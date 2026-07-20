package api

import (
	"backend/internal/jwtutils"
	"backend/internal/services"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
)

type Api struct {
	Router        *chi.Mux
	UserService   services.UserService
	FriendService services.FriendService
	ChatService   services.ChatService
	Jwt           jwtutils.Config
	Hub           *Hub
	WsUpgrader    websocket.Upgrader

	// Browser origins allowed to call the API and open /ws. Empty means
	// same-origin only, in which case no CORS middleware is installed.
	AllowedOrigins []string
}
