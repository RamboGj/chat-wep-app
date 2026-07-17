# Real-time hub

Adapts go-bid's `AuctionRoom` event-loop pattern into a **single global, multiplexed hub**.
go-bid ran one room (one socket) per auction with a deadline; here there is one long-lived hub,
one socket per **user**, and messages are routed by `chat_id`.

## Topology

- Each user opens **one** WebSocket at `GET /api/v1/ws` (behind `AuthMiddleware` → userID from
  the `access_token` cookie).
- The hub keeps `Clients map[uuid.UUID]*Client` (userID → connection).
- An inbound message names a `chat_id`. The hub verifies the sender participates in that chat,
  persists the message, looks up the chat's participants, and pushes the stored message to each
  participant that is currently connected.
- Chat **history** is loaded over REST (`GET /chats/{id}/messages`), not the socket. The socket
  carries only live messages.

## Structs

```go
type Hub struct {
	Register   chan *Client
	Unregister chan *Client
	Inbound    chan Inbound        // {SenderID, WSMessage}
	Clients    map[uuid.UUID]*Client

	ChatService    *services.ChatService
	MessageService *services.MessageService
}

type Client struct {
	Hub    *Hub
	Conn   *websocket.Conn
	Send   chan WSMessage       // buffered (e.g. 256)
	UserID uuid.UUID
}

type MessageKind int
const (
	KindSendMessage MessageKind = iota // client → server: {chat_id, content}
	KindNewMessage                     // server → participants: full persisted message
	KindError                          // server → sender
	KindInvalidJSON                    // server → sender
)

type WSMessage struct {
	Kind     MessageKind `json:"kind"`
	ChatID   uuid.UUID   `json:"chat_id,omitempty"`
	Content  string      `json:"content,omitempty"`
	// populated on outbound KindNewMessage:
	ID       uuid.UUID   `json:"id,omitempty"`
	SenderID uuid.UUID   `json:"sender_id,omitempty"`
	SentAt   time.Time   `json:"sent_at,omitempty"`
	Message  string      `json:"message,omitempty"` // error text
}
```

## Hub event loop (single goroutine owns `Clients` — no lock)

```go
func (h *Hub) Run() {
	for {
		select {
		case c := <-h.Register:
			h.Clients[c.UserID] = c
		case c := <-h.Unregister:
			if _, ok := h.Clients[c.UserID]; ok {
				delete(h.Clients, c.UserID)
				close(c.Send)
			}
		case in := <-h.Inbound:
			h.handleInbound(in)
		}
	}
}

func (h *Hub) handleInbound(in Inbound) {
	switch in.Msg.Kind {
	case KindSendMessage:
		// SenderID is server-authoritative (from the socket), NOT from the payload.
		msg, err := h.MessageService.CreateMessage(ctx, in.Msg.ChatID, in.SenderID, in.Msg.Content)
		if err != nil {
			if errors.Is(err, services.ErrNotParticipant) {
				h.sendTo(in.SenderID, WSMessage{Kind: KindError, Message: "not a participant of this chat"})
			}
			return
		}
		participants, _ := h.ChatService.ParticipantIDs(ctx, in.Msg.ChatID)
		out := WSMessage{Kind: KindNewMessage, ID: msg.ID, ChatID: msg.ChatID,
			SenderID: msg.SenderID, Content: msg.Content, SentAt: msg.SentAt}
		for _, uid := range participants { // includes sender → doubles as the ack
			h.sendTo(uid, out)
		}
	}
}

func (h *Hub) sendTo(userID uuid.UUID, m WSMessage) {
	if c, ok := h.Clients[userID]; ok {
		select {
		case c.Send <- m:
		default: // slow/stuck client: drop it rather than block the hub
			h.Unregister <- c
		}
	}
}
```

`CreateMessage` must enforce membership atomically — e.g. `INSERT ... SELECT ... WHERE EXISTS
(participant row)` returning the row, mapping "no row" to `ErrNotParticipant`. That keeps the
authorization check and the write in one statement.

## Per-client pump goroutines (mirror go-bid exactly)

Two goroutines per connection; **each closes the conn in its own defer** — the upgrade handler
must not close it.

- `ReadPump`: sets read limit + read deadline + pong handler; loops `ReadJSON`; on a JSON
  syntax/type error replies `KindInvalidJSON` to the sender and keeps reading; on any other
  error `return`s (which unregisters via defer). Forwards valid messages as
  `h.Inbound <- Inbound{SenderID: c.UserID, Msg: m}`.
- `WritePump`: `ticker` at `pingPeriod`; drains `c.Send` → `WriteJSON`; on ticker → `PingMessage`;
  on `c.Send` closed → send close frame and return.

Constants from go-bid: `maxMessageSize = 512`, `readDeadline = 60s`, `writeWait = 10s`,
`pingPeriod = readDeadline * 9 / 10`.

## Upgrade handler

```go
func (api *Api) handleWS(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(userIDKey).(uuid.UUID)
	conn, err := api.WsUpgrader.Upgrade(w, r, nil)
	if err != nil { /* EncodeJson 500 */ return }

	client := &Client{Hub: api.Hub, Conn: conn, Send: make(chan WSMessage, 256), UserID: userID}
	api.Hub.Register <- client
	go client.WritePump()
	go client.ReadPump()
}
```

## Scaling note (MVP-acceptable)

`handleInbound` does DB work inside the single hub goroutine, so all messages across all chats
are serialized through it — same tradeoff as go-bid's `broadcastMessage`. Fine for the MVP.
When it becomes a bottleneck, move persistence to a worker pool or a per-chat goroutine, keeping
only the `Clients` map mutation on the hub goroutine. A single-process hub also means horizontal
scaling later needs a pub/sub fan-out (e.g. Postgres `LISTEN/NOTIFY` or Redis) between instances.
