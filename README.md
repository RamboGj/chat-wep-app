<div align="center">

<img src="docs/assets/logo.svg" alt="Pulse" width="88" height="88">

# Pulse — Real-Time Chat

A full-stack 1:1 messaging app: cookie-based JWT auth, friend invitations,<br>
and live messaging over a single multiplexed WebSocket.

**Go 1.26 · PostgreSQL 17 · React 19 · TypeScript · TanStack Router/Query · Tailwind v4**

</div>

---

## Features

| | |
|---|---|
| **Authentication** | Signup, login, logout, and silent token refresh. Access + refresh JWTs in `httpOnly` cookies. |
| **Friend invitations** | Invite by username, accept (creates the chat), reject, list pending, remove friend. |
| **Real-time messaging** | Live delivery over one multiplexed WebSocket per user, with paginated history over REST. |
| **Presence of failure** | Automatic socket reconnection with capped exponential backoff and a live connection indicator. |

---

## Architecture

```
chat-app/
├── backend/                     Go API + WebSocket hub
│   ├── cmd/api/                 composition root (wiring, env, graceful config)
│   └── internal/
│       ├── api/                 HTTP handlers, middleware, WS hub + client pumps
│       ├── services/            business logic (user, friend, chat, message)
│       ├── store/pgstore/       sqlc-generated queries + tern migrations
│       ├── jwtutils/            token minting, parsing, cookie management
│       └── validator/           request validation
└── frontend/                    React SPA
    └── src/
        ├── components/atoms/    Button, Input, Tab, Avatar, Logo
        ├── modules/             auth · chat · friends (api / hooks / components)
        ├── lib/                 fetch client, query keys, formatting
        └── routes/              file-based routes + auth guards
```

The backend follows a layered pattern — handlers stay thin, services own the business rules and
transactions, and `store/pgstore` is generated from hand-written SQL by sqlc. Errors are declared
as sentinel values in the service layer (`ErrNotParticipant`, `ErrInviteAlreadyResolved`, …) and
mapped to status codes at the edge, so HTTP concerns never leak inward.

---

## Engineering decisions

These were deliberate, and are the parts of the project worth reading.

**Auth lives in `httpOnly` cookies, not `localStorage`.**
Tokens are unreachable from JavaScript, so a successful XSS cannot exfiltrate a session. The
refresh cookie is additionally path-scoped to `/api/v1/auth/refresh`, so it is not even sent on
ordinary API calls. This choice pays off twice: the browser attaches the cookie to the WebSocket
upgrade request automatically, so the socket needs no bespoke auth handshake at all.

**One multiplexed socket per user, not one per chat.**
Every envelope carries a `chat_id`; a single hub goroutine owns the client map — so it needs no
mutex — and fans messages out to connected participants. Opening a conversation in the UI is
pure client state, with no connection churn.

**The server's echo is the ack.**
The hub fans a persisted message out to *all* participants including its sender. The frontend
therefore inserts nothing optimistically: the echo is the single path a message takes into the
cache, which means there are no temporary IDs to reconcile and no duplicate-key edge cases.

**"Friends" are not a table — they are the user's 1:1 chats.**
Accepting an invitation creates the chat, both participant rows, and marks the invite accepted in
**one transaction**, so a chat can never exist without its participants. Removing a friend
hard-deletes the chat inside a transaction and lets `ON DELETE CASCADE` take its participants and
messages with it.

**Token refresh is single-flight.**
A 401 triggers one shared refresh request; concurrent callers await the same promise and then
retry. A burst of parallel queries hitting an expired access token produces exactly one refresh,
not one per query.

**Reconnect backoff resets on stability, not on connect.**
Since the hub allows one socket per user and evicts the previous one, two open tabs would
otherwise evict each other in a tight loop. The backoff counter only resets once a connection has
*held* for 10s, so a losing socket backs off instead of hammering the upgrade endpoint.

---

## Realtime protocol

A single JSON envelope in both directions, discriminated by a numeric `kind`:

| kind | direction | payload |
|---|---|---|
| `0` SendMessage | client → server | `chat_id`, `content` |
| `1` NewMessage | server → participants | `id`, `chat_id`, `sender_id`, `content`, `sent_at` |
| `2` Error | server → sender | `message` |
| `3` InvalidJSON | server → sender | `message` |

`sender_id` is always taken from the authenticated connection, never from the client payload —
a client cannot send a message as someone else.

---

## API

All routes are under `/api/v1`.

```
POST   /auth/signup                    create account
POST   /auth/login                     set access + refresh cookies
POST   /auth/refresh                   mint a fresh access cookie
POST   /auth/logout                    clear cookies
GET    /auth/me                        current user

POST   /friends/invites/               invite by username
GET    /friends/invites/               pending invitations
POST   /friends/invites/{id}/accept    accept → creates the chat
POST   /friends/invites/{id}/reject    reject
GET    /friends/                       friends list
DELETE /friends/{chat_id}              remove friend

GET    /chats/                         chat list with last-message preview
GET    /chats/{chat_id}/messages       history (?before=RFC3339&limit=)

GET    /ws                             WebSocket upgrade
```

---

## Running locally

**Prerequisites:** Go 1.26+, Node 20+, Docker.

```bash
# 1. Database
cd backend
cp .env.example .env          # defaults work for local development
docker compose up -d

# 2. Migrations
make migrate

# 3. API  →  http://localhost:3080
make run-api                  # or: go run ./cmd/api

# 4. Frontend  →  http://localhost:5173
cd ../frontend
npm install
npm run dev
```

The Vite dev server proxies `/api` (including the WebSocket upgrade) to the Go API, so the
browser stays on a single origin and the auth cookies work without any CORS configuration.

---

## Design

The interface is built from a small design system — dark violet-on-slate, `Sora` for headings and
`Manrope` for body — defined as Tailwind v4 theme tokens in `frontend/src/index.css` and consumed
through [`tailwind-variants`](https://www.tailwind-variants.org/) atoms.

<img src="docs/assets/logo-variants.svg" alt="The Pulse mark in its gradient, outline and light treatments" width="336" height="96">

The mark is a single `<Logo />` component rather than a set of exported image assets: one
component covers every size and all three surface treatments above — the outline variant carries
the violet ramp on the glyph itself, so the gradient survives on a dark card. Corner radius is
30% of the box at every size, so the squircle keeps its proportions.

---

## Status

MVP feature-complete and manually verified end to end against a live database. Known gaps, kept
visible rather than papered over:

- **No automated tests yet** — the highest-value next step.
- **Invitations are polled, not pushed.** The socket carries chat messages only, so incoming
  invites refresh on a 20s interval.
- **No online-presence tracking.** The hub knows who is connected but does not broadcast it, so
  the UI shows connection state rather than per-contact presence.
- **No message pagination in the UI.** The API supports a `before` cursor; the client currently
  loads only the most recent page.
