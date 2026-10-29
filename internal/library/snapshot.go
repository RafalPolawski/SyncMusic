package library

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"path"
	"sort"
	"strings"

	"github.com/RafalPolawski/SyncMusic/internal/store"
)

// Track is a library track.
type Track = store.Track

// Folder groups the tracks of one directory. Top-level folders act as
// playlists; the root folder ("") holds loose tracks.
type Folder struct {
	Path         string   `json:"path"`
	Name         string   `json:"name"`
	Parent       string   `json:"parent"`
	TrackIDs     []string `json:"trackIds"`
	CoverTrackID string   `json:"coverTrackId,omitempty"`
	// Image is the absolute path of a folder image (cover.jpg etc.), if any.
	Image string `json:"-"`
}

// Playlist is an .m3u playlist resolved to track ids.
type Playlist struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Path     string   `json:"path"`
	TrackIDs []string `json:"trackIds"`
}

// Snapshot is an immutable view of the library. It is replaced atomically
// after every scan, so readers never need locks.
type Snapshot struct {
	Version   string
	Tracks    []*Track // sorted in library order (folder, disc, track, file name)
	Folders   []*Folder
	Playlists []*Playlist

	byID     map[string]*Track
	folders  map[string]*Folder
	json     []byte
	jsonGzip []byte
}

// Track looks up a track by id.
func (s *Snapshot) Track(id string) (*Track, bool) {
	t, ok := s.byID[id]
	return t, ok
}

// Folder looks up a folder by relative path.
func (s *Snapshot) Folder(p string) (*Folder, bool) {
	f, ok := s.folders[p]
	return f, ok
}

// FolderImage returns the absolute path of the image file of a folder, if any.
func (s *Snapshot) FolderImage(p string) string {
	if f, ok := s.folders[p]; ok {
		return f.Image
	}
	return ""
}

// Playlist looks up a playlist by id.
func (s *Snapshot) Playlist(id string) (*Playlist, bool) {
	for _, p := range s.Playlists {
		if p.ID == id {
			return p, true
		}
	}
	return nil, false
}

// DurationMs implements the room engine's catalog interface.
func (s *Snapshot) DurationMs(id string) (int64, bool) {
	t, ok := s.byID[id]
	if !ok {
		return 0, false
	}
	return t.DurationMs, true
}

// JSON returns the client representation (and its gzip compressed form).
func (s *Snapshot) JSON() (plain, gzipped []byte) { return s.json, s.jsonGzip }

// ETag returns a strong HTTP entity tag for the JSON representation.
func (s *Snapshot) ETag() string { return `"` + s.Version + `"` }

type trackJSON struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Artist     string `json:"artist,omitempty"`
	Album      string `json:"album,omitempty"`
	Genre      string `json:"genre,omitempty"`
	Year       int    `json:"year,omitempty"`
	Folder     string `json:"folder"`
	File       string `json:"file"`
	TrackNo    int    `json:"trackNo,omitempty"`
	DiscNo     int    `json:"discNo,omitempty"`
	DurationMs int64  `json:"durationMs"`
	Codec      string `json:"codec,omitempty"`
	Bitrate    int    `json:"bitrate,omitempty"`
	Size       int64  `json:"size"`
	Cover      bool   `json:"cover,omitempty"`
	// Rev changes whenever the file changes; clients put it into media URLs
	// so those can be cached forever.
	Rev string `json:"rev"`
}

type libraryJSON struct {
	Version   string      `json:"version"`
	Tracks    []trackJSON `json:"tracks"`
	Folders   []*Folder   `json:"folders"`
	Playlists []*Playlist `json:"playlists"`
}

// buildSnapshot assembles the in-memory library. folderImages maps a relative
// directory to the absolute path of its cover image.
func buildSnapshot(tracks []Track, playlists []store.Playlist, folderImages map[string]string) *Snapshot {
	s := &Snapshot{
		byID:    make(map[string]*Track, len(tracks)),
		folders: map[string]*Folder{},
	}
	ptrs := make([]*Track, len(tracks))
	for i := range tracks {
		t := tracks[i]
		ptrs[i] = &t
	}
	sort.SliceStable(ptrs, func(i, j int) bool { return trackLess(ptrs[i], ptrs[j]) })
	s.Tracks = ptrs

	ensureFolder := func(p string) *Folder {
		if f, ok := s.folders[p]; ok {
			return f
		}
		f := &Folder{Path: p, Name: path.Base(p), TrackIDs: []string{}}
		if p == "" {
			f.Name = ""
		} else {
			parent := path.Dir(p)
			if parent == "." {
				parent = ""
			}
			f.Parent = parent
		}
		s.folders[p] = f
		return f
	}

	for _, t := range ptrs {
		s.byID[t.ID] = t
		f := ensureFolder(t.Folder)
		f.TrackIDs = append(f.TrackIDs, t.ID)
		// Make every ancestor navigable.
		for p := f.Parent; p != ""; {
			anc := ensureFolder(p)
			p = anc.Parent
		}
	}
	if _, ok := s.folders[""]; !ok && len(s.folders) > 0 {
		ensureFolder("")
	}
	for p, f := range s.folders {
		f.Image = folderImages[p]
		for _, id := range f.TrackIDs {
			if t := s.byID[id]; t.HasCover {
				f.CoverTrackID = id
				break
			}
		}
		if f.CoverTrackID == "" && f.Image != "" && len(f.TrackIDs) > 0 {
			// The track cover endpoint falls back to the folder image.
			f.CoverTrackID = f.TrackIDs[0]
		}
		s.Folders = append(s.Folders, f)
	}
	sort.Slice(s.Folders, func(i, j int) bool { return naturalLess(s.Folders[i].Path, s.Folders[j].Path) })

	s.Playlists = resolvePlaylists(playlists, ptrs)
	s.Version = computeVersion(ptrs, s.Playlists, folderImages)
	s.encode()
	return s
}

func trackLess(a, b *Track) bool {
	if a.Folder != b.Folder {
		return naturalLess(a.Folder, b.Folder)
	}
	if a.DiscNo != b.DiscNo {
		return a.DiscNo < b.DiscNo
	}
	if a.TrackNo != b.TrackNo {
		// Untagged files (0) go after numbered ones.
		if a.TrackNo == 0 || b.TrackNo == 0 {
			return b.TrackNo == 0
		}
		return a.TrackNo < b.TrackNo
	}
	if fa, fb := path.Base(a.Path), path.Base(b.Path); fa != fb {
		return naturalLess(fa, fb)
	}
	return a.Path < b.Path
}

func resolvePlaylists(playlists []store.Playlist, tracks []*Track) []*Playlist {
	byPath := make(map[string]*Track, len(tracks))
	byBase := map[string][]*Track{}
	for _, t := range tracks {
		byPath[t.Path] = t
		lb := strings.ToLower(path.Base(t.Path))
		byBase[lb] = append(byBase[lb], t)
	}
	out := make([]*Playlist, 0, len(playlists))
	for _, p := range playlists {
		pl := &Playlist{ID: p.ID, Name: p.Name, Path: p.Path, TrackIDs: []string{}}
		for _, entry := range p.TrackPaths {
			if t, ok := byPath[entry]; ok {
				pl.TrackIDs = append(pl.TrackIDs, t.ID)
				continue
			}
			// Absolute or differently rooted entry: match the longest path tail.
			var best *Track
			for _, cand := range byBase[strings.ToLower(path.Base(entry))] {
				if strings.HasSuffix(strings.ToLower(entry), "/"+strings.ToLower(cand.Path)) &&
					(best == nil || len(cand.Path) > len(best.Path)) {
					best = cand
				}
			}
			if best != nil {
				pl.TrackIDs = append(pl.TrackIDs, best.ID)
			}
		}
		out = append(out, pl)
	}
	sort.SliceStable(out, func(i, j int) bool { return naturalLess(out[i].Name, out[j].Name) })
	return out
}

func computeVersion(tracks []*Track, playlists []*Playlist, folderImages map[string]string) string {
	h := sha256.New()
	var buf [8]byte
	writeInt := func(n int64) {
		binary.LittleEndian.PutUint64(buf[:], uint64(n))
		h.Write(buf[:])
	}
	for _, t := range tracks {
		for _, s := range []string{t.ID, t.Path, t.Title, t.Artist, t.Album, t.Genre, t.Codec} {
			h.Write([]byte(s))
			h.Write([]byte{0})
		}
		writeInt(t.DurationMs)
		writeInt(t.Size)
		writeInt(t.MtimeNs)
		writeInt(int64(t.TrackNo)<<32 | int64(t.DiscNo))
		writeInt(int64(t.Year))
		writeInt(int64(t.Bitrate))
		if t.HasCover {
			h.Write([]byte{1})
		}
	}
	h.Write([]byte("images"))
	dirs := make([]string, 0, len(folderImages))
	for d := range folderImages {
		dirs = append(dirs, d)
	}
	sort.Strings(dirs)
	for _, d := range dirs {
		h.Write([]byte(d + "\x00" + folderImages[d] + "\x00"))
	}
	h.Write([]byte("playlists"))
	for _, p := range playlists {
		h.Write([]byte(p.ID + "\x00" + p.Name + "\x00" + strings.Join(p.TrackIDs, ",") + "\x00"))
	}
	return hex.EncodeToString(h.Sum(nil)[:8])
}

func (s *Snapshot) encode() {
	out := libraryJSON{
		Version:   s.Version,
		Tracks:    make([]trackJSON, 0, len(s.Tracks)),
		Folders:   s.Folders,
		Playlists: s.Playlists,
	}
	if out.Folders == nil {
		out.Folders = []*Folder{}
	}
	for _, t := range s.Tracks {
		out.Tracks = append(out.Tracks, trackJSON{
			ID: t.ID, Title: t.Title, Artist: t.Artist, Album: t.Album, Genre: t.Genre, Year: t.Year,
			Folder: t.Folder, File: path.Base(t.Path), TrackNo: t.TrackNo, DiscNo: t.DiscNo,
			DurationMs: t.DurationMs, Codec: t.Codec, Bitrate: t.Bitrate, Size: t.Size,
			Cover: t.HasCover || s.FolderImage(t.Folder) != "",
			Rev:   Rev(t),
		})
	}
	b, err := json.Marshal(out)
	if err != nil {
		panic(err) // only plain data types; cannot fail
	}
	s.json = b
	var gz bytes.Buffer
	w, _ := gzip.NewWriterLevel(&gz, gzip.BestCompression)
	_, _ = w.Write(b)
	_ = w.Close()
	s.jsonGzip = gz.Bytes()
}

// Rev returns a short revision string of a track's file.
func Rev(t *Track) string {
	var buf [16]byte
	binary.LittleEndian.PutUint64(buf[:8], uint64(t.Size))
	binary.LittleEndian.PutUint64(buf[8:], uint64(t.MtimeNs))
	sum := sha256.Sum256(buf[:])
	return hex.EncodeToString(sum[:4])
}
