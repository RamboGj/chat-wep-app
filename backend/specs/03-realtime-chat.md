# Feature 3 — Real-time Chat

Friends exchange messages in their 1:1 chat in real time over a **single multiplexed WebSocket
per user**. History and the chat list are served over REST. Full hub/client design lives in the
`go-chat-backend` skill → `references/realtime-hub.md`; this spec is the feature contract.

## Connection model

- One socket per user: `GET /api/v1/ws`, behind `WSAuthMiddleware`. The browser's WebSocket
  API cannot set an `Authorization` header, so the client offers the subprotocols
  `["bearer", "<access token>"]` and the server selects `"bearer"`. The query string is not
  used: chi's request logger would record the token.
- The `Hub` is a single long-lived goroutine created in `cmd/api/main.go` (`go hub.Run()`) and
  injected into `api.Api`. It owns `Clients map[uuid.UUID]*Client` — no mutex needed.
- Inbound message names a `chat_id`; the hub authorizes the sender, persists, and pushes the
  stored message to every **connected** participant of that chat (including the sender, which
  doubles as the ack).

## Envelope (JSON over the socket)

Client → server:
```json
{ "kind": 0, "chat_id": "<uuid>", "content": "hello" }
```
Server → client (`kind: 1` new message):
```json
{ "kind": 1, "id": "<uuid>", "chat_id": "<uuid>", "sender_id": "<uuid>",
  "content": "hello", "sent_at": "2026-07-16T12:00:00Z" }
```
Server → client errors: `{ "kind": 2, "message": "..." }` (e.g. not a participant),
`{ "kind": 3, "message": "this message should be a valid json" }`.

`MessageKind`: `0 KindSendMessage`, `1 KindNewMessage`, `2 KindError`, `3 KindInvalidJSON`,
`4 KindChatCreated` (server → inviter, carries only `chat_id`; queued from the accept-invite
handler via `Hub.NotifyUser`, not from a client frame).
**`sender_id` is server-authoritative** — taken from the authenticated socket, never trusted
from the payload.

## Entities

`chats`, `chat_participants`, `messages` — see [`schema.md`](./schema.md). Chats and
participants are created by Feature 2 (accept-invite); this feature reads them and writes
`messages`.

## Service (`internal/services`)

`ChatService`:
```
ListChatsForUser(ctx, userID) ([]ChatSummary, error)   // chat_id, other participant, last message
ParticipantIDs(ctx, chatID) ([]uuid.UUID, error)       // for hub fan-out
IsParticipant(ctx, chatID, userID) (bool, error)
ListMessages(ctx, chatID, userID, before time.Time, limit int) ([]pgstore.Message, error)
    - authorize participant first → else ErrNotParticipant
```

`MessageService`:
```
CreateMessage(ctx, chatID, senderID uuid.UUID, content string) (pgstore.Message, error)
    - authorize + insert in one statement (INSERT ... SELECT ... WHERE EXISTS participant),
      RETURNING the row; "no row" → ErrNotParticipant
    - reject empty/whitespace content → ErrEmptyMessage
```

Sentinel errors: `ErrNotParticipant`, `ErrEmptyMessage`.

## REST endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/v1/chats` | ✔ | list caller's chats (+ other participant, last message) |
| GET | `/api/v1/chats/{chat_id}/messages?before=<rfc3339>&limit=50` | ✔ | history, newest-first, participant-only |
| GET | `/api/v1/ws` | ✔ | upgrade to the multiplexed WebSocket |

`ListMessages` pages with a `before` cursor on `sent_at` (index `idx_messages_chat_sent`).
Default `limit` 50, cap at 100. Non-participant → `403`/`404`.

## Hub behavior (see skill reference for code)

1. Upgrade → build `Client{Send: make(chan WSMessage, 256)}` → `hub.Register <- client` →
   start `ReadPump` + `WritePump`.
2. `ReadPump`: read limit 512, read deadline 60s, pong handler resets deadline. Invalid JSON →
   reply `KindInvalidJSON` to sender, keep reading. Connection-level error → return (unregisters).
   Valid message → `hub.Inbound <- {SenderID: client.UserID, Msg}`.
3. `handleInbound` (`KindSendMessage`): `MessageService.CreateMessage`. `ErrNotParticipant` /
   `ErrEmptyMessage` → `KindError` to sender only. On success → `ParticipantIDs` → push
   `KindNewMessage` to each connected participant.
4. `WritePump`: drain `Send` → `WriteJSON`; ping every `pingPeriod` (54s); write deadline 10s.
   If a client's `Send` buffer is full, the hub drops that client rather than block.

## Acceptance criteria

- [ ] Connecting to `/ws` without a valid access token in `Sec-WebSocket-Protocol` → `401`,
      no upgrade. The successful handshake echoes `Sec-WebSocket-Protocol: bearer`.
- [ ] Two friends connected simultaneously: a message from A appears live for both A and B.
- [ ] The message persists to `messages` and appears in `GET /chats/{id}/messages` afterward.
- [ ] Sending to a `chat_id` the caller does not participate in → `KindError`, nothing persisted.
- [ ] Empty/whitespace content is rejected with `KindError`, nothing persisted.
- [ ] Sending while the recipient is offline persists the message; the recipient sees it in
      history on next `GET /chats/{id}/messages`.
- [ ] Malformed JSON on the socket → `KindInvalidJSON`, connection stays open.
- [ ] `sent_at`/`id` in the broadcast match the persisted row (server-authoritative).
- [ ] Idle connections stay alive via ping/pong (no drop within the 60s read deadline).
- [ ] `GET /chats/{id}/messages` paginates newest-first and honors `before` + `limit`.
