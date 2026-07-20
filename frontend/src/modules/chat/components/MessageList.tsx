import { useEffect, useRef } from 'react'
import { formatMessageTime } from '@/lib/format'
import type { Message } from '@/types/api'

interface MessageListProps {
  messages: Message[]
  currentUserId: string
  isLoading: boolean
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
    <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-4 md:p-6">
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
              <p className="mt-1 text-right text-[10.5px] opacity-60">
                {formatMessageTime(message.sent_at)}
              </p>
            </div>
          </div>
        )
      })}

      <div ref={bottomRef} />
    </div>
  )
}
