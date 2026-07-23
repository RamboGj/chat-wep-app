import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { Avatar } from '@/components/atoms/Avatar/Avatar'
import { Logo } from '@/components/atoms/Logo/Logo'
import { useCurrentUser, useLogout } from '@/modules/auth/hooks/use-auth'
import { NewChatDialog } from '@/modules/friends/components/NewChatDialog'
import { useRemoveFriend } from '@/modules/friends/hooks/use-friends'
import { ChatSidebar } from '../components/ChatSidebar'
import { MessageComposer } from '../components/MessageComposer'
import { MessageList } from '../components/MessageList'
import { useChatRealtime, useChats, useMarkChatRead, useMessages } from '../hooks/use-chat'

export function ChatPage() {
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [showNewChat, setShowNewChat] = useState(false)
  const [socketError, setSocketError] = useState<string | null>(null)

  const navigate = useNavigate()

  const { data: user } = useCurrentUser()
  const { data: chats = [], isLoading: chatsLoading } = useChats()

  const logout = useLogout()
  const removeFriend = useRemoveFriend()
  const { mutate: markChatRead } = useMarkChatRead()


  const handleSocketError = (message: string) => {
    setSocketError(message)
  }

  const closeNewChat = () => setShowNewChat(false)

  const { status, sendMessage } = useChatRealtime({
    enabled: Boolean(user),
    currentUserId: user?.id,
    onError: handleSocketError,
  })

  const selectedChat = chats.find((chat) => chat.chat_id === selectedChatId) ?? null

  const activeChatId = selectedChat?.chat_id ?? null

  const {
    messages,
    isLoading: messagesLoading,
    hasOlder,
    isLoadingOlder,
    loadOlder,
  } = useMessages(activeChatId)

  const activeUnreadCount = selectedChat?.unread_count ?? 0

  function handleSend(content: string) {
    if (!activeChatId) return false
    return sendMessage(activeChatId, content)
  }

  function handleLogout() {
    logout.mutate(undefined, {
      onSettled: () => navigate('/auth'),
    })
  }

  function handleRemoveFriend() {
    if (!selectedChat) return

    const confirmed = window.confirm(
      `Remove ${selectedChat.other_username}? This deletes the conversation and all of its messages for both of you.`,
    )
    if (!confirmed) return

    removeFriend.mutate(selectedChat.chat_id, {
      onSuccess: () => setSelectedChatId(null),
    })
  }

  // Clear the socket error banner shortly after it appears.
  useEffect(() => {
    if (!socketError) return

    const timer = setTimeout(() => setSocketError(null), 4000)
    return () => clearTimeout(timer)
  }, [socketError])

  useEffect(() => {
    if (!activeChatId || activeUnreadCount === 0) return

    const markIfVisible = () => {
      if (document.visibilityState !== 'visible') return
      markChatRead(activeChatId)
    }

    markIfVisible()

    document.addEventListener('visibilitychange', markIfVisible)
    return () => document.removeEventListener('visibilitychange', markIfVisible)
  }, [activeChatId, activeUnreadCount, markChatRead])



  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-gray-900 text-gray-100">
      <header className="flex h-16 min-h-16 items-center justify-between gap-3 border-b border-white-08 bg-gray-700 px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar
            name={user?.username ?? '?'}
            size="sm"
            ringColor="var(--color-gray-700)"
          />
          <div className="min-w-0">
            <p className="truncate font-sora text-[15px] font-bold leading-tight">
              {user?.username ?? '…'}
            </p>
            <p className="font-manrope text-xs text-gray-300">Pulse Messenger</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 md:gap-2.5">
          {/* Below sm the label collapses to its dot, so the status stays
              visible without crowding the actions off the header. */}
          <span className="flex items-center gap-2" aria-live="polite">
            <span
              aria-hidden
              className={`size-2 shrink-0 rounded-full ${
                status === 'open'
                  ? 'bg-success-500'
                  : status === 'connecting'
                    ? 'bg-brand-400'
                    : 'bg-error-500'
              }`}
            />
            <span className="sr-only sm:not-sr-only font-manrope text-xs text-gray-300">
              {status === 'open'
                ? 'Connected'
                : status === 'connecting'
                  ? 'Connecting…'
                  : 'Offline'}
            </span>
          </span>

          <button
            type="button"
            onClick={() => setShowNewChat(true)}
            className="flex cursor-pointer items-center gap-2 rounded-[10px] bg-[linear-gradient(135deg,var(--color-brand-500),var(--color-brand-400))] px-3 py-2.5 font-sora text-[13px] font-semibold text-white transition-[filter] duration-200 hover:brightness-110 sm:px-4"
          >
            <span className="text-base leading-none">+</span>
            <span className="sr-only sm:not-sr-only">New chat</span>
          </button>

          <button
            type="button"
            onClick={handleLogout}
            disabled={logout.isPending}
            className="cursor-pointer rounded-[10px] border border-white-12 px-3 py-2.5 font-manrope text-[13px] text-gray-300 transition-colors duration-200 hover:border-white-25 hover:text-gray-100 disabled:opacity-50 md:px-3.5"
          >
            Log out
          </button>
        </div>
      </header>

      {socketError && (
        <p
          role="alert"
          className="border-b border-white-08 bg-error-500/15 px-4 py-2 font-manrope text-sm text-error-500 md:px-6"
        >
          {socketError}
        </p>
      )}

      {/* Below md there is only room for one pane, so the selection doubles as
          navigation: the list is the screen until a chat is open. From md up
          both panes are always mounted side by side. */}
      <div className="flex flex-1 overflow-hidden">
        <ChatSidebar
          chats={chats}
          selectedChatId={selectedChatId}
          onSelect={setSelectedChatId}
          search={search}
          onSearchChange={setSearch}
          isLoading={chatsLoading}
          className={activeChatId ? 'hidden md:flex' : 'flex'}
        />

        <main
          className={`min-w-0 flex-1 flex-col bg-gray-900 ${
            activeChatId ? 'flex' : 'hidden md:flex'
          }`}
        >
          {selectedChat && user ? (
            <>
              <header className="flex h-18 min-h-18 items-center gap-3 border-b border-white-08 bg-gray-700 px-4 md:px-6">
                {/* Only pane on small screens, so it carries its own way back. */}
                <button
                  type="button"
                  onClick={() => setSelectedChatId(null)}
                  aria-label="Back to chats"
                  className="-ml-1 flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-gray-300 transition-colors duration-200 hover:bg-white-08 hover:text-gray-100 md:hidden"
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                </button>

                <Avatar
                  name={selectedChat.other_username}
                  ringColor="var(--color-gray-700)"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-sora text-[15px] font-bold">
                    {selectedChat.other_username}
                  </p>
                  <p className="font-manrope text-xs text-gray-300">
                    {status === 'open' ? 'Live' : 'Reconnecting…'}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleRemoveFriend}
                  disabled={removeFriend.isPending}
                  className="shrink-0 cursor-pointer rounded-[10px] border border-white-12 px-3 py-2 font-manrope text-xs text-gray-300 transition-colors duration-200 hover:border-error-500 hover:text-error-500 disabled:opacity-50"
                >
                  Remove<span className="sr-only sm:not-sr-only"> friend</span>
                </button>
              </header>

              <MessageList
                messages={messages}
                currentUserId={user.id}
                isLoading={messagesLoading}
                hasOlder={hasOlder}
                isLoadingOlder={isLoadingOlder}
                loadOlder={loadOlder}
              />

              <MessageComposer onSend={handleSend} status={status} />
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-gray-300">
              <Logo variant="outline" size="xl" markOnly />
              <p className="mt-1 font-sora text-base font-semibold text-gray-300">
                No chat selected
              </p>
              <p className="font-manrope text-[13px] text-gray-300">
                Pick a conversation from the sidebar to start messaging
              </p>
            </div>
          )}
        </main>
      </div>

      {showNewChat && <NewChatDialog onClose={closeNewChat} />}
    </div>
  )
}
