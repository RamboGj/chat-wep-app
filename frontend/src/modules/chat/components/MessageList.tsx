import { useEffect, useRef } from 'react'
import { formatMessageTime } from '@/lib/format'
import type { Message } from '@/types/api'

interface MessageListProps {
  messages: Message[]
  currentUserId: string
  isLoading: boolean
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

export function MessageList({ messages, currentUserId, isLoading }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  // Follow the conversation as messages arrive over the socket.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

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
    <div className="scroll-surface flex flex-1 flex-col gap-2.5 overflow-y-auto p-4 md:p-6">
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
