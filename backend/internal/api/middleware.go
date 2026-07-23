package api

import (
	"context"
	"net/http"
	"strings"

	"backend/internal/jsonutils"
	"backend/internal/jwtutils"

	"github.com/google/uuid"
)

type ctxKey string

const userIDKey ctxKey = "userID"

// WSAuthProtocol is the sentinel the /ws handshake uses to carry the access
// token. The browser's WebSocket constructor cannot set an Authorization
// header, and its only other channel is the URL — where the token would land in
// every access log and proxy trace. Subprotocols travel in
// Sec-WebSocket-Protocol instead, so the client offers
// ["bearer", "<access token>"] and the server selects "bearer".
const WSAuthProtocol = "bearer"

// AuthMiddleware verifies the bearer access token and puts the caller's id in
// the request context. Handlers read it with userIDFromContext.
func (api *Api) AuthMiddleware(next http.Handler) http.Handler {
	return api.authenticate(next, bearerToken)
}

// WSAuthMiddleware is AuthMiddleware for the socket upgrade, which carries its
// token in Sec-WebSocket-Protocol rather than Authorization.
func (api *Api) WSAuthMiddleware(next http.Handler) http.Handler {
	return api.authenticate(next, wsToken)
}

func (api *Api) authenticate(
	next http.Handler,
	extract func(*http.Request) (string, bool),
) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := extract(r)
		if !ok {
			_ = jsonutils.EncodeJson(w, r, http.StatusUnauthorized, map[string]any{
				"error": "must be logged in",
			})
			return
		}

		userID, err := api.Jwt.Parse(token, jwtutils.AccessToken)
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

// bearerToken pulls the token out of `Authorization: Bearer <token>`.
func bearerToken(r *http.Request) (string, bool) {
	scheme, token, found := strings.Cut(r.Header.Get("Authorization"), " ")
	if !found || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}

	token = strings.TrimSpace(token)
	return token, token != ""
}

// wsToken pulls the token out of the offered subprotocols, where it is the
// entry following the WSAuthProtocol sentinel. A client may send the list as
// several headers or one comma-separated header; both are legal.
func wsToken(r *http.Request) (string, bool) {
	for _, header := range r.Header.Values("Sec-WebSocket-Protocol") {
		offered := strings.Split(header, ",")

		for i, protocol := range offered {
			if strings.TrimSpace(protocol) != WSAuthProtocol || i+1 >= len(offered) {
				continue
			}

			token := strings.TrimSpace(offered[i+1])
			if token != "" {
				return token, true
			}
		}
	}

	return "", false
}

// userIDFromContext is only valid inside an authenticated route.
func userIDFromContext(ctx context.Context) uuid.UUID {
	userID, ok := ctx.Value(userIDKey).(uuid.UUID)
	if !ok {
		panic("userID missing from context: route is not behind AuthMiddleware")
	}
	return userID
}
