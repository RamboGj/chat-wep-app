package user

import (
	"context"

	"backend/internal/validator"
)

type CreateUserRequest struct {
	Username string `json:"username"`
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (req CreateUserRequest) Valid(ctx context.Context) validator.Evaluator {
	var eval validator.Evaluator

	eval.CheckField(validator.NotBlank(req.Username), "username", "this field cannot be blank")
	eval.CheckField(validator.MaxChars(req.Username, 50), "username", "this field cannot have more than 50 characters")
	eval.CheckField(validator.Matches(req.Email, validator.EmailRX), "email", "must be a valid email")
	eval.CheckField(validator.MinChars(req.Password, 8), "password", "this field must have at least 8 characters")

	return eval
}
