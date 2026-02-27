package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/dhowden/tag" // NOWA BIBLIOTEKA DO CZYTANIA TAGÓW!
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
var isShuffleGlobal bool // NOWE: Globalny stan Shuffle

// Pobieranie listy plików (bez zmian)
func handleGetSongs(w http.ResponseWriter, r *http.Request) {
	var songs []string
	err := filepath.Walk("./music", func(path string, info os.FileInfo, err error) error {
		if err != nil { return err }
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

// NOWA FUNKCJA: Wyciąganie okładki z pliku w locie!
func handleGetCover(w http.ResponseWriter, r *http.Request) {
	songPath := r.URL.Query().Get("song")
	if songPath == "" {
		http.Error(w, "Brak utworu", http.StatusBadRequest)
		return
	}

	// Zabezpieczenie ścieżki i otworzenie pliku z muzyką
	cleanPath := filepath.Clean(songPath)
	fullPath := filepath.Join("./music", cleanPath)
	f, err := os.Open(fullPath)
	if err != nil {
		http.Error(w, "Brak pliku", http.StatusNotFound)
		return
	}
	defer f.Close()

	// Czytamy metadane (tagi)
	m, err := tag.ReadFrom(f)
	if err != nil || m == nil {
		http.Error(w, "Brak metadanych", http.StatusNotFound)
		return
	}

	// Szukamy obrazka okładki
	pic := m.Picture()
	if pic == nil {
		http.Error(w, "Brak okładki", http.StatusNotFound)
		return
	}

	// Wysyłamy obrazek prosto do przeglądarki!
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
		log.Println(err)
		return
	}
	defer ws.Close()

	mutex.Lock()
	clients[ws] = true
	mutex.Unlock()

	// POWITANIE NOWEGO UŻYTKOWNIKA (wysyłamy też stan Shuffle!)
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
			"isShuffle": isShuffleGlobal, // Synchronizujemy Shuffle!
		}
		ws.WriteJSON(syncMsg)
	} else {
		// Jeśli nic nie gra, chociaż wyślijmy mu, czy shuffle jest włączone
		ws.WriteJSON(map[string]interface{}{
			"action":    "shuffle",
			"state":     isShuffleGlobal,
		})
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
				if t, ok := msg["time"].(float64); ok { currentPosition = t }
				isPlaying = true
				lastUpdate = time.Now()
			case "pause":
				if t, ok := msg["time"].(float64); ok { currentPosition = t }
				isPlaying = false
			case "seek":
				if t, ok := msg["time"].(float64); ok {
					currentPosition = t
					lastUpdate = time.Now()
				}
				if playing, ok := msg["isPlaying"].(bool); ok {
					isPlaying = playing
				}
			// NOWE: Zapamiętujemy Shuffle globalnie
			case "shuffle":
				if st, ok := msg["state"].(bool); ok {
					isShuffleGlobal = st
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
	http.Handle("/", http.FileServer(http.Dir("./frontend")))
	http.Handle("/music/", http.StripPrefix("/music/", http.FileServer(http.Dir("./music"))))
	http.HandleFunc("/api/songs", handleGetSongs)
	
	// NOWY ENDPOINT DLA OKŁADEK!
	http.HandleFunc("/api/cover", handleGetCover)
	
	http.HandleFunc("/ws", handleConnections)

	log.Println("Serwer wystartował na porcie :12137!")
	log.Fatal(http.ListenAndServe(":12137", nil))
}