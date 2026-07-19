package services

import (
	"context"
	"errors"
	"time"

	"backend/internal/store/pgstore"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrSelfInvite            = errors.New("cannot invite yourself")
	ErrAlreadyFriends        = errors.New("users are already friends")
	ErrInviteExists          = errors.New("a pending invitation already exists")
	ErrInviteNotFound        = errors.New("invitation not found")
	ErrNotInviteRecipient    = errors.New("caller is not the invitation recipient")
	ErrInviteAlreadyResolved = errors.New("invitation has already been resolved")
	ErrNotParticipant        = errors.New("caller does not participate in this chat")
)

// InviteView is a pending invitation as seen by its recipient.
type InviteView struct {
	ID           uuid.UUID `json:"id"`
	FromUserID   uuid.UUID `json:"from_user_id"`
	FromUsername string    `json:"from_username"`
	CreatedAt    time.Time `json:"created_at"`
}

// FriendView is one of the caller's 1:1 chats, described by the other participant.
type FriendView struct {
	ChatID   uuid.UUID `json:"chat_id"`
	UserID   uuid.UUID `json:"user_id"`
	Username string    `json:"username"`
}

type FriendService struct {
	pool    *pgxpool.Pool
	queries *pgstore.Queries
}

func NewFriendService(pool *pgxpool.Pool) FriendService {
	return FriendService{
		pool:    pool,
		queries: pgstore.New(pool),
	}
}

func (fs *FriendService) CreateInvite(ctx context.Context, fromID uuid.UUID, toUsername string) (uuid.UUID, error) {
	to, err := fs.queries.GetUserByUsername(ctx, toUsername)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.UUID{}, ErrUserNotFound
		}
		return uuid.UUID{}, err
	}

	if to.ID == fromID {
		return uuid.UUID{}, ErrSelfInvite
	}

	friends, err := fs.queries.FriendshipExists(ctx, pgstore.FriendshipExistsParams{
		UserID:   fromID,
		UserID_2: to.ID,
	})
	if err != nil {
		return uuid.UUID{}, err
	}
	if friends {
		return uuid.UUID{}, ErrAlreadyFriends
	}

	pending, err := fs.queries.PendingInviteExists(ctx, pgstore.PendingInviteExistsParams{
		FromUserID: fromID,
		ToUserID:   to.ID,
	})
	if err != nil {
		return uuid.UUID{}, err
	}
	if pending {
		return uuid.UUID{}, ErrInviteExists
	}

	id, err := fs.queries.CreateFriendInvitation(ctx, pgstore.CreateFriendInvitationParams{
		FromUserID: fromID,
		ToUserID:   to.ID,
	})
	if err != nil {
		// The uq_pending_invite partial index catches the race the check above misses.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return uuid.UUID{}, ErrInviteExists
		}
		return uuid.UUID{}, err
	}

	return id, nil
}

func (fs *FriendService) ListPendingInvites(ctx context.Context, toID uuid.UUID) ([]InviteView, error) {
	rows, err := fs.queries.ListPendingInvitesForUser(ctx, toID)
	if err != nil {
		return nil, err
	}

	invites := make([]InviteView, 0, len(rows))
	for _, row := range rows {
		invites = append(invites, InviteView{
			ID:           row.ID,
			FromUserID:   row.FromUserID,
			FromUsername: row.FromUsername,
			CreatedAt:    row.CreatedAt,
		})
	}

	return invites, nil
}

// AcceptInvite creates the chat, both participant rows and marks the invite
// accepted in a single transaction, so there is never a chat without its
// participants.
func (fs *FriendService) AcceptInvite(ctx context.Context, inviteID, callerID uuid.UUID) (uuid.UUID, error) {
	tx, err := fs.pool.Begin(ctx)
	if err != nil {
		return uuid.UUID{}, err
	}
	defer tx.Rollback(ctx) // no-op after a successful Commit

	q := fs.queries.WithTx(tx)

	invite, err := q.GetInviteByID(ctx, inviteID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.UUID{}, ErrInviteNotFound
		}
		return uuid.UUID{}, err
	}
	if invite.ToUserID != callerID {
		return uuid.UUID{}, ErrNotInviteRecipient
	}
	if invite.AcceptedAt != nil {
		return uuid.UUID{}, ErrInviteAlreadyResolved
	}

	chatID, err := q.CreateChat(ctx)
	if err != nil {
		return uuid.UUID{}, err
	}

	for _, userID := range []uuid.UUID{invite.FromUserID, invite.ToUserID} {
		if err := q.AddChatParticipant(ctx, pgstore.AddChatParticipantParams{
			ChatID: chatID,
			UserID: userID,
		}); err != nil {
			return uuid.UUID{}, err
		}
	}

	if err := q.MarkInviteAccepted(ctx, inviteID); err != nil {
		return uuid.UUID{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return uuid.UUID{}, err
	}

	return chatID, nil
}

func (fs *FriendService) RejectInvite(ctx context.Context, inviteID, callerID uuid.UUID) error {
	invite, err := fs.queries.GetInviteByID(ctx, inviteID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrInviteNotFound
		}
		return err
	}
	if invite.ToUserID != callerID {
		return ErrNotInviteRecipient
	}
	if invite.AcceptedAt != nil {
		return ErrInviteAlreadyResolved
	}

	return fs.queries.DeleteInvite(ctx, inviteID)
}

func (fs *FriendService) ListFriends(ctx context.Context, userID uuid.UUID) ([]FriendView, error) {
	rows, err := fs.queries.ListFriends(ctx, userID)
	if err != nil {
		return nil, err
	}

	friends := make([]FriendView, 0, len(rows))
	for _, row := range rows {
		friends = append(friends, FriendView{
			ChatID:   row.ChatID,
			UserID:   row.UserID,
			Username: row.Username,
		})
	}

	return friends, nil
}

// RemoveFriend hard-deletes the chat; ON DELETE CASCADE takes its participants
// and messages with it.
func (fs *FriendService) RemoveFriend(ctx context.Context, chatID, callerID uuid.UUID) error {
	tx, err := fs.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	q := fs.queries.WithTx(tx)

	participates, err := q.IsChatParticipant(ctx, pgstore.IsChatParticipantParams{
		ChatID: chatID,
		UserID: callerID,
	})
	if err != nil {
		return err
	}
	if !participates {
		return ErrNotParticipant
	}

	if err := q.DeleteChat(ctx, chatID); err != nil {
		return err
	}

	return tx.Commit(ctx)
}
