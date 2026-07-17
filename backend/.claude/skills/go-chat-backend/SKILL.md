---
name: go-chat-backend
description: Build backend features for this real-time chat MVP in Go. Use whenever implementing or modifying the chat backend — HTTP handlers, services, sqlc queries/migrations, JWT auth, or the WebSocket hub. Encodes the layered architecture and code conventions adapted from the go-bid reference project (chi + pgx + sqlc + tern + gorilla/websocket).
---

# go-chat-backend

Conventions and patterns for building this **real-time chat MVP** backend in Go. Every
feature added to this project MUST follow the structure and idioms captured here. The base
pattern comes from the reference project **[go-bid](https://github.com/RamboGj/go-bid)**
(a real-time auction backend by the same author); this skill adapts it for chat.

## When to use

Invoke this skill before writing or changing any backend code: a new endpoint, a service
method, a sqlc query, a migration, auth logic, or anything touching the WebSocket hub. Read
the relevant `specs/*.md` (in the backend repo root) for the feature you're implementing —
the specs are the source of truth for *what* to build; this skill is the source of truth for
*how* to build it.

## Stack

| Concern | Choice |
|---|---|
| Language | Go 1.26 (module `backend`) |
| HTTP router | `github.com/go-chi/chi/v5` |
| DB driver / pool | `github.com/jackc/pgx/v5` (`pgxpool`) |
| Query codegen | **sqlc** (`sqlc.yml`, `sql_package: pgx/v5`) |
| Migrations | **tern** |
| Auth | **JWT** access + refresh (`github.com/golang-jwt/jwt/v5`), httpOnly cookies, bcrypt password hashing |
| Real-time | `github.com/gorilla/websocket` — single multiplexed hub |
| Env loading | `github.com/joho/godotenv` |
| DB | PostgreSQL 17 (via `docker-compose.yaml`) |
| Hot reload | `air` (`.air.toml`) |

Env vars use the `CHATAPP_` prefix (e.g. `CHATAPP_DATABASE_HOST`, `CHATAPP_JWT_SECRET`).

## Project structure

Layered, dependencies pointing **inward**: `cmd → api → services → store/pgstore`.

```
backend/
├── cmd/
│   ├── api/main.go            # composition root: pool, hub, upgrader → api.Api, bind routes, ListenAndServe
│   └── terndotenv/main.go     # loads .env then shells out to `tern migrate`
├── internal/
│   ├── api/                   # HTTP layer (chi). One Api struct is the receiver for every handler.
│   │   ├── api.go             # Api struct: Router + all services + JWT + Hub + WsUpgrader
│   │   ├── routes.go          # BindRoutes: middleware chain + route tree
│   │   ├── middleware.go      # AuthMiddleware (reads access_token cookie → userID in ctx)
│   │   └── *_handlers.go      # one file per resource (auth, friends, chats, ws)
│   ├── usecase/<entity>/      # request DTOs implementing validator.Validator (Valid(ctx) Evaluator)
│   ├── services/              # business logic, one service per entity, own sentinel errors
│   ├── store/pgstore/         # sqlc-GENERATED — do not hand-edit *.sql.go / models.go / db.go
│   │   ├── queries/*.sql      # hand-written SQL (source for sqlc)
│   │   ├── migrations/*.sql   # tern migrations (source of schema for sqlc)
│   │   ├── sqlc.yml
│   │   └── migrations/tern.conf
│   ├── jsonutils/             # EncodeJson / DecodeValidJson generics
│   ├── validator/             # Validator interface + Evaluator (field→message map)
│   └── jwtutils/              # token mint/parse, cookie helpers
├── specs/                     # per-feature implementation specs (WHAT to build)
├── docker-compose.yaml
├── .air.toml
├── makefile
└── go.mod
```

## Golden-path conventions (non-negotiable)

1. **Request/response goes through `jsonutils`.** Handlers decode + validate in one step:
   `data, problems, err := jsonutils.DecodeValidJson[T](r)`. If `problems != nil` → respond
   `422` with the problems map. Write every response with `jsonutils.EncodeJson(w, r, status, payload)`.

2. **DTOs live in `internal/usecase/<entity>` and implement `validator.Validator`.** They
   carry validation rules only — no business logic, no DB access. Build field errors with the
   `Evaluator` (keeps the first error per field).

3. **One service per entity in `internal/services`**, constructed with `NewXxxService(pool)`,
   wrapping a `pgstore.Queries`. Services own their **sentinel errors** (e.g. `ErrInvalidCredentials`,
   `ErrNotParticipant`) which handlers match with `errors.Is` and translate to HTTP status codes.
   Detect Postgres unique-violation with `pgErr.Code == "23505"`.

4. **The store layer is generated.** Never hand-edit `*.sql.go`, `models.go`, or `db.go`. Edit
   `queries/*.sql` and `migrations/*.sql`, then run `sqlc generate`. UUID → `google/uuid.UUID`,
   `timestamptz` → `time.Time` (configured in `sqlc.yml`).

5. **Handlers are methods on `*api.Api`** and read the authenticated user id from the request
   **context** (not from the request body): `userID := r.Context().Value(userIDKey).(uuid.UUID)`.

6. **Multi-step DB writes that must be atomic use a pgx transaction** (`pool.Begin` →
   `queries.WithTx(tx)` → `tx.Commit`/`Rollback`). Required for: accept-invite (create chat +
   2 participants), and remove-friend (delete chat cascading to participants + messages).

## Deviations from go-bid (read these — they are intentional)

go-bid is the pattern base, but this project differs in three ways:

- **Auth is JWT, not `scs` sessions.** go-bid uses `alexedwards/scs` Postgres-backed session
  cookies. Here we use short-lived **access** + longer **refresh** JWTs delivered as httpOnly
  cookies (stateless — no session/token table). `AuthMiddleware` verifies the `access_token`
  cookie; `/auth/refresh` mints a new access token from a valid `refresh_token` cookie; logout
  clears both cookies. See `references/jwt-auth.md`.

- **The WebSocket hub is a single multiplexed connection per user**, not one socket per room.
  go-bid opens one socket per auction. Here each user opens **one** `/ws` socket; envelopes
  carry a `chat_id` and the hub fans messages out to the connected participants of that chat.
  See `references/realtime-hub.md`.

- **`users` schema** uses `username` (not go-bid's `user_name`) and has **no `bio`** column.

## Reference files

- `references/architecture.md` — the layered flow end-to-end with a worked request trace.
- `references/code-patterns.md` — copy-ready snippets: jsonutils, validator, a DTO, a service,
  a handler, a sqlc query, a tern migration, sqlc.yml, docker-compose, makefile, .air.toml.
- `references/jwt-auth.md` — token/cookie strategy, middleware, endpoints.
- `references/realtime-hub.md` — the multiplexed Hub/Client design adapted from go-bid's room.

## Commands

```sh
docker compose up -d                                        # start Postgres 17
go run ./cmd/terndotenv                                     # run migrations (loads .env)
make migrate                                                # same, tern directly
sqlc generate -f ./internal/store/pgstore/sqlc.yml         # regenerate Go after editing SQL
make run-api                                                # run API with hot reload (air)
go run ./cmd/api                                            # run API without hot reload
go test ./...                                               # tests
```

External tools on PATH: `tern`, `sqlc`, `air`.
