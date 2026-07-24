package api

import (
	"context"
	"errors"
	"log/slog"
	"slices"
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
	KindTyping                         // 6: client → server: {chat_id}
	KindUserTyping                     // 7: server → the other participants: {chat_id, sender_id}
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

// participantCacheTTL bounds how long a cached roster outlives the DB. Membership
// is immutable today, so this only caps the two things that can drift: a deleted
// chat, and (once feature 3 lands) a roster that can change.
const participantCacheTTL = 10 * time.Minute

type participantEntry struct {
	ids     []uuid.UUID
	fetched time.Time
}

// participantCache memoizes chat → participant ids. Owned by the hub goroutine
// like Clients, so it needs no mutex.
//
// Membership is immutable in this codebase: participants are written once, in
// the accept-invite transaction, and remove-friend deletes the chat outright
// rather than editing its roster. So a hit is correct by construction today, and
// the TTL exists only to bound an entry that outlives its chat.
type participantCache struct {
	entries map[uuid.UUID]participantEntry
	ttl     time.Duration
}

// Hub is a single long-lived goroutine that owns Clients, so the map needs no
// mutex. One socket per user; messages are routed by chat_id.
type Hub struct {
	Register   chan *Client
	Unregister chan *Client
	Inbound    chan Inbound
	Notify     chan Notification
	Forget     chan uuid.UUID
	Clients    map[uuid.UUID]*Client

	// partCache is owned by Run, like Clients: only the hub goroutine touches it.
	partCache participantCache

	chatService    services.ChatService
	messageService services.MessageService
}

func NewHub(chatService services.ChatService, messageService services.MessageService) *Hub {
	return &Hub{
		Register:   make(chan *Client),
		Unregister: make(chan *Client),
		Inbound:    make(chan Inbound),
		Notify:     make(chan Notification),
		Forget:     make(chan uuid.UUID),
		Clients:    make(map[uuid.UUID]*Client),
		partCache: participantCache{
			entries: make(map[uuid.UUID]participantEntry),
			ttl:     participantCacheTTL,
		},
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

		case chatID := <-h.Forget:
			delete(h.partCache.entries, chatID)
		}
	}
}

// ForgetChat drops a chat's cached roster. Called from HTTP handlers when a chat
// is deleted, queued through the channel like NotifyUser so it lands on the hub
// goroutine that owns the cache. Without it, a removed friend could still be
// fanned typing frames until the cache entry's TTL expired.
func (h *Hub) ForgetChat(ctx context.Context, chatID uuid.UUID) {
	select {
	case h.Forget <- chatID:
	case <-ctx.Done():
		// Request cancelled or the hub is wedged; the entry lapses on its TTL.
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

		participants, ok := h.participants(msg.ChatID)
		if !ok {
			// The message is already persisted; the recipient will pick it up
			// from history. Only the live fan-out is lost.
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

	case KindTyping:
		// No DB on the common path, and no error frame ever: an over-limit
		// sender was already dropped in ReadPump, and a bad chat_id is ignored.
		participants, ok := h.participants(in.Msg.ChatID)
		if !ok || !slices.Contains(participants, in.SenderID) {
			return // not a participant, or the chat is gone: silently ignore
		}

		out := WSMessage{Kind: KindUserTyping, ChatID: in.Msg.ChatID, SenderID: in.SenderID}
		for _, userID := range participants {
			if userID == in.SenderID {
				continue // unlike KindNewMessage, there is no ack to deliver
			}
			h.sendEphemeral(userID, out)
		}
	}
}

// participants returns a chat's participant ids, served from the cache when
// fresh and from the DB on a miss (repopulating the cache). ok is false only
// when the lookup itself failed; a deleted chat is a successful empty result.
// Runs on the hub goroutine, so the cache needs no lock.
func (h *Hub) participants(chatID uuid.UUID) ([]uuid.UUID, bool) {
	if e, hit := h.partCache.entries[chatID]; hit && time.Since(e.fetched) < h.partCache.ttl {
		return e.ids, true
	}

	ctx, cancel := context.WithTimeout(context.Background(), hubDBTimeout)
	defer cancel()

	ids, err := h.chatService.ParticipantIDs(ctx, chatID)
	if err != nil {
		slog.Error("failed to load chat participants", "error", err, "chat_id", chatID)
		return nil, false
	}

	h.partCache.entries[chatID] = participantEntry{ids: ids, fetched: time.Now()}
	return ids, true
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

// sendEphemeral queues a frame the recipient can lose without noticing. A full
// buffer drops the frame, not the client: the indicator simply expires on the
// receiver, a state it is already built to handle. Killing a socket — and its
// live message delivery — because a "typing…" hint could not be queued would
// invert the priority exactly. A backed-up client thus sheds typing frames
// first and keeps its message backlog, the degradation order we want.
func (h *Hub) sendEphemeral(userID uuid.UUID, m WSMessage) {
	c, ok := h.Clients[userID]
	if !ok {
		return
	}

	select {
	case c.Send <- m:
	default:
	}
}
