package main

import (
	"crypto/tls"
	"log"
	"net/http"

	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
)

func main() {
	initDB()
	defer db.Close()
	initRedis()
	subscribeRedis()

	tlsCert, hash := generateIdentity()
	certHashStr = hash
	log.Printf("[INFO] Initialized WebTransport TLS with hash: %s\n", certHashStr)

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	mux.Handle("/music/", http.StripPrefix("/music/", http.FileServer(http.Dir("./music"))))
	mux.HandleFunc("/api/songs", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		handleGetSongs(w, r)
	})
	mux.HandleFunc("/api/cover",     handleGetCover)
	mux.HandleFunc("/api/cert-hash", handleCertHash)
	mux.HandleFunc("/api/rescan",    handleRescan)
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
		if err := wtServer.ListenAndServe(); err != nil {
			log.Fatalf("[ERROR] WebTransport server failed: %v", err)
		}
	}()

	log.Println("[INFO] HTTP API Server listening on TCP :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}
