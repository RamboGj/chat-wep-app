-- Authorization and the write are one statement: the row is only inserted if the
-- sender participates in the chat, so a non-participant gets no row back rather
-- than a persisted message. "no rows" maps to ErrNotParticipant.
-- name: CreateMessage :one
INSERT INTO messages (chat_id, sender_id, content)
SELECT $1, $2, $3
WHERE EXISTS (
    SELECT 1
    FROM chat_participants
    WHERE chat_id = $1 AND user_id = $2
)
RETURNING id, chat_id, sender_id, content, sent_at;

-- Newest-first page of a chat's history, walking backwards from the `before`
-- cursor. Uses idx_messages_chat_sent.
-- name: ListMessages :many
SELECT id, chat_id, sender_id, content, sent_at
FROM messages
WHERE chat_id = $1
  AND sent_at < $2
ORDER BY sent_at DESC
LIMIT $3;
