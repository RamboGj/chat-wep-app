/** Mirrors the JSON the Go API emits. Keep in sync with backend/internal. */

export interface User {
  id: string
  username: string
  email: string
}

/** services.ChatSummary */
export interface ChatSummary {
  chat_id: string
  other_user_id: string
  other_username: string
  last_message: string | null
  last_message_at: string | null
}

/** services.FriendView */
export interface Friend {
  chat_id: string
  user_id: string
  username: string
}

/** services.InviteView — a pending invitation as seen by its recipient. */
export interface Invite {
  id: string
  from_user_id: string
  from_username: string
  created_at: string
}

/** pgstore.Message */
export interface Message {
  id: string
  chat_id: string
  sender_id: string
  content: string
  sent_at: string
}
