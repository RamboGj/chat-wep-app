package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"strings"
	"time"

	"backend/internal/api"
	"backend/internal/jwtutils"
	"backend/internal/services"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
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
	// .env is a local-dev convenience. In deployed environments the vars come
	// from the platform and no file exists, which is not an error.
	if err := godotenv.Load(); err != nil && !errors.Is(err, fs.ErrNotExist) {
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

	chatService := services.NewChatService(pool)
	messageService := services.NewMessageService(pool)

	hub := api.NewHub(chatService, messageService)
	go hub.Run()

	s := api.Api{
		Router:        chi.NewMux(),
		UserService:   services.NewUserService(pool),
		FriendService: services.NewFriendService(pool),
		ChatService:   chatService,
		Jwt:           jwtCfg,
		Hub:           hub,
		WsUpgrader:    wsUpgrader(),
	}

	s.BindRoutes()

	addr := envOr("CHATAPP_API_ADDR", "localhost:3080")
	fmt.Printf("listening on http://%s\n", addr)

	if err := http.ListenAndServe(addr, s.Router); err != nil {
		return fmt.Errorf("server stopped: %w", err)
	}

	return nil
}

// wsUpgrader builds the upgrader. Because the socket authenticates with a
// cookie, Origin must be checked or any site could open an authenticated socket
// on the user's behalf. Leaving CHATAPP_ALLOWED_ORIGINS unset keeps gorilla's
// same-origin default; set it to the frontend's origin when it is served
// separately.
func wsUpgrader() websocket.Upgrader {
	raw := os.Getenv("CHATAPP_ALLOWED_ORIGINS")
	if raw == "" {
		return websocket.Upgrader{}
	}

	allowed := make(map[string]struct{})
	for _, origin := range strings.Split(raw, ",") {
		if origin = strings.TrimSpace(origin); origin != "" {
			allowed[origin] = struct{}{}
		}
	}

	return websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			if origin == "" {
				return true // non-browser client: no cross-site risk to guard
			}
			_, ok := allowed[origin]
			return ok
		},
	}
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
