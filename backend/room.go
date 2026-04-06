package main

import (
	"context"
	"encoding/json"
	"log"
	"sync"

	"github.com/quic-go/webtransport-go"
)

// WTClient represents a single connected WebTransport client.
type WTClient struct {
	Session  *webtransport.Session
	Stream   *webtransport.Stream
	SendChan chan []byte
	cancel   context.CancelFunc
	mu       sync.RWMutex
	Nickname string
	RoomID   string
}

func (c *WTClient) GetNickname() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.Nickname
}

func (c *WTClient) SetNickname(nick string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Nickname = nick
}

func (c *WTClient) GetRoomID() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.RoomID
}

func (c *WTClient) SetRoomID(roomID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.RoomID = roomID
}

// SendNonBlocking queues a message without blocking. Drops the message if the
// channel is full to avoid slowing down the broadcast loop.
func (c *WTClient) SendNonBlocking(msg []byte) {
	select {
	case c.SendChan <- msg:
	default:
		log.Printf("[WARN] WTClient SendChan full, dropping message\n")
	}
}

// LocalClientsTracker holds connected clients on this instance.
type LocalClientsTracker struct {
	Clients      map[*WTClient]bool
	ClientsMutex sync.Mutex
}

var globalLocalClients = &LocalClientsTracker{
	Clients: make(map[*WTClient]bool),
}

// BroadcastToRoom sends msg to every connected client in the specified room.
func (r *LocalClientsTracker) BroadcastToRoom(roomID string, msg []byte) {
	r.ClientsMutex.Lock()
	var targets []*WTClient
	for c := range r.Clients {
		if c.GetRoomID() == roomID {
			targets = append(targets, c)
		}
	}
	r.ClientsMutex.Unlock()

	for _, c := range targets {
		c.SendNonBlocking(msg)
	}
}

// BroadcastPresenceToRoom sends the listener list to every client in the room.
func (r *LocalClientsTracker) BroadcastPresenceToRoom(roomID string) {
	if roomID == "" {
		return
	}
	r.ClientsMutex.Lock()
	var users []string
	var targets []*WTClient
	for c := range r.Clients {
		if c.GetRoomID() == roomID {
			targets = append(targets, c)
			nick := c.GetNickname()
			if nick != "" {
				users = append(users, nick)
			} else {
				users = append(users, "Anonymous")
			}
		}
	}
	r.ClientsMutex.Unlock()

	msg := map[string]interface{}{
		"action": "presence",
		"users":  users,
	}
	b, _ := json.Marshal(msg)
	b = append(b, '\n')
	for _, t := range targets {
		t.SendNonBlocking(b)
	}
}

// clientWriter drains the SendChan and writes messages to the stream.
func clientWriter(ctx context.Context, client *WTClient) {
	defer client.Stream.Close()
	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-client.SendChan:
			client.Stream.Write(msg)
		}
	}
}

// ── Queue mutation helpers ────────────────────────────────────────────────────
// These apply modifications to a given slice. The caller handles saving to Redis.

func removeQueueByID(q []map[string]interface{}, id string) ([]map[string]interface{}, bool) {
	for i, item := range q {
		if qID, ok := item["id"].(string); ok && qID == id {
			return removeQueueByIndex(q, i)
		}
	}
	return q, false
}

func removeQueueByIndex(q []map[string]interface{}, i int) ([]map[string]interface{}, bool) {
	if i < 0 || i >= len(q) {
		return q, false
	}
	copy(q[i:], q[i+1:])
	q[len(q)-1] = nil // allow GC
	q = q[:len(q)-1]
	return q, true
}

func moveQueueItem(q []map[string]interface{}, from, to int) []map[string]interface{} {
	if from < 0 || from >= len(q) || to < 0 || to > len(q) {
		return q
	}
	item := q[from]
	// Remove from old position
	copy(q[from:], q[from+1:])
	q[len(q)-1] = nil
	q = q[:len(q)-1]

	// Insert at new position
	var newQ []map[string]interface{}
	if to == 0 {
		newQ = append([]map[string]interface{}{item}, q...)
	} else if to >= len(q) {
		newQ = append(q, item)
	} else {
		newQ = append(newQ, q[:to]...)
		newQ = append(newQ, item)
		newQ = append(newQ, q[to:]...)
	}
	return newQ
}
