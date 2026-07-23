# Feature 1 — JWT Authentication

Users sign up, sign in, stay signed in via refresh, and sign out. Auth is **stateless JWT as
bearer tokens** (see the `go-chat-backend` skill → `references/jwt-auth.md` for the full
token/middleware design, including why this is not cookie-based).

## Goals

- Sign up with `username`, `email`, `password`.
- Sign in → receive access + refresh tokens in the response body.
- Stay signed in across the session: a short-lived access token, refreshed on demand.
- Sign out → the client discards both tokens.

## Entities

`users` — see [`schema.md`](./schema.md). Password stored as a **bcrypt** hash (`cost 12`) in
`password_hash BYTEA`. Never return `password_hash` in any response.

## Endpoints (`/api/v1/auth`)

| Method | Path | Auth | Request body | Success |
|---|---|---|---|---|
| POST | `/signup` | public | `{username, email, password}` | `201 {user_id}` |
| POST | `/login` | public | `{email, password}` | `200 {access_token, refresh_token, token_type, expires_in}` |
| POST | `/refresh` | token in body | `{refresh_token}` | `200 {access_token, token_type, expires_in}` |
| POST | `/logout` | none | — | `200 {message}` |
| GET | `/me` | bearer access token | — | `200 {id, username, email}` |

Access token ~15m, refresh ~7d. The access token travels as `Authorization: Bearer <token>`;
the refresh token only ever appears in the `/refresh` body. The refresh token is **not
rotated**.

## DTOs (`internal/usecase/user`)

- `CreateUserRequest{username, email, password}` — `username` not blank & ≤ 50 chars; `email`
  matches `EmailRX`; `password` ≥ 8 chars.
- `LoginUserRequest{email, password}` — `email` matches `EmailRX`; `password` not blank.
- `RefreshTokenRequest{refresh_token}` — not blank.

## Service (`internal/services/user_service.go`)

```
CreateUser(ctx, username, email, password) (uuid.UUID, error)
    - bcrypt hash, INSERT, map 23505 → ErrDuplicatedEmailOrUsername
AuthenticateUser(ctx, email, password) (uuid.UUID, error)
    - GetUserByEmail; pgx.ErrNoRows → ErrInvalidCredentials
    - bcrypt.CompareHashAndPassword; mismatch → ErrInvalidCredentials
GetUserByID(ctx, id) (pgstore.User, error)   // for /me
```

Sentinel errors: `ErrDuplicatedEmailOrUsername`, `ErrInvalidCredentials`.

## Queries (`queries/users.sql`)

`CreateUser :one` (RETURNING id), `GetUserByEmail :one`, `GetUserByID :one`. Never select
`password_hash` for `/me`.

## Handler behavior

- **signup**: decode+validate → `CreateUser`. `ErrDuplicatedEmailOrUsername` → `422`; else
  `500`; success `201 {user_id}`. (Do not auto-login on signup for the MVP; client calls
  `/login` next.)
- **login**: decode+validate → `AuthenticateUser`. `ErrInvalidCredentials` → `400
  {"error":"invalid email or password"}`. On success mint both tokens and return them.
- **refresh**: decode+validate body → `Jwt.Parse(refresh_token, "refresh")`. Invalid/expired →
  `401`. Mint and return a new access token.
- **logout**: `200`, unconditionally. Stateless tokens leave nothing to revoke — the client
  discarding them is what ends the session.
- **me**: read `userID` from context → `GetUserByID` → return public fields.

## Middleware

`AuthMiddleware` (`internal/api/middleware.go`) verifies the `Authorization: Bearer` token and
injects `userID` into the request context under `userIDKey`. Protected routes are grouped under
it in `routes.go`, and it covers all of Features 2 & 3. `/ws` (Feature 3) uses the sibling
`WSAuthMiddleware`, which reads the token from `Sec-WebSocket-Protocol` because the browser's
WebSocket API cannot set headers.

## Acceptance criteria

- [ ] Signup rejects duplicate email or username with `422`.
- [ ] Signup rejects password < 8 chars and invalid email with `422` field errors.
- [ ] Login with wrong password returns `400`, never reveals which field was wrong.
- [ ] Login returns `access_token` and `refresh_token` in the body and sets **no** cookie.
- [ ] A protected endpoint returns `401` with no/invalid/expired bearer token.
- [ ] A refresh token is rejected at a protected route, and an access token at `/refresh`
      (the `typ` claim is enforced).
- [ ] After the access token expires, `POST /auth/refresh` returns a new access token and the
      protected endpoint works again.
- [ ] `POST /auth/logout` returns `200`.
- [ ] `password_hash` never appears in any response body.
