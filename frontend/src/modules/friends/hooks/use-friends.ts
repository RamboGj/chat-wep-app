import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import type { Invite } from '@/types/api'
import { friendsApi } from '../api/friends-api'

/** Drop a resolved invite from the cached list so the row disappears at once. */
function removeInviteFromCache(
  invites: Invite[] | undefined,
  inviteId: string,
) {
  return invites?.filter((invite) => invite.id !== inviteId)
}

/**
 * Invitations have no realtime channel — the socket only carries chat messages
 * — so incoming invites are polled.
 */
const INVITE_POLL_INTERVAL = 10_000

export function useFriends() {
  return useQuery({
    queryKey: queryKeys.friends,
    queryFn: friendsApi.list,
  })
}

export function usePendingInvites() {
  return useQuery({
    queryKey: queryKeys.invites,
    queryFn: friendsApi.listPendingInvites,
    refetchInterval: INVITE_POLL_INTERVAL,
  })
}

export function useCreateInvite() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (username: string) => friendsApi.createInvite(username),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invites })
    },
  })
}

export function useAcceptInvite() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (inviteId: string) => friendsApi.acceptInvite(inviteId),
    onSuccess: (_data, inviteId) => {
      // Remove the invite from its list instantly; its row unmounts at once.
      queryClient.setQueryData<Invite[]>(queryKeys.invites, (invites) =>
        removeInviteFromCache(invites, inviteId),
      )
      // Accepting creates the chat, so the chat/friend lists still need the
      // new server-side rows those responses don't carry.
      queryClient.invalidateQueries({ queryKey: queryKeys.friends })
      queryClient.invalidateQueries({ queryKey: queryKeys.chats })
    },
  })
}

export function useRejectInvite() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (inviteId: string) => friendsApi.rejectInvite(inviteId),
    onSuccess: (_data, inviteId) => {
      queryClient.setQueryData<Invite[]>(queryKeys.invites, (invites) =>
        removeInviteFromCache(invites, inviteId),
      )
    },
  })
}

export function useRemoveFriend() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (chatId: string) => friendsApi.remove(chatId),
    onSuccess: (_data, chatId) => {
      queryClient.removeQueries({ queryKey: queryKeys.messages(chatId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.friends })
      queryClient.invalidateQueries({ queryKey: queryKeys.chats })
    },
  })
}
