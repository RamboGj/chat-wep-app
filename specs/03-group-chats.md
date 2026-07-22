# Feature 3 — Group Chats

> **Deferred to the next stage.** Read receipts (feature 2) and image messages (feature 4) ship
> first. This spec assumes both have landed, so `messages.read_at`, `messages.type`,
> `ChatSummary.unread_count`, `ChatSummary.last_message_type` and `services.MessageView` already
> exist. Re-read [`02-read-receipts.md`](./02-read-receipts.md#semantics-and-their-limits) before
> starting — groups are what makes `read_at` approximate.

A user picks up to four friends, names the group, and creates it. One `chats` row plus one
`chat_participants` row per member, in a single transaction. Messaging, history, and the hub
fan-out already work for N participants and need no changes.

The hard part is not creating groups — it is that three existing queries say "chat" and mean
"1:1 chat".

## Flow

1. User opens the "New group" dialog.
2. Sees their friends list (`GET /friends`).
3. Selects 1–4 of them.
4. Types a group name.
5. Submits → `POST /api/v1/chats`.
6. Backend creates the chat + all `chat_participants` rows in one transaction and pushes
   `KindChatCreated` to every member except the creator.
7. The chat appears in everyone's sidebar; the creator's client opens it.

**Limit: 5 participants total, creator included** — so at most 4 selected friends.

---

# Backend

## Migration — `008_add_is_group_to_chats.sql`

```sql
-- Write your migrate up statements here
-- Every chat that exists today is a 1:1 chat, so FALSE is the correct backfill.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS is_group BOOLEAN NOT NULL DEFAULT FALSE;

-- A group without a name would render as an unlabelled row in every sidebar.
ALTER TABLE chats ADD CONSTRAINT chats_group_has_title
    CHECK (NOT is_group OR title IS NOT NULL);
---- create above / drop below ----
ALTER TABLE chats DROP CONSTRAINT IF EXISTS chats_group_has_title;
ALTER TABLE chats DROP COLUMN IF EXISTS is_group;
```

`chats.title` stops being reserved and becomes the group name. It stays `NULL` for 1:1 chats,
whose display name is still the other participant's username.

### Why a column instead of counting participants

`COUNT(chat_participants) > 2` would work and needs no migration. It is the wrong call here
because of the three queries below: each one would need a correlated subquery in its `WHERE`
clause, and each would be one refactor away from silently losing the guard. A boolean makes the
fix `AND c.is_group = FALSE` — greppable, and obvious when it's missing.

The five-participant cap is **not** a DB constraint. A `CHECK` cannot span rows, and a trigger to
enforce it is disproportionate when there is exactly one write path (creation — there is no
add-member endpoint) and it runs inside a transaction. Enforce it in the service.

## Existing queries that MUST be fixed

This is the load-bearing part of the feature. Missing any of these is a data-integrity bug, not a
cosmetic one.

### 1. `ListFriends` — add `AND c.is_group = FALSE`

Without it, every member of a group appears in every other member's **friends list**, and the
group's `chat_id` is reported as a friendship. The friend list would then offer to "remove" a
group.

### 2. `FriendshipExists` — add `AND c.is_group = FALSE`

This guards `ErrAlreadyFriends` on invite. Without the filter, sharing a group with someone makes
`POST /friends/invites` reject a genuine friend request with `409`, and the two users can never
become actual friends.

### 3. `IsChatParticipant` as used by `RemoveFriend` — restrict to 1:1

`DELETE /friends/{chat_id}` hard-deletes the chat and cascades to its messages. Pointed at a group
id it would let any member nuke the group for everyone. Add a dedicated query and use it **only**
in `FriendService.RemoveFriend`:

```sql
-- Remove-friend targets a friendship, which is a 1:1 chat. A group id must not
-- match here, or any member could delete the group for everyone.
-- name: IsDirectChatParticipant :one
SELECT EXISTS (
    SELECT 1
    FROM chat_participants cp
    JOIN chats c ON c.id = cp.chat_id
    WHERE cp.chat_id = $1 AND cp.user_id = $2 AND c.is_group = FALSE
);
```

A group id then falls through the existing `!participates → ErrNotParticipant` branch and returns
`404`. No new sentinel error, no new HTTP mapping, and the response doesn't confirm the group
exists.

Leave the plain `IsChatParticipant` alone — `ListMessages`, `MarkChatRead`, and `CreateMessage`
all need it to match groups.

## New queries — `queries/chats.sql`

```sql
-- name: CreateGroupChat :one
INSERT INTO chats (title, is_group)
VALUES ($1, TRUE)
RETURNING id;

-- How many of the given user ids are actually 1:1 friends of the caller? The
-- service compares this against the requested count instead of round-tripping
-- per id, and a mismatch is all it needs to reject the request.
-- name: CountFriendsAmong :one
SELECT COUNT(DISTINCT other.user_id)
FROM chat_participants self
JOIN chats c
  ON c.id = self.chat_id AND c.is_group = FALSE AND c.deleted_at IS NULL
JOIN chat_participants other
  ON other.chat_id = self.chat_id AND other.user_id <> self.user_id
WHERE self.user_id = $1
  AND other.user_id = ANY($2::uuid[]);
```

The existing `CreateChat` (`VALUES (NULL)`) keeps working — `is_group` defaults to `FALSE` — but
make it explicit (`VALUES (NULL, FALSE)`) so the two creation paths read as a pair.

## `ListChatsForUser` — rewritten

The current query joins "the other participant". With three participants it returns **two rows for
the same chat**, so the sidebar would show the group twice under two different names. It has to go.

Split into two queries and stitch in Go:

```sql
-- One row per chat. No participant join: with more than two members that join
-- multiplies rows, and the participants come from the query below instead.
-- name: ListChatsForUser :many
SELECT c.id AS chat_id,
       c.title,
       c.is_group,
       last.content AS last_message,
       last.sent_at AS last_message_at,
       last.type    AS last_message_type,
       (SELECT COUNT(*)
        FROM messages um
        WHERE um.chat_id = c.id
          AND um.sender_id <> $1
          AND um.read_at IS NULL) AS unread_count
FROM chat_participants self
JOIN chats c ON c.id = self.chat_id
LEFT JOIN messages last ON last.id = (
    SELECT m.id
    FROM messages m
    WHERE m.chat_id = c.id
    ORDER BY m.sent_at DESC
    LIMIT 1
)
WHERE self.user_id = $1
  AND c.deleted_at IS NULL
ORDER BY COALESCE(last.sent_at, c.created_at) DESC;

-- Everyone in the caller's chats except the caller, for stitching onto the
-- rows above. One extra round trip, no aggregation.
-- name: ListParticipantsForUserChats :many
SELECT cp.chat_id, u.id AS user_id, u.username
FROM chat_participants cp
JOIN users u ON u.id = cp.user_id
WHERE cp.user_id <> $1
  AND cp.chat_id IN (SELECT chat_id FROM chat_participants WHERE user_id = $1)
ORDER BY u.username;
```

`unread_count` and `last_message_type` already exist on the current query (features 2 and 4) —
carry them across the rewrite unchanged. The `unread_count` subquery in particular is easy to drop
on the floor here, and losing it silently zeroes every unread pill.

**Alternative considered:** a single query with `json_agg` over the participants. One round trip,
but sqlc types the aggregate as `[]byte` and the service unmarshals hand-written JSON, which
trades a cheap query for a fragile one. Two queries is the better shape at this size.

## `ChatSummary` v2

```go
type ChatParticipantView struct {
    UserID   uuid.UUID `json:"user_id"`
    Username string    `json:"username"`
}

type ChatSummary struct {
    ChatID          uuid.UUID             `json:"chat_id"`
    Title           *string               `json:"title"`         // group name; nil for 1:1
    IsGroup         bool                  `json:"is_group"`
    Participants    []ChatParticipantView `json:"participants"`  // everyone EXCEPT the caller
    LastMessage     *string               `json:"last_message"`
    LastMessageAt   *time.Time            `json:"last_message_at"`
    LastMessageType string                `json:"last_message_type"` // feature 4
    UnreadCount     int64                 `json:"unread_count"`      // feature 2
}
```

`OtherUserID` and `OtherUsername` are **removed**. There is no meaningful "other user" in a group,
and keeping them populated for 1:1 only would give the frontend two code paths for the same
question. Display name is derived client-side: `title ?? participants[0].username`.

`Participants` excludes the caller — the client already knows who it is, and every consumer
(avatar, header subtitle, sender lookup) wants the others. For a 1:1 chat it has exactly one
entry, which is the old `other_*` pair.

This breaks `GET /api/v1/chats` for any existing client. There is one client and it ships in the
same change; see decision D1 in the overview.

## Service — `ChatService`

```go
const MaxChatParticipants = 5

CreateGroupChat(ctx, creatorID uuid.UUID, title string, participantIDs []uuid.UUID)
    (uuid.UUID, error)                                          // TRANSACTION
    - dedupe participantIDs; drop creatorID if present
    - len(unique) == 0                        → ErrEmptyGroup
    - len(unique)+1 > MaxChatParticipants     → ErrTooManyParticipants
    - CountFriendsAmong(creatorID, unique) != len(unique) → ErrNotFriends
    - CreateGroupChat(title)
    - AddChatParticipant for creatorID and each unique id
    - commit; return chatID
```

Dedupe **before** counting, so `[a, a, b, c, d]` is a 3-person group and not a limit violation.
Drop the creator silently rather than erroring — a client including itself in its own group is a
reasonable thing to send.

The friendship requirement means you cannot pull a stranger into a group. It also means group
membership can outlive the friendship, since removing a friend deletes only the 1:1 chat. That is
correct: leaving a group is a separate action nobody has (see [Deferred](#deferred)).

New sentinel errors on `services`:

| Error | Status |
|---|---|
| `ErrEmptyGroup` | 422 |
| `ErrTooManyParticipants` | 422 |
| `ErrNotFriends` | 422 |

Wire them into `respondChatError`.

## DTO — `internal/usecase/chat/create_group.go`

```go
type CreateGroupChatRequest struct {
    Title          string      `json:"title"`
    ParticipantIDs []uuid.UUID `json:"participant_ids"`
}
```

`Valid(ctx)` via the `Evaluator`:

- `title` — trimmed, not blank, ≤ 50 chars.
- `participant_ids` — at least 1, at most `MaxChatParticipants - 1` (= 4).

Malformed uuids fail at decode time and surface as `422` through `DecodeValidJson`, matching every
other DTO in the project. The service re-checks the count after deduping; the DTO check is there
to reject an obviously-bad payload before it reaches a transaction.

## Endpoint

| Method | Path | Auth | Body | Success |
|---|---|---|---|---|
| POST | `/api/v1/chats` | ✔ | `{title, participant_ids[]}` | `201 {chat_id}` |

```go
r.Post("/", api.handleCreateGroupChat)
```

registered next to `r.Get("/", api.handleListChats)` inside the existing `/chats` route group, so
it inherits `AuthMiddleware`.

After a successful commit the handler pushes `KindChatCreated` to every participant except the
creator — same pattern as accept-invite, which pushes to the inviter:

```go
for _, id := range participantIDs {
    api.Hub.NotifyUser(r.Context(), id, WSMessage{Kind: KindChatCreated, ChatID: chatID})
}
```

No new message kind. `KindChatCreated` already means "a chat you're in now exists, refetch", and
the client already handles it by invalidating the chat list.

## Acceptance criteria (backend)

- [ ] `POST /chats` with a title and 1–4 friend ids creates one chat (`is_group = TRUE`, title
      set) and `n+1` participant rows — atomically.
- [ ] Selecting 5+ friends → `422`, nothing written.
- [ ] Including a non-friend's id → `422`, nothing written.
- [ ] Including your own id is tolerated and does not create a duplicate participant row.
- [ ] Duplicate ids in the payload collapse to one participant.
- [ ] Blank or missing title → `422`.
- [ ] Every member except the creator receives `kind: 4` over their socket.
- [ ] `GET /chats` returns **one** row per group with `is_group: true`, the title, and all other
      members in `participants`.
- [ ] `GET /chats` still returns 1:1 chats with `is_group: false`, `title: null`, and exactly one
      entry in `participants`.
- [ ] A message sent to a group reaches all connected members and persists.
- [ ] `GET /friends` does **not** list group members as friends.
- [ ] Inviting someone you share a group with (but are not friends with) succeeds — no false
      `ErrAlreadyFriends`.
- [ ] `DELETE /friends/{group_chat_id}` → `404`, and the group still exists with all its messages.
- [ ] `DELETE /friends/{direct_chat_id}` still works.

---

# Frontend

## Types

```ts
export interface ChatParticipant {
  user_id: string
  username: string
}

export interface ChatSummary {
  chat_id: string
  title: string | null
  is_group: boolean
  participants: ChatParticipant[]
  last_message: string | null
  last_message_at: string | null
  last_message_type: 'text' | 'image'   // feature 4
  unread_count: number                  // feature 2
}
```

`other_user_id` / `other_username` are gone. Add one helper next to the type and use it everywhere
a chat needs a label, so the fallback lives in exactly one place:

```ts
// src/modules/chat/lib/chat-display.ts
export function chatDisplayName(chat: ChatSummary): string {
  return chat.title ?? chat.participants[0]?.username ?? 'Unknown'
}
```

The `?? 'Unknown'` guards a chat whose only other participant deleted their account — the
`ON DELETE CASCADE` on `chat_participants` leaves the chat row with one member.

Call sites to update: `ChatSidebar` (name + avatar + search filter), `ChatPage` (header, avatar,
remove-friend confirm text).

## Creating a group

**Entry point.** The header's `+ New chat` button becomes a two-item menu:

- *Invite a friend* → the existing `NewChatDialog` (unchanged — it sends an invitation, it does
  not create a chat)
- *New group* → the new `NewGroupDialog`

Keep the button's gradient styling and its `sr-only sm:not-sr-only` label collapse. Close the menu
on outside click and `Escape`, matching `NewChatDialog`'s existing keydown handling.

**`modules/friends/components/NewGroupDialog.tsx`** — mirror `NewChatDialog`'s structure: mounted
only while open (so state resets for free), overlay click and `Escape` close, `role="dialog"` +
`aria-modal`, same panel classes.

Contents:

- Group name `<Input>`, `autoFocus`, `maxLength={50}`.
- Friend list from `useFriends()`, each row a checkbox-style toggle with `Avatar` + username.
  Scrollable (`max-h-64 overflow-y-auto scroll-surface`) — the list is unbounded.
- A counter: `{selected.length}/4 selected`. Once 4 are selected, unselected rows are
  `disabled` with `opacity-50` rather than hidden, so the limit is visible instead of mysterious.
- Empty state when the user has no friends: *"Add a friend first — groups are built from your
  friends list."*
- Submit disabled until a non-blank name and ≥ 1 friend. `loading` from the mutation.
- On success: close, and select the new chat (the mutation returns `chat_id`).

```ts
// modules/chat/hooks/use-chat.ts
export function useCreateGroupChat() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { title: string; participant_ids: string[] }) =>
      chatApi.createGroup(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.chats }),
  })
}
```

Surface backend `422`s inline via the existing `requestFieldErrors` helper — the DTO returns
per-field messages keyed `title` / `participant_ids`, which is exactly what that helper reads.

## Sidebar

- Name: `chatDisplayName(chat)`.
- Avatar: `name={chatDisplayName(chat)}` — the existing initials avatar works for a group name.
- Add a small group glyph (`lucide-react`'s `Users`, already a dependency) next to the name when
  `is_group`, so a group named after a person isn't mistaken for a 1:1.
- Search filter matches the display name **and** any participant username, so a group is findable
  by who's in it.

## Chat header (`ChatPage`)

| | 1:1 | Group |
|---|---|---|
| Title | username | `chat.title` |
| Subtitle | `Live` / `Reconnecting…` | participant usernames, comma-joined, truncated |
| Action | *Remove friend* | **nothing** |

**Hide "Remove friend" for groups.** The backend now returns `404` for that call on a group
(`IsDirectChatParticipant`), so leaving the button visible would render a dead control that
reports "chat not found". There is no group equivalent yet — see below.

## Message list

Group messages need a sender label; incoming bubbles are otherwise unattributable.

Add `showSenderNames?: boolean` to `MessageList` (true when `chat.is_group`) and resolve names
from a `Map<string, string>` built from `chat.participants`. **No backend change** — the message
payload already carries `sender_id`, and the chat summary already carries id→username for everyone
else in the chat.

Render above the content on incoming bubbles only, in `text-[11px] font-semibold text-brand-100`.
Own messages never get a label. Consecutive messages from the same sender may collapse to one
label; nice, not required.

An unresolvable `sender_id` (a departed member) falls back to `'Unknown'` rather than rendering
blank.

## Acceptance criteria (frontend)

- [ ] "New group" opens a dialog listing the user's friends.
- [ ] Selecting a 5th friend is blocked and the limit is visibly communicated.
- [ ] Submitting with a name and 1–4 friends creates the group, closes the dialog, and opens the
      new chat.
- [ ] The group appears in every member's sidebar without a manual refresh.
- [ ] The sidebar shows the group name and a group indicator.
- [ ] Incoming group messages are labelled with the sender's username; own messages are not.
- [ ] The group header shows the member list and **no** remove-friend button.
- [ ] 1:1 chats look and behave exactly as they do today.
- [ ] Searching a group by a member's username finds it.

---

## Deferred

**Leaving or deleting a group is not in this feature.** Combined with hiding remove-friend for
groups, that makes a group permanent for everyone in it. This is a real gap, called out so it is
a decision and not a surprise — the natural follow-up is
`DELETE /api/v1/chats/{chat_id}/participants/me`, deleting the caller's `chat_participants` row
and hard-deleting the chat when the last member leaves.

Also out of scope: adding members after creation, renaming a group, group avatars, and admin
roles. Each would need its own participant-limit check at a second write path — the reason the cap
lives in the service is that today there is only one.
