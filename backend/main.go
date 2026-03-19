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
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/dhowden/tag"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
)

type WTClient struct {
	Session  *webtransport.Session
	Stream   *webtransport.Stream
	SendChan chan []byte
	cancel   context.CancelFunc
	Nickname string
}

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
		GlobalVolume: 1.0, // Default 100%
		Queue:        make([]map[string]interface{}, 0),
	}
}

var globalRoom = NewRoom()

func (r *Room) Broadcast(msg []byte) {
	r.ClientsMutex.Lock()
	defer r.ClientsMutex.Unlock()
	for c := range r.Clients {
		select {
		case c.SendChan <- msg:
		default:
			log.Printf("[WARN] Client SendChan full, dropping message\n")
		}
	}
}

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

var certHashStr string

// initDB() from db.go will handle setup

// -- Cover art in-memory cache --
type cachedCover struct {
	data        []byte
	contentType string
}

var coverCache sync.Map // map[string]*cachedCover

type SongMeta struct {
	Path   string `json:"path"`
	Title  string `json:"title"`
	Artist string `json:"artist"`
}

func handleGetSongs(w http.ResponseWriter, r *http.Request) {
	status := GetScanStatus()
	if status.IsScanning {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(status)
		return
	}

	songs, err := getSongsFromDB()
	if err != nil {
		log.Printf("[ERROR] Database query Failed: %v\n", err)
		http.Error(w, "Failed to load songs from database", http.StatusInternalServerError)
		return
	}

	// First run, empty DB fallback
	if len(songs) == 0 {
		go scanLibraryToDB()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(GetScanStatus())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(songs)
}

func handleGetCover(w http.ResponseWriter, r *http.Request) {
	songPath := r.URL.Query().Get("song")
	if songPath == "" {
		http.Error(w, "Missing song parameter", http.StatusBadRequest)
		return
	}

	cleanPath := filepath.Clean(songPath)

	// Serve from in-memory cache if available
	if cached, ok := coverCache.Load(cleanPath); ok {
		c := cached.(*cachedCover)
		w.Header().Set("Content-Type", c.contentType)
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.Write(c.data)
		return
	}

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

	// Store in cache for future requests
	coverCache.Store(cleanPath, &cachedCover{data: pic.Data, contentType: contentType})

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=86400")
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
	totalClients := len(globalRoom.Clients)
	globalRoom.ClientsMutex.Unlock()

	log.Printf("[INFO] WT Client connected: %s. Total clients: %d\n", clientIP, totalClients)

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
		client.SendChan <- append(b, '\n')
	} else {
		m1, _ := json.Marshal(map[string]interface{}{"action": "shuffle", "state": globalRoom.IsShuffleGlobal})
		m2, _ := json.Marshal(map[string]interface{}{"action": "repeat", "state": globalRoom.IsRepeatGlobal})
		m3, _ := json.Marshal(map[string]interface{}{"action": "queue_update", "queue": globalRoom.Queue})
		client.SendChan <- append(m1, '\n')
		client.SendChan <- append(m2, '\n')
		client.SendChan <- append(m3, '\n')
	}
	globalRoom.StateMutex.Unlock()

	decoder := json.NewDecoder(stream)
	for {
		var msg map[string]interface{}
		err := decoder.Decode(&msg)
		if err != nil {
			break
		}

		globalRoom.StateMutex.Lock()
		if action, ok := msg["action"].(string); ok {
			switch action {
			case "join":
				if nick, ok := msg["nickname"].(string); ok {
					client.Nickname = nick
					log.Printf("[INFO] Client %s associated with nickname: %s\n", clientIP, nick)
				}
				globalRoom.StateMutex.Unlock()
				globalRoom.BroadcastPresence()
				continue // Do not blindly broadcast join

			case "ping":
				if clientTime, ok := msg["clientTime"].(float64); ok {
					pongMsg := map[string]interface{}{
						"action":     "pong",
						"clientTime": clientTime,
						"serverTime": time.Now().UnixMilli(),
					}
					b, _ := json.Marshal(pongMsg)
					client.SendChan <- append(b, '\n')
				}
				globalRoom.StateMutex.Unlock()
				continue // Do not broadcast ping

			case "load":
				if s, ok := msg["song"].(string); ok {
					globalRoom.CurrentSong = s
					globalRoom.CurrentPosition = 0
					globalRoom.IsPlaying = true
					globalRoom.LastUpdate = time.Now()
					log.Printf("[ACTION] Client %s loaded song: %s\n", clientIP, s)
				}
				if f, ok := msg["folder"].(string); ok {
					globalRoom.CurrentFolder = f
					log.Printf("[ACTION] Client %s set active folder to: %s\n", clientIP, f)
				}
				msg["server_ts"] = time.Now().UnixMilli()
			case "play":
				if t, ok := msg["time"].(float64); ok {
					globalRoom.CurrentPosition = t
				}
				globalRoom.IsPlaying = true
				globalRoom.LastUpdate = time.Now()
				msg["server_ts"] = time.Now().UnixMilli()
				log.Printf("[ACTION] Client %s pressed PLAY at %.2fs\n", clientIP, globalRoom.CurrentPosition)
			case "pause":
				if t, ok := msg["time"].(float64); ok {
					globalRoom.CurrentPosition = t
				}
				globalRoom.IsPlaying = false
				msg["server_ts"] = time.Now().UnixMilli()
				log.Printf("[ACTION] Client %s pressed PAUSE at %.2fs\n", clientIP, globalRoom.CurrentPosition)
			case "seek":
				if t, ok := msg["time"].(float64); ok {
					globalRoom.CurrentPosition = t
					globalRoom.LastUpdate = time.Now()
					log.Printf("[ACTION] Client %s SEEK to %.2fs\n", clientIP, globalRoom.CurrentPosition)
				}
				if playing, ok := msg["isPlaying"].(bool); ok {
					globalRoom.IsPlaying = playing
				}
				msg["server_ts"] = time.Now().UnixMilli()
			case "shuffle":
				if st, ok := msg["state"].(bool); ok {
					globalRoom.IsShuffleGlobal = st
					stateStr := "OFF"
					if st {
						stateStr = "ON"
					}
					log.Printf("[ACTION] Client %s toggled SHUFFLE to %s\n", clientIP, stateStr)
				}
			case "repeat":
				if st, ok := msg["state"].(float64); ok {
					globalRoom.IsRepeatGlobal = int(st)
					mode := "OFF"
					if globalRoom.IsRepeatGlobal == 1 {
						mode = "PLAYLIST"
					} else if globalRoom.IsRepeatGlobal == 2 {
						mode = "TRACK"
					}
					log.Printf("[ACTION] Client %s changed REPEAT to %s\n", clientIP, mode)
				}
			case "volume":
				if vol, ok := msg["level"].(float64); ok {
					globalRoom.GlobalVolume = vol
					log.Printf("[ACTION] Client %s changed VOLUME to %.2f\n", clientIP, vol)
				}
			case "enqueue":
				if item, ok := msg["item"].(map[string]interface{}); ok {
					item["id"] = float64(time.Now().UnixNano())
					globalRoom.Queue = append(globalRoom.Queue, item)
					queueMsg := map[string]interface{}{"action": "queue_update", "queue": globalRoom.Queue}
					b, _ := json.Marshal(queueMsg)
					globalRoom.Broadcast(append(b, '\n'))
					log.Printf("[ACTION] Client %s enqueued song: %v\n", clientIP, item["path"])
				}
				globalRoom.StateMutex.Unlock()
				continue // already broadcasted explicitly
			case "dequeue":
				if idVal, ok := msg["id"].(float64); ok {
					foundIdx := -1
					for i, qItem := range globalRoom.Queue {
						if qID, qOk := qItem["id"].(float64); qOk && qID == idVal {
							foundIdx = i
							break
						}
					}
					if foundIdx != -1 {
						globalRoom.Queue = append(globalRoom.Queue[:foundIdx], globalRoom.Queue[foundIdx+1:]...)
						queueMsg := map[string]interface{}{"action": "queue_update", "queue": globalRoom.Queue}
						b, _ := json.Marshal(queueMsg)
						globalRoom.Broadcast(append(b, '\n'))
						log.Printf("[ACTION] Client %s dequeued id: %v\n", clientIP, idVal)
					}
				} else if idx, ok := msg["index"].(float64); ok {
					i := int(idx)
					if i >= 0 && i < len(globalRoom.Queue) {
						globalRoom.Queue = append(globalRoom.Queue[:i], globalRoom.Queue[i+1:]...)
						queueMsg := map[string]interface{}{"action": "queue_update", "queue": globalRoom.Queue}
						b, _ := json.Marshal(queueMsg)
						globalRoom.Broadcast(append(b, '\n'))
						log.Printf("[ACTION] Client %s dequeued index: %d\n", clientIP, i)
					}
				}
				globalRoom.StateMutex.Unlock()
				continue // already broadcasted explicitly
			case "queue_move":
				if fromIdx, ok1 := msg["from"].(float64); ok1 {
					if toIdx, ok2 := msg["to"].(float64); ok2 {
						f := int(fromIdx)
						t := int(toIdx)
						if f >= 0 && f < len(globalRoom.Queue) && t >= 0 && t <= len(globalRoom.Queue) {
							item := globalRoom.Queue[f]
							globalRoom.Queue = append(globalRoom.Queue[:f], globalRoom.Queue[f+1:]...)
							
							var newQueue []map[string]interface{}
							if t == 0 {
								newQueue = append([]map[string]interface{}{item}, globalRoom.Queue...)
							} else if t >= len(globalRoom.Queue) {
								newQueue = append(globalRoom.Queue, item)
							} else {
								newQueue = append(newQueue, globalRoom.Queue[:t]...)
								newQueue = append(newQueue, item)
								newQueue = append(newQueue, globalRoom.Queue[t:]...)
							}
							globalRoom.Queue = newQueue
							
							queueMsg := map[string]interface{}{"action": "queue_update", "queue": globalRoom.Queue}
							b, _ := json.Marshal(queueMsg)
							globalRoom.Broadcast(append(b, '\n'))
							log.Printf("[ACTION] Client %s moved queue item from %d to %d\n", clientIP, f, t)
						}
					}
				}
				globalRoom.StateMutex.Unlock()
				continue
			}
		}
		globalRoom.StateMutex.Unlock()

		outMsg, _ := json.Marshal(msg)
		outMsg = append(outMsg, '\n')

		globalRoom.Broadcast(outMsg)
	}
}

func main() {
	initDB() // Initialize SQLite DB
	defer db.Close()

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

	apiMux.HandleFunc("/api/rescan", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		go func() {
			scanLibraryToDB()
		}()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "scanning"})
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
