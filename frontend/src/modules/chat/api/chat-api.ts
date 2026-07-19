import { apiFetch } from '@/lib/api'
import type { ChatSummary, Message } from '@/types/api'

export const chatApi = {
  list: () => apiFetch<{ chats: ChatSummary[] }>('/chats/').then((r) => r.chats),

  /**
   * The API returns a newest-first page ending just before `before`. The UI
   * renders oldest-first, so the page is reversed here.
   */
  listMessages: async (chatId: string, options: { before?: string; limit?: number } = {}) => {
    const params = new URLSearchParams()
    if (options.before) params.set('before', options.before)
    if (options.limit) params.set('limit', String(options.limit))

    const query = params.toString()
    const res = await apiFetch<{ messages: Message[] }>(
      `/chats/${chatId}/messages${query ? `?${query}` : ''}`,
    )

    return res.messages.slice().reverse()
  },
}
