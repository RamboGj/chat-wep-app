package api

import (
	"backend/internal/jwtutils"
	"backend/internal/services"

	"github.com/go-chi/chi/v5"
)

type Api struct {
	Router      *chi.Mux
	UserService services.UserService
	Jwt         jwtutils.Config
}
