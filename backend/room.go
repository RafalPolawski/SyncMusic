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
	Nickname string
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

// Broadcast sends msg to every connected client on this instance.
func (r *LocalClientsTracker) Broadcast(msg []byte) {
	r.ClientsMutex.Lock()
	defer r.ClientsMutex.Unlock()
	for c := range r.Clients {
		c.SendNonBlocking(msg)
	}
}

// BroadcastPresence sends the current listener list to every client.
// TODO: This currently only shows local instance presence. With Redis, we'd need
// to aggregate presence. For now, we will just send local presence or disable.
func (r *LocalClientsTracker) BroadcastPresence() {
	r.ClientsMutex.Lock()
	var users []string
	for c := range r.Clients {
		if c.Nickname != "" {
			users = append(users, c.Nickname)
		} else {
			users = append(users, "Anonymous")
		}
	}
	r.ClientsMutex.Unlock()

	msg := map[string]interface{}{
		"action": "presence",
		"users":  users,
	}
	b, _ := json.Marshal(msg)
	r.Broadcast(append(b, '\n'))
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

func removeQueueByID(q []map[string]interface{}, id float64) ([]map[string]interface{}, bool) {
	for i, item := range q {
		if qID, ok := item["id"].(float64); ok && qID == id {
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
