package store

import (
	"context"
	"database/sql"
	"errors"
)

// RoomRecord is a persisted room.
type RoomRecord struct {
	ID        string
	Name      string
	State     []byte // JSON encoded room state
	UpdatedAt int64  // unix milliseconds
}

// SaveRoom inserts or updates a room.
func (db *DB) SaveRoom(ctx context.Context, r RoomRecord) error {
	_, err := db.ExecContext(ctx, `INSERT INTO rooms (id, name, state, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name = excluded.name, state = excluded.state, updated_at = excluded.updated_at`,
		r.ID, r.Name, string(r.State), r.UpdatedAt)
	return err
}

// LoadRoom returns a single room.
func (db *DB) LoadRoom(ctx context.Context, id string) (RoomRecord, error) {
	var r RoomRecord
	var state string
	err := db.QueryRowContext(ctx, "SELECT id, name, state, updated_at FROM rooms WHERE id = ?", id).
		Scan(&r.ID, &r.Name, &state, &r.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return r, ErrNotFound
	}
	r.State = []byte(state)
	return r, err
}

// ListRooms returns all persisted rooms, most recently used first.
func (db *DB) ListRooms(ctx context.Context) ([]RoomRecord, error) {
	rows, err := db.QueryContext(ctx, "SELECT id, name, state, updated_at FROM rooms ORDER BY updated_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RoomRecord
	for rows.Next() {
		var r RoomRecord
		var state string
		if err := rows.Scan(&r.ID, &r.Name, &state, &r.UpdatedAt); err != nil {
			return nil, err
		}
		r.State = []byte(state)
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeleteRoomsBefore removes rooms not updated since the given time and
// returns how many were deleted.
func (db *DB) DeleteRoomsBefore(ctx context.Context, updatedBefore int64) (int64, error) {
	res, err := db.ExecContext(ctx, "DELETE FROM rooms WHERE updated_at < ?", updatedBefore)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
