# Feature 4 — Image Messages

Messages gain a `type` of `text` or `image`. For an image, `content` holds an object key in
Cloudflare R2 rather than message text, and the bubble renders the picture.

## Storage: why Cloudflare R2

The deployment constrains this more than anything else. **Render's free tier has an ephemeral
filesystem** — the disk is wiped on every deploy and on the sleep/wake cycle a free instance goes
through — so writing uploads next to the API is not an option at any price. Object storage is
mandatory.

| Option | Free tier | Egress | Verdict |
|---|---|---|---|
| **Cloudflare R2** | 10 GB, 1M writes/mo | **$0, always** | **Chosen** |
| Supabase Storage | 1 GB | metered | Fine, 10× less room |
| Vercel Blob | 1 GB | metered | Client uploads want a Vercel function to mint tokens — splits auth across two backends |
| Cloudinary | 25 credits/mo | metered | Best transforms; another vendor for a feature that needs none |
| Render disk | — | — | Not available on free; ephemeral |

R2 wins on two things. **Zero egress fees**, which matters because every chat scroll re-fetches
images and a metered plan turns a demo into a bill. And **S3 compatibility**, so it works with
`aws-sdk-go-v2` — no vendor SDK, and switching to S3/Minio later is a config change.

**Bytes never pass through the API.** The backend mints a presigned `PUT` and the browser uploads
straight to R2. A free Render instance has 512 MB of RAM and sleeps when idle; proxying a 5 MB
upload through it would be slow, would count against its bandwidth, and would risk the request
outliving a sleeping dyno.

```
browser ──POST /uploads/images──> API      (auth, validate, presign)
browser <───{upload_url, key}──── API
browser ──────PUT bytes──────────> R2      (direct; API not involved)
browser ──WS {type:"image", content:key}──> API ──> DB + fan-out
```

---

# Backend

## Migration — `007_add_type_to_messages.sql`

```sql
-- Write your migrate up statements here
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'text';

-- The set is closed and tiny; a CHECK keeps a typo from reaching the client as
-- a message that renders as neither text nor image.
ALTER TABLE messages ADD CONSTRAINT messages_type_valid
    CHECK (type IN ('text', 'image'));
---- create above / drop below ----
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_type_valid;
ALTER TABLE messages DROP COLUMN IF EXISTS type;
```

`DEFAULT 'text'` backfills every existing row correctly.

**A `CHECK`, not a Postgres `ENUM`.** An enum needs `ALTER TYPE … ADD VALUE` to extend, which
cannot run inside a transaction in older Postgres and gives sqlc a named type to map. A `TEXT`
column with a `CHECK` stays a Go `string` and is one migration to widen.

## Configuration

```
CHATAPP_R2_ACCOUNT_ID          # from the Cloudflare dashboard
CHATAPP_R2_BUCKET              # e.g. chatapp-images
CHATAPP_R2_ACCESS_KEY_ID       # R2 API token, Object Read & Write
CHATAPP_R2_SECRET_ACCESS_KEY
CHATAPP_R2_PUBLIC_BASE_URL     # https://images.example.com  (or the r2.dev URL)
```

Add to `.env.example` (with placeholder values and the comment block the file uses) and to
`render.yaml` as `sync: false` entries — they are account secrets and must not live in the repo.

Client construction, in `cmd/api/main.go` alongside the pool:

```go
cfg, err := config.LoadDefaultConfig(ctx,
    config.WithRegion("auto"),                       // R2 has no regions
    config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
        os.Getenv("CHATAPP_R2_ACCESS_KEY_ID"),
        os.Getenv("CHATAPP_R2_SECRET_ACCESS_KEY"),
        "",
    )),
)

s3Client := s3.NewFromConfig(cfg, func(o *s3.Options) {
    o.BaseEndpoint = aws.String(
        fmt.Sprintf("https://%s.r2.cloudflarestorage.com", accountID))
    o.UsePathStyle = true      // R2 does not do virtual-host style buckets
})
```

Dependencies: `aws-sdk-go-v2/config`, `aws-sdk-go-v2/credentials`, `aws-sdk-go-v2/service/s3`.

### R2 bucket setup (manual, one-off)

1. Create the bucket.
2. Enable public access — a custom domain in production, or the `r2.dev` URL for development.
   `r2.dev` is aggressively rate-limited and Cloudflare says not to use it in production.
3. **CORS policy** — without it the browser's `PUT` is blocked at preflight and the whole feature
   fails with an opaque network error:

```json
[{
  "AllowedOrigins": ["https://chat-wep-app.vercel.app", "http://localhost:5173"],
  "AllowedMethods": ["PUT"],
  "AllowedHeaders": ["Content-Type"],
  "MaxAgeSeconds": 3600
}]
```

Keep this list in step with `CHATAPP_ALLOWED_ORIGINS`. They are enforced by different systems and
will drift.

## Service — `internal/services/upload_service.go`

```go
const (
    MaxImageBytes  = 5 << 20  // 5 MiB
    presignExpiry  = 5 * time.Minute
)

var allowedImageTypes = map[string]string{
    "image/jpeg": "jpg",
    "image/png":  "png",
    "image/webp": "webp",
    "image/gif":  "gif",
}

type PresignedUpload struct {
    UploadURL string    `json:"upload_url"`
    ObjectKey string    `json:"object_key"`
    PublicURL string    `json:"public_url"`
    ExpiresAt time.Time `json:"expires_at"`
}

PresignImageUpload(ctx, userID uuid.UUID, contentType string, sizeBytes int64)
    (PresignedUpload, error)
    - contentType not in allowedImageTypes → ErrUnsupportedImageType
    - sizeBytes <= 0 || > MaxImageBytes    → ErrImageTooLarge
    - key := fmt.Sprintf("messages/%s/%s.%s", userID, uuid.New(), ext)
    - PresignPutObject{Bucket, Key: key, ContentType, ContentLength: sizeBytes}
```

Sentinel errors: `ErrUnsupportedImageType` → `422`, `ErrImageTooLarge` → `422`.

**Sign `ContentType` and `ContentLength`.** A presigned URL authorizes exactly the request it was
signed for: with both headers signed, R2 rejects an upload whose type or size doesn't match what
the API approved. Leave them unsigned and the 5 MB limit is a client-side suggestion and the
image-only restriction is decorative.

**Keys are user-scoped** (`messages/{user_id}/…`) so the send path can verify ownership with a
string prefix instead of a database round trip — see below.

## Message type validation

`MessageService.CreateMessage` takes a `msgType string` and validates by type:

```go
switch msgType {
case "", "text":
    msgType = "text"
    if strings.TrimSpace(content) == "" { return ErrEmptyMessage }

case "image":
    // The key must be one this sender was issued. Without this check any
    // authenticated user could reference another user's object key and post
    // their image into a chat they share.
    if !strings.HasPrefix(content, fmt.Sprintf("messages/%s/", senderID)) {
        return ErrInvalidImageRef
    }

default:
    return ErrInvalidMessageType
}
```

An empty `type` normalizes to `text` so an old client — or a hand-written frame — keeps working.

Note what this deliberately does **not** do: it never checks that the object actually exists in
R2. A `HeadObject` per message would put a network call on the hub goroutine, where every message
in the process is serialized. A key pointing at nothing renders as a broken image for one message;
a wedged hub takes down messaging for everyone.

New sentinels: `ErrInvalidImageRef`, `ErrInvalidMessageType`. Both map to `KindError` on the
socket, alongside the existing `ErrEmptyMessage` / `ErrNotParticipant` branches in
`Hub.handleInbound`.

`queries/messages.sql`: add `type` to `CreateMessage`'s insert column list and `RETURNING`, and to
`ListMessages`'s `SELECT`.

## MessageView

`type` is stored but the client wants a **URL**, and building
`{public_base}/{object_key}` on the client would mean shipping the bucket URL into the frontend
bundle and duplicating config across two deploys. So the API stops serializing `pgstore.Message`
directly:

```go
// services.MessageView is the single serialized shape for a message, over both
// REST and the socket. URL is derived, not stored: the object key in Content is
// the source of truth, so the bucket can move without rewriting message rows.
type MessageView struct {
    ID       uuid.UUID  `json:"id"`
    ChatID   uuid.UUID  `json:"chat_id"`
    SenderID uuid.UUID  `json:"sender_id"`
    Type     string     `json:"type"`
    Content  string     `json:"content"`
    URL      *string    `json:"url"`      // absolute image URL; nil when type == "text"
    SentAt   time.Time  `json:"sent_at"`
    ReadAt   *time.Time `json:"read_at"`  // feature 2
}

func NewMessageView(m pgstore.Message, publicBaseURL string) MessageView
```

`handleListMessages` maps its page through it. `Hub.handleInbound` builds the outbound
`KindNewMessage` from it too, so REST and the socket cannot drift — today they are two hand-built
shapes that happen to agree.

Storing the key rather than the full URL is what makes the public base URL a config value: moving
from `r2.dev` to a custom domain is an env change, not a data migration.

## Endpoint

| Method | Path | Auth | Body | Success |
|---|---|---|---|---|
| POST | `/api/v1/uploads/images` | ✔ | `{content_type, size_bytes}` | `200 {upload_url, object_key, public_url, expires_at}` |

```go
r.Route("/uploads", func(r chi.Router) {
    r.Use(api.AuthMiddleware)
    r.Post("/images", api.handlePresignImageUpload)
})
```

DTO in `internal/usecase/upload/presign_image.go`, implementing `validator.Validator` like every
other request type:

```go
type PresignImageRequest struct {
    ContentType string `json:"content_type"`
    SizeBytes   int64  `json:"size_bytes"`
}
```

## WebSocket envelope

`WSMessage` gains `Type string \`json:"type,omitempty"\``.

Client → server:

```json
{ "kind": 0, "chat_id": "<uuid>", "type": "image",
  "content": "messages/<user_id>/<uuid>.png" }
```

Server → participants (`kind: 1`) now carries `type` and `url`:

```json
{ "kind": 1, "id": "<uuid>", "chat_id": "<uuid>", "sender_id": "<uuid>",
  "type": "image", "content": "messages/<user_id>/<uuid>.png",
  "url": "https://images.example.com/messages/<user_id>/<uuid>.png",
  "sent_at": "2026-07-22T18:04:11Z", "read_at": null }
```

Text messages are unchanged apart from `"type": "text"`.

The 512-byte read limit in `ReadPump` is comfortable for a key of ~60 chars — no change needed.

## Chat list preview

Add `last.type AS last_message_type` to `ListChatsForUser`'s `SELECT` list, and
`LastMessageType string \`json:"last_message_type"\`` to `services.ChatSummary`. Everything else
in that query and struct is untouched — see overview decision D1.

Without it the sidebar renders a raw object key (`messages/8f2a…/c41b….png`) as the preview text
for any chat whose last message is an image, which leaks internal keys into the UI and reads as
corruption.

The column is `NULL` for a chat with no messages (it comes through the existing `LEFT JOIN`), so
type it as nullable and treat `nil` the same as `text` — the preview line already falls back to
"Say hello 👋" in that case.

## Privacy tradeoff

**Images in a public bucket are readable by anyone holding the URL, without authenticating.** The
keys contain a v4 UUID, so they are not enumerable, but this is security by unguessability. Chat
messages are private; their images are not quite. Accept it knowingly.

The hardened alternative is a **presigned GET**: keep the bucket private and have `MessageView`
mint a short-lived read URL per message. It fits neatly — `MessageView` is already computed per
request — with two costs. Every history fetch signs N URLs. And URLs expire, so a page left open
past the TTL shows broken images until it refetches, and browser caching across sessions is lost
because the URL changes every time.

For a portfolio chat app, public + UUID keys is the right call. If this ever holds real
conversations, switch — the object key in `content` is stable, so it is a serialization change and
not a data migration.

## Orphaned objects

A client can presign an upload, `PUT` the bytes, and never send the message — the object then has
no row referencing it and nothing will ever delete it. Bounded by the 5 MB cap and by requiring
authentication, so it is not an open door, but it does grow.

Not handled here. The cheap mitigation is an **R2 lifecycle rule** deleting objects under
`messages/` older than N days, but that would delete live images too, so it needs a staging prefix
(upload to `staging/`, copy to `messages/` on send) — more machinery than this feature warrants.
Revisit if storage actually grows.

## Acceptance criteria (backend)

- [ ] `POST /uploads/images` with a supported type and a size under the cap returns a presigned
      URL, and a `PUT` of matching bytes to it succeeds from the browser.
- [ ] An unsupported `content_type` (e.g. `application/pdf`) → `422`.
- [ ] `size_bytes` over 5 MiB → `422`.
- [ ] Uploading with a **different** `Content-Type` than was signed is rejected by R2.
- [ ] Uploading more bytes than the signed `Content-Length` is rejected by R2.
- [ ] Unauthenticated `POST /uploads/images` → `401`.
- [ ] A `kind: 0` frame with `type: "image"` and a key under the sender's own prefix persists a
      row with `type = 'image'` and fans out with an absolute `url`.
- [ ] A frame referencing **another user's** key → `KindError`, nothing persisted.
- [ ] A frame with an unknown `type` → `KindError`, nothing persisted.
- [ ] A frame with no `type` still persists as `text` — old clients keep working.
- [ ] An image message with whitespace content is **not** rejected as empty (the empty check
      applies to text only).
- [ ] `GET /chats/{id}/messages` returns `type` and `url` on every message; `url` is `null` for
      text.
- [ ] `GET /chats` reports `last_message_type` for the preview.

---

# Frontend

## Types

```ts
export type MessageType = 'text' | 'image'

export interface Message {
  id: string
  chat_id: string
  sender_id: string
  type: MessageType
  content: string
  url: string | null
  sent_at: string
  read_at: string | null   // feature 2
}
```

`use-chat-socket.ts`: add `type` and `url` to `WSMessage`, and pass them through in the
`WSKind.NewMessage` branch. Default `type` to `'text'` when absent, mirroring the backend.

## Upload flow (`MessageComposer`)

Add an attach button (paperclip, `lucide-react`) left of the textarea, driving a hidden
`<input type="file" accept="image/jpeg,image/png,image/webp,image/gif">`.

On file selection:

1. **Validate client-side first** — type in the allowed set, size ≤ 5 MiB. Reject with an inline
   message rather than round-tripping to be told no.
2. `POST /uploads/images` with `{content_type, size_bytes}`.
3. `PUT` the file to `upload_url` with `Content-Type` set to the **exact** value sent in step 2 —
   it is part of the signature, and a mismatch fails at R2 with a 403 that reads like a
   configuration bug.
4. On success, send the socket frame: `{kind: 0, chat_id, type: 'image', content: object_key}`.

Use `XMLHttpRequest` for step 3, not `fetch`. `fetch` has no upload progress event, and a 5 MB
upload on a phone needs a progress bar.

**Preview while uploading:** show the local file as a thumbnail strip *above* the composer with a
progress overlay and a cancel button — **not** as a pending bubble in the message list. This
preserves the invariant `use-chat.ts` documents: the server echo is the only path a message takes
into the cache, so there is nothing optimistic to reconcile or roll back. A failed upload clears
the strip and shows an error; the message list never held a message that didn't exist.

Revoke the `URL.createObjectURL` blob URL when the strip clears, or the file leaks for the life of
the tab.

Disable the attach button while `status !== 'open'` — the upload would succeed and the send would
silently drop.

## `MessageBubble`

Extract the bubble from `MessageList`'s map into
`modules/chat/components/MessageBubble.tsx`, taking the new `type` prop:

```ts
interface MessageBubbleProps {
  type: MessageType
  content: string
  url: string | null
  sentAt: string
  readAt: string | null
  mine: boolean
}
```

(Feature 3 later adds an optional `senderName` here for group sender labels. Don't add it now —
in a 1:1 chat there are exactly two senders and the alignment already says which is which.)

The wrapper, alignment, gradient/gray background, timestamp footer and read ticks are **shared** —
only the body switches on `type`. Keeping one bubble is what stops image and text messages
drifting apart visually.

For `type === 'image'`:

- `<img src={url}>` inside the bubble, `rounded-xl`, `max-h-80 w-auto`, `object-cover`.
- Tighter padding than a text bubble (`p-1`) so the image nearly fills it — a wide gradient border
  around a photo looks like a mistake.
- `loading="lazy"` and explicit sizing to keep scroll position stable as history loads.
- A `bg-gray-500` placeholder until `onLoad`, so the list doesn't jump.
- `onError` → an inline "Image unavailable" state. The backend never verifies the object exists,
  so this is a state the UI will genuinely reach.
- `alt` of `"Photo from {sender}"`.
- Click opens the full image (new tab is enough; a lightbox is not required).
- The timestamp/tick footer overlays the bottom-right of the image with a subtle scrim, rather
  than sitting below it.

## Sidebar preview

When `last_message_type === 'image'`, render `📷 Photo` instead of `last_message` — which holds an
object key and would otherwise render as `messages/8f2a…/c41b….png` in the preview line.

## Acceptance criteria (frontend)

- [ ] The attach button opens a file picker limited to image types.
- [ ] Selecting an image shows a local preview with upload progress before it is sent.
- [ ] Once uploaded, the image appears as a message bubble for both sender and recipient, live.
- [ ] The image survives a refresh (it is in history, not just in memory).
- [ ] A file over 5 MB is rejected client-side with a clear message and no request is made.
- [ ] A non-image file cannot be chosen, and is rejected if forced through.
- [ ] A failed upload clears the preview, shows an error, and adds nothing to the message list.
- [ ] The attach button is disabled while the socket is not open.
- [ ] A broken image URL renders the "unavailable" state, not a broken-image icon.
- [ ] The sidebar shows "📷 Photo" for a chat whose last message is an image.
- [ ] Text messages render exactly as they do today.
- [ ] Read ticks (feature 2) render on image messages the same as on text ones.
