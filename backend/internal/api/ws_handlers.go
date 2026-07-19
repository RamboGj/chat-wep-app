package api

import (
	"log/slog"
	"net/http"
)

// handleWS upgrades the request to the user's multiplexed socket. It runs
// behind AuthMiddleware, so an unauthenticated request is rejected with 401
// before any upgrade happens.
func (api *Api) handleWS(w http.ResponseWriter, r *http.Request) {
	userID := userIDFromContext(r.Context())

	conn, err := api.WsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		// Upgrade already wrote an HTTP error response.
		slog.Warn("websocket upgrade failed", "error", err, "user_id", userID)
		return
	}

	client := &Client{
		Hub:    api.Hub,
		Conn:   conn,
		Send:   make(chan WSMessage, sendBuffer),
		UserID: userID,
	}

	api.Hub.Register <- client

	// Each pump closes the connection in its own defer.
	go client.WritePump()
	go client.ReadPump()
}
