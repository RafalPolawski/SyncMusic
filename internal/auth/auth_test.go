package auth

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPasswordAndTokens(t *testing.T) {
	m := New("hunter2", []byte("0123456789abcdef0123456789abcdef"), time.Hour)
	if !m.Required() || !m.CheckPassword("hunter2") || m.CheckPassword("hunter3") || m.CheckPassword("") {
		t.Fatal("password check")
	}
	tok, exp := m.Issue()
	if err := m.Verify(tok); err != nil {
		t.Fatalf("fresh token rejected: %v", err)
	}
	if time.Until(exp) < 59*time.Minute {
		t.Fatalf("expiry = %v", exp)
	}
	tok2, _ := m.Issue()
	if tok == tok2 {
		t.Fatal("tokens must be unique")
	}

	// Tampering.
	enc, sig, _ := strings.Cut(tok, ".")
	for _, bad := range []string{"", "x", enc + ".", enc + "." + sig + "x", "AAAA." + sig, enc[1:] + "." + sig} {
		if m.Verify(bad) == nil {
			t.Errorf("tampered token %q accepted", bad)
		}
	}

	// Expiry.
	m.now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	if m.Verify(tok) == nil {
		t.Fatal("expired token accepted")
	}
}

func TestPasswordChangeInvalidatesSessions(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	tok, _ := New("old", secret, time.Hour).Issue()
	if New("new", secret, time.Hour).Verify(tok) == nil {
		t.Fatal("token survived a password change")
	}
	if New("old", []byte("another-secret-another-secret-xx"), time.Hour).Verify(tok) == nil {
		t.Fatal("token survived a secret change")
	}
}

func TestMiddleware(t *testing.T) {
	m := New("pw", []byte("0123456789abcdef0123456789abcdef"), time.Hour)
	h := m.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/library", nil))
	if rec.Code != 401 {
		t.Fatalf("no cookie: %d", rec.Code)
	}

	tok, exp := m.Issue()
	cookieRec := httptest.NewRecorder()
	SetCookie(cookieRec, tok, exp, true)
	cookie := cookieRec.Result().Cookies()[0]
	if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/" {
		t.Fatalf("cookie attributes: %+v", cookie)
	}
	req := httptest.NewRequest("GET", "/api/library", nil)
	req.AddCookie(cookie)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 204 {
		t.Fatalf("valid cookie: %d", rec.Code)
	}

	open := New("", []byte("x"), time.Hour)
	rec = httptest.NewRecorder()
	open.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })).
		ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != 204 || open.Required() {
		t.Fatal("auth disabled should let everything through")
	}

	clear := httptest.NewRecorder()
	ClearCookie(clear, false)
	if c := clear.Result().Cookies()[0]; c.MaxAge >= 0 || c.Value != "" {
		t.Fatalf("clear cookie: %+v", c)
	}
}

func TestLoadOrCreateSecret(t *testing.T) {
	dir := t.TempDir()
	a, err := LoadOrCreateSecret("", dir)
	if err != nil || len(a) != 32 {
		t.Fatalf("create: %v %d", err, len(a))
	}
	fi, err := os.Stat(filepath.Join(dir, "session.key"))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("key file mode: %v %v", fi, err)
	}
	b, err := LoadOrCreateSecret("", dir)
	if err != nil || string(a) != string(b) {
		t.Fatal("secret not persisted")
	}
	c, _ := LoadOrCreateSecret("configured", dir)
	if string(c) != "configured" {
		t.Fatal("configured secret ignored")
	}
	if err := os.WriteFile(filepath.Join(dir, "session.key"), []byte("zz"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreateSecret("", dir); err == nil {
		t.Fatal("corrupt key should be reported")
	}
}

func TestLimiter(t *testing.T) {
	l := NewLimiter(time.Minute, 3)
	now := time.Unix(1000, 0)
	l.now = func() time.Time { return now }
	for i := range 3 {
		if l.Blocked("1.2.3.4") {
			t.Fatalf("blocked after %d failures", i)
		}
		l.Fail("1.2.3.4")
	}
	if !l.Blocked("1.2.3.4") {
		t.Fatal("should be blocked after 3 failures")
	}
	if l.Blocked("5.6.7.8") {
		t.Fatal("other IPs are independent")
	}
	now = now.Add(time.Minute)
	if l.Blocked("1.2.3.4") {
		t.Fatal("a token should refill")
	}
}

func TestClientIPAndSecure(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "10.0.0.5:1234"
	r.Header.Set("X-Forwarded-For", "100.64.0.9, 10.0.0.1")
	r.Header.Set("X-Forwarded-Proto", "https")
	if ClientIP(r, false) != "10.0.0.5" || ClientIP(r, true) != "100.64.0.9" {
		t.Fatal("ClientIP")
	}
	if IsSecure(r, "auto", false) || !IsSecure(r, "auto", true) || !IsSecure(r, "true", false) || IsSecure(r, "false", true) {
		t.Fatal("IsSecure")
	}
	r.TLS = &tls.ConnectionState{}
	if !IsSecure(r, "auto", false) {
		t.Fatal("TLS request is secure")
	}
	r.RemoteAddr = "garbage"
	if ClientIP(r, false) != "garbage" {
		t.Fatal("unparsable remote addr")
	}
}
