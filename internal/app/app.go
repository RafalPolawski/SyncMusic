// Package app assembles and runs the SyncMusic server.
package app

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"

	"github.com/RafalPolawski/SyncMusic/internal/auth"
	"github.com/RafalPolawski/SyncMusic/internal/buildinfo"
	"github.com/RafalPolawski/SyncMusic/internal/config"
	"github.com/RafalPolawski/SyncMusic/internal/hub"
	"github.com/RafalPolawski/SyncMusic/internal/library"
	"github.com/RafalPolawski/SyncMusic/internal/media"
	"github.com/RafalPolawski/SyncMusic/internal/server"
	"github.com/RafalPolawski/SyncMusic/internal/store"
)

// NewLogger builds the process logger from the configuration.
func NewLogger(cfg config.Config, w *os.File) *slog.Logger {
	var level slog.Level
	_ = level.UnmarshalText([]byte(cfg.LogLevel))
	opts := &slog.HandlerOptions{Level: level}
	if cfg.LogFormat == "json" {
		return slog.New(slog.NewJSONHandler(w, opts))
	}
	return slog.New(slog.NewTextHandler(w, opts))
}

// Options are runtime hooks used by tests.
type Options struct {
	WebFS fs.FS
	// Listener overrides cfg.Listen (tests use ":0").
	Listener net.Listener
	// OnReady is called with the bound address once the server accepts requests.
	OnReady func(addr string)
}

// Run starts the server and blocks until ctx is cancelled, then shuts down
// gracefully (persisting room state).
func Run(ctx context.Context, cfg config.Config, log *slog.Logger, opts Options) error {
	log.Info("starting", "version", buildinfo.String(), "music", cfg.MusicDir, "data", cfg.DataDir)
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return fmt.Errorf("create data directory: %w", err)
	}
	if fi, err := os.Stat(cfg.MusicDir); err != nil || !fi.IsDir() {
		return fmt.Errorf("music directory %q is not accessible (mount your music there): %v", cfg.MusicDir, err)
	}
	ffprobe, err := exec.LookPath(cfg.FFprobePath)
	if err != nil {
		return fmt.Errorf("ffprobe not found (%s): it is required to read audio metadata", cfg.FFprobePath)
	}
	ffmpeg, ffmpegErr := exec.LookPath(cfg.FFmpegPath)

	db, err := store.Open(ctx, filepath.Join(cfg.DataDir, "syncmusic.db"))
	if err != nil {
		return err
	}
	defer db.Close()

	secret, err := auth.LoadOrCreateSecret(cfg.SessionSecret, cfg.DataDir)
	if err != nil {
		return err
	}
	authMgr := auth.New(cfg.Password, secret, cfg.SessionTTL)
	if !authMgr.Required() {
		log.Warn("SYNCMUSIC_PASSWORD is not set: anyone who can reach the server can use it")
	}

	reg := prometheus.NewRegistry()
	reg.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))

	lib := library.New(library.Options{
		Root:    cfg.MusicDir,
		DB:      db,
		Prober:  media.FFprobe{FFprobePath: ffprobe, FFmpegPath: ffmpeg},
		Workers: cfg.ScanWorkers,
		Logger:  log,
	})
	if err := lib.Load(ctx); err != nil {
		return err
	}
	covers, err := library.NewCovers(lib, filepath.Join(cfg.DataDir, "cache", "covers"))
	if err != nil {
		return err
	}

	var tr *media.Transcoder
	switch {
	case !cfg.Transcode:
		log.Info("transcoding disabled; original files are served")
	case ffmpegErr != nil:
		log.Warn("ffmpeg not found, transcoding disabled", "path", cfg.FFmpegPath)
	default:
		tr, err = media.NewTranscoder(media.TranscoderOptions{
			FFmpegPath: ffmpeg,
			CacheDir:   filepath.Join(cfg.DataDir, "cache", "transcode"),
			MaxBytes:   cfg.TranscodeCacheSize,
			Workers:    cfg.TranscodeWorkers,
			Logger:     log,
		})
		if err != nil {
			return err
		}
		registerTranscodeMetrics(reg, tr)
	}

	runCtx, stop := context.WithCancel(ctx)
	defer stop()

	h := hub.New(hub.Options{
		Catalog:         snapshotCatalog{lib},
		LibraryVersion:  func() string { return lib.Snapshot().Version },
		Store:           db,
		Logger:          log,
		StartDelay:      cfg.StartDelay,
		ResumeDelay:     cfg.ResumeDelay,
		WaitForAllMax:   cfg.WaitForAllMax,
		RoomIdleTimeout: cfg.RoomIdleTimeout,
		OriginPatterns:  cfg.AllowedOrigins,
		Prewarm:         prewarmer(lib, tr),
		ServerVersion:   buildinfo.Version,
		Metrics:         hub.NewMetrics(reg),
	})
	lib.OnChange(func(s *library.Snapshot) { h.LibraryChanged(s.Version) })

	var ready atomic.Bool
	var gatherer prometheus.Gatherer
	if cfg.Metrics {
		gatherer = reg
	}
	handler := server.New(server.Deps{
		Library:      lib,
		Covers:       covers,
		Transcoder:   tr,
		Hub:          h,
		Auth:         authMgr,
		Logger:       log,
		WebFS:        opts.WebFS,
		Gatherer:     gatherer,
		CookieSecure: cfg.CookieSecure,
		TrustProxy:   cfg.TrustProxy,
		Ready:        ready.Load,
	})

	ln := opts.Listener
	if ln == nil {
		ln, err = net.Listen("tcp", cfg.Listen)
		if err != nil {
			return fmt.Errorf("listen on %s: %w", cfg.Listen, err)
		}
	}
	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
		BaseContext:       func(net.Listener) context.Context { return runCtx },
	}

	if tr != nil {
		go tr.RunPrewarmer(runCtx)
	}
	go lib.RunPeriodic(runCtx, cfg.ScanInterval)

	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(ln) }()
	ready.Store(true)
	log.Info("listening", "addr", ln.Addr().String(), "auth", authMgr.Required(), "transcoding", tr != nil)
	if opts.OnReady != nil {
		opts.OnReady(ln.Addr().String())
	}

	select {
	case <-ctx.Done():
	case err := <-serveErr:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}

	log.Info("shutting down")
	ready.Store(false)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := h.Close(shutdownCtx); err != nil {
		log.Warn("closing rooms", "err", err)
	}
	stop()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Warn("http shutdown", "err", err)
	}
	return nil
}

// snapshotCatalog adapts the always-current library snapshot to room.Catalog.
type snapshotCatalog struct{ lib *library.Library }

func (c snapshotCatalog) DurationMs(id string) (int64, bool) {
	return c.lib.Snapshot().DurationMs(id)
}

func prewarmer(lib *library.Library, tr *media.Transcoder) func(id, format, quality string) {
	if tr == nil {
		return nil
	}
	return func(id, format, quality string) {
		t, ok := lib.Snapshot().Track(id)
		if !ok {
			return
		}
		abs, err := lib.AbsPath(t.Path)
		if err != nil {
			return
		}
		src := media.Source{TrackID: t.ID, Path: abs, Size: t.Size, MtimeNs: t.MtimeNs, Codec: t.Codec, Bitrate: t.Bitrate, Channels: t.Channels}
		if p, ok := media.Plan(src, media.ParseFormat(format), media.ParseQuality(quality), true); ok {
			tr.Prewarm(src, p)
		}
	}
}

func registerTranscodeMetrics(reg prometheus.Registerer, tr *media.Transcoder) {
	hits := prometheus.NewCounter(prometheus.CounterOpts{Name: "syncmusic_transcode_cache_hits_total", Help: "Transcode cache hits."})
	runs := prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name: "syncmusic_transcode_duration_seconds", Help: "ffmpeg transcode duration.",
		Buckets: []float64{0.5, 1, 2, 5, 10, 30, 60, 120},
	}, []string{"result"})
	size := prometheus.NewGaugeFunc(prometheus.GaugeOpts{Name: "syncmusic_transcode_cache_bytes", Help: "Transcode cache size."},
		func() float64 { return float64(tr.CacheSize()) })
	reg.MustRegister(hits, runs, size)
	tr.OnHit = hits.Inc
	tr.OnMiss = func(d time.Duration, err error) {
		result := "ok"
		if err != nil {
			result = "error"
		}
		runs.WithLabelValues(result).Observe(d.Seconds())
	}
}
