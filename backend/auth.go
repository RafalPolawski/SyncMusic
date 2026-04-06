package main

import (
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

var jwtSecret = []byte(os.Getenv("JWT_SECRET"))

func init() {
	if len(jwtSecret) == 0 {
		jwtSecret = []byte("syncmusic-dev-secret-change-me")
	}
}

type UserClaims struct {
	Username  string
	IsSSO     bool
	ExpiresAt time.Time
}

// ParseJWT parses and validates the JWT signature.
func ParseJWT(tokenString string) (*UserClaims, error) {
	token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return jwtSecret, nil
	})
	if err != nil {
		return nil, err
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok || !token.Valid {
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

// DecodeJWTBody extracts the verified username from a JWT.
func DecodeJWTBody(token string) string {
	claims, err := ParseJWT(token)
	if err != nil {
		return ""
	}
	return claims.Username
}
