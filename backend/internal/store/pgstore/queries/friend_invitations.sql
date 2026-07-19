-- name: CreateFriendInvitation :one
INSERT INTO friend_invitations (from_user_id, to_user_id)
VALUES ($1, $2)
RETURNING id;

-- FOR UPDATE so that inside the accept transaction two concurrent accepts of the
-- same invite serialize; the second one then sees accepted_at set.
-- name: GetInviteByID :one
SELECT id, from_user_id, to_user_id, accepted_at, created_at
FROM friend_invitations
WHERE id = $1
FOR UPDATE;

-- name: ListPendingInvitesForUser :many
SELECT fi.id, fi.from_user_id, u.username AS from_username, fi.created_at
FROM friend_invitations fi
JOIN users u ON u.id = fi.from_user_id
WHERE fi.to_user_id = $1
  AND fi.accepted_at IS NULL
ORDER BY fi.created_at DESC;

-- Guards ErrInviteExists: a pending invite in EITHER direction blocks a new one.
-- name: PendingInviteExists :one
SELECT EXISTS (
    SELECT 1
    FROM friend_invitations
    WHERE accepted_at IS NULL
      AND ((from_user_id = $1 AND to_user_id = $2)
        OR (from_user_id = $2 AND to_user_id = $1))
);

-- name: MarkInviteAccepted :exec
UPDATE friend_invitations
SET accepted_at = NOW()
WHERE id = $1;

-- name: DeleteInvite :exec
DELETE FROM friend_invitations
WHERE id = $1;
