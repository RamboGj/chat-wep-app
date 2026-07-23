import { useEffect, useLayoutEffect, useRef } from 'react'
import { formatMessageTime } from '@/lib/format'
import type { Message } from '@/types/api'

interface MessageListProps {
  messages: Message[]
  currentUserId: string
  isLoading: boolean
  /** Whether there is more history behind the oldest loaded message. */
  hasOlder: boolean
  isLoadingOlder: boolean
  loadOlder: () => void
}

/**
 * Always a double check — there is no single-check state to render. Nothing is
 * inserted optimistically, so every message on screen is already the server's
 * echo; "sent but not yet acknowledged" is a state this UI can never be in.
 *
 * Mint rather than brand for the read state: own bubbles *are* the brand
 * gradient, so a brand-coloured tick would be invisible on its own background.
 */
function ReadTicks({ readAt }: { readAt: string | null }) {
  const read = readAt !== null

  return (
    <svg
      width="17"
      height="16"
      viewBox="0 0 17 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={read ? 'Read' : 'Sent'}
      className={`inline-block shrink-0 align-[-0.2em] ${
        read ? 'text-success-500' : 'text-white/45'
      }`}
    >
      <path d="M1 8.5 L4.2 12 L10.5 4.5" />
      <path d="M6.5 8.5 L9.7 12 L16 4.5" />
    </svg>
  )
}

export function MessageList({
  messages,
  currentUserId,
  isLoading,
  hasOlder,
  isLoadingOlder,
  loadOlder,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Where the list stood when an older page went in flight; spent by the layout
  // effect below and cleared to null there.
  const prevScrollRef = useRef<{ height: number; top: number } | null>(null)

  const lastMessageId = messages.at(-1)?.id

  // Follow the conversation as messages arrive over the socket.
  //
  // Keyed on the newest message and not on messages.length: prepending an older
  // page changes the length too, so that version yanked the user from the top of
  // the history back to the bottom on every page load. A prepend leaves the last
  // message alone, an arriving one does not, and switching chats changes it as
  // well — so a chat still opens at the bottom.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [lastMessageId])

  // Loading older history is triggered by the sentinel reaching the top of the
  // scroll container. An observer rather than a scroll handler: nothing fires
  // per frame, there is no scrollTop arithmetic, and a short history that leaves
  // the sentinel on screen simply fires again for the next page.
  //
  // isLoadingOlder in the deps is what stops a burst: while a page is in flight
  // the observer is torn down entirely, so a sentinel that stays visible cannot
  // fire again. It is re-attached when the fetch settles, by which point the
  // prepended page has pushed it out of view.
  useEffect(() => {
    const sentinel = sentinelRef.current
    const root = scrollRef.current
    if (!sentinel || !root || !hasOlder || isLoadingOlder) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) loadOlder()
      },
      // Fire a little before the true top so the page is usually already in
      // flight by the time the user gets there.
      { root, rootMargin: '120px 0px 0px 0px' },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasOlder, isLoadingOlder, loadOlder])

  useEffect(() => {
    if (isLoadingOlder && scrollRef.current) {
      prevScrollRef.current = {
        height: scrollRef.current.scrollHeight,
        top: scrollRef.current.scrollTop,
      }
    }
  }, [isLoadingOlder])

  // Prepending grows scrollHeight above the viewport while scrollTop stays put,
  // so the content under the user's eyes would jump down by the height of the
  // new page. useLayoutEffect and not useEffect: a plain effect runs after
  // paint, so the jump would be visible for one frame before the correction.
  //
  // scrollTop is *assigned*, never `+=`. Chrome's scroll anchoring compensates
  // for content inserted above the viewport on its own, so adding our delta on
  // top of its adjustment moves the user a whole page further down — which
  // reads as "loading older messages throws me to the bottom". An absolute
  // target lands in the same place whether the browser adjusted or not, and
  // `overflow-anchor: none` on the container below stops it adjusting at all;
  // WebKit never had anchoring, so the correction has to stand on its own there
  // regardless.
  //
  // isLoadingOlder is a dependency as well as messages.length so the capture is
  // always spent. A page that comes back empty settles the fetch without
  // changing the length, and a position left behind there would be applied
  // later against the next arriving message.
  useLayoutEffect(() => {
    const el = scrollRef.current
    const prev = prevScrollRef.current
    if (!el || !prev) return

    el.scrollTop = prev.top + (el.scrollHeight - prev.height)
    prevScrollRef.current = null
  }, [messages.length, isLoadingOlder])

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center font-manrope text-sm text-gray-300">
        Loading messages…
      </div>
    )
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center font-manrope text-sm text-gray-300">
        No messages yet — say hello 👋
      </div>
    )
  }

  return (
    /* [overflow-anchor:none]: the layout effect above owns scroll restoration.
       Left on, the browser corrects for the prepended page as well and the two
       corrections stack into a full-page jump. */
    <div
      ref={scrollRef}
      className="scroll-surface flex flex-1 flex-col gap-2.5 overflow-y-auto p-4 [overflow-anchor:none] md:p-6"
    >
      {/* Constant height, and mounted whatever the state — including once
          hasOlder is false. Both children are absolutely positioned so the row
          measures the same 4px loading or idle: any height it gained while the
          spinner was up would land inside the scrollHeight delta the layout
          effect corrects against and make the correction overshoot. Unmounting
          the row would likewise take its height off the top of the content at
          exactly the moment the user is looking at the top of the content. */}
      <div className="relative flex h-1 shrink-0 items-center justify-center">
        <div ref={sentinelRef} aria-hidden className="absolute inset-x-0 top-0 h-px" />
        {isLoadingOlder && (
          <div
            role="status"
            aria-label="Loading older messages"
            className="absolute left-1/2 top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 animate-spin rounded-full border-2 border-brand-400 border-t-transparent"
          />
        )}
      </div>

      {messages.map((message) => {
        const mine = message.sender_id === currentUserId

        return (
          <div
            key={message.id}
            className={`flex animate-showContent ${mine ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 font-manrope text-sm leading-[1.45] text-gray-100 sm:max-w-[75%] lg:max-w-[60%] ${
                mine
                  ? 'bg-[linear-gradient(135deg,var(--color-brand-500),var(--color-brand-400))]'
                  : 'bg-gray-500'
              }`}
            >
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
              {/* Ticks only on our own bubbles: a read receipt on someone
                  else's message tells the reader nothing. */}
              <p className="mt-1 flex items-center justify-end gap-1 text-right text-[10.5px]">
                <span className="opacity-60">{formatMessageTime(message.sent_at)}</span>
                {mine && <ReadTicks readAt={message.read_at} />}
              </p>
            </div>
          </div>
        )
      })}

      <div ref={bottomRef} />
    </div>
  )
}
