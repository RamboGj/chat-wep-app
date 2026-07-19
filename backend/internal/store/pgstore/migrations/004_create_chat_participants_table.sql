-- Write your migrate up statements here
CREATE TABLE IF NOT EXISTS chat_participants (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    UNIQUE (user_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_participants_user ON chat_participants (user_id);
---- create above / drop below ----
DROP TABLE IF EXISTS chat_participants;
