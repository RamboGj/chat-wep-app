package api

import (
	"context"
	"net/http"

	"backend/internal/jsonutils"
	"backend/internal/jwtutils"

	"github.com/google/uuid"
)

type ctxKey string

const userIDKey ctxKey = "userID"

// AuthMiddleware verifies the access_token cookie and puts the caller's id in
// the request context. Handlers read it with userIDFromContext.
func (api *Api) AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(jwtutils.AccessCookieName)
		if err != nil {
			_ = jsonutils.EncodeJson(w, r, http.StatusUnauthorized, map[string]any{
				"error": "must be logged in",
			})
			return
		}

		userID, err := api.Jwt.Parse(cookie.Value, jwtutils.AccessToken)
		if err != nil {
			_ = jsonutils.EncodeJson(w, r, http.StatusUnauthorized, map[string]any{
				"error": "invalid or expired token",
			})
			return
		}

		ctx := context.WithValue(r.Context(), userIDKey, userID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// userIDFromContext is only valid inside an AuthMiddleware-protected route.
func userIDFromContext(ctx context.Context) uuid.UUID {
	userID, ok := ctx.Value(userIDKey).(uuid.UUID)
	if !ok {
		panic("userID missing from context: route is not behind AuthMiddleware")
	}
	return userID
}
