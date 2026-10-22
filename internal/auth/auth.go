// Package auth implements the shared-password login: a correct password is
// exchanged for a long lived, HMAC signed session cookie. The cookie is sent
// automatically with audio, cover and WebSocket requests, so offline-capable
// clients stay logged in without storing the password.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// CookieName is the session cookie.
const CookieName = "syncmusic_session"

// Manager issues and verifies sessions.
type Manager struct {
	required bool
	pwHash   [32]byte
	key      []byte
	ttl      time.Duration
	now      func() time.Time
}

// New creates a manager. An empty password disables authentication.
func New(password string, secret []byte, ttl time.Duration) *Manager {
	m := &Manager{required: password != "", ttl: ttl, now: time.Now}
	m.pwHash = sha256.Sum256([]byte(password))
	// Deriving the signing key from the password invalidates all sessions
	// when the password changes.
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte("syncmusic-session-v1"))
	mac.Write(m.pwHash[:])
	m.key = mac.Sum(nil)
	return m
}

// Required reports whether a password is configured.
func (m *Manager) Required() bool { return m.required }

// CheckPassword compares in constant time.
func (m *Manager) CheckPassword(pw string) bool {
	h := sha256.Sum256([]byte(pw))
	return subtle.ConstantTimeCompare(h[:], m.pwHash[:]) == 1
}

// Issue creates a new session token and its expiry.
func (m *Manager) Issue() (string, time.Time) {
	now := m.now()
	exp := now.Add(m.ttl)
	nonce := make([]byte, 12)
	_, _ = rand.Read(nonce)
	payload := "v1." + strconv.FormatInt(now.Unix(), 10) + "." + strconv.FormatInt(exp.Unix(), 10) + "." + hex.EncodeToString(nonce)
	enc := base64.RawURLEncoding.EncodeToString([]byte(payload))
	return enc + "." + m.sign(enc), exp
}

func (m *Manager) sign(s string) string {
	mac := hmac.New(sha256.New, m.key)
	mac.Write([]byte(s))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// ErrInvalidToken is returned for tampered, malformed or expired tokens.
var ErrInvalidToken = errors.New("invalid session")

// Verify checks a token's signature and expiry.
func (m *Manager) Verify(token string) error {
	enc, sig, ok := strings.Cut(token, ".")
	if !ok || !hmac.Equal([]byte(sig), []byte(m.sign(enc))) {
		return ErrInvalidToken
	}
	raw, err := base64.RawURLEncoding.DecodeString(enc)
	if err != nil {
		return ErrInvalidToken
	}
	parts := strings.Split(string(raw), ".")
	if len(parts) != 4 || parts[0] != "v1" {
		return ErrInvalidToken
	}
	exp, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil || m.now().Unix() >= exp {
		return ErrInvalidToken
	}
	return nil
}

// Authenticated reports whether the request carries a valid session (or
// authentication is disabled).
func (m *Manager) Authenticated(r *http.Request) bool {
	if !m.required {
		return true
	}
	c, err := r.Cookie(CookieName)
	if err != nil {
		return false
	}
	return m.Verify(c.Value) == nil
}

// Middleware rejects unauthenticated requests with 401.
func (m *Manager) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !m.Authenticated(r) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// SetCookie writes the session cookie.
func SetCookie(w http.ResponseWriter, token string, exp time.Time, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    token,
		Path:     "/",
		Expires:  exp,
		MaxAge:   int(time.Until(exp).Seconds()),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
}

// ClearCookie removes the session cookie.
func ClearCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name: CookieName, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode,
	})
}

// LoadOrCreateSecret returns the configured secret or a random one persisted
// in dir/session.key (created with mode 0600).
func LoadOrCreateSecret(configured, dir string) ([]byte, error) {
	if configured != "" {
		return []byte(configured), nil
	}
	path := filepath.Join(dir, "session.key")
	if b, err := os.ReadFile(path); err == nil {
		key, err := hex.DecodeString(strings.TrimSpace(string(b)))
		if err == nil && len(key) >= 32 {
			return key, nil
		}
		return nil, fmt.Errorf("%s is corrupt; delete it to generate a new one (all sessions will be logged out)", path)
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, []byte(hex.EncodeToString(key)+"\n"), 0o600); err != nil {
		return nil, fmt.Errorf("write session key: %w", err)
	}
	return key, nil
}

// Limiter rate limits login attempts per client IP.
type Limiter struct {
	mu      sync.Mutex
	every   rate.Limit
	burst   int
	clients map[string]*limiterEntry
	now     func() time.Time
}

type limiterEntry struct {
	lim  *rate.Limiter
	seen time.Time
}

// NewLimiter allows burst attempts and then one per interval.
func NewLimiter(interval time.Duration, burst int) *Limiter {
	return &Limiter{every: rate.Every(interval), burst: burst, clients: map[string]*limiterEntry{}, now: time.Now}
}

// Allow reports whether ip may attempt a login now.
func (l *Limiter) Allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if len(l.clients) > 10000 {
		for k, e := range l.clients {
			if now.Sub(e.seen) > time.Hour {
				delete(l.clients, k)
			}
		}
	}
	e, ok := l.clients[ip]
	if !ok {
		e = &limiterEntry{lim: rate.NewLimiter(l.every, l.burst)}
		l.clients[ip] = e
	}
	e.seen = now
	return e.lim.AllowN(now, 1)
}

// ClientIP extracts the client address, honouring X-Forwarded-For only when
// the server sits behind a trusted proxy.
func ClientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			first, _, _ := strings.Cut(xff, ",")
			if ip := strings.TrimSpace(first); ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// IsSecure decides the Secure cookie flag: "true"/"false" force it, "auto"
// enables it for TLS requests (directly or via a trusted proxy).
func IsSecure(r *http.Request, mode string, trustProxy bool) bool {
	switch mode {
	case "true":
		return true
	case "false":
		return false
	}
	if r.TLS != nil {
		return true
	}
	return trustProxy && strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}
