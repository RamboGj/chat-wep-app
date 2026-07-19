package api

import (
	"errors"
	"net/http"

	"backend/internal/jsonutils"
	"backend/internal/services"
	"backend/internal/usecase/friend"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func (api *Api) handleCreateInvite(w http.ResponseWriter, r *http.Request) {
	data, problems, err := jsonutils.DecodeValidJson[friend.CreateInviteRequest](r)
	if err != nil {
		_ = jsonutils.EncodeJson(w, r, http.StatusUnprocessableEntity, problems)
		return
	}

	callerID := userIDFromContext(r.Context())

	inviteID, err := api.FriendService.CreateInvite(r.Context(), callerID, data.Username)
	if err != nil {
		api.respondFriendError(w, r, err)
		return
	}

	_ = jsonutils.EncodeJson(w, r, http.StatusCreated, map[string]any{"invite_id": inviteID})
}

func (api *Api) handleListPendingInvites(w http.ResponseWriter, r *http.Request) {
	callerID := userIDFromContext(r.Context())

	invites, err := api.FriendService.ListPendingInvites(r.Context(), callerID)
	if err != nil {
		api.respondFriendError(w, r, err)
		return
	}

	_ = jsonutils.EncodeJson(w, r, http.StatusOK, map[string]any{"invites": invites})
}

func (api *Api) handleAcceptInvite(w http.ResponseWriter, r *http.Request) {
	inviteID, ok := uuidURLParam(w, r, "invite_id")
	if !ok {
		return
	}

	callerID := userIDFromContext(r.Context())

	chatID, err := api.FriendService.AcceptInvite(r.Context(), inviteID, callerID)
	if err != nil {
		api.respondFriendError(w, r, err)
		return
	}

	_ = jsonutils.EncodeJson(w, r, http.StatusCreated, map[string]any{"chat_id": chatID})
}

func (api *Api) handleRejectInvite(w http.ResponseWriter, r *http.Request) {
	inviteID, ok := uuidURLParam(w, r, "invite_id")
	if !ok {
		return
	}

	callerID := userIDFromContext(r.Context())

	if err := api.FriendService.RejectInvite(r.Context(), inviteID, callerID); err != nil {
		api.respondFriendError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (api *Api) handleListFriends(w http.ResponseWriter, r *http.Request) {
	callerID := userIDFromContext(r.Context())

	friends, err := api.FriendService.ListFriends(r.Context(), callerID)
	if err != nil {
		api.respondFriendError(w, r, err)
		return
	}

	_ = jsonutils.EncodeJson(w, r, http.StatusOK, map[string]any{"friends": friends})
}

func (api *Api) handleRemoveFriend(w http.ResponseWriter, r *http.Request) {
	chatID, ok := uuidURLParam(w, r, "chat_id")
	if !ok {
		return
	}

	callerID := userIDFromContext(r.Context())

	if err := api.FriendService.RemoveFriend(r.Context(), chatID, callerID); err != nil {
		api.respondFriendError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// uuidURLParam parses a uuid path param, responding 400 and reporting false
// when it is malformed.
func uuidURLParam(w http.ResponseWriter, r *http.Request, name string) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, name))
	if err != nil {
		_ = jsonutils.EncodeJson(w, r, http.StatusBadRequest, map[string]any{
			"error": "invalid " + name,
		})
		return uuid.UUID{}, false
	}
	return id, true
}

func (api *Api) respondFriendError(w http.ResponseWriter, r *http.Request, err error) {
	status := http.StatusInternalServerError
	message := "something went wrong"

	switch {
	case errors.Is(err, services.ErrUserNotFound):
		status, message = http.StatusNotFound, "user not found"
	case errors.Is(err, services.ErrSelfInvite):
		status, message = http.StatusUnprocessableEntity, "you cannot invite yourself"
	case errors.Is(err, services.ErrAlreadyFriends):
		status, message = http.StatusConflict, "you are already friends with this user"
	case errors.Is(err, services.ErrInviteExists):
		status, message = http.StatusConflict, "a pending invitation already exists"
	case errors.Is(err, services.ErrInviteNotFound):
		status, message = http.StatusNotFound, "invitation not found"
	case errors.Is(err, services.ErrNotParticipant):
		// 404 rather than 403: do not reveal that the chat exists.
		status, message = http.StatusNotFound, "chat not found"
	case errors.Is(err, services.ErrNotInviteRecipient):
		status, message = http.StatusForbidden, "you are not the recipient of this invitation"
	case errors.Is(err, services.ErrInviteAlreadyResolved):
		status, message = http.StatusConflict, "this invitation has already been resolved"
	}

	_ = jsonutils.EncodeJson(w, r, status, map[string]any{"error": message})
}
