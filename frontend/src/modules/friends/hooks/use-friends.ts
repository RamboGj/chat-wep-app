import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { friendsApi } from '../api/friends-api'

/**
 * Invitations have no realtime channel — the socket only carries chat messages
 * — so incoming invites are polled.
 */
const INVITE_POLL_INTERVAL = 5_000

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
    onSuccess: () => {
      // Accepting creates the chat, so the chat list changes too.
      queryClient.invalidateQueries({ queryKey: queryKeys.invites })
      queryClient.invalidateQueries({ queryKey: queryKeys.friends })
      queryClient.invalidateQueries({ queryKey: queryKeys.chats })
    },
  })
}

export function useRejectInvite() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (inviteId: string) => friendsApi.rejectInvite(inviteId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invites })
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
