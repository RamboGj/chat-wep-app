package jwtutils

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

const (
	AccessToken  = "access"
	RefreshToken = "refresh"

	AccessCookieName  = "access_token"
	RefreshCookieName = "refresh_token"

	// The refresh cookie is scoped to the refresh endpoint so it is not sent
	// on every other request.
	refreshCookiePath = "/api/v1/auth/refresh"
)

var ErrInvalidToken = errors.New("invalid or expired token")

type Config struct {
	Secret     []byte
	AccessTTL  time.Duration
	RefreshTTL time.Duration
	Secure     bool

	// SameSite mode for both cookies. Lax is right when the frontend shares a
	// registrable domain with the API; a frontend on an unrelated domain needs
	// None, which browsers only honour together with Secure.
	SameSite http.SameSite
}

type claims struct {
	Type string `json:"typ"`
	jwt.RegisteredClaims
}

func (c Config) mint(userID uuid.UUID, tokenType string, ttl time.Duration) (string, error) {
	now := time.Now()

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims{
		Type: tokenType,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID.String(),
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
		},
	})

	signed, err := token.SignedString(c.Secret)
	if err != nil {
		return "", fmt.Errorf("failed to sign %s token: %w", tokenType, err)
	}

	return signed, nil
}

func (c Config) MintAccess(userID uuid.UUID) (string, error) {
	return c.mint(userID, AccessToken, c.AccessTTL)
}

func (c Config) MintRefresh(userID uuid.UUID) (string, error) {
	return c.mint(userID, RefreshToken, c.RefreshTTL)
}

// Parse verifies the signature and expiry, enforces that the token is of
// wantType, and returns the subject. Every failure collapses to
// ErrInvalidToken so callers cannot leak which check failed.
func (c Config) Parse(token, wantType string) (uuid.UUID, error) {
	var cl claims

	_, err := jwt.ParseWithClaims(token, &cl, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return c.Secret, nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))
	if err != nil {
		return uuid.UUID{}, ErrInvalidToken
	}

	// Without this an access token would be accepted at /refresh and a refresh
	// token would authenticate every protected route.
	if cl.Type != wantType {
		return uuid.UUID{}, ErrInvalidToken
	}

	userID, err := uuid.Parse(cl.Subject)
	if err != nil {
		return uuid.UUID{}, ErrInvalidToken
	}

	return userID, nil
}

func (c Config) accessCookie(value string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name:     AccessCookieName,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   c.Secure,
		SameSite: c.SameSite,
	}
}

func (c Config) refreshCookie(value string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name:     RefreshCookieName,
		Value:    value,
		Path:     refreshCookiePath,
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   c.Secure,
		SameSite: c.SameSite,
	}
}

func (c Config) SetAccessCookie(w http.ResponseWriter, access string) {
	http.SetCookie(w, c.accessCookie(access, int(c.AccessTTL.Seconds())))
}

func (c Config) SetAuthCookies(w http.ResponseWriter, access, refresh string) {
	c.SetAccessCookie(w, access)
	http.SetCookie(w, c.refreshCookie(refresh, int(c.RefreshTTL.Seconds())))
}

// ClearAuthCookies expires both cookies. The attributes must match the ones
// used when setting them or the browser will keep the originals.
func (c Config) ClearAuthCookies(w http.ResponseWriter) {
	http.SetCookie(w, c.accessCookie("", -1))
	http.SetCookie(w, c.refreshCookie("", -1))
}
