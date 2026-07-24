import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * One second of slack over the sender's 3s throttle, so latency and jitter
 * cannot make a continuously typing user's indicator flicker.
 */
export const TYPING_TTL = 4_000

/** The rendered snapshot: chat id → the set of user ids typing in it. */
export type TypingState = Map<string, Set<string>>

/**
 * Receiver-side typing state, kept out of the React Query cache: writing it there
 * would re-render every chat-list subscriber on a timer and mix ephemeral state
 * into the cache that read receipts and pagination write to.
 *
 * A typing frame is a *lease*, not a toggle — there is no "stopped" frame. Each
 * frame renews a per-(chat, user) timer; when it lapses the indicator hides.
 * That single timer is also the only thing that covers a closed tab, a dead
 * socket, or a dropped frame — cases an explicit stop frame never could.
 */
export function useTypingIndicator() {
  const [typing, setTyping] = useState<TypingState>(new Map())

  // One timer per (chat, user). A ref, not state: timers are not render data,
  // and the map must survive every render to be cancellable.
  const timers = useRef(new Map<string, Map<string, ReturnType<typeof setTimeout>>>())

  const clearTyping = useCallback((chatId: string, userId: string) => {
    const chatTimers = timers.current.get(chatId)
    const timer = chatTimers?.get(userId)
    if (timer !== undefined) {
      clearTimeout(timer)
      chatTimers!.delete(userId)
      if (chatTimers!.size === 0) timers.current.delete(chatId)
    }

    setTyping((prev) => {
      const users = prev.get(chatId)
      if (!users?.has(userId)) return prev

      const next = new Map(prev)
      const remaining = new Set(users)
      remaining.delete(userId)
      if (remaining.size === 0) next.delete(chatId)
      else next.set(chatId, remaining)
      return next
    })
  }, [])

  const onTyping = useCallback(
    (chatId: string, userId: string) => {
      // Each frame replaces the previous timer, so a continuously typing user
      // renews their lease rather than accumulating timers.
      const chatTimers = timers.current.get(chatId) ?? new Map()
      clearTimeout(chatTimers.get(userId))
      chatTimers.set(userId, setTimeout(() => clearTyping(chatId, userId), TYPING_TTL))
      timers.current.set(chatId, chatTimers)

      setTyping((prev) => {
        // Already showing: the renewed timer above is the whole update, so skip
        // the state write and the re-render it would cause.
        if (prev.get(chatId)?.has(userId)) return prev

        const next = new Map(prev)
        const users = new Set(prev.get(chatId))
        users.add(userId)
        next.set(chatId, users)
        return next
      })
    },
    [clearTyping],
  )

  // Cancel every timer and drop all state. Used when the socket leaves `open`
  // (the state is unverifiable while disconnected, and a stale "typing…" carried
  // through a reconnect is worse than nothing) and on unmount.
  const clearAll = useCallback(() => {
    for (const chatTimers of timers.current.values())
      for (const timer of chatTimers.values()) clearTimeout(timer)
    timers.current.clear()
    setTyping((prev) => (prev.size === 0 ? prev : new Map()))
  }, [])

  useEffect(() => () => clearAll(), [clearAll])

  return { typing, onTyping, clearTyping, clearAll }
}
