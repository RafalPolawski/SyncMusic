package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/go-redsync/redsync/v4"
	"github.com/go-redsync/redsync/v4/redis/goredis/v9"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client
var rs *redsync.Redsync
var ctx = context.Background()

var (
	lockDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "syncmusic_redis_lock_acquisition_duration_seconds",
		Help:    "Time spent waiting for Redis distributed lock",
		Buckets: prometheus.DefBuckets,
	}, []string{"room_id"})

	lockErrors = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "syncmusic_redis_lock_errors_total",
		Help: "Total number of Redis lock acquisition/release errors",
	}, []string{"room_id", "op"})
)

func getRoomStateKey(roomID string) string { return "syncmusic:room_state:" + roomID }
func getPubsubChannel(roomID string) string { return "syncmusic:room_events:" + roomID }

// withStateLock serializes state mutations with a distributed Redis lock (Redlock).
// This allows multiple backend instances to safely manage room state.
func withStateLock(roomID string, fn func()) {
	mutex := rs.NewMutex("syncmusic:lock:room:" + roomID)

	start := time.Now()
	if err := mutex.Lock(); err != nil {
		log.Printf("[ERROR] Failed to acquire Redis lock for room %s: %v\n", roomID, err)
		lockErrors.WithLabelValues(roomID, "lock").Inc()
		return
	}
	lockDuration.WithLabelValues(roomID).Observe(time.Since(start).Seconds())

	defer func() {
		if ok, err := mutex.Unlock(); !ok || err != nil {
			log.Printf("[WARN] Failed to release Redis lock for room %s: %v\n", roomID, err)
			lockErrors.WithLabelValues(roomID, "unlock").Inc()
		}
	}()

	fn()
}

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

	// Retry connect up to 5 times (container startup race)
	for i := 0; i < 5; i++ {
		if err := rdb.Ping(ctx).Err(); err == nil {
			log.Println("[INFO] Connected to Redis successfully.")
			break
		}
		log.Printf("[WARN] Redis not ready (attempt %d/5), retrying in 2s...", i+1)
		time.Sleep(2 * time.Second)
	}

	// Initialize redsync for distributed locking
	pool := goredis.NewPool(rdb)
	rs = redsync.New(pool)
}

func subscribeRedis() {
	pubsub := rdb.PSubscribe(ctx, "syncmusic:room_events:*")
	ch := pubsub.Channel()
	go func() {
		for msg := range ch {
			roomID := msg.Channel[len("syncmusic:room_events:"):]
			globalLocalClients.BroadcastToRoom(roomID, append([]byte(msg.Payload), '\n'))
		}
	}()
	log.Println("[INFO] Listening on Redis Pub/Sub pattern: syncmusic:room_events:*")
}

// subscribeRedis listens for room events globally.
// saveAndPublish writes room state and broadcasts the event in a single
// Redis pipeline — halves the number of round-trips vs two separate calls.
func saveAndPublish(roomID string, state RoomState, msg map[string]interface{}) {
	isPlaying := 0
	if state.IsPlaying {
		isPlaying = 1
	}
	isShuffle := 0
	if state.IsShuffleGlobal {
		isShuffle = 1
	}
	qBytes, _ := json.Marshal(state.Queue)
	msgBytes, _ := json.Marshal(msg)

	pipe := rdb.Pipeline()
	pipe.HSet(ctx, getRoomStateKey(roomID), map[string]interface{}{
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
	pipe.Expire(ctx, getRoomStateKey(roomID), 1*time.Hour)
	pipe.Publish(ctx, getPubsubChannel(roomID), string(msgBytes))
	if _, err := pipe.Exec(ctx); err != nil {
		log.Printf("[ERROR] Redis pipeline error: %v\n", err)
	}
}

// SaveRoomState persists state only (no broadcast). Use saveAndPublish when
// a broadcast is also needed.
func SaveRoomState(roomID string, state RoomState) {
	isPlaying := 0
	if state.IsPlaying {
		isPlaying = 1
	}
	isShuffle := 0
	if state.IsShuffleGlobal {
		isShuffle = 1
	}
	qBytes, _ := json.Marshal(state.Queue)

	rdb.HSet(ctx, getRoomStateKey(roomID), map[string]interface{}{
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
	rdb.Expire(ctx, getRoomStateKey(roomID), 1*time.Hour)
}

// RoomState is the parsed in-memory representation of the room.
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

func GetRoomState(roomID string) RoomState {
	res, _ := rdb.HGetAll(ctx, getRoomStateKey(roomID)).Result()

	if len(res) == 0 {
		return RoomState{
			GlobalVolume: 1.0,
			LastUpdate:   time.Now(),
		}
	}

	isPlaying, _ := strconv.Atoi(res["IsPlaying"])
	currentPos, _ := strconv.ParseFloat(res["CurrentPosition"], 64)
	lastUpdateUnix, errLU := strconv.ParseInt(res["LastUpdate"], 10, 64)
	if errLU != nil {
		lastUpdateUnix = time.Now().UnixMilli()
	}
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
