package library

import (
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/RafalPolawski/SyncMusic/internal/media"
	"github.com/RafalPolawski/SyncMusic/internal/store"
	"github.com/RafalPolawski/SyncMusic/internal/testutil"
)

// fakeProber returns metadata derived from the file name and counts calls.
type fakeProber struct {
	calls atomic.Int32
	fail  map[string]bool
}

func (f *fakeProber) Probe(_ context.Context, p string) (media.Info, error) {
	f.calls.Add(1)
	base := filepath.Base(p)
	if f.fail[base] {
		return media.Info{}, errors.New("broken file")
	}
	info := media.Info{Codec: "mp3", DurationMs: 1000, Bitrate: 128000}
	if strings.HasPrefix(base, "tagged") {
		info.Title = "Tagged " + base
		info.Artist = "Tag Artist"
	}
	return info, nil
}

func writeFile(t *testing.T, root, rel, content string) string {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func newTestLibrary(t *testing.T, root string, prober media.Prober) (*Library, *store.DB) {
	t.Helper()
	db, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return New(Options{Root: root, DB: db, Prober: prober, Workers: 3}), db
}

func TestScanIncremental(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "Gym/01 - Eye of the Tiger.mp3", "a")
	writeFile(t, root, "Gym/02 - Survivor - Burning Heart.mp3", "b")
	writeFile(t, root, "Gym/tagged.flac", "c")
	writeFile(t, root, "Chill/Sub/slow.ogg", "d")
	writeFile(t, root, "loose.mp3", "e")
	writeFile(t, root, "notes.txt", "ignored")
	writeFile(t, root, ".hidden/secret.mp3", "ignored")
	writeFile(t, root, "@eaDir/thumb.mp3", "ignored")
	writeFile(t, root, "Gym/._resource.mp3", "ignored")
	writeFile(t, root, "Gym/gym.m3u", "#EXTM3U\n#EXTINF:1,x\n02 - Survivor - Burning Heart.mp3\n../loose.mp3\nmissing.mp3\nhttp://stream/x\n")

	prober := &fakeProber{}
	lib, _ := newTestLibrary(t, root, prober)
	var changes atomic.Int32
	lib.OnChange(func(*Snapshot) { changes.Add(1) })

	res, err := lib.Scan(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.Added != 5 || res.Removed != 0 || !res.VersionChanged {
		t.Fatalf("first scan: %+v", res)
	}
	if prober.calls.Load() != 5 {
		t.Fatalf("probe calls = %d", prober.calls.Load())
	}
	snap := lib.Snapshot()
	if len(snap.Tracks) != 5 {
		t.Fatalf("tracks = %d", len(snap.Tracks))
	}

	gym, ok := snap.Folder("Gym")
	if !ok || len(gym.TrackIDs) != 3 {
		t.Fatalf("Gym folder: %+v", gym)
	}
	first, _ := snap.Track(gym.TrackIDs[0])
	second, _ := snap.Track(gym.TrackIDs[1])
	if first.Title != "Eye of the Tiger" || first.Artist != "" {
		t.Fatalf("filename guess failed: %+v", first)
	}
	if second.Title != "Burning Heart" || second.Artist != "Survivor" {
		t.Fatalf("artist guess failed: %+v", second)
	}
	tagged, _ := snap.Track(TrackID("Gym/tagged.flac"))
	if tagged.Title != "Tagged tagged.flac" || tagged.Artist != "Tag Artist" {
		t.Fatalf("tags not used: %+v", tagged)
	}

	if _, ok := snap.Folder("Chill"); !ok {
		t.Fatal("ancestor folder Chill should exist")
	}
	sub, ok := snap.Folder("Chill/Sub")
	if !ok || sub.Parent != "Chill" || sub.Name != "Sub" {
		t.Fatalf("nested folder: %+v", sub)
	}
	rootFolder, ok := snap.Folder("")
	if !ok || len(rootFolder.TrackIDs) != 1 {
		t.Fatalf("root folder: %+v", rootFolder)
	}

	if len(snap.Playlists) != 1 {
		t.Fatalf("playlists: %+v", snap.Playlists)
	}
	pl := snap.Playlists[0]
	if pl.Name != "gym" || len(pl.TrackIDs) != 2 || pl.TrackIDs[0] != second.ID || pl.TrackIDs[1] != TrackID("loose.mp3") {
		t.Fatalf("playlist: %+v", pl)
	}

	// Second scan without changes: nothing probed, version stable.
	v1 := snap.Version
	res, err = lib.Scan(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.Unchanged != 5 || res.Added+res.Updated+res.Removed != 0 || res.VersionChanged {
		t.Fatalf("second scan: %+v", res)
	}
	if prober.calls.Load() != 5 {
		t.Fatalf("unchanged files were re-probed: %d", prober.calls.Load())
	}
	if lib.Snapshot().Version != v1 {
		t.Fatal("version changed without changes")
	}

	// Modify, delete and add.
	writeFile(t, root, "loose.mp3", "changed content")
	if err := os.Remove(filepath.Join(root, "Chill/Sub/slow.ogg")); err != nil {
		t.Fatal(err)
	}
	writeFile(t, root, "Gym/03 - New.mp3", "f")
	res, err = lib.Scan(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.Added != 1 || res.Updated != 1 || res.Removed != 1 || !res.VersionChanged {
		t.Fatalf("third scan: %+v", res)
	}
	if _, ok := lib.Snapshot().Folder("Chill"); ok {
		t.Fatal("empty folder should disappear")
	}
	if changes.Load() != 2 {
		t.Fatalf("OnChange calls = %d, want 2", changes.Load())
	}
	st := lib.Status()
	if st.Scanning || st.Tracks != 5 || st.LastScanAt.IsZero() {
		t.Fatalf("status: %+v", st)
	}
}

func TestScanPersistsAndLoads(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "A/x.mp3", "x")
	writeFile(t, root, "A/cover.jpg", "img")
	lib, db := newTestLibrary(t, root, &fakeProber{})
	if _, err := lib.Scan(context.Background()); err != nil {
		t.Fatal(err)
	}
	v := lib.Snapshot().Version

	lib2 := New(Options{Root: root, DB: db, Prober: &fakeProber{}})
	if err := lib2.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	snap := lib2.Snapshot()
	if snap.Version != v || len(snap.Tracks) != 1 {
		t.Fatalf("loaded snapshot differs: %s vs %s", snap.Version, v)
	}
	if snap.FolderImage("A") == "" {
		t.Fatal("folder image not persisted")
	}
	f, _ := snap.Folder("A")
	if f.CoverTrackID != snap.Tracks[0].ID {
		t.Fatalf("folder cover track: %+v", f)
	}
}

func TestScanSkipsBrokenFilesUntilChanged(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "bad.mp3", "x")
	writeFile(t, root, "good.mp3", "y")
	prober := &fakeProber{fail: map[string]bool{"bad.mp3": true}}
	lib, _ := newTestLibrary(t, root, prober)
	res, err := lib.Scan(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.Added != 1 || res.Failed != 1 {
		t.Fatalf("scan: %+v", res)
	}
	calls := prober.calls.Load()
	if _, err := lib.Scan(context.Background()); err != nil {
		t.Fatal(err)
	}
	if prober.calls.Load() != calls {
		t.Fatal("known-broken file was probed again")
	}
	writeFile(t, root, "bad.mp3", "now different")
	if _, err := lib.Scan(context.Background()); err != nil {
		t.Fatal(err)
	}
	if prober.calls.Load() != calls+1 {
		t.Fatal("changed broken file should be retried")
	}
}

func TestScanMissingRoot(t *testing.T) {
	lib, _ := newTestLibrary(t, filepath.Join(t.TempDir(), "nope"), &fakeProber{})
	if _, err := lib.Scan(context.Background()); err == nil {
		t.Fatal("expected error")
	}
	if lib.Status().LastError == "" {
		t.Fatal("status should report the error")
	}
}

func TestTryScanConcurrent(t *testing.T) {
	root := t.TempDir()
	lib, _ := newTestLibrary(t, root, &fakeProber{})
	lib.scanMu.Lock()
	_, err := lib.TryScan(context.Background())
	lib.scanMu.Unlock()
	if !errors.Is(err, ErrScanInProgress) {
		t.Fatalf("want ErrScanInProgress, got %v", err)
	}
}

func TestScanCancelled(t *testing.T) {
	root := t.TempDir()
	for i := range 20 {
		writeFile(t, root, filepath.Join("d", string(rune('a'+i))+".mp3"), "x")
	}
	lib, _ := newTestLibrary(t, root, &fakeProber{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := lib.Scan(ctx); err == nil {
		t.Fatal("expected cancellation error")
	}
}

func TestAbsPath(t *testing.T) {
	root := t.TempDir()
	lib := New(Options{Root: root})
	p, err := lib.AbsPath("A/b.mp3")
	if err != nil || p != filepath.Join(root, "A", "b.mp3") {
		t.Fatalf("AbsPath = %q, %v", p, err)
	}
	// Traversal is neutralised by cleaning against the root.
	p, err = lib.AbsPath("../../etc/passwd")
	if err != nil || !strings.HasPrefix(p, root) {
		t.Fatalf("traversal not contained: %q, %v", p, err)
	}
	if _, err := lib.AbsPath(""); err == nil {
		t.Fatal("empty path should fail")
	}
}

func TestLibraryJSON(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "A/tagged1.mp3", "x")
	lib, _ := newTestLibrary(t, root, &fakeProber{})
	if _, err := lib.Scan(context.Background()); err != nil {
		t.Fatal(err)
	}
	plain, gz := lib.Snapshot().JSON()
	if len(gz) == 0 {
		t.Fatal("gzip body missing")
	}
	var decoded struct {
		Version string `json:"version"`
		Tracks  []struct {
			ID, Title, Folder, File string
			DurationMs              int64
		} `json:"tracks"`
		Folders []struct {
			Path     string
			TrackIDs []string `json:"trackIds"`
		} `json:"folders"`
		Playlists []any `json:"playlists"`
	}
	if err := json.Unmarshal(plain, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Version != lib.Snapshot().Version || len(decoded.Tracks) != 1 || decoded.Tracks[0].File != "tagged1.mp3" ||
		decoded.Tracks[0].DurationMs != 1000 || decoded.Playlists == nil {
		t.Fatalf("json: %s", plain)
	}
	if strings.Contains(string(plain), root) {
		t.Fatal("absolute paths must not leak into the API")
	}
	if lib.Snapshot().ETag() != `"`+decoded.Version+`"` {
		t.Fatal("etag")
	}
}

func TestEmptyLibraryJSON(t *testing.T) {
	lib := New(Options{Root: t.TempDir()})
	plain, _ := lib.Snapshot().JSON()
	if !strings.Contains(string(plain), `"tracks":[]`) || !strings.Contains(string(plain), `"folders":[]`) {
		t.Fatalf("empty library json: %s", plain)
	}
}

func TestNaturalLess(t *testing.T) {
	in := []string{"Track 10", "track 2", "Track 1", "Album", "album 01", "album 1", "Ćwiczenia", "Zumba"}
	sort.Slice(in, func(i, j int) bool { return naturalLess(in[i], in[j]) })
	want := []string{"Album", "album 1", "album 01", "Track 1", "track 2", "Track 10", "Zumba", "Ćwiczenia"}
	for i := range want {
		if in[i] != want[i] {
			t.Fatalf("got %v\nwant %v", in, want)
		}
	}
}

func TestGuessFromFilename(t *testing.T) {
	cases := []struct{ in, title, artist string }{
		{"A/01 - Song.mp3", "Song", ""},
		{"A/01. Artist - Song.mp3", "Song", "Artist"},
		{"Artist - Song (Remix).flac", "Song (Remix)", "Artist"},
		{"1999.mp3", "1999", ""},
		{"02_some_song.ogg", "some song", ""},
		{"Plain.mp3", "Plain", ""},
	}
	for _, c := range cases {
		title, artist := guessFromFilename(c.in)
		if title != c.title || artist != c.artist {
			t.Errorf("guessFromFilename(%q) = %q, %q; want %q, %q", c.in, title, artist, c.title, c.artist)
		}
	}
}

func TestTrackIDStableAndNormalized(t *testing.T) {
	nfc := "Zażółć/gęślą.mp3"
	nfd := "Zaz\u0307o\u0301\u0142c\u0301/ge\u0328s\u0301la\u0328.mp3"
	if TrackID(nfc) != TrackID(nfd) {
		t.Fatal("NFC and NFD paths must map to the same id")
	}
	if TrackID(`A\b.mp3`) != TrackID("A/b.mp3") {
		t.Fatal("separators must be normalized")
	}
	if len(TrackID("x")) != 16 || TrackID("x") == TrackID("y") || TrackID("x") == PlaylistID("x") {
		t.Fatal("ids")
	}
}

func TestParseM3U(t *testing.T) {
	data := "\xef\xbb\xbf#EXTM3U\r\n#EXTINF:123,Artist - Song\r\nsong.mp3\r\n\r\nsub/other.flac\n../../escape.mp3\n/home/me/Music/Rock/x.mp3\nC:\\Music\\Rock\\y.mp3\nfile:///mnt/music/Rock/z.mp3\nhttps://radio.example/stream\n"
	got := parseM3U([]byte(data), "Lists/gym.m3u8")
	want := []string{"Lists/song.mp3", "Lists/sub/other.flac", "/home/me/Music/Rock/x.mp3", "C:/Music/Rock/y.mp3", "/mnt/music/Rock/z.mp3"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got  %v\nwant %v", got, want)
	}
}

func TestResolvePlaylistsBySuffix(t *testing.T) {
	tracks := []*Track{
		{ID: "x", Path: "Rock/x.mp3"},
		{ID: "x2", Path: "x.mp3"},
		{ID: "y", Path: "Rock/y.mp3"},
	}
	pls := resolvePlaylists([]store.Playlist{{ID: "p", Name: "P", TrackPaths: []string{
		"/home/me/Music/Rock/x.mp3", "C:/Music/ROCK/Y.MP3", "/nowhere/q.mp3",
	}}}, tracks)
	if got := strings.Join(pls[0].TrackIDs, ","); got != "x,y" {
		t.Fatalf("resolved = %s", got)
	}
}

func TestIsFolderImage(t *testing.T) {
	for name, want := range map[string]bool{
		"cover.jpg": true, "Folder.JPG": true, "front.png": true, "AlbumArt.webp": true,
		"cover.gif": false, "booklet.jpg": false, "cover.mp3": false,
	} {
		if isFolderImage(name) != want {
			t.Errorf("isFolderImage(%q) != %v", name, want)
		}
	}
	if folderImageRank("cover.png") >= folderImageRank("folder.jpg") {
		t.Fatal("cover should be preferred over folder")
	}
}

func TestSkipDir(t *testing.T) {
	for name, want := range map[string]bool{".git": true, "@eaDir": true, "#recycle": true, "Rock": false} {
		if skipDir(name) != want {
			t.Errorf("skipDir(%q) != %v", name, want)
		}
	}
}

func TestTrackOrdering(t *testing.T) {
	tracks := []Track{
		{ID: "c", Path: "A/c.mp3", Folder: "A", TrackNo: 0},
		{ID: "b", Path: "A/b.mp3", Folder: "A", TrackNo: 2},
		{ID: "a", Path: "A/a.mp3", Folder: "A", TrackNo: 1},
		{ID: "d2", Path: "A/d.mp3", Folder: "A", TrackNo: 1, DiscNo: 2},
		{ID: "z", Path: "B/z.mp3", Folder: "B"},
		{ID: "r", Path: "r.mp3", Folder: ""},
	}
	snap := buildSnapshot(tracks, nil, nil)
	var ids []string
	for _, t := range snap.Tracks {
		ids = append(ids, t.ID)
	}
	if got := strings.Join(ids, ","); got != "r,a,b,c,d2,z" {
		t.Fatalf("order = %s", got)
	}
	if snap.Folders[0].Path != "" {
		t.Fatalf("root folder should sort first: %+v", snap.Folders[0])
	}
}

func writePNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := range w {
		for y := range h {
			img.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 100, A: 255})
		}
	}
	p := filepath.Join(t.TempDir(), "img.png")
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	f.Close()
	b, _ := os.ReadFile(p)
	return b
}

func TestResizeToJPEG(t *testing.T) {
	out, err := resizeToJPEG(writePNG(t, 1000, 500), 128)
	if err != nil {
		t.Fatal(err)
	}
	img, err := jpeg.Decode(strings.NewReader(string(out)))
	if err != nil {
		t.Fatal(err)
	}
	if b := img.Bounds(); b.Dx() != 128 || b.Dy() != 64 {
		t.Fatalf("resized to %v", b)
	}
	small, err := resizeToJPEG(writePNG(t, 50, 40), 512)
	if err != nil {
		t.Fatal(err)
	}
	img, _ = jpeg.Decode(strings.NewReader(string(small)))
	if b := img.Bounds(); b.Dx() != 50 || b.Dy() != 40 {
		t.Fatalf("small image must not be upscaled: %v", b)
	}
	if _, err := resizeToJPEG([]byte("nope"), 128); err == nil {
		t.Fatal("expected decode error")
	}
}

func TestNormalizeSize(t *testing.T) {
	if NormalizeSize(0) != 128 || NormalizeSize(128) != 128 || NormalizeSize(129) != 512 || NormalizeSize(4000) != 512 {
		t.Fatal("NormalizeSize")
	}
}

func TestCoversEmbeddedAndFolderFallback(t *testing.T) {
	root := t.TempDir()
	testutil.Generate(t, root,
		testutil.Spec{Path: "Embedded/a.mp3", Seconds: 1, Cover: true},
		testutil.Spec{Path: "FolderArt/b.mp3", Seconds: 1},
		testutil.Spec{Path: "None/c.mp3", Seconds: 1},
	)
	if err := os.WriteFile(filepath.Join(root, "FolderArt", "cover.png"), writePNG(t, 600, 600), 0o644); err != nil {
		t.Fatal(err)
	}
	lib, _ := newTestLibrary(t, root, media.FFprobe{})
	if _, err := lib.Scan(context.Background()); err != nil {
		t.Fatal(err)
	}
	covers, err := NewCovers(lib, filepath.Join(t.TempDir(), "covers"))
	if err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"Embedded/a.mp3", "FolderArt/b.mp3"} {
		p, err := covers.Path(TrackID(rel), 512)
		if err != nil {
			t.Fatalf("%s: %v", rel, err)
		}
		f, err := os.Open(p)
		if err != nil {
			t.Fatal(err)
		}
		img, err := jpeg.Decode(f)
		f.Close()
		if err != nil {
			t.Fatalf("%s: cached cover is not a JPEG: %v", rel, err)
		}
		if b := img.Bounds(); b.Dx() > 512 || b.Dy() > 512 {
			t.Fatalf("%s: not resized: %v", rel, b)
		}
		again, err := covers.Path(TrackID(rel), 512)
		if err != nil || again != p {
			t.Fatalf("second lookup should hit the cache: %q %v", again, err)
		}
	}
	if _, err := covers.Path(TrackID("None/c.mp3"), 128); !errors.Is(err, ErrNoCover) {
		t.Fatalf("want ErrNoCover, got %v", err)
	}
	if _, err := covers.Path("unknown", 128); !errors.Is(err, ErrNoCover) {
		t.Fatalf("want ErrNoCover for unknown track, got %v", err)
	}
}

func TestRunPeriodic(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "a.mp3", "x")
	lib, _ := newTestLibrary(t, root, &fakeProber{})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { lib.RunPeriodic(ctx, 10*time.Millisecond); close(done) }()
	deadline := time.Now().Add(5 * time.Second)
	for len(lib.Snapshot().Tracks) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	if len(lib.Snapshot().Tracks) != 1 {
		t.Fatal("periodic scan did not run")
	}
}
