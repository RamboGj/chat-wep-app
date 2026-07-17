# Code patterns

Copy-ready idioms, adapted verbatim from **go-bid**. Match these exactly when adding code.

## jsonutils (`internal/jsonutils/json_utils.go`)

```go
func EncodeJson[T any](w http.ResponseWriter, r *http.Request, statusCode int, data T) error {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		return fmt.Errorf("failed to encode JSON: %w", err)
	}
	return nil
}

func DecodeValidJson[T validator.Validator](r *http.Request) (T, map[string]string, error) {
	var data T
	if err := json.NewDecoder(r.Body).Decode(&data); err != nil {
		return data, nil, fmt.Errorf("failed to decode valid JSON: %w", err)
	}
	if problems := data.Valid(r.Context()); len(problems) > 0 {
		return data, problems, fmt.Errorf("invalid %T: %d problems", data, len(problems))
	}
	return data, nil, nil
}
```

## validator (`internal/validator/validator.go`)

```go
type Validator interface {
	Valid(context.Context) Evaluator
}

type Evaluator map[string]string // field → message; keeps the FIRST error per field

func (e *Evaluator) AddFieldError(key, message string) {
	if *e == nil { *e = make(map[string]string) }
	if _, exists := (*e)[key]; !exists { (*e)[key] = message }
}
func (e *Evaluator) CheckField(ok bool, key, message string) {
	if !ok { e.AddFieldError(key, message) }
}
// helpers: NotBlank, MinChars, MaxChars, Matches(rx); EmailRX is a package var.
```

## A request DTO (`internal/usecase/<entity>/*.go`)

```go
type CreateUserRequest struct {
	Username string `json:"username"`
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (req CreateUserRequest) Valid(ctx context.Context) validator.Evaluator {
	var eval validator.Evaluator
	eval.CheckField(validator.NotBlank(req.Username), "username", "must not be blank")
	eval.CheckField(validator.MaxChars(req.Username, 50), "username", "must be at most 50 characters")
	eval.CheckField(validator.Matches(req.Email, validator.EmailRX), "email", "must be a valid email")
	eval.CheckField(validator.MinChars(req.Password, 8), "password", "must be at least 8 characters long")
	return eval
}
```

## A service (`internal/services/*.go`)

```go
var (
	ErrDuplicatedEmailOrUsername = errors.New("invalid username or email")
	ErrInvalidCredentials        = errors.New("invalid credentials")
)

type UserService struct {
	pool    *pgxpool.Pool
	queries *pgstore.Queries
}

func NewUserService(pool *pgxpool.Pool) UserService {
	return UserService{pool: pool, queries: pgstore.New(pool)}
}

func (us *UserService) CreateUser(ctx context.Context, username, email, password string) (uuid.UUID, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil { return uuid.UUID{}, err }

	id, err := us.queries.CreateUser(ctx, pgstore.CreateUserParams{
		Username: username, Email: email, PasswordHash: hash,
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
```

### Transaction pattern (accept-invite, remove-friend)

```go
func (fs *FriendService) AcceptInvite(ctx context.Context, inviteID, callerID uuid.UUID) (uuid.UUID, error) {
	tx, err := fs.pool.Begin(ctx)
	if err != nil { return uuid.UUID{}, err }
	defer tx.Rollback(ctx) // no-op after a successful Commit

	q := fs.queries.WithTx(tx)
	// ... validate the invite belongs to callerID and is still pending ...
	chatID, err := q.CreateChat(ctx)                                  // 1 chat
	if err != nil { return uuid.UUID{}, err }
	if err := q.AddChatParticipant(ctx, chatID, invite.FromUserID); err != nil { return uuid.UUID{}, err }
	if err := q.AddChatParticipant(ctx, chatID, invite.ToUserID);   err != nil { return uuid.UUID{}, err }
	if err := q.MarkInviteAccepted(ctx, inviteID); err != nil { return uuid.UUID{}, err }

	if err := tx.Commit(ctx); err != nil { return uuid.UUID{}, err }
	return chatID, nil
}
```

## A handler (`internal/api/*_handlers.go`)

```go
func (api *Api) handleSignupUser(w http.ResponseWriter, r *http.Request) {
	data, problems, err := jsonutils.DecodeValidJson[user.CreateUserRequest](r)
	if err != nil {
		_ = jsonutils.EncodeJson(w, r, http.StatusUnprocessableEntity, problems)
		return
	}
	id, err := api.UserService.CreateUser(r.Context(), data.Username, data.Email, data.Password)
	if err != nil {
		if errors.Is(err, services.ErrDuplicatedEmailOrUsername) {
			_ = jsonutils.EncodeJson(w, r, http.StatusUnprocessableEntity,
				map[string]any{"error": "email or username already exists"})
			return
		}
		_ = jsonutils.EncodeJson(w, r, http.StatusInternalServerError,
			map[string]any{"error": "something went wrong"})
		return
	}
	_ = jsonutils.EncodeJson(w, r, http.StatusCreated, map[string]any{"user_id": id})
}
```

## sqlc query (`internal/store/pgstore/queries/*.sql`)

```sql
-- name: CreateUser :one
INSERT INTO users (username, email, password_hash)
VALUES ($1, $2, $3)
RETURNING id;

-- name: GetUserByEmail :one
SELECT id, username, email, password_hash, created_at, updated_at
FROM users
WHERE email = $1;
```

`:one` returns a single row, `:many` a slice, `:exec` no rows. Run `sqlc generate` after edits.

## tern migration (`internal/store/pgstore/migrations/00N_*.sql`)

```sql
-- Write your migrate up statements here
CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      VARCHAR(50) UNIQUE NOT NULL,
    email         TEXT UNIQUE NOT NULL,
    password_hash BYTEA NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NULL
);
---- create above / drop below ----
DROP TABLE IF EXISTS users;
```

## sqlc.yml (`internal/store/pgstore/sqlc.yml`)

```yaml
version: 2
sql:
  - engine: "postgresql"
    queries: "./queries"
    schema: "./migrations"
    gen:
      go:
        emit_json_tags: true
        out: "."
        package: "pgstore"
        sql_package: "pgx/v5"
        overrides:
          - db_type: "uuid"
            go_type: { import: "github.com/google/uuid", type: "UUID" }
          - db_type: "timestamptz"
            go_type: { import: "time", type: "Time" }
```

## Infra

**docker-compose.yaml**
```yaml
services:
  db:
    image: postgres:17
    restart: unless-stopped
    ports:
      - ${CHATAPP_DATABASE_PORT:-5432}:5432
    environment:
      - POSTGRES_USER=${CHATAPP_DATABASE_USER}
      - POSTGRES_PASSWORD=${CHATAPP_DATABASE_PASSWORD}
      - POSTGRES_DB=${CHATAPP_DATABASE_NAME}
    volumes:
      - db:/var/lib/postgresql/data
volumes:
  db: { driver: local }
```

**makefile**
```make
.PHONY: migrate run-api
migrate:
	tern migrate --migrations ./internal/store/pgstore/migrations --config ./internal/store/pgstore/migrations/tern.conf
run-api:
	air --build.cmd "go build -o ./bin/api ./cmd/api" --build.bin "./bin/api"
```

**migrations/tern.conf**
```ini
[database]
port     = {{env "CHATAPP_DATABASE_PORT"}}
user     = {{env "CHATAPP_DATABASE_USER"}}
password = {{env "CHATAPP_DATABASE_PASSWORD"}}
database = {{env "CHATAPP_DATABASE_NAME"}}
host     = {{env "CHATAPP_DATABASE_HOST"}}
```

**.air.toml** — build `./cmd/api` to `./tmp/main.exe`, watch `.go`, exclude `_test.go`, `tmp`, `bin`, `vendor`.

**.env** (local dev only)
```
CHATAPP_DATABASE_HOST=localhost
CHATAPP_DATABASE_PORT=5432
CHATAPP_DATABASE_USER=postgres
CHATAPP_DATABASE_PASSWORD=postgres
CHATAPP_DATABASE_NAME=chatapp
CHATAPP_JWT_SECRET=change-me-in-prod
CHATAPP_ACCESS_TOKEN_TTL=15m
CHATAPP_REFRESH_TOKEN_TTL=168h
```
