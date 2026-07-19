import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Avatar } from '@/components/atoms/Avatar/Avatar'
import { Logo } from '@/components/atoms/Logo/Logo'
import { useCurrentUser, useLogout } from '@/modules/auth/hooks/use-auth'
import { NewChatDialog } from '@/modules/friends/components/NewChatDialog'
import { useRemoveFriend } from '@/modules/friends/hooks/use-friends'
import { ChatSidebar } from '../components/ChatSidebar'
import { MessageComposer } from '../components/MessageComposer'
import { MessageList } from '../components/MessageList'
import { useChatRealtime, useChats, useMessages } from '../hooks/use-chat'

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

  const handleSocketError = useCallback((message: string) => {
    setSocketError(message)
  }, [])

  // Stable identity: the dialog subscribes to it in an effect.
  const closeNewChat = useCallback(() => setShowNewChat(false), [])

  const { status, sendMessage } = useChatRealtime({
    enabled: Boolean(user),
    onError: handleSocketError,
  })

  // Clear the socket error banner shortly after it appears.
  useEffect(() => {
    if (!socketError) return

    const timer = setTimeout(() => setSocketError(null), 4000)
    return () => clearTimeout(timer)
  }, [socketError])

  const selectedChat = useMemo(
    () => chats.find((chat) => chat.chat_id === selectedChatId) ?? null,
    [chats, selectedChatId],
  )

  // A chat can vanish underneath the selection — the other side may have
  // removed us. Deriving the active id from the chat list rather than trusting
  // the stored one means no request is ever made for a chat we no longer have,
  // and the view falls back to the empty state on its own.
  const activeChatId = selectedChat?.chat_id ?? null

  const { data: messages = [], isLoading: messagesLoading } = useMessages(activeChatId)

  function handleSend(content: string) {
    if (!activeChatId) return false
    return sendMessage(activeChatId, content)
  }

  function handleLogout() {
    logout.mutate(undefined, {
      onSettled: () => navigate({ to: '/auth' }),
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

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-gray-900 text-gray-100">
      <header className="flex h-16 min-h-16 items-center justify-between border-b border-white-08 bg-gray-700 px-6">
        <div className="flex items-center gap-3">
          <Avatar
            name={user?.username ?? '?'}
            size="sm"
            ringColor="var(--color-gray-700)"
          />
          <div>
            <p className="font-sora text-[15px] font-bold leading-tight">
              {user?.username ?? '…'}
            </p>
            <p className="font-manrope text-xs text-gray-300">Pulse Messenger</p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <span
            className="font-manrope text-xs text-gray-300"
            aria-live="polite"
          >
            {status === 'open'
              ? 'Connected'
              : status === 'connecting'
                ? 'Connecting…'
                : 'Offline'}
          </span>

          <button
            type="button"
            onClick={() => setShowNewChat(true)}
            className="flex cursor-pointer items-center gap-2 rounded-[10px] bg-[linear-gradient(135deg,var(--color-brand-500),var(--color-brand-400))] px-4 py-2.5 font-sora text-[13px] font-semibold text-white transition-[filter] duration-200 hover:brightness-110"
          >
            <span className="text-base leading-none">+</span> New chat
          </button>

          <button
            type="button"
            onClick={handleLogout}
            disabled={logout.isPending}
            className="cursor-pointer rounded-[10px] border border-white-12 px-3.5 py-2.5 font-manrope text-[13px] text-gray-300 transition-colors duration-200 hover:border-white-25 hover:text-gray-100 disabled:opacity-50"
          >
            Log out
          </button>
        </div>
      </header>

      {socketError && (
        <p
          role="alert"
          className="border-b border-white-08 bg-error-500/15 px-6 py-2 font-manrope text-sm text-error-500"
        >
          {socketError}
        </p>
      )}

      <div className="flex flex-1 overflow-hidden">
        <ChatSidebar
          chats={chats}
          selectedChatId={selectedChatId}
          onSelect={setSelectedChatId}
          search={search}
          onSearchChange={setSearch}
          isLoading={chatsLoading}
        />

        <main className="flex min-w-0 flex-1 flex-col bg-gray-900">
          {selectedChat && user ? (
            <>
              <header className="flex h-18 min-h-18 items-center gap-3 border-b border-white-08 bg-gray-700 px-6">
                <Avatar
                  name={selectedChat.other_username}
                  ringColor="var(--color-gray-700)"
                />
                <div className="flex-1">
                  <p className="font-sora text-[15px] font-bold">
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
                  className="cursor-pointer rounded-[10px] border border-white-12 px-3 py-2 font-manrope text-xs text-gray-300 transition-colors duration-200 hover:border-error-500 hover:text-error-500 disabled:opacity-50"
                >
                  Remove friend
                </button>
              </header>

              <MessageList
                messages={messages}
                currentUserId={user.id}
                isLoading={messagesLoading}
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
