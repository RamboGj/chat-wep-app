package jwtutils

import (
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

const (
	AccessToken  = "access"
	RefreshToken = "refresh"
)

var ErrInvalidToken = errors.New("invalid or expired token")

// Config mints and verifies the two bearer tokens. Tokens are handed to the
// client in the response body rather than in cookies: the frontend and the API
// are on unrelated registrable domains, which makes any cookie between them a
// third-party cookie — blocked outright by WebKit (so by every browser on iOS)
// and by Brave. A bearer token has no such origin rules.
type Config struct {
	Secret     []byte
	AccessTTL  time.Duration
	RefreshTTL time.Duration
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
