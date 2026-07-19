package api

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"backend/internal/jsonutils"
	"backend/internal/services"
)

func (api *Api) handleListChats(w http.ResponseWriter, r *http.Request) {
	callerID := userIDFromContext(r.Context())

	chats, err := api.ChatService.ListChatsForUser(r.Context(), callerID)
	if err != nil {
		api.respondChatError(w, r, err)
		return
	}

	_ = jsonutils.EncodeJson(w, r, http.StatusOK, map[string]any{"chats": chats})
}

func (api *Api) handleListMessages(w http.ResponseWriter, r *http.Request) {
	chatID, ok := uuidURLParam(w, r, "chat_id")
	if !ok {
		return
	}

	before := time.Now()
	if raw := r.URL.Query().Get("before"); raw != "" {
		parsed, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			_ = jsonutils.EncodeJson(w, r, http.StatusBadRequest, map[string]any{
				"error": "before must be an RFC3339 timestamp",
			})
			return
		}
		before = parsed
	}

	// Out-of-range values are clamped by the service; only unparseable ones are
	// a client error.
	limit := 0
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			_ = jsonutils.EncodeJson(w, r, http.StatusBadRequest, map[string]any{
				"error": "limit must be an integer",
			})
			return
		}
		limit = parsed
	}

	callerID := userIDFromContext(r.Context())

	messages, err := api.ChatService.ListMessages(r.Context(), chatID, callerID, before, limit)
	if err != nil {
		api.respondChatError(w, r, err)
		return
	}

	_ = jsonutils.EncodeJson(w, r, http.StatusOK, map[string]any{"messages": messages})
}

func (api *Api) respondChatError(w http.ResponseWriter, r *http.Request, err error) {
	status := http.StatusInternalServerError
	message := "something went wrong"

	if errors.Is(err, services.ErrNotParticipant) {
		// 404 rather than 403: do not reveal that the chat exists.
		status, message = http.StatusNotFound, "chat not found"
	}

	_ = jsonutils.EncodeJson(w, r, status, map[string]any{"error": message})
}
