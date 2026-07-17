# Architecture

Layered, dependencies pointing inward. A request never skips a layer.

```
HTTP request
   │
   ▼
cmd/api ──────────► composition root. Builds pgxpool, jwt config, Hub, WsUpgrader,
                    all services; injects them into one api.Api struct; binds routes.
   │
   ▼
internal/api ─────► chi router + middleware. Handlers are methods on *Api.
   │                Decode+validate via jsonutils/usecase DTO, read userID from ctx,
   │                call a service, translate sentinel errors → HTTP status, EncodeJson.
   ▼
internal/services ► business logic. One service per entity. Owns sentinel errors.
   │                Orchestrates transactions. Never touches HTTP.
   ▼
internal/store/pgstore ► sqlc-generated type-safe DB access over pgxpool. Never hand-edited.
   │
   ▼
PostgreSQL
```

`internal/usecase/<entity>` sits beside the api layer: it holds the request DTOs and their
validation rules (`Valid(ctx) Evaluator`). `internal/jsonutils`, `internal/validator`, and
`internal/jwtutils` are cross-cutting helpers.

## Worked request trace — `POST /api/v1/friends/invites`

1. **Router** (`routes.go`) matches the route inside the `AuthMiddleware`-protected group.
2. **AuthMiddleware** (`middleware.go`) reads the `access_token` cookie, verifies the JWT,
   puts the caller's `uuid.UUID` into the request context. Missing/invalid → `401`.
3. **Handler** `handleCreateInvite` (`friends_handlers.go`):
   - `data, problems, err := jsonutils.DecodeValidJson[friend.CreateInviteRequest](r)`
   - `problems != nil` → `EncodeJson(..., 422, problems)`.
   - `fromID := r.Context().Value(userIDKey).(uuid.UUID)`.
   - `inviteID, err := api.FriendService.CreateInvite(ctx, fromID, data.Username)`.
   - `errors.Is(err, services.ErrUserNotFound)` → `404`; `ErrAlreadyFriends`/`ErrInviteExists`
     → `409`/`422`; else `500`; success → `201` with `{"invite_id": inviteID}`.
4. **Service** `FriendService.CreateInvite` resolves `to_user_id` from the username, guards
   self-invite / duplicate / already-friends, inserts the `friend_invitations` row via the
   generated query, and maps `pgErr.Code == "23505"` to `ErrInviteExists`.
5. **Store** `queries.CreateFriendInvitation` — generated from `queries/friend_invitations.sql`.

## The composition root (`cmd/api/main.go`)

The single place that wires concrete dependencies. It:
- loads `.env` (`godotenv.Load`),
- builds the `pgxpool.Pool` from `CHATAPP_DATABASE_*` and `Ping`s it,
- builds the `jwtutils.Config` from `CHATAPP_JWT_SECRET` + TTLs,
- constructs the `chat.Hub` and starts `go hub.Run()`,
- constructs every `services.NewXxxService(pool)`,
- assembles the `api.Api` struct, calls `api.BindRoutes()`, and `http.ListenAndServe`.

Adding a feature therefore means: migration → query → `sqlc generate` → service (+ sentinel
errors) → usecase DTO → handler → route in `BindRoutes` → wire the new service in `main.go`
and the `Api` struct.
