package app

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/RafalPolawski/SyncMusic/internal/config"
	"github.com/RafalPolawski/SyncMusic/internal/testutil"
)

func TestRunServesAndShutsDownGracefully(t *testing.T) {
	music := t.TempDir()
	testutil.Generate(t, music, testutil.Spec{Path: "Gym/a.mp3", Seconds: 1})
	cfg := config.Default()
	cfg.MusicDir = music
	cfg.DataDir = filepath.Join(t.TempDir(), "data")
	cfg.ScanInterval = 0
	cfg.Metrics = true

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	ready := make(chan string, 1)
	go func() {
		done <- Run(ctx, cfg, slog.New(slog.DiscardHandler), Options{Listener: ln, OnReady: func(a string) { ready <- a }})
	}()
	var addr string
	select {
	case addr = <-ready:
	case err := <-done:
		t.Fatalf("Run exited early: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("server did not start")
	}
	base := "http://" + addr

	get := func(path string) (int, []byte) {
		resp, err := http.Get(base + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, b
	}
	if code, _ := get("/healthz"); code != 200 {
		t.Fatalf("healthz %d", code)
	}
	if code, body := get("/metrics"); code != 200 || len(body) == 0 {
		t.Fatalf("metrics %d", code)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		_, body := get("/api/library")
		var lib struct{ Tracks []any }
		_ = json.Unmarshal(body, &lib)
		if len(lib.Tracks) == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("initial scan did not finish: %s", body)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if _, err := os.Stat(filepath.Join(cfg.DataDir, "session.key")); err != nil {
		t.Fatalf("session key not created: %v", err)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run returned %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("shutdown timed out")
	}
}

func TestRunValidatesEnvironment(t *testing.T) {
	cfg := config.Default()
	cfg.MusicDir = filepath.Join(t.TempDir(), "missing")
	cfg.DataDir = t.TempDir()
	if err := Run(context.Background(), cfg, slog.New(slog.DiscardHandler), Options{}); err == nil {
		t.Fatal("missing music dir must fail")
	}
	cfg.MusicDir = t.TempDir()
	cfg.FFprobePath = "definitely-not-ffprobe"
	if err := Run(context.Background(), cfg, slog.New(slog.DiscardHandler), Options{}); err == nil {
		t.Fatal("missing ffprobe must fail")
	}
}

func TestNewLogger(t *testing.T) {
	cfg := config.Default()
	cfg.LogFormat = "json"
	cfg.LogLevel = "debug"
	if l := NewLogger(cfg, os.Stderr); !l.Enabled(context.Background(), slog.LevelDebug) {
		t.Fatal("debug level not applied")
	}
}
