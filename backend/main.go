package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

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

func handleGetSongs(w http.ResponseWriter, r *http.Request) {
	var songs []string
	err := filepath.Walk("./music", func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		ext := filepath.Ext(path)
		if !info.IsDir() && (ext == ".mp3" || ext == ".opus") {
			relPath, _ := filepath.Rel("music", path)
			relPath = filepath.ToSlash(relPath)
			songs = append(songs, relPath)
		}
		return nil
	})

	if err != nil {
		http.Error(w, "Błąd", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(songs)
}

func handleConnections(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println(err)
		return
	}
	defer ws.Close()

	mutex.Lock()
	clients[ws] = true
	mutex.Unlock()

	log.Println("Nowy użytkownik podłączony!")

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
		}
		ws.WriteJSON(syncMsg)
	}
	stateMutex.Unlock()

	for {
		var msg map[string]interface{}
		err := ws.ReadJSON(&msg)
		if err != nil {
			mutex.Lock()
			delete(clients, ws)
			mutex.Unlock()
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
				}
			case "play":
				if t, ok := msg["time"].(float64); ok {
					currentPosition = t
				}
				isPlaying = true
				lastUpdate = time.Now()
			case "pause":
				if t, ok := msg["time"].(float64); ok {
					currentPosition = t
				}
				isPlaying = false
			case "seek":
				if t, ok := msg["time"].(float64); ok {
					currentPosition = t
					lastUpdate = time.Now()
				}
			}
		}
		stateMutex.Unlock()

		mutex.Lock()
		for client := range clients {
			err := client.WriteJSON(msg)
			if err != nil {
				client.Close()
				delete(clients, client)
			}
		}
		mutex.Unlock()
	}
}

func main() {
	http.Handle("/", http.FileServer(http.Dir("./frontend")))
	http.Handle("/music/", http.StripPrefix("/music/", http.FileServer(http.Dir("./music"))))
	http.HandleFunc("/api/songs", handleGetSongs)
	http.HandleFunc("/ws", handleConnections)

	log.Println("Serwer wystartował na porcie :12137! Z pamięcią stanu.")
	err := http.ListenAndServe(":12137", nil)
	if err != nil {
		log.Fatal("Błąd serwera: ", err)
	}
}