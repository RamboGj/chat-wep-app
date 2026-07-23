/** Mirrors the JSON the Go API emits. Keep in sync with backend/internal. */

export interface User {
  id: string
  username: string
  email: string
}

/** api.handleLoginUser — the session, now that it is not a cookie. */
export interface AuthTokens {
  access_token: string
  refresh_token: string
  token_type: string
  /** Lifetime of the access token in seconds. */
  expires_in: number
}

/** api.handleRefreshToken — the refresh token is not rotated, so none comes back. */
export type RefreshedAccessToken = Omit<AuthTokens, 'refresh_token'>

/** services.ChatSummary */
export interface ChatSummary {
  chat_id: string
  other_user_id: string
  other_username: string
  last_message: string | null
  last_message_at: string | null
  /** Messages in this chat from the other participant that we have not read. */
  unread_count: number
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
  /**
   * When the first participant other than the sender opened the chat with this
   * message already in it. Written once, so it never moves. Null = unread.
   */
  read_at: string | null
}
