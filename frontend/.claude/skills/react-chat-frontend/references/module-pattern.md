# Adding a domain feature end-to-end

The vertical slice for any new feature. Follow the layers in this order — each one only
depends on the one above it.

```
types/api.ts          mirror the Go JSON shape
      ↓
modules/<d>/api/      one apiFetch wrapper per endpoint
      ↓
lib/query-keys.ts     register the cache key
      ↓
modules/<d>/hooks/    useQuery / useMutation
      ↓
modules/<d>/components/  render it
```

## 1. Mirror the type

`src/types/api.ts`. Comment it with its Go source so the two can be diffed by eye. Keep the
backend's `snake_case` — the wire format is the contract, and renaming here means every cache
update has to translate in both directions.

```ts
/** services.ChatSummary */
export interface ChatSummary {
  chat_id: string
  other_user_id: string
  other_username: string
  last_message: string | null
  last_message_at: string | null
}
```

`timestamptz` arrives as an ISO string, so it is `string` here — parse at the point of use
(`Date.parse(...)`), never store a `Date` in the cache.

Nullable Go pointers (`*time.Time`) become `T | null`. A field the backend omits entirely
(`omitempty`) becomes optional (`field?: T`) — these are different, and conflating them is how
`undefined` reaches a component that only guards against `null`.

## 2. Wrap the endpoints

`src/modules/<domain>/api/<domain>-api.ts`. One exported object, methods named after the
action, not the HTTP verb.

```ts
import { apiFetch } from '@/lib/api'
import type { ChatSummary, Message } from '@/types/api'

export const chatApi = {
  list: () => apiFetch<{ chats: ChatSummary[] }>('/chats/').then((r) => r.chats),

  markRead: (chatId: string) =>
    apiFetch<{ marked: number; read_at: string }>(`/chats/${chatId}/read`, {
      method: 'POST',
    }),
}
```

Paths are relative to `/api/v1` — `apiFetch` prepends `API_BASE`. Never write the prefix here.

The backend wraps list responses in an envelope (`{ chats: [...] }`); unwrapping it in the API
module is the right place, so hooks and components deal in plain arrays.

Request payload types live in this file too, exported as named interfaces
(`export interface SignupPayload { … }`) so hooks can reference them without redeclaring.

## 3. Register the key

`src/lib/query-keys.ts`. Parameterized keys are functions; static ones are `as const` arrays.

```ts
export const queryKeys = {
  currentUser: ['auth', 'me'] as const,
  chats: ['chats'] as const,
  messages: (chatId: string) => ['chats', chatId, 'messages'] as const,
  friends: ['friends'] as const,
  invites: ['friends', 'invites'] as const,
}
```

The hierarchy is load-bearing: `queryKeys.invites` is `['friends', 'invites']`, so invalidating
`queryKeys.friends` also invalidates invites. Choose prefixes deliberately.

## 4. The hooks

`src/modules/<domain>/hooks/use-<domain>.ts`. Queries and mutations for one domain in one file.

```ts
export function useChats() {
  return useQuery({
    queryKey: queryKeys.chats,
    queryFn: chatApi.list,
  })
}

export function useMessages(chatId: string | null) {
  return useQuery({
    queryKey: queryKeys.messages(chatId ?? ''),
    queryFn: () => chatApi.listMessages(chatId as string),
    enabled: Boolean(chatId),
  })
}
```

The `enabled` + `?? ''` pairing is the pattern for a query that depends on a selection: the key
must still be a valid array when nothing is selected, and `enabled` stops it from firing.

**Export `queryOptions` instead of a hook when a route loader also needs the query.** This is
what keeps a guard and a component from issuing the same request twice:

```ts
export const currentUserQueryOptions = queryOptions<User | null>({
  queryKey: queryKeys.currentUser,
  queryFn: async () => {
    try {
      return await authApi.me()
    } catch (error) {
      // A 401 is the answer ("nobody is logged in"), not a failure — resolving to
      // null lets guards branch on the value instead of catching.
      if (error instanceof ApiError && error.status === 401) return null
      throw error
    }
  },
  retry: false,
  staleTime: 5 * 60 * 1000,
})

export function useCurrentUser() {
  return useQuery(currentUserQueryOptions)
}
```

Mutations declare their own cache consequences — the component calling them should not have to:

```ts
export function useLogout() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => authApi.logout(),
    onSettled: () => {
      // Drop every cached query: none of it belongs to the next user.
      queryClient.clear()
    },
  })
}
```

Use `onSettled` (not `onSuccess`) for cleanup that must happen even if the request failed —
a failed logout still needs the local cache gone.

For an optimistic update, do the write in `onMutate`:

```ts
export function useMarkChatRead() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (chatId: string) => chatApi.markRead(chatId),
    onMutate: (chatId) => {
      queryClient.setQueryData<ChatSummary[]>(queryKeys.chats, (current) =>
        current?.map((c) => (c.chat_id === chatId ? { ...c, unread_count: 0 } : c)),
      )
    },
  })
}
```

Every `setQueryData` updater must tolerate `current` being `undefined` (the query may not have
loaded) and must return a **new** array/object — mutating the cached value in place will not
re-render.

## 5. The component

Domain components go in `modules/<domain>/components/`; route-level ones in
`modules/<domain>/pages/`. Consume the hook, handle the three states, render atoms.

```tsx
export function ChatSidebar({ activeChatId, onSelect }: ChatSidebarProps) {
  const { data: chats, isPending, isError } = useChats()

  if (isPending) return <SidebarSkeleton />
  if (isError) return <SidebarError />

  return (
    <ul>
      {chats.map((chat) => (
        <li key={chat.chat_id}>…</li>
      ))}
    </ul>
  )
}
```

Narrowing on `isPending` / `isError` first means `chats` is non-undefined afterwards without a
non-null assertion.

Props: an explicit `interface XxxProps`, extending `ComponentProps<'element'>` when the
component wraps a DOM element. Callbacks are named `onXxx`. Pass data down and events up — a
sibling module is never imported directly.

## Where things do *not* go

| Temptation | Correct home |
|---|---|
| A `fetch` call inside a component | `modules/<d>/api/` |
| `queryClient.setQueryData` inside a component body | the hook's `onSuccess`/`onMutate` |
| A date/string formatter written twice | `lib/format.ts` |
| An inline `['chats', id]` key | `lib/query-keys.ts` |
| A generic Button/Input/Modal inside a module | `components/atoms/` |
| A zod schema next to the form | `utils/validation/` |
