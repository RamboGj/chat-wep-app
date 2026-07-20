# Feature 2 — Friends & Invitations

Friends are the prerequisite for chatting. A user invites another **by username**; the target
accepts (which creates a 1:1 chat) or rejects (which deletes the invite). "Friends" are simply
the user's 1:1 chats — there is no separate friendships table.

## Model recap (see `00-overview.md` decision #3)

- **Invite** → insert a pending `friend_invitations` row (`accepted_at IS NULL`).
- **Accept** → single transaction: create 1 `chats` row + 2 `chat_participants` rows + set the
  invite's `accepted_at`.
- **Reject** → delete the invitation row.
- **List invites** → the caller's pending invitations (not accepted, not rejected/deleted).
- **List friends** → the caller's chats + the other participant of each.
- **Remove friend** → single transaction: hard-delete the `chats` row; `ON DELETE CASCADE`
  removes its `chat_participants` and `messages`.

All multi-step writes MUST be transactional (`pool.Begin` → `queries.WithTx(tx)` →
`Commit`/`Rollback`) so there is never partial state.

## Endpoints

| Method | Path | Auth | Body | Success |
|---|---|---|---|---|
| POST | `/api/v1/friends/invites` | ✔ | `{username}` | `201 {invite_id}` |
| GET | `/api/v1/friends/invites` | ✔ | — | `200 {invites:[...]}` (pending received) |
| POST | `/api/v1/friends/invites/{invite_id}/accept` | ✔ | — | `201 {chat_id}` |
| POST | `/api/v1/friends/invites/{invite_id}/reject` | ✔ | — | `204` |
| GET | `/api/v1/friends` | ✔ | — | `200 {friends:[{chat_id, user_id, username}]}` |
| DELETE | `/api/v1/friends/{chat_id}` | ✔ | — | `204` |

`GET /friends/invites` returns invites **received** by the caller (`to_user_id = caller`,
`accepted_at IS NULL`), each with `from` user info. Optionally also expose sent invites via a
`?direction=sent` filter — not required for MVP.

## DTO (`internal/usecase/friend`)

- `CreateInviteRequest{username}` — `username` not blank & ≤ 50 chars.

Accept/reject/remove take their id from the URL param (`chi.URLParam(r, "invite_id")` /
`"chat_id"`), parsed with `uuid.Parse` (bad uuid → `400`).

## Service (`internal/services/friend_service.go`)

```
CreateInvite(ctx, fromID uuid.UUID, toUsername string) (uuid.UUID, error)
    - resolve toID from username (GetUserByUsername); not found → ErrUserNotFound
    - toID == fromID → ErrSelfInvite
    - already friends (a chat with both) → ErrAlreadyFriends
    - existing pending invite either direction → ErrInviteExists
    - INSERT; map 23505 → ErrInviteExists
    - returns invite id

ListPendingInvites(ctx, toID uuid.UUID) ([]InviteView, error)   // accepted_at IS NULL

AcceptInvite(ctx, inviteID, callerID uuid.UUID) (AcceptedInvite, error)   // TRANSACTION
    - load invite; not found → ErrInviteNotFound
    - invite.to_user_id != callerID → ErrNotInviteRecipient
    - invite.accepted_at != NULL → ErrInviteAlreadyResolved
    - CreateChat → AddChatParticipant(from) → AddChatParticipant(to) → MarkInviteAccepted
    - returns {ChatID, InviterID}; the handler pushes KindChatCreated to the
      inviter over the hub, who otherwise never learns the chat exists

RejectInvite(ctx, inviteID, callerID uuid.UUID) error
    - load + authorize recipient; DeleteInvite

ListFriends(ctx, userID uuid.UUID) ([]FriendView, error)
    - the caller's non-deleted chats + the OTHER participant (id, username)

RemoveFriend(ctx, chatID, callerID uuid.UUID) error   // TRANSACTION
    - verify caller participates in chatID → else ErrNotParticipant
    - DeleteChat(chatID)  // cascades to participants + messages
```

Sentinel errors: `ErrUserNotFound`, `ErrSelfInvite`, `ErrAlreadyFriends`, `ErrInviteExists`,
`ErrInviteNotFound`, `ErrNotInviteRecipient`, `ErrInviteAlreadyResolved`, `ErrNotParticipant`.

### Handler → HTTP mapping

| Error | Status |
|---|---|
| `ErrUserNotFound` | 404 |
| `ErrSelfInvite` | 422 |
| `ErrAlreadyFriends`, `ErrInviteExists` | 409 |
| `ErrInviteNotFound`, `ErrNotParticipant` | 404 |
| `ErrNotInviteRecipient` | 403 |
| `ErrInviteAlreadyResolved` | 409 |
| (other) | 500 |

## Queries (`queries/friend_invitations.sql`, `queries/chats.sql`)

- `GetUserByUsername :one`
- `CreateFriendInvitation :one` (RETURNING id)
- `ListPendingInvitesForUser :many` (join `from` user; `to_user_id = $1 AND accepted_at IS NULL`)
- `GetInviteByID :one`, `MarkInviteAccepted :exec`, `DeleteInvite :exec`
- `FriendshipExists :one` — is there a chat both users participate in? (guards `ErrAlreadyFriends`)
- `CreateChat :one`, `AddChatParticipant :exec`, `DeleteChat :exec`
- `IsChatParticipant :one`, `ListFriends :many` (caller's chats + other participant)

## Acceptance criteria

- [ ] Inviting a non-existent username → `404`.
- [ ] Inviting yourself → `422`.
- [ ] Inviting an existing friend → `409`.
- [ ] Duplicate pending invite (either direction) → `409`, and no second row exists.
- [ ] Recipient sees the invite in `GET /friends/invites`; the sender's pending invite is not
      shown to the recipient as "sent".
- [ ] Accepting creates exactly one chat and two participants; the invite's `accepted_at` is set
      — all-or-nothing (kill the process mid-accept → no orphan chat).
- [ ] A non-recipient accepting/rejecting → `403`.
- [ ] Accepting an already-resolved invite → `409`.
- [ ] Rejecting deletes the invitation row; it disappears from the pending list.
- [ ] `GET /friends` lists the accepted friend with the shared `chat_id`.
- [ ] `DELETE /friends/{chat_id}` removes the chat, both participant rows, and all its messages
      atomically; a non-participant gets `404`.
