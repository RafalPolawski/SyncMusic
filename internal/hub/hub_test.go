package hub

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/RafalPolawski/SyncMusic/internal/protocol"
	"github.com/RafalPolawski/SyncMusic/internal/room"
	"github.com/RafalPolawski/SyncMusic/internal/store"
)

var catalog = room.MapCatalog{"a": 10_000, "b": 20_000, "c": 5_000, "short1": 300, "short2": 300}

type env struct {
	t   *testing.T
	hub *Hub
	srv *httptest.Server
	db  *store.DB
}

func newEnv(t *testing.T, mutate ...func(*Options)) *env {
	t.Helper()
	db, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	opts := Options{
		Catalog:        catalog,
		LibraryVersion: func() string { return "lib-v1" },
		Store:          db,
		StartDelay:     50 * time.Millisecond,
		ResumeDelay:    20 * time.Millisecond,
		WaitForAllMax:  2 * time.Second,
		ServerVersion:  "test",
		Logger:         slog.New(slog.DiscardHandler),
	}
	for _, m := range mutate {
		m(&opts)
	}
	h := New(opts)
	srv := httptest.NewServer(h)
	e := &env{t: t, hub: h, srv: srv, db: db}
	t.Cleanup(func() {
		srv.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = h.Close(ctx)
		db.Close()
	})
	return e
}

type client struct {
	t    *testing.T
	ws   *websocket.Conn
	msgs chan []byte
	mu   sync.Mutex
	err  error
}

func (e *env) dial(header ...http.Header) *client {
	e.t.Helper()
	url := "ws" + strings.TrimPrefix(e.srv.URL, "http")
	opts := &websocket.DialOptions{}
	if len(header) > 0 {
		opts.HTTPHeader = header[0]
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, url, opts)
	if err != nil {
		e.t.Fatalf("dial: %v", err)
	}
	ws.SetReadLimit(1 << 20)
	c := &client{t: e.t, ws: ws, msgs: make(chan []byte, 256)}
	go func() {
		defer close(c.msgs)
		for {
			_, data, err := ws.Read(context.Background())
			if err != nil {
				c.mu.Lock()
				c.err = err
				c.mu.Unlock()
				return
			}
			c.msgs <- data
		}
	}()
	e.t.Cleanup(func() { ws.CloseNow() })
	return c
}

func (c *client) send(v any) {
	c.t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		c.t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.ws.Write(ctx, websocket.MessageText, b); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

// next returns the next message of the given type, skipping others.
func (c *client) next(typ string, timeout time.Duration) json.RawMessage {
	c.t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case data, ok := <-c.msgs:
			if !ok {
				c.t.Fatalf("connection closed while waiting for %q: %v", typ, c.err)
			}
			var env struct{ Type string }
			_ = json.Unmarshal(data, &env)
			if env.Type == typ {
				return data
			}
		case <-deadline:
			c.t.Fatalf("timed out waiting for %q", typ)
		}
	}
}

// until returns the first state message satisfying pred.
func (c *client) until(timeout time.Duration, pred func(protocol.State) bool) protocol.State {
	c.t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			c.t.Fatal("timed out waiting for matching state")
		}
		var st protocol.State
		if err := json.Unmarshal(c.next(protocol.TypeState, remaining), &st); err != nil {
			c.t.Fatal(err)
		}
		if pred(st) {
			return st
		}
	}
}

func (c *client) untilPresence(timeout time.Duration, pred func(protocol.Presence) bool) protocol.Presence {
	c.t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			c.t.Fatal("timed out waiting for matching presence")
		}
		var p protocol.Presence
		if err := json.Unmarshal(c.next(protocol.TypePresence, remaining), &p); err != nil {
			c.t.Fatal(err)
		}
		if pred(p) {
			return p
		}
	}
}

func hello(clientID, name, roomName string) protocol.Hello {
	return protocol.Hello{Type: protocol.TypeHello, Protocol: protocol.Version, ClientID: clientID, Name: name, Room: roomName, Format: "opus", Quality: "medium"}
}

func (e *env) join(clientID, name, roomName string) (*client, protocol.State) {
	e.t.Helper()
	c := e.dial()
	c.send(hello(clientID, name, roomName))
	var w protocol.Welcome
	if err := json.Unmarshal(c.next(protocol.TypeWelcome, 5*time.Second), &w); err != nil {
		e.t.Fatal(err)
	}
	if w.ClientID != clientID || w.LibraryVersion != "lib-v1" || w.Protocol != protocol.Version {
		e.t.Fatalf("welcome = %+v", w)
	}
	st := c.until(5*time.Second, func(protocol.State) bool { return true })
	return c, st
}

func cmd(id string, c room.Command) protocol.Command {
	return protocol.Command{Type: protocol.TypeCommand, ID: id, Cmd: c}
}

func ptr[T any](v T) *T { return &v }

func playFolder(tracks ...string) room.Command {
	return room.Command{Op: "playContext", Context: &room.ContextSpec{Kind: "folder", ID: "F", Name: "F", Tracks: tracks}}
}

func readAck(t *testing.T, c *client) protocol.Ack {
	t.Helper()
	var a protocol.Ack
	if err := json.Unmarshal(c.next(protocol.TypeAck, 5*time.Second), &a); err != nil {
		t.Fatal(err)
	}
	return a
}

func TestJoinGetsFullInitialState(t *testing.T) {
	e := newEnv(t)
	_, st := e.join("client-aaaa", "Ala", "Siłownia")
	if st.Queue == nil || st.Context == nil {
		t.Fatalf("first state must carry queue and context: %+v", st)
	}
	if st.Playback.TrackID != "" || st.Repeat != room.RepeatOff {
		t.Fatalf("fresh room state = %+v", st)
	}
}

func TestCommandsAreBroadcast(t *testing.T) {
	e := newEnv(t)
	a, _ := e.join("client-aaaa", "Ala", "gym")
	b, _ := e.join("client-bbbb", "Bob", "GYM") // room ids are case-insensitive

	a.send(cmd("c1", playFolder("a", "b")))
	ack := readAck(t, a)
	if !ack.OK || ack.Version == 0 {
		t.Fatalf("ack = %+v", ack)
	}
	st := b.until(3*time.Second, func(s protocol.State) bool { return s.Playback.TrackID == "a" })
	if !st.Playback.Playing || st.Context == nil || len(st.Context.Tracks) != 2 || st.Version != ack.Version {
		t.Fatalf("b state = %+v", st)
	}
	if st.Playback.AnchorMs < st.ServerTime {
		t.Fatalf("start should be scheduled in the future: anchor %d server %d", st.Playback.AnchorMs, st.ServerTime)
	}

	// A pause only changes playback: queue and context are omitted.
	b.send(cmd("c2", room.Command{Op: "pause"}))
	st = a.until(3*time.Second, func(s protocol.State) bool { return !s.Playback.Playing })
	if st.Queue != nil || st.Context != nil {
		t.Fatalf("unchanged queue/context should not be resent: %+v", st)
	}

	// Queue changes include the queue.
	a.send(cmd("c3", room.Command{Op: "queueAdd", TrackIDs: []string{"c"}}))
	st = b.until(3*time.Second, func(s protocol.State) bool { return s.Queue != nil })
	if len(*st.Queue) != 1 || (*st.Queue)[0].TrackID != "c" || (*st.Queue)[0].AddedBy != "Ala" {
		t.Fatalf("queue = %+v", st.Queue)
	}
}

func TestCommandErrorsAndDedup(t *testing.T) {
	e := newEnv(t)
	a, _ := e.join("client-aaaa", "Ala", "gym")
	a.send(cmd("bad", room.Command{Op: "queueAdd", TrackIDs: []string{"nope"}}))
	ack := readAck(t, a)
	if ack.OK || ack.Error == nil || ack.Error.Code != "unknown_track" {
		t.Fatalf("ack = %+v", ack)
	}

	a.send(cmd("same", room.Command{Op: "queueAdd", TrackIDs: []string{"a"}}))
	first := readAck(t, a)
	a.send(cmd("same", room.Command{Op: "queueAdd", TrackIDs: []string{"a"}}))
	second := readAck(t, a)
	if first != second {
		t.Fatalf("retry must return the original ack: %+v vs %+v", first, second)
	}
	a.send(cmd("check", room.Command{Op: "repeat", Mode: room.RepeatAll}))
	st := a.until(3*time.Second, func(s protocol.State) bool { return s.Repeat == room.RepeatAll })
	if st.QueueVersion != 1 {
		t.Fatalf("duplicate command was applied twice: queueVersion=%d", st.QueueVersion)
	}

	a.send(cmd("noop", room.Command{Op: "pause"}))
	if ack := readAck(t, a); !ack.OK {
		t.Fatalf("no-op command should be acknowledged ok: %+v", ack)
	}
}

func TestAutoAdvanceIsBroadcast(t *testing.T) {
	e := newEnv(t)
	a, _ := e.join("client-aaaa", "Ala", "gym")
	a.send(cmd("c1", room.Command{Op: "waitForAll", On: ptr(false)}))
	a.send(cmd("c2", playFolder("short1", "short2")))
	started := a.until(5*time.Second, func(s protocol.State) bool { return s.Playback.TrackID == "short1" })
	st := a.until(5*time.Second, func(s protocol.State) bool { return s.Playback.TrackID == "short2" })
	// Gapless: the second track is anchored exactly at the end of the first.
	if st.Playback.AnchorMs != started.Playback.AnchorMs+300 {
		t.Fatalf("second track anchor %d, want %d", st.Playback.AnchorMs, started.Playback.AnchorMs+300)
	}
	if !st.Playback.Playing || st.ContextIndex != 1 {
		t.Fatalf("advanced state = %+v", st)
	}
	st = a.until(5*time.Second, func(s protocol.State) bool { return !s.Playback.Playing })
	if st.Playback.TrackID != "short1" || st.ContextIndex != 0 {
		t.Fatalf("end of context should park on the first track: %+v", st)
	}
}

func TestWaitForAllHoldsUntilEveryoneIsReady(t *testing.T) {
	e := newEnv(t)
	a, st := e.join("client-aaaa", "Ala", "gym")
	if !st.WaitForAll {
		t.Fatal("wait for everyone should be on by default")
	}
	b, _ := e.join("client-bbbb", "Bob", "gym")

	a.send(cmd("c1", playFolder("a")))
	st = a.until(3*time.Second, func(s protocol.State) bool { return s.Playback.TrackID == "a" })
	if st.Hold == nil {
		t.Fatalf("expected a hold: %+v", st)
	}
	firstAnchor := st.Playback.AnchorMs
	a.send(protocol.Status{Type: protocol.TypeStatus, TrackID: "a", Ready: true})

	// Bob is still buffering: the start is postponed.
	st = a.until(3*time.Second, func(s protocol.State) bool { return s.Playback.AnchorMs > firstAnchor })
	if st.Hold == nil {
		t.Fatal("hold should remain while Bob buffers")
	}
	p := a.untilPresence(3*time.Second, func(p protocol.Presence) bool { return len(p.Waiting) > 0 })
	if p.Waiting[0] != "Bob" {
		t.Fatalf("waiting = %v", p.Waiting)
	}

	b.send(protocol.Status{Type: protocol.TypeStatus, TrackID: "a", Ready: true})
	st = b.until(3*time.Second, func(s protocol.State) bool { return s.Hold == nil })
	if !st.Playback.Playing || st.Playback.TrackID != "a" {
		t.Fatalf("released state = %+v", st)
	}
}

func TestWaitForAllGivesUp(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.WaitForAllMax = 300 * time.Millisecond })
	a, _ := e.join("client-aaaa", "Ala", "gym")
	_, _ = e.join("client-bbbb", "Bob", "gym")
	a.send(cmd("c1", playFolder("a")))
	a.until(3*time.Second, func(s protocol.State) bool { return s.Hold != nil })
	st := a.until(3*time.Second, func(s protocol.State) bool { return s.Hold == nil })
	if !st.Playback.Playing {
		t.Fatalf("playback should start after giving up: %+v", st)
	}
}

func TestLeavingListenerDoesNotBlockHold(t *testing.T) {
	e := newEnv(t)
	a, _ := e.join("client-aaaa", "Ala", "gym")
	b, _ := e.join("client-bbbb", "Bob", "gym")
	a.send(cmd("c1", playFolder("a")))
	a.until(3*time.Second, func(s protocol.State) bool { return s.Hold != nil })
	a.send(protocol.Status{Type: protocol.TypeStatus, TrackID: "a", Ready: true})
	b.ws.Close(websocket.StatusNormalClosure, "bye")
	a.until(3*time.Second, func(s protocol.State) bool { return s.Hold == nil })
	p := a.untilPresence(3*time.Second, func(p protocol.Presence) bool {
		for _, m := range p.Members {
			if m.Name == "Bob" && !m.Connected {
				return true
			}
		}
		return false
	})
	if len(p.Members) != 2 {
		t.Fatalf("disconnected member should stay visible for a while: %+v", p.Members)
	}
}

func TestPresenceReportsStatus(t *testing.T) {
	e := newEnv(t)
	a, _ := e.join("client-aaaa", "Ala", "gym")
	drift := 12.5
	a.send(protocol.Status{Type: protocol.TypeStatus, TrackID: "a", Ready: true, Playing: true, DriftMs: &drift, Offline: 42})
	p := a.untilPresence(3*time.Second, func(p protocol.Presence) bool {
		return len(p.Members) == 1 && p.Members[0].DriftMs != nil
	})
	m := p.Members[0]
	if m.Name != "Ala" || !m.Connected || !m.Ready || *m.DriftMs != 12.5 || m.Offline != 42 {
		t.Fatalf("member = %+v", m)
	}
	a.send(protocol.Profile{Type: protocol.TypeProfile, Name: "  Ala   Kot  "})
	a.untilPresence(3*time.Second, func(p protocol.Presence) bool { return p.Members[0].Name == "Ala Kot" })
}

func TestReconnectReplacesOldConnection(t *testing.T) {
	e := newEnv(t)
	old, _ := e.join("client-aaaa", "Ala", "gym")
	_, _ = e.join("client-aaaa", "Ala", "gym")
	var perr protocol.Error
	if err := json.Unmarshal(old.next(protocol.TypeError, 3*time.Second), &perr); err != nil || perr.Code != "replaced" {
		t.Fatalf("old connection error = %+v %v", perr, err)
	}
	deadline := time.After(3 * time.Second)
	for {
		select {
		case _, ok := <-old.msgs:
			if !ok {
				return
			}
		case <-deadline:
			t.Fatal("old connection was not closed")
		}
	}
}

func TestPingPong(t *testing.T) {
	e := newEnv(t)
	c := e.dial()
	c.send(protocol.Ping{Type: protocol.TypePing, ID: 7, T0: 123.5})
	var p protocol.Pong
	if err := json.Unmarshal(c.next(protocol.TypePong, 3*time.Second), &p); err != nil {
		t.Fatal(err)
	}
	now := float64(time.Now().UnixMilli())
	if p.ID != 7 || p.T0 != 123.5 || p.T1 <= 0 || p.T2 < p.T1 || p.T2 > now+1000 {
		t.Fatalf("pong = %+v", p)
	}
}

func TestProtocolErrors(t *testing.T) {
	e := newEnv(t)
	c := e.dial()
	c.send(map[string]any{"type": "cmd", "id": "x", "cmd": map[string]any{"op": "play"}})
	var perr protocol.Error
	_ = json.Unmarshal(c.next(protocol.TypeError, 3*time.Second), &perr)
	if perr.Code != "not_joined" {
		t.Fatalf("error = %+v", perr)
	}
	if err := c.ws.Write(context.Background(), websocket.MessageText, []byte("{not json")); err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal(c.next(protocol.TypeError, 3*time.Second), &perr)
	if perr.Code != "bad_message" {
		t.Fatalf("error = %+v", perr)
	}
	c.send(map[string]any{"type": "dance"})
	_ = json.Unmarshal(c.next(protocol.TypeError, 3*time.Second), &perr)
	if perr.Code != "bad_message" {
		t.Fatalf("error = %+v", perr)
	}
	h := hello("client-aaaa", "Ala", "bad/room!")
	c.send(h)
	_ = json.Unmarshal(c.next(protocol.TypeError, 3*time.Second), &perr)
	if perr.Code != "bad_room" {
		t.Fatalf("error = %+v", perr)
	}
	c.send(hello("x", "Ala", "gym"))
	_ = json.Unmarshal(c.next(protocol.TypeError, 3*time.Second), &perr)
	if perr.Code != "bad_client" {
		t.Fatalf("error = %+v", perr)
	}
	c.send(hello("client-aaaa", "Ala", "gym"))
	c.next(protocol.TypeWelcome, 3*time.Second)
	c.send(hello("client-aaaa", "Ala", "gym"))
	_ = json.Unmarshal(c.next(protocol.TypeError, 3*time.Second), &perr)
	if perr.Code != "already_joined" {
		t.Fatalf("error = %+v", perr)
	}
}

func TestProtocolMismatchCloses(t *testing.T) {
	e := newEnv(t)
	c := e.dial()
	h := hello("client-aaaa", "Ala", "gym")
	h.Protocol = 999
	c.send(h)
	var perr protocol.Error
	_ = json.Unmarshal(c.next(protocol.TypeError, 3*time.Second), &perr)
	if perr.Code != "protocol_mismatch" {
		t.Fatalf("error = %+v", perr)
	}
}

func TestCrossOriginRejected(t *testing.T) {
	e := newEnv(t)
	url := "ws" + strings.TrimPrefix(e.srv.URL, "http")
	_, resp, err := websocket.Dial(context.Background(), url, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"https://evil.example"}},
	})
	if err == nil {
		t.Fatal("cross-origin websocket must be rejected")
	}
	if resp != nil && resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	// Explicitly allowed origins work.
	e2 := newEnv(t, func(o *Options) { o.OriginPatterns = []string{"localhost:5173"} })
	c := e2.dial(http.Header{"Origin": []string{"http://localhost:5173"}})
	c.send(protocol.Ping{Type: protocol.TypePing, ID: 1})
	c.next(protocol.TypePong, 3*time.Second)
}

func TestStatePersistsAcrossRestarts(t *testing.T) {
	e := newEnv(t)
	a, _ := e.join("client-aaaa", "Ala", "Gym Bros")
	a.send(cmd("c1", playFolder("a", "b", "c")))
	readAck(t, a)
	a.send(cmd("c2", room.Command{Op: "queueAdd", TrackIDs: []string{"c"}}))
	readAck(t, a)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := e.hub.Close(ctx); err != nil {
		t.Fatal(err)
	}
	rec, err := e.db.LoadRoom(ctx, "gym-bros")
	if err != nil {
		t.Fatal(err)
	}
	if rec.Name != "Gym Bros" {
		t.Fatalf("room name = %q", rec.Name)
	}

	h2 := New(Options{Catalog: catalog, Store: e.db, StartDelay: time.Millisecond, Logger: slog.New(slog.DiscardHandler)})
	srv := httptest.NewServer(h2)
	defer srv.Close()
	defer h2.Close(context.Background())
	e2 := &env{t: t, hub: h2, srv: srv, db: e.db}
	c := e2.dial()
	c.send(hello("client-cccc", "Cyd", "gym bros"))
	st := c.until(5*time.Second, func(protocol.State) bool { return true })
	if st.Queue == nil || len(*st.Queue) != 1 || st.Context == nil || len(st.Context.Tracks) != 3 {
		t.Fatalf("restored state = %+v", st)
	}
	rooms, err := h2.Rooms(context.Background())
	if err != nil || len(rooms) != 1 || rooms[0].Name != "Gym Bros" || len(rooms[0].Listeners) != 1 {
		t.Fatalf("rooms = %+v, %v", rooms, err)
	}
}

func TestLibraryChangedNotifiesClients(t *testing.T) {
	e := newEnv(t)
	a, _ := e.join("client-aaaa", "Ala", "gym")
	e.hub.LibraryChanged("lib-v2")
	var msg protocol.Library
	if err := json.Unmarshal(a.next(protocol.TypeLibrary, 3*time.Second), &msg); err != nil || msg.Version != "lib-v2" {
		t.Fatalf("library message = %+v %v", msg, err)
	}
}

func TestPrewarmUpcomingTracks(t *testing.T) {
	var mu sync.Mutex
	got := map[string]bool{}
	e := newEnv(t, func(o *Options) {
		o.Prewarm = func(id, format, quality string) {
			mu.Lock()
			got[id+"/"+format+"/"+quality] = true
			mu.Unlock()
		}
	})
	a, _ := e.join("client-aaaa", "Ala", "gym")
	a.send(cmd("c1", playFolder("a", "b", "c")))
	readAck(t, a)
	mu.Lock()
	defer mu.Unlock()
	for _, id := range []string{"a", "b", "c"} {
		if !got[id+"/opus/medium"] {
			t.Fatalf("track %s not prewarmed: %v", id, got)
		}
	}
}

func TestRoomsListing(t *testing.T) {
	e := newEnv(t)
	_, _ = e.join("client-aaaa", "Ala", "gym")
	_, _ = e.join("client-bbbb", "Bob", "chill")
	_, _ = e.join("client-cccc", "Cyd", "gym")
	rooms, err := e.hub.Rooms(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(rooms) != 2 || rooms[0].ID != "gym" || len(rooms[0].Listeners) != 2 || rooms[1].ID != "chill" {
		t.Fatalf("rooms = %+v", rooms)
	}
}

func TestMaxRooms(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.MaxRooms = 1 })
	_, _ = e.join("client-aaaa", "Ala", "one")
	c := e.dial()
	c.send(hello("client-bbbb", "Bob", "two"))
	var perr protocol.Error
	_ = json.Unmarshal(c.next(protocol.TypeError, 3*time.Second), &perr)
	if perr.Code != "join_failed" {
		t.Fatalf("error = %+v", perr)
	}
}

func TestIdleRoomIsUnloaded(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.RoomIdleTimeout = time.Millisecond })
	a, _ := e.join("client-aaaa", "Ala", "gym")
	a.send(cmd("c1", playFolder("a")))
	readAck(t, a)
	a.ws.Close(websocket.StatusNormalClosure, "")
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		e.hub.mu.Lock()
		n := len(e.hub.rooms)
		e.hub.mu.Unlock()
		if n == 0 {
			if _, err := e.db.LoadRoom(context.Background(), "gym"); err != nil {
				t.Fatalf("unloaded room should be persisted: %v", err)
			}
			// Joining again loads it from the store.
			_, st := e.join("client-bbbb", "Bob", "gym")
			if st.Playback.TrackID != "a" {
				t.Fatalf("reloaded state = %+v", st)
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("idle room was not unloaded")
}

func TestNormalizeRoomName(t *testing.T) {
	cases := map[string]string{"": "main", "  Siłownia   Bros ": "Siłownia Bros", "gym_2-b": "gym_2-b"}
	for in, want := range cases {
		got, ok := NormalizeRoomName(in)
		if !ok || got != want {
			t.Errorf("NormalizeRoomName(%q) = %q, %v", in, got, ok)
		}
	}
	for _, bad := range []string{"a/b", "<script>", strings.Repeat("x", 33)} {
		if _, ok := NormalizeRoomName(bad); ok {
			t.Errorf("NormalizeRoomName(%q) should fail", bad)
		}
	}
	if RoomID("Siłownia Bros") != "siłownia-bros" {
		t.Fatal("RoomID")
	}
}

func TestSanitize(t *testing.T) {
	if sanitizeName(" \tAla\nKot ") != "Ala Kot" || sanitizeName("") != "Listener" || len([]rune(sanitizeName(strings.Repeat("ż", 50)))) != 32 {
		t.Fatal("sanitizeName")
	}
	if sanitizeClientID("abc") != "" || sanitizeClientID("valid-id_123") != "valid-id_123" || sanitizeClientID("bad id!!") != "" {
		t.Fatal("sanitizeClientID")
	}
}

func TestServeAfterCloseRejected(t *testing.T) {
	e := newEnv(t)
	if err := e.hub.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	e.hub.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", rec.Code)
	}
}
