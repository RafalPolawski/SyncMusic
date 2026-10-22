// Package config loads SyncMusic runtime configuration from environment
// variables. Every option has a sensible default so a bare `syncmusic`
// invocation (or `docker run` with two volumes) just works.
package config

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Config holds all runtime options.
type Config struct {
	// Listen is the TCP address of the HTTP server.
	Listen string
	// MusicDir is the root of the music library (read-only access is enough).
	MusicDir string
	// DataDir holds the database, transcode cache and generated secrets.
	DataDir string

	// Password protects the whole server. Empty disables authentication.
	Password string
	// SessionSecret signs session cookies. Generated and persisted when empty.
	SessionSecret string
	// SessionTTL is how long a login stays valid.
	SessionTTL time.Duration
	// CookieSecure controls the Secure cookie flag: "auto", "true" or "false".
	CookieSecure string
	// TrustProxy makes the server trust X-Forwarded-For / X-Forwarded-Proto.
	TrustProxy bool
	// AllowedOrigins lists extra WebSocket origins (host patterns such as
	// "localhost:5173"); same-origin connections are always allowed.
	AllowedOrigins []string

	// ScanInterval is the period of incremental library rescans (0 disables).
	ScanInterval time.Duration
	// ScanWorkers is the number of files probed in parallel.
	ScanWorkers int

	// FFmpegPath and FFprobePath locate the media tools.
	FFmpegPath  string
	FFprobePath string
	// Transcode enables on-the-fly transcoding to smaller formats.
	Transcode bool
	// TranscodeCacheSize caps the on-disk transcode cache (bytes).
	TranscodeCacheSize int64
	// TranscodeWorkers limits concurrent ffmpeg processes.
	TranscodeWorkers int

	// StartDelay is the lead time given to all clients before a newly
	// selected track starts, so everybody starts at the same instant.
	StartDelay time.Duration
	// ResumeDelay is the lead time used for play/seek commands.
	ResumeDelay time.Duration
	// WaitForAllMax caps how long a room waits for slow clients to buffer
	// a newly selected track when "wait for everyone" is enabled.
	WaitForAllMax time.Duration
	// RoomIdleTimeout pauses and unloads rooms nobody joined for that long.
	RoomIdleTimeout time.Duration

	// LogLevel is one of debug, info, warn, error. LogFormat is text or json.
	LogLevel  string
	LogFormat string
	// Metrics exposes Prometheus metrics at /metrics.
	Metrics bool
}

// Default returns the configuration used when no variables are set.
func Default() Config {
	workers := runtime.NumCPU() / 2
	if workers < 1 {
		workers = 1
	}
	return Config{
		Listen:             ":8080",
		MusicDir:           "/music",
		DataDir:            "/data",
		SessionTTL:         180 * 24 * time.Hour,
		CookieSecure:       "auto",
		ScanInterval:       15 * time.Minute,
		ScanWorkers:        runtime.NumCPU(),
		FFmpegPath:         "ffmpeg",
		FFprobePath:        "ffprobe",
		Transcode:          true,
		TranscodeCacheSize: 4 << 30,
		TranscodeWorkers:   workers,
		StartDelay:         1500 * time.Millisecond,
		ResumeDelay:        400 * time.Millisecond,
		WaitForAllMax:      10 * time.Second,
		RoomIdleTimeout:    12 * time.Hour,
		LogLevel:           "info",
		LogFormat:          "text",
		Metrics:            true,
	}
}

// Getenv abstracts os.Getenv for tests.
type Getenv func(string) string

// Load reads the configuration from the environment.
func Load(getenv Getenv) (Config, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	c := Default()
	p := parser{getenv: getenv}

	c.Listen = p.str("SYNCMUSIC_LISTEN", c.Listen)
	if port := getenv("PORT"); port != "" && getenv("SYNCMUSIC_LISTEN") == "" {
		c.Listen = ":" + port
	}
	c.MusicDir = p.str("SYNCMUSIC_MUSIC_DIR", c.MusicDir)
	c.DataDir = p.str("SYNCMUSIC_DATA_DIR", c.DataDir)
	c.Password = p.secret("SYNCMUSIC_PASSWORD", "")
	c.SessionSecret = p.secret("SYNCMUSIC_SESSION_SECRET", "")
	c.SessionTTL = p.duration("SYNCMUSIC_SESSION_TTL", c.SessionTTL)
	c.CookieSecure = strings.ToLower(p.str("SYNCMUSIC_COOKIE_SECURE", c.CookieSecure))
	c.TrustProxy = p.boolean("SYNCMUSIC_TRUST_PROXY", c.TrustProxy)
	c.AllowedOrigins = p.list("SYNCMUSIC_ALLOWED_ORIGINS")
	c.ScanInterval = p.duration("SYNCMUSIC_SCAN_INTERVAL", c.ScanInterval)
	c.ScanWorkers = p.integer("SYNCMUSIC_SCAN_WORKERS", c.ScanWorkers)
	c.FFmpegPath = p.str("SYNCMUSIC_FFMPEG", c.FFmpegPath)
	c.FFprobePath = p.str("SYNCMUSIC_FFPROBE", c.FFprobePath)
	c.Transcode = p.boolean("SYNCMUSIC_TRANSCODE", c.Transcode)
	c.TranscodeCacheSize = p.size("SYNCMUSIC_TRANSCODE_CACHE_SIZE", c.TranscodeCacheSize)
	c.TranscodeWorkers = p.integer("SYNCMUSIC_TRANSCODE_WORKERS", c.TranscodeWorkers)
	c.StartDelay = p.duration("SYNCMUSIC_START_DELAY", c.StartDelay)
	c.ResumeDelay = p.duration("SYNCMUSIC_RESUME_DELAY", c.ResumeDelay)
	c.WaitForAllMax = p.duration("SYNCMUSIC_WAIT_FOR_ALL_MAX", c.WaitForAllMax)
	c.RoomIdleTimeout = p.duration("SYNCMUSIC_ROOM_IDLE_TIMEOUT", c.RoomIdleTimeout)
	c.LogLevel = strings.ToLower(p.str("SYNCMUSIC_LOG_LEVEL", c.LogLevel))
	c.LogFormat = strings.ToLower(p.str("SYNCMUSIC_LOG_FORMAT", c.LogFormat))
	c.Metrics = p.boolean("SYNCMUSIC_METRICS", c.Metrics)

	if len(p.errs) > 0 {
		return c, errors.Join(p.errs...)
	}
	return c, c.Validate()
}

// Validate checks option ranges.
func (c Config) Validate() error {
	var errs []error
	if c.MusicDir == "" {
		errs = append(errs, errors.New("SYNCMUSIC_MUSIC_DIR must not be empty"))
	}
	if c.DataDir == "" {
		errs = append(errs, errors.New("SYNCMUSIC_DATA_DIR must not be empty"))
	}
	if c.ScanWorkers < 1 {
		errs = append(errs, errors.New("SYNCMUSIC_SCAN_WORKERS must be >= 1"))
	}
	if c.TranscodeWorkers < 1 {
		errs = append(errs, errors.New("SYNCMUSIC_TRANSCODE_WORKERS must be >= 1"))
	}
	if c.TranscodeCacheSize < 0 {
		errs = append(errs, errors.New("SYNCMUSIC_TRANSCODE_CACHE_SIZE must be >= 0"))
	}
	if c.SessionTTL < time.Minute {
		errs = append(errs, errors.New("SYNCMUSIC_SESSION_TTL must be at least 1m"))
	}
	if c.StartDelay < 0 || c.StartDelay > 30*time.Second {
		errs = append(errs, errors.New("SYNCMUSIC_START_DELAY must be between 0 and 30s"))
	}
	if c.ResumeDelay < 0 || c.ResumeDelay > 10*time.Second {
		errs = append(errs, errors.New("SYNCMUSIC_RESUME_DELAY must be between 0 and 10s"))
	}
	if c.WaitForAllMax < 0 || c.WaitForAllMax > 2*time.Minute {
		errs = append(errs, errors.New("SYNCMUSIC_WAIT_FOR_ALL_MAX must be between 0 and 2m"))
	}
	switch c.CookieSecure {
	case "auto", "true", "false":
	default:
		errs = append(errs, fmt.Errorf("SYNCMUSIC_COOKIE_SECURE must be auto, true or false, got %q", c.CookieSecure))
	}
	switch c.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		errs = append(errs, fmt.Errorf("SYNCMUSIC_LOG_LEVEL must be debug, info, warn or error, got %q", c.LogLevel))
	}
	switch c.LogFormat {
	case "text", "json":
	default:
		errs = append(errs, fmt.Errorf("SYNCMUSIC_LOG_FORMAT must be text or json, got %q", c.LogFormat))
	}
	return errors.Join(errs...)
}

type parser struct {
	getenv Getenv
	errs   []error
}

func (p *parser) str(key, def string) string {
	if v := strings.TrimSpace(p.getenv(key)); v != "" {
		return v
	}
	return def
}

// secret reads KEY or, when KEY_FILE is set, the trimmed content of that file
// (Docker/Kubernetes secrets convention).
func (p *parser) secret(key, def string) string {
	if path := strings.TrimSpace(p.getenv(key + "_FILE")); path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			p.errs = append(p.errs, fmt.Errorf("%s_FILE: %w", key, err))
			return def
		}
		return strings.TrimRight(string(b), "\r\n")
	}
	if v := p.getenv(key); v != "" {
		return v
	}
	return def
}

func (p *parser) list(key string) []string {
	var out []string
	for _, v := range strings.Split(p.getenv(key), ",") {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func (p *parser) boolean(key string, def bool) bool {
	v := strings.TrimSpace(p.getenv(key))
	if v == "" {
		return def
	}
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	p.errs = append(p.errs, fmt.Errorf("%s: invalid boolean %q", key, v))
	return def
}

func (p *parser) integer(key string, def int) int {
	v := strings.TrimSpace(p.getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		p.errs = append(p.errs, fmt.Errorf("%s: invalid integer %q", key, v))
		return def
	}
	return n
}

func (p *parser) duration(key string, def time.Duration) time.Duration {
	v := strings.TrimSpace(p.getenv(key))
	if v == "" {
		return def
	}
	d, err := ParseDuration(v)
	if err != nil {
		p.errs = append(p.errs, fmt.Errorf("%s: %w", key, err))
		return def
	}
	return d
}

func (p *parser) size(key string, def int64) int64 {
	v := strings.TrimSpace(p.getenv(key))
	if v == "" {
		return def
	}
	n, err := ParseSize(v)
	if err != nil {
		p.errs = append(p.errs, fmt.Errorf("%s: %w", key, err))
		return def
	}
	return n
}

// ParseDuration extends time.ParseDuration with a "d" (day) unit and plain
// integers interpreted as seconds.
func ParseDuration(s string) (time.Duration, error) {
	s = strings.TrimSpace(s)
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		return time.Duration(n) * time.Second, nil
	}
	if strings.HasSuffix(s, "d") {
		n, err := strconv.ParseFloat(strings.TrimSuffix(s, "d"), 64)
		if err != nil {
			return 0, fmt.Errorf("invalid duration %q", s)
		}
		return time.Duration(n * float64(24*time.Hour)), nil
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, fmt.Errorf("invalid duration %q", s)
	}
	return d, nil
}

// ParseSize parses human readable sizes such as "512MB", "4GiB" or "1048576".
// Decimal (KB, MB, GB, TB) and binary (KiB, MiB, GiB, TiB) units are accepted.
func ParseSize(s string) (int64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, errors.New("empty size")
	}
	i := len(s)
	for i > 0 && (s[i-1] < '0' || s[i-1] > '9') && s[i-1] != '.' {
		i--
	}
	num, unit := strings.TrimSpace(s[:i]), strings.ToLower(strings.TrimSpace(s[i:]))
	f, err := strconv.ParseFloat(num, 64)
	if err != nil || f < 0 {
		return 0, fmt.Errorf("invalid size %q", s)
	}
	mult := map[string]float64{
		"": 1, "b": 1,
		"k": 1e3, "kb": 1e3, "m": 1e6, "mb": 1e6, "g": 1e9, "gb": 1e9, "t": 1e12, "tb": 1e12,
		"kib": 1 << 10, "mib": 1 << 20, "gib": 1 << 30, "tib": 1 << 40,
	}
	m, ok := mult[unit]
	if !ok {
		return 0, fmt.Errorf("invalid size unit in %q", s)
	}
	return int64(f * m), nil
}
