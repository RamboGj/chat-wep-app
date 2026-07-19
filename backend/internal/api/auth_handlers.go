package api

import (
	"errors"
	"net/http"

	"backend/internal/jsonutils"
	"backend/internal/jwtutils"
	"backend/internal/services"
	"backend/internal/usecase/user"
)

func (api *Api) handleSignupUser(w http.ResponseWriter, r *http.Request) {
	data, problems, err := jsonutils.DecodeValidJson[user.CreateUserRequest](r)
	if err != nil {
		_ = jsonutils.EncodeJson(w, r, http.StatusUnprocessableEntity, problems)
		return
	}

	id, err := api.UserService.CreateUser(r.Context(), data.Username, data.Email, data.Password)
	if err != nil {
		if errors.Is(err, services.ErrDuplicatedEmailOrUsername) {
			_ = jsonutils.EncodeJson(w, r, http.StatusUnprocessableEntity, map[string]any{
				"error": "email or username already exists",
			})
			return
		}
		_ = jsonutils.EncodeJson(w, r, http.StatusInternalServerError, map[string]any{
			"error": "something went wrong",
		})
		return
	}

	_ = jsonutils.EncodeJson(w, r, http.StatusCreated, map[string]any{"user_id": id})
}

func (api *Api) handleLoginUser(w http.ResponseWriter, r *http.Request) {
	data, problems, err := jsonutils.DecodeValidJson[user.LoginUserRequest](r)
	if err != nil {
		_ = jsonutils.EncodeJson(w, r, http.StatusUnprocessableEntity, problems)
		return
	}

	id, err := api.UserService.AuthenticateUser(r.Context(), data.Email, data.Password)
	if err != nil {
		if errors.Is(err, services.ErrInvalidCredentials) {
			_ = jsonutils.EncodeJson(w, r, http.StatusBadRequest, map[string]any{
				"error": "invalid email or password",
			})
			return
		}
		_ = jsonutils.EncodeJson(w, r, http.StatusInternalServerError, map[string]any{
			"error": "something went wrong",
		})
		return
	}

	access, err := api.Jwt.MintAccess(id)
	if err != nil {
		_ = jsonutils.EncodeJson(w, r, http.StatusInternalServerError, map[string]any{
			"error": "something went wrong",
		})
		return
	}

	refresh, err := api.Jwt.MintRefresh(id)
	if err != nil {
		_ = jsonutils.EncodeJson(w, r, http.StatusInternalServerError, map[string]any{
			"error": "something went wrong",
		})
		return
	}

	api.Jwt.SetAuthCookies(w, access, refresh)

	_ = jsonutils.EncodeJson(w, r, http.StatusOK, map[string]any{
		"message": "logged in successfully",
	})
}

func (api *Api) handleRefreshToken(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(jwtutils.RefreshCookieName)
	if err != nil {
		_ = jsonutils.EncodeJson(w, r, http.StatusUnauthorized, map[string]any{
			"error": "missing refresh token",
		})
		return
	}

	userID, err := api.Jwt.Parse(cookie.Value, jwtutils.RefreshToken)
	if err != nil {
		_ = jsonutils.EncodeJson(w, r, http.StatusUnauthorized, map[string]any{
			"error": "invalid or expired refresh token",
		})
		return
	}

	access, err := api.Jwt.MintAccess(userID)
	if err != nil {
		_ = jsonutils.EncodeJson(w, r, http.StatusInternalServerError, map[string]any{
			"error": "something went wrong",
		})
		return
	}

	api.Jwt.SetAccessCookie(w, access)

	_ = jsonutils.EncodeJson(w, r, http.StatusOK, map[string]any{
		"message": "token refreshed successfully",
	})
}

func (api *Api) handleLogoutUser(w http.ResponseWriter, r *http.Request) {
	api.Jwt.ClearAuthCookies(w)

	_ = jsonutils.EncodeJson(w, r, http.StatusOK, map[string]any{
		"message": "logged out successfully",
	})
}

func (api *Api) handleGetCurrentUser(w http.ResponseWriter, r *http.Request) {
	userID := userIDFromContext(r.Context())

	u, err := api.UserService.GetUserByID(r.Context(), userID)
	if err != nil {
		if errors.Is(err, services.ErrUserNotFound) {
			_ = jsonutils.EncodeJson(w, r, http.StatusNotFound, map[string]any{
				"error": "user not found",
			})
			return
		}
		_ = jsonutils.EncodeJson(w, r, http.StatusInternalServerError, map[string]any{
			"error": "something went wrong",
		})
		return
	}

	_ = jsonutils.EncodeJson(w, r, http.StatusOK, map[string]any{
		"id":       u.ID,
		"username": u.Username,
		"email":    u.Email,
	})
}
