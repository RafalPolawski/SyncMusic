package main

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

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

// Room holds all connected clients and the shared playback state.
type Room struct {
	Clients         map[*WTClient]bool
	ClientsMutex    sync.Mutex
	StateMutex      sync.Mutex
	CurrentSong     string
	IsPlaying       bool
	CurrentPosition float64
	LastUpdate      time.Time
	IsShuffleGlobal bool
	IsRepeatGlobal  int
	CurrentFolder   string
	GlobalVolume    float64
	Queue           []map[string]interface{}
}

func NewRoom() *Room {
	return &Room{
		Clients:      make(map[*WTClient]bool),
		GlobalVolume: 1.0,
		Queue:        make([]map[string]interface{}, 0),
	}
}

var globalRoom = NewRoom()

// Broadcast sends msg to every connected client.
func (r *Room) Broadcast(msg []byte) {
	r.ClientsMutex.Lock()
	defer r.ClientsMutex.Unlock()
	for c := range r.Clients {
		c.SendNonBlocking(msg)
	}
}

// BroadcastPresence sends the current listener list to every client.
func (r *Room) BroadcastPresence() {
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
