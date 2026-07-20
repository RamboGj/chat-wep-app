package api

import (
	"net/http"

	"backend/internal/jsonutils"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
)

func (api *Api) BindRoutes() {
	api.Router.Use(middleware.RequestID)
	api.Router.Use(middleware.Recoverer)
	api.Router.Use(middleware.Logger)

	// Auth rides on cookies, so AllowCredentials is required and the origin
	// list must be explicit — the "*" wildcard is invalid alongside it.
	// Handling OPTIONS here also gives preflights a 204 instead of chi's 404,
	// since none of the routes below register an OPTIONS handler.
	if len(api.AllowedOrigins) > 0 {
		api.Router.Use(cors.Handler(cors.Options{
			AllowedOrigins:   api.AllowedOrigins,
			AllowedMethods:   []string{"GET", "POST", "DELETE", "OPTIONS"},
			AllowedHeaders:   []string{"Accept", "Content-Type"},
			AllowCredentials: true,
			MaxAge:           300,
		}))
	}

	api.Router.Route("/api", func(r chi.Router) {
		r.Route("/v1", func(r chi.Router) {
			r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
				_ = jsonutils.EncodeJson(w, r, http.StatusOK, map[string]any{"status": "ok"})
			})

			r.Route("/auth", func(r chi.Router) {
				r.Post("/signup", api.handleSignupUser)
				r.Post("/login", api.handleLoginUser)

				// Authenticated by the refresh cookie itself, not AuthMiddleware.
				r.Post("/refresh", api.handleRefreshToken)

				// Clearing cookies must work even with an expired access token,
				// so logout stays outside AuthMiddleware.
				r.Post("/logout", api.handleLogoutUser)

				r.Group(func(r chi.Router) {
					r.Use(api.AuthMiddleware)
					r.Get("/me", api.handleGetCurrentUser)
				})
			})

			r.Route("/friends", func(r chi.Router) {
				r.Use(api.AuthMiddleware)

				r.Route("/invites", func(r chi.Router) {
					r.Post("/", api.handleCreateInvite)
					r.Get("/", api.handleListPendingInvites)
					r.Post("/{invite_id}/accept", api.handleAcceptInvite)
					r.Post("/{invite_id}/reject", api.handleRejectInvite)
				})

				r.Get("/", api.handleListFriends)
				r.Delete("/{chat_id}", api.handleRemoveFriend)
			})

			r.Route("/chats", func(r chi.Router) {
				r.Use(api.AuthMiddleware)

				r.Get("/", api.handleListChats)
				r.Get("/{chat_id}/messages", api.handleListMessages)
			})

			// The browser sends the access_token cookie on the upgrade request,
			// so the socket needs no bespoke auth of its own.
			r.With(api.AuthMiddleware).Get("/ws", api.handleWS)
		})
	})
}
