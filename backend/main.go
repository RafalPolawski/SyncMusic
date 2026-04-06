package main

import (
	"crypto/tls"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/beevik/ntp"
	"github.com/golang-jwt/jwt/v5"

	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
)

var ntpOffset time.Duration

func NowNTP() time.Time {
	return time.Now().Add(ntpOffset)
}

// Simple JWT middleware
func authMiddleware(next http.HandlerFunc, mandatory bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// CORS headers
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			if mandatory {
				http.Error(w, "Unauthorized: No token provided", http.StatusUnauthorized)
				return
			}
			next(w, r)
			return
		}

		tokenString := strings.TrimPrefix(authHeader, "Bearer ")
		// In a "not incredibly secure" app, we'll just parse the claims without strict RSA verification
		// to avoid complex JWKS fetching logic, but still check expiration.
		token, _, err := new(jwt.Parser).ParseUnverified(tokenString, jwt.MapClaims{})
		if err != nil {
			if mandatory {
				http.Error(w, "Unauthorized: Invalid token", http.StatusUnauthorized)
				return
			}
		} else {
			if claims, ok := token.Claims.(jwt.MapClaims); ok {
				if exp, ok := claims["exp"].(float64); ok {
					if time.Unix(int64(exp), 0).Before(NowNTP()) {
						if mandatory {
							http.Error(w, "Unauthorized: Token expired", http.StatusUnauthorized)
							return
						}
					}
				}
			}
		}

		next(w, r)
	}
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
	mux.HandleFunc("/api/songs",     authMiddleware(handleGetSongs, false)) // Optional auth for songs (allows offline)
	mux.HandleFunc("/api/cover",     handleGetCover)                      // Covers are public for simplicity
	mux.HandleFunc("/api/cert-hash", handleCertHash)
	mux.HandleFunc("/api/rescan",    authMiddleware(handleRescan, true))    // Rescan MUST be authenticated
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

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("[INFO] HTTP API Server listening on TCP :%s\n", port)
	log.Fatal(http.ListenAndServe(fmt.Sprintf(":%s", port), mux))
}
