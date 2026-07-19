import { Avatar } from '@/components/atoms/Avatar/Avatar'
import { formatChatTime } from '@/lib/format'
import { InvitesPanel } from '@/modules/friends/components/InvitesPanel'
import type { ChatSummary } from '@/types/api'

interface ChatSidebarProps {
  chats: ChatSummary[]
  selectedChatId: string | null
  onSelect: (chatId: string) => void
  search: string
  onSearchChange: (value: string) => void
  isLoading: boolean
}

export function ChatSidebar({
  chats,
  selectedChatId,
  onSelect,
  search,
  onSearchChange,
  isLoading,
}: ChatSidebarProps) {
  const query = search.trim().toLowerCase()
  const filtered = query
    ? chats.filter((chat) => chat.other_username.toLowerCase().includes(query))
    : chats

  return (
    <aside className="flex w-85 min-w-85 flex-col border-r border-white-08 bg-gray-800">
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
          className="w-full rounded-[10px] border border-white-08 bg-gray-600 px-3.5 py-2.5 font-manrope text-sm text-gray-100 placeholder:text-gray-300 focus:border-brand-500 focus:outline-none"
        />
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
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

              return (
                <li key={chat.chat_id}>
                  <button
                    type="button"
                    onClick={() => onSelect(chat.chat_id)}
                    aria-current={isSelected}
                    className="mb-0.5 flex w-full items-center gap-3 rounded-xl p-3 text-left transition-colors duration-200 hover:bg-white-08"
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

                      <p className="mt-0.5 truncate font-manrope text-[13px] text-gray-300">
                        {chat.last_message ?? 'Say hello 👋'}
                      </p>
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
