package room

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type fixtureFile struct {
	Catalog    map[string]int64 `json:"catalog"`
	PositionAt []struct {
		Name     string   `json:"name"`
		Playback Playback `json:"playback"`
		Now      int64    `json:"now"`
		Expect   int64    `json:"expect"`
	} `json:"positionAt"`
	Normalize []struct {
		Name   string          `json:"name"`
		State  json.RawMessage `json:"state"`
		Now    int64           `json:"now"`
		Expect struct {
			Changed      bool     `json:"changed"`
			Playback     Playback `json:"playback"`
			ContextIndex int      `json:"contextIndex"`
			Queue        []string `json:"queue"`
		} `json:"expect"`
	} `json:"normalize"`
	Upcoming []struct {
		Name   string          `json:"name"`
		State  json.RawMessage `json:"state"`
		N      int             `json:"n"`
		Expect []string        `json:"expect"`
	} `json:"upcoming"`
}

func loadFixtures(t *testing.T) fixtureFile {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "sync", "timeline.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f fixtureFile
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func fixtureState(t *testing.T, raw json.RawMessage) State {
	t.Helper()
	s := NewState()
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestSharedFixturesPositionAt(t *testing.T) {
	f := loadFixtures(t)
	for _, c := range f.PositionAt {
		if got := c.Playback.PositionAt(c.Now); got != c.Expect {
			t.Errorf("%s: got %d want %d", c.Name, got, c.Expect)
		}
	}
}

func TestSharedFixturesNormalize(t *testing.T) {
	f := loadFixtures(t)
	cat := MapCatalog(f.Catalog)
	for _, c := range f.Normalize {
		t.Run(c.Name, func(t *testing.T) {
			s := fixtureState(t, c.State)
			changed := Normalize(&s, c.Now, cat)
			if changed != c.Expect.Changed {
				t.Errorf("changed = %v, want %v", changed, c.Expect.Changed)
			}
			if s.Playback != c.Expect.Playback {
				t.Errorf("playback\n got  %+v\n want %+v", s.Playback, c.Expect.Playback)
			}
			if s.ContextIndex != c.Expect.ContextIndex {
				t.Errorf("contextIndex = %d, want %d", s.ContextIndex, c.Expect.ContextIndex)
			}
			ids := []string{}
			for _, q := range s.Queue {
				ids = append(ids, q.ID)
			}
			if !reflect.DeepEqual(ids, c.Expect.Queue) {
				t.Errorf("queue = %v, want %v", ids, c.Expect.Queue)
			}
			// Normalising again at the same time must be a no-op.
			if Normalize(&s, c.Now, cat) {
				t.Error("second Normalize changed the state")
			}
		})
	}
}

func TestSharedFixturesUpcoming(t *testing.T) {
	f := loadFixtures(t)
	cat := MapCatalog(f.Catalog)
	for _, c := range f.Upcoming {
		s := fixtureState(t, c.State)
		before := s.Clone()
		got := Upcoming(s, c.N, cat)
		if !reflect.DeepEqual(got, c.Expect) {
			t.Errorf("%s: got %v want %v", c.Name, got, c.Expect)
		}
		if !reflect.DeepEqual(s, before) {
			t.Errorf("%s: Upcoming mutated the state", c.Name)
		}
	}
}

func TestNormalizeIsTimeConsistent(t *testing.T) {
	// Normalising in small steps must give the same result as one big jump:
	// this is what lets offline phones agree with the server.
	f := loadFixtures(t)
	cat := MapCatalog(f.Catalog)
	for _, c := range f.Normalize {
		stepped := fixtureState(t, c.State)
		jumped := stepped.Clone()
		start := stepped.Playback.AnchorMs
		for now := start; now <= c.Now; now += 333 {
			Normalize(&stepped, now, cat)
		}
		Normalize(&stepped, c.Now, cat)
		Normalize(&jumped, c.Now, cat)
		if stepped.Playback != jumped.Playback || stepped.ContextIndex != jumped.ContextIndex || len(stepped.Queue) != len(jumped.Queue) {
			t.Errorf("%s: stepped %+v != jumped %+v", c.Name, stepped.Playback, jumped.Playback)
		}
	}
}

func TestNormalizeBounded(t *testing.T) {
	s := NewState()
	s.Repeat = RepeatOne
	s.Playback = Playback{TrackID: "t", Playing: true, DurationMs: 1, AnchorMs: 0}
	Normalize(&s, 1<<40, MapCatalog{"t": 1})
	if s.Playback.AnchorMs != maxAdvanceSteps {
		t.Fatalf("expected bounded advance, anchor = %d", s.Playback.AnchorMs)
	}
}

func TestEndsAt(t *testing.T) {
	p := Playback{TrackID: "a", PositionMs: 12000, AnchorMs: 100, Playing: true, DurationMs: 10000}
	if end, ok := p.EndsAt(); !ok || end != 100 {
		t.Fatalf("position past duration should end at anchor: %d %v", end, ok)
	}
	p.Playing = false
	if _, ok := p.EndsAt(); ok {
		t.Fatal("paused playback has no end")
	}
}

func TestCloneIsDeep(t *testing.T) {
	s := NewState()
	s.Queue = []QueueEntry{{ID: "q1", TrackID: "a"}}
	s.Context = Context{Tracks: []string{"a"}, Order: []int{0}}
	s.Hold = &Hold{TrackID: "a"}
	c := s.Clone()
	c.Queue[0].ID = "changed"
	c.Context.Tracks[0] = "changed"
	c.Context.Order[0] = 9
	c.Hold.TrackID = "changed"
	if s.Queue[0].ID != "q1" || s.Context.Tracks[0] != "a" || s.Context.Order[0] != 0 || s.Hold.TrackID != "a" {
		t.Fatal("Clone shares memory with the original")
	}
}
