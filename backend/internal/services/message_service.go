package services

import (
	"context"
	"errors"
	"strings"

	"backend/internal/store/pgstore"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrEmptyMessage = errors.New("message content cannot be empty")

type MessageService struct {
	pool    *pgxpool.Pool
	queries *pgstore.Queries
}

func NewMessageService(pool *pgxpool.Pool) MessageService {
	return MessageService{
		pool:    pool,
		queries: pgstore.New(pool),
	}
}

// CreateMessage persists a message. The membership check lives inside the
// INSERT (see queries/messages.sql), so a non-participant never writes a row:
// "no rows returned" is exactly "not a participant".
func (ms *MessageService) CreateMessage(ctx context.Context, chatID, senderID uuid.UUID, content string) (pgstore.Message, error) {
	if strings.TrimSpace(content) == "" {
		return pgstore.Message{}, ErrEmptyMessage
	}

	msg, err := ms.queries.CreateMessage(ctx, pgstore.CreateMessageParams{
		ChatID:   chatID,
		SenderID: senderID,
		Content:  content,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pgstore.Message{}, ErrNotParticipant
		}
		return pgstore.Message{}, err
	}

	return msg, nil
}
