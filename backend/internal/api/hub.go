package api

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"backend/internal/services"

	"github.com/google/uuid"
)

// MessageKind is the envelope discriminator carried over the socket. The
// frontend mirrors these positionally, so the iota is append-only: renumbering
// a kind silently routes frames to the wrong handler in every tab still running
// the old build.
type MessageKind int

const (
	KindSendMessage MessageKind = iota // client → server: {chat_id, content}
	KindNewMessage                     // server → participants: the persisted message
	KindError                          // server → sender
	KindInvalidJSON                    // server → sender
	KindChatCreated                    // server → inviter: an invite of theirs was accepted
	KindMessagesRead                   // server → the other participants of a chat
)

// WSMessage is the single envelope in both directions.
type WSMessage struct {
	Kind    MessageKind `json:"kind"`
	ChatID  uuid.UUID   `json:"chat_id,omitempty"`
	Content string      `json:"content,omitempty"`

	// Populated on an outbound KindNewMessage.
	ID       uuid.UUID `json:"id,omitempty"`
	SenderID uuid.UUID `json:"sender_id,omitempty"`
	SentAt   time.Time `json:"sent_at,omitempty"`

	// Populated on KindMessagesRead: every message in the chat sent at or
	// before this is now read. A timestamp rather than a list of ids, because
	// the list is unbounded — a 500-message backlog would put 500 uuids in one
	// frame and the hub drops any client whose Send buffer backs up — and
	// because it closes the race where a message created after the UPDATE is
	// pushed before the receipt: such a message necessarily has a later sent_at.
	ReadAt *time.Time `json:"read_at,omitempty"`

	// Populated on KindError / KindInvalidJSON.
	Message string `json:"message,omitempty"`
}

// Inbound pairs a client's message with the user id of the socket it arrived
// on. SenderID comes from the authenticated connection, never from the payload.
type Inbound struct {
	SenderID uuid.UUID
	Msg      WSMessage
}

// Notification is a server-originated push aimed at one user, queued by code
// outside the hub goroutine (HTTP handlers). Clients is owned by Run, so those
// callers must go through the channel rather than touching the map.
type Notification struct {
	UserID uuid.UUID
	Msg    WSMessage
}

// hubDBTimeout bounds the DB work done on the hub goroutine: every message in
// the process is serialized through it, so a hung query must not wedge the hub.
const hubDBTimeout = 5 * time.Second

// Hub is a single long-lived goroutine that owns Clients, so the map needs no
// mutex. One socket per user; messages are routed by chat_id.
type Hub struct {
	Register   chan *Client
	Unregister chan *Client
	Inbound    chan Inbound
	Notify     chan Notification
	Clients    map[uuid.UUID]*Client

	chatService    services.ChatService
	messageService services.MessageService
}

func NewHub(chatService services.ChatService, messageService services.MessageService) *Hub {
	return &Hub{
		Register:       make(chan *Client),
		Unregister:     make(chan *Client),
		Inbound:        make(chan Inbound),
		Notify:         make(chan Notification),
		Clients:        make(map[uuid.UUID]*Client),
		chatService:    chatService,
		messageService: messageService,
	}
}

func (h *Hub) Run() {
	for {
		select {
		case c := <-h.Register:
			// One socket per user: a second connection replaces the first.
			if existing, ok := h.Clients[c.UserID]; ok && existing != c {
				delete(h.Clients, existing.UserID)
				close(existing.Send)
			}
			h.Clients[c.UserID] = c

		case c := <-h.Unregister:
			// Compare identity: a stale client must not evict its replacement.
			if current, ok := h.Clients[c.UserID]; ok && current == c {
				delete(h.Clients, c.UserID)
				close(current.Send)
			}

		case in := <-h.Inbound:
			h.handleInbound(in)

		case n := <-h.Notify:
			h.sendTo(n.UserID, n.Msg)
		}
	}
}

// NotifyUser queues a push for userID. Safe to call from any goroutine, unlike
// sendTo. A user with no live socket is a no-op: they pick the change up from
// the REST endpoints on their next fetch, so this is best-effort by design.
func (h *Hub) NotifyUser(ctx context.Context, userID uuid.UUID, m WSMessage) {
	select {
	case h.Notify <- Notification{UserID: userID, Msg: m}:
	case <-ctx.Done():
		// Request cancelled or the hub is wedged; drop the push rather than
		// pin the handler goroutine to it.
	}
}

func (h *Hub) handleInbound(in Inbound) {
	switch in.Msg.Kind {
	case KindSendMessage:
		ctx, cancel := context.WithTimeout(context.Background(), hubDBTimeout)
		defer cancel()

		msg, err := h.messageService.CreateMessage(ctx, in.Msg.ChatID, in.SenderID, in.Msg.Content)
		if err != nil {
			switch {
			case errors.Is(err, services.ErrNotParticipant):
				h.sendTo(in.SenderID, WSMessage{Kind: KindError, Message: "not a participant of this chat"})
			case errors.Is(err, services.ErrEmptyMessage):
				h.sendTo(in.SenderID, WSMessage{Kind: KindError, Message: "message content cannot be empty"})
			default:
				slog.Error("failed to persist message", "error", err, "sender_id", in.SenderID)
				h.sendTo(in.SenderID, WSMessage{Kind: KindError, Message: "something went wrong"})
			}
			return
		}

		participants, err := h.chatService.ParticipantIDs(ctx, msg.ChatID)
		if err != nil {
			// The message is already persisted; the recipient will pick it up
			// from history. Only the live fan-out is lost.
			slog.Error("failed to load participants for fan-out", "error", err, "chat_id", msg.ChatID)
			return
		}

		out := WSMessage{
			Kind:     KindNewMessage,
			ID:       msg.ID,
			ChatID:   msg.ChatID,
			SenderID: msg.SenderID,
			Content:  msg.Content,
			SentAt:   msg.SentAt,
		}
		for _, userID := range participants { // includes the sender → doubles as the ack
			h.sendTo(userID, out)
		}
	}
}

func (h *Hub) sendTo(userID uuid.UUID, m WSMessage) {
	c, ok := h.Clients[userID]
	if !ok {
		return
	}

	select {
	case c.Send <- m:
	default:
		// Slow or stuck client: drop it rather than block the hub. Unregister
		// inline — sending to h.Unregister from the hub goroutine would deadlock.
		delete(h.Clients, userID)
		close(c.Send)
	}
}
