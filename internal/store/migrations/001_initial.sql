-- Library index. Track ids are derived from the relative path so they stay
-- stable across rescans and server reinstalls.
CREATE TABLE tracks (
    id           TEXT    PRIMARY KEY,
    path         TEXT    NOT NULL UNIQUE,
    folder       TEXT    NOT NULL,
    title        TEXT    NOT NULL,
    artist       TEXT    NOT NULL DEFAULT '',
    album        TEXT    NOT NULL DEFAULT '',
    album_artist TEXT    NOT NULL DEFAULT '',
    genre        TEXT    NOT NULL DEFAULT '',
    year         INTEGER NOT NULL DEFAULT 0,
    track_no     INTEGER NOT NULL DEFAULT 0,
    disc_no      INTEGER NOT NULL DEFAULT 0,
    duration_ms  INTEGER NOT NULL DEFAULT 0,
    format       TEXT    NOT NULL DEFAULT '',
    codec        TEXT    NOT NULL DEFAULT '',
    bitrate      INTEGER NOT NULL DEFAULT 0,
    sample_rate  INTEGER NOT NULL DEFAULT 0,
    channels     INTEGER NOT NULL DEFAULT 0,
    has_cover    INTEGER NOT NULL DEFAULT 0,
    size         INTEGER NOT NULL,
    mtime_ns     INTEGER NOT NULL,
    scanned_at   INTEGER NOT NULL
);

CREATE INDEX tracks_folder ON tracks(folder);

-- Playlists imported from .m3u/.m3u8 files inside the music directory.
CREATE TABLE playlists (
    id       TEXT    PRIMARY KEY,
    path     TEXT    NOT NULL UNIQUE,
    name     TEXT    NOT NULL,
    size     INTEGER NOT NULL,
    mtime_ns INTEGER NOT NULL
);

CREATE TABLE playlist_tracks (
    playlist_id TEXT    NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    track_path  TEXT    NOT NULL,
    PRIMARY KEY (playlist_id, position)
);

-- Persisted room state (JSON encoded room.State) so restarts keep the queue.
CREATE TABLE rooms (
    id         TEXT    PRIMARY KEY,
    name       TEXT    NOT NULL,
    state      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
