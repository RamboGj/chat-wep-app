import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE, ensureAccessToken } from '@/lib/api'
import type { Message } from '@/types/api'

/**
 * Mirrors api.WSAuthProtocol. The WebSocket constructor cannot set an
 * Authorization header, and putting the token in the query string would write
 * it into every access log, so it travels as the subprotocol entry after this
 * sentinel. The server answers by selecting the sentinel alone.
 */
const WS_AUTH_PROTOCOL = 'bearer'

/** Mirrors api.MessageKind — a Go iota, so these are positional. */
export const WSKind = {
  SendMessage: 0,
  NewMessage: 1,
  Error: 2,
  InvalidJSON: 3,
  ChatCreated: 4,
  MessagesRead: 5,
} as const

export interface WSMessage {
  kind: number
  chat_id?: string
  content?: string
  id?: string
  sender_id?: string
  sent_at?: string
  message?: string
  read_at?: string
}

export type SocketStatus = 'connecting' | 'open' | 'closed'

const BASE_RECONNECT_DELAY = 1_000
const MAX_RECONNECT_DELAY = 15_000

/**
 * How long a connection must survive before it counts as healthy. The backend
 * allows one socket per user and evicts the previous one, so a second tab makes
 * two clients evict each other. Resetting the backoff on open alone would turn
 * that into a tight reconnect war; requiring the connection to hold first means
 * a losing socket backs off instead.
 */
const STABLE_CONNECTION_MS = 10_000

/**
 * Derived from API_BASE so the socket follows the API wherever it is pointed.
 * Resolving against the current location handles both forms it can take: a
 * same-origin path, and an absolute origin on another host.
 */
function socketUrl(): string {
  const url = new URL(`${API_BASE}/ws`, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

interface UseChatSocketOptions {
  /** Gate the connection on being authenticated. */
  enabled: boolean
  onNewMessage: (message: Message) => void
  /** An invite we sent was accepted; the chat list has a new entry. */
  onChatCreated?: () => void
  /**
   * Someone else opened a chat we are in: everything in it sent at or before
   * `readAt` is now read.
   */
  onMessagesRead?: (chatId: string, readAt: string) => void
  onError?: (message: string) => void
}

/**
 * One multiplexed socket for the whole session: the backend routes every chat
 * over it and fans out by chat_id, so there is nothing to open or close when
 * the user switches conversations.
 */
export function useChatSocket({
  enabled,
  onNewMessage,
  onChatCreated,
  onMessagesRead,
  onError,
}: UseChatSocketOptions) {
  const [status, setStatus] = useState<SocketStatus>('closed')

  const socketRef = useRef<WebSocket | null>(null)

  // Handlers are read through a ref so a new callback identity on every render
  // never tears the socket down.
  const handlers = useRef({
    onNewMessage,
    onChatCreated,
    onMessagesRead,
    onError,
  })
  useEffect(() => {
    handlers.current = { onNewMessage, onChatCreated, onMessagesRead, onError }
  }, [onNewMessage, onChatCreated, onMessagesRead, onError])

  useEffect(() => {
    if (!enabled) return

    // Scoped to this effect run, not shared across runs. A ref here would be
    // reset by the next run before the previous run's sockets finished closing,
    // and those stale sockets would each schedule a reconnect.
    let cancelled = false
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    // `stable` is what earns a fresh backoff: only a connection that held for a
    // while counts, so a socket losing the one-per-user race backs off instead
    // of fighting for the slot.
    const scheduleReconnect = (stable: boolean) => {
      if (cancelled) return

      if (stable) attempts = 0

      const delay = Math.min(
        BASE_RECONNECT_DELAY * 2 ** attempts,
        MAX_RECONNECT_DELAY,
      )
      attempts += 1
      timer = setTimeout(() => void connect(), delay)
    }

    const connect = async () => {
      if (cancelled) return

      setStatus('connecting')

      // Refresh first if the token has aged out: the upgrade is rejected
      // outright with a stale one, and a reconnect would present the very same
      // token, so the socket would retry forever instead of recovering.
      const token = await ensureAccessToken()
      if (cancelled) return

      if (token === null) {
        // Signed out, or the refresh failed. The route guard handles the former;
        // retrying covers the latter.
        setStatus('closed')
        scheduleReconnect(false)
        return
      }

      const socket = new WebSocket(socketUrl(), [WS_AUTH_PROTOCOL, token])
      socketRef.current = socket
      const openedAt = Date.now()

      socket.onopen = () => {
        if (cancelled) return
        setStatus('open')
      }

      socket.onmessage = (event) => {
        let payload: WSMessage
        try {
          payload = JSON.parse(event.data as string)
        } catch {
          return
        }

        switch (payload.kind) {
          case WSKind.NewMessage:
            if (!payload.id || !payload.chat_id || !payload.sender_id) return

            handlers.current.onNewMessage({
              id: payload.id,
              chat_id: payload.chat_id,
              sender_id: payload.sender_id,
              content: payload.content ?? '',
              sent_at: payload.sent_at ?? new Date().toISOString(),
              // A message is never born read; the receipt arrives separately.
              read_at: null,
            })
            break

          case WSKind.ChatCreated:
            handlers.current.onChatCreated?.()
            break

          case WSKind.MessagesRead:
            if (!payload.chat_id || !payload.read_at) return

            handlers.current.onMessagesRead?.(payload.chat_id, payload.read_at)
            break

          case WSKind.Error:
          case WSKind.InvalidJSON:
            handlers.current.onError?.(
              payload.message ?? 'Something went wrong',
            )
            break
        }
      }

      socket.onclose = () => {
        // Superseded by a newer socket: that one owns the connection now.
        if (socketRef.current === socket) socketRef.current = null
        if (cancelled || socketRef.current !== null) return

        setStatus('closed')
        scheduleReconnect(Date.now() - openedAt >= STABLE_CONNECTION_MS)
      }

      // An error is always followed by a close, which owns the reconnect.
      socket.onerror = () => socket.close()
    }

    void connect()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      socketRef.current?.close()
      socketRef.current = null
      setStatus('closed')
    }
  }, [enabled])

  const sendMessage = useCallback(
    (chatId: string, content: string): boolean => {
      const socket = socketRef.current
      if (!socket || socket.readyState !== WebSocket.OPEN) return false

      socket.send(
        JSON.stringify({
          kind: WSKind.SendMessage,
          chat_id: chatId,
          content,
        }),
      )
      return true
    },
    [],
  )

  return { status, sendMessage }
}
