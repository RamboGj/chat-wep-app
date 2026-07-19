package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"time"

	"backend/internal/api"
	"backend/internal/jwtutils"
	"backend/internal/services"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	if err := godotenv.Load(); err != nil {
		return fmt.Errorf("failed to load .env: %w", err)
	}

	ctx := context.Background()

	pool, err := pgxpool.New(ctx, fmt.Sprintf(
		"user=%s password=%s host=%s port=%s dbname=%s",
		os.Getenv("CHATAPP_DATABASE_USER"),
		os.Getenv("CHATAPP_DATABASE_PASSWORD"),
		os.Getenv("CHATAPP_DATABASE_HOST"),
		os.Getenv("CHATAPP_DATABASE_PORT"),
		os.Getenv("CHATAPP_DATABASE_NAME"),
	))
	if err != nil {
		return fmt.Errorf("failed to create connection pool: %w", err)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		return fmt.Errorf("failed to ping database: %w", err)
	}

	jwtCfg, err := jwtConfigFromEnv()
	if err != nil {
		return err
	}

	s := api.Api{
		Router:        chi.NewMux(),
		UserService:   services.NewUserService(pool),
		FriendService: services.NewFriendService(pool),
		Jwt:           jwtCfg,
	}

	s.BindRoutes()

	addr := envOr("CHATAPP_API_ADDR", "localhost:3080")
	fmt.Printf("listening on http://%s\n", addr)

	if err := http.ListenAndServe(addr, s.Router); err != nil {
		return fmt.Errorf("server stopped: %w", err)
	}

	return nil
}

func jwtConfigFromEnv() (jwtutils.Config, error) {
	secret := os.Getenv("CHATAPP_JWT_SECRET")
	if secret == "" {
		return jwtutils.Config{}, fmt.Errorf("CHATAPP_JWT_SECRET must be set")
	}

	accessTTL, err := time.ParseDuration(envOr("CHATAPP_ACCESS_TOKEN_TTL", "15m"))
	if err != nil {
		return jwtutils.Config{}, fmt.Errorf("invalid CHATAPP_ACCESS_TOKEN_TTL: %w", err)
	}

	refreshTTL, err := time.ParseDuration(envOr("CHATAPP_REFRESH_TOKEN_TTL", "168h"))
	if err != nil {
		return jwtutils.Config{}, fmt.Errorf("invalid CHATAPP_REFRESH_TOKEN_TTL: %w", err)
	}

	return jwtutils.Config{
		Secret:     []byte(secret),
		AccessTTL:  accessTTL,
		RefreshTTL: refreshTTL,
		Secure:     os.Getenv("CHATAPP_COOKIE_SECURE") == "true",
	}, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
