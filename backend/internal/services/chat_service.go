package services

import (
	"context"
	"time"

	"backend/internal/store/pgstore"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// DefaultMessageLimit / MaxMessageLimit bound a history page.
	DefaultMessageLimit = 50
	MaxMessageLimit     = 100
)

// ChatSummary is one of the caller's chats: who else is in it, a preview of the
// last message, and how many messages the caller has not read. LastMessage/
// LastMessageAt are nil for a chat with no messages yet.
type ChatSummary struct {
	ChatID        uuid.UUID  `json:"chat_id"`
	OtherUserID   uuid.UUID  `json:"other_user_id"`
	OtherUsername string     `json:"other_username"`
	LastMessage   *string    `json:"last_message"`
	LastMessageAt *time.Time `json:"last_message_at"`
	UnreadCount   int64      `json:"unread_count"`
}

type ChatService struct {
	pool    *pgxpool.Pool
	queries *pgstore.Queries
}

func NewChatService(pool *pgxpool.Pool) ChatService {
	return ChatService{
		pool:    pool,
		queries: pgstore.New(pool),
	}
}

func (cs *ChatService) ListChatsForUser(ctx context.Context, userID uuid.UUID) ([]ChatSummary, error) {
	rows, err := cs.queries.ListChatsForUser(ctx, userID)
	if err != nil {
		return nil, err
	}

	chats := make([]ChatSummary, 0, len(rows))
	for _, row := range rows {
		summary := ChatSummary{
			ChatID:        row.ChatID,
			OtherUserID:   row.OtherUserID,
			OtherUsername: row.OtherUsername,
			LastMessageAt: row.LastMessageAt,
			UnreadCount:   row.UnreadCount,
		}
		if row.LastMessage.Valid {
			content := row.LastMessage.String
			summary.LastMessage = &content
		}
		chats = append(chats, summary)
	}

	return chats, nil
}

// ParticipantIDs lists everyone in a chat, used by the hub for fan-out.
func (cs *ChatService) ParticipantIDs(ctx context.Context, chatID uuid.UUID) ([]uuid.UUID, error) {
	return cs.queries.ChatParticipantIDs(ctx, chatID)
}

func (cs *ChatService) IsParticipant(ctx context.Context, chatID, userID uuid.UUID) (bool, error) {
	return cs.queries.IsChatParticipant(ctx, pgstore.IsChatParticipantParams{
		ChatID: chatID,
		UserID: userID,
	})
}

// ListMessages returns a newest-first page of a chat's history, ending just
// before the `before` cursor. Non-participants get ErrNotParticipant rather
// than any part of the history.
func (cs *ChatService) ListMessages(ctx context.Context, chatID, userID uuid.UUID, before time.Time, limit int) ([]pgstore.Message, error) {
	participates, err := cs.IsParticipant(ctx, chatID, userID)
	if err != nil {
		return nil, err
	}
	if !participates {
		return nil, ErrNotParticipant
	}

	if limit <= 0 {
		limit = DefaultMessageLimit
	}
	if limit > MaxMessageLimit {
		limit = MaxMessageLimit
	}
	if before.IsZero() {
		before = time.Now()
	}

	messages, err := cs.queries.ListMessages(ctx, pgstore.ListMessagesParams{
		ChatID: chatID,
		SentAt: before,
		Limit:  int32(limit),
	})
	if err != nil {
		return nil, err
	}
	if messages == nil {
		messages = []pgstore.Message{}
	}

	return messages, nil
}

// MarkChatRead stamps read_at on every message in the chat the caller did not
// send and has not already read. Returns how many it marked and the timestamp
// written; the timestamp is nil when there was nothing to mark, which the
// caller uses to skip the fan-out.
//
// Participation is a separate statement rather than an EXISTS inside the
// UPDATE, mirroring ListMessages: a non-participant must get 404, and an UPDATE
// that touches zero rows cannot tell "not allowed" from "nothing to do". That
// is the opposite of CreateMessage, where the single-statement form is right
// precisely because both outcomes mean "don't write".
func (cs *ChatService) MarkChatRead(ctx context.Context, chatID, callerID uuid.UUID) (int64, *time.Time, error) {
	participates, err := cs.IsParticipant(ctx, chatID, callerID)
	if err != nil {
		return 0, nil, err
	}
	if !participates {
		return 0, nil, ErrNotParticipant
	}

	row, err := cs.queries.MarkChatRead(ctx, pgstore.MarkChatReadParams{
		ChatID:   chatID,
		SenderID: callerID,
	})
	if err != nil {
		return 0, nil, err
	}
	if row.MarkedCount == 0 {
		return 0, nil, nil
	}

	return row.MarkedCount, &row.ReadAt, nil
}
