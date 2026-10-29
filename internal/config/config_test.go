package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) Getenv {
	return func(k string) string { return m[k] }
}

func TestLoadDefaults(t *testing.T) {
	c, err := Load(env(nil))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	d := Default()
	if c.Listen != d.Listen || c.MusicDir != "/music" || c.DataDir != "/data" {
		t.Fatalf("unexpected defaults: %+v", c)
	}
	if c.Password != "" {
		t.Fatalf("password should default to empty")
	}
	if !c.Transcode || c.TranscodeCacheSize != 4<<30 {
		t.Fatalf("transcode defaults wrong: %+v", c)
	}
}

func TestLoadOverrides(t *testing.T) {
	c, err := Load(env(map[string]string{
		"SYNCMUSIC_LISTEN":               "127.0.0.1:9000",
		"SYNCMUSIC_MUSIC_DIR":            "/srv/music",
		"SYNCMUSIC_PASSWORD":             "hunter2",
		"SYNCMUSIC_SCAN_INTERVAL":        "0",
		"SYNCMUSIC_TRANSCODE":            "off",
		"SYNCMUSIC_TRANSCODE_CACHE_SIZE": "512MiB",
		"SYNCMUSIC_SESSION_TTL":          "30d",
		"SYNCMUSIC_START_DELAY":          "2s",
		"SYNCMUSIC_LOG_FORMAT":           "JSON",
		"SYNCMUSIC_ALLOWED_ORIGINS":      "localhost:5173, *.example.com ,",
	}))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.Listen != "127.0.0.1:9000" || c.MusicDir != "/srv/music" || c.Password != "hunter2" {
		t.Fatalf("overrides not applied: %+v", c)
	}
	if c.ScanInterval != 0 || c.Transcode || c.TranscodeCacheSize != 512<<20 {
		t.Fatalf("overrides not applied: %+v", c)
	}
	if len(c.AllowedOrigins) != 2 || c.AllowedOrigins[1] != "*.example.com" {
		t.Fatalf("allowed origins: %q", c.AllowedOrigins)
	}
	if c.SessionTTL != 30*24*time.Hour || c.StartDelay != 2*time.Second || c.LogFormat != "json" {
		t.Fatalf("overrides not applied: %+v", c)
	}
}

func TestPortFallback(t *testing.T) {
	c, err := Load(env(map[string]string{"PORT": "1234"}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Listen != ":1234" {
		t.Fatalf("PORT not honoured: %q", c.Listen)
	}
}

func TestPasswordFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pw")
	if err := os.WriteFile(path, []byte("s3cret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := Load(env(map[string]string{"SYNCMUSIC_PASSWORD_FILE": path, "SYNCMUSIC_PASSWORD": "ignored"}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Password != "s3cret" {
		t.Fatalf("password file not read: %q", c.Password)
	}

	_, err = Load(env(map[string]string{"SYNCMUSIC_PASSWORD_FILE": filepath.Join(t.TempDir(), "missing")}))
	if err == nil {
		t.Fatal("expected error for missing password file")
	}
}

func TestLoadErrors(t *testing.T) {
	_, err := Load(env(map[string]string{
		"SYNCMUSIC_TRANSCODE":     "maybe",
		"SYNCMUSIC_SCAN_WORKERS":  "many",
		"SYNCMUSIC_START_DELAY":   "soon",
		"SYNCMUSIC_LOG_LEVEL":     "verbose",
		"SYNCMUSIC_COOKIE_SECURE": "sometimes",
	}))
	if err == nil {
		t.Fatal("expected errors")
	}
	for _, want := range []string{"SYNCMUSIC_TRANSCODE", "SYNCMUSIC_SCAN_WORKERS", "SYNCMUSIC_START_DELAY"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %s", err, want)
		}
	}
}

func TestValidate(t *testing.T) {
	c := Default()
	c.LogLevel = "trace"
	c.CookieSecure = "maybe"
	c.TranscodeWorkers = 0
	c.StartDelay = time.Hour
	err := c.Validate()
	if err == nil {
		t.Fatal("expected validation error")
	}
	for _, want := range []string{"LOG_LEVEL", "COOKIE_SECURE", "TRANSCODE_WORKERS", "START_DELAY"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %s", err, want)
		}
	}
}

func TestParseSize(t *testing.T) {
	cases := map[string]int64{
		"0":       0,
		"1024":    1024,
		"10KB":    10_000,
		"1.5GB":   1_500_000_000,
		"2GiB":    2 << 30,
		"512 MiB": 512 << 20,
		"3mb":     3_000_000,
	}
	for in, want := range cases {
		got, err := ParseSize(in)
		if err != nil || got != want {
			t.Errorf("ParseSize(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "GB", "-1GB", "12XB"} {
		if _, err := ParseSize(bad); err == nil {
			t.Errorf("ParseSize(%q) should fail", bad)
		}
	}
}

func TestParseDuration(t *testing.T) {
	cases := map[string]time.Duration{
		"30":   30 * time.Second,
		"1.5s": 1500 * time.Millisecond,
		"2d":   48 * time.Hour,
		"15m":  15 * time.Minute,
	}
	for in, want := range cases {
		got, err := ParseDuration(in)
		if err != nil || got != want {
			t.Errorf("ParseDuration(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "xd", "fast"} {
		if _, err := ParseDuration(bad); err == nil {
			t.Errorf("ParseDuration(%q) should fail", bad)
		}
	}
}
