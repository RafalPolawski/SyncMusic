package main

import (
	"crypto/tls"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/beevik/ntp"

	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
)

var ntpOffset time.Duration

func NowNTP() time.Time {
	return time.Now().Add(ntpOffset)
}

func main() {
	initDB()
	defer db.Close()
	initRedis()
	subscribeRedis()

	resp, err := ntp.Query("time.google.com")
	if err == nil {
		ntpOffset = resp.ClockOffset
		log.Printf("[INFO] NTP Time sync complete. Offset: %v\n", ntpOffset)
	} else {
		log.Printf("[WARN] NTP sync failed, using local HTTP server time: %v\n", err)
	}

	tlsCert, hash := generateIdentity()
	certHashStr = hash
	log.Printf("[INFO] Initialized WebTransport TLS with hash: %s\n", certHashStr)

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	mux.Handle("/music/", http.StripPrefix("/music/", http.FileServer(http.Dir("./music"))))

	// API Endpoints
	mux.HandleFunc("/api/songs",     authMiddleware(handleGetSongs, false)) 
	mux.HandleFunc("/api/cover",     handleGetCover)
	mux.HandleFunc("/api/cert-hash", handleCertHash)
	mux.HandleFunc("/api/rescan",    authMiddleware(handleRescan, true))
	mux.HandleFunc("/api/rooms",     handleGetRooms)
	mux.HandleFunc("/api/ok",        handleOK)

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
	webtransport.ConfigureHTTP3Server(wtServer.H3)

	// WebTransport upgrade (Protected with optional auth)
	wtHandler := authMiddleware(func(w http.ResponseWriter, r *http.Request) {
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
	}, false)

	wtServer.H3.Handler = wtHandler

	go func() {
		log.Println("[INFO] WebTransport UDP server listening on :4433")
		if err := wtServer.ListenAndServe(); err != nil {
			log.Fatalf("[ERROR] WebTransport server failed: %v", err)
		}
	}()

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("[INFO] HTTP API Server listening on TCP :%s\n", port)
	log.Fatal(http.ListenAndServe(fmt.Sprintf(":%s", port), mux))
}
