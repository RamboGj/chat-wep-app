package services

import (
	"context"
	"errors"

	"backend/internal/store/pgstore"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

var (
	ErrDuplicatedEmailOrUsername = errors.New("email or username already exists")
	ErrInvalidCredentials        = errors.New("invalid credentials")
	ErrUserNotFound              = errors.New("user not found")
)

const bcryptCost = 12

type UserService struct {
	pool    *pgxpool.Pool
	queries *pgstore.Queries
}

func NewUserService(pool *pgxpool.Pool) UserService {
	return UserService{
		pool:    pool,
		queries: pgstore.New(pool),
	}
}

func (us *UserService) CreateUser(ctx context.Context, username, email, password string) (uuid.UUID, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return uuid.UUID{}, err
	}

	id, err := us.queries.CreateUser(ctx, pgstore.CreateUserParams{
		Username:     username,
		Email:        email,
		PasswordHash: hash,
	})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return uuid.UUID{}, ErrDuplicatedEmailOrUsername
		}
		return uuid.UUID{}, err
	}

	return id, nil
}

// AuthenticateUser returns ErrInvalidCredentials for both an unknown email and
// a wrong password, so the response cannot be used to enumerate accounts.
func (us *UserService) AuthenticateUser(ctx context.Context, email, password string) (uuid.UUID, error) {
	user, err := us.queries.GetUserByEmail(ctx, email)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.UUID{}, ErrInvalidCredentials
		}
		return uuid.UUID{}, err
	}

	if err := bcrypt.CompareHashAndPassword(user.PasswordHash, []byte(password)); err != nil {
		if errors.Is(err, bcrypt.ErrMismatchedHashAndPassword) {
			return uuid.UUID{}, ErrInvalidCredentials
		}
		return uuid.UUID{}, err
	}

	return user.ID, nil
}

func (us *UserService) GetUserByID(ctx context.Context, id uuid.UUID) (pgstore.GetUserByIDRow, error) {
	user, err := us.queries.GetUserByID(ctx, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pgstore.GetUserByIDRow{}, ErrUserNotFound
		}
		return pgstore.GetUserByIDRow{}, err
	}

	return user, nil
}
