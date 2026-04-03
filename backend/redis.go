package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client
var ctx = context.Background()

const roomStateKey = "syncmusic:room_state"
const pubsubChannel = "syncmusic:room_events"
const lockKey = "syncmusic:room_lock"

func initRedis() {
	redisUrl := os.Getenv("REDIS_URL")
	if redisUrl == "" {
		redisUrl = "redis://localhost:6379/0"
	}

	opts, err := redis.ParseURL(redisUrl)
	if err != nil {
		log.Fatalf("[ERROR] Failed to parse Redis URL: %v", err)
	}

	rdb = redis.NewClient(opts)

	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Printf("[WARN] Failed to connect to Redis initially: %v. Retrying...", err)
		for i := 0; i < 5; i++ {
			time.Sleep(2 * time.Second)
			if err := rdb.Ping(ctx).Err(); err == nil {
				log.Println("[INFO] Successfully connected to Redis after retrying.")
				break
			}
		}
	} else {
		log.Println("[INFO] Connected to Redis successfully.")
	}

	// Create default state if empty
	if rdb.Exists(ctx, roomStateKey).Val() == 0 {
		rdb.HSet(ctx, roomStateKey, map[string]interface{}{
			"CurrentSong":     "",
			"IsPlaying":       0, // 0 or 1
			"CurrentPosition": 0.0,
			"LastUpdate":      time.Now().UnixMilli(),
			"IsShuffleGlobal": 0, // 0 or 1
			"IsRepeatGlobal":  0,
			"CurrentFolder":   "",
			"GlobalVolume":    1.0,
			"Queue":           "[]",
		})
	}
}

func subscribeRedis() {
	pubsub := rdb.Subscribe(ctx, pubsubChannel)
	ch := pubsub.Channel()
	go func() {
		for msg := range ch {
			globalLocalClients.Broadcast([]byte(msg.Payload + "\n"))
		}
	}()
	log.Println("[INFO] Listening on Redis Pub/Sub channel:", pubsubChannel)
}

func publishEvent(msg map[string]interface{}) {
	b, _ := json.Marshal(msg)
	err := rdb.Publish(ctx, pubsubChannel, string(b)).Err()
	if err != nil {
		log.Printf("[ERROR] Redis publish error: %v\n", err)
	}
}

// State Mutex using Redis setnx
func lockState() bool {
	acquired, _ := rdb.SetNX(ctx, lockKey, "locked", 5*time.Second).Result()
	return acquired
}

func unlockState() {
	rdb.Del(ctx, lockKey)
}

// Acquire with retries
func withStateLock(fn func()) {
	for i := 0; i < 20; i++ {
		if lockState() {
			defer unlockState()
			fn()
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	log.Println("[ERROR] Failed to acquire Redis state lock")
}

// RoomState defines the parsed state of the room
type RoomState struct {
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

func GetRoomState() RoomState {
	res, _ := rdb.HGetAll(ctx, roomStateKey).Result()

	isPlaying, _ := strconv.Atoi(res["IsPlaying"])
	currentPos, _ := strconv.ParseFloat(res["CurrentPosition"], 64)
	lastUpdateUnix, _ := strconv.ParseInt(res["LastUpdate"], 10, 64)
	isShuffle, _ := strconv.Atoi(res["IsShuffleGlobal"])
	isRepeat, _ := strconv.Atoi(res["IsRepeatGlobal"])
	globalVol, err := strconv.ParseFloat(res["GlobalVolume"], 64)
	if err != nil {
		globalVol = 1.0
	}

	queueStr := res["Queue"]
	if queueStr == "" {
		queueStr = "[]"
	}
	var queue []map[string]interface{}
	json.Unmarshal([]byte(queueStr), &queue)

	return RoomState{
		CurrentSong:     res["CurrentSong"],
		IsPlaying:       isPlaying == 1,
		CurrentPosition: currentPos,
		LastUpdate:      time.UnixMilli(lastUpdateUnix),
		IsShuffleGlobal: isShuffle == 1,
		IsRepeatGlobal:  isRepeat,
		CurrentFolder:   res["CurrentFolder"],
		GlobalVolume:    globalVol,
		Queue:           queue,
	}
}

func SaveRoomState(state RoomState) {
	isPlaying := 0
	if state.IsPlaying {
		isPlaying = 1
	}
	isShuffle := 0
	if state.IsShuffleGlobal {
		isShuffle = 1
	}
	qBytes, _ := json.Marshal(state.Queue)

	rdb.HSet(ctx, roomStateKey, map[string]interface{}{
		"CurrentSong":     state.CurrentSong,
		"IsPlaying":       isPlaying,
		"CurrentPosition": state.CurrentPosition,
		"LastUpdate":      state.LastUpdate.UnixMilli(),
		"IsShuffleGlobal": isShuffle,
		"IsRepeatGlobal":  state.IsRepeatGlobal,
		"CurrentFolder":   state.CurrentFolder,
		"GlobalVolume":    state.GlobalVolume,
		"Queue":           string(qBytes),
	})
}
