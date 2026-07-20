import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import type { ChatSummary, Message } from '@/types/api'
import { chatApi } from '../api/chat-api'
import { useChatSocket } from './use-chat-socket'

export function useChats() {
  return useQuery({
    queryKey: queryKeys.chats,
    queryFn: chatApi.list,
  })
}

export function useMessages(chatId: string | null) {
  return useQuery({
    queryKey: queryKeys.messages(chatId ?? ''),
    queryFn: () => chatApi.listMessages(chatId as string),
    enabled: Boolean(chatId),
  })
}

function byRecency(a: ChatSummary, b: ChatSummary) {
  const at = a.last_message_at ? Date.parse(a.last_message_at) : 0
  const bt = b.last_message_at ? Date.parse(b.last_message_at) : 0
  return bt - at
}

/**
 * Opens the session socket and folds every inbound message into the query
 * cache.
 *
 * The backend fans out to all participants including the sender, so a sent
 * message comes back over the socket and that echo doubles as the ack. That is
 * why nothing is inserted optimistically — the echo is the single path a
 * message takes into the cache, so there are no duplicates to reconcile.
 */
export function useChatRealtime(options: { enabled: boolean; onError?: (message: string) => void }) {
  const queryClient = useQueryClient()

  const applyMessage = useCallback(
    (message: Message) => {
      queryClient.setQueryData<Message[]>(
        queryKeys.messages(message.chat_id),
        (current) => {
          if (!current) return current // not loaded yet; the fetch will include it
          if (current.some((m) => m.id === message.id)) return current
          return [...current, message]
        },
      )

      let known = false

      queryClient.setQueryData<ChatSummary[]>(queryKeys.chats, (current) => {
        if (!current) return current

        known = current.some((chat) => chat.chat_id === message.chat_id)
        if (!known) return current

        return current
          .map((chat) =>
            chat.chat_id === message.chat_id
              ? {
                  ...chat,
                  last_message: message.content,
                  last_message_at: message.sent_at,
                }
              : chat,
          )
          .sort(byRecency)
      })

      // Backstop for a chat we have never seen: the ChatCreated push normally
      // gets there first, but it is dropped if we were offline when the invite
      // was accepted.
      if (!known) {
        queryClient.invalidateQueries({ queryKey: queryKeys.chats })
      }
    },
    [queryClient],
  )

  // Our invite was accepted: the chat exists now, and the other user is a
  // friend, but neither list has any reason to refetch on its own.
  const applyChatCreated = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.chats })
    queryClient.invalidateQueries({ queryKey: queryKeys.friends })
  }, [queryClient])

  return useChatSocket({
    enabled: options.enabled,
    onNewMessage: applyMessage,
    onChatCreated: applyChatCreated,
    onError: options.onError,
  })
}
