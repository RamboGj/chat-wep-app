import { Avatar } from '@/components/atoms/Avatar/Avatar'
import { formatChatTime } from '@/lib/format'
import { InvitesPanel } from '@/modules/friends/components/InvitesPanel'
import type { ChatSummary } from '@/types/api'
import type { TypingState } from '../hooks/use-typing-indicator'

interface ChatSidebarProps {
  chats: ChatSummary[]
  selectedChatId: string | null
  onSelect: (chatId: string) => void
  search: string
  onSearchChange: (value: string) => void
  isLoading: boolean
  /** Ephemeral typing state, chat id → the user ids typing in it. */
  typing: TypingState
  /** Controls the pane's visibility across breakpoints; owned by the page. */
  className?: string
}

export function ChatSidebar({
  chats,
  selectedChatId,
  onSelect,
  search,
  onSearchChange,
  isLoading,
  typing,
  className = '',
}: ChatSidebarProps) {
  const query = search.trim().toLowerCase()
  const filtered = query
    ? chats.filter((chat) => chat.other_username.toLowerCase().includes(query))
    : chats

  return (
    <aside
      className={`w-full min-w-0 flex-col bg-gray-800 md:w-72 md:min-w-72 md:border-r md:border-white-08 lg:w-85 lg:min-w-85 ${className}`}
    >
      <div className="p-4">
        <label className="sr-only" htmlFor="search_chats_input">
          Search chats
        </label>
        <input
          type="search"
          name="search"
          id="search_chats_input"
          placeholder="Search chats"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          className="w-full rounded-[10px] border border-white-08 bg-gray-600 px-3.5 py-2.5 font-manrope text-base text-gray-100 placeholder:text-gray-300 focus:border-brand-500 focus:outline-none md:text-sm"
        />
      </div>

      <div className="scroll-surface flex-1 overflow-y-auto px-2 pb-2">
        <InvitesPanel />

        {isLoading ? (
          <p className="px-3 py-6 text-center font-manrope text-sm text-gray-300">
            Loading chats…
          </p>
        ) : filtered.length === 0 ? (
          <p className="px-3 py-6 text-center font-manrope text-sm text-gray-300">
            {query
              ? `No chats match "${search}"`
              : 'No chats yet. Invite someone with “New chat”.'}
          </p>
        ) : (
          <ul>
            {filtered.map((chat) => {
              const isSelected = chat.chat_id === selectedChatId

              // The open chat never wears a pill — you are looking at it, and
              // its count is on its way to zero. Suppressing it here rather
              // than in the cache is what lets an incoming message still raise
              // the count and trigger the mark-read effect.
              const unread = chat.unread_count > 0 && !isSelected

              // 1:1 today, so the other participant is the only one who can be
              // typing in this row.
              const isTyping = typing.get(chat.chat_id)?.has(chat.other_user_id) ?? false

              return (
                <li key={chat.chat_id}>
                  <button
                    type="button"
                    onClick={() => onSelect(chat.chat_id)}
                    aria-current={isSelected}
                    className="mb-0.5 flex w-full items-center gap-3 rounded-xl p-3 text-left transition-colors duration-200 hover:bg-white-08 hover:cursor-pointer"
                  >
                    <Avatar
                      name={chat.other_username}
                      size="lg"
                      ringColor="var(--color-gray-800)"
                    />

                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span
                          className={`truncate font-sora text-sm font-semibold ${
                            isSelected ? 'text-brand-100' : 'text-gray-100'
                          }`}
                        >
                          {chat.other_username}
                        </span>
                        <span className="shrink-0 text-[11px] text-gray-300">
                          {formatChatTime(chat.last_message_at)}
                        </span>
                      </div>

                      {/* The dim grey preview is the read state; brightening it
                          is the only change unread makes to the row besides the
                          pill, so a read chat renders exactly as it did before
                          this feature. Typing replaces the preview in the
                          success token (the project's live-state colour): it
                          reads as "live" rather than as content and does not
                          fight the unread pill, which stays as feature 2 has it. */}
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <p
                          className={`truncate font-manrope text-[13px] ${
                            isTyping
                              ? 'text-success-500'
                              : unread
                                ? 'text-gray-100'
                                : 'text-gray-300'
                          }`}
                        >
                          {isTyping ? 'typing…' : (chat.last_message ?? 'Say hello 👋')}
                        </p>

                        {unread && (
                          <span
                            aria-label={`${chat.unread_count} unread messages`}
                            className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,var(--color-brand-500),var(--color-brand-400))] px-1.5 font-sora text-[11px] font-bold text-white"
                          >
                            {chat.unread_count > 99 ? '99+' : chat.unread_count}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </aside>
  )
}
