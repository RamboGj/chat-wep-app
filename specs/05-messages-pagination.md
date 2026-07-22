# Feature 5 — Message History Pagination

A chat opens on its **latest 20 messages**. Scrolling to the top of the list loads the previous
20 and prepends them, with a small spinner while the page is in flight. Repeat until history runs
out.

Today `GET /chats/{id}/messages` is called with no arguments, so a chat with 40 000 messages
serializes 50 of them — the default limit already caps the response. What is missing is not the
cap; it is the **ability to go back past it**. The frontend has no cursor, no accumulation, and no
trigger, so everything older than the first page is currently unreachable in the UI.

## Scope

**This is a frontend-only feature.** The backend cursor API already exists and is correct. The
backend section below is a verification pass and a documented limitation, not a work list.

## Where it should land in the order

**Before read receipts (feature 2), if both are still open.** Pagination changes the *shape* of
the cached message list from `Message[]` to `InfiniteData<Message[]>`, and feature 2 adds a new
`setQueryData` handler over that same list. Landing pagination first means that handler is written
once, against the final shape.

If feature 2 is already in flight, land it and take the small rewrite — the ripple is mechanical
and [enumerated below](#every-write-to-the-message-cache-has-to-move).

---

# Backend

## Nothing to build

The endpoint is already a keyset-paginated cursor API:

| Param | Type | Default | Meaning |
|---|---|---|---|
| `before` | RFC3339Nano | `time.Now()` | exclusive upper bound on `sent_at` |
| `limit` | int | `50` (`DefaultMessageLimit`), clamped to `100` | page size |

```sql
-- name: ListMessages :many
SELECT id, chat_id, sender_id, content, sent_at
FROM messages
WHERE chat_id = $1
  AND sent_at < $2
ORDER BY sent_at DESC
LIMIT $3;
```

`ORDER BY sent_at DESC` + `idx_messages_chat_sent` on `(chat_id, sent_at DESC)` means each page is
an index range scan whose cost is proportional to the **page**, not to the history behind it. This
is the property that makes the feature worth having, and it is already true — **no migration, no
new index, no query change.**

`limit = 20` passes the clamp untouched (`0 < 20 <= 100`). `DefaultMessageLimit` stays at `50`: it
is the answer for a client that names no page size, and the frontend is about to always name one.
Lowering it to 20 would couple a server default to one client's scroll UX for no gain.

## Known tension — the cursor is `sent_at` alone

`sent_at < $2` is exclusive on a timestamp, not on `(sent_at, id)`. If two messages in one chat
share an identical `sent_at` **and** a page boundary falls between them, the second is skipped and
never appears — no error, just a message missing from history.

`timestamptz` is microsecond-precision, and two messages collide only if two separate requests
insert into the same chat within the same microsecond. Accepted as-is. The fix, if it ever matters,
is a compound cursor:

```sql
WHERE chat_id = $1 AND (sent_at, id) < ($2, $3)
ORDER BY sent_at DESC, id DESC
```

which needs the index rebuilt as `(chat_id, sent_at DESC, id DESC)` and a second cursor param
threaded through the handler, service, and client. **Not in scope** — it is a real correctness
improvement, but it is unreachable in this application's write pattern and would double the size of
the cursor contract.

## Acceptance criteria (backend)

Verification only — all of these should already pass:

- [ ] `GET /chats/{id}/messages?limit=20` returns at most 20, newest-first.
- [ ] `GET /chats/{id}/messages?before=<sent_at of the oldest returned>&limit=20` returns the 20
      immediately older, with **no overlap** against the previous page.
- [ ] Paging past the beginning of history returns `{"messages": []}` and `200`, not an error.
- [ ] `before` in a non-RFC3339 format returns `400`.
- [ ] `EXPLAIN` on the paged query shows an index scan on `idx_messages_chat_sent`, and its cost
      does not grow as the cursor walks backwards.

---

# Frontend

## The page size

```ts
// src/modules/chat/hooks/use-chat.ts
export const MESSAGE_PAGE_SIZE = 20
```

One constant, exported, used in **both** the request and the has-more test. They have to be the
same number for the feature to work at all — see the failure mode under
[`getPreviousPageParam`](#pages-are-previous-not-next).

## `useMessages` becomes an infinite query

`chatApi.listMessages` already takes `{ before, limit }` and already reverses each page to
oldest-first for rendering. It needs no changes.

```ts
import { useInfiniteQuery } from '@tanstack/react-query'

export function useMessages(chatId: string | null) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.messages(chatId ?? ''),
    queryFn: ({ pageParam }) =>
      chatApi.listMessages(chatId as string, {
        before: pageParam,
        limit: MESSAGE_PAGE_SIZE,
      }),
    enabled: Boolean(chatId),

    // `undefined as string | undefined` and not plain `undefined`: without the
    // annotation TS infers the page param as literally `undefined` and then
    // rejects the string returned by getPreviousPageParam.
    initialPageParam: undefined as string | undefined,

    // A full page means there is probably another one behind it. The cursor is
    // the oldest message we hold — pages arrive oldest-first, so that is [0].
    getPreviousPageParam: (firstPage) =>
      firstPage.length === MESSAGE_PAGE_SIZE ? firstPage[0].sent_at : undefined,

    // Nothing pages forward: newer messages arrive over the socket.
    getNextPageParam: () => undefined,
  })

  return {
    messages: query.data?.pages.flat() ?? [],
    isLoading: query.isPending,
    hasOlder: query.hasPreviousPage,
    isLoadingOlder: query.isFetchingPreviousPage,
    loadOlder: query.fetchPreviousPage,
  }
}
```

The hook returns a **narrow named surface** rather than the raw query object. `ChatPage` currently
destructures `{ data: messages = [], isLoading }`; the call site changes to
`{ messages, isLoading, hasOlder, isLoadingOlder, loadOlder }` and `MessageList` receives the last
three as props.

### Pages are `previous`, not `next`

This is the decision the rest of the feature rests on. TanStack Query **prepends** pages fetched
via `fetchPreviousPage` to `data.pages`, and appends those from `fetchNextPage`. Older messages are
therefore `previous`:

```
data.pages = [ oldest page, …, newest page ]
                                    ↑ page 0, the initial fetch
data.pages.flat()  →  chronological order, free
```

Modelling older-as-`next` also works, but leaves `pages` reverse-chronological, so every read
becomes `[...pages].reverse().flat()` and every write has to remember which end is which. Getting
that backwards renders the conversation upside down — a bug that looks like a CSS problem.

**Never set `maxPages`.** It silently evicts pages from the far end, so scrolling up far enough
would start dropping the newest messages — the ones the socket is still writing to.

### The has-more rule

`firstPage.length === MESSAGE_PAGE_SIZE` is exactly the requirement's "refetch if the latest result
length is the PAGE_SIZE of 20", and `hasPreviousPage` is `getPreviousPageParam(...) !== undefined`,
so the rule needs no separate state.

Two consequences worth knowing:

- **The request must send `limit` explicitly.** Omit it and the backend applies its default of 50;
  a 50-message page is never `=== 20`, `hasPreviousPage` is permanently `false`, and the sentinel
  silently never fires. There is no error anywhere — the feature just does not work.
- **A chat with a history that is an exact multiple of 20 costs one wasted request** returning
  `[]`, which then correctly sets `hasPreviousPage` to `false`. Distinguishing that case needs a
  total count or an `has_more` flag on the response; not worth an extra column in the payload for
  one request at the end of a scroll.
- **Pass `sent_at` through verbatim.** Go marshals `time.Time` as RFC3339**Nano**, so the string
  carries microseconds. Round-tripping it through `new Date(m.sent_at).toISOString()` truncates to
  milliseconds, which moves the cursor *backwards* by up to 999µs and can skip messages that fall
  in the gap. The string from the API is already the correct cursor — do not reformat it.

## Every write to the message cache has to move

The cached value is now `InfiniteData<Message[]>`, not `Message[]`. **Nothing enforces this** —
`setQueryData<Message[]>` still compiles against the same key, writes a bare array over the
`InfiniteData` object, and the list goes blank on the next render. Every message-cache write must
be updated in the same change.

Add one helper and route the page-agnostic writes through it:

```ts
import type { InfiniteData } from '@tanstack/react-query'

/** Applies `update` to every loaded page of a chat's history. */
function updateMessagePages(
  queryClient: QueryClient,
  chatId: string,
  update: (page: Message[]) => Message[],
) {
  queryClient.setQueryData<InfiniteData<Message[]>>(
    queryKeys.messages(chatId),
    (current) => current && { ...current, pages: current.pages.map(update) },
  )
}
```

The append in `applyMessage` is the one write that is **not** page-agnostic — an inbound message is
the newest, so it belongs on the last page:

```ts
queryClient.setQueryData<InfiniteData<Message[]>>(
  queryKeys.messages(message.chat_id),
  (current) => {
    if (!current || current.pages.length === 0) return current

    // Idempotency now has to span pages, not just one array.
    if (current.pages.some((page) => page.some((m) => m.id === message.id))) return current

    const pages = current.pages.slice()
    pages[pages.length - 1] = [...pages[pages.length - 1], message]
    return { ...current, pages }
  },
)
```

`pages[pages.length - 1]` is the newest page because page 0 is the *initial* fetch and every
`fetchPreviousPage` prepends. The chats-list half of `applyMessage` is untouched.

### Call sites to update

| Site | Change |
|---|---|
| `applyMessage` (`use-chat.ts`) | append to the last page, as above |
| `applyMessagesRead` (feature 2) | wrap in `updateMessagePages` |
| any `getQueryData<Message[]>(queryKeys.messages(…))` | now `InfiniteData<Message[]>` |
| `useMarkChatRead().onSuccess` (feature 2) | see below |

Feature 2's `invalidateQueries({ queryKey: queryKeys.messages(chatId) })` still *works* — TanStack
refetches every loaded page — but it now costs one request per page held. Since the read push
already carries everything needed, prefer the `updateMessagePages` write and drop the invalidation.
Feature 4 (image messages) needs no changes here: it changes what a `Message` contains, not how the
list is paged.

## The trigger — a sentinel at the top

A 1px sentinel inside the scroll container, watched by an `IntersectionObserver` rooted on that
container.

```tsx
const scrollRef = useRef<HTMLDivElement>(null)
const sentinelRef = useRef<HTMLDivElement>(null)

useEffect(() => {
  const sentinel = sentinelRef.current
  const root = scrollRef.current
  if (!sentinel || !root || !hasOlder || isLoadingOlder) return

  const observer = new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting) loadOlder()
    },
    // Fire a little before the true top so the page is usually already in
    // flight by the time the user gets there.
    { root, rootMargin: '120px 0px 0px 0px' },
  )

  observer.observe(sentinel)
  return () => observer.disconnect()
}, [hasOlder, isLoadingOlder, loadOlder])
```

`isLoadingOlder` in the dependency list is what stops a burst: while a page is in flight the
observer is torn down entirely, so a sentinel that stays on screen cannot fire again. It is
re-attached when the fetch settles, and by then the prepended page has pushed it out of view.

An `IntersectionObserver` and not a scroll handler: no listener firing on every frame, no
`scrollTop < threshold` arithmetic, and it self-corrects when a short history leaves the sentinel
visible with the list already at rest — it just fires again and loads the next page, which is the
right behaviour.

## Keeping the scroll position

Prepending 20 messages grows `scrollHeight` above the viewport while `scrollTop` stays put, so the
content under the user's eyes jumps down by the height of the new page. Correct this in a
**layout** effect, before paint:

```tsx
const prevHeightRef = useRef(0)

// Runs when the fetch starts, capturing the height to restore against.
useEffect(() => {
  if (isLoadingOlder && scrollRef.current) {
    prevHeightRef.current = scrollRef.current.scrollHeight
  }
}, [isLoadingOlder])

useLayoutEffect(() => {
  const el = scrollRef.current
  if (!el || prevHeightRef.current === 0) return

  el.scrollTop += el.scrollHeight - prevHeightRef.current
  prevHeightRef.current = 0
}, [messages.length])
```

`useLayoutEffect`, not `useEffect` — a plain effect runs after paint, so the user sees one frame of
the jump before the correction.

**Give the spinner row a fixed height that does not change.** If the top row is 1px while idle and
40px while loading, that 39px lands inside the `scrollHeight` delta and the correction overshoots.
Render a constant-height row (`h-10`) that holds the sentinel and swaps a spinner in and out of it:

```tsx
<div className="flex h-10 shrink-0 items-center justify-center">
  <div ref={sentinelRef} className="h-px w-full" />
  {isLoadingOlder && <Spinner />}
</div>
```

Keep the row mounted whenever the list is non-empty, including after `hasOlder` goes false —
unmounting it removes 40px from the top of the content at exactly the moment the user is looking at
the top of the content.

## The auto-scroll effect is currently wrong for this

`MessageList` follows the conversation with:

```tsx
useEffect(() => {
  bottomRef.current?.scrollIntoView({ block: 'end' })
}, [messages.length])
```

`messages.length` changes when older messages are **prepended**, so every page load would yank the
user from the top of the history back to the bottom — the feature would appear completely broken
while every individual piece worked. Key the effect on the identity of the newest message instead:

```tsx
const lastMessageId = messages.at(-1)?.id

useEffect(() => {
  bottomRef.current?.scrollIntoView({ block: 'end' })
}, [lastMessageId])
```

A prepend does not change the last message, so the effect does not run. An arriving message does,
so it still follows the conversation. Switching chats does too, so a chat still opens at the
bottom. **This one-line change is the difference between the feature working and not.**

## Loading states

Three distinct states, and they must not be conflated:

| State | Source | UI |
|---|---|---|
| First page loading | `isLoading` (`isPending`) | the existing full-pane "Loading messages…" |
| Older page loading | `isLoadingOlder` | small spinner in the fixed top row |
| Nothing older left | `!hasOlder` | empty top row, no affordance |

`isPending` is `true` only while there is no data at all, so it never fires for a prepend and the
message list is never replaced by the full-pane loader mid-scroll.

The spinner is a small brand-coloured ring — `size-4`, `border-2`, `border-brand-400`,
`border-t-transparent`, `animate-spin` — using the existing brand token. No new dependency, no
skeleton: the row is 40px and the wait is one request.

## Switching chats

Nothing to reset. `queryKeys.messages(chatId)` puts each chat's pages under its own key, so
selecting another chat reads a different `InfiniteData` and opens on its latest 20. Returning to a
chat whose history was already scrolled back re-renders every loaded page from cache, still
scrolled — which is the behaviour you want, and it is free.

## Acceptance criteria (frontend)

- [ ] Opening a chat requests exactly one page with `limit=20` and renders the newest 20, scrolled
      to the bottom.
- [ ] Scrolling to the top loads the previous 20 and prepends them.
- [ ] **The message under the cursor does not move when a page is prepended.**
- [ ] A spinner shows in a fixed-height row at the top while an older page is loading, and the
      message list is not replaced by the full-pane loader.
- [ ] Scrolling up repeatedly walks back through the whole history, one page per pass.
- [ ] Reaching the beginning stops: no spinner, no further requests, no request loop at the top.
- [ ] A chat with fewer than 20 messages issues exactly one request and never shows the spinner.
- [ ] Pages do not overlap and no message is duplicated across a page boundary.
- [ ] A message arriving over the socket appends to the bottom while older pages are loaded, and
      still scrolls the view down.
- [ ] A socket message for a chat whose history is scrolled back does not clear the loaded pages.
- [ ] Switching chats and switching back preserves the loaded pages and the scroll position.
- [ ] Holding the sentinel on screen (a very short viewport) does not fire overlapping requests —
      the network tab shows one request per page, never a burst.
