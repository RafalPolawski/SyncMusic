package room

import (
	"encoding/json"
	"errors"
	"math/rand/v2"
	"reflect"
	"slices"
	"testing"
)

var testCatalog = MapCatalog{"a": 10000, "b": 20000, "c": 5000, "d": 8000, "e": 7000}

func newTestEngine() *Engine {
	s := NewState()
	s.WaitForAll = false
	return NewEngine(s, testCatalog, Options{StartDelayMs: 1000, ResumeDelayMs: 300, WaitForAllMaxMs: 5000}, rand.New(rand.NewPCG(1, 2)))
}

func ptr[T any](v T) *T { return &v }

func mustApply(t *testing.T, e *Engine, cmd Command, now int64) Changes {
	t.Helper()
	ch, err := e.Apply(cmd, now, "tester")
	if err != nil {
		t.Fatalf("%s: %v", cmd.Op, err)
	}
	return ch
}

func folder(tracks ...string) *ContextSpec {
	return &ContextSpec{Kind: "folder", ID: "F", Name: "Folder", Tracks: tracks}
}

func TestPlayContextStartsAfterLeadTime(t *testing.T) {
	e := newTestEngine()
	ch := mustApply(t, e, Command{Op: "playContext", Context: folder("a", "b", "c"), StartIndex: ptr(1)}, 5000)
	if ch&ChangedPlayback == 0 || ch&ChangedContext == 0 {
		t.Fatalf("changes = %b", ch)
	}
	p := e.State.Playback
	if p.TrackID != "b" || !p.Playing || p.AnchorMs != 6000 || p.PositionMs != 0 || p.DurationMs != 20000 {
		t.Fatalf("playback = %+v", p)
	}
	if e.State.ContextIndex != 1 || e.State.Version != 1 || e.State.ContextVersion != 1 {
		t.Fatalf("state = %+v", e.State)
	}
	if !slices.Equal(e.State.Context.Order, []int{0, 1, 2}) {
		t.Fatalf("order = %v", e.State.Context.Order)
	}
}

func TestPlayContextFiltersUnknownTracks(t *testing.T) {
	e := newTestEngine()
	mustApply(t, e, Command{Op: "playContext", Context: folder("x", "a", "y", "c"), StartIndex: ptr(3)}, 0)
	if !slices.Equal(e.State.Context.Tracks, []string{"a", "c"}) || e.State.Playback.TrackID != "c" || e.State.ContextIndex != 1 {
		t.Fatalf("state = %+v", e.State)
	}
	_, err := e.Apply(Command{Op: "playContext", Context: folder("x", "a"), StartIndex: ptr(0)}, 0, "")
	assertCode(t, err, "unknown_track")
	_, err = e.Apply(Command{Op: "playContext", Context: folder("x", "y")}, 0, "")
	assertCode(t, err, "unknown_track")
	_, err = e.Apply(Command{Op: "playContext"}, 0, "")
	assertCode(t, err, "bad_request")
}

func assertCode(t *testing.T, err error, code string) {
	t.Helper()
	var ce *Error
	if !errors.As(err, &ce) || ce.Code != code {
		t.Fatalf("want error code %q, got %v", code, err)
	}
}

func TestPauseAndResume(t *testing.T) {
	e := newTestEngine()
	mustApply(t, e, Command{Op: "playContext", Context: folder("a", "b")}, 0) // a starts at 1000
	mustApply(t, e, Command{Op: "pause"}, 4000)
	p := e.State.Playback
	if p.Playing || p.PositionMs != 3000 || p.AnchorMs != 4000 {
		t.Fatalf("after pause: %+v", p)
	}
	if _, err := e.Apply(Command{Op: "pause"}, 5000, ""); !errors.Is(err, ErrNoChange) {
		t.Fatalf("second pause should be a no-op, got %v", err)
	}
	mustApply(t, e, Command{Op: "play"}, 10000)
	p = e.State.Playback
	if !p.Playing || p.PositionMs != 3000 || p.AnchorMs != 10300 {
		t.Fatalf("after resume: %+v", p)
	}
	if _, err := e.Apply(Command{Op: "play"}, 10001, ""); !errors.Is(err, ErrNoChange) {
		t.Fatalf("play while playing should be a no-op, got %v", err)
	}
}

func TestPauseTrustsListenerPositionWithinWindow(t *testing.T) {
	e := newTestEngine()
	mustApply(t, e, Command{Op: "playContext", Context: folder("a")}, 0)
	mustApply(t, e, Command{Op: "pause", PositionMs: ptr[int64](2500)}, 4000) // server thinks 3000
	if e.State.Playback.PositionMs != 2500 {
		t.Fatalf("listener position not trusted: %+v", e.State.Playback)
	}
	mustApply(t, e, Command{Op: "play"}, 5000)
	mustApply(t, e, Command{Op: "pause", PositionMs: ptr[int64](9000)}, 6000) // server thinks 3200
	if e.State.Playback.PositionMs != 3200 {
		t.Fatalf("far-off position should be ignored: %+v", e.State.Playback)
	}
}

func TestSeek(t *testing.T) {
	e := newTestEngine()
	_, err := e.Apply(Command{Op: "seek", PositionMs: ptr[int64](1)}, 0, "")
	assertCode(t, err, "nothing_to_play")
	mustApply(t, e, Command{Op: "playContext", Context: folder("a")}, 0)
	mustApply(t, e, Command{Op: "seek", PositionMs: ptr[int64](7000)}, 2000)
	if p := e.State.Playback; p.PositionMs != 7000 || p.AnchorMs != 2300 || !p.Playing {
		t.Fatalf("seek while playing: %+v", p)
	}
	mustApply(t, e, Command{Op: "seek", PositionMs: ptr[int64](-5)}, 2500)
	if e.State.Playback.PositionMs != 0 {
		t.Fatal("negative seek not clamped")
	}
	mustApply(t, e, Command{Op: "pause"}, 3000)
	mustApply(t, e, Command{Op: "seek", PositionMs: ptr[int64](99999)}, 3100)
	if p := e.State.Playback; p.PositionMs != 10000 || p.AnchorMs != 3100 || p.Playing {
		t.Fatalf("seek while paused: %+v", p)
	}
	_, err = e.Apply(Command{Op: "seek"}, 0, "")
	assertCode(t, err, "bad_request")
}

func TestNextPrev(t *testing.T) {
	e := newTestEngine()
	mustApply(t, e, Command{Op: "playContext", Context: folder("a", "b", "c")}, 0)
	mustApply(t, e, Command{Op: "next"}, 2000)
	if e.State.Playback.TrackID != "b" || e.State.Playback.AnchorMs != 3000 || e.State.ContextIndex != 1 {
		t.Fatalf("next: %+v", e.State.Playback)
	}
	// Early in the track: previous goes back.
	mustApply(t, e, Command{Op: "prev"}, 4000)
	if e.State.Playback.TrackID != "a" || e.State.ContextIndex != 0 {
		t.Fatalf("prev: %+v", e.State.Playback)
	}
	// Late in the track: previous restarts it.
	mustApply(t, e, Command{Op: "prev"}, 9000) // a playing since 5000 -> 4000ms in
	if p := e.State.Playback; p.TrackID != "a" || p.PositionMs != 0 || p.AnchorMs != 9300 {
		t.Fatalf("prev restart: %+v", p)
	}
	// At the first track without repeat: restart.
	mustApply(t, e, Command{Op: "prev"}, 9500)
	if e.State.Playback.TrackID != "a" {
		t.Fatal("prev at start should restart")
	}
	// Repeat all: previous wraps to the end.
	mustApply(t, e, Command{Op: "repeat", Mode: RepeatAll}, 9600)
	mustApply(t, e, Command{Op: "prev"}, 9700)
	if e.State.Playback.TrackID != "c" || e.State.ContextIndex != 2 {
		t.Fatalf("prev wrap: %+v", e.State.Playback)
	}
	mustApply(t, e, Command{Op: "next"}, 9800)
	if e.State.Playback.TrackID != "a" {
		t.Fatalf("next wrap: %+v", e.State.Playback)
	}
}

func TestNextAtEndParksOnFirstTrack(t *testing.T) {
	e := newTestEngine()
	mustApply(t, e, Command{Op: "playContext", Context: folder("a", "b"), StartIndex: ptr(1)}, 0)
	mustApply(t, e, Command{Op: "next"}, 2000)
	p := e.State.Playback
	if p.TrackID != "a" || p.Playing || p.PositionMs != 0 || e.State.ContextIndex != 0 {
		t.Fatalf("next at end: %+v", p)
	}
	if _, err := newTestEngine().Apply(Command{Op: "next"}, 0, ""); !errors.Is(err, ErrNoChange) {
		t.Fatalf("next on empty room should be a no-op, got %v", err)
	}
}

func TestQueueOperations(t *testing.T) {
	e := newTestEngine()
	mustApply(t, e, Command{Op: "playContext", Context: folder("a", "b")}, 0)
	ch := mustApply(t, e, Command{Op: "queueAdd", TrackIDs: []string{"c", "d"}}, 100)
	if ch&ChangedQueue == 0 || e.State.QueueVersion != 1 {
		t.Fatalf("queueAdd changes=%b qv=%d", ch, e.State.QueueVersion)
	}
	mustApply(t, e, Command{Op: "queueAdd", TrackIDs: []string{"e"}, Next: true}, 200)
	if got := queueTracks(e); !slices.Equal(got, []string{"e", "c", "d"}) {
		t.Fatalf("queue = %v", got)
	}
	if e.State.Queue[0].AddedBy != "tester" || e.State.Queue[0].ID == e.State.Queue[1].ID {
		t.Fatalf("entries = %+v", e.State.Queue)
	}
	// Move "d" to the front.
	mustApply(t, e, Command{Op: "queueMove", EntryID: e.State.Queue[2].ID, ToIndex: ptr(0)}, 300)
	if got := queueTracks(e); !slices.Equal(got, []string{"d", "e", "c"}) {
		t.Fatalf("after move = %v", got)
	}
	mustApply(t, e, Command{Op: "queueMove", EntryID: e.State.Queue[0].ID, ToIndex: ptr(99)}, 310)
	if got := queueTracks(e); !slices.Equal(got, []string{"e", "c", "d"}) {
		t.Fatalf("after move to end = %v", got)
	}
	// Next plays the head of the queue and keeps the context position.
	mustApply(t, e, Command{Op: "next"}, 400)
	if p := e.State.Playback; p.TrackID != "e" || p.EntryID == "" || e.State.ContextIndex != 0 {
		t.Fatalf("next from queue: %+v", p)
	}
	// Previous from a queued track returns to the interrupted context track.
	mustApply(t, e, Command{Op: "prev"}, 500)
	if p := e.State.Playback; p.TrackID != "a" || p.EntryID != "" {
		t.Fatalf("prev from queue: %+v", p)
	}
	// Play a specific entry.
	target := e.State.Queue[1] // "d"
	mustApply(t, e, Command{Op: "playEntry", EntryID: target.ID}, 600)
	if p := e.State.Playback; p.TrackID != "d" || p.EntryID != target.ID {
		t.Fatalf("playEntry: %+v", p)
	}
	if got := queueTracks(e); !slices.Equal(got, []string{"c"}) {
		t.Fatalf("queue after playEntry = %v", got)
	}
	mustApply(t, e, Command{Op: "queueRemove", EntryID: e.State.Queue[0].ID}, 700)
	if len(e.State.Queue) != 0 {
		t.Fatal("queueRemove failed")
	}
	if _, err := e.Apply(Command{Op: "queueClear"}, 800, ""); !errors.Is(err, ErrNoChange) {
		t.Fatalf("clearing an empty queue should be a no-op, got %v", err)
	}
	mustApply(t, e, Command{Op: "queueAdd", TrackIDs: []string{"a"}}, 900)
	mustApply(t, e, Command{Op: "queueClear"}, 901)
	if len(e.State.Queue) != 0 {
		t.Fatal("queueClear failed")
	}

	_, err := e.Apply(Command{Op: "queueAdd", TrackIDs: []string{"zzz"}}, 0, "")
	assertCode(t, err, "unknown_track")
	_, err = e.Apply(Command{Op: "queueAdd"}, 0, "")
	assertCode(t, err, "bad_request")
	_, err = e.Apply(Command{Op: "queueRemove", EntryID: "nope"}, 0, "")
	assertCode(t, err, "not_found")
	_, err = e.Apply(Command{Op: "queueMove", EntryID: "nope", ToIndex: ptr(0)}, 0, "")
	assertCode(t, err, "not_found")
	_, err = e.Apply(Command{Op: "queueMove", EntryID: "nope"}, 0, "")
	assertCode(t, err, "bad_request")
	_, err = e.Apply(Command{Op: "playEntry", EntryID: "nope"}, 0, "")
	assertCode(t, err, "not_found")
}

func TestQueueLimit(t *testing.T) {
	e := newTestEngine()
	ids := make([]string, MaxQueueLength)
	for i := range ids {
		ids[i] = "a"
	}
	mustApply(t, e, Command{Op: "queueAdd", TrackIDs: ids}, 0)
	_, err := e.Apply(Command{Op: "queueAdd", TrackIDs: []string{"b"}}, 0, "")
	assertCode(t, err, "queue_full")
}

func queueTracks(e *Engine) []string {
	var out []string
	for _, q := range e.State.Queue {
		out = append(out, q.TrackID)
	}
	return out
}

func TestShuffleKeepsCurrentTrackFirst(t *testing.T) {
	e := newTestEngine()
	tracks := []string{"a", "b", "c", "d", "e"}
	mustApply(t, e, Command{Op: "playContext", Context: folder(tracks...), StartIndex: ptr(2)}, 0)
	ch := mustApply(t, e, Command{Op: "shuffle", On: ptr(true)}, 100)
	if ch&ChangedContext == 0 || e.State.ContextVersion != 2 {
		t.Fatalf("shuffle changes=%b cv=%d", ch, e.State.ContextVersion)
	}
	order := e.State.Context.Order
	if order[0] != 2 || e.State.ContextIndex != 0 {
		t.Fatalf("current track must lead the shuffled order: %v idx=%d", order, e.State.ContextIndex)
	}
	sorted := slices.Clone(order)
	slices.Sort(sorted)
	if !slices.Equal(sorted, []int{0, 1, 2, 3, 4}) {
		t.Fatalf("order is not a permutation: %v", order)
	}
	if e.State.Playback.TrackID != "c" {
		t.Fatal("shuffle must not change the current track")
	}
	// Advance two tracks, then turn shuffle off: context index follows the
	// natural position of the current track.
	mustApply(t, e, Command{Op: "next"}, 200)
	current := e.State.Playback.TrackID
	mustApply(t, e, Command{Op: "shuffle", On: ptr(false)}, 300)
	if !slices.Equal(e.State.Context.Order, []int{0, 1, 2, 3, 4}) || tracks[e.State.ContextIndex] != current {
		t.Fatalf("unshuffle: order=%v idx=%d current=%s", e.State.Context.Order, e.State.ContextIndex, current)
	}
	if _, err := e.Apply(Command{Op: "shuffle", On: ptr(false)}, 400, ""); !errors.Is(err, ErrNoChange) {
		t.Fatalf("repeated shuffle off should be a no-op, got %v", err)
	}
	_, err := e.Apply(Command{Op: "shuffle"}, 0, "")
	assertCode(t, err, "bad_request")
}

func TestPlayContextWithShuffle(t *testing.T) {
	e := newTestEngine()
	mustApply(t, e, Command{Op: "shuffle", On: ptr(true)}, 0)
	mustApply(t, e, Command{Op: "playContext", Context: folder("a", "b", "c", "d"), StartIndex: ptr(3)}, 0)
	if e.State.Playback.TrackID != "d" || e.State.Context.Order[0] != 3 || e.State.ContextIndex != 0 {
		t.Fatalf("shuffled start: %+v order=%v", e.State.Playback, e.State.Context.Order)
	}
	mustApply(t, e, Command{Op: "playContext", Context: folder("a", "b", "c", "d")}, 0)
	if e.State.ContextIndex != 0 || e.State.Playback.TrackID != e.State.Context.Tracks[e.State.Context.Order[0]] {
		t.Fatalf("shuffle play: %+v", e.State)
	}
}

func TestRepeatAndValidation(t *testing.T) {
	e := newTestEngine()
	mustApply(t, e, Command{Op: "repeat", Mode: RepeatOne}, 0)
	if e.State.Repeat != RepeatOne {
		t.Fatal("repeat not set")
	}
	_, err := e.Apply(Command{Op: "repeat", Mode: "sometimes"}, 0, "")
	assertCode(t, err, "bad_request")
	_, err = e.Apply(Command{Op: "dance"}, 0, "")
	assertCode(t, err, "unknown_op")
	_, err = e.Apply(Command{Op: "jump"}, 0, "")
	assertCode(t, err, "bad_request")
	_, err = e.Apply(Command{Op: "jump", Index: ptr(5)}, 0, "")
	assertCode(t, err, "bad_request")
}

func TestJump(t *testing.T) {
	e := newTestEngine()
	mustApply(t, e, Command{Op: "playContext", Context: folder("a", "b", "c")}, 0)
	mustApply(t, e, Command{Op: "jump", Index: ptr(2)}, 100)
	if e.State.Playback.TrackID != "c" || e.State.ContextIndex != 2 {
		t.Fatalf("jump: %+v", e.State.Playback)
	}
}

func TestPlayWithoutTrackStartsContextOrQueue(t *testing.T) {
	e := newTestEngine()
	_, err := e.Apply(Command{Op: "play"}, 0, "")
	assertCode(t, err, "nothing_to_play")
	mustApply(t, e, Command{Op: "queueAdd", TrackIDs: []string{"d"}}, 0)
	mustApply(t, e, Command{Op: "play"}, 100)
	if p := e.State.Playback; p.TrackID != "d" || !p.Playing || p.AnchorMs != 1100 {
		t.Fatalf("play from queue: %+v", p)
	}
}

func TestApplyNormalizesFirst(t *testing.T) {
	e := newTestEngine()
	mustApply(t, e, Command{Op: "playContext", Context: folder("a", "b")}, 0) // a: 1000..11000
	// Pausing at 12000 must pause b (auto-advanced), not a.
	ch := mustApply(t, e, Command{Op: "pause"}, 12000)
	if p := e.State.Playback; p.TrackID != "b" || p.PositionMs != 1000 || p.Playing {
		t.Fatalf("pause after auto advance: %+v", p)
	}
	if ch&ChangedPlayback == 0 {
		t.Fatal("changes must include playback")
	}
	// A no-op command after an advance still reports the advance.
	e2 := newTestEngine()
	mustApply(t, e2, Command{Op: "playContext", Context: folder("a", "b")}, 0)
	v := e2.State.Version
	ch, err := e2.Apply(Command{Op: "play"}, 12000, "")
	if err != nil || ch&ChangedPlayback == 0 || e2.State.Version != v+1 {
		t.Fatalf("advance not reported: ch=%b err=%v v=%d", ch, err, e2.State.Version)
	}
}

func TestEndedFallbackForUnknownDuration(t *testing.T) {
	cat := MapCatalog{"u": 0, "a": 10000}
	e := NewEngine(NewState(), cat, Options{StartDelayMs: 0}, nil)
	e.State.WaitForAll = false
	mustApply(t, e, Command{Op: "playContext", Context: folder("u", "a")}, 0)
	if _, err := e.Apply(Command{Op: "ended", TrackID: "a"}, 100, ""); !errors.Is(err, ErrNoChange) {
		t.Fatalf("ended for another track must be ignored, got %v", err)
	}
	mustApply(t, e, Command{Op: "ended", TrackID: "u"}, 60000)
	if p := e.State.Playback; p.TrackID != "a" || p.AnchorMs != 60000 {
		t.Fatalf("ended fallback: %+v", p)
	}
	// Duplicate report is ignored because the duration is now known.
	if _, err := e.Apply(Command{Op: "ended", TrackID: "u"}, 60001, ""); !errors.Is(err, ErrNoChange) {
		t.Fatalf("duplicate ended must be ignored, got %v", err)
	}
}

func TestWaitForAllHold(t *testing.T) {
	e := newTestEngine()
	mustApply(t, e, Command{Op: "waitForAll", On: ptr(true)}, 0)
	mustApply(t, e, Command{Op: "playContext", Context: folder("a", "b")}, 0) // anchor 1000, hold until 5000
	h := e.State.Hold
	if h == nil || h.TrackID != "a" || h.UntilMs != 5000 {
		t.Fatalf("hold = %+v", h)
	}
	// Not everyone ready, anchor still far: nothing to do, check again later.
	ch, next := e.CheckHold(200, false)
	if ch != 0 || next != 750 {
		t.Fatalf("early check: ch=%b next=%d", ch, next)
	}
	// Anchor imminent and someone still buffering: postpone.
	v := e.State.Version
	ch, next = e.CheckHold(800, false)
	if ch == 0 || e.State.Playback.AnchorMs != 1800 || e.State.Version != v+1 || next != 1550 {
		t.Fatalf("postpone: ch=%b anchor=%d next=%d", ch, e.State.Playback.AnchorMs, next)
	}
	// Everyone ready with time to spare: release, keep anchor.
	ch, next = e.CheckHold(1000, true)
	if ch == 0 || e.State.Hold != nil || e.State.Playback.AnchorMs != 1800 || next != 0 {
		t.Fatalf("release: ch=%b hold=%+v anchor=%d", ch, e.State.Hold, e.State.Playback.AnchorMs)
	}
	if ch, _ := e.CheckHold(1100, true); ch != 0 {
		t.Fatal("no hold, no changes")
	}
}

func TestWaitForAllHoldReleasedLate(t *testing.T) {
	e := newTestEngine()
	mustApply(t, e, Command{Op: "waitForAll", On: ptr(true)}, 0)
	mustApply(t, e, Command{Op: "playContext", Context: folder("a")}, 0)
	e.CheckHold(800, false) // anchor -> 1800
	e.CheckHold(1600, false)
	// Ready after the anchor has nearly passed: restart with a fresh lead.
	e.CheckHold(2700, true)
	if e.State.Playback.AnchorMs != 3000 {
		t.Fatalf("late release anchor = %d", e.State.Playback.AnchorMs)
	}
}

func TestWaitForAllHoldGivesUp(t *testing.T) {
	e := newTestEngine()
	mustApply(t, e, Command{Op: "waitForAll", On: ptr(true)}, 0)
	mustApply(t, e, Command{Op: "playContext", Context: folder("a")}, 0)
	for now := int64(0); now < 5000; now += 100 {
		e.CheckHold(now, false)
	}
	ch, next := e.CheckHold(5000, false)
	if ch == 0 || e.State.Hold != nil || next != 0 {
		t.Fatalf("give up: ch=%b hold=%+v", ch, e.State.Hold)
	}
}

func TestHoldClearedByPauseSeekAndToggle(t *testing.T) {
	for _, cmd := range []Command{
		{Op: "pause"},
		{Op: "seek", PositionMs: ptr[int64](500)},
		{Op: "waitForAll", On: ptr(false)},
	} {
		e := newTestEngine()
		mustApply(t, e, Command{Op: "waitForAll", On: ptr(true)}, 0)
		mustApply(t, e, Command{Op: "playContext", Context: folder("a")}, 0)
		mustApply(t, e, cmd, 100)
		if e.State.Hold != nil {
			t.Fatalf("%s should clear the hold", cmd.Op)
		}
	}
	e := newTestEngine()
	mustApply(t, e, Command{Op: "waitForAll", On: ptr(true)}, 0)
	mustApply(t, e, Command{Op: "playContext", Context: folder("a", "b")}, 0)
	// Track changed behind the hold's back (e.g. auto advance): dropped.
	e.State.Playback.TrackID = "b"
	if ch, _ := e.CheckHold(100, false); ch == 0 || e.State.Hold != nil {
		t.Fatal("stale hold should be dropped")
	}
}

func TestStateJSONRoundTrip(t *testing.T) {
	e := newTestEngine()
	mustApply(t, e, Command{Op: "playContext", Context: folder("a", "b", "c")}, 0)
	mustApply(t, e, Command{Op: "queueAdd", TrackIDs: []string{"d"}}, 0)
	b, err := json.Marshal(e.State)
	if err != nil {
		t.Fatal(err)
	}
	var back State
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(back, e.State) {
		t.Fatalf("round trip mismatch:\n%+v\n%+v", back, e.State)
	}
}

func TestNewEngineRepairsState(t *testing.T) {
	e := NewEngine(State{Repeat: "bogus"}, testCatalog, Options{}, nil)
	if e.State.Repeat != RepeatOff || e.State.Queue == nil || e.State.Context.Tracks == nil || e.State.Context.Order == nil {
		t.Fatalf("state not repaired: %+v", e.State)
	}
}

// TestRandomCommandsKeepInvariants drives the engine with random commands
// and checks structural invariants after each step.
func TestRandomCommandsKeepInvariants(t *testing.T) {
	rng := rand.New(rand.NewPCG(7, 7))
	ids := []string{"a", "b", "c", "d", "e", "zz"}
	for run := range 50 {
		e := newTestEngine()
		e.State.WaitForAll = run%2 == 0
		now := int64(0)
		var lastVersion uint64
		for step := range 300 {
			now += rng.Int64N(6000)
			var cmd Command
			switch rng.IntN(13) {
			case 0:
				n := 1 + rng.IntN(5)
				tr := make([]string, n)
				for i := range tr {
					tr[i] = ids[rng.IntN(len(ids))]
				}
				cmd = Command{Op: "playContext", Context: folder(tr...), StartIndex: ptr(rng.IntN(n))}
			case 1:
				cmd = Command{Op: "play"}
			case 2:
				cmd = Command{Op: "pause", PositionMs: ptr(rng.Int64N(25000))}
			case 3:
				cmd = Command{Op: "seek", PositionMs: ptr(rng.Int64N(25000) - 100)}
			case 4:
				cmd = Command{Op: "next"}
			case 5:
				cmd = Command{Op: "prev"}
			case 6:
				cmd = Command{Op: "queueAdd", TrackIDs: []string{ids[rng.IntN(len(ids)-1)]}, Next: rng.IntN(2) == 0}
			case 7:
				if len(e.State.Queue) > 0 {
					cmd = Command{Op: "queueRemove", EntryID: e.State.Queue[rng.IntN(len(e.State.Queue))].ID}
				}
			case 8:
				if len(e.State.Queue) > 0 {
					cmd = Command{Op: "queueMove", EntryID: e.State.Queue[rng.IntN(len(e.State.Queue))].ID, ToIndex: ptr(rng.IntN(5))}
				}
			case 9:
				cmd = Command{Op: "shuffle", On: ptr(rng.IntN(2) == 0)}
			case 10:
				cmd = Command{Op: "repeat", Mode: []Repeat{RepeatOff, RepeatAll, RepeatOne}[rng.IntN(3)]}
			case 11:
				if n := len(e.State.Context.Order); n > 0 {
					cmd = Command{Op: "jump", Index: ptr(rng.IntN(n))}
				}
			case 12:
				e.CheckHold(now, rng.IntN(2) == 0)
			}
			if cmd.Op != "" {
				_, _ = e.Apply(cmd, now, "fuzz")
			}
			checkInvariants(t, e, run, step, now)
			if e.State.Version < lastVersion {
				t.Fatalf("version went backwards")
			}
			lastVersion = e.State.Version
		}
	}
}

func checkInvariants(t *testing.T, e *Engine, run, step int, now int64) {
	t.Helper()
	s := e.State
	fail := func(msg string) {
		t.Fatalf("run %d step %d (now %d): %s\nstate: %+v", run, step, now, msg, s)
	}
	if len(s.Context.Order) != len(s.Context.Tracks) {
		fail("order length differs from tracks")
	}
	seen := make([]bool, len(s.Context.Tracks))
	for _, v := range s.Context.Order {
		if v < 0 || v >= len(seen) || seen[v] {
			fail("order is not a permutation")
		}
		seen[v] = true
	}
	if s.ContextIndex < -1 || s.ContextIndex >= max(len(s.Context.Order), 1) {
		fail("context index out of range")
	}
	if s.Playback.PositionMs < 0 {
		fail("negative position")
	}
	if s.Playback.TrackID != "" {
		d, ok := e.Catalog.DurationMs(s.Playback.TrackID)
		if !ok {
			fail("playing an unknown track")
		}
		if d != s.Playback.DurationMs {
			fail("duration mismatch")
		}
		if d > 0 && s.Playback.PositionMs > d {
			fail("position beyond duration")
		}
	}
	ids := map[string]bool{}
	for _, q := range s.Queue {
		if ids[q.ID] {
			fail("duplicate queue entry id")
		}
		ids[q.ID] = true
	}
	if s.Hold != nil && !s.WaitForAll {
		fail("hold without waitForAll")
	}
}
