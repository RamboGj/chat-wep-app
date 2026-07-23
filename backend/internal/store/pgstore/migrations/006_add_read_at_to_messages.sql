-- Write your migrate up statements here
ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ DEFAULT NULL;

-- Everything that predates the feature counts as read. There is no record of
-- who saw what before this column existed, and leaving it NULL is not the
-- neutral choice: it republishes all history as unread, so every conversation
-- with a backlog wakes up wearing a pill for messages both sides read long ago.
--
-- This is a one-time backfill, deliberately not `DEFAULT NOW()` on the column.
-- A column default applies to every future INSERT too, and CreateMessage does
-- not name read_at — so new messages would be born already read, no message
-- could ever be unread, and the whole feature would be inert. The default stays
-- NULL; only the rows that existed before this migration are stamped.
UPDATE messages SET read_at = NOW() WHERE read_at IS NULL;

-- Unread counts scan (chat_id, sender_id) for the rows still NULL. A partial
-- index keeps that scan proportional to the unread backlog rather than to all
-- history, and read rows drop out of the index as they are marked. Built after
-- the backfill so it starts out empty rather than indexing every historical row
-- only to have the UPDATE churn it right back out.
CREATE INDEX IF NOT EXISTS idx_messages_unread
    ON messages (chat_id, sender_id)
    WHERE read_at IS NULL;
---- create above / drop below ----
DROP INDEX IF EXISTS idx_messages_unread;
ALTER TABLE messages DROP COLUMN IF EXISTS read_at;
