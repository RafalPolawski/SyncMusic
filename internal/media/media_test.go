package media

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/RafalPolawski/SyncMusic/internal/testutil"
)

func TestParseFFprobe(t *testing.T) {
	raw := `{
	  "streams": [
	    {"codec_type":"audio","codec_name":"opus","sample_rate":"48000","channels":2,"bit_rate":"","duration":"185.512",
	     "tags":{"TITLE":"Stream Title","ARTIST":"Stream Artist","TRACKNUMBER":"7"}},
	    {"codec_type":"video","codec_name":"mjpeg","disposition":{"attached_pic":1}}
	  ],
	  "format": {"format_name":"ogg","duration":"185.600","bit_rate":"97000","tags":{"album":"Album","DATE":"2019-04-01"}}
	}`
	info, err := parseFFprobe([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	want := Info{Format: "ogg", Codec: "opus", DurationMs: 185512, Bitrate: 97000, SampleRate: 48000, Channels: 2,
		HasCover: true, Title: "Stream Title", Artist: "Stream Artist", Album: "Album", Year: 2019, TrackNo: 7}
	if info != want {
		t.Fatalf("got  %+v\nwant %+v", info, want)
	}
}

func TestParseFFprobeNoAudio(t *testing.T) {
	_, err := parseFFprobe([]byte(`{"streams":[{"codec_type":"video"}],"format":{}}`))
	if err != ErrNoAudio {
		t.Fatalf("want ErrNoAudio, got %v", err)
	}
	if _, err := parseFFprobe([]byte(`not json`)); err == nil {
		t.Fatal("expected JSON error")
	}
}

func TestParseHelpers(t *testing.T) {
	if parseIndex("3/12") != 3 || parseIndex(" 04 ") != 4 || parseIndex("x") != 0 || parseIndex("-1") != 0 {
		t.Fatal("parseIndex")
	}
	if parseYear("2019-05-01") != 2019 || parseYear("19") != 0 || parseYear("abcd") != 0 {
		t.Fatal("parseYear")
	}
	if parseSeconds("1.2345") != 1235 || parseSeconds("N/A") != 0 || parseSeconds("-1") != 0 {
		t.Fatal("parseSeconds")
	}
	progress := "frame=0\nout_time_us=1500000\nprogress=continue\nout_time_us=2504000\nprogress=end\n"
	if got := parseProgressDuration([]byte(progress)); got != 2504 {
		t.Fatalf("parseProgressDuration = %d", got)
	}
}

func TestProbeRealFiles(t *testing.T) {
	dir := t.TempDir()
	paths := testutil.Generate(t, dir,
		testutil.Spec{Path: "a.mp3", Seconds: 3, Title: "Song A", Artist: "Artist A", Album: "Alb", Track: "2/9", Cover: true},
		testutil.Spec{Path: "b.flac", Seconds: 2.5, Title: "Song B", Cover: true},
		testutil.Spec{Path: "c.ogg", Seconds: 1.5, Artist: "Opus Artist", Channels: 1},
		testutil.Spec{Path: "d.m4a", Seconds: 2},
	)
	p := FFprobe{}
	ctx := context.Background()

	a, err := p.Probe(ctx, paths[0])
	if err != nil {
		t.Fatal(err)
	}
	if a.Codec != "mp3" || a.Title != "Song A" || a.Artist != "Artist A" || a.Album != "Alb" || a.TrackNo != 2 || !a.HasCover {
		t.Fatalf("mp3 info: %+v", a)
	}
	assertNear(t, "mp3 duration", a.DurationMs, 3000, 80)

	b, err := p.Probe(ctx, paths[1])
	if err != nil {
		t.Fatal(err)
	}
	if b.Codec != "flac" || b.Title != "Song B" || !b.HasCover || b.SampleRate != 44100 {
		t.Fatalf("flac info: %+v", b)
	}
	assertNear(t, "flac duration", b.DurationMs, 2500, 10)

	c, err := p.Probe(ctx, paths[2])
	if err != nil {
		t.Fatal(err)
	}
	if c.Codec != "opus" || c.Artist != "Opus Artist" || c.Channels != 1 || c.HasCover {
		t.Fatalf("ogg info: %+v", c)
	}
	assertNear(t, "ogg duration", c.DurationMs, 1500, 30)

	d, err := p.Probe(ctx, paths[3])
	if err != nil {
		t.Fatal(err)
	}
	if d.Codec != "aac" {
		t.Fatalf("m4a info: %+v", d)
	}

	notAudio := filepath.Join(dir, "x.mp3")
	if err := os.WriteFile(notAudio, []byte("definitely not audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Probe(ctx, notAudio); err == nil {
		t.Fatal("expected error for garbage file")
	}
}

func assertNear(t *testing.T, what string, got, want, tol int64) {
	t.Helper()
	if got < want-tol || got > want+tol {
		t.Fatalf("%s = %d, want %d±%d", what, got, want, tol)
	}
}

func TestPlan(t *testing.T) {
	flac := Source{Codec: "flac", Bitrate: 900_000}
	mp3small := Source{Codec: "mp3", Bitrate: 128_000}
	mp3big := Source{Codec: "mp3", Bitrate: 320_000}
	opus := Source{Codec: "opus", Bitrate: 96_000}

	cases := []struct {
		name    string
		src     Source
		f       Format
		q       Quality
		enabled bool
		want    string // "" means passthrough
	}{
		{"flac medium opus", flac, FormatOpus, QualityMedium, true, "opus-96"},
		{"flac high aac", flac, FormatAAC, QualityHigh, true, "aac-192"},
		{"original always passthrough", flac, FormatOpus, QualityOriginal, true, ""},
		{"disabled passthrough", flac, FormatOpus, QualityLow, false, ""},
		{"small mp3 not re-encoded", mp3small, FormatOpus, QualityMedium, true, ""},
		{"big mp3 re-encoded", mp3big, FormatOpus, QualityMedium, true, "opus-96"},
		{"small mp3 re-encoded for low", mp3small, FormatOpus, QualityLow, true, "opus-64"},
		{"opus source passthrough for opus clients", opus, FormatOpus, QualityMedium, true, ""},
		{"opus source transcoded for aac clients", opus, FormatAAC, QualityMedium, true, "aac-128"},
	}
	for _, c := range cases {
		p, ok := Plan(c.src, c.f, c.q, c.enabled)
		got := ""
		if ok {
			got = p.Name
		}
		if got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

func TestParseFormatQuality(t *testing.T) {
	if ParseFormat("AAC") != FormatAAC || ParseFormat("weird") != FormatOpus {
		t.Fatal("ParseFormat")
	}
	if ParseQuality("HIGH") != QualityHigh || ParseQuality("") != QualityMedium || ParseQuality("original") != QualityOriginal {
		t.Fatal("ParseQuality")
	}
	if MIMEType("x.FLAC") != "audio/flac" || MIMEType("x.bin") != "application/octet-stream" {
		t.Fatal("MIMEType")
	}
	if !AudioExtensions[".opus"] || AudioExtensions[".txt"] {
		t.Fatal("AudioExtensions")
	}
}

func newTestTranscoder(t *testing.T, max int64) *Transcoder {
	t.Helper()
	tr, err := NewTranscoder(TranscoderOptions{CacheDir: filepath.Join(t.TempDir(), "cache"), MaxBytes: max, Workers: 2})
	if err != nil {
		t.Fatal(err)
	}
	return tr
}

func sourceFor(t *testing.T, id, path string) Source {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return Source{TrackID: id, Path: path, Size: fi.Size(), MtimeNs: fi.ModTime().UnixNano(), Codec: "flac", Channels: 2}
}

func TestTranscodeOpusAndAAC(t *testing.T) {
	dir := t.TempDir()
	paths := testutil.Generate(t, dir, testutil.Spec{Path: "song.flac", Seconds: 3, Cover: true})
	tr := newTestTranscoder(t, 0)
	ctx := context.Background()
	src := sourceFor(t, "t1", paths[0])

	for _, f := range []Format{FormatOpus, FormatAAC} {
		p, _ := LookupProfile(f, QualityLow)
		out, err := tr.Get(ctx, src, p)
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		if !strings.HasSuffix(out, p.Ext) {
			t.Fatalf("unexpected output name %s", out)
		}
		info, err := FFprobe{}.Probe(ctx, out)
		if err != nil {
			t.Fatal(err)
		}
		wantCodec := map[Format]string{FormatOpus: "opus", FormatAAC: "aac"}[f]
		if info.Codec != wantCodec || info.HasCover {
			t.Fatalf("%s output info: %+v", f, info)
		}
		assertNear(t, string(f)+" duration", info.DurationMs, 3000, 60)
	}
	if tr.CacheSize() <= 0 {
		t.Fatal("cache size not tracked")
	}
}

func TestTranscodeSharesWorkAndCaches(t *testing.T) {
	dir := t.TempDir()
	paths := testutil.Generate(t, dir, testutil.Spec{Path: "song.flac", Seconds: 2})
	tr := newTestTranscoder(t, 0)
	var misses, hits atomic.Int32
	tr.OnMiss = func(time.Duration, error) { misses.Add(1) }
	tr.OnHit = func() { hits.Add(1) }
	src := sourceFor(t, "t1", paths[0])
	p, _ := LookupProfile(FormatOpus, QualityMedium)

	var wg sync.WaitGroup
	results := make([]string, 5)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			out, err := tr.Get(context.Background(), src, p)
			if err != nil {
				t.Error(err)
			}
			results[i] = out
		}(i)
	}
	wg.Wait()
	for _, r := range results[1:] {
		if r != results[0] {
			t.Fatalf("different outputs: %v", results)
		}
	}
	if misses.Load() != 1 {
		t.Fatalf("expected exactly one ffmpeg run, got %d", misses.Load())
	}
	if _, err := tr.Get(context.Background(), src, p); err != nil {
		t.Fatal(err)
	}
	if hits.Load() < 1 {
		t.Fatal("expected a cache hit")
	}
}

func TestTranscodeInvalidatesOnSourceChange(t *testing.T) {
	dir := t.TempDir()
	paths := testutil.Generate(t, dir, testutil.Spec{Path: "song.flac", Seconds: 1})
	tr := newTestTranscoder(t, 0)
	p, _ := LookupProfile(FormatOpus, QualityLow)
	src := sourceFor(t, "t1", paths[0])
	first, err := tr.Get(context.Background(), src, p)
	if err != nil {
		t.Fatal(err)
	}
	testutil.Generate(t, dir, testutil.Spec{Path: "song.flac", Seconds: 2})
	later := time.Now().Add(time.Minute)
	if err := os.Chtimes(paths[0], later, later); err != nil {
		t.Fatal(err)
	}
	src2 := sourceFor(t, "t1", paths[0])
	second, err := tr.Get(context.Background(), src2, p)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("source change must produce a new cache file")
	}
	if _, err := os.Stat(first); !os.IsNotExist(err) {
		t.Fatalf("stale variant should be removed, stat err = %v", err)
	}
}

func TestTranscodeEviction(t *testing.T) {
	dir := t.TempDir()
	paths := testutil.Generate(t, dir,
		testutil.Spec{Path: "a.flac", Seconds: 2},
		testutil.Spec{Path: "b.flac", Seconds: 2, Freq: 880},
		testutil.Spec{Path: "c.flac", Seconds: 2, Freq: 660},
	)
	p, _ := LookupProfile(FormatOpus, QualityHigh)
	probeTr := newTestTranscoder(t, 0)
	one, err := probeTr.Get(context.Background(), sourceFor(t, "a", paths[0]), p)
	if err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(one)
	// Room for roughly two outputs.
	tr := newTestTranscoder(t, fi.Size()*2+fi.Size()/2)
	clock := time.Now()
	tr.now = func() time.Time { clock = clock.Add(time.Second); return clock }

	outA, _ := tr.Get(context.Background(), sourceFor(t, "a", paths[0]), p)
	outB, _ := tr.Get(context.Background(), sourceFor(t, "b", paths[1]), p)
	if _, err := tr.Get(context.Background(), sourceFor(t, "a", paths[0]), p); err != nil { // touch a
		t.Fatal(err)
	}
	outC, err := tr.Get(context.Background(), sourceFor(t, "c", paths[2]), p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(outB); !os.IsNotExist(err) {
		t.Fatal("least recently used entry (b) should be evicted")
	}
	for _, f := range []string{outA, outC} {
		if _, err := os.Stat(f); err != nil {
			t.Fatalf("%s should still exist: %v", f, err)
		}
	}
	if tr.CacheSize() > tr.maxBytes {
		t.Fatalf("cache size %d exceeds max %d", tr.CacheSize(), tr.maxBytes)
	}
}

func TestTranscoderIndexesExistingCacheAndCleansTmp(t *testing.T) {
	cache := filepath.Join(t.TempDir(), "cache")
	if err := os.MkdirAll(cache, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cache, "x.opus-96.abc.ogg"), make([]byte, 100), 0o644); err != nil {
		t.Fatal(err)
	}
	tmp := filepath.Join(cache, "y.opus-96.abc.ogg"+tmpMarker+"123")
	if err := os.WriteFile(tmp, make([]byte, 50), 0o644); err != nil {
		t.Fatal(err)
	}
	tr, err := NewTranscoder(TranscoderOptions{CacheDir: cache})
	if err != nil {
		t.Fatal(err)
	}
	if tr.CacheSize() != 100 {
		t.Fatalf("cache size = %d, want 100", tr.CacheSize())
	}
	if _, err := os.Stat(tmp); !os.IsNotExist(err) {
		t.Fatal("tmp leftover should be removed")
	}
}

func TestTranscodeFailure(t *testing.T) {
	testutil.RequireFFmpeg(t)
	bad := filepath.Join(t.TempDir(), "bad.flac")
	if err := os.WriteFile(bad, []byte("garbage"), 0o644); err != nil {
		t.Fatal(err)
	}
	tr := newTestTranscoder(t, 0)
	p, _ := LookupProfile(FormatOpus, QualityLow)
	if _, err := tr.Get(context.Background(), sourceFor(t, "bad", bad), p); err == nil {
		t.Fatal("expected ffmpeg failure")
	}
	des, _ := os.ReadDir(tr.dir)
	if len(des) != 0 {
		t.Fatalf("failed transcode left files behind: %v", des)
	}
}

func TestGetHonoursContext(t *testing.T) {
	dir := t.TempDir()
	paths := testutil.Generate(t, dir, testutil.Spec{Path: "song.flac", Seconds: 1})
	tr := newTestTranscoder(t, 0)
	p, _ := LookupProfile(FormatOpus, QualityLow)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := tr.Get(ctx, sourceFor(t, "t", paths[0]), p); err == nil {
		t.Fatal("expected context error")
	}
}

func TestPrewarm(t *testing.T) {
	dir := t.TempDir()
	paths := testutil.Generate(t, dir, testutil.Spec{Path: "song.flac", Seconds: 1})
	tr := newTestTranscoder(t, 0)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go tr.RunPrewarmer(ctx)
	p, _ := LookupProfile(FormatOpus, QualityLow)
	src := sourceFor(t, "t", paths[0])
	tr.Prewarm(src, p)
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if _, ok := tr.lookup(FileName(src, p)); ok {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("prewarm did not produce a cached file")
}
