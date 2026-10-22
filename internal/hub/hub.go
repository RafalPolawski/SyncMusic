// Package hub connects listeners to rooms over WebSocket. Each room is an
// actor goroutine that owns a room.Engine; connections only exchange
// messages with it.
package hub

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/coder/websocket"

	"github.com/RafalPolawski/SyncMusic/internal/room"
	"github.com/RafalPolawski/SyncMusic/internal/store"
)

// RoomStore persists room state.
type RoomStore interface {
	SaveRoom(ctx context.Context, r store.RoomRecord) error
	LoadRoom(ctx context.Context, id string) (store.RoomRecord, error)
	ListRooms(ctx context.Context) ([]store.RoomRecord, error)
}

// Options configures a Hub.
type Options struct {
	Catalog         room.Catalog
	LibraryVersion  func() string
	Store           RoomStore
	Logger          *slog.Logger
	StartDelay      time.Duration
	ResumeDelay     time.Duration
	WaitForAllMax   time.Duration
	RoomIdleTimeout time.Duration
	// OriginPatterns lists extra allowed WebSocket origins (host patterns).
	// Same-origin requests are always allowed.
	OriginPatterns []string
	// Prewarm is called with tracks that are about to be played.
	Prewarm       func(trackID, format, quality string)
	ServerVersion string
	// Now overrides the clock (tests).
	Now     func() time.Time
	Metrics *Metrics
	// MaxRooms caps concurrently loaded rooms.
	MaxRooms int
}

// RoomSummary describes a room for listings.
type RoomSummary struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Listeners []string `json:"listeners"`
	TrackID   string   `json:"trackId,omitempty"`
	Playing   bool     `json:"playing"`
	UpdatedAt int64    `json:"updatedAt,omitempty"`
}

// Hub manages rooms and connections.
type Hub struct {
	opts    Options
	log     *slog.Logger
	catalog room.Catalog
	metrics *Metrics
	now     func() time.Time

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	mu    sync.Mutex
	rooms map[string]*Room
	conns map[*conn]struct{}
}

// New creates a hub.
func New(opts Options) *Hub {
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.LibraryVersion == nil {
		opts.LibraryVersion = func() string { return "" }
	}
	if opts.RoomIdleTimeout == 0 {
		opts.RoomIdleTimeout = 12 * time.Hour
	}
	if opts.MaxRooms == 0 {
		opts.MaxRooms = 100
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Hub{
		opts:    opts,
		log:     opts.Logger,
		catalog: opts.Catalog,
		metrics: opts.Metrics,
		now:     opts.Now,
		ctx:     ctx,
		cancel:  cancel,
		rooms:   map[string]*Room{},
		conns:   map[*conn]struct{}{},
	}
}

func (h *Hub) nowFloat() float64 {
	return float64(h.now().UnixMicro()) / 1000
}

func (h *Hub) engineOptions() room.Options {
	return room.Options{
		StartDelayMs:    h.opts.StartDelay.Milliseconds(),
		ResumeDelayMs:   h.opts.ResumeDelay.Milliseconds(),
		WaitForAllMaxMs: h.opts.WaitForAllMax.Milliseconds(),
	}
}

// ServeHTTP upgrades the request to a WebSocket and serves it until it closes.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.ctx.Err() != nil {
		http.Error(w, "server shutting down", http.StatusServiceUnavailable)
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns:       h.opts.OriginPatterns,
		CompressionMode:      websocket.CompressionContextTakeover,
		CompressionThreshold: 256,
	})
	if err != nil {
		h.log.Debug("websocket accept failed", "err", err)
		return
	}
	ws.SetReadLimit(maxMessageBytes)
	c := newConn(h, ws, h.log)

	h.mu.Lock()
	h.conns[c] = struct{}{}
	h.mu.Unlock()
	h.metrics.connected(1)
	defer func() {
		h.mu.Lock()
		delete(h.conns, c)
		h.mu.Unlock()
		h.metrics.connected(-1)
	}()

	go c.writeLoop()
	c.readLoop()
	c.cancel()
	if c.room != nil {
		c.room.post(context.Background(), leaveEvent{conn: c})
	}
	_ = ws.CloseNow()
}

// join attaches a connection to a room, loading or creating it.
func (h *Hub) join(c *conn, info joinInfo) (*Room, error) {
	id := RoomID(info.roomName)
	for attempt := 0; attempt < 5; attempt++ {
		r, err := h.getRoom(id, info.roomName)
		if err != nil {
			return nil, err
		}
		reply := make(chan error, 1)
		if !r.post(c.ctx, joinEvent{conn: c, info: info, reply: reply}) {
			if c.ctx.Err() != nil {
				return nil, c.ctx.Err()
			}
			continue // room unloaded concurrently; retry with a fresh one
		}
		select {
		case err := <-reply:
			if errors.Is(err, errRoomClosed) {
				continue
			}
			return r, err
		case <-r.done:
			continue
		case <-c.ctx.Done():
			return nil, c.ctx.Err()
		}
	}
	return nil, errors.New("could not join room")
}

var errTooManyRooms = errors.New("too many rooms")

func (h *Hub) getRoom(id, name string) (*Room, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.ctx.Err() != nil {
		return nil, errors.New("server shutting down")
	}
	if r, ok := h.rooms[id]; ok {
		return r, nil
	}
	if len(h.rooms) >= h.opts.MaxRooms {
		return nil, errTooManyRooms
	}
	st := room.NewState()
	if h.opts.Store != nil {
		ctx, cancel := context.WithTimeout(h.ctx, 5*time.Second)
		rec, err := h.opts.Store.LoadRoom(ctx, id)
		cancel()
		switch {
		case err == nil:
			if jerr := unmarshalState(rec.State, &st); jerr != nil {
				h.log.Warn("ignoring corrupt room state", "room", id, "err", jerr)
				st = room.NewState()
			} else if rec.Name != "" {
				name = rec.Name
			}
		case errors.Is(err, store.ErrNotFound):
		default:
			return nil, err
		}
	}
	r := newRoom(h, id, name, st)
	h.rooms[id] = r
	h.metrics.rooms(len(h.rooms))
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		r.run(h.ctx)
	}()
	h.log.Info("room loaded", "room", id)
	return r, nil
}

// unload removes an idle room. It returns false if the room was replaced.
func (h *Hub) unload(r *Room) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.rooms[r.id] != r {
		return false
	}
	delete(h.rooms, r.id)
	h.metrics.rooms(len(h.rooms))
	h.log.Info("room unloaded", "room", r.id)
	return true
}

// LibraryChanged notifies all rooms and clients about a new library version.
func (h *Hub) LibraryChanged(version string) {
	h.mu.Lock()
	rooms := make([]*Room, 0, len(h.rooms))
	for _, r := range h.rooms {
		rooms = append(rooms, r)
	}
	h.mu.Unlock()
	for _, r := range rooms {
		r.post(h.ctx, libraryEvent{version: version})
	}
}

// Rooms lists loaded and persisted rooms.
func (h *Hub) Rooms(ctx context.Context) ([]RoomSummary, error) {
	h.mu.Lock()
	loaded := make([]*Room, 0, len(h.rooms))
	for _, r := range h.rooms {
		loaded = append(loaded, r)
	}
	h.mu.Unlock()
	seen := map[string]bool{}
	var out []RoomSummary
	for _, r := range loaded {
		reply := make(chan RoomSummary, 1)
		if !r.post(ctx, summaryEvent{reply: reply}) {
			continue
		}
		select {
		case s := <-reply:
			out = append(out, s)
			seen[s.ID] = true
		case <-r.done:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if h.opts.Store != nil {
		recs, err := h.opts.Store.ListRooms(ctx)
		if err != nil {
			return nil, err
		}
		for _, rec := range recs {
			if !seen[rec.ID] {
				out = append(out, RoomSummary{ID: rec.ID, Name: rec.Name, Listeners: []string{}, UpdatedAt: rec.UpdatedAt})
			}
		}
	}
	slices.SortFunc(out, func(a, b RoomSummary) int {
		if len(a.Listeners) != len(b.Listeners) {
			return len(b.Listeners) - len(a.Listeners)
		}
		return strings.Compare(a.ID, b.ID)
	})
	for i := range out {
		if out[i].Listeners == nil {
			out[i].Listeners = []string{}
		}
	}
	return out, nil
}

// Close saves all rooms and closes every connection.
func (h *Hub) Close(ctx context.Context) error {
	h.cancel()
	h.mu.Lock()
	for c := range h.conns {
		c.close(websocket.StatusGoingAway, "server shutting down")
	}
	h.mu.Unlock()
	done := make(chan struct{})
	go func() { h.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// NormalizeRoomName trims and validates a room name. Allowed are letters,
// digits, spaces, dashes and underscores, up to 32 characters.
func NormalizeRoomName(name string) (string, bool) {
	name = strings.Join(strings.Fields(name), " ")
	if name == "" {
		name = "main"
	}
	if utf8.RuneCountInString(name) > 32 {
		return "", false
	}
	for _, r := range name {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != ' ' && r != '-' && r != '_' {
			return "", false
		}
	}
	return name, true
}

// RoomID maps a room name to its case-insensitive identifier.
func RoomID(name string) string {
	return strings.ToLower(strings.ReplaceAll(name, " ", "-"))
}

func sanitizeName(name string) string {
	name = strings.Join(strings.FieldsFunc(name, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }), " ")
	if name == "" {
		return "Listener"
	}
	if utf8.RuneCountInString(name) > 32 {
		name = string([]rune(name)[:32])
	}
	return name
}

func sanitizeClientID(id string) string {
	if len(id) < 8 || len(id) > 64 {
		return ""
	}
	for _, r := range id {
		if !isIDChar(r) {
			return ""
		}
	}
	return id
}

func isIDChar(r rune) bool {
	return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_'
}
