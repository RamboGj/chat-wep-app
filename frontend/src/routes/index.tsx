import { createFileRoute } from '@tanstack/react-router'
import { ChatPage } from '../modules/chat/pages/ChatPage'

export const Route = createFileRoute('/')({
  component: Index,
})

function Index() {
  return <ChatPage />
}
