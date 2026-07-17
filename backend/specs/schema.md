# Database schema

PostgreSQL 17. Managed with **tern** migrations under
`internal/store/pgstore/migrations/`, consumed by **sqlc** (`sql_package: pgx/v5`). UUID →
`google/uuid.UUID`, `timestamptz` → `time.Time`.

Create migrations in this order (FKs depend on it):

```
001_create_users_table.sql
002_create_friend_invitations_table.sql
003_create_chats_table.sql
004_create_chat_participants_table.sql
005_create_messages_table.sql
```

## users

```sql
CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      VARCHAR(50) UNIQUE NOT NULL,
    email         TEXT UNIQUE NOT NULL,
    password_hash BYTEA NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NULL
);
```

## friend_invitations

Pending = `accepted_at IS NULL`. Accepted = `accepted_at` set (row kept). Rejected = row deleted.

```sql
CREATE TABLE IF NOT EXISTS friend_invitations (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    accepted_at  TIMESTAMPTZ DEFAULT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT no_self_invite CHECK (from_user_id <> to_user_id)
);

-- At most one PENDING invite per direction:
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_invite
    ON friend_invitations (from_user_id, to_user_id)
    WHERE accepted_at IS NULL;
```

`to_user_id` is resolved from the target's unique `username` at invite time. Preventing
inverse-direction duplicates (B invites A while A→B pending) and re-inviting existing friends is
enforced in `FriendService`, not by a constraint.

## chats

`title` is null in the MVP (no groups). `deleted_at` is **reserved/unused** — remove-friend hard
-deletes the row (see `00-overview.md`, decision #4).

```sql
CREATE TABLE IF NOT EXISTS chats (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title      TEXT DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ DEFAULT NULL
);
```

## chat_participants

Exactly 2 rows per chat in the 1:1 MVP. `ON DELETE CASCADE` from `chats` is what makes
remove-friend atomic.

```sql
CREATE TABLE IF NOT EXISTS chat_participants (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    UNIQUE (user_id, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_participants_user ON chat_participants (user_id);
```

## messages

Adds an `id` PK (needed by the WebSocket ack/rendering). `sender_id` = the "sender" FK.

```sql
CREATE TABLE IF NOT EXISTS messages (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id   UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content   TEXT NOT NULL,
    sent_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- History pagination is (chat_id, sent_at DESC):
CREATE INDEX IF NOT EXISTS idx_messages_chat_sent ON messages (chat_id, sent_at DESC);
```

## Relationship summary

```
users 1───∞ friend_invitations   (from_user_id, to_user_id)
users 1───∞ chat_participants ∞───1 chats
users 1───∞ messages ∞───1 chats
```
