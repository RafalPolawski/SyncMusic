package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/quic-go/webtransport-go"
)

// handleWTSession manages the full lifecycle of a single WebTransport client:
// registering, sending initial sync state, reading commands, and clean-up.
func handleWTSession(session *webtransport.Session) {
	clientIP := session.RemoteAddr().String()

	stream, err := session.AcceptStream(context.Background())
	if err != nil {
		log.Printf("[ERROR] WT failed to accept stream from %s: %v\n", clientIP, err)
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	client := &WTClient{
		Session:  session,
		Stream:   stream,
		SendChan: make(chan []byte, 100),
		cancel:   cancel,
	}

	go clientWriter(ctx, client)

	globalRoom.ClientsMutex.Lock()
	globalRoom.Clients[client] = true
	total := len(globalRoom.Clients)
	globalRoom.ClientsMutex.Unlock()
	log.Printf("[INFO] WT Client connected: %s. Total clients: %d\n", clientIP, total)

	defer func() {
		client.cancel()
		globalRoom.ClientsMutex.Lock()
		delete(globalRoom.Clients, client)
		remaining := len(globalRoom.Clients)
		globalRoom.ClientsMutex.Unlock()
		log.Printf("[INFO] WT Client disconnected: %s. Total clients: %d\n", clientIP, remaining)
		globalRoom.BroadcastPresence()
		session.CloseWithError(0, "")
	}()

	// Send current room state to the newly joined client
	globalRoom.StateMutex.Lock()
	if globalRoom.CurrentSong != "" {
		pos := globalRoom.CurrentPosition
		if globalRoom.IsPlaying {
			pos += time.Since(globalRoom.LastUpdate).Seconds()
		}
		syncMsg := map[string]interface{}{
			"action":    "sync",
			"song":      globalRoom.CurrentSong,
			"time":      pos,
			"server_ts": time.Now().UnixMilli(),
			"isPlaying": globalRoom.IsPlaying,
			"isShuffle": globalRoom.IsShuffleGlobal,
			"isRepeat":  globalRoom.IsRepeatGlobal,
			"folder":    globalRoom.CurrentFolder,
			"volume":    globalRoom.GlobalVolume,
			"queue":     globalRoom.Queue,
		}
		b, _ := json.Marshal(syncMsg)
		client.SendNonBlocking(append(b, '\n'))
	} else {
		m1, _ := json.Marshal(map[string]interface{}{"action": "shuffle", "state": globalRoom.IsShuffleGlobal})
		m2, _ := json.Marshal(map[string]interface{}{"action": "repeat", "state": globalRoom.IsRepeatGlobal})
		m3, _ := json.Marshal(map[string]interface{}{"action": "queue_update", "queue": globalRoom.Queue})
		client.SendNonBlocking(append(m1, '\n'))
		client.SendNonBlocking(append(m2, '\n'))
		client.SendNonBlocking(append(m3, '\n'))
	}
	globalRoom.StateMutex.Unlock()

	// Main read loop
	decoder := json.NewDecoder(stream)
	for {
		var msg map[string]interface{}
		if err := decoder.Decode(&msg); err != nil {
			break
		}
		handleClientMessage(client, clientIP, msg)
	}
}

// handleClientMessage dispatches a single decoded client message and
// broadcasts the result to all other clients where applicable.
func handleClientMessage(client *WTClient, clientIP string, msg map[string]interface{}) {
	globalRoom.StateMutex.Lock()

	action, _ := msg["action"].(string)
	switch action {

	case "join":
		if nick, ok := msg["nickname"].(string); ok {
			client.Nickname = nick
			log.Printf("[INFO] Client %s joined as: %s\n", clientIP, nick)
		}
		globalRoom.StateMutex.Unlock()
		globalRoom.BroadcastPresence()
		return

	case "ping":
		if clientTime, ok := msg["clientTime"].(float64); ok {
			pong := map[string]interface{}{
				"action":     "pong",
				"clientTime": clientTime,
				"serverTime": time.Now().UnixMilli(),
			}
			b, _ := json.Marshal(pong)
			client.SendNonBlocking(append(b, '\n'))
		}
		globalRoom.StateMutex.Unlock()
		return

	case "load":
		if s, ok := msg["song"].(string); ok {
			// Race-condition guard: reject if expected previous doesn't match
			if expPrev, hasPrev := msg["expected_previous"].(string); hasPrev {
				if expPrev != "" && globalRoom.CurrentSong != "" && expPrev != globalRoom.CurrentSong {
					log.Printf("[ACTION] Rejected load %s from %s (expected_prev mismatch)\n", s, clientIP)
					globalRoom.StateMutex.Unlock()
					return
				}
			}
			globalRoom.CurrentSong     = s
			globalRoom.CurrentPosition = 0
			globalRoom.IsPlaying        = true
			globalRoom.LastUpdate       = time.Now()
			log.Printf("[ACTION] Client %s loaded: %s\n", clientIP, s)
		}
		if f, ok := msg["folder"].(string); ok {
			globalRoom.CurrentFolder = f
		}
		msg["server_ts"] = time.Now().UnixMilli()

	case "play":
		if t, ok := msg["time"].(float64); ok {
			globalRoom.CurrentPosition = t
		}
		globalRoom.IsPlaying  = true
		globalRoom.LastUpdate = time.Now()
		msg["server_ts"] = time.Now().UnixMilli()
		log.Printf("[ACTION] Client %s PLAY at %.2fs\n", clientIP, globalRoom.CurrentPosition)

	case "pause":
		if t, ok := msg["time"].(float64); ok {
			globalRoom.CurrentPosition = t
		}
		globalRoom.IsPlaying = false
		msg["server_ts"] = time.Now().UnixMilli()
		log.Printf("[ACTION] Client %s PAUSE at %.2fs\n", clientIP, globalRoom.CurrentPosition)

	case "seek":
		if t, ok := msg["time"].(float64); ok {
			globalRoom.CurrentPosition = t
			globalRoom.LastUpdate      = time.Now()
			log.Printf("[ACTION] Client %s SEEK to %.2fs\n", clientIP, t)
		}
		if playing, ok := msg["isPlaying"].(bool); ok {
			globalRoom.IsPlaying = playing
		}
		msg["server_ts"] = time.Now().UnixMilli()

	case "shuffle":
		if st, ok := msg["state"].(bool); ok {
			globalRoom.IsShuffleGlobal = st
			log.Printf("[ACTION] Client %s SHUFFLE=%v\n", clientIP, st)
		}

	case "repeat":
		if st, ok := msg["state"].(float64); ok {
			globalRoom.IsRepeatGlobal = int(st)
			log.Printf("[ACTION] Client %s REPEAT=%d\n", clientIP, int(st))
		}

	case "volume":
		if vol, ok := msg["level"].(float64); ok {
			globalRoom.GlobalVolume = vol
			log.Printf("[ACTION] Client %s VOLUME=%.2f\n", clientIP, vol)
		}

	case "enqueue":
		if item, ok := msg["item"].(map[string]interface{}); ok {
			if len(globalRoom.Queue) >= 500 {
				log.Printf("[ACTION] Client %s enqueue rejected (queue full)\n", clientIP)
				globalRoom.StateMutex.Unlock()
				return
			}
			item["id"] = float64(time.Now().UnixNano())
			globalRoom.Queue = append(globalRoom.Queue, item)
			broadcastQueue()
			log.Printf("[ACTION] Client %s enqueued: %v\n", clientIP, item["path"])
		}
		globalRoom.StateMutex.Unlock()
		return

	case "dequeue":
		removed := false
		if idVal, ok := msg["id"].(float64); ok {
			removed = removeQueueByID(idVal)
		} else if idx, ok := msg["index"].(float64); ok {
			removed = removeQueueByIndex(int(idx))
		}
		if removed {
			broadcastQueue()
			log.Printf("[ACTION] Client %s dequeued\n", clientIP)
		}
		globalRoom.StateMutex.Unlock()
		return

	case "queue_move":
		if fromF, ok1 := msg["from"].(float64); ok1 {
			if toF, ok2 := msg["to"].(float64); ok2 {
				moveQueueItem(int(fromF), int(toF))
				broadcastQueue()
				log.Printf("[ACTION] Client %s moved queue %d→%d\n", clientIP, int(fromF), int(toF))
			}
		}
		globalRoom.StateMutex.Unlock()
		return
	}

	globalRoom.StateMutex.Unlock()

	// Broadcast to all clients (default path for play/pause/seek/load/shuffle/repeat/volume)
	out, _ := json.Marshal(msg)
	globalRoom.Broadcast(append(out, '\n'))
}

// ── Queue mutation helpers ────────────────────────────────────────────────────
// All callers hold StateMutex when invoking these.

func removeQueueByID(id float64) bool {
	for i, item := range globalRoom.Queue {
		if qID, ok := item["id"].(float64); ok && qID == id {
			return removeQueueByIndex(i)
		}
	}
	return false
}

func removeQueueByIndex(i int) bool {
	q := globalRoom.Queue
	if i < 0 || i >= len(q) {
		return false
	}
	copy(q[i:], q[i+1:])
	q[len(q)-1] = nil // allow GC
	globalRoom.Queue = q[:len(q)-1]
	return true
}

func moveQueueItem(from, to int) {
	q := globalRoom.Queue
	if from < 0 || from >= len(q) || to < 0 || to > len(q) {
		return
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
	globalRoom.Queue = newQ
}

func broadcastQueue() {
	msg := map[string]interface{}{"action": "queue_update", "queue": globalRoom.Queue}
	b, _ := json.Marshal(msg)
	globalRoom.Broadcast(append(b, '\n'))
}
