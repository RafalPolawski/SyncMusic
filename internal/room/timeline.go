package room

// This file holds the timeline rules that clients replicate for offline
// "dead reckoning". Keep it free of side effects other than on the State and
// keep web/src/sync/timeline.ts in lockstep with it.

// maxAdvanceSteps bounds Normalize when a room was left playing for a very
// long time (e.g. a day of repeat-one on a short track).
const maxAdvanceSteps = 10000

// PositionAt returns the playback position at server time now.
func (p Playback) PositionAt(now int64) int64 {
	if !p.Playing || now <= p.AnchorMs {
		return p.PositionMs
	}
	pos := p.PositionMs + (now - p.AnchorMs)
	if p.DurationMs > 0 && pos > p.DurationMs {
		return p.DurationMs
	}
	return pos
}

// EndsAt returns the server time at which the current track finishes, or
// false when that cannot be known (paused, nothing loaded, unknown length).
func (p Playback) EndsAt() (int64, bool) {
	if !p.Playing || p.TrackID == "" || p.DurationMs <= 0 {
		return 0, false
	}
	remaining := p.DurationMs - p.PositionMs
	if remaining < 0 {
		remaining = 0
	}
	return p.AnchorMs + remaining, true
}

// Normalize advances the timeline to server time now: every track that has
// finished in the meantime is replaced by its successor, anchored exactly at
// the moment the previous one ended (gapless, identical on every device).
// It reports whether anything changed.
func Normalize(s *State, now int64, cat Catalog) bool {
	changed := false
	for range maxAdvanceSteps {
		end, ok := s.Playback.EndsAt()
		if !ok || now < end {
			break
		}
		advanceAuto(s, end, cat)
		changed = true
	}
	return changed
}

// item is a track selected to play next.
type item struct {
	trackID string
	entryID string
}

// advanceAuto moves to the next track when the current one ends at time at.
func advanceAuto(s *State, at int64, cat Catalog) {
	if s.Repeat == RepeatOne {
		s.Playback.PositionMs = 0
		s.Playback.AnchorMs = at
		return
	}
	next, ok := takeNext(s, s.Repeat == RepeatAll, cat)
	if !ok {
		stopAtEnd(s, at, cat)
		return
	}
	startItem(s, next, at, cat)
}

// takeNext removes and returns the next item: the head of the queue, or
// the next context track. With wrap the context starts over at its end.
// Tracks missing from the catalog are skipped.
func takeNext(s *State, wrap bool, cat Catalog) (item, bool) {
	for len(s.Queue) > 0 {
		e := s.Queue[0]
		s.Queue = s.Queue[1:]
		s.QueueVersion++
		if _, ok := cat.DurationMs(e.TrackID); ok {
			return item{trackID: e.TrackID, entryID: e.ID}, true
		}
	}
	n := len(s.Context.Order)
	idx := s.ContextIndex
	for range n {
		idx++
		if idx >= n {
			if !wrap {
				return item{}, false
			}
			idx = 0
		}
		id := contextTrack(s, idx)
		if _, ok := cat.DurationMs(id); ok {
			s.ContextIndex = idx
			return item{trackID: id}, true
		}
	}
	return item{}, false
}

// stopAtEnd parks playback on the first context track (or the current track
// when there is no context), paused at the beginning.
func stopAtEnd(s *State, at int64, cat Catalog) {
	if len(s.Context.Order) > 0 {
		s.ContextIndex = 0
		id := contextTrack(s, 0)
		d, _ := cat.DurationMs(id)
		s.Playback = Playback{TrackID: id, DurationMs: d}
	} else {
		s.Playback.EntryID = ""
	}
	s.Playback.PositionMs = 0
	s.Playback.AnchorMs = at
	s.Playback.Playing = false
}

func startItem(s *State, it item, anchor int64, cat Catalog) {
	d, _ := cat.DurationMs(it.trackID)
	s.Playback = Playback{
		TrackID:    it.trackID,
		EntryID:    it.entryID,
		PositionMs: 0,
		AnchorMs:   anchor,
		Playing:    true,
		DurationMs: d,
	}
}

func contextTrack(s *State, orderIdx int) string {
	return s.Context.Tracks[s.Context.Order[orderIdx]]
}

// Upcoming returns up to n track ids that will play after the current one,
// following the same rules as automatic advancing. It does not modify s.
func Upcoming(s State, n int, cat Catalog) []string {
	if n <= 0 {
		return nil
	}
	c := s.Clone()
	out := make([]string, 0, n)
	if c.Repeat == RepeatOne && c.Playback.TrackID != "" {
		for range n {
			out = append(out, c.Playback.TrackID)
		}
		return out
	}
	// Without wrapping a context of length k yields at most k items, so the
	// loop terminates even when n is larger.
	for len(out) < n {
		it, ok := takeNext(&c, c.Repeat == RepeatAll, cat)
		if !ok {
			break
		}
		out = append(out, it.trackID)
	}
	return out
}
