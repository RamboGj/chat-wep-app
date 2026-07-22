# Chat App Backend — Overview

Real-time chat MVP in Go. Users authenticate, add each other as friends via invitations, and
exchange messages in 1:1 chats over WebSocket.

Build every feature following the **`go-chat-backend` skill** (`.claude/skills/go-chat-backend/`),
which encodes the layered architecture and code conventions adapted from the reference project
[go-bid](https://github.com/RamboGj/go-bid). These specs define *what* to build; the skill
defines *how*.

## Features & specs

1. [`01-jwt-authentication.md`](./01-jwt-authentication.md) — signup, login, refresh, logout, me.
2. [`02-friends-and-invitations.md`](./02-friends-and-invitations.md) — invite by username,
   accept (creates a 1:1 chat), reject, list pending invites, list friends, remove friend.
3. [`03-realtime-chat.md`](./03-realtime-chat.md) — multiplexed WebSocket, live messaging,
   REST chat list + message history.

Full database schema and migration order: [`schema.md`](./schema.md).

> **These specs describe the MVP as shipped.** Four post-MVP features (React Router migration,
> read receipts, group chats, image messages) are specified in [`../../specs/`](../../specs/) and
> change the schema and several contracts here — notably `messages` (`read_at`, `type`), `chats`
> (`is_group`, `title` now used), and the shape of `ChatSummary`. Read that directory alongside
> this one.

## Stack

Go 1.26 · chi · pgx/v5 + sqlc · tern migrations · gorilla/websocket · JWT (golang-jwt/v5) ·
bcrypt · PostgreSQL 17 · docker-compose · air. Env prefix `CHATAPP_`.

## Architecture decisions (from project kickoff)

These decisions were made deliberately and deviate from a naive reading of the entity list —
implement to the decision, not the original sketch.

1. **Auth = JWT access + refresh, in httpOnly cookies (stateless).**
   Access ~15m, refresh ~7d. `/auth/refresh` mints a fresh access token so users don't drop
   mid-conversation. **Logout clears both cookies** — there is no server-side token table and no
   revocation of an already-issued access token (short TTL bounds exposure). Cookie-based JWT
   also authenticates the WebSocket upgrade with no extra work.

2. **WebSocket = single multiplexed socket per user** (`/api/v1/ws`), not one socket per chat.
   Envelopes carry `chat_id`; the hub fans out to connected participants. See the skill's
   `references/realtime-hub.md`.

3. **"Friends" are not a separate table — they are the user's 1:1 chats.**
   - Accepting an invite creates, in **one transaction**: 1 `chats` row + 2 `chat_participants`
     rows + sets the invite's `accepted_at`.
   - Rejecting an invite **deletes** the invitation row.
   - "List friends" = list the caller's chats plus the other participant of each.
   - **Remove friend hard-deletes the `chats` row in a transaction**, cascading to its
     `chat_participants` and `messages` (via `ON DELETE CASCADE`). Atomic — no partial state.

4. **`chats.deleted_at` is reserved/unused under current semantics.** Remove-friend does a hard
   delete, so the soft-delete column is kept (as originally specified) but not written by any MVP
   flow. Left in place for a future soft-delete/blocking feature. *(Open question — see below.)*

5. **`messages` gets a `uuid` primary key** (`id`), which the original entity sketch omitted but
   the WebSocket ack/rendering needs.

## Open questions / things to confirm

- **`deleted_at` vs hard delete (decision #4):** remove-friend hard-deletes the chat, so
  `deleted_at` is never set. Options: (a) keep it reserved as-is, (b) switch remove-friend to a
  soft delete (`SET deleted_at = NOW()`) and preserve message history, (c) drop the column. Kept
  as-is per the kickoff instruction; flag if you want a different resolution.
- **Reusing invitations after remove-friend:** since accepted invites keep `accepted_at` set,
  re-friending after a removal needs either a fresh invite row or clearing the old one. The
  duplicate-invite guard is a **partial** unique index over pending invites only, so a new invite
  is allowed after removal — confirm that's the intended UX.
- **Re-inviting after rejection:** rejection deletes the row, so re-inviting is unconstrained.
  Acceptable for MVP; add rate limiting later if abused.
