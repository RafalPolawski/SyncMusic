package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func openTest(t *testing.T) *DB {
	t.Helper()
	db, err := Open(context.Background(), filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestMigrationsApplyAndAreIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")
	ctx := context.Background()
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	v, err := db.SchemaVersion(ctx)
	if err != nil || v < 1 {
		t.Fatalf("schema version = %d, %v", v, err)
	}
	db.Close()

	db, err = Open(ctx, path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer db.Close()
	v2, _ := db.SchemaVersion(ctx)
	if v2 != v {
		t.Fatalf("version changed on reopen: %d -> %d", v, v2)
	}
}

func TestRefusesNewerSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")
	ctx := context.Background()
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "PRAGMA user_version = 999"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if _, err := Open(ctx, path); err == nil {
		t.Fatal("expected refusal to open newer schema")
	}
}

func TestInMemory(t *testing.T) {
	db, err := Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.SetKV(context.Background(), "a", "b"); err != nil {
		t.Fatal(err)
	}
}

func TestKV(t *testing.T) {
	db := openTest(t)
	ctx := context.Background()
	if _, err := db.GetKV(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
	if err := db.SetKV(ctx, "k", "v1"); err != nil {
		t.Fatal(err)
	}
	if err := db.SetKV(ctx, "k", "v2"); err != nil {
		t.Fatal(err)
	}
	got, err := db.GetKV(ctx, "k")
	if err != nil || got != "v2" {
		t.Fatalf("GetKV = %q, %v", got, err)
	}
}

func TestTracksRoundTrip(t *testing.T) {
	db := openTest(t)
	ctx := context.Background()
	a := Track{ID: "a", Path: "Rock/a.flac", Folder: "Rock", Title: "A", Artist: "X", DurationMs: 1000, HasCover: true, Size: 10, MtimeNs: 1}
	b := Track{ID: "b", Path: "b.mp3", Folder: "", Title: "B", Size: 20, MtimeNs: 2}
	if err := db.ApplyTrackChanges(ctx, []Track{a, b}, nil); err != nil {
		t.Fatal(err)
	}
	a.Title = "A2"
	if err := db.ApplyTrackChanges(ctx, []Track{a}, []string{"b"}); err != nil {
		t.Fatal(err)
	}
	tracks, err := db.ListTracks(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(tracks) != 1 || tracks[0].Title != "A2" || !tracks[0].HasCover || tracks[0].DurationMs != 1000 {
		t.Fatalf("unexpected tracks: %+v", tracks)
	}
	if err := db.ApplyTrackChanges(ctx, nil, nil); err != nil {
		t.Fatal(err)
	}
}

func TestPlaylists(t *testing.T) {
	db := openTest(t)
	ctx := context.Background()
	pls := []Playlist{
		{ID: "p1", Path: "gym.m3u", Name: "Gym", TrackPaths: []string{"a.mp3", "b.mp3"}},
		{ID: "p2", Path: "chill.m3u8", Name: "Chill"},
	}
	if err := db.ReplacePlaylists(ctx, pls); err != nil {
		t.Fatal(err)
	}
	got, err := db.ListPlaylists(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Name != "Chill" || got[1].Name != "Gym" || len(got[1].TrackPaths) != 2 || got[1].TrackPaths[1] != "b.mp3" {
		t.Fatalf("unexpected playlists: %+v", got)
	}
	if err := db.ReplacePlaylists(ctx, nil); err != nil {
		t.Fatal(err)
	}
	got, _ = db.ListPlaylists(ctx)
	if len(got) != 0 {
		t.Fatalf("playlists not replaced: %+v", got)
	}
}

func TestRooms(t *testing.T) {
	db := openTest(t)
	ctx := context.Background()
	if _, err := db.LoadRoom(ctx, "gym"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
	if err := db.SaveRoom(ctx, RoomRecord{ID: "gym", Name: "Gym", State: []byte(`{"v":1}`), UpdatedAt: 100}); err != nil {
		t.Fatal(err)
	}
	if err := db.SaveRoom(ctx, RoomRecord{ID: "old", Name: "Old", State: []byte(`{}`), UpdatedAt: 10}); err != nil {
		t.Fatal(err)
	}
	if err := db.SaveRoom(ctx, RoomRecord{ID: "gym", Name: "Gym", State: []byte(`{"v":2}`), UpdatedAt: 200}); err != nil {
		t.Fatal(err)
	}
	r, err := db.LoadRoom(ctx, "gym")
	if err != nil || string(r.State) != `{"v":2}` || r.UpdatedAt != 200 {
		t.Fatalf("LoadRoom = %+v, %v", r, err)
	}
	rooms, err := db.ListRooms(ctx)
	if err != nil || len(rooms) != 2 || rooms[0].ID != "gym" {
		t.Fatalf("ListRooms = %+v, %v", rooms, err)
	}
	n, err := db.DeleteRoomsBefore(ctx, 50)
	if err != nil || n != 1 {
		t.Fatalf("DeleteRoomsBefore = %d, %v", n, err)
	}
}
