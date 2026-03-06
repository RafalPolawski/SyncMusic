package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"log"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
	"net"
	"strings"

	"github.com/dhowden/tag"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
)

type WTClient struct {
	Session *webtransport.Session
	Stream  *webtransport.Stream
	mu      sync.Mutex
}

var clients = make(map[*WTClient]bool)
var mutex sync.Mutex

var stateMutex sync.Mutex
var currentSong string
var isPlaying bool
var currentPosition float64
var lastUpdate time.Time
var isShuffleGlobal bool
var isRepeatGlobal int
var currentFolder string

var certHashStr string

// ----------------------
// LIBRARY CACHING SYSTEM
// ----------------------
var (
	cachedSongs   []SongMeta
	libraryMutex  sync.RWMutex
	libraryLoaded bool
)

type SongMeta struct {
	Path   string `json:"path"`
	Title  string `json:"title"`
	Artist string `json:"artist"`
}

func handleGetSongs(w http.ResponseWriter, r *http.Request) {
	libraryMutex.RLock()
	if libraryLoaded && len(cachedSongs) > 0 {
		libraryMutex.RUnlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(cachedSongs)
		return
	}
	libraryMutex.RUnlock()

	libraryMutex.Lock()
	if libraryLoaded {
		defer libraryMutex.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(cachedSongs)
		return
	}

	var tempSongs []SongMeta
	var paths []string

	err := filepath.Walk("./music", func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		ext := strings.ToLower(filepath.Ext(path))
		validExts := map[string]bool{
			".opus": true, ".mp3": true, ".flac": true,
			".wav": true, ".ogg": true, ".m4a": true, ".aac": true,
		}
		if !info.IsDir() && validExts[ext] {
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

	var wg sync.WaitGroup
	var resultsMutex sync.Mutex
	semaphore := make(chan struct{}, 20)

	for _, p := range paths {
		wg.Add(1)
		semaphore <- struct{}{}

		go func(path string) {
			defer wg.Done()
			defer func() { <-semaphore }()

			relPath, _ := filepath.Rel("music", path)
			relPath = filepath.ToSlash(relPath)

			f, fsErr := os.Open(path)
			if fsErr != nil {
				return
			}
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

			resultsMutex.Lock()
			tempSongs = append(tempSongs, SongMeta{
				Path:   relPath,
				Title:  title,
				Artist: artist,
			})
			resultsMutex.Unlock()
		}(p)
	}

	wg.Wait()

	cachedSongs = tempSongs
	libraryLoaded = true
	libraryMutex.Unlock()

	log.Printf("[INFO] Master library compiled into RAM successfully! Cached %d tracks.", len(cachedSongs))

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(cachedSongs)
}

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

func generateIdentity() (*tls.Certificate, string) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		log.Fatal(err)
	}

	notBefore := time.Now().Add(-1 * time.Hour)
	notAfter := notBefore.Add(10 * 24 * time.Hour)

	serialNumberLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serialNumber, err := rand.Int(rand.Reader, serialNumberLimit)
	if err != nil {
		log.Fatal(err)
	}

	template := x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			Organization: []string{"SyncMusic WT"},
		},
		NotBefore:             notBefore,
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{"localhost"},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	}

	derBytes, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		log.Fatal(err)
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: derBytes})
	keyPEM, _ := x509.MarshalECPrivateKey(priv)
	keyPemFile := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyPEM})

	tlsCert, err := tls.X509KeyPair(certPEM, keyPemFile)
	if err != nil {
		log.Fatal(err)
	}

	hash := sha256.Sum256(derBytes)
	hashStr := hex.EncodeToString(hash[:])

	return &tlsCert, hashStr
}

func handleWTSession(session *webtransport.Session) {
	clientIP := session.RemoteAddr().String()

	stream, err := session.AcceptStream(context.Background())
	if err != nil {
		log.Printf("[ERROR] WT failed to accept stream from %s: %v\n", clientIP, err)
		return
	}

	client := &WTClient{Session: session, Stream: stream}

	mutex.Lock()
	clients[client] = true
	totalClients := len(clients)
	mutex.Unlock()

	log.Printf("[INFO] WT Client connected: %s. Total clients: %d\n", clientIP, totalClients)

	defer func() {
		mutex.Lock()
		delete(clients, client)
		remaining := len(clients)
		mutex.Unlock()
		log.Printf("[INFO] WT Client disconnected: %s. Total clients: %d\n", clientIP, remaining)
		session.CloseWithError(0, "")
	}()

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
			"folder":    currentFolder,
		}
		b, _ := json.Marshal(syncMsg)
		client.mu.Lock()
		stream.Write(append(b, '\n'))
		client.mu.Unlock()
	} else {
		m1, _ := json.Marshal(map[string]interface{}{"action": "shuffle", "state": isShuffleGlobal})
		m2, _ := json.Marshal(map[string]interface{}{"action": "repeat", "state": isRepeatGlobal})
		client.mu.Lock()
		stream.Write(append(m1, '\n'))
		stream.Write(append(m2, '\n'))
		client.mu.Unlock()
	}
	stateMutex.Unlock()

	decoder := json.NewDecoder(stream)
	for {
		var msg map[string]interface{}
		err := decoder.Decode(&msg)
		if err != nil {
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
				if t, ok := msg["time"].(float64); ok {
					currentPosition = t
				}
				isPlaying = true
				lastUpdate = time.Now()
				log.Printf("[ACTION] Client %s pressed PLAY at %.2fs\n", clientIP, currentPosition)
			case "pause":
				if t, ok := msg["time"].(float64); ok {
					currentPosition = t
				}
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
			case "shuffle":
				if st, ok := msg["state"].(bool); ok {
					isShuffleGlobal = st
					stateStr := "OFF"
					if st {
						stateStr = "ON"
					}
					log.Printf("[ACTION] Client %s toggled SHUFFLE to %s\n", clientIP, stateStr)
				}
			case "repeat":
				if st, ok := msg["state"].(float64); ok {
					isRepeatGlobal = int(st)
					mode := "OFF"
					if isRepeatGlobal == 1 {
						mode = "PLAYLIST"
					} else if isRepeatGlobal == 2 {
						mode = "TRACK"
					}
					log.Printf("[ACTION] Client %s changed REPEAT to %s\n", clientIP, mode)
				}
			}
		}
		stateMutex.Unlock()

		outMsg, _ := json.Marshal(msg)
		outMsg = append(outMsg, '\n')

		mutex.Lock()
		for c := range clients {
			c.mu.Lock()
			c.Stream.Write(outMsg)
			c.mu.Unlock()
		}
		mutex.Unlock()
	}
}

func main() {
	tlsCert, hash := generateIdentity()
	certHashStr = hash
	log.Printf("[INFO] Initialized WebTransport TLS with hash: %s\n", certHashStr)

	apiMux := http.NewServeMux()
	apiMux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})
	apiMux.Handle("/music/", http.StripPrefix("/music/", http.FileServer(http.Dir("./music"))))
	
	apiMux.HandleFunc("/api/songs", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		handleGetSongs(w, r)
	})
	apiMux.HandleFunc("/api/cover", handleGetCover)
	
	apiMux.HandleFunc("/api/cert-hash", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"hash": certHashStr})
	})

	// Used by Caddy's on_demand_tls 'ask' to allow cert generation for any hostname
	apiMux.HandleFunc("/api/ok", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	wtServer := &webtransport.Server{
		H3: &http3.Server{
			Addr: ":4433",
			TLSConfig: &tls.Config{
				Certificates: []tls.Certificate{*tlsCert},
				NextProtos:   []string{"h3"},
			},
		},
		CheckOrigin: func(r *http.Request) bool { return true },
	}

	// This is the critical missing piece: Configure the H3 server correctly
	// with WebTransport settings (enables datagrams, configures context, sets SETTINGS frame)
	webtransport.ConfigureHTTP3Server(wtServer.H3)

	wtServer.H3.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/wt" {
			session, err := wtServer.Upgrade(w, r)
			if err != nil {
				log.Printf("[ERROR] WebTransport upgrade failed: %v\n", err)
				return
			}
			go handleWTSession(session)
			return
		}
		http.NotFound(w, r)
	})

	go func() {
		log.Println("[INFO] WebTransport UDP server listening on :4433")
		err := wtServer.ListenAndServe()
		if err != nil {
			log.Fatalf("[ERROR] WebTransport server failed: %v", err)
		}
	}()

	log.Println("[INFO] HTTP API Server listening on TCP :12137")
	log.Fatal(http.ListenAndServe(":12137", apiMux))
}