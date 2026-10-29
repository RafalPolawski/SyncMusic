package hub

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/RafalPolawski/SyncMusic/internal/protocol"
	"github.com/RafalPolawski/SyncMusic/internal/room"
	"github.com/RafalPolawski/SyncMusic/internal/store"
)

const (
	// memberGrace keeps a disconnected listener visible (as reconnecting)
	// for a while, so flaky connections do not make people blink in and out.
	memberGrace = 2 * time.Minute
	// presenceInterval throttles presence broadcasts.
	presenceInterval = time.Second
	// saveInterval debounces persisting room state.
	saveInterval = 2 * time.Second
	// recentCommands is how many command ids are remembered per listener for
	// de-duplicating retries.
	recentCommands = 64
	// prewarmAhead is how many upcoming tracks are transcoded in advance.
	prewarmAhead = 3
)

type member struct {
	clientID       string
	name           string
	format         string
	quality        string
	conn           *conn
	status         protocol.Status
	hasStatus      bool
	lastSeen       time.Time
	disconnectedAt time.Time
	recent         []recentAck
}

type recentAck struct {
	id  string
	ack protocol.Ack
}

func (m *member) connected() bool { return m.conn != nil }

func (m *member) remember(id string, ack protocol.Ack) {
	m.recent = append(m.recent, recentAck{id: id, ack: ack})
	if len(m.recent) > recentCommands {
		m.recent = m.recent[len(m.recent)-recentCommands:]
	}
}

func (m *member) lookup(id string) (protocol.Ack, bool) {
	for i := len(m.recent) - 1; i >= 0; i-- {
		if m.recent[i].id == id {
			return m.recent[i].ack, true
		}
	}
	return protocol.Ack{}, false
}

// Events processed by the room actor.
type (
	joinEvent struct {
		conn  *conn
		info  joinInfo
		reply chan error
	}
	leaveEvent struct{ conn *conn }
	// clientEvent carries a decoded client message (command, status, profile).
	clientEvent struct {
		conn *conn
		msg  any
	}
	libraryEvent struct{ version string }
	summaryEvent struct{ reply chan RoomSummary }
)

type joinInfo struct {
	roomName string
	name     string
	format   string
	quality  string
}

// Room is the actor owning one room's state. All state is confined to the
// run goroutine; other goroutines talk to it through the inbox.
type Room struct {
	id   string
	name string
	hub  *Hub

	engine  *room.Engine
	members map[string]*member // by client id

	inbox chan any
	done  chan struct{}

	dirty         bool
	lastSave      time.Time
	lastActive    time.Time
	lastPresence  time.Time
	presenceDirty bool
	prewarmKey    string
}

func newRoom(h *Hub, id, name string, st room.State) *Room {
	st.Hold = nil // a hold never survives a restart
	return &Room{
		id:         id,
		name:       name,
		hub:        h,
		engine:     room.NewEngine(st, h.catalog, h.engineOptions(), nil),
		members:    map[string]*member{},
		inbox:      make(chan any, 256),
		done:       make(chan struct{}),
		lastActive: h.now(),
	}
}

// post delivers an event unless the room or the caller is gone.
func (r *Room) post(ctx context.Context, ev any) bool {
	select {
	case r.inbox <- ev:
		return true
	case <-r.done:
		return false
	case <-ctx.Done():
		return false
	}
}

func (r *Room) nowMs() int64 { return r.hub.now().UnixMilli() }

func (r *Room) run(ctx context.Context) {
	defer close(r.done)
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	saveTicker := time.NewTicker(saveInterval)
	defer saveTicker.Stop()

	// Catch up with time that passed while the room was not loaded.
	if ch := r.engine.Normalize(r.nowMs()); ch != 0 {
		r.dirty = true
	}
	for {
		r.reschedule(timer)
		select {
		case ev := <-r.inbox:
			r.handle(ev)
		case <-timer.C:
			r.tick()
		case <-saveTicker.C:
			r.save(false)
			if r.idle() && r.hub.unload(r) {
				r.drain()
				return
			}
		case <-ctx.Done():
			r.save(true)
			r.closeConns(websocket.StatusGoingAway, "server shutting down")
			return
		}
	}
}

// drain answers events that raced with unloading.
func (r *Room) drain() {
	for {
		select {
		case ev := <-r.inbox:
			if j, ok := ev.(joinEvent); ok {
				j.reply <- errRoomClosed
			}
		default:
			return
		}
	}
}

var errRoomClosed = errors.New("room closed")

func (r *Room) idle() bool {
	for _, m := range r.members {
		if m.connected() {
			return false
		}
	}
	return r.hub.now().Sub(r.lastActive) > r.hub.opts.RoomIdleTimeout
}

func (r *Room) handle(ev any) {
	switch e := ev.(type) {
	case joinEvent:
		r.join(e)
	case leaveEvent:
		r.leave(e.conn)
	case clientEvent:
		m := r.memberFor(e.conn)
		if m == nil {
			return
		}
		m.lastSeen = r.hub.now()
		switch msg := e.msg.(type) {
		case *protocol.Command:
			r.command(m, msg)
		case *protocol.Status:
			r.status(m, msg)
		case *protocol.Profile:
			r.profile(m, msg)
		}
	case libraryEvent:
		r.libraryChanged(e.version)
	case summaryEvent:
		e.reply <- r.summary()
	}
}

func (r *Room) memberFor(c *conn) *member {
	m, ok := r.members[c.clientID]
	if !ok || m.conn != c {
		return nil
	}
	return m
}

func (r *Room) join(e joinEvent) {
	c := e.conn
	now := r.hub.now()
	m, ok := r.members[c.clientID]
	if !ok {
		m = &member{clientID: c.clientID}
		r.members[c.clientID] = m
	}
	if old := m.conn; old != nil && old != c {
		// Same device reconnected before the old socket died.
		old.sendControl(&protocol.Error{Type: protocol.TypeError, Code: "replaced", Message: "connected from another tab"})
		old.closeAfter(websocket.StatusPolicyViolation, "replaced")
	}
	m.conn = c
	m.name = e.info.name
	m.format, m.quality = e.info.format, e.info.quality
	m.lastSeen = now
	m.disconnectedAt = time.Time{}
	m.hasStatus = false
	r.lastActive = now
	e.reply <- nil

	c.sendControl(&protocol.Welcome{
		Type:           protocol.TypeWelcome,
		Protocol:       protocol.Version,
		ServerTime:     r.hub.nowFloat(),
		Room:           protocol.RoomInfo{ID: r.id, Name: r.name},
		ClientID:       c.clientID,
		LibraryVersion: r.hub.opts.LibraryVersion(),
		Timing: protocol.Timing{
			StartDelayMs:  r.hub.opts.StartDelay.Milliseconds(),
			ResumeDelayMs: r.hub.opts.ResumeDelay.Milliseconds(),
		},
		ServerVersion: r.hub.opts.ServerVersion,
	})
	if ch := r.engine.Normalize(r.nowMs()); ch != 0 {
		r.dirty = true
		r.broadcastState()
	} else {
		r.sendState(c)
	}
	r.markPresence()
	r.hub.log.Info("listener joined", "room", r.id, "client", c.clientID, "name", m.name)
}

func (r *Room) leave(c *conn) {
	m := r.memberFor(c)
	if m == nil {
		return
	}
	m.conn = nil
	m.disconnectedAt = r.hub.now()
	r.lastActive = r.hub.now()
	r.markPresence()
	r.checkHold() // a departed listener must not block a held start
	r.hub.log.Info("listener left", "room", r.id, "client", c.clientID, "name", m.name)
}

func (r *Room) command(m *member, msg *protocol.Command) {
	if ack, ok := m.lookup(msg.ID); ok && msg.ID != "" {
		m.conn.sendControl(&ack) // retry of a command we already applied
		return
	}
	r.lastActive = r.hub.now()
	ch, err := r.engine.Apply(msg.Cmd, r.nowMs(), m.name)
	if ch != 0 {
		r.hub.metrics.command(msg.Cmd.Op)
		r.dirty = true
		r.checkHoldQuiet()
		r.broadcastState()
		r.prewarm()
	}
	ack := protocol.Ack{Type: protocol.TypeAck, ID: msg.ID, OK: true, Version: r.engine.State.Version}
	if err != nil && !errors.Is(err, room.ErrNoChange) {
		ack.OK = false
		var re *room.Error
		if errors.As(err, &re) {
			ack.Error = re
		} else {
			ack.Error = &room.Error{Code: "internal", Message: "command failed"}
		}
	}
	m.remember(msg.ID, ack)
	m.conn.sendControl(&ack)
}

func (r *Room) status(m *member, st *protocol.Status) {
	prevReady, prevTrack, prevBuffering := m.status.Ready, m.status.TrackID, m.status.Buffering
	m.status = *st
	m.hasStatus = true
	if !prevReadyEqual(prevReady, prevTrack, prevBuffering, st) {
		r.checkHold()
	}
	r.markPresence()
}

func prevReadyEqual(ready bool, track string, buffering bool, st *protocol.Status) bool {
	return ready == st.Ready && track == st.TrackID && buffering == st.Buffering
}

func (r *Room) profile(m *member, p *protocol.Profile) {
	if n := sanitizeName(p.Name); p.Name != "" {
		m.name = n
	}
	if p.Format != "" {
		m.format = p.Format
	}
	if p.Quality != "" {
		m.quality = p.Quality
	}
	r.markPresence()
	r.prewarmKey = "" // profiles changed: prewarm again
	r.prewarm()
}

func (r *Room) libraryChanged(version string) {
	// Durations may have changed after a rescan.
	p := &r.engine.State.Playback
	if p.TrackID != "" {
		if d, ok := r.hub.catalog.DurationMs(p.TrackID); ok && d != p.DurationMs {
			p.DurationMs = d
			r.engine.State.Version++
			r.dirty = true
			r.broadcastState()
		}
	}
	msg, _ := json.Marshal(protocol.Library{Type: protocol.TypeLibrary, Version: version})
	for _, m := range r.members {
		if m.conn != nil {
			m.conn.sendControl(json.RawMessage(msg))
		}
	}
}

// tick runs when the room timer fires: auto-advance, hold handling,
// throttled presence and member expiry.
func (r *Room) tick() {
	if ch := r.engine.Normalize(r.nowMs()); ch != 0 {
		r.dirty = true
		r.broadcastState()
		r.prewarm()
	}
	r.checkHold()
	now := r.hub.now()
	for id, m := range r.members {
		if !m.connected() && now.Sub(m.disconnectedAt) > memberGrace {
			delete(r.members, id)
			r.presenceDirty = true
		}
	}
	if r.presenceDirty && now.Sub(r.lastPresence) >= presenceInterval {
		r.broadcastPresence()
	}
}

// allReady reports whether every connected listener has buffered the held track.
func (r *Room) allReady() (bool, []string) {
	h := r.engine.State.Hold
	if h == nil {
		return true, nil
	}
	var waiting []string
	for _, m := range r.members {
		if !m.connected() {
			continue
		}
		if !m.hasStatus || !m.status.Ready || m.status.TrackID != h.TrackID {
			waiting = append(waiting, m.name)
		}
	}
	slices.Sort(waiting)
	return len(waiting) == 0, waiting
}

// checkHold evaluates the hold and broadcasts any change.
func (r *Room) checkHold() {
	if r.checkHoldQuiet() {
		r.broadcastState()
	}
}

func (r *Room) checkHoldQuiet() bool {
	if r.engine.State.Hold == nil {
		return false
	}
	ready, _ := r.allReady()
	ch, _ := r.engine.CheckHold(r.nowMs(), ready)
	if ch != 0 {
		r.dirty = true
		r.markPresence() // waiting list changed
		return true
	}
	return false
}

func (r *Room) reschedule(t *time.Timer) {
	now := r.hub.now()
	next := now.Add(time.Hour)
	consider := func(at time.Time) {
		if at.Before(next) {
			next = at
		}
	}
	if end, ok := r.engine.State.Playback.EndsAt(); ok {
		consider(time.UnixMilli(end))
	}
	if at := r.engine.NextHoldCheck(); at > 0 {
		consider(time.UnixMilli(at))
	}
	if r.presenceDirty {
		consider(r.lastPresence.Add(presenceInterval))
	}
	for _, m := range r.members {
		if !m.connected() {
			consider(m.disconnectedAt.Add(memberGrace + time.Second))
		}
	}
	d := next.Sub(now)
	if d < time.Millisecond {
		d = time.Millisecond
	}
	if !t.Stop() {
		select {
		case <-t.C:
		default:
		}
	}
	t.Reset(d)
}

func (r *Room) markPresence() {
	r.presenceDirty = true
	if r.hub.now().Sub(r.lastPresence) >= presenceInterval {
		r.broadcastPresence()
	}
}

func (r *Room) broadcastPresence() {
	r.presenceDirty = false
	r.lastPresence = r.hub.now()
	msg := protocol.Presence{Type: protocol.TypePresence, Members: make([]protocol.Member, 0, len(r.members))}
	for _, m := range r.members {
		pm := protocol.Member{
			ClientID:  m.clientID,
			Name:      m.name,
			Connected: m.connected(),
			LastSeen:  m.lastSeen.UnixMilli(),
		}
		if m.hasStatus {
			pm.TrackID = m.status.TrackID
			pm.Ready = m.status.Ready
			pm.Buffering = m.status.Buffering
			pm.Playing = m.status.Playing
			pm.DriftMs = m.status.DriftMs
			pm.RTTMs = m.status.RTTMs
			pm.Offline = m.status.Offline
		}
		msg.Members = append(msg.Members, pm)
	}
	slices.SortFunc(msg.Members, func(a, b protocol.Member) int {
		if c := strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)); c != 0 {
			return c
		}
		return strings.Compare(a.ClientID, b.ClientID)
	})
	if r.engine.State.Hold != nil {
		_, msg.Waiting = r.allReady()
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	for _, m := range r.members {
		if m.conn != nil {
			m.conn.setPresence(data)
		}
	}
}

// stateFor builds the snapshot for one connection, including the queue and
// context only when the connection has not seen their current versions.
func (r *Room) stateFor(c *conn, cache map[[2]bool][]byte) ([]byte, uint64, uint64) {
	s := &r.engine.State
	withQueue := c.sentQueueV.Load() != s.QueueVersion
	withContext := c.sentContextV.Load() != s.ContextVersion
	// A pending, unsent snapshot may already carry them; keep including
	// them until the writer confirms delivery.
	c.mu.Lock()
	if c.pendingState != nil {
		withQueue = withQueue || c.pendingQueueV != notSent
		withContext = withContext || c.pendingContextV != notSent
	}
	c.mu.Unlock()
	key := [2]bool{withQueue, withContext}
	qv, cv := uint64(notSent), uint64(notSent)
	if withQueue {
		qv = s.QueueVersion
	}
	if withContext {
		cv = s.ContextVersion
	}
	if b, ok := cache[key]; ok {
		return b, qv, cv
	}
	msg := protocol.State{
		Type:           protocol.TypeState,
		Version:        s.Version,
		ServerTime:     r.nowMs(),
		Playback:       s.Playback,
		ContextIndex:   s.ContextIndex,
		Shuffle:        s.Shuffle,
		Repeat:         s.Repeat,
		WaitForAll:     s.WaitForAll,
		Hold:           s.Hold,
		QueueVersion:   s.QueueVersion,
		ContextVersion: s.ContextVersion,
	}
	if withQueue {
		q := s.Queue
		msg.Queue = &q
	}
	if withContext {
		ctx := s.Context
		msg.Context = &ctx
	}
	b, err := json.Marshal(msg)
	if err != nil {
		r.hub.log.Error("marshal state", "err", err)
		return nil, qv, cv
	}
	cache[key] = b
	return b, qv, cv
}

func (r *Room) sendState(c *conn) {
	if b, qv, cv := r.stateFor(c, map[[2]bool][]byte{}); b != nil {
		c.setState(b, qv, cv)
	}
}

func (r *Room) broadcastState() {
	cache := map[[2]bool][]byte{}
	for _, m := range r.members {
		if m.conn == nil {
			continue
		}
		if b, qv, cv := r.stateFor(m.conn, cache); b != nil {
			m.conn.setState(b, qv, cv)
		}
	}
}

// prewarm asks the transcoder to prepare the current and next tracks in the
// formats the connected listeners use.
func (r *Room) prewarm() {
	if r.hub.opts.Prewarm == nil {
		return
	}
	s := r.engine.State
	ids := append([]string{}, s.Playback.TrackID)
	ids = append(ids, room.Upcoming(s, prewarmAhead, r.hub.catalog)...)
	profiles := map[[2]string]bool{}
	for _, m := range r.members {
		if m.connected() {
			profiles[[2]string{m.format, m.quality}] = true
		}
	}
	keys := make([]string, 0, len(profiles))
	for p := range profiles {
		keys = append(keys, p[0]+"/"+p[1])
	}
	slices.Sort(keys)
	key := strings.Join(ids, ",") + "|" + strings.Join(keys, ",")
	if key == r.prewarmKey {
		return
	}
	r.prewarmKey = key
	for p := range profiles {
		for _, id := range ids {
			if id != "" {
				r.hub.opts.Prewarm(id, p[0], p[1])
			}
		}
	}
}

func (r *Room) summary() RoomSummary {
	sum := RoomSummary{ID: r.id, Name: r.name, TrackID: r.engine.State.Playback.TrackID, Playing: r.engine.State.Playback.Playing}
	for _, m := range r.members {
		if m.connected() {
			sum.Listeners = append(sum.Listeners, m.name)
		}
	}
	slices.Sort(sum.Listeners)
	return sum
}

func (r *Room) save(force bool) {
	if !r.dirty || r.hub.opts.Store == nil {
		return
	}
	if !force && r.hub.now().Sub(r.lastSave) < saveInterval {
		return
	}
	data, err := json.Marshal(r.engine.State)
	if err != nil {
		r.hub.log.Error("marshal room state", "room", r.id, "err", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := r.hub.opts.Store.SaveRoom(ctx, store.RoomRecord{ID: r.id, Name: r.name, State: data, UpdatedAt: r.hub.now().UnixMilli()}); err != nil {
		r.hub.log.Error("save room state", "room", r.id, "err", err)
		return
	}
	r.dirty = false
	r.lastSave = r.hub.now()
}

func (r *Room) closeConns(code websocket.StatusCode, reason string) {
	for _, m := range r.members {
		if m.conn != nil {
			m.conn.close(code, reason)
		}
	}
}
