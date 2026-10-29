// Package library indexes the music directory: it walks the tree, probes new
// or changed files, persists the result and exposes immutable snapshots.
package library

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/RafalPolawski/SyncMusic/internal/media"
	"github.com/RafalPolawski/SyncMusic/internal/store"
)

// Status describes the scanner state.
type Status struct {
	Scanning   bool      `json:"scanning"`
	Processed  int       `json:"processed"`
	Total      int       `json:"total"`
	LastScanAt time.Time `json:"lastScanAt,omitzero"`
	LastError  string    `json:"lastError,omitempty"`
	Tracks     int       `json:"tracks"`
}

// ScanResult summarises a finished scan.
type ScanResult struct {
	Added, Updated, Removed, Unchanged, Failed int
	Duration                                   time.Duration
	VersionChanged                             bool
}

// Library owns the index of one music directory.
type Library struct {
	root    string
	db      *store.DB
	prober  media.Prober
	workers int
	log     *slog.Logger
	now     func() time.Time

	snap   atomic.Pointer[Snapshot]
	scanMu sync.Mutex

	statusMu sync.Mutex
	status   Status

	// failed remembers files that could not be probed (keyed by path with
	// size/mtime) so they are not retried on every scan.
	failedMu sync.Mutex
	failed   map[string]fileSig

	listenersMu sync.Mutex
	listeners   []func(*Snapshot)
}

type fileSig struct {
	size    int64
	mtimeNs int64
}

// Options configures a Library.
type Options struct {
	Root    string
	DB      *store.DB
	Prober  media.Prober
	Workers int
	Logger  *slog.Logger
}

// New creates a library. Call Load to read the persisted index.
func New(opts Options) *Library {
	if opts.Workers < 1 {
		opts.Workers = 4
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	l := &Library{
		root:    opts.Root,
		db:      opts.DB,
		prober:  opts.Prober,
		workers: opts.Workers,
		log:     opts.Logger,
		now:     time.Now,
		failed:  map[string]fileSig{},
	}
	l.snap.Store(buildSnapshot(nil, nil, nil))
	return l
}

// Root returns the absolute music directory.
func (l *Library) Root() string { return l.root }

// Snapshot returns the current library view.
func (l *Library) Snapshot() *Snapshot { return l.snap.Load() }

// Status returns the scanner status.
func (l *Library) Status() Status {
	l.statusMu.Lock()
	defer l.statusMu.Unlock()
	st := l.status
	st.Tracks = len(l.Snapshot().Tracks)
	return st
}

// OnChange registers a callback invoked (synchronously) whenever a scan
// produces a snapshot with a new version.
func (l *Library) OnChange(fn func(*Snapshot)) {
	l.listenersMu.Lock()
	defer l.listenersMu.Unlock()
	l.listeners = append(l.listeners, fn)
}

const folderImagesKey = "library.folder_images"

// Load builds a snapshot from the database without touching the file system.
func (l *Library) Load(ctx context.Context) error {
	tracks, err := l.db.ListTracks(ctx)
	if err != nil {
		return fmt.Errorf("load tracks: %w", err)
	}
	playlists, err := l.db.ListPlaylists(ctx)
	if err != nil {
		return fmt.Errorf("load playlists: %w", err)
	}
	images := map[string]string{}
	if raw, err := l.db.GetKV(ctx, folderImagesKey); err == nil {
		_ = json.Unmarshal([]byte(raw), &images)
	}
	l.snap.Store(buildSnapshot(tracks, playlists, images))
	return nil
}

// AbsPath resolves a library-relative path to an absolute one, refusing any
// path that escapes the music directory.
func (l *Library) AbsPath(rel string) (string, error) {
	clean := path.Clean("/" + NormalizePath(rel))
	if clean == "/" {
		return "", errors.New("empty path")
	}
	abs := filepath.Join(l.root, filepath.FromSlash(clean[1:]))
	if !strings.HasPrefix(abs, filepath.Clean(l.root)+string(filepath.Separator)) {
		return "", errors.New("path escapes library")
	}
	return abs, nil
}

type walkedFile struct {
	rel     string
	abs     string
	size    int64
	mtimeNs int64
}

// ErrScanInProgress is returned by TryScan when another scan is running.
var ErrScanInProgress = errors.New("scan already in progress")

// TryScan starts a scan unless one is already running.
func (l *Library) TryScan(ctx context.Context) (ScanResult, error) {
	if !l.scanMu.TryLock() {
		return ScanResult{}, ErrScanInProgress
	}
	defer l.scanMu.Unlock()
	return l.scan(ctx)
}

// Scan performs an incremental scan, waiting for a running one to finish first.
func (l *Library) Scan(ctx context.Context) (ScanResult, error) {
	l.scanMu.Lock()
	defer l.scanMu.Unlock()
	return l.scan(ctx)
}

func (l *Library) scan(ctx context.Context) (res ScanResult, err error) {
	start := l.now()
	l.setStatus(func(s *Status) { *s = Status{Scanning: true, LastScanAt: s.LastScanAt} })
	defer func() {
		res.Duration = l.now().Sub(start)
		l.setStatus(func(s *Status) {
			s.Scanning = false
			s.LastScanAt = l.now()
			s.LastError = ""
			if err != nil {
				s.LastError = err.Error()
			}
		})
	}()

	audio, playlistFiles, images, err := l.walk(ctx)
	if err != nil {
		return res, err
	}
	l.setStatus(func(s *Status) { s.Total = len(audio) })

	existing, err := l.db.ListTracks(ctx)
	if err != nil {
		return res, fmt.Errorf("load tracks: %w", err)
	}
	byPath := make(map[string]store.Track, len(existing))
	for _, t := range existing {
		byPath[t.Path] = t
	}

	var toProbe []walkedFile
	seen := make(map[string]bool, len(audio))
	for _, f := range audio {
		seen[f.rel] = true
		if old, ok := byPath[f.rel]; ok && old.Size == f.size && old.MtimeNs == f.mtimeNs {
			res.Unchanged++
			continue
		}
		if l.knownFailure(f) {
			res.Failed++
			continue
		}
		toProbe = append(toProbe, f)
	}
	l.setStatus(func(s *Status) { s.Processed = res.Unchanged + res.Failed })

	upserts, failed := l.probeAll(ctx, toProbe)
	if err := ctx.Err(); err != nil {
		return res, err
	}
	res.Failed += failed
	for _, t := range upserts {
		if _, ok := byPath[t.Path]; ok {
			res.Updated++
		} else {
			res.Added++
		}
	}
	var deletes []string
	for p, t := range byPath {
		if !seen[p] {
			deletes = append(deletes, t.ID)
		}
	}
	res.Removed = len(deletes)
	if err := l.db.ApplyTrackChanges(ctx, upserts, deletes); err != nil {
		return res, fmt.Errorf("save tracks: %w", err)
	}

	pls := l.readPlaylists(playlistFiles)
	if err := l.db.ReplacePlaylists(ctx, pls); err != nil {
		return res, fmt.Errorf("save playlists: %w", err)
	}
	if raw, err := json.Marshal(images); err == nil {
		if err := l.db.SetKV(ctx, folderImagesKey, string(raw)); err != nil {
			return res, fmt.Errorf("save folder images: %w", err)
		}
	}

	old := l.Snapshot()
	if err := l.Load(ctx); err != nil {
		return res, err
	}
	snap := l.Snapshot()
	res.VersionChanged = snap.Version != old.Version
	l.log.Info("library scan finished",
		"tracks", len(snap.Tracks), "added", res.Added, "updated", res.Updated, "removed", res.Removed,
		"failed", res.Failed, "duration", l.now().Sub(start).Round(time.Millisecond))
	if res.VersionChanged {
		l.listenersMu.Lock()
		listeners := append([]func(*Snapshot){}, l.listeners...)
		l.listenersMu.Unlock()
		for _, fn := range listeners {
			fn(snap)
		}
	}
	return res, nil
}

func (l *Library) walk(ctx context.Context) (audio, playlists []walkedFile, images map[string]string, err error) {
	images = map[string]string{}
	imageRank := map[string]int{}
	root := filepath.Clean(l.root)
	if fi, err := os.Stat(root); err != nil {
		return nil, nil, nil, fmt.Errorf("music directory: %w", err)
	} else if !fi.IsDir() {
		return nil, nil, nil, fmt.Errorf("music directory %s is not a directory", root)
	}
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if walkErr != nil {
			l.log.Warn("cannot read path during scan", "path", p, "err", walkErr)
			if d != nil && d.IsDir() && p != root {
				return fs.SkipDir
			}
			return nil
		}
		name := d.Name()
		if d.IsDir() {
			if p != root && skipDir(name) {
				return fs.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(name, ".") {
			return nil // hidden files, macOS "._" resource forks
		}
		relOS, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		rel := NormalizePath(filepath.ToSlash(relOS))
		ext := strings.ToLower(filepath.Ext(name))
		isAudio := media.AudioExtensions[ext]
		isPlaylist := ext == ".m3u" || ext == ".m3u8"
		if isFolderImage(name) {
			dir := path.Dir(rel)
			if dir == "." {
				dir = ""
			}
			rank := folderImageRank(name)
			if cur, ok := imageRank[dir]; !ok || rank < cur {
				imageRank[dir] = rank
				images[dir] = p
			}
			return nil
		}
		if !isAudio && !isPlaylist {
			return nil
		}
		fi, err := os.Stat(p) // follows symlinked files
		if err != nil {
			l.log.Debug("skipping unreadable file", "path", p, "err", err)
			return nil //nolint:nilerr // broken symlinks and unreadable files are skipped, not fatal
		}
		if !fi.Mode().IsRegular() {
			return nil
		}
		wf := walkedFile{rel: rel, abs: p, size: fi.Size(), mtimeNs: fi.ModTime().UnixNano()}
		if isAudio {
			audio = append(audio, wf)
		} else {
			playlists = append(playlists, wf)
		}
		return nil
	})
	return audio, playlists, images, err
}

func (l *Library) probeAll(ctx context.Context, files []walkedFile) (tracks []store.Track, failed int) {
	if len(files) == 0 {
		return nil, 0
	}
	jobs := make(chan walkedFile)
	var mu sync.Mutex
	var wg sync.WaitGroup
	workers := min(l.workers, len(files))
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for f := range jobs {
				t, err := l.probeOne(ctx, f)
				mu.Lock()
				if err != nil {
					failed++
				} else {
					tracks = append(tracks, t)
				}
				mu.Unlock()
				l.setStatus(func(s *Status) { s.Processed++ })
			}
		}()
	}
feed:
	for _, f := range files {
		select {
		case jobs <- f:
		case <-ctx.Done():
			break feed
		}
	}
	close(jobs)
	wg.Wait()
	return tracks, failed
}

func (l *Library) probeOne(ctx context.Context, f walkedFile) (store.Track, error) {
	info, err := l.prober.Probe(ctx, f.abs)
	if err != nil {
		if ctx.Err() == nil {
			l.log.Warn("skipping unreadable audio file", "path", f.rel, "err", err)
			l.failedMu.Lock()
			l.failed[f.rel] = fileSig{f.size, f.mtimeNs}
			l.failedMu.Unlock()
		}
		return store.Track{}, err
	}
	folder := path.Dir(f.rel)
	if folder == "." {
		folder = ""
	}
	t := store.Track{
		ID: TrackID(f.rel), Path: f.rel, Folder: folder,
		Title: info.Title, Artist: info.Artist, Album: info.Album, AlbumArtist: info.AlbumArtist,
		Genre: info.Genre, Year: info.Year, TrackNo: info.TrackNo, DiscNo: info.DiscNo,
		DurationMs: info.DurationMs, Format: info.Format, Codec: info.Codec, Bitrate: info.Bitrate,
		SampleRate: info.SampleRate, Channels: info.Channels, HasCover: info.HasCover,
		Size: f.size, MtimeNs: f.mtimeNs, ScannedAt: l.now().UnixMilli(),
	}
	if t.Title == "" {
		title, artist := guessFromFilename(f.rel)
		t.Title = title
		if t.Artist == "" {
			t.Artist = artist
		}
	}
	return t, nil
}

func (l *Library) knownFailure(f walkedFile) bool {
	l.failedMu.Lock()
	defer l.failedMu.Unlock()
	sig, ok := l.failed[f.rel]
	return ok && sig == fileSig{f.size, f.mtimeNs}
}

func (l *Library) readPlaylists(files []walkedFile) []store.Playlist {
	out := make([]store.Playlist, 0, len(files))
	for _, f := range files {
		data, err := os.ReadFile(f.abs)
		if err != nil {
			l.log.Warn("cannot read playlist", "path", f.rel, "err", err)
			continue
		}
		out = append(out, store.Playlist{
			ID: PlaylistID(f.rel), Path: f.rel, Name: playlistName(f.rel),
			Size: f.size, MtimeNs: f.mtimeNs, TrackPaths: parseM3U(data, f.rel),
		})
	}
	return out
}

func (l *Library) setStatus(fn func(*Status)) {
	l.statusMu.Lock()
	fn(&l.status)
	l.statusMu.Unlock()
}

// RunPeriodic scans immediately and then every interval until ctx ends.
// An interval of zero performs only the initial scan.
func (l *Library) RunPeriodic(ctx context.Context, interval time.Duration) {
	scan := func() {
		if _, err := l.TryScan(ctx); err != nil && !errors.Is(err, ErrScanInProgress) && ctx.Err() == nil {
			l.log.Error("library scan failed", "err", err)
		}
	}
	scan()
	if interval <= 0 {
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			scan()
		}
	}
}
