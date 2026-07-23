package user

import (
	"context"

	"backend/internal/validator"
)

// RefreshTokenRequest carries the refresh token in the body rather than in an
// Authorization header, so that a request can never be mistaken for one bearing
// an access token — Parse rejects the wrong token type, but keeping the two on
// separate channels means a client bug cannot silently send the long-lived
// token to a route that only needs the short-lived one.
type RefreshTokenRequest struct {
	RefreshToken string `json:"refresh_token"`
}

func (req RefreshTokenRequest) Valid(ctx context.Context) validator.Evaluator {
	var eval validator.Evaluator

	eval.CheckField(validator.NotBlank(req.RefreshToken), "refresh_token", "this field cannot be blank")

	return eval
}
