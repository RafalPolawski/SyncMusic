// Package server wires the HTTP API, WebSocket hub and embedded web client.
package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/RafalPolawski/SyncMusic/internal/auth"
	"github.com/RafalPolawski/SyncMusic/internal/buildinfo"
	"github.com/RafalPolawski/SyncMusic/internal/hub"
	"github.com/RafalPolawski/SyncMusic/internal/library"
	"github.com/RafalPolawski/SyncMusic/internal/media"
)

// Deps are the collaborators of the HTTP server.
type Deps struct {
	Library    *library.Library
	Covers     *library.Covers
	Transcoder *media.Transcoder // nil disables transcoding
	Hub        *hub.Hub
	Auth       *auth.Manager
	Limiter    *auth.Limiter
	Logger     *slog.Logger
	WebFS      fs.FS               // embedded client; nil serves a placeholder
	Gatherer   prometheus.Gatherer // nil disables /metrics

	CookieSecure string
	TrustProxy   bool
	// Ready reports whether the server finished starting up.
	Ready func() bool
}

type server struct {
	Deps
	static http.Handler
}

// New returns the root HTTP handler.
func New(d Deps) http.Handler {
	if d.Logger == nil {
		d.Logger = slog.Default()
	}
	if d.Limiter == nil {
		d.Limiter = auth.NewLimiter(12*time.Second, 5)
	}
	if d.Ready == nil {
		d.Ready = func() bool { return true }
	}
	s := &server{Deps: d}
	s.static = newStaticHandler(d.WebFS)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("GET /readyz", s.readyz)
	if d.Gatherer != nil {
		mux.Handle("GET /metrics", promhttp.HandlerFor(d.Gatherer, promhttp.HandlerOpts{}))
	}
	mux.HandleFunc("GET /api/session", s.session)
	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.HandleFunc("POST /api/auth/logout", s.logout)

	protected := http.NewServeMux()
	protected.HandleFunc("GET /api/library", s.libraryJSON)
	protected.HandleFunc("GET /api/library/status", s.libraryStatus)
	protected.HandleFunc("POST /api/library/rescan", s.rescan)
	protected.HandleFunc("GET /api/tracks/{id}/audio", s.audio)
	protected.HandleFunc("GET /api/tracks/{id}/cover", s.cover)
	protected.HandleFunc("GET /api/rooms", s.rooms)
	protected.Handle("GET /api/ws", d.Hub)
	protected.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found")
	})
	mux.Handle("/api/", d.Auth.Middleware(protected))
	mux.Handle("/", s.static)

	var h http.Handler = mux
	h = securityHeaders(h)
	h = s.logRequests(h)
	h = recoverer(h, d.Logger)
	return h
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

func (s *server) healthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	_, _ = w.Write([]byte("ok\n"))
}

func (s *server) readyz(w http.ResponseWriter, _ *http.Request) {
	if !s.Ready() {
		http.Error(w, "starting", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/plain")
	_, _ = w.Write([]byte("ready\n"))
}

type sessionInfo struct {
	AuthRequired  bool   `json:"authRequired"`
	Authenticated bool   `json:"authenticated"`
	ServerVersion string `json:"serverVersion"`
	Transcoding   bool   `json:"transcoding"`
}

func (s *server) session(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, sessionInfo{
		AuthRequired:  s.Auth.Required(),
		Authenticated: s.Auth.Authenticated(r),
		ServerVersion: buildinfo.Version,
		Transcoding:   s.Transcoder != nil,
	})
}

// sameOriginPost rejects cross-site form posts. Browsers always send Origin
// on POST; JSON bodies additionally require a CORS preflight cross-origin.
func sameOriginPost(r *http.Request) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	o, ok := strings.CutPrefix(origin, "https://")
	if !ok {
		o, ok = strings.CutPrefix(origin, "http://")
	}
	return ok && strings.EqualFold(o, r.Host)
}

func (s *server) login(w http.ResponseWriter, r *http.Request) {
	if !sameOriginPost(r) {
		writeError(w, http.StatusForbidden, "cross_origin")
		return
	}
	if !s.Limiter.Allow(auth.ClientIP(r, s.TrustProxy)) {
		w.Header().Set("Retry-After", "15")
		writeError(w, http.StatusTooManyRequests, "too_many_attempts")
		return
	}
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request")
		return
	}
	if s.Auth.Required() && !s.Auth.CheckPassword(body.Password) {
		s.Logger.Warn("failed login", "ip", auth.ClientIP(r, s.TrustProxy))
		writeError(w, http.StatusUnauthorized, "wrong_password")
		return
	}
	tok, exp := s.Auth.Issue()
	auth.SetCookie(w, tok, exp, auth.IsSecure(r, s.CookieSecure, s.TrustProxy))
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) logout(w http.ResponseWriter, r *http.Request) {
	if !sameOriginPost(r) {
		writeError(w, http.StatusForbidden, "cross_origin")
		return
	}
	auth.ClearCookie(w, auth.IsSecure(r, s.CookieSecure, s.TrustProxy))
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) libraryJSON(w http.ResponseWriter, r *http.Request) {
	snap := s.Library.Snapshot()
	etag := snap.ETag()
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("Vary", "Accept-Encoding")
	if match := r.Header.Get("If-None-Match"); match != "" && strings.Contains(match, etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	plain, gz := snap.JSON()
	w.Header().Set("Content-Type", "application/json")
	body := plain
	if acceptsGzip(r) {
		w.Header().Set("Content-Encoding", "gzip")
		body = gz
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	_, _ = w.Write(body)
}

func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		enc, q, _ := strings.Cut(strings.TrimSpace(part), ";")
		if strings.EqualFold(strings.TrimSpace(enc), "gzip") && strings.TrimSpace(q) != "q=0" {
			return true
		}
	}
	return false
}

func (s *server) libraryStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.Library.Status())
}

func (s *server) rescan(w http.ResponseWriter, r *http.Request) {
	if !sameOriginPost(r) {
		writeError(w, http.StatusForbidden, "cross_origin")
		return
	}
	go func() {
		if _, err := s.Library.TryScan(contextWithoutCancel(r)); err != nil && !errors.Is(err, library.ErrScanInProgress) {
			s.Logger.Error("manual rescan failed", "err", err)
		}
	}()
	writeJSON(w, http.StatusAccepted, s.Library.Status())
}

func (s *server) rooms(w http.ResponseWriter, r *http.Request) {
	rooms, err := s.Hub.Rooms(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, rooms)
}

const immutable = "private, max-age=31536000, immutable"

func (s *server) audio(w http.ResponseWriter, r *http.Request) {
	snap := s.Library.Snapshot()
	t, ok := snap.Track(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "unknown_track")
		return
	}
	abs, err := s.Library.AbsPath(t.Path)
	if err != nil {
		writeError(w, http.StatusNotFound, "unknown_track")
		return
	}
	q := r.URL.Query()
	src := media.Source{TrackID: t.ID, Path: abs, Size: t.Size, MtimeNs: t.MtimeNs, Codec: t.Codec, Bitrate: t.Bitrate, Channels: t.Channels}
	format, quality := media.ParseFormat(q.Get("f")), media.ParseQuality(q.Get("q"))

	file, contentType := abs, media.MIMEType(t.Path)
	profileName := "original"
	if profile, transcode := media.Plan(src, format, quality, s.Transcoder != nil); transcode {
		out, err := s.Transcoder.Get(r.Context(), src, profile)
		switch {
		case err == nil:
			file, contentType, profileName = out, profile.MIME, profile.Name
		case r.Context().Err() != nil:
			return // client went away
		default:
			// Better to deliver the original than nothing.
			s.Logger.Error("transcode failed, serving original", "track", t.ID, "err", err)
		}
	}
	f, err := os.Open(file)
	if err != nil {
		s.Logger.Error("open audio", "track", t.ID, "err", err)
		writeError(w, http.StatusNotFound, "unavailable")
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal")
		return
	}
	h := w.Header()
	h.Set("Content-Type", contentType)
	h.Set("X-Audio-Profile", profileName)
	h.Set("ETag", `"`+library.Rev(t)+"-"+profileName+`"`)
	if q.Get("v") != "" {
		h.Set("Cache-Control", immutable)
	} else {
		h.Set("Cache-Control", "private, no-cache")
	}
	http.ServeContent(w, r, "", fi.ModTime(), f)
}

func (s *server) cover(w http.ResponseWriter, r *http.Request) {
	size, _ := strconv.Atoi(r.URL.Query().Get("s"))
	p, err := s.Covers.Path(r.PathValue("id"), size)
	if errors.Is(err, library.ErrNoCover) {
		w.Header().Set("Cache-Control", "private, max-age=3600")
		writeError(w, http.StatusNotFound, "no_cover")
		return
	}
	if err != nil {
		s.Logger.Warn("cover failed", "track", r.PathValue("id"), "err", err)
		writeError(w, http.StatusNotFound, "no_cover")
		return
	}
	f, err := os.Open(p)
	if err != nil {
		writeError(w, http.StatusNotFound, "no_cover")
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal")
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	if r.URL.Query().Get("v") != "" {
		w.Header().Set("Cache-Control", immutable)
	} else {
		w.Header().Set("Cache-Control", "private, max-age=86400")
	}
	http.ServeContent(w, r, "", fi.ModTime(), f)
}

// staticHandler serves the single page app with sensible caching: hashed
// assets are immutable, everything else is revalidated so updates roll out.
type staticHandler struct {
	fsys  fs.FS
	files http.Handler
	index []byte
}

const placeholderPage = `<!doctype html><meta charset="utf-8"><title>SyncMusic</title>
<p>The web client is not built. Run <code>npm ci && npm run build</code> in <code>web/</code>.</p>`

func newStaticHandler(fsys fs.FS) http.Handler {
	h := &staticHandler{fsys: fsys}
	if fsys != nil {
		if b, err := fs.ReadFile(fsys, "index.html"); err == nil {
			h.index = b
		}
		h.files = http.FileServerFS(fsys)
	}
	return h
}

func (h *staticHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if h.index == nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(placeholderPage))
		return
	}
	name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if name != "" && name != "index.html" {
		if fi, err := fs.Stat(h.fsys, name); err == nil && !fi.IsDir() {
			if strings.HasPrefix(name, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			h.files.ServeHTTP(w, r)
			return
		}
		if path.Ext(name) != "" {
			http.NotFound(w, r)
			return
		}
	}
	// SPA fallback.
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(h.index))
}
