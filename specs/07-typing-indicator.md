# Feature 7 — Typing Indicator

"Typing…" appears under the conversation while the other person is composing, and in the sidebar
row of any chat they are typing in. It is **ephemeral state**: nothing is persisted, nothing is
queryable, and nothing about it survives a reload.

No migration, no query, no REST endpoint, no schema change. Two new WebSocket kinds and a `Map` in
the frontend.

## The two questions this feature is really about

The concern raised at kickoff was the right one: *is this another message on the socket, and how do
we cancel it without flooding the connection at scale?* Both are answered up front, because every
detail below follows from these two decisions.

### 1. Yes, the socket — and it is the cheap option, not the expensive one

The alternative is a REST endpoint per keystroke burst. That is strictly worse: a request carries
~500 bytes of headers, a TLS record, a handler goroutine, and a chi middleware chain to move ~40
bytes of meaning. The socket is already open, already authenticated, already multiplexed across
every chat, and its keepalive ping costs more per minute than the throttle below allows typing to.

```
{"kind":6,"chat_id":"3f2a…"}          ← 47 bytes, no auth, no headers, no handler
```

`maxMessageSize` is already 512 bytes and `WSMessage` already carries `chat_id` and `sender_id`,
so the envelope needs **no new fields**.

### 2. There is no cancel frame — the indicator expires on its own

This is the load-bearing decision.

> A typing frame is a **lease**, not a toggle. Receiving one shows the indicator for `TYPING_TTL`
> and no longer. Continuing to type renews the lease; anything else lets it lapse.

An explicit "stopped typing" frame is the obvious design and it is wrong, because it only covers
the one case where the user politely stops typing. It does nothing for the tab being closed, the
laptop lid closing, the socket dying, the message being sent, the browser being killed, or a
network partition — and every one of those has to hide the indicator too. So a receiver-side timer
is needed *regardless*, and once it exists the stop frame covers nothing the timer does not.

The stop frame is also the flooding vector, not the start frame: "typing" is throttled by
definition, but "stopped" fires on every pause — a user typing in bursts emits start/stop/start/
stop faster than they emit either alone.

**The one cancellation that is genuinely instant is free.** Sending the message already pushes
`KindNewMessage` with that `chat_id` and `sender_id`; the receiver clears the indicator when it
applies the message. Zero extra frames, and it arrives on the same ordered socket as the typing
frame, so it cannot race ahead of it.

### The numbers

| Constant | Value | Where | Why |
|---|---|---|---|
| `TYPING_THROTTLE` | 3s | client (sender) | Leading edge: emit immediately, then at most one per interval while typing continues. |
| `TYPING_TTL` | 4s | client (receiver) | One second of slack over the throttle, so latency and jitter cannot make a continuously typing user's indicator flicker. |
| rate limit | 1 per 2s, burst 3 | server, per socket | The client throttle is advisory. This is the one that holds. |

A user typing continuously for a full minute emits **20 frames**, not one per keystroke. At ~50
bytes that is ~1 KB/min upstream, fanned out to one other participant in a 1:1 chat. The socket's
own keepalive ping is 1/min. Bandwidth is not the constraint at any scale this app will see.

**The hub goroutine is the constraint**, and the next section is about protecting it.

---

# Backend

## Kinds — append only

```go
KindTyping     // 6: client → server: {chat_id}
KindUserTyping // 7: server → the other participants: {chat_id, sender_id}
```

Two kinds, not one reused in both directions — the same split as
`KindSendMessage`/`KindNewMessage`, and for the same reason: `sender_id` is filled in by the server
from the authenticated socket. A single echoed kind invites a client to put someone else's id in
the field.

`Content` is ignored on an inbound typing frame. The indicator says *that* someone is typing, never
what — sending the draft would be a privacy change nobody asked for and a much larger frame.

> **Claim the number when you land, like the migrations.** Feature 3 (group chats) may also append
> kinds. The iota is positional and mirrored by every deployed frontend build, so renumbering one
> silently routes frames to the wrong handler in every tab still running the old bundle.

## Rate limiting — in `ReadPump`, before the hub

This is the single most important line in the feature:

```go
// internal/api/client.go, in ReadPump's loop, before c.Hub.Inbound <- …
if msg.Kind == KindTyping && !c.typing.allow() {
    continue
}
```

The hub is **one goroutine that every message in the process is serialized through**. A frame
dropped inside `handleInbound` has already cost a channel send, a hub scheduling slot, and a switch
— it has already done the damage. Dropping it on the abusive socket's own `ReadPump` goroutine
keeps the cost where it belongs and leaves the hub's throughput untouched by a flood.

A minimal token bucket on `Client`, needing no mutex because only `ReadPump` touches it:

```go
// typingLimiter is a token bucket sized so a well-behaved client (one frame per
// TYPING_THROTTLE) never sees it, while a client sending per-keystroke gets ~1
// frame in 30 through. Burst 3 absorbs the reconnect case, where a few frames
// can legitimately arrive close together.
type typingLimiter struct {
    tokens float64
    last   time.Time
}

const (
    typingRefillPerSec = 0.5 // 1 token per 2s
    typingBurst        = 3.0
)

func (l *typingLimiter) allow() bool {
    now := time.Now()
    if l.last.IsZero() {
        l.last = now
        l.tokens = typingBurst
    }
    l.tokens = math.Min(typingBurst, l.tokens+now.Sub(l.last).Seconds()*typingRefillPerSec)
    l.last = now

    if l.tokens < 1 {
        return false
    }
    l.tokens--
    return true
}
```

**Drop silently. Never answer an over-limit frame with `KindError`.** An error response turns one
abusive inbound frame into one outbound frame plus a client-side error render — the flood would be
amplified by the very thing meant to stop it, and it would hand an attacker a way to make the
server do more work than they do.

## No database on the typing path

`handleInbound`'s existing branch calls `chatService.ParticipantIDs` — a DB round trip — **on the
hub goroutine**. That is tolerable for messages: one query per message sent. It is not tolerable
for typing, which is 3–6× more frequent than messages by construction, and every one of those
queries would hold the hub while all real message traffic waits behind it.

So the hub gets a participant cache:

```go
// participantCache memoizes chat → participant ids. Owned by the hub goroutine
// like Clients, so it needs no mutex.
//
// Membership is immutable in this codebase: participants are written once, in
// the accept-invite transaction, and remove-friend deletes the chat outright
// rather than editing its roster. So a hit is correct by construction today,
// and the TTL exists only to bound the two things that outlive an entry — a
// deleted chat, and (once feature 3 lands) a roster that can change.
type participantCache struct {
    entries map[uuid.UUID]participantEntry
    ttl     time.Duration // 10 * time.Minute
}
```

- **Miss** → `ParticipantIDs`, populate, proceed. A miss costs exactly what today's message path
  costs, and only the first typing frame of a conversation pays it.
- **Use it for `KindSendMessage` too.** That removes a DB round trip per message from the hub, and
  keeps one code path rather than two views of the same fact.
- **Evict on `chat_id` when a chat is deleted.** Remove-friend already runs in an HTTP handler with
  the hub in reach; add a `Hub.ForgetChat(chatID)` queued the same way `NotifyUser` is. Without it,
  a removed friend could still receive typing frames for up to the TTL.

**Participation is still verified.** A typing frame whose `chat_id` the sender is not in must be
dropped — otherwise anyone could spray "someone is typing" into arbitrary conversations by guessing
chat ids. The check is `slices.Contains(participants, in.SenderID)` against the cached slice: a
handful of pointer comparisons, no I/O.

## Fan-out

```go
case KindTyping:
    participants, ok := h.participants(in.Msg.ChatID)   // cache; miss → DB
    if !ok || !slices.Contains(participants, in.SenderID) {
        return // not a participant, or the chat is gone: silently ignore
    }

    out := WSMessage{Kind: KindUserTyping, ChatID: in.Msg.ChatID, SenderID: in.SenderID}
    for _, userID := range participants {
        if userID == in.SenderID {
            continue // unlike KindNewMessage, there is no ack to deliver
        }
        h.sendEphemeral(userID, out)
    }
```

### `sendEphemeral` — never drop a client over a typing frame

`sendTo` drops the client when its 256-slot `Send` buffer is full, which is right for a message:
a client that cannot keep up with real data is broken and should reconnect. It is **wrong** for
typing. Killing someone's socket — and with it their live message delivery — because a "typing…"
hint could not be queued inverts the priority exactly.

```go
// sendEphemeral queues a frame the recipient can lose without noticing. A full
// buffer drops the frame, not the client: the indicator simply expires on the
// receiver, which is a state it is already built to handle.
func (h *Hub) sendEphemeral(userID uuid.UUID, m WSMessage) {
    c, ok := h.Clients[userID]
    if !ok {
        return
    }
    select {
    case c.Send <- m:
    default:
    }
}
```

This also means a backed-up client naturally sheds typing frames first and keeps its message
backlog — the degradation order you want, for free.

## What is deliberately not built

- **Persistence.** Typing state that survives a reload is not typing state.
- **A presence/online feature.** "Last seen" and the green dot are a different feature with a
  different lifetime, a different storage answer, and privacy implications typing does not have.
  The socket's connect/disconnect is not a good enough proxy for either.
- **Server-side timers.** No `time.AfterFunc` per typing user, no expiry goroutine, no sweep. The
  TTL lives entirely on the receiver, so the server holds **zero** typing state — it is a pure
  router for these frames, which is what makes them cheap.

## Acceptance criteria (backend)

- [ ] `kind: 6` from a participant fans out `kind: 7` with the correct `chat_id` and `sender_id`
      to the other participants only.
- [ ] The sender never receives their own `kind: 7`.
- [ ] `kind: 6` for a chat the sender is not in is silently ignored — no fan-out, no error frame.
- [ ] A client sending `kind: 6` per keystroke has the excess dropped in `ReadPump`, receives no
      error, and stays connected.
- [ ] Under that flood, message delivery for **other** users is unaffected — the hub never blocks
      on the abusive socket.
- [ ] No SQL runs on a typing frame after the chat's first one (cache hit).
- [ ] Removing a friend stops typing frames from reaching the removed user.
- [ ] A recipient with a full `Send` buffer loses the typing frame and **keeps its connection**.
- [ ] Nothing about typing is written to the database or returned by any REST endpoint.

---

# Frontend

## Sending — throttled inside the hook

`useChatSocket` gains `sendTyping`, and the throttle lives **in the hook, not the composer**, so
every call site is throttled by construction and no future caller can forget.

```ts
// Leading-edge, per chat: the first keystroke emits immediately (the indicator
// should appear as the other person starts, not 3s later), then at most one
// frame per interval while typing continues.
//
// NOT a trailing debounce — that fires when the user *stops*, which is the exact
// inverse of what the indicator means.
const TYPING_THROTTLE = 3_000

const lastTypingSent = useRef(new Map<string, number>())

const sendTyping = useCallback((chatId: string) => {
  const socket = socketRef.current
  if (!socket || socket.readyState !== WebSocket.OPEN) return

  const now = Date.now()
  const last = lastTypingSent.current.get(chatId) ?? 0
  if (now - last < TYPING_THROTTLE) return

  lastTypingSent.current.set(chatId, now)
  socket.send(JSON.stringify({ kind: WSKind.Typing, chat_id: chatId }))
}, [])
```

Two details that are easy to get wrong:

1. **Clear the entry for a chat when a message is sent in it.** Otherwise the throttle suppresses
   the first keystroke of the *next* sentence for up to 3s, and the indicator arrives late exactly
   when the conversation is liveliest.
2. **Never queue when the socket is closed.** A typing frame delivered after reconnection describes
   a moment that has passed. Drop it; `readyState` is the whole check.

`MessageComposer` calls it from the existing `onChange`, guarded on non-empty input:

```ts
onChange={(event) => {
  setDraft(event.target.value)
  resize()
  if (event.target.value.trim()) onTyping()
}}
```

Deleting back to an empty box sends nothing and cancels nothing — the lease lapses on its own.

## Receiving — `useTypingIndicator`

State is a `Map<chatId, Map<userId, timeoutId>>`, in a hook of its own.

**Not in the React Query cache.** Writing typing state into `queryKeys.chats` would re-render every
subscriber of the chat list on a timer, and would mix ephemeral state into the cache that read
receipts and pagination write to — one of them would eventually persist or refetch it away.

```ts
const TYPING_TTL = 4_000

// One timer per (chat, user). Each frame replaces the previous timer, so a
// continuously typing user renews rather than accumulating timers.
function onTyping(chatId: string, userId: string) {
  clearTimeout(timers.current.get(chatId)?.get(userId))
  const timer = setTimeout(() => remove(chatId, userId), TYPING_TTL)
  // …store timer, set state
}
```

It must clear on all four of these:

| Event | Why |
|---|---|
| TTL lapses | The only path that handles a closed tab, a dead socket, or a dropped frame. |
| `onNewMessage` from that sender in that chat | They just sent it; the instant, free cancellation. |
| Socket leaves `open` | The state is unverifiable while disconnected — showing a stale "typing…" through a reconnect is worse than showing nothing. |
| Unmount | `clearTimeout` every pending timer. |

Keying by user, not just by chat, costs nothing today (one other participant) and is what makes
this work unchanged when feature 3 lands and three people type at once.

## Rendering

**In the conversation** — a row below the last message, inside the scroll container so it sits with
the thread and scrolls into view like a message would:

```tsx
{isTyping && (
  <div role="status" aria-live="polite" className="px-4 pb-2">
    <span className="font-manrope text-[13px] text-gray-300">
      {name} is typing
      <span className="typing-dots" aria-hidden />
    </span>
  </div>
)}
```

Three dots animating with staggered `animation-delay` — a keyframe in `index.css` next to the
existing `animate-showContent`, not a JS timer. Respect `prefers-reduced-motion`: fall back to a
static "…".

`aria-live="polite"` announces once on appearance rather than on every frame, because the element
mounts and unmounts rather than re-rendering with new content.

**In the sidebar** — replace the last-message preview with `typing…` in `text-success-500`, the
project's existing live-state token (the connected-socket dot, the read tick). It reads as "live"
rather than as content, and it does not fight the unread pill, which stays exactly as feature 2
specifies:

```tsx
<p className={`truncate font-manrope text-[13px] ${
  typing ? 'text-success-500' : unread ? 'text-gray-100' : 'text-gray-300'
}`}>
  {typing ? 'typing…' : (chat.last_message ?? 'Say hello 👋')}
</p>
```

The preview is replaced rather than pushed aside: the row has no spare horizontal space at mobile
widths, and the last message is the thing typing is about to make stale anyway.

## Acceptance criteria (frontend)

- [ ] Typing in one tab shows "typing…" in the other user's conversation view **and** their sidebar
      row within ~1s.
- [ ] Typing continuously for 30s keeps the indicator up without flicker, and the network panel
      shows ~10 frames, not one per keystroke.
- [ ] Stopping typing hides the indicator within `TYPING_TTL`, with **no frame sent** to do it.
- [ ] Sending the message hides it immediately, not after the TTL.
- [ ] Closing the sender's tab mid-typing hides it within the TTL.
- [ ] Killing the receiver's connection while the indicator is up hides it, and it does not
      reappear on reconnect unless the sender is still typing.
- [ ] Typing in chat A while viewing chat B shows the indicator only on A's sidebar row.
- [ ] The indicator never appears for the user's own typing, in any view.
- [ ] Unread pills, read ticks, and previews behave exactly as feature 2 specifies while an
      indicator is showing.
- [ ] Deleting the draft back to empty sends nothing.
- [ ] No typing state appears in the React Query cache in devtools.
