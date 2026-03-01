package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/dhowden/tag"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

var clients = make(map[*websocket.Conn]bool)
var mutex sync.Mutex

var stateMutex sync.Mutex
var currentSong string
var isPlaying bool
var currentPosition float64
var lastUpdate time.Time
var isShuffleGlobal bool // Globalny stan Shuffle
var isRepeatGlobal int   // 0 = off, 1 = playlist, 2 = track
var currentFolder string // NOWE: Globalny folder playlisty

// ----------------------
// LIBRARY CACHING SYSTEM
// ----------------------
var (
	cachedSongs   []SongMeta
	libraryMutex  sync.RWMutex
	libraryLoaded bool
)

// Data structure mapped for Frontend Library 
type SongMeta struct {
	Path   string `json:"path"`
	Title  string `json:"title"`
	Artist string `json:"artist"`
}

// Fetching list of files with Metadata Parsing, Concurrency and RAM Caching
func handleGetSongs(w http.ResponseWriter, r *http.Request) {
	// 1. FAST PATH: Return from Memory Cache if already loaded
	libraryMutex.RLock()
	if libraryLoaded && len(cachedSongs) > 0 {
		libraryMutex.RUnlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(cachedSongs)
		return
	}
	libraryMutex.RUnlock()

	// 2. SLOW PATH: Build Cache using concurrency
	libraryMutex.Lock()
	// Double check pattern
	if libraryLoaded {
		defer libraryMutex.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(cachedSongs)
		return
	}

	var tempSongs []SongMeta
	var paths []string

	// Walk directory synchronously to gather all valid paths first
	err := filepath.Walk("./music", func(path string, info os.FileInfo, err error) error {
		if err != nil { return err }
		ext := filepath.Ext(path)
		if !info.IsDir() && ext == ".opus" {
			paths = append(paths, path)
		}
		return nil
	})

	if err != nil {
		libraryMutex.Unlock()
		log.Printf("[ERROR] Failed to walk music directory: %v\n", err)
		http.Error(w, "Failed to load songs", http.StatusInternalServerError)
		return
	}

	// 3. Process ID3 tags efficiently using a worker pool (20 concurrent handles to avoid OS limit)
	var wg sync.WaitGroup
	var resultsMutex sync.Mutex
	semaphore := make(chan struct{}, 20) 

	for _, p := range paths {
		wg.Add(1)
		semaphore <- struct{}{} // Block if 20 goroutines are running

		go func(path string) {
			defer wg.Done()
			defer func() { <-semaphore }()

			relPath, _ := filepath.Rel("music", path)
			relPath = filepath.ToSlash(relPath)
			
			f, fsErr := os.Open(path)
			if fsErr != nil { return }
			defer f.Close()

			fileName := filepath.Base(path)
			ext := filepath.Ext(path)
			title := fileName // fallback
			artist := "Unknown Artist"
			
			m, tagErr := tag.ReadFrom(f)
			if tagErr == nil && m != nil {
				if m.Title() != "" {
					title = m.Title()
				} else {
					title = title[:len(title)-len(ext)]
				}
				if m.Artist() != "" {
					artist = m.Artist()
				}
			} else {
				title = title[:len(title)-len(ext)]
			}

			// Save to temp array safely using mutex
			resultsMutex.Lock()
			tempSongs = append(tempSongs, SongMeta{
				Path:   relPath,
				Title:  title,
				Artist: artist,
			})
			resultsMutex.Unlock()
		}(p)
	}

	wg.Wait() // Wait for all tag reading to finish

	// Save to global RAM cache
	cachedSongs = tempSongs
	libraryLoaded = true
	libraryMutex.Unlock()

	log.Printf("[INFO] Master library compiled into RAM successfully! Cached %d tracks.", len(cachedSongs))

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(cachedSongs)
}

// NEW FUNCTION: Extracting cover art from file on the fly (Now with logging!)
func handleGetCover(w http.ResponseWriter, r *http.Request) {
	songPath := r.URL.Query().Get("song")
	if songPath == "" {
		http.Error(w, "Missing song parameter", http.StatusBadRequest)
		return
	}

	cleanPath := filepath.Clean(songPath)
	fullPath := filepath.Join("./music", cleanPath)
	f, err := os.Open(fullPath)
	if err != nil {
		log.Printf("[ERROR] Cannot open file: %s (%v)\n", fullPath, err)
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	defer f.Close()

	m, err := tag.ReadFrom(f)
	if err != nil || m == nil {
		log.Printf("[WARN] No ID3/Vorbis tags found in file: %s (%v)\n", fullPath, err)
		http.Error(w, "Metadata not found", http.StatusNotFound)
		return
	}

	pic := m.Picture()
	if pic == nil {
		log.Printf("[INFO] No cover picture embedded within tags for: %s\n", fullPath)
		http.Error(w, "Cover not found", http.StatusNotFound)
		return
	}

	contentType := pic.MIMEType
	if contentType == "" {
		contentType = "image/" + pic.Ext
	}
	w.Header().Set("Content-Type", contentType)
	w.Write(pic.Data)
}

func handleConnections(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[ERROR] WebSocket upgrade failed: %v\n", err)
		return
	}
	defer ws.Close()

	clientIP := ws.RemoteAddr().String()

	mutex.Lock()
	clients[ws] = true
	totalClients := len(clients)
	mutex.Unlock()

	log.Printf("[INFO] Client connected: %s. Total clients: %d\n", clientIP, totalClients)

	// GREETING NEW USER (we also send Shuffle state!)
	stateMutex.Lock()
	if currentSong != "" {
		pos := currentPosition
		if isPlaying {
			pos += time.Since(lastUpdate).Seconds()
		}
		syncMsg := map[string]interface{}{
			"action":    "sync",
			"song":      currentSong,
			"time":      pos,
			"isPlaying": isPlaying,
			"isShuffle": isShuffleGlobal,
			"isRepeat":  isRepeatGlobal,
			"folder":    currentFolder, // Synchronize folder
		}
		ws.WriteJSON(syncMsg)
	} else {
		ws.WriteJSON(map[string]interface{}{
			"action":    "shuffle",
			"state":     isShuffleGlobal,
		})
		ws.WriteJSON(map[string]interface{}{
			"action":    "repeat",
			"state":     isRepeatGlobal,
		})
	}
	stateMutex.Unlock()

	for {
		var msg map[string]interface{}
		err := ws.ReadJSON(&msg)
		if err != nil {
			mutex.Lock()
			delete(clients, ws)
			remainingClients := len(clients)
			mutex.Unlock()
			log.Printf("[INFO] Client disconnected: %s. Total clients: %d\n", clientIP, remainingClients)
			break
		}

		stateMutex.Lock()
		if action, ok := msg["action"].(string); ok {
			switch action {
			case "load":
				if s, ok := msg["song"].(string); ok {
					currentSong = s
					currentPosition = 0
					isPlaying = true
					lastUpdate = time.Now()
					log.Printf("[ACTION] Client %s loaded song: %s\n", clientIP, s)
				}
				if f, ok := msg["folder"].(string); ok {
					currentFolder = f
					log.Printf("[ACTION] Client %s set active folder to: %s\n", clientIP, f)
				}
			case "play":
				if t, ok := msg["time"].(float64); ok { currentPosition = t }
				isPlaying = true
				lastUpdate = time.Now()
				log.Printf("[ACTION] Client %s pressed PLAY at %.2fs\n", clientIP, currentPosition)
			case "pause":
				if t, ok := msg["time"].(float64); ok { currentPosition = t }
				isPlaying = false
				log.Printf("[ACTION] Client %s pressed PAUSE at %.2fs\n", clientIP, currentPosition)
			case "seek":
				if t, ok := msg["time"].(float64); ok {
					currentPosition = t
					lastUpdate = time.Now()
					log.Printf("[ACTION] Client %s SEEK to %.2fs\n", clientIP, currentPosition)
				}
				if playing, ok := msg["isPlaying"].(bool); ok {
					isPlaying = playing
				}
			// Remember Shuffle globally
			case "shuffle":
				if st, ok := msg["state"].(bool); ok {
					isShuffleGlobal = st
					stateStr := "OFF"
					if st { stateStr = "ON" }
					log.Printf("[ACTION] Client %s toggled SHUFFLE to %s\n", clientIP, stateStr)
				}
			// Remember Repeat globally
			case "repeat":
				if st, ok := msg["state"].(float64); ok { // JSON przysyła float64
					isRepeatGlobal = int(st)
					mode := "OFF"
					if isRepeatGlobal == 1 { mode = "PLAYLIST" } else if isRepeatGlobal == 2 { mode = "TRACK" }
					log.Printf("[ACTION] Client %s changed REPEAT to %s\n", clientIP, mode)
				}
			}
		}
		stateMutex.Unlock()

		mutex.Lock()
		for client := range clients {
			client.WriteJSON(msg)
		}
		mutex.Unlock()
	}
}

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(`<h1>Hello!</h1><p>Go backend is working correctly. Your frontend interface is now located at the Vite development address: <a href="http://localhost:5173">http://localhost:5173</a>.</p>`))
	})
	http.Handle("/music/", http.StripPrefix("/music/", http.FileServer(http.Dir("./music"))))
	http.HandleFunc("/api/songs", handleGetSongs)
	
	// NEW ENDPOINT FOR COVERS!
	http.HandleFunc("/api/cover", handleGetCover)
	
	http.HandleFunc("/ws", handleConnections)

	log.Println("[INFO] Server started safely on port :12137!")
	log.Fatal(http.ListenAndServe(":12137", nil))
}