# Real-time — socket to query cache

One WebSocket per user for the whole session (`/api/v1/ws`), not one per chat. Envelopes carry
a `chat_id` and a numeric `kind`; the backend hub fans each message out to that chat's
connected participants. The backend side is documented in the `go-chat-backend` skill's
`references/realtime-hub.md`.

## The layering

```
use-chat-socket.ts    transport: connect, auth, parse envelopes, reconnect
        ↓  typed callbacks (onNewMessage, onChatCreated, onError)
use-chat.ts           cache: fold each event into TanStack Query
        ↓  plain query hooks
components            render
```

Keep the split. `use-chat-socket` knows nothing about the query cache; `use-chat` knows nothing
about frames or reconnects. A new event kind means a new callback on the socket hook and a new
handler in `useChatRealtime` — never a `setQueryData` inside the socket layer.

The socket authenticates with the same access token as every other request, but it cannot send
an `Authorization` header — the `WebSocket` constructor takes no headers. It passes the token
as the second **subprotocol**, after a `'bearer'` sentinel, and the server selects `'bearer'`:

```ts
new WebSocket(socketUrl(), [WS_AUTH_PROTOCOL, token])
```

The query string is *not* an option: chi's request logger would write the token into every
access log line.

`connect()` calls `ensureAccessToken()` first, which refreshes an expired token before the
handshake. Skipping that is a trap — the upgrade is rejected outright with a stale token, and
the reconnect would present the very same token, so the socket retries forever instead of
recovering.

## Only one socket per user, ever

The hub allows **one connection per user and evicts the previous one** when a second arrives.
Two consequences:

- **Exactly one call to `useChatRealtime` in the tree.** It lives in `ChatPage`. A second
  component calling it opens a second socket, which evicts the first, whose close handler
  reconnects, which evicts the second — an infinite loop that looks like flapping connectivity.
- **Reconnect logic must not treat a server-initiated close as a transient failure.** Blind
  retry against an eviction is the same loop. Reconnect with backoff, and stop on a close code
  that means "you were replaced" rather than "the network dropped."

Gate the connection with `enabled` — it must be false until the current user is known, or the
socket opens before the session is established and immediately fails the upgrade.

## Folding events into the cache

Every handler is a `setQueryData` against a key from `queryKeys`. Three rules:

1. **Tolerate `current` being `undefined`.** The query may not have loaded. Returning `current`
   unchanged is correct — the eventual fetch will include whatever you skipped.
2. **Return new objects.** Mutating the cached array in place will not re-render.
3. **Be idempotent.** Reconnects and StrictMode double-invocation both replay handlers; a
   handler that appends unconditionally will duplicate rows.

```ts
const applyMessage = useCallback(
  (message: Message) => {
    queryClient.setQueryData<Message[]>(queryKeys.messages(message.chat_id), (current) => {
      if (!current) return current              // not loaded yet; the fetch will include it
      if (current.some((m) => m.id === message.id)) return current   // idempotent
      return [...current, message]
    })

    let known = false

    queryClient.setQueryData<ChatSummary[]>(queryKeys.chats, (current) => {
      if (!current) return current
      known = current.some((chat) => chat.chat_id === message.chat_id)
      if (!known) return current

      return current
        .map((chat) =>
          chat.chat_id === message.chat_id
            ? { ...chat, last_message: message.content, last_message_at: message.sent_at }
            : chat,
        )
        .sort(byRecency)
    })

    // Backstop for a chat we have never seen: the ChatCreated push normally gets
    // there first, but it is dropped if we were offline when the invite was accepted.
    if (!known) {
      queryClient.invalidateQueries({ queryKey: queryKeys.chats })
    }
  },
  [queryClient],
)
```

Note the shape of that backstop. **Any event referencing an entity not in the cache should fall
back to `invalidateQueries`** rather than being dropped — pushes are missed while offline, and
a UI that only ever updates from pushes will stay wrong until a manual refresh.

`useCallback` here is not a performance hedge (React Compiler handles that) — `applyMessage` is
a declared dependency of the socket effect, so a stable identity is required for correctness.

## The echo is the only path in

The backend fans out to **all** participants including the sender, so a sent message comes back
over the socket, and that echo doubles as the ack. **Nothing is inserted optimistically for
messages.** One path into the cache means no duplicate reconciliation, no temporary ids, and no
divergence between what the sender sees and what everyone else sees.

Do not add an optimistic insert to make sending feel faster. If perceived latency needs work,
the composer can show a pending state without writing to the cache — which is exactly why the
image-upload spec puts the pending thumbnail *above* the composer rather than in the message
list.

Optimistic updates are still fine where there is no echo — zeroing an unread count in a
mutation's `onMutate`, for instance.

## Adding an event kind

The `kind` discriminator is an **append-only iota** shared with the Go `MessageKind`. Never
renumber or reuse a value: a deployed frontend and a newly deployed backend will disagree for
as long as anyone has a tab open, and a renumbered kind means messages are silently routed to
the wrong handler rather than failing loudly.

To add one:

1. Add the kind and any new envelope fields to `types/api.ts`, matching the Go `WSMessage`
   tags. Fields with `omitempty` are optional (`field?: T`).
2. Add a callback to `useChatSocket`'s options and dispatch on the new kind.
3. Add the handler in `useChatRealtime`.
4. Ignore unknown kinds silently — an older frontend must not break against a newer backend.

**Prefer constant-size payloads.** The hub drops a client whose 256-slot send buffer backs up,
so an unbounded payload (a list of every affected message id) can disconnect exactly the users
with the most history. This is why read receipts push a single `read_at` timestamp meaning
"everything in this chat sent at or before this is read" instead of an id list — constant size,
and it closes the race where a message created after the update arrives before the receipt.

```ts
queryClient.setQueryData<Message[]>(queryKeys.messages(chatId), (current) =>
  current?.map((m) =>
    m.read_at === null && Date.parse(m.sent_at) <= Date.parse(readAt)
      ? { ...m, read_at: readAt }
      : m,
  ),
)
```
