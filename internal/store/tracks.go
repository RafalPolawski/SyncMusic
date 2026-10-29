package store

import (
	"context"
	"database/sql"
	"fmt"
)

// Track is a library entry as persisted in the database.
type Track struct {
	ID          string
	Path        string // relative to the music root, always slash separated
	Folder      string // relative directory ("" for files in the root)
	Title       string
	Artist      string
	Album       string
	AlbumArtist string
	Genre       string
	Year        int
	TrackNo     int
	DiscNo      int
	DurationMs  int64
	Format      string // container, e.g. "flac", "mp3", "mov,mp4,m4a"
	Codec       string // audio codec, e.g. "flac", "mp3", "aac", "opus"
	Bitrate     int    // bits per second
	SampleRate  int
	Channels    int
	HasCover    bool
	Size        int64
	MtimeNs     int64
	ScannedAt   int64
}

const trackColumns = `id, path, folder, title, artist, album, album_artist, genre, year, track_no, disc_no,
	duration_ms, format, codec, bitrate, sample_rate, channels, has_cover, size, mtime_ns, scanned_at`

func scanTrack(row interface{ Scan(...any) error }) (Track, error) {
	var t Track
	err := row.Scan(&t.ID, &t.Path, &t.Folder, &t.Title, &t.Artist, &t.Album, &t.AlbumArtist, &t.Genre,
		&t.Year, &t.TrackNo, &t.DiscNo, &t.DurationMs, &t.Format, &t.Codec, &t.Bitrate, &t.SampleRate,
		&t.Channels, &t.HasCover, &t.Size, &t.MtimeNs, &t.ScannedAt)
	return t, err
}

// ListTracks returns every track in the library.
func (db *DB) ListTracks(ctx context.Context) ([]Track, error) {
	rows, err := db.QueryContext(ctx, "SELECT "+trackColumns+" FROM tracks")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Track
	for rows.Next() {
		t, err := scanTrack(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ApplyTrackChanges upserts and deletes tracks in a single transaction.
func (db *DB) ApplyTrackChanges(ctx context.Context, upserts []Track, deleteIDs []string) error {
	if len(upserts) == 0 && len(deleteIDs) == 0 {
		return nil
	}
	return db.inTx(ctx, func(tx *sql.Tx) error {
		if len(deleteIDs) > 0 {
			del, err := tx.PrepareContext(ctx, "DELETE FROM tracks WHERE id = ?")
			if err != nil {
				return err
			}
			defer del.Close()
			for _, id := range deleteIDs {
				if _, err := del.ExecContext(ctx, id); err != nil {
					return fmt.Errorf("delete track %s: %w", id, err)
				}
			}
		}
		if len(upserts) > 0 {
			up, err := tx.PrepareContext(ctx, `INSERT INTO tracks (`+trackColumns+`)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					path = excluded.path, folder = excluded.folder, title = excluded.title,
					artist = excluded.artist, album = excluded.album, album_artist = excluded.album_artist,
					genre = excluded.genre, year = excluded.year, track_no = excluded.track_no,
					disc_no = excluded.disc_no, duration_ms = excluded.duration_ms, format = excluded.format,
					codec = excluded.codec, bitrate = excluded.bitrate, sample_rate = excluded.sample_rate,
					channels = excluded.channels, has_cover = excluded.has_cover, size = excluded.size,
					mtime_ns = excluded.mtime_ns, scanned_at = excluded.scanned_at`)
			if err != nil {
				return err
			}
			defer up.Close()
			for _, t := range upserts {
				if _, err := up.ExecContext(ctx, t.ID, t.Path, t.Folder, t.Title, t.Artist, t.Album, t.AlbumArtist,
					t.Genre, t.Year, t.TrackNo, t.DiscNo, t.DurationMs, t.Format, t.Codec, t.Bitrate, t.SampleRate,
					t.Channels, t.HasCover, t.Size, t.MtimeNs, t.ScannedAt); err != nil {
					return fmt.Errorf("upsert track %s: %w", t.Path, err)
				}
			}
		}
		return nil
	})
}

// Playlist is an imported .m3u playlist.
type Playlist struct {
	ID         string
	Path       string
	Name       string
	Size       int64
	MtimeNs    int64
	TrackPaths []string
}

// ListPlaylists returns all playlists with their entries.
func (db *DB) ListPlaylists(ctx context.Context) ([]Playlist, error) {
	rows, err := db.QueryContext(ctx, "SELECT id, path, name, size, mtime_ns FROM playlists ORDER BY name")
	if err != nil {
		return nil, err
	}
	var out []Playlist
	index := map[string]int{}
	for rows.Next() {
		var p Playlist
		if err := rows.Scan(&p.ID, &p.Path, &p.Name, &p.Size, &p.MtimeNs); err != nil {
			rows.Close()
			return nil, err
		}
		index[p.ID] = len(out)
		out = append(out, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	entries, err := db.QueryContext(ctx, "SELECT playlist_id, track_path FROM playlist_tracks ORDER BY playlist_id, position")
	if err != nil {
		return nil, err
	}
	defer entries.Close()
	for entries.Next() {
		var id, path string
		if err := entries.Scan(&id, &path); err != nil {
			return nil, err
		}
		if i, ok := index[id]; ok {
			out[i].TrackPaths = append(out[i].TrackPaths, path)
		}
	}
	return out, entries.Err()
}

// ReplacePlaylists replaces the full set of playlists.
func (db *DB) ReplacePlaylists(ctx context.Context, playlists []Playlist) error {
	return db.inTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "DELETE FROM playlists"); err != nil {
			return err
		}
		insP, err := tx.PrepareContext(ctx, "INSERT INTO playlists (id, path, name, size, mtime_ns) VALUES (?, ?, ?, ?, ?)")
		if err != nil {
			return err
		}
		defer insP.Close()
		insT, err := tx.PrepareContext(ctx, "INSERT INTO playlist_tracks (playlist_id, position, track_path) VALUES (?, ?, ?)")
		if err != nil {
			return err
		}
		defer insT.Close()
		for _, p := range playlists {
			if _, err := insP.ExecContext(ctx, p.ID, p.Path, p.Name, p.Size, p.MtimeNs); err != nil {
				return fmt.Errorf("insert playlist %s: %w", p.Path, err)
			}
			for i, tp := range p.TrackPaths {
				if _, err := insT.ExecContext(ctx, p.ID, i, tp); err != nil {
					return fmt.Errorf("insert playlist entry: %w", err)
				}
			}
		}
		return nil
	})
}

func (db *DB) inTx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}
