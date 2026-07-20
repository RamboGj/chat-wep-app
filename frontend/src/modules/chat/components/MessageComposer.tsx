import { useRef, useState, type KeyboardEvent } from 'react'
import type { SocketStatus } from '../hooks/use-chat-socket'

interface MessageComposerProps {
  onSend: (content: string) => boolean
  status: SocketStatus
}

const MAX_HEIGHT = 120

export function MessageComposer({ onSend, status }: MessageComposerProps) {
  const [draft, setDraft] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const offline = status !== 'open'
  const canSend = draft.trim().length > 0 && !offline

  function resize() {
    const el = textareaRef.current
    if (!el) return

    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }

  function send() {
    const content = draft.trim()
    if (!content || offline) return

    // The socket is the only transport; if the send fails the draft is kept so
    // the user does not lose what they typed.
    if (!onSend(content)) return

    setDraft('')
    requestAnimationFrame(resize)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  return (
    <div className="flex items-end gap-2 border-t border-white-08 bg-gray-700 px-4 py-3 md:gap-3 md:px-6 md:py-4">
      <label className="sr-only" htmlFor="message_input">
        Type a message
      </label>
      {/* text-base below md: iOS Safari zooms the viewport on focus for
          anything under 16px. */}
      <textarea
        ref={textareaRef}
        id="message_input"
        rows={1}
        placeholder={offline ? 'Reconnecting…' : 'Type a message'}
        value={draft}
        disabled={offline}
        onChange={(event) => {
          setDraft(event.target.value)
          resize()
        }}
        onKeyDown={handleKeyDown}
        className="max-h-30 min-w-0 flex-1 resize-none rounded-[14px] border border-white-08 bg-gray-600 px-4 py-3 font-manrope text-base text-gray-100 placeholder:text-gray-300 focus:border-brand-500 focus:outline-none disabled:opacity-60 md:text-sm"
      />

      <button
        type="button"
        onClick={send}
        disabled={!canSend}
        aria-label="Send message"
        className={`flex size-11 shrink-0 items-center justify-center rounded-full text-white transition-[filter] duration-200 ${
          canSend
            ? 'cursor-pointer bg-[linear-gradient(135deg,var(--color-brand-500),var(--color-brand-400))] hover:brightness-110'
            : 'cursor-not-allowed bg-gray-400'
        }`}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M2.5 21 23 12 2.5 3 2.5 10l14.5 2-14.5 2z" />
        </svg>
      </button>
    </div>
  )
}
