import { createFileRoute, redirect } from '@tanstack/react-router'
import { queryClient } from '@/lib/query-client'
import { currentUserQueryOptions } from '@/modules/auth/hooks/use-auth'
import { ChatPage } from '@/modules/chat/pages/ChatPage'

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    // ensureQueryData shares the cache entry with useCurrentUser, so the guard
    // and the page never fetch /auth/me twice.
    const user = await queryClient
      .ensureQueryData(currentUserQueryOptions)
      .catch(() => null) // API unreachable: treat as signed out

    if (!user) {
      throw redirect({ to: '/auth' })
    }
  },
  component: Index,
})

function Index() {
  return <ChatPage />
}
