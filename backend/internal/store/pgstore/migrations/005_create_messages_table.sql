-- Write your migrate up statements here
CREATE TABLE IF NOT EXISTS messages (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id   UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content   TEXT NOT NULL,
    sent_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- History pagination is (chat_id, sent_at DESC).
CREATE INDEX IF NOT EXISTS idx_messages_chat_sent ON messages (chat_id, sent_at DESC);
---- create above / drop below ----
DROP TABLE IF EXISTS messages;
