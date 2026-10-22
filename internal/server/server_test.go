package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"

	"github.com/RafalPolawski/SyncMusic/internal/auth"
	"github.com/RafalPolawski/SyncMusic/internal/hub"
	"github.com/RafalPolawski/SyncMusic/internal/library"
	"github.com/RafalPolawski/SyncMusic/internal/media"
	"github.com/RafalPolawski/SyncMusic/internal/store"
	"github.com/RafalPolawski/SyncMusic/internal/testutil"
)

type fixture struct {
	srv    *httptest.Server
	lib    *library.Library
	client *http.Client
	root   string
}

var webFS = fstest.MapFS{
	"index.html":           {Data: []byte("<!doctype html><title>SyncMusic</title>")},
	"sw.js":                {Data: []byte("self.addEventListener('fetch',()=>{})")},
	"assets/app-1234.js":   {Data: []byte("console.log(1)")},
	"manifest.webmanifest": {Data: []byte("{}")},
}

func newFixture(t *testing.T, password string, transcode bool) *fixture {
	t.Helper()
	root := t.TempDir()
	testutil.Generate(t, root,
		testutil.Spec{Path: "Gym/01 - Pump.flac", Seconds: 2, Title: "Pump", Artist: "Lifter", Cover: true},
		testutil.Spec{Path: "Gym/02 - Squat.mp3", Seconds: 2, Title: "Squat"},
		testutil.Spec{Path: "loose.mp3", Seconds: 1},
	)
	data := t.TempDir()
	db, err := store.Open(context.Background(), filepath.Join(data, "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	log := slog.New(slog.DiscardHandler)
	lib := library.New(library.Options{Root: root, DB: db, Prober: media.FFprobe{}, Logger: log})
	if _, err := lib.Scan(context.Background()); err != nil {
		t.Fatal(err)
	}
	covers, err := library.NewCovers(lib, filepath.Join(data, "covers"))
	if err != nil {
		t.Fatal(err)
	}
	var tr *media.Transcoder
	if transcode {
		tr, err = media.NewTranscoder(media.TranscoderOptions{CacheDir: filepath.Join(data, "transcode"), Logger: log})
		if err != nil {
			t.Fatal(err)
		}
	}
	h := hub.New(hub.Options{Catalog: lib.Snapshot(), Store: db, Logger: log})
	t.Cleanup(func() { _ = h.Close(context.Background()) })
	handler := New(Deps{
		Library: lib, Covers: covers, Transcoder: tr, Hub: h,
		Auth:    auth.New(password, []byte("0123456789abcdef0123456789abcdef"), time.Hour),
		Limiter: auth.NewLimiter(time.Minute, 3),
		Logger:  log, WebFS: webFS, CookieSecure: "false",
	})
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	jar, _ := cookiejar.New(nil)
	return &fixture{srv: srv, lib: lib, client: &http.Client{Jar: jar}, root: root}
}

func (f *fixture) get(t *testing.T, path string, hdr ...string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, f.srv.URL+path, nil)
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	resp, err := f.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func (f *fixture) postJSON(t *testing.T, path, body string, hdr ...string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, f.srv.URL+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	resp, err := f.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func readAll(t *testing.T, r io.Reader) []byte {
	t.Helper()
	b, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func trackID(rel string) string { return library.TrackID(rel) }

func TestHealthAndSession(t *testing.T) {
	f := newFixture(t, "", false)
	if r := f.get(t, "/healthz"); r.StatusCode != http.StatusOK {
		t.Fatalf("healthz %d", r.StatusCode)
	}
	if r := f.get(t, "/readyz"); r.StatusCode != http.StatusOK {
		t.Fatalf("readyz %d", r.StatusCode)
	}
	var s sessionInfo
	if err := json.Unmarshal(readAll(t, f.get(t, "/api/session").Body), &s); err != nil {
		t.Fatal(err)
	}
	if s.AuthRequired || !s.Authenticated || s.Transcoding {
		t.Fatalf("session = %+v", s)
	}
}

func TestLoginFlow(t *testing.T) {
	f := newFixture(t, "secret", false)
	if r := f.get(t, "/api/library"); r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("library without login: %d", r.StatusCode)
	}
	var s sessionInfo
	_ = json.Unmarshal(readAll(t, f.get(t, "/api/session").Body), &s)
	if !s.AuthRequired || s.Authenticated {
		t.Fatalf("session before login = %+v", s)
	}
	if r := f.postJSON(t, "/api/auth/login", `{"password":"nope"}`); r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong password: %d", r.StatusCode)
	}
	// Successful logins do not use up attempts.
	for range 5 {
		if r := f.postJSON(t, "/api/auth/login", `{"password":"secret"}`); r.StatusCode != http.StatusNoContent {
			t.Fatalf("repeated login: %d", r.StatusCode)
		}
	}
	if r := f.postJSON(t, "/api/auth/login", `not json`); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad body: %d", r.StatusCode)
	}
	if r := f.postJSON(t, "/api/auth/login", `{"password":"secret"}`); r.StatusCode != http.StatusNoContent {
		t.Fatalf("login: %d", r.StatusCode)
	}
	if r := f.get(t, "/api/library"); r.StatusCode != http.StatusOK {
		t.Fatalf("library after login: %d", r.StatusCode)
	}
	_ = json.Unmarshal(readAll(t, f.get(t, "/api/session").Body), &s)
	if !s.Authenticated {
		t.Fatal("session should be authenticated")
	}
	if r := f.postJSON(t, "/api/auth/logout", `{}`); r.StatusCode != http.StatusNoContent {
		t.Fatalf("logout: %d", r.StatusCode)
	}
	if r := f.get(t, "/api/library"); r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("library after logout: %d", r.StatusCode)
	}
	// Rate limited after 3 failed attempts.
	for range 2 {
		if r := f.postJSON(t, "/api/auth/login", `{"password":"x"}`); r.StatusCode != http.StatusUnauthorized {
			t.Fatalf("failed attempt: %d", r.StatusCode)
		}
	}
	if r := f.postJSON(t, "/api/auth/login", `{"password":"secret"}`); r.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("rate limit: %d", r.StatusCode)
	}
}

func TestLoginRejectsCrossSiteRequests(t *testing.T) {
	f := newFixture(t, "secret", false)
	resp, err := f.client.Post(f.srv.URL+"/api/auth/login", "application/x-www-form-urlencoded", strings.NewReader("password=secret"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("form post: %d", resp.StatusCode)
	}
	if r := f.postJSON(t, "/api/auth/login", `{"password":"secret"}`, "Origin", "https://evil.example"); r.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin: %d", r.StatusCode)
	}
	host := strings.TrimPrefix(f.srv.URL, "http://")
	if r := f.postJSON(t, "/api/auth/login", `{"password":"secret"}`, "Origin", "http://"+host); r.StatusCode != http.StatusNoContent {
		t.Fatalf("same-origin: %d", r.StatusCode)
	}
}

func TestLibraryETagAndGzip(t *testing.T) {
	f := newFixture(t, "", false)
	r := f.get(t, "/api/library", "Accept-Encoding", "gzip")
	if r.StatusCode != http.StatusOK || r.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("status %d encoding %q", r.StatusCode, r.Header.Get("Content-Encoding"))
	}
	zr, err := gzip.NewReader(r.Body)
	if err != nil {
		t.Fatal(err)
	}
	var lib struct {
		Version string
		Tracks  []struct{ ID, Title, Rev string }
		Folders []struct{ Path string }
	}
	if err := json.Unmarshal(readAll(t, zr), &lib); err != nil {
		t.Fatal(err)
	}
	if len(lib.Tracks) != 3 || lib.Tracks[0].Rev == "" {
		t.Fatalf("library = %+v", lib)
	}
	etag := r.Header.Get("ETag")
	if r2 := f.get(t, "/api/library", "If-None-Match", etag); r2.StatusCode != http.StatusNotModified {
		t.Fatalf("conditional request: %d", r2.StatusCode)
	}
	// Without gzip support the plain body is served.
	req, _ := http.NewRequest(http.MethodGet, f.srv.URL+"/api/library", nil)
	req.Header.Set("Accept-Encoding", "identity")
	tr := &http.Transport{DisableCompression: true}
	resp, err := (&http.Client{Transport: tr}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("Content-Encoding") != "" || !json.Valid(readAll(t, resp.Body)) {
		t.Fatal("plain library response expected")
	}
	if r := f.get(t, "/api/library/status"); r.StatusCode != http.StatusOK {
		t.Fatalf("status endpoint: %d", r.StatusCode)
	}
	if r := f.postJSON(t, "/api/library/rescan", `{}`); r.StatusCode != http.StatusAccepted {
		t.Fatalf("rescan: %d", r.StatusCode)
	}
}

func TestAudioOriginalWithRanges(t *testing.T) {
	f := newFixture(t, "", true)
	id := trackID("Gym/02 - Squat.mp3")
	orig, err := os.ReadFile(filepath.Join(f.root, "Gym", "02 - Squat.mp3"))
	if err != nil {
		t.Fatal(err)
	}
	r := f.get(t, "/api/tracks/"+id+"/audio?q=original&v=abc")
	body := readAll(t, r.Body)
	if r.StatusCode != http.StatusOK || !bytes.Equal(body, orig) || r.Header.Get("Content-Type") != "audio/mpeg" {
		t.Fatalf("status %d type %q len %d", r.StatusCode, r.Header.Get("Content-Type"), len(body))
	}
	if r.Header.Get("Cache-Control") != immutable || r.Header.Get("X-Audio-Profile") != "original" {
		t.Fatalf("headers: %v", r.Header)
	}
	rr := f.get(t, "/api/tracks/"+id+"/audio?q=original", "Range", "bytes=10-19")
	part := readAll(t, rr.Body)
	if rr.StatusCode != http.StatusPartialContent || !bytes.Equal(part, orig[10:20]) {
		t.Fatalf("range: status %d body %d bytes", rr.StatusCode, len(part))
	}
	if rr.Header.Get("Cache-Control") != "private, no-cache" {
		t.Fatalf("unversioned audio must revalidate: %q", rr.Header.Get("Cache-Control"))
	}
}

func TestAudioTranscoded(t *testing.T) {
	f := newFixture(t, "", true)
	id := trackID("Gym/01 - Pump.flac")
	r := f.get(t, "/api/tracks/"+id+"/audio?f=opus&q=low")
	body := readAll(t, r.Body)
	if r.StatusCode != http.StatusOK || r.Header.Get("Content-Type") != "audio/ogg" || r.Header.Get("X-Audio-Profile") != "opus-64" {
		t.Fatalf("status %d headers %v", r.StatusCode, r.Header)
	}
	if !bytes.HasPrefix(body, []byte("OggS")) {
		t.Fatal("not an Ogg stream")
	}
	r = f.get(t, "/api/tracks/"+id+"/audio?f=aac&q=medium")
	body = readAll(t, r.Body)
	if r.Header.Get("Content-Type") != "audio/mp4" || r.Header.Get("X-Audio-Profile") != "aac-128" || !bytes.Contains(body[:64], []byte("ftyp")) {
		t.Fatalf("aac: headers %v", r.Header)
	}
	if r := f.get(t, "/api/tracks/nope/audio"); r.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown track: %d", r.StatusCode)
	}
}

func TestAudioWithoutTranscoderServesOriginal(t *testing.T) {
	f := newFixture(t, "", false)
	r := f.get(t, "/api/tracks/"+trackID("Gym/01 - Pump.flac")+"/audio?f=opus&q=low")
	if r.StatusCode != http.StatusOK || r.Header.Get("Content-Type") != "audio/flac" {
		t.Fatalf("status %d type %q", r.StatusCode, r.Header.Get("Content-Type"))
	}
}

func TestCover(t *testing.T) {
	f := newFixture(t, "", false)
	r := f.get(t, "/api/tracks/"+trackID("Gym/01 - Pump.flac")+"/cover?s=128&v=1")
	body := readAll(t, r.Body)
	if r.StatusCode != http.StatusOK || r.Header.Get("Content-Type") != "image/jpeg" || !bytes.HasPrefix(body, []byte{0xff, 0xd8}) {
		t.Fatalf("cover: status %d type %q", r.StatusCode, r.Header.Get("Content-Type"))
	}
	if r := f.get(t, "/api/tracks/"+trackID("loose.mp3")+"/cover"); r.StatusCode != http.StatusNotFound {
		t.Fatalf("no cover: %d", r.StatusCode)
	}
}

func TestStaticFiles(t *testing.T) {
	f := newFixture(t, "", false)
	r := f.get(t, "/")
	if r.StatusCode != http.StatusOK || !strings.Contains(string(readAll(t, r.Body)), "SyncMusic") || r.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("index: %d %v", r.StatusCode, r.Header)
	}
	r = f.get(t, "/library/some/folder")
	if r.StatusCode != http.StatusOK || !strings.Contains(string(readAll(t, r.Body)), "<!doctype html>") {
		t.Fatalf("spa fallback: %d", r.StatusCode)
	}
	r = f.get(t, "/assets/app-1234.js")
	if r.StatusCode != http.StatusOK || !strings.Contains(r.Header.Get("Cache-Control"), "immutable") {
		t.Fatalf("asset: %d %q", r.StatusCode, r.Header.Get("Cache-Control"))
	}
	r = f.get(t, "/sw.js")
	if r.StatusCode != http.StatusOK || r.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("sw: %d %q", r.StatusCode, r.Header.Get("Cache-Control"))
	}
	if r := f.get(t, "/assets/missing.js"); r.StatusCode != http.StatusNotFound {
		t.Fatalf("missing asset: %d", r.StatusCode)
	}
	if r := f.get(t, "/api/unknown"); r.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown api: %d", r.StatusCode)
	}
	for _, h := range []string{"Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy"} {
		if r.Header.Get(h) == "" {
			t.Errorf("missing security header %s", h)
		}
	}
	resp, err := f.client.Post(f.srv.URL+"/", "text/plain", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST /: %d", resp.StatusCode)
	}
}

func TestPlaceholderWithoutWebBuild(t *testing.T) {
	rec := httptest.NewRecorder()
	newStaticHandler(nil).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "npm run build") {
		t.Fatalf("placeholder: %d %s", rec.Code, rec.Body.String())
	}
}

func TestWebSocketRequiresSession(t *testing.T) {
	f := newFixture(t, "secret", false)
	url := "ws" + strings.TrimPrefix(f.srv.URL, "http") + "/api/ws"
	_, resp, err := websocket.Dial(context.Background(), url, nil)
	if err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated websocket: %v %v", err, resp)
	}
	if r := f.postJSON(t, "/api/auth/login", `{"password":"secret"}`); r.StatusCode != http.StatusNoContent {
		t.Fatal("login failed")
	}
	ws, _, err := websocket.Dial(context.Background(), url, &websocket.DialOptions{HTTPClient: f.client})
	if err != nil {
		t.Fatalf("authenticated websocket: %v", err)
	}
	defer func() { _ = ws.CloseNow() }()
	if err := ws.Write(context.Background(), websocket.MessageText, []byte(`{"type":"ping","id":1,"t0":1}`)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, data, err := ws.Read(ctx)
	if err != nil || !strings.Contains(string(data), `"pong"`) {
		t.Fatalf("pong: %s %v", data, err)
	}
	if r := f.get(t, "/api/rooms"); r.StatusCode != http.StatusOK {
		t.Fatalf("rooms: %d", r.StatusCode)
	}
}

func TestAcceptsGzip(t *testing.T) {
	cases := map[string]bool{"gzip": true, "br, gzip;q=0.8": true, "gzip;q=0": false, "identity": false, "": false}
	for in, want := range cases {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.Header.Set("Accept-Encoding", in)
		if acceptsGzip(r) != want {
			t.Errorf("acceptsGzip(%q) != %v", in, want)
		}
	}
}

func TestRecoverer(t *testing.T) {
	h := recoverer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }), slog.New(slog.DiscardHandler))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != 500 {
		t.Fatalf("status = %d", rec.Code)
	}
}
