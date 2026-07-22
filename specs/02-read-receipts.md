# Feature 2 — Read Receipts & Unread Counts

WhatsApp-style read state. A message carries a `read_at` timestamp; opening a chat marks
everything the caller has not sent as read; the sender's own bubbles show a grey double-check that
turns mint once read; the sidebar shows an unread pill and brightens the last-message preview.

## Semantics, and their limits

`read_at` is **one nullable column on `messages`**, per the project decision. Read state is
conceptually per `(message, reader)`, so a single column can only approximate it. The exact
semantics this spec commits to:

> `messages.read_at` is the timestamp at which **the first participant other than the sender**
> opened the chat with this message already in it. It is written once — every query that sets it
> filters on `read_at IS NULL` — so it never moves.

- **1:1 chats:** exact. The only other participant is the recipient, so this is precisely
  WhatsApp's blue-tick meaning. **Every chat is 1:1 in this stage**, so nothing below is
  approximate yet.
- **Group chats (feature 3, next stage):** this degrades to *"at least one other participant has
  read this"* — the tick turns mint when the first member opens the chat, not when all of them
  have. Nothing here needs changing when that happens; it is a documented loss of precision, not
  a bug to fix. Revisit the upgrade path below when starting feature 3, not now.
- A sender re-reading their own chat marks nothing: `sender_id <> caller` is part of every
  update. Their own messages stay unread until someone else opens the conversation.

### Upgrade path (not in scope)

Exact per-recipient state needs a join table:

```sql
CREATE TABLE message_reads (
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    read_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (message_id, user_id)
);
```

with "read by all" = `COUNT(reads) = participants - 1`. That is a strictly larger feature — a row
per message per reader, a different unread-count query, and a per-member read list in the group
UI. **Do not build it here.** Build the column; if group read accuracy later matters, the column
becomes a denormalized "first read" cache over this table.

---

# Backend

## Migration — `006_add_read_at_to_messages.sql`

```sql
-- Write your migrate up statements here
ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ DEFAULT NULL;

-- Unread counts scan (chat_id, sender_id) for the rows still NULL. A partial
-- index keeps that scan proportional to the unread backlog rather than to all
-- history, and read rows drop out of the index as they are marked.
CREATE INDEX IF NOT EXISTS idx_messages_unread
    ON messages (chat_id, sender_id)
    WHERE read_at IS NULL;
---- create above / drop below ----
DROP INDEX IF EXISTS idx_messages_unread;
ALTER TABLE messages DROP COLUMN IF EXISTS read_at;
```

Existing rows get `NULL` — i.e. every pre-existing message becomes unread. Acceptable: the
deployed data is demo traffic. If that bothers you, backfill in the same migration with
`UPDATE messages SET read_at = sent_at;` and say so in the PR.

sqlc's `timestamptz nullable` override (already in `sqlc.yml`) maps this to `*time.Time`.

## Queries — `queries/messages.sql`

```sql
-- Marks the caller's unread inbox for one chat. Only messages the caller did
-- NOT send, and only ones still unread, so read_at is written exactly once and
-- never moves. Participation is checked by the service before this runs.
-- name: MarkChatRead :one
UPDATE messages
SET read_at = NOW()
WHERE chat_id = $1
  AND sender_id <> $2
  AND read_at IS NULL
RETURNING read_at;
```

`:one` with a bare `RETURNING read_at` returns one row **per updated message**, which sqlc will
reject. Use `:many` and take the first, or — preferred — wrap it so the statement returns a single
row regardless of how many it touched:

```sql
-- name: MarkChatRead :one
WITH marked AS (
    UPDATE messages
    SET read_at = NOW()
    WHERE chat_id = $1
      AND sender_id <> $2
      AND read_at IS NULL
    RETURNING read_at
)
SELECT COUNT(*) AS marked_count, MAX(read_at)::timestamptz AS read_at
FROM marked;
```

`read_at` is `NULL` when nothing was marked — the service treats that as a no-op.

Also extend the two existing message queries to select the new column, and add it to
`CreateMessage`'s `RETURNING` list (it will be `NULL` there, always):

```sql
-- CreateMessage  → RETURNING id, chat_id, sender_id, content, sent_at, read_at;
-- ListMessages   → SELECT id, chat_id, sender_id, content, sent_at, read_at
```

## Queries — `queries/chats.sql`

`ListChatsForUser` gains an unread count. Use a correlated subquery, not a `JOIN … GROUP BY` —
the existing query already joins participants and a last-message row, and adding aggregation on
top would force everything else into the `GROUP BY`:

```sql
       (SELECT COUNT(*)
        FROM messages um
        WHERE um.chat_id = c.id
          AND um.sender_id <> $1
          AND um.read_at IS NULL) AS unread_count
```

sqlc types this as `int64`. It hits `idx_messages_unread`.

Everything else in that query — the participant join, the `LEFT JOIN` last-message preview, the
`ORDER BY COALESCE(last.sent_at, c.created_at)` — stays exactly as it is. This is an additive
change to one `SELECT` list.

## Service — `ChatService`

```go
// MarkChatRead stamps read_at on every message in the chat the caller did not
// send and has not already read. Returns the timestamp written, or nil when
// there was nothing to mark — the caller uses that to skip the fan-out.
MarkChatRead(ctx, chatID, callerID uuid.UUID) (*time.Time, error)
    - IsParticipant first → else ErrNotParticipant   (same shape as ListMessages)
    - MarkChatRead query
    - marked_count == 0 → (nil, nil)
```

The participation check is a separate statement rather than an `EXISTS` inside the `UPDATE`
because a non-participant must get `404`, and an `UPDATE` that touches zero rows cannot
distinguish "not allowed" from "nothing to do". This mirrors `ListMessages`; it does **not**
mirror `CreateMessage`, where the single-statement form is right precisely because both outcomes
mean "don't write".

No new sentinel errors.

## Endpoint

| Method | Path | Auth | Body | Success |
|---|---|---|---|---|
| POST | `/api/v1/chats/{chat_id}/read` | ✔ | — | `200 {marked, read_at}` |

```json
{ "marked": 3, "read_at": "2026-07-22T18:04:11.512Z" }
```

`marked: 0` returns `200` with `"read_at": null`. Non-participant → `404 {"error":"chat not found"}`
via the existing `respondChatError`. Route registration goes next to the other chat routes:

```go
r.Post("/{chat_id}/read", api.handleMarkChatRead)
```

`POST` is already in the CORS `AllowedMethods` list — no change to `routes.go` middleware.

The handler then pushes the read notification to the other participants over the hub, using the
**same pattern as accept-invite**: `ChatService.ParticipantIDs` → `Hub.NotifyUser` for each
participant except the caller. Best-effort by design; offline senders pick the state up from
history on their next fetch.

## WebSocket

New kind appended to the iota — **append only**, the frontend mirrors these positionally:

```go
KindMessagesRead  // 5: server → the other participants of a chat
```

Envelope:

```json
{ "kind": 5, "chat_id": "<uuid>", "read_at": "2026-07-22T18:04:11.512Z" }
```

Meaning: *every message in this chat sent at or before `read_at` is now read.*

`WSMessage` gains `ReadAt *time.Time \`json:"read_at,omitempty"\``.

### Why a timestamp and not a list of message ids

An id list is the obvious design and is wrong twice. It is unbounded — marking a 500-message
backlog puts 500 uuids in one frame, and the hub drops any client whose 256-slot `Send` buffer
backs up. And it invites a race: the `UPDATE` runs on the HTTP handler's goroutine while the hub
keeps processing sends, so a message created *after* the update can be pushed *before* the read
notification. A client applying "mark everything currently unread" would then wrongly tick it.

The `sent_at <= read_at` rule is constant-size and closes the race, because a message created
after the update necessarily has a later `sent_at`.

## Serialization — no DTO needed here

`pgstore.Message` is serialized directly today, and regenerating sqlc adds
`ReadAt *time.Time \`json:"read_at"\`` with the correct tag. So `read_at` reaches the client with
**no serialization changes at all** — no new struct, no handler mapping.

Feature 4 introduces `services.MessageView` because an image message needs a derived URL that has
no column behind it. Leave that refactor there (overview decision D2): doing it here would be a
shape change with nothing yet requiring it, and feature 4 would have to touch every field again
anyway.

## Acceptance criteria (backend)

- [ ] `POST /chats/{id}/read` sets `read_at` on the caller's unread inbox for that chat only.
- [ ] It does **not** touch messages the caller sent.
- [ ] It does not move an already-set `read_at` — call it twice, second returns `marked: 0` and
      the timestamps from the first call are unchanged.
- [ ] A non-participant gets `404` and nothing is written.
- [ ] The sender receives `kind: 5` over their socket with the chat id and timestamp.
- [ ] The reader does **not** receive their own `kind: 5`.
- [ ] With the sender offline, the read still persists and shows in their history on next fetch.
- [ ] `GET /chats` returns `unread_count` per chat, counting only messages from others.
- [ ] `GET /chats/{id}/messages` includes `read_at` on every message.

---

# Frontend

## Types (`src/types/api.ts`)

```ts
export interface Message {
  // …existing
  read_at: string | null
}

export interface ChatSummary {
  // …existing
  unread_count: number
}
```

`WSKind` in `use-chat-socket.ts` gains `MessagesRead: 5`, and `WSMessage` gains
`read_at?: string`.

## Marking read

**Trigger:** an effect in `ChatPage` that fires when *all* of these hold — the chat is active, its
`unread_count > 0`, and `document.visibilityState === 'visible'`.

This condition is self-limiting and needs no debounce, timer, or "already marked" ref: the
mutation drives `unread_count` to `0`, which is exactly the thing that stops the effect refiring.
A message arriving in the open chat pushes the count back to `1` and re-fires it — which is the
behaviour you want anyway.

Set `unread_count: 0` optimistically in `onMutate` rather than waiting for the response, or the
effect fires a second time while the first request is still in flight.

Also re-check on `visibilitychange`, so a tab left open on a chat marks the backlog read when the
user comes back rather than on their next click.

```ts
// modules/chat/hooks/use-chat.ts
export function useMarkChatRead() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (chatId: string) => chatApi.markRead(chatId),
    onMutate: (chatId) => {
      // Clears the condition that triggered this, so the effect settles.
      queryClient.setQueryData<ChatSummary[]>(queryKeys.chats, (current) =>
        current?.map((c) => (c.chat_id === chatId ? { ...c, unread_count: 0 } : c)),
      )
    },
    onSuccess: (_data, chatId) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.messages(chatId) })
    },
  })
}
```

## Applying `kind: 5`

`useChatRealtime` gains an `applyMessagesRead({ chat_id, read_at })` handler that walks the cached
message list for that chat and stamps every message whose `read_at` is `null` **and** whose
`sent_at <= read_at`:

```ts
queryClient.setQueryData<Message[]>(queryKeys.messages(chatId), (current) =>
  current?.map((m) =>
    m.read_at === null && Date.parse(m.sent_at) <= Date.parse(readAt)
      ? { ...m, read_at: readAt }
      : m,
  ),
)
```

No refetch — the push carries everything needed, and a `GET /messages` for a long history is
exactly what the socket exists to avoid.

## Ticks (`MessageList`)

Render on **outgoing messages only**. Incoming bubbles never show ticks — a tick on someone else's
message is meaningless and WhatsApp doesn't do it either.

**Always a double check.** There is no single-check state and none is needed: `use-chat.ts`
inserts nothing optimistically, so every rendered message is already the server's echo. A single
check would be a state the UI can never be in.

| State | Colour | Token |
|---|---|---|
| `read_at === null` | muted grey | `text-white/45` |
| `read_at !== null` | mint | `text-success-500` (`#2fe6b8`) |

**Mint, not brand.** Own bubbles are the brand gradient (`#6c5ce7 → #8b7cf6`), so a brand-coloured
tick is invisible on its own background. `--color-success-500` is the project's existing
positive-state token — it already marks the connected socket dot — and reads cleanly on purple.

Place the ticks inline with the timestamp in the existing footer row (`mt-1 text-right`), tick
after the time, `aria-label` of `"Read"` / `"Sent"` so the state is not colour-only.

Add the glyph to `public/icons.svg` or inline it — two overlapping polylines:

```
M1 8.5 L4.2 12 L10.5 4.5      (first check)
M6.5 8.5 L9.7 12 L16 4.5      (second, offset right)
```

## Sidebar (`ChatSidebar`)

Per the requirement — a chat with `unread_count > 0`:

1. **Pill** with the count, right-aligned under the timestamp, in the brand gradient with white
   text. Cap the display at `99+`; the count itself stays exact.
2. **Preview text brightened** from `text-gray-300` (`#5c6472`) to `text-gray-100` (`#eef1f5`).
   That is the "lighter colour" in the requirement — the dim grey is the read state, and it stays
   exactly as it is today for read chats.
3. Leave the name, avatar, and timestamp alone. Read chats are pixel-identical to today.

```tsx
<div className="mt-0.5 flex items-center justify-between gap-2">
  <p className={`truncate font-manrope text-[13px] ${
    unread ? 'text-gray-100' : 'text-gray-300'
  }`}>
    {chat.last_message ?? 'Say hello 👋'}
  </p>

  {unread && (
    <span
      aria-label={`${chat.unread_count} unread messages`}
      className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,var(--color-brand-500),var(--color-brand-400))] px-1.5 font-sora text-[11px] font-bold text-white"
    >
      {chat.unread_count > 99 ? '99+' : chat.unread_count}
    </span>
  )}
</div>
```

The example in the requirement — *sitting in chat A while chat B receives a message* — falls out
of this without special handling: the socket's `applyMessage` already updates chat B's row in the
`chats` cache, so incrementing `unread_count` there when `message.sender_id !== currentUserId`
**and** `message.chat_id !== activeChatId` is the only addition. `useChatRealtime` needs the
active chat id for that test; pass it in as an option.

## Acceptance criteria (frontend)

- [ ] Opening a chat with unread messages clears its pill and marks them read.
- [ ] Own messages show a grey double-check, which turns mint when the other user opens the chat —
      live, without a refresh.
- [ ] Incoming messages show no ticks.
- [ ] Sitting in chat A while chat B receives a message: B's row shows a pill with the count and a
      brightened preview; A stays clear.
- [ ] Receiving a message in the **currently open** chat marks it read immediately and never
      shows a pill for it.
- [ ] A chat with no unread messages renders exactly as it does today.
- [ ] Backgrounding the tab, receiving messages, then returning marks them read on focus.
- [ ] The read effect does not loop — network tab shows one `POST /read` per batch, not a stream.
