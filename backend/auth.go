package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type UserClaims struct {
	Username  string
	IsSSO     bool
	ExpiresAt time.Time
}

// ParseJWT extracts basic user information from a JWT without signature verification (for simplified security).
func ParseJWT(tokenString string) (*UserClaims, error) {
	token, _, err := new(jwt.Parser).ParseUnverified(tokenString, jwt.MapClaims{})
	if err != nil {
		return nil, err
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return nil, jwt.ErrInvalidKey
	}

	res := &UserClaims{
		Username: "Anonymous",
		IsSSO:    true,
	}

	if name, ok := claims["preferred_username"].(string); ok {
		res.Username = name
	} else if name, ok := claims["name"].(string); ok {
		res.Username = name
	}

	if exp, ok := claims["exp"].(float64); ok {
		res.ExpiresAt = time.Unix(int64(exp), 0)
	}

	return res, nil
}

// authMiddleware wraps a handler with optional or mandatory JWT check.
func authMiddleware(next http.HandlerFunc, mandatory bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Unified CORS
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
		claims, err := ParseJWT(tokenString)
		if err != nil {
			if mandatory {
				http.Error(w, "Unauthorized: Invalid token", http.StatusUnauthorized)
				return
			}
		} else {
			if !claims.ExpiresAt.IsZero() && claims.ExpiresAt.Before(NowNTP()) {
				if mandatory {
					http.Error(w, "Unauthorized: Token expired", http.StatusUnauthorized)
					return
				}
			}
		}

		next(w, r)
	}
}

// DecodeJWTBody is a helper for WebTransport sessions to extract nickname from token if present.
func DecodeJWTBody(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		PreferredUsername string `json:"preferred_username"`
		Name              string `json:"name"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return ""
	}
	if claims.PreferredUsername != "" {
		return claims.PreferredUsername
	}
	return claims.Name
}
