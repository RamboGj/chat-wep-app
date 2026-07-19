package friend

import (
	"context"

	"backend/internal/validator"
)

type CreateInviteRequest struct {
	Username string `json:"username"`
}

func (req CreateInviteRequest) Valid(ctx context.Context) validator.Evaluator {
	var eval validator.Evaluator

	eval.CheckField(validator.NotBlank(req.Username), "username", "this field cannot be blank")
	eval.CheckField(validator.MaxChars(req.Username, 50), "username", "this field cannot have more than 50 characters")

	return eval
}
