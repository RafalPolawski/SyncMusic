package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log"
	"strings"

	"github.com/quic-go/webtransport-go"
)

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

	globalLocalClients.ClientsMutex.Lock()
	globalLocalClients.Clients[client] = true
	total := len(globalLocalClients.Clients)
	globalLocalClients.ClientsMutex.Unlock()
	log.Printf("[INFO] WT Client connected: %s. Local clients: %d\n", clientIP, total)

	defer func() {
		client.cancel()
		globalLocalClients.ClientsMutex.Lock()
		delete(globalLocalClients.Clients, client)
		remaining := len(globalLocalClients.Clients)
		globalLocalClients.ClientsMutex.Unlock()
		log.Printf("[INFO] WT Client disconnected: %s. Local clients: %d\n", clientIP, remaining)
		if client.RoomID != "" {
			globalLocalClients.BroadcastPresenceToRoom(client.RoomID)
		}
		session.CloseWithError(0, "")
	}()

	// We delay sending the state until the client emits "join" providing RoomID.

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

func handleClientMessage(client *WTClient, clientIP string, msg map[string]interface{}) {
	action, _ := msg["action"].(string)

	if action == "join" {
		if nick, ok := msg["nickname"].(string); ok {
			client.Nickname = nick
		}
		
		// SSO JWT Decoding (Trust on First Use / Identity Mapping)
		if token, ok := msg["token"].(string); ok && token != "" {
			parts := strings.Split(token, ".")
			if len(parts) == 3 {
				if payload, err := base64.RawURLEncoding.DecodeString(parts[1]); err == nil {
					var claims struct {
						PreferredUsername string `json:"preferred_username"`
						GivenName         string `json:"given_name"`
						Name              string `json:"name"`
					}
					if err := json.Unmarshal(payload, &claims); err == nil {
						authLabel := " (SSO ✔️)"
						if claims.PreferredUsername != "" {
							client.Nickname = claims.PreferredUsername + authLabel
						} else if claims.GivenName != "" {
							client.Nickname = claims.GivenName + authLabel
						} else if claims.Name != "" {
							client.Nickname = claims.Name + authLabel
						}
						log.Printf("[AUTH] Identified SSO User: %s (Claims: pref=%s, given=%s)\n", client.Nickname, claims.PreferredUsername, claims.GivenName)
					} else {
						log.Printf("[AUTH] Failed to unmarshal JWT payload: %v\n", err)
					}
				} else {
					log.Printf("[AUTH] Failed to decode JWT base64: %v\n", err)
				}
			} else {
				log.Printf("[AUTH] Invalid JWT parts count: %d\n", len(parts))
			}
		}

		if room, ok := msg["room_id"].(string); ok && room != "" {
			client.RoomID = room
		} else {
			client.RoomID = "global"
		}
		log.Printf("[INFO] Client %s joined room: %s as %s\n", clientIP, client.RoomID, client.Nickname)

		state := GetRoomState(client.RoomID)
		if state.CurrentSong != "" {
			pos := state.CurrentPosition
			if state.IsPlaying {
				pos += NowNTP().Sub(state.LastUpdate).Seconds()
			}
			syncMsg := map[string]interface{}{
				"action":    "sync",
				"song":      state.CurrentSong,
				"time":      pos,
				"server_ts": NowNTP().UnixMilli(),
				"isPlaying": state.IsPlaying,

				"isShuffle": state.IsShuffleGlobal,
				"isRepeat":  state.IsRepeatGlobal,
				"folder":    state.CurrentFolder,
				"volume":    state.GlobalVolume,
				"queue":     state.Queue,
			}
			b, _ := json.Marshal(syncMsg)
			client.SendNonBlocking(append(b, '\n'))
		} else {
			m1, _ := json.Marshal(map[string]interface{}{"action": "shuffle", "state": state.IsShuffleGlobal})
			m2, _ := json.Marshal(map[string]interface{}{"action": "repeat", "state": state.IsRepeatGlobal})
			m3, _ := json.Marshal(map[string]interface{}{"action": "queue_update", "queue": state.Queue})
			client.SendNonBlocking(append(m1, '\n'))
			client.SendNonBlocking(append(m2, '\n'))
			client.SendNonBlocking(append(m3, '\n'))
		}

		globalLocalClients.BroadcastPresenceToRoom(client.RoomID)
		return
	}

	if action == "ping" {
		if clientTime, ok := msg["clientTime"].(float64); ok {
			pong := map[string]interface{}{
				"action":     "pong",
				"clientTime": clientTime,
				"serverTime": NowNTP().UnixMilli(),
				"pingKey":    msg["pingKey"], // echo back for accurate RTT tracking
			}

			b, _ := json.Marshal(pong)
			client.SendNonBlocking(append(b, '\n'))
		}
		return
	}

	withStateLock(func() {
		state := GetRoomState(client.RoomID)

		switch action {

		case "load":
			if s, ok := msg["song"].(string); ok {
				if expPrev, hasPrev := msg["expected_previous"].(string); hasPrev {
					if expPrev != "" && state.CurrentSong != "" && expPrev != state.CurrentSong {
						log.Printf("[ACTION] Rejected load %s from %s (expected_prev mismatch)\n", s, clientIP)
						return // Lock released by defer
					}
				}
				state.CurrentSong = s
				state.CurrentPosition = 0
				state.IsPlaying = true
				state.LastUpdate = NowNTP()
				log.Printf("[ACTION] Client %s loaded: %s\n", clientIP, s)
			}
			if f, ok := msg["folder"].(string); ok {
				state.CurrentFolder = f
			}
			msg["server_ts"] = NowNTP().UnixMilli()
			saveAndPublish(client.RoomID, state, msg)

		case "play":
			if t, ok := msg["time"].(float64); ok {
				state.CurrentPosition = t
			}
			state.IsPlaying = true
			state.LastUpdate = NowNTP()
			msg["server_ts"] = NowNTP().UnixMilli()
			saveAndPublish(client.RoomID, state, msg)
			log.Printf("[ACTION] Client %s PLAY at %.2fs\n", clientIP, state.CurrentPosition)

		case "pause":
			if t, ok := msg["time"].(float64); ok {
				state.CurrentPosition = t
			}
			state.IsPlaying = false
			state.LastUpdate = NowNTP()
			msg["server_ts"] = NowNTP().UnixMilli()
			saveAndPublish(client.RoomID, state, msg)
			log.Printf("[ACTION] Client %s PAUSE at %.2fs\n", clientIP, state.CurrentPosition)

		case "seek":
			if t, ok := msg["time"].(float64); ok {
				state.CurrentPosition = t
				state.LastUpdate = NowNTP()
				log.Printf("[ACTION] Client %s SEEK to %.2fs\n", clientIP, t)
			}
			if playing, ok := msg["isPlaying"].(bool); ok {
				state.IsPlaying = playing
			}
			msg["server_ts"] = NowNTP().UnixMilli()
			saveAndPublish(client.RoomID, state, msg)

		case "shuffle":
			if st, ok := msg["state"].(bool); ok {
				state.IsShuffleGlobal = st
				saveAndPublish(client.RoomID, state, msg)
				log.Printf("[ACTION] Client %s SHUFFLE=%v\n", clientIP, st)
			}

		case "repeat":
			if st, ok := msg["state"].(float64); ok {
				state.IsRepeatGlobal = int(st)
				saveAndPublish(client.RoomID, state, msg)
				log.Printf("[ACTION] Client %s REPEAT=%d\n", clientIP, int(st))
			}

		case "volume":
			if vol, ok := msg["level"].(float64); ok {
				state.GlobalVolume = vol
				saveAndPublish(client.RoomID, state, msg)
				log.Printf("[ACTION] Client %s VOLUME=%.2f\n", clientIP, vol)
			}

		case "enqueue":
			if item, ok := msg["item"].(map[string]interface{}); ok {
				if len(state.Queue) >= 500 {
					log.Printf("[ACTION] Client %s enqueue rejected (queue full)\n", clientIP)
					return
				}
				item["id"] = float64(NowNTP().UnixNano())
				state.Queue = append(state.Queue, item)
				broadcastMsg := map[string]interface{}{"action": "queue_update", "queue": state.Queue}
				saveAndPublish(client.RoomID, state, broadcastMsg)
				log.Printf("[ACTION] Client %s enqueued: %v\n", clientIP, item["path"])
			}

		case "dequeue":
			removed := false
			if idVal, ok := msg["id"].(float64); ok {
				state.Queue, removed = removeQueueByID(state.Queue, idVal)
			} else if idx, ok := msg["index"].(float64); ok {
				state.Queue, removed = removeQueueByIndex(state.Queue, int(idx))
			}
			if removed {
				broadcastMsg := map[string]interface{}{"action": "queue_update", "queue": state.Queue}
				saveAndPublish(client.RoomID, state, broadcastMsg)
				log.Printf("[ACTION] Client %s dequeued\n", clientIP)
			}

		case "queue_move":
			if fromF, ok1 := msg["from"].(float64); ok1 {
				if toF, ok2 := msg["to"].(float64); ok2 {
					state.Queue = moveQueueItem(state.Queue, int(fromF), int(toF))
					broadcastMsg := map[string]interface{}{"action": "queue_update", "queue": state.Queue}
					saveAndPublish(client.RoomID, state, broadcastMsg)
					log.Printf("[ACTION] Client %s moved queue %d→%d\n", clientIP, int(fromF), int(toF))
				}
			}
		}
	})
}
