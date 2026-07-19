-- name: CreateChat :one
INSERT INTO chats (title)
VALUES (NULL)
RETURNING id;

-- name: AddChatParticipant :exec
INSERT INTO chat_participants (chat_id, user_id)
VALUES ($1, $2);

-- Hard delete; cascades to chat_participants and messages.
-- name: DeleteChat :exec
DELETE FROM chats
WHERE id = $1;

-- name: IsChatParticipant :one
SELECT EXISTS (
    SELECT 1
    FROM chat_participants
    WHERE chat_id = $1 AND user_id = $2
);

-- Guards ErrAlreadyFriends: do the two users already share a chat?
-- name: FriendshipExists :one
SELECT EXISTS (
    SELECT 1
    FROM chat_participants a
    JOIN chat_participants b ON b.chat_id = a.chat_id
    JOIN chats c ON c.id = a.chat_id
    WHERE a.user_id = $1
      AND b.user_id = $2
      AND c.deleted_at IS NULL
);

-- name: ListFriends :many
SELECT c.id AS chat_id, u.id AS user_id, u.username
FROM chat_participants self
JOIN chats c ON c.id = self.chat_id
JOIN chat_participants other
  ON other.chat_id = self.chat_id AND other.user_id <> self.user_id
JOIN users u ON u.id = other.user_id
WHERE self.user_id = $1
  AND c.deleted_at IS NULL
ORDER BY c.created_at DESC;
