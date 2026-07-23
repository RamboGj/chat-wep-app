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
RETURNING id, chat_id, sender_id, content, sent_at, read_at;

-- Newest-first page of a chat's history, walking backwards from the `before`
-- cursor. Uses idx_messages_chat_sent.
-- name: ListMessages :many
SELECT id, chat_id, sender_id, content, sent_at, read_at
FROM messages
WHERE chat_id = $1
  AND sent_at < $2
ORDER BY sent_at DESC
LIMIT $3;

-- Marks the caller's unread inbox for one chat. Only messages the caller did
-- NOT send, and only ones still unread, so read_at is written exactly once and
-- never moves. Participation is checked by the service before this runs.
--
-- The UPDATE is wrapped in a CTE so the statement returns a single row however
-- many messages it touched — a bare `RETURNING read_at` returns one row per
-- updated message, which :one cannot express.
--
-- The timestamp is re-derived with NOW() rather than aggregated out of the
-- CTE's RETURNING. NOW() is transaction_timestamp(), constant for the whole
-- statement, so it is exactly the value the UPDATE wrote — and it types as a
-- plain non-null timestamptz, which MAX(read_at) over a data-modifying CTE does
-- not (sqlc infers interface{} without a cast and NOT NULL with one, and this
-- row exists even when zero messages were marked). marked_count == 0 is what
-- the service reads as a no-op, so the timestamp is never consulted then.
-- name: MarkChatRead :one
WITH marked AS (
    UPDATE messages
    SET read_at = NOW()
    WHERE chat_id = $1
      AND sender_id <> $2
      AND read_at IS NULL
    RETURNING id
)
SELECT COUNT(*) AS marked_count, NOW()::timestamptz AS read_at
FROM marked;
