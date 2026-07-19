export const queryKeys = {
  currentUser: ['auth', 'me'] as const,
  chats: ['chats'] as const,
  messages: (chatId: string) => ['chats', chatId, 'messages'] as const,
  friends: ['friends'] as const,
  invites: ['friends', 'invites'] as const,
}
