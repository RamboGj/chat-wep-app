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

// ChatSummary is one of the caller's chats: who else is in it and a preview of
// the last message. LastMessage/LastMessageAt are nil for a chat with no
// messages yet.
type ChatSummary struct {
	ChatID        uuid.UUID  `json:"chat_id"`
	OtherUserID   uuid.UUID  `json:"other_user_id"`
	OtherUsername string     `json:"other_username"`
	LastMessage   *string    `json:"last_message"`
	LastMessageAt *time.Time `json:"last_message_at"`
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
