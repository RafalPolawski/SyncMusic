package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/dhowden/tag"
)

// ── Cover art in-memory bounded LRU cache ─────────────────────────────────────

type cachedCover struct {
	data        []byte
	contentType string
}

const maxCoverCacheSize = 250 // ~25-50 MB depending on artwork size

var (
	coverCacheMutex sync.RWMutex
	coverCache      = make(map[string]*cachedCover)
	coverCacheKeys  []string
)

// SongMeta is the JSON shape returned by /api/songs.
type SongMeta struct {
	Path   string `json:"path"`
	Title  string `json:"title"`
	Artist string `json:"artist"`
	Size   int64  `json:"size"`
}

// handleGetSongs returns the song list or scan progress if a scan is running.
func handleGetSongs(w http.ResponseWriter, r *http.Request) {
	status := GetScanStatus()
	if status.IsScanning {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(status)
		return
	}

	songs, err := getSongsFromDB()
	if err != nil {
		log.Printf("[ERROR] Database query failed: %v\n", err)
		http.Error(w, "Failed to load songs from database", http.StatusInternalServerError)
		return
	}

	// First run: DB is empty — kick off a scan and return progress
	if len(songs) == 0 {
		go scanLibraryToDB()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(GetScanStatus())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(songs)
}

// handleGetCover serves embedded album art for a given song path.
func handleGetCover(w http.ResponseWriter, r *http.Request) {
	songPath := r.URL.Query().Get("song")
	if songPath == "" {
		http.Error(w, "Missing song parameter", http.StatusBadRequest)
		return
	}

	cleanPath := filepath.Clean(songPath)
	if strings.Contains(cleanPath, "..") || filepath.IsAbs(cleanPath) {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	// Serve from in-memory cache if available
	coverCacheMutex.RLock()
	if c, ok := coverCache[cleanPath]; ok {
		coverCacheMutex.RUnlock()
		w.Header().Set("Content-Type", c.contentType)
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.Write(c.data)
		return
	}
	coverCacheMutex.RUnlock()

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
		log.Printf("[WARN] No tags found in: %s (%v)\n", fullPath, err)
		http.Error(w, "Metadata not found", http.StatusNotFound)
		return
	}

	pic := m.Picture()
	if pic == nil {
		log.Printf("[INFO] No cover art in: %s\n", fullPath)
		http.Error(w, "Cover not found", http.StatusNotFound)
		return
	}

	contentType := pic.MIMEType
	if contentType == "" {
		contentType = "image/" + pic.Ext
	}

	// Store in bounded LRU cache
	coverCacheMutex.Lock()
	if _, exists := coverCache[cleanPath]; !exists {
		if len(coverCacheKeys) >= maxCoverCacheSize {
			oldest := coverCacheKeys[0]
			coverCacheKeys = coverCacheKeys[1:]
			delete(coverCache, oldest)
		}
		coverCacheKeys = append(coverCacheKeys, cleanPath)
		coverCache[cleanPath] = &cachedCover{data: pic.Data, contentType: contentType}
	}
	coverCacheMutex.Unlock()

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Write(pic.Data)
}

// handleRescan triggers an async library rescan.
func handleRescan(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	go scanLibraryToDB()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "scanning"})
}

// handleCertHash returns the WebTransport certificate hash so the browser
// can pin the self-signed cert.
func handleCertHash(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"hash": certHashStr})
}

// handleOK is used by Caddy's on_demand_tls 'ask' endpoint.
func handleOK(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}
