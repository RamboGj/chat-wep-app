-- Write your migrate up statements here
CREATE TABLE IF NOT EXISTS friend_invitations (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    accepted_at  TIMESTAMPTZ DEFAULT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT no_self_invite CHECK (from_user_id <> to_user_id)
);

-- At most one PENDING invite per direction:
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_invite
    ON friend_invitations (from_user_id, to_user_id)
    WHERE accepted_at IS NULL;
---- create above / drop below ----
DROP TABLE IF EXISTS friend_invitations;
