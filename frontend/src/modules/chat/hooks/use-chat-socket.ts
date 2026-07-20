import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE } from '@/lib/api'
import type { Message } from '@/types/api'

/** Mirrors api.MessageKind — a Go iota, so these are positional. */
export const WSKind = {
  SendMessage: 0,
  NewMessage: 1,
  Error: 2,
  InvalidJSON: 3,
  ChatCreated: 4,
} as const

export interface WSMessage {
  kind: number
  chat_id?: string
  content?: string
  id?: string
  sender_id?: string
  sent_at?: string
  message?: string
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
  onError,
}: UseChatSocketOptions) {
  const [status, setStatus] = useState<SocketStatus>('closed')

  const socketRef = useRef<WebSocket | null>(null)

  // Handlers are read through a ref so a new callback identity on every render
  // never tears the socket down.
  const handlers = useRef({ onNewMessage, onChatCreated, onError })
  useEffect(() => {
    handlers.current = { onNewMessage, onChatCreated, onError }
  }, [onNewMessage, onChatCreated, onError])

  useEffect(() => {
    if (!enabled) return

    // Scoped to this effect run, not shared across runs. A ref here would be
    // reset by the next run before the previous run's sockets finished closing,
    // and those stale sockets would each schedule a reconnect.
    let cancelled = false
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (cancelled) return

      setStatus('connecting')

      // The access_token cookie rides along on the upgrade request, so the
      // socket needs no auth handshake of its own.
      const socket = new WebSocket(socketUrl())
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
            })
            break

          case WSKind.ChatCreated:
            handlers.current.onChatCreated?.()
            break

          case WSKind.Error:
          case WSKind.InvalidJSON:
            handlers.current.onError?.(payload.message ?? 'Something went wrong')
            break
        }
      }

      socket.onclose = () => {
        // Superseded by a newer socket: that one owns the connection now.
        if (socketRef.current === socket) socketRef.current = null
        if (cancelled || socketRef.current !== null) return

        setStatus('closed')

        // Only a connection that held for a while earns a fresh backoff.
        if (Date.now() - openedAt >= STABLE_CONNECTION_MS) attempts = 0

        const delay = Math.min(
          BASE_RECONNECT_DELAY * 2 ** attempts,
          MAX_RECONNECT_DELAY,
        )
        attempts += 1
        timer = setTimeout(connect, delay)
      }

      // An error is always followed by a close, which owns the reconnect.
      socket.onerror = () => socket.close()
    }

    connect()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      socketRef.current?.close()
      socketRef.current = null
      setStatus('closed')
    }
  }, [enabled])

  const sendMessage = useCallback((chatId: string, content: string): boolean => {
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
  }, [])

  return { status, sendMessage }
}
