# Post-MVP Specs — Overview

The MVP (auth, friends/invitations, real-time 1:1 chat) is built and deployed. Its specs live in
[`backend/specs/`](../backend/specs/) and remain the reference for everything already shipped.

This directory holds the **post-MVP features**. Unlike the MVP specs, these are full-stack: each
file covers backend and frontend in one place, because the contract between them is the part
most likely to drift.

## Current stage

**Pagination, read receipts, and image messages ship now. Group chats are deferred to a later
stage.**

| # | Spec | Stage | Backend | Frontend |
|---|---|---|---|---|
| 5 | [`05-messages-pagination.md`](./05-messages-pagination.md) | **now** | — | ✔ |
| 2 | [`02-read-receipts.md`](./02-read-receipts.md) | **now** | ✔ | ✔ |
| 4 | [`04-image-messages.md`](./04-image-messages.md) | **now** | ✔ | ✔ |
| 6 | [`06-google-auth.md`](./06-google-auth.md) | **now** | ✔ | ✔ |
| 7 | [`07-typing-indicator.md`](./07-typing-indicator.md) | **now** | ✔ | ✔ |
| 1 | [`01-react-router-migration.md`](./01-react-router-migration.md) | unscheduled | — | ✔ |
| 3 | [`03-group-chats.md`](./03-group-chats.md) | next stage | ✔ | ✔ |

Files keep their original numbers so links and branch names stay stable — the numbers are
identifiers, not an order.

Backend work still follows the **`go-chat-backend` skill** (`backend/.claude/skills/`) — layered
architecture, sqlc/tern, jsonutils, sentinel errors. These specs define *what*; the skill defines
*how*. Frontend work follows the conventions already visible in `frontend/src/modules/` —
module-per-domain (`api/`, `components/`, `hooks/`, `pages/`), TanStack Query for server state,
Tailwind v4 with the project's design tokens.

## Order within this stage

**Pagination first, then read receipts, then images.** Google auth (6) is independent of all
three — it touches `users`, `/auth`, and the auth page, and shares no query, no cache entry, and
no component with them. Slot it wherever it fits; its only coupling to the others is the migration
number, which is first-come (see below).

**Typing (7) goes after read receipts (2).** Both write to the sidebar row's preview line and both
add a WebSocket kind, so doing them in the other order means authoring that line twice and
guessing at the other's kind number. Neither touches the database, so there is no migration
conflict between them.

Feature 5 is frontend-only — the cursor API it needs already exists — but it changes the *shape* of
the cached message list from `Message[]` to `InfiniteData<Message[]>`, and both of the others add
writes to that cache. Landing it first means those writes are authored once against the final
shape. It is also the smallest of the three and touches no SQL, so it does not block either branch.

Read receipts then images. They are close to independent — different columns, different endpoints,
no shared query beyond `ListChatsForUser`, which each extends by one field. Doing read receipts
first means the `MessageView` DTO that feature 4 introduces arrives once, already knowing every
field it has to carry.

They can also be built in parallel on separate branches. The only collision points are
`queries/messages.sql` (both add a column to `CreateMessage` and `ListMessages`) and
`queries/chats.sql` (both add one field to `ListChatsForUser`) — trivial merges, but worth knowing
about in advance.

## Migrations introduced

Feature 5 introduces none — it is frontend-only and reuses `idx_messages_chat_sent` from `005`.

tern applies migrations in strict filename order.

```
006_add_read_at_to_messages.sql     (feature 2 — this stage, applied)
007_add_type_to_messages.sql        (feature 4 — this stage)
008_add_google_id_to_users.sql      (feature 6 — this stage)
009_add_is_group_to_chats.sql       (feature 3 — next stage)
```

**Numbers are claimed on landing, not reserved.** tern refuses a sequence with a gap — it aborts
with `Missing migration N` — so whichever of 4 and 6 merges first takes `007` and the other takes
`008`. Nothing depends on their relative order; renumber the loser's file in the merge.

After editing anything under `migrations/` or `queries/`, regenerate:

```sh
sqlc generate -f ./internal/store/pgstore/sqlc.yml
```

## WebSocket kinds claimed

`MessageKind` is a Go iota mirrored **positionally** by every deployed frontend build, so it is
append-only: renumbering a kind silently routes frames to the wrong handler in every tab still
running the old bundle. Like the migrations, numbers are claimed on landing, not reserved.

```
0-4  MVP        (send, new, error, invalid-json, chat-created)
5    feature 2  KindMessagesRead                    — landed
6    feature 7  KindTyping      (client → server)
7    feature 7  KindUserTyping  (server → participants)
```

Feature 3 appends after those. Features 4 and 5 add none.

## Cross-cutting decisions

### D1 — `ChatSummary` is extended now, rewritten later

This stage **adds two fields** and changes nothing else:

```go
ChatSummary{ ChatID, OtherUserID, OtherUsername, LastMessage, LastMessageAt,
             UnreadCount,      // feature 2
             LastMessageType } // feature 4
```

`OtherUserID` / `OtherUsername` and the SQL behind them
(`JOIN chat_participants other ON other.user_id <> self.user_id`) survive this stage untouched —
they are correct for 1:1 chats, which is all that exists until groups land.

`GET /api/v1/chats` is therefore **backwards compatible** in this stage: two new fields, no
removals. The breaking rewrite (`participants[]`, `is_group`, `title`, and the removal of
`other_*`) belongs to feature 3 and is specified there. Do not pre-emptively adopt it — building
a participants array for chats that always have exactly one other participant is speculative
work, and it would force the frontend into a shape with no current payoff.

### D2 — messages are serialized through a DTO, not `pgstore.Message`

Today `handleListMessages` encodes `[]pgstore.Message` straight to JSON, so the wire format is
whatever sqlc generates. Feature 4 needs a derived field (an absolute image URL) that has no
column, so `services.MessageView` becomes the single serialized shape for both REST and the
WebSocket. Defined in [`04-image-messages.md`](./04-image-messages.md#messageview).

**Feature 2 does not need it.** Regenerating sqlc adds
`ReadAt *time.Time \`json:"read_at"\`` to `pgstore.Message` with the right tag, so read receipts
serialize correctly with no DTO. Introduce `MessageView` in feature 4, where a derived value
actually forces it — that keeps the refactor attached to the change that justifies it.

### D3 — `chats.is_group` — deferred with feature 3

Not part of this stage. Every chat is 1:1 until groups land, so no query needs the discriminator
yet. Rationale is in [`03-group-chats.md`](./03-group-chats.md).

### D4 — `chats.deleted_at` stays unused

Unchanged from the MVP (`backend/specs/00-overview.md`, decision #4). Nothing in these features
writes it. Every new query that filters chats must keep the existing `AND c.deleted_at IS NULL`
predicate.

## Known tensions in this stage

Flagged here rather than buried, because each is a deliberate acceptance of a limitation:

1. **`read_at` is a single column, but read state is per-recipient.** Exact for 1:1 chats, so it
   is exactly right for everything that exists this stage. It degrades to "at least one other
   participant has read this" the moment groups arrive — a known cost of the column, documented
   with its upgrade path in
   [`02-read-receipts.md`](./02-read-receipts.md#semantics-and-their-limits). Worth re-reading
   before starting feature 3, not before starting feature 2.
2. **Images live in a public bucket behind unguessable keys.** Anyone holding the URL can fetch
   the image without authenticating. Feature 4 documents this and the presigned-GET alternative.
   See [`04-image-messages.md`](./04-image-messages.md#privacy-tradeoff).
3. **Orphaned uploads are never reclaimed.** A presigned upload that is never sent as a message
   leaves an object nothing references. Bounded by the 5 MB cap and by auth; see
   [`04-image-messages.md`](./04-image-messages.md#orphaned-objects).
4. **A Google ID token is replayable for its ~1h lifetime.** No nonce is issued, so anyone who
   captures the token in that window can exchange it for a session — an attacker who can do that
   can already read `localStorage`. Documented with the nonce fix in
   [`06-google-auth.md`](./06-google-auth.md#nonce).
5. **The history cursor is `sent_at` alone, not `(sent_at, id)`.** Two messages inserted into one
   chat within the same microsecond, with a page boundary falling between them, would lose the
   second from history. Unreachable in this application's write pattern; the compound-cursor fix is
   documented in
   [`05-messages-pagination.md`](./05-messages-pagination.md#known-tension--the-cursor-is-sent_at-alone).
6. **The hub's participant cache can serve a stale roster for up to 10 minutes.** Correct by
   construction today — membership is written once at accept-invite and never edited, and
   remove-friend evicts explicitly. It becomes a real staleness window when feature 3 adds
   add/remove-member, which must evict the same way. See
   [`07-typing-indicator.md`](./07-typing-indicator.md#no-database-on-the-typing-path).

## New environment variables

Features 4 and 6. Add to `backend/.env.example`, `backend/render.yaml`, and the Render dashboard:

```
CHATAPP_R2_ACCOUNT_ID              (feature 4)
CHATAPP_R2_BUCKET                  (feature 4)
CHATAPP_R2_ACCESS_KEY_ID           (feature 4)
CHATAPP_R2_SECRET_ACCESS_KEY       (feature 4)
CHATAPP_R2_PUBLIC_BASE_URL         (feature 4)
CHATAPP_GOOGLE_CLIENT_ID           (feature 6 — not a secret; see the spec)
```

Feature 6 also adds a frontend variable, `VITE_GOOGLE_CLIENT_ID` — same value, set in
`frontend/.env.example` and in Vercel. It is inlined at build time, so changing it in the
dashboard does nothing until the next build.
