package media

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

// Transcoder converts audio files with ffmpeg and keeps the results in a
// size-bounded on-disk LRU cache. Concurrent requests for the same output
// share one ffmpeg process.
type Transcoder struct {
	ffmpeg   string
	dir      string
	maxBytes int64
	timeout  time.Duration
	log      *slog.Logger
	now      func() time.Time

	sem     chan struct{}
	group   singleflight.Group
	prewarm chan prewarmJob

	mu      sync.Mutex
	entries map[string]*cacheEntry // file name -> entry
	total   int64

	// Metrics hooks (optional).
	OnHit  func()
	OnMiss func(d time.Duration, err error)
}

type cacheEntry struct {
	size       int64
	lastAccess time.Time
}

type prewarmJob struct {
	src Source
	p   Profile
}

// TranscoderOptions configures a Transcoder.
type TranscoderOptions struct {
	FFmpegPath string
	CacheDir   string
	MaxBytes   int64 // 0 means unbounded
	Workers    int
	Timeout    time.Duration
	Logger     *slog.Logger
}

const tmpMarker = ".tmp-"

// NewTranscoder prepares the cache directory and indexes existing entries.
func NewTranscoder(opts TranscoderOptions) (*Transcoder, error) {
	if opts.Workers < 1 {
		opts.Workers = 1
	}
	if opts.Timeout == 0 {
		opts.Timeout = 15 * time.Minute
	}
	if opts.FFmpegPath == "" {
		opts.FFmpegPath = "ffmpeg"
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if err := os.MkdirAll(opts.CacheDir, 0o755); err != nil {
		return nil, fmt.Errorf("create transcode cache: %w", err)
	}
	t := &Transcoder{
		ffmpeg:   opts.FFmpegPath,
		dir:      opts.CacheDir,
		maxBytes: opts.MaxBytes,
		timeout:  opts.Timeout,
		log:      opts.Logger,
		now:      time.Now,
		sem:      make(chan struct{}, opts.Workers),
		prewarm:  make(chan prewarmJob, 64),
		entries:  map[string]*cacheEntry{},
	}
	if err := t.index(); err != nil {
		return nil, err
	}
	return t, nil
}

func (t *Transcoder) index() error {
	des, err := os.ReadDir(t.dir)
	if err != nil {
		return err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, de := range des {
		if de.IsDir() {
			continue
		}
		name := de.Name()
		if strings.Contains(name, tmpMarker) {
			_ = os.Remove(filepath.Join(t.dir, name)) // leftover from a crash
			continue
		}
		fi, err := de.Info()
		if err != nil {
			continue
		}
		t.entries[name] = &cacheEntry{size: fi.Size(), lastAccess: fi.ModTime()}
		t.total += fi.Size()
	}
	t.evictLocked("")
	return nil
}

// CacheSize returns the current total size of cached files.
func (t *Transcoder) CacheSize() int64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.total
}

// FileName returns the cache file name for a source/profile pair. It changes
// whenever the source file changes, so stale outputs are never served.
func FileName(src Source, p Profile) string {
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%d\x00%d\x00%s", src.Path, src.Size, src.MtimeNs, p.Name)
	return src.TrackID + "." + p.Name + "." + hex.EncodeToString(h.Sum(nil))[:12] + p.Ext
}

// Get returns the path of the transcoded file, creating it when needed.
// The caller's context only bounds how long it waits: an ffmpeg run that
// already started keeps going so the result can serve the next request.
func (t *Transcoder) Get(ctx context.Context, src Source, p Profile) (string, error) {
	name := FileName(src, p)
	if path, ok := t.lookup(name); ok {
		if t.OnHit != nil {
			t.OnHit()
		}
		return path, nil
	}
	ch := t.group.DoChan(name, func() (any, error) {
		if path, ok := t.lookup(name); ok {
			return path, nil
		}
		start := t.now()
		path, err := t.run(src, p, name)
		if t.OnMiss != nil {
			t.OnMiss(t.now().Sub(start), err)
		}
		return path, err
	})
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case res := <-ch:
		if res.Err != nil {
			return "", res.Err
		}
		return res.Val.(string), nil
	}
}

// Prewarm schedules a background transcode with low priority. It never blocks;
// when the queue is full the request is dropped.
func (t *Transcoder) Prewarm(src Source, p Profile) {
	if _, ok := t.lookup(FileName(src, p)); ok {
		return
	}
	select {
	case t.prewarm <- prewarmJob{src: src, p: p}:
	default:
	}
}

// RunPrewarmer processes prewarm requests one at a time until ctx ends.
func (t *Transcoder) RunPrewarmer(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-t.prewarm:
			if _, err := t.Get(ctx, job.src, job.p); err != nil && ctx.Err() == nil {
				t.log.Warn("prewarm transcode failed", "track", job.src.TrackID, "profile", job.p.Name, "err", err)
			}
		}
	}
}

func (t *Transcoder) lookup(name string) (string, bool) {
	t.mu.Lock()
	e, ok := t.entries[name]
	if ok {
		e.lastAccess = t.now()
	}
	t.mu.Unlock()
	if !ok {
		return "", false
	}
	path := filepath.Join(t.dir, name)
	if _, err := os.Stat(path); err != nil {
		// Removed behind our back.
		t.mu.Lock()
		if e, ok := t.entries[name]; ok {
			t.total -= e.size
			delete(t.entries, name)
		}
		t.mu.Unlock()
		return "", false
	}
	now := t.now()
	_ = os.Chtimes(path, now, now) // persist LRU order across restarts
	return path, true
}

func (t *Transcoder) run(src Source, p Profile, name string) (string, error) {
	t.sem <- struct{}{}
	defer func() { <-t.sem }()

	ctx, cancel := context.WithTimeout(context.Background(), t.timeout)
	defer cancel()

	final := filepath.Join(t.dir, name)
	tmp := final + tmpMarker + strconv.FormatInt(t.now().UnixNano(), 36)
	args := ffmpegArgs(src, p, tmp)
	cmd := exec.CommandContext(ctx, t.ffmpeg, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		_ = os.Remove(tmp)
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 500 {
			msg = msg[len(msg)-500:]
		}
		return "", fmt.Errorf("ffmpeg %s -> %s: %w: %s", src.Path, p.Name, err, msg)
	}
	fi, err := os.Stat(tmp)
	if err != nil {
		return "", err
	}
	if fi.Size() == 0 {
		_ = os.Remove(tmp)
		return "", errors.New("ffmpeg produced an empty file")
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}

	t.mu.Lock()
	if old, ok := t.entries[name]; ok {
		t.total -= old.size
	}
	t.entries[name] = &cacheEntry{size: fi.Size(), lastAccess: t.now()}
	t.total += fi.Size()
	t.removeStaleVariantsLocked(src, p, name)
	t.evictLocked(name)
	t.mu.Unlock()
	return final, nil
}

func ffmpegArgs(src Source, p Profile, out string) []string {
	args := []string{"-nostdin", "-hide_banner", "-v", "error", "-y", "-i", src.Path,
		"-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1"}
	if src.Channels > 2 || src.Channels == 0 {
		args = append(args, "-ac", "2")
	}
	kbps := strconv.Itoa(p.Bitrate/1000) + "k"
	switch p.Format {
	case FormatAAC:
		args = append(args, "-c:a", "aac", "-b:a", kbps, "-movflags", "+faststart", "-f", "ipod")
	default:
		args = append(args, "-c:a", "libopus", "-b:a", kbps, "-vbr", "on", "-application", "audio",
			"-ar", "48000", "-f", "ogg")
	}
	return append(args, out)
}

// removeStaleVariantsLocked drops cached outputs produced from an older
// version of the same source file.
func (t *Transcoder) removeStaleVariantsLocked(src Source, p Profile, keep string) {
	prefix := src.TrackID + "." + p.Name + "."
	for name, e := range t.entries {
		if name != keep && strings.HasPrefix(name, prefix) {
			if err := os.Remove(filepath.Join(t.dir, name)); err == nil || os.IsNotExist(err) {
				t.total -= e.size
				delete(t.entries, name)
			}
		}
	}
}

// evictLocked removes least recently used files until the cache fits. The
// entry named keep is never evicted.
func (t *Transcoder) evictLocked(keep string) {
	if t.maxBytes <= 0 || t.total <= t.maxBytes {
		return
	}
	names := make([]string, 0, len(t.entries))
	for name := range t.entries {
		if name != keep {
			names = append(names, name)
		}
	}
	sort.Slice(names, func(i, j int) bool {
		return t.entries[names[i]].lastAccess.Before(t.entries[names[j]].lastAccess)
	})
	for _, name := range names {
		if t.total <= t.maxBytes {
			return
		}
		e := t.entries[name]
		if err := os.Remove(filepath.Join(t.dir, name)); err != nil && !os.IsNotExist(err) {
			t.log.Warn("evict transcode cache entry", "file", name, "err", err)
			continue
		}
		t.total -= e.size
		delete(t.entries, name)
	}
}
