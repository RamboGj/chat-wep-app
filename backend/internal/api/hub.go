package api

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"backend/internal/services"

	"github.com/google/uuid"
)

// MessageKind is the envelope discriminator carried over the socket.
type MessageKind int

const (
	KindSendMessage MessageKind = iota // client → server: {chat_id, content}
	KindNewMessage                     // server → participants: the persisted message
	KindError                          // server → sender
	KindInvalidJSON                    // server → sender
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

	// Populated on KindError / KindInvalidJSON.
	Message string `json:"message,omitempty"`
}

// Inbound pairs a client's message with the user id of the socket it arrived
// on. SenderID comes from the authenticated connection, never from the payload.
type Inbound struct {
	SenderID uuid.UUID
	Msg      WSMessage
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
	Clients    map[uuid.UUID]*Client

	chatService    services.ChatService
	messageService services.MessageService
}

func NewHub(chatService services.ChatService, messageService services.MessageService) *Hub {
	return &Hub{
		Register:       make(chan *Client),
		Unregister:     make(chan *Client),
		Inbound:        make(chan Inbound),
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
		}
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
