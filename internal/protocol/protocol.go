// Package protocol defines the JSON messages exchanged over the room
// WebSocket. See docs/protocol.md for the narrative description; the web
// client mirrors these types in web/src/sync/protocol.ts.
package protocol

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/RafalPolawski/SyncMusic/internal/room"
)

// Version is bumped on incompatible changes. Clients with another version
// are asked to reload.
const Version = 1

// Client -> server message types.
const (
	TypeHello   = "hello"
	TypePing    = "ping"
	TypeCommand = "cmd"
	TypeStatus  = "status"
	TypeProfile = "profile"
)

// Server -> client message types.
const (
	TypeWelcome  = "welcome"
	TypePong     = "pong"
	TypeAck      = "ack"
	TypeState    = "state"
	TypePresence = "presence"
	TypeLibrary  = "library"
	TypeError    = "error"
)

// Hello is the first message of every connection.
type Hello struct {
	Type     string `json:"type"`
	Protocol int    `json:"protocol"`
	ClientID string `json:"clientId"`
	Name     string `json:"name"`
	Room     string `json:"room"`
	Format   string `json:"format,omitempty"`
	Quality  string `json:"quality,omitempty"`
}

// Ping is a clock synchronisation probe. T0 is the client's clock when sent.
type Ping struct {
	Type string  `json:"type"`
	ID   int64   `json:"id"`
	T0   float64 `json:"t0"`
}

// Pong answers a Ping. T1 is the server time when the ping was received and
// T2 when the pong was written, both in Unix milliseconds (fractional).
type Pong struct {
	Type string  `json:"type"`
	ID   int64   `json:"id"`
	T0   float64 `json:"t0"`
	T1   float64 `json:"t1"`
	T2   float64 `json:"t2"`
}

// Command wraps a room command with a client chosen id used for
// acknowledgement and de-duplication of retries.
type Command struct {
	Type string       `json:"type"`
	ID   string       `json:"id"`
	Cmd  room.Command `json:"cmd"`
}

// Status is periodically reported by clients for presence and for the
// "wait for everyone" barrier.
type Status struct {
	Type      string   `json:"type"`
	TrackID   string   `json:"trackId"`
	EntryID   string   `json:"entryId,omitempty"`
	Ready     bool     `json:"ready"`
	Buffering bool     `json:"buffering"`
	Playing   bool     `json:"playing"`
	DriftMs   *float64 `json:"driftMs,omitempty"`
	RTTMs     *float64 `json:"rttMs,omitempty"`
	Offline   int      `json:"offline,omitempty"` // number of tracks available offline
}

// Profile updates a listener's display name or audio preferences.
type Profile struct {
	Type    string `json:"type"`
	Name    string `json:"name,omitempty"`
	Format  string `json:"format,omitempty"`
	Quality string `json:"quality,omitempty"`
}

// RoomInfo identifies a room.
type RoomInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Timing tells clients how the server schedules starts.
type Timing struct {
	StartDelayMs  int64 `json:"startDelayMs"`
	ResumeDelayMs int64 `json:"resumeDelayMs"`
}

// Welcome confirms a successful hello.
type Welcome struct {
	Type           string   `json:"type"`
	Protocol       int      `json:"protocol"`
	ServerTime     float64  `json:"serverTime"`
	Room           RoomInfo `json:"room"`
	ClientID       string   `json:"clientId"`
	LibraryVersion string   `json:"libraryVersion"`
	Timing         Timing   `json:"timing"`
	ServerVersion  string   `json:"serverVersion"`
}

// Ack answers a Command.
type Ack struct {
	Type    string      `json:"type"`
	ID      string      `json:"id"`
	OK      bool        `json:"ok"`
	Version uint64      `json:"version"`
	Error   *room.Error `json:"error,omitempty"`
}

// State is a room snapshot. Queue and Context are only included when they
// changed since the last snapshot the connection received (and always in the
// first one), keeping frequent play/pause updates tiny.
type State struct {
	Type           string             `json:"type"`
	Version        uint64             `json:"version"`
	ServerTime     int64              `json:"serverTime"`
	Playback       room.Playback      `json:"playback"`
	ContextIndex   int                `json:"contextIndex"`
	Shuffle        bool               `json:"shuffle"`
	Repeat         room.Repeat        `json:"repeat"`
	WaitForAll     bool               `json:"waitForAll"`
	Hold           *room.Hold         `json:"hold,omitempty"`
	QueueVersion   uint64             `json:"queueVersion"`
	Queue          *[]room.QueueEntry `json:"queue,omitempty"`
	ContextVersion uint64             `json:"contextVersion"`
	Context        *room.Context      `json:"context,omitempty"`
}

// Member is one listener in a presence update.
type Member struct {
	ClientID  string   `json:"clientId"`
	Name      string   `json:"name"`
	Connected bool     `json:"connected"`
	TrackID   string   `json:"trackId,omitempty"`
	Ready     bool     `json:"ready"`
	Buffering bool     `json:"buffering"`
	Playing   bool     `json:"playing"`
	DriftMs   *float64 `json:"driftMs,omitempty"`
	RTTMs     *float64 `json:"rttMs,omitempty"`
	Offline   int      `json:"offline,omitempty"`
	LastSeen  int64    `json:"lastSeen"`
}

// Presence lists the room's listeners.
type Presence struct {
	Type    string   `json:"type"`
	Members []Member `json:"members"`
	// Waiting lists names of listeners a held start is waiting for.
	Waiting []string `json:"waiting,omitempty"`
}

// Library notifies clients that the library changed.
type Library struct {
	Type    string `json:"type"`
	Version string `json:"version"`
}

// Error reports a protocol level problem.
type Error struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ErrUnknownType is returned for messages with an unknown type.
var ErrUnknownType = errors.New("unknown message type")

// Decode parses a client message into one of the client message structs.
func Decode(data []byte) (any, error) {
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, fmt.Errorf("invalid message: %w", err)
	}
	var msg any
	switch env.Type {
	case TypeHello:
		msg = &Hello{}
	case TypePing:
		msg = &Ping{}
	case TypeCommand:
		msg = &Command{}
	case TypeStatus:
		msg = &Status{}
	case TypeProfile:
		msg = &Profile{}
	default:
		return nil, fmt.Errorf("%w %q", ErrUnknownType, env.Type)
	}
	if err := json.Unmarshal(data, msg); err != nil {
		return nil, fmt.Errorf("invalid %s message: %w", env.Type, err)
	}
	return msg, nil
}
