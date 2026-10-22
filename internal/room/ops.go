package room

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"strconv"
)

// Limits protecting the server from oversized rooms.
const (
	MaxQueueLength   = 1000
	MaxContextTracks = 50000
	// PrevRestartThresholdMs: "previous" restarts the current track when it
	// has been playing for longer than this.
	PrevRestartThresholdMs = 3000
	// PauseTrustWindowMs: a pause carries the position the listener saw; it is
	// trusted when close to the server's own estimate.
	PauseTrustWindowMs = 3000
	// HoldMarginMs / HoldExtendMs control how a held start is postponed while
	// waiting for slow listeners.
	HoldMarginMs = 250
	HoldExtendMs = 1000
)

// Error is a client facing command error.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func errf(code, format string, args ...any) error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// ErrNoChange is returned by Apply when a command was valid but had no effect.
var ErrNoChange = errors.New("no change")

// ContextSpec describes a context a listener wants to play.
type ContextSpec struct {
	Kind   string   `json:"kind"`
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Tracks []string `json:"tracks"`
}

// Command is a listener's request to change the room.
type Command struct {
	Op         string       `json:"op"`
	PositionMs *int64       `json:"positionMs,omitempty"`
	Context    *ContextSpec `json:"context,omitempty"`
	StartIndex *int         `json:"startIndex,omitempty"`
	Index      *int         `json:"index,omitempty"`
	TrackIDs   []string     `json:"trackIds,omitempty"`
	Next       bool         `json:"next,omitempty"`
	EntryID    string       `json:"entryId,omitempty"`
	ToIndex    *int         `json:"toIndex,omitempty"`
	On         *bool        `json:"on,omitempty"`
	Mode       Repeat       `json:"mode,omitempty"`
	TrackID    string       `json:"trackId,omitempty"`
}

// Changes reports which parts of the state a command touched.
type Changes uint8

const (
	ChangedPlayback Changes = 1 << iota
	ChangedQueue
	ChangedContext
	ChangedSettings
)

// Options are timing parameters of a room.
type Options struct {
	StartDelayMs    int64 // lead time before a newly selected track starts
	ResumeDelayMs   int64 // lead time for play and seek
	WaitForAllMaxMs int64 // max time to wait for listeners to buffer
}

// Engine applies commands to a State. It is not safe for concurrent use; a
// room actor owns one engine.
type Engine struct {
	State   State
	Catalog Catalog
	Opts    Options
	Rand    *rand.Rand
}

// NewEngine wraps a state.
func NewEngine(s State, cat Catalog, opts Options, rng *rand.Rand) *Engine {
	if rng == nil {
		rng = rand.New(rand.NewPCG(rand.Uint64(), rand.Uint64()))
	}
	if s.Queue == nil {
		s.Queue = []QueueEntry{}
	}
	if s.Context.Tracks == nil {
		s.Context.Tracks = []string{}
	}
	if s.Context.Order == nil {
		s.Context.Order = []int{}
	}
	if !s.Repeat.Valid() {
		s.Repeat = RepeatOff
	}
	return &Engine{State: s, Catalog: cat, Opts: opts, Rand: rng}
}

// Normalize advances the timeline to now and bumps the version on change.
func (e *Engine) Normalize(now int64) Changes {
	before := e.State.QueueVersion
	if !Normalize(&e.State, now, e.Catalog) {
		return 0
	}
	e.State.Version++
	ch := ChangedPlayback
	if e.State.QueueVersion != before {
		ch |= ChangedQueue
	}
	return ch
}

// Apply executes a command at server time now on behalf of a listener.
// The timeline is normalised first. It returns ErrNoChange for valid
// commands that did not change anything.
func (e *Engine) Apply(cmd Command, now int64, by string) (Changes, error) {
	pre := e.Normalize(now)
	before := e.State.QueueVersion
	ch, err := e.apply(cmd, now, by)
	if err != nil {
		if pre != 0 {
			return pre, err
		}
		return 0, err
	}
	if ch == 0 {
		if pre != 0 {
			return pre, nil
		}
		return 0, ErrNoChange
	}
	if e.State.QueueVersion != before {
		ch |= ChangedQueue
	}
	if ch&ChangedQueue != 0 && e.State.QueueVersion == before {
		e.State.QueueVersion++
	}
	if ch&ChangedContext != 0 {
		e.State.ContextVersion++
	}
	e.State.Version++
	return ch | pre, nil
}

func (e *Engine) apply(cmd Command, now int64, by string) (Changes, error) {
	s := &e.State
	switch cmd.Op {
	case "play":
		return e.play(cmd, now)
	case "pause":
		return e.pause(cmd, now), nil
	case "seek":
		if cmd.PositionMs == nil {
			return 0, errf("bad_request", "seek requires positionMs")
		}
		return e.seek(*cmd.PositionMs, now)
	case "next":
		return e.next(now), nil
	case "prev":
		return e.prev(now), nil
	case "playContext":
		return e.playContext(cmd, now)
	case "jump":
		if cmd.Index == nil {
			return 0, errf("bad_request", "jump requires index")
		}
		return e.jump(*cmd.Index, now)
	case "playEntry":
		return e.playEntry(cmd.EntryID, now)
	case "queueAdd":
		return e.queueAdd(cmd.TrackIDs, cmd.Next, by)
	case "queueRemove":
		for i, q := range s.Queue {
			if q.ID == cmd.EntryID {
				s.Queue = append(s.Queue[:i:i], s.Queue[i+1:]...)
				return ChangedQueue, nil
			}
		}
		return 0, errf("not_found", "queue entry %q not found", cmd.EntryID)
	case "queueMove":
		if cmd.ToIndex == nil {
			return 0, errf("bad_request", "queueMove requires toIndex")
		}
		return e.queueMove(cmd.EntryID, *cmd.ToIndex)
	case "queueClear":
		if len(s.Queue) == 0 {
			return 0, nil
		}
		s.Queue = []QueueEntry{}
		return ChangedQueue, nil
	case "shuffle":
		if cmd.On == nil {
			return 0, errf("bad_request", "shuffle requires on")
		}
		return e.setShuffle(*cmd.On), nil
	case "repeat":
		if !cmd.Mode.Valid() {
			return 0, errf("bad_request", "invalid repeat mode %q", cmd.Mode)
		}
		if s.Repeat == cmd.Mode {
			return 0, nil
		}
		s.Repeat = cmd.Mode
		return ChangedSettings, nil
	case "waitForAll":
		if cmd.On == nil {
			return 0, errf("bad_request", "waitForAll requires on")
		}
		if s.WaitForAll == *cmd.On {
			return 0, nil
		}
		s.WaitForAll = *cmd.On
		if !s.WaitForAll && s.Hold != nil {
			s.Hold = nil
			return ChangedSettings | ChangedPlayback, nil
		}
		return ChangedSettings, nil
	case "ended":
		return e.ended(cmd, now), nil
	default:
		return 0, errf("unknown_op", "unknown command %q", cmd.Op)
	}
}

func (e *Engine) play(cmd Command, now int64) (Changes, error) {
	s := &e.State
	if s.Playback.TrackID == "" {
		if it, ok := takeNext(s, false, e.Catalog); ok {
			e.start(it, now)
			return ChangedPlayback, nil
		}
		return 0, errf("nothing_to_play", "nothing to play")
	}
	if s.Playback.Playing {
		return 0, nil
	}
	pos := s.Playback.PositionMs
	if cmd.PositionMs != nil {
		pos = *cmd.PositionMs
	}
	s.Playback.PositionMs = e.clamp(pos)
	s.Playback.AnchorMs = now + e.Opts.ResumeDelayMs
	s.Playback.Playing = true
	s.Hold = nil
	return ChangedPlayback, nil
}

func (e *Engine) pause(cmd Command, now int64) Changes {
	s := &e.State
	if !s.Playback.Playing {
		return 0
	}
	pos := s.Playback.PositionAt(now)
	if cmd.PositionMs != nil {
		if d := *cmd.PositionMs - pos; d <= PauseTrustWindowMs && d >= -PauseTrustWindowMs {
			pos = *cmd.PositionMs
		}
	}
	s.Playback.PositionMs = e.clamp(pos)
	s.Playback.AnchorMs = now
	s.Playback.Playing = false
	s.Hold = nil
	return ChangedPlayback
}

func (e *Engine) seek(pos, now int64) (Changes, error) {
	s := &e.State
	if s.Playback.TrackID == "" {
		return 0, errf("nothing_to_play", "nothing is loaded")
	}
	s.Playback.PositionMs = e.clamp(pos)
	if s.Playback.Playing {
		s.Playback.AnchorMs = now + e.Opts.ResumeDelayMs
	} else {
		s.Playback.AnchorMs = now
	}
	s.Hold = nil
	return ChangedPlayback, nil
}

func (e *Engine) next(now int64) Changes {
	s := &e.State
	it, ok := takeNext(s, s.Repeat != RepeatOff, e.Catalog)
	if !ok {
		if s.Playback.TrackID == "" {
			return 0
		}
		stopAtEnd(s, now, e.Catalog)
		s.Hold = nil
		return ChangedPlayback
	}
	e.start(it, now)
	return ChangedPlayback
}

func (e *Engine) prev(now int64) Changes {
	s := &e.State
	if s.Playback.TrackID == "" {
		return 0
	}
	restart := func() Changes {
		ch, _ := e.seek(0, now)
		return ch
	}
	if s.Playback.PositionAt(now) > PrevRestartThresholdMs {
		return restart()
	}
	n := len(s.Context.Order)
	if s.Playback.EntryID != "" {
		// Leaving a queued track: go back to the context track it interrupted.
		if s.ContextIndex >= 0 && s.ContextIndex < n {
			e.start(item{trackID: contextTrack(s, s.ContextIndex)}, now)
			return ChangedPlayback
		}
		return restart()
	}
	idx := s.ContextIndex - 1
	if idx < 0 {
		if s.Repeat == RepeatOff || n == 0 {
			return restart()
		}
		idx = n - 1
	}
	if idx >= n {
		return restart()
	}
	s.ContextIndex = idx
	e.start(item{trackID: contextTrack(s, idx)}, now)
	return ChangedPlayback
}

func (e *Engine) playContext(cmd Command, now int64) (Changes, error) {
	spec := cmd.Context
	if spec == nil {
		return 0, errf("bad_request", "playContext requires context")
	}
	if len(spec.Tracks) > MaxContextTracks {
		return 0, errf("too_large", "context exceeds %d tracks", MaxContextTracks)
	}
	start := -1
	tracks := make([]string, 0, len(spec.Tracks))
	for i, id := range spec.Tracks {
		if _, ok := e.Catalog.DurationMs(id); !ok {
			continue
		}
		if cmd.StartIndex != nil && *cmd.StartIndex == i {
			start = len(tracks)
		}
		tracks = append(tracks, id)
	}
	if len(tracks) == 0 {
		return 0, errf("unknown_track", "context has no playable tracks")
	}
	if cmd.StartIndex != nil && start < 0 {
		return 0, errf("unknown_track", "start track is not playable")
	}
	s := &e.State
	s.Context = Context{Kind: spec.Kind, ID: spec.ID, Name: spec.Name, Tracks: tracks}
	s.Context.Order = e.order(len(tracks), start)
	s.ContextIndex = 0
	if !s.Shuffle && start >= 0 {
		s.ContextIndex = start
	}
	e.start(item{trackID: contextTrack(s, s.ContextIndex)}, now)
	return ChangedPlayback | ChangedContext, nil
}

func (e *Engine) jump(idx int, now int64) (Changes, error) {
	s := &e.State
	if idx < 0 || idx >= len(s.Context.Order) {
		return 0, errf("bad_request", "index %d out of range", idx)
	}
	id := contextTrack(s, idx)
	if _, ok := e.Catalog.DurationMs(id); !ok {
		return 0, errf("unknown_track", "track %q is not available", id)
	}
	s.ContextIndex = idx
	e.start(item{trackID: id}, now)
	return ChangedPlayback, nil
}

func (e *Engine) playEntry(entryID string, now int64) (Changes, error) {
	s := &e.State
	for i, q := range s.Queue {
		if q.ID != entryID {
			continue
		}
		if _, ok := e.Catalog.DurationMs(q.TrackID); !ok {
			return 0, errf("unknown_track", "track %q is not available", q.TrackID)
		}
		s.Queue = append(s.Queue[:i:i], s.Queue[i+1:]...)
		e.start(item{trackID: q.TrackID, entryID: q.ID}, now)
		return ChangedPlayback | ChangedQueue, nil
	}
	return 0, errf("not_found", "queue entry %q not found", entryID)
}

func (e *Engine) queueAdd(ids []string, atFront bool, by string) (Changes, error) {
	s := &e.State
	if len(ids) == 0 {
		return 0, errf("bad_request", "queueAdd requires trackIds")
	}
	if len(s.Queue)+len(ids) > MaxQueueLength {
		return 0, errf("queue_full", "queue is limited to %d tracks", MaxQueueLength)
	}
	entries := make([]QueueEntry, 0, len(ids))
	for _, id := range ids {
		if _, ok := e.Catalog.DurationMs(id); !ok {
			return 0, errf("unknown_track", "unknown track %q", id)
		}
		s.NextEntrySeq++
		entries = append(entries, QueueEntry{ID: "q" + strconv.FormatUint(s.NextEntrySeq, 36), TrackID: id, AddedBy: by})
	}
	if atFront {
		s.Queue = append(entries, s.Queue...)
	} else {
		s.Queue = append(s.Queue, entries...)
	}
	return ChangedQueue, nil
}

func (e *Engine) queueMove(entryID string, to int) (Changes, error) {
	s := &e.State
	from := -1
	for i, q := range s.Queue {
		if q.ID == entryID {
			from = i
			break
		}
	}
	if from < 0 {
		return 0, errf("not_found", "queue entry %q not found", entryID)
	}
	if to < 0 {
		to = 0
	}
	if to >= len(s.Queue) {
		to = len(s.Queue) - 1
	}
	if to == from {
		return 0, nil
	}
	entry := s.Queue[from]
	q := append(s.Queue[:from:from], s.Queue[from+1:]...)
	q = append(q[:to:to], append([]QueueEntry{entry}, q[to:]...)...)
	s.Queue = q
	return ChangedQueue, nil
}

func (e *Engine) setShuffle(on bool) Changes {
	s := &e.State
	if s.Shuffle == on {
		return 0
	}
	s.Shuffle = on
	n := len(s.Context.Order)
	if n == 0 {
		return ChangedSettings
	}
	current := -1 // index into Tracks of the current context position
	if s.ContextIndex >= 0 && s.ContextIndex < n {
		current = s.Context.Order[s.ContextIndex]
	}
	s.Context.Order = e.order(len(s.Context.Tracks), current)
	if on {
		if current >= 0 {
			s.ContextIndex = 0
		} else {
			s.ContextIndex = -1
		}
	} else {
		s.ContextIndex = current
	}
	return ChangedSettings | ChangedContext
}

func (e *Engine) ended(cmd Command, now int64) Changes {
	s := &e.State
	p := s.Playback
	// Only needed when the duration is unknown; otherwise Normalize already
	// advanced. Guard against stale or duplicate reports.
	if !p.Playing || p.DurationMs > 0 || p.TrackID != cmd.TrackID || p.EntryID != cmd.EntryID || now < p.AnchorMs {
		return 0
	}
	advanceAuto(s, now, e.Catalog)
	return ChangedPlayback
}

// order builds a play order over n tracks. With shuffle enabled the result
// is a random permutation; when first >= 0 that track is placed first.
func (e *Engine) order(n, first int) []int {
	order := make([]int, n)
	for i := range order {
		order[i] = i
	}
	if !e.State.Shuffle {
		return order
	}
	e.Rand.Shuffle(n, func(i, j int) { order[i], order[j] = order[j], order[i] })
	if first >= 0 {
		for i, v := range order {
			if v == first {
				order[0], order[i] = order[i], order[0]
				break
			}
		}
	}
	return order
}

// start begins playing an item after the configured lead time and arms the
// "wait for everyone" hold when enabled.
func (e *Engine) start(it item, now int64) {
	s := &e.State
	startItem(s, it, now+e.Opts.StartDelayMs, e.Catalog)
	s.Hold = nil
	if s.WaitForAll && e.Opts.WaitForAllMaxMs > 0 {
		s.Hold = &Hold{TrackID: it.trackID, EntryID: it.entryID, StartedMs: now, UntilMs: now + e.Opts.WaitForAllMaxMs}
	}
}

func (e *Engine) clamp(pos int64) int64 {
	if pos < 0 {
		return 0
	}
	if d := e.State.Playback.DurationMs; d > 0 && pos > d {
		return d
	}
	return pos
}

// CheckHold evaluates a pending "wait for everyone" hold. allReady reports
// whether every connected listener has buffered the held track. It returns
// the changes made and the server time at which it should be called again
// (0 when no hold is pending).
func (e *Engine) CheckHold(now int64, allReady bool) (Changes, int64) {
	s := &e.State
	h := s.Hold
	if h == nil {
		return 0, 0
	}
	p := &s.Playback
	if !p.Playing || p.TrackID != h.TrackID || p.EntryID != h.EntryID {
		s.Hold = nil
		s.Version++
		return ChangedPlayback, 0
	}
	if allReady {
		s.Hold = nil
		if p.AnchorMs < now+HoldMarginMs {
			p.AnchorMs = now + e.Opts.ResumeDelayMs
		}
		s.Version++
		return ChangedPlayback, 0
	}
	if now >= h.UntilMs {
		// Give up waiting; latecomers catch up by seeking.
		s.Hold = nil
		s.Version++
		return ChangedPlayback, 0
	}
	if p.AnchorMs-now <= HoldMarginMs {
		p.AnchorMs = now + HoldExtendMs
		p.PositionMs = 0
		s.Version++
		return ChangedPlayback, min(h.UntilMs, p.AnchorMs-HoldMarginMs)
	}
	return 0, min(h.UntilMs, p.AnchorMs-HoldMarginMs)
}

// NextHoldCheck returns the server time at which CheckHold should run next,
// or 0 when no hold is pending.
func (e *Engine) NextHoldCheck() int64 {
	h := e.State.Hold
	if h == nil {
		return 0
	}
	return min(h.UntilMs, e.State.Playback.AnchorMs-HoldMarginMs)
}
