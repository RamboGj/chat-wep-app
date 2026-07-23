import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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

/**
 * Marks a chat's incoming backlog read.
 *
 * The count is zeroed in `onMutate` rather than on the response because the
 * effect that calls this is triggered by `unread_count > 0` — leaving the count
 * up while the request is in flight would fire a second one.
 */
export function useMarkChatRead() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (chatId: string) => chatApi.markRead(chatId),
    onMutate: (chatId) => {
      queryClient.setQueryData<ChatSummary[]>(queryKeys.chats, (current) =>
        current?.map((chat) =>
          chat.chat_id === chatId ? { ...chat, unread_count: 0 } : chat,
        ),
      )
    },
    onSuccess: (_data, chatId) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.messages(chatId) })

      // Between fetches the count is derived locally, by counting socket
      // frames. Re-deriving it from the server — the only place it is computed
      // rather than accumulated — bounds any drift to a single round trip
      // instead of letting it persist until the next window focus.
      //
      // Success only, deliberately: after a failure the optimistic zero stands
      // until a natural refetch, so a failing endpoint cannot restore the very
      // count that re-triggers the mark-read effect that called it.
      queryClient.invalidateQueries({ queryKey: queryKeys.chats })
    },
  })
}

function byRecency(a: ChatSummary, b: ChatSummary) {
  const at = a.last_message_at ? Date.parse(a.last_message_at) : 0
  const bt = b.last_message_at ? Date.parse(b.last_message_at) : 0
  return bt - at
}

interface UseChatRealtimeOptions {
  enabled: boolean
  /**
   * Needed to tell our own echo from someone else's message: the hub fans out
   * to every participant including the sender, so our own messages come back
   * over the socket too and must not count as unread.
   */
  currentUserId: string | undefined
  onError?: (message: string) => void
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
export function useChatRealtime({ enabled, currentUserId, onError }: UseChatRealtimeOptions) {
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

      // Incoming messages raise the unread count for every chat, the open one
      // included: that count is what drives the mark-read effect, so skipping
      // the active chat here would leave its messages unread on the server. The
      // sidebar is what decides not to *show* a pill on the chat you are in.
      //
      // Not knowing who we are has to fail closed. `sender_id !== undefined` is
      // true of our own echo as well, so an unset currentUserId would count our
      // own messages as unread — the one way a message you sent can land in
      // your own pill. Skipping the increment is self-correcting: the next
      // GET /chats carries the server's count, which is computed with
      // `sender_id <> caller` and so can never include your own messages.
      const incoming =
        currentUserId !== undefined && message.sender_id !== currentUserId

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
                  unread_count: incoming ? chat.unread_count + 1 : chat.unread_count,
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
    [queryClient, currentUserId],
  )

  // Our invite was accepted: the chat exists now, and the other user is a
  // friend, but neither list has any reason to refetch on its own.
  const applyChatCreated = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.chats })
    queryClient.invalidateQueries({ queryKey: queryKeys.friends })
  }, [queryClient])

  /**
   * Someone opened a chat we are in. The push carries a single timestamp
   * meaning "everything sent at or before this is read", so the whole update is
   * local — no refetch, which is exactly the `GET /messages` over a long history
   * that the socket exists to avoid.
   *
   * The `sent_at <= read_at` test is what makes this safe against a message
   * created after the UPDATE but delivered before the receipt: such a message
   * necessarily has a later `sent_at` and is left alone.
   */
  const applyMessagesRead = useCallback(
    (chatId: string, readAt: string) => {
      const readAtMs = Date.parse(readAt)

      queryClient.setQueryData<Message[]>(queryKeys.messages(chatId), (current) =>
        current?.map((m) =>
          m.read_at === null && Date.parse(m.sent_at) <= readAtMs
            ? { ...m, read_at: readAt }
            : m,
        ),
      )
    },
    [queryClient],
  )

  return useChatSocket({
    enabled,
    onNewMessage: applyMessage,
    onChatCreated: applyChatCreated,
    onMessagesRead: applyMessagesRead,
    onError,
  })
}
