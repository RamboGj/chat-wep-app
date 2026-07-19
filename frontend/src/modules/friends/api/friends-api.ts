import { apiFetch } from '@/lib/api'
import type { Friend, Invite } from '@/types/api'

export const friendsApi = {
  list: () =>
    apiFetch<{ friends: Friend[] }>('/friends/').then((res) => res.friends),

  /** Invites by username — the backend resolves it to a user id. */
  createInvite: (username: string) =>
    apiFetch<{ invite_id: string }>('/friends/invites/', {
      method: 'POST',
      body: { username },
    }),

  listPendingInvites: () =>
    apiFetch<{ invites: Invite[] }>('/friends/invites/').then(
      (res) => res.invites,
    ),

  acceptInvite: (inviteId: string) =>
    apiFetch<{ chat_id: string }>(`/friends/invites/${inviteId}/accept`, {
      method: 'POST',
    }),

  rejectInvite: (inviteId: string) =>
    apiFetch<void>(`/friends/invites/${inviteId}/reject`, { method: 'POST' }),

  /** Removing a friend deletes the chat, its participants and its messages. */
  remove: (chatId: string) =>
    apiFetch<void>(`/friends/${chatId}`, { method: 'DELETE' }),
}
