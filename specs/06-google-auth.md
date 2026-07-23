# Feature 6 — Google Auth

"Continue with Google" on the auth screen. One button that both signs up and signs in, sitting
alongside the existing email/password forms rather than replacing them.

The session it produces is **the project's own JWT pair** — Google authenticates the human, and
that is all it does. Nothing downstream of `/auth/google` knows or cares which provider minted the
identity: the same `access_token` / `refresh_token`, the same `AuthMiddleware`, the same
`Sec-WebSocket-Protocol` handshake on `/ws`.

## Flow: ID token, not authorization code

Google Identity Services renders the button in the browser, the user picks an account, and GIS
hands the page a signed **ID token** (a JWT). The page POSTs that token to `/auth/google`; the
backend verifies it against Google's public keys and trades it for our tokens.

The alternative — the server-side authorization-code redirect flow — is **rejected here**:

- It needs a **client secret**, a `/auth/google/callback` endpoint, and a way to get the minted
  tokens from that callback back into the SPA. The API is on Render and the app is on Vercel, so
  that hand-back is a cross-domain redirect carrying tokens in a fragment — the exact class of
  cross-registrable-domain plumbing that already cost this project its cookie auth
  (`backend/specs/00-overview.md`, decision #1).
- It buys access to Google APIs on the user's behalf. This app wants a name and an email.

The ID-token flow has **no secret anywhere** — the client ID is public by construction, since it
ships in the frontend bundle. Switch to the code flow only if the app ever needs to call a Google
API as the user (Calendar, Drive, offline access); nothing in the roadmap does.

## Identity model

`users` gains a nullable `google_id` (Google's `sub` claim — stable, opaque, and the only field
Google guarantees never changes), and `password_hash` **becomes nullable**, because a Google-only
account has no password to hash.

Three account shapes exist after this feature:

| `password_hash` | `google_id` | How it signs in |
|---|---|---|
| set | null | email + password (every account today) |
| null | set | Google only |
| set | set | either — a linked account |

### Linking rule

> A Google sign-in whose `email_verified` is **true** and whose email matches an existing user
> **links** to that user: the row's `google_id` is filled in and the existing session semantics
> continue unchanged.

Google's verified email is a strong claim — it means Google controls the mailbox or watched the
user prove they do. Refusing to link would strand anyone who signed up with `jo@gmail.com` and
password, then clicked the Google button expecting their chats: they would get either an error
they cannot act on, or a second account with a mangled username and none of their friends.

An **unverified** email links to nothing and creates nothing → `422`. Linking on an unverified
address would be an account takeover: anyone able to set that address on a throwaway Google
account would inherit the matching chat account.

## Known tensions

Flagged rather than buried — each is a deliberate acceptance:

1. **No nonce, so an ID token is replayable for its lifetime (~1h).** Anyone who captures the
   token in that window can exchange it for a session. Capturing it means reading the POST body
   over TLS or scripting the page — an attacker who can do either can already read the tokens out
   of `localStorage`. Closing it properly needs a server-issued nonce (an extra endpoint plus
   server state, in a service that has deliberately none), so it is not worth it here. See
   [below](#nonce) for the shape of the fix if the threat model changes.
2. **Usernames are derived, not chosen.** The username is how friends find each other
   (`POST /friends/invites` resolves by username), and a Google user gets `joao.rambo` or, on a
   collision, `joao.rambo2`. Acceptable; the alternative is a mandatory second step between the
   Google popup and the app. See [open questions](#open-questions).
3. **A Google-only user who tries the password form gets "invalid email or password."** Correct
   and non-enumerable, but unhelpful — the app knows perfectly well what is wrong and won't say.
   Making it say so would turn the login form into an account-existence oracle.
4. **The GIS button cannot be styled to match the project's `Button` atom.** Google's branding
   guidelines require their own button, and `renderButton` only exposes the options it exposes.
   The design accommodates it rather than fighting it.

---

# Backend

## Migration — `007_add_google_id_to_users.sql`

> **Take the next free number when you branch.** The overview reserves `007` for feature 4 and
> `008` for feature 3, but tern will not tolerate a gap — it aborts with `Missing migration N` if
> the sequence skips one, so `009` cannot be reserved ahead of them. `006` is the highest applied
> today, so this is `007` unless feature 4 lands first, in which case renumber to `008`. Nothing
> depends on the relative order.

```sql
-- Write your migrate up statements here
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT DEFAULT NULL;

-- Google's `sub` is the account identity. UNIQUE is what makes the "find the
-- user for this Google account" lookup total, and what makes two concurrent
-- first-time sign-ins collapse to one row instead of two.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_google_id ON users (google_id);

-- A Google-only account has no password to hash. Every read path must now
-- treat a NULL hash as "cannot authenticate by password" — see AuthenticateUser.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
---- create above / drop below ----
-- Rows created by Google sign-in have no password and cannot be represented
-- without the column being nullable, so the down migration deletes them. That
-- is a real data loss, and it is the only honest way back to NOT NULL.
DELETE FROM users WHERE password_hash IS NULL;
ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL;
DROP INDEX IF EXISTS uq_users_google_id;
ALTER TABLE users DROP COLUMN IF EXISTS google_id;
```

A partial index is unnecessary: Postgres unique indexes already ignore NULLs, so every
password-only account stays out of it for free.

After editing, regenerate:

```sh
sqlc generate -f ./internal/store/pgstore/sqlc.yml
```

**What regeneration changes:** `pgstore.User.GoogleID` arrives as `pgtype.Text` (nullable `TEXT`,
same as `Chat.Title` — the `sqlc.yml` overrides only cover uuid and timestamptz).
`PasswordHash` stays `[]byte`; sqlc maps `bytea` to `[]byte` whether or not it is nullable, so it
simply arrives `nil` for Google accounts and **nothing type-checks differently** — which is exactly
why the nil guard below has to be written by hand.

## Queries — `queries/users.sql`

The `::text` casts are load-bearing: without them sqlc infers the parameter from the nullable
column and hands the service `pgtype.Text` for values that are never null at the call site.

```sql
-- name: GetUserByGoogleID :one
SELECT id, username, email, created_at, updated_at
FROM users
WHERE google_id = sqlc.arg(google_id)::text;

-- Links an existing password account to a Google account. The google_id IS NULL
-- predicate makes this a no-op — zero rows, pgx.ErrNoRows — if the row was
-- linked to some other Google account in the meantime, rather than silently
-- rebinding it.
-- name: LinkGoogleAccount :one
UPDATE users
SET google_id = sqlc.arg(google_id)::text, updated_at = NOW()
WHERE id = sqlc.arg(id) AND google_id IS NULL
RETURNING id;

-- name: CreateGoogleUser :one
INSERT INTO users (username, email, google_id)
VALUES ($1, $2, sqlc.arg(google_id)::text)
RETURNING id;

-- name: UsernameExists :one
SELECT EXISTS (SELECT 1 FROM users WHERE username = $1);
```

`CreateUser` (password signup) is unchanged — it never mentions `google_id`, which defaults to
NULL.

## Verifier — `internal/googleauth/verifier.go`

A new package next to `jwtutils`, for the same reason `jwtutils` is not inside `services`: it is
token mechanics with a config of its own, wired in at `Api` construction, and the service layer
consumes an already-verified identity rather than a raw string.

```go
package googleauth

// Identity is the subset of the ID token this app acts on. Everything else
// Google sends (picture, locale, hd, given/family name) is deliberately dropped.
type Identity struct {
    Sub           string // stable Google account id → users.google_id
    Email         string
    EmailVerified bool
    Name          string // display name, used only to seed a username
}

type Verifier struct {
    ClientID string
}

var ErrInvalidToken = errors.New("invalid google id token")

// Verify checks the signature against Google's published keys and the aud, exp
// and iss claims. Every failure collapses to ErrInvalidToken, matching
// jwtutils.Parse — the caller must not be able to learn which check failed.
func (v Verifier) Verify(ctx context.Context, rawIDToken string) (Identity, error)
```

Use **`google.golang.org/api/idtoken`**:

```go
payload, err := idtoken.Validate(ctx, rawIDToken, v.ClientID)
```

`idtoken.Validate` fetches and caches Google's JWKS, verifies the signature, and checks `exp` and
`aud`. It does **not** promise to check the issuer, so check it explicitly — one line, and without
it a token minted by a different issuer for the same audience would pass:

```go
if payload.Issuer != "accounts.google.com" && payload.Issuer != "https://accounts.google.com" {
    return Identity{}, ErrInvalidToken
}
```

Claims come out as `map[string]any`; read them with comma-ok assertions and treat a missing or
wrong-typed `email` as `ErrInvalidToken` (an ID token without an email is not something this app
can act on):

```go
Sub:           payload.Subject,
Email:         claims["email"].(string),
EmailVerified: claims["email_verified"].(bool),
Name:          claims["name"].(string),   // may be absent; empty is fine
```

Hand-rolling JWKS fetching with `golang-jwt` is the alternative and is not worth it — key rotation,
caching, and `alg` confusion are exactly what this dependency has already got right. Do **not** use
the `tokeninfo` REST endpoint: it is a network round trip per sign-in and Google discourages it.

## Service — `UserService`

```go
// AuthenticateWithGoogle resolves a verified Google identity to a user, creating
// one if this is their first sign-in. The bool reports whether a row was created.
AuthenticateWithGoogle(ctx, id googleauth.Identity) (uuid.UUID, bool, error)
```

Order matters — `sub` first, email second:

1. **`GetUserByGoogleID(id.Sub)`** → hit ⇒ `(user.ID, false, nil)`. This is every sign-in after
   the first, and it is the only lookup that is correct when a user changes their Gmail address.
2. `!id.EmailVerified` ⇒ `ErrGoogleEmailUnverified`. Checked here rather than in the handler
   because it is a rule about who may become a user, not about the shape of the request. Step 1
   comes first deliberately: an already-linked account keeps working even if Google's verification
   state for the address later changes.
3. **`GetUserByEmail(id.Email)`** → hit ⇒ `LinkGoogleAccount(user.ID, id.Sub)`.
   `pgx.ErrNoRows` from the link (the row grew a different `google_id` between the two statements)
   ⇒ `ErrGoogleAccountConflict`. Otherwise `(user.ID, false, nil)`.
4. **Create.** Derive a username (below) and `CreateGoogleUser`. On `23505`, branch on
   `pgErr.ConstraintName`:
   - `uq_users_google_id` ⇒ a concurrent first sign-in won the race. Re-run step 1 and return its
     result. **Do not** return an error: both requests are the same user signing in twice.
   - `users_username_key` ⇒ another account took the username between the existence check and the
     insert. Retry with the next suffix.
   - `users_email_key` ⇒ `ErrGoogleAccountConflict` (a password account appeared for this email
     mid-flight).

New sentinel errors: `ErrGoogleEmailUnverified`, `ErrGoogleAccountConflict`.

No explicit transaction. Every step is a single statement, and the concurrent cases collapse onto
the unique indexes, which is a stronger guarantee than a transaction would give here — `BEGIN`
around a read-then-insert does not prevent the duplicate at `READ COMMITTED` anyway.

### Username derivation

Unexported helper in the service. Rules, in order:

1. Seed from the email local part (`jo.rambo@gmail.com` → `jo.rambo`), not from `name` — display
   names contain spaces, accents, and emoji, and are far more likely to collide.
2. Lowercase; drop everything outside `[a-z0-9._]`; collapse runs of `.` and trim them from the
   ends.
3. Empty result ⇒ `"user"`. Shorter than 3 ⇒ pad to 3 (the frontend's `ZSignUpSchema` sets that
   floor, so hand-made and derived usernames should agree). Truncate to **45**, leaving room for a
   suffix under the column's `VARCHAR(50)`.
4. `UsernameExists` ⇒ append `2`, `3`, … and re-check, up to 20 attempts, then fall back to the
   base plus 6 random hex characters. The loop is an optimisation, not the correctness boundary:
   the unique index and the `users_username_key` retry above are.

### `AuthenticateUser` must reject a NULL hash — required

This is not optional cleanup. `password_hash` is now nullable, and today's code passes it straight
to bcrypt:

```go
// internal/services/user_service.go, in AuthenticateUser, before the compare:
//
// A Google-only account has no password. bcrypt would return ErrHashTooShort
// here, which is not ErrMismatchedHashAndPassword and so falls through to a 500
// — and, worse, leaves the "can this identity authenticate by password?"
// question answered by a hash-format check instead of by an explicit rule.
if user.PasswordHash == nil {
    return uuid.UUID{}, ErrInvalidCredentials
}
```

## DTO — `internal/usecase/user/google_login.go`

```go
type GoogleLoginRequest struct {
    IDToken string `json:"id_token"`
}

func (req GoogleLoginRequest) Valid(ctx context.Context) validator.Evaluator {
    var eval validator.Evaluator
    eval.CheckField(validator.NotBlank(req.IDToken), "id_token", "this field cannot be blank")
    return eval
}
```

Nothing more. The token's structure is the verifier's business, and duplicating "looks like a JWT"
here would just be a second place to be wrong.

## Endpoint

| Method | Path | Auth | Body | Success |
|---|---|---|---|---|
| POST | `/api/v1/auth/google` | public | `{id_token}` | `200 {access_token, refresh_token, token_type, expires_in, created}` |

```json
{
  "access_token": "…",
  "refresh_token": "…",
  "token_type": "Bearer",
  "expires_in": 900,
  "created": true
}
```

The body is `handleLoginUser`'s, plus `created` — true only when this call inserted the row. The
client cannot compute it and the service already knows it. (The frontend ignores it today; it is
there for a welcome state and for knowing what happened when reading logs.)

**One endpoint, not a signup/login pair.** The browser cannot know whether the Google account is
already a user without asking, and an endpoint pair would make it ask — a round trip, plus a race
between the check and the act.

Errors:

| Cause | Status | Body |
|---|---|---|
| blank `id_token` | `422` | the validator's problems map |
| `googleauth.ErrInvalidToken` | `401` | `{"error":"invalid google credential"}` |
| `ErrGoogleEmailUnverified` | `422` | `{"error":"this google account has no verified email"}` |
| `ErrGoogleAccountConflict` | `409` | `{"error":"this email is already linked to a different account"}` |
| anything else | `500` | `{"error":"something went wrong"}` |

Route, next to the other public auth routes in `routes.go`:

```go
r.Post("/google", api.handleGoogleLogin)
```

`POST` and `Content-Type` are already in the CORS config — no middleware change. The handler mints
both tokens exactly as `handleLoginUser` does; factor the mint-and-encode tail out of both rather
than copying it.

## Wiring — `Api` and `main.go`

```go
// internal/api/api.go
type Api struct {
    // …existing
    Google googleauth.Verifier
}
```

```go
// cmd/api/main.go, in run()
clientID := os.Getenv("CHATAPP_GOOGLE_CLIENT_ID")
```

**Do not make it fatal when unset.** A missing `CHATAPP_JWT_SECRET` breaks every request and
rightly stops the process; a missing client ID breaks one optional button. Leave it empty, let
`Verify` fail closed (`idtoken.Validate` rejects everything against an empty audience), and log
one line at startup so an unconfigured deploy is visible:

```
google sign-in disabled: CHATAPP_GOOGLE_CLIENT_ID is not set
```

## Environment & Google Cloud Console

Add to `backend/.env.example` and `backend/render.yaml`:

```
CHATAPP_GOOGLE_CLIENT_ID=<id>.apps.googleusercontent.com
```

In `render.yaml` this is a plain `value:` — **not** `generateValue` or a secret. There is no client
secret in this flow at all, and the client ID ships in the frontend bundle by design.

In the Google Cloud Console, create an **OAuth 2.0 Client ID → Web application** and set
**Authorized JavaScript origins** to `http://localhost:5173` and the deployed frontend origin
(`https://chat-wep-app.vercel.app`). **Authorized redirect URIs stays empty** — the ID-token button
flow never redirects. The consent screen needs only the `email` and `profile` scopes, which GIS
requests implicitly.

<a id="nonce"></a>
### If the replay window ever matters

`google.accounts.id.initialize` accepts a `nonce`, which Google echoes into the ID token. Closing
tension #1 means a `GET /auth/google/nonce` that mints and stores a single-use value, and a
`Verify` that checks it — server state in a service that has none by design. Not built.

## Acceptance criteria (backend)

- [ ] First Google sign-in creates a user with `google_id` set, `password_hash` NULL, and a
      username derived from the email local part; response is `200` with `created: true`.
- [ ] Second sign-in with the same Google account returns the **same** `user_id`, `created: false`,
      and creates nothing.
- [ ] A Google account whose verified email matches an existing password account links to it: no
      new row, and the user's existing chats and friends are all present.
- [ ] `email_verified: false` returns `422` and writes nothing — no user, no link.
- [ ] A tampered, expired, or foreign-audience ID token returns `401`, and the response does not
      reveal which check failed.
- [ ] A Google-only user attempting `POST /auth/login` gets `400 {"error":"invalid email or
      password"}` — **not** a `500`.
- [ ] Tokens from `/auth/google` work on a protected route, on `/auth/refresh`, and on the `/ws`
      handshake, identically to `/auth/login` tokens.
- [ ] Two simultaneous first-time sign-ins for one Google account produce exactly one user row and
      two successful responses.
- [ ] A derived username that collides gets a numeric suffix; both accounts remain invitable by
      their exact usernames.
- [ ] `password_hash` and `google_id` appear in no response body.
- [ ] With `CHATAPP_GOOGLE_CLIENT_ID` unset the server starts, logs the disabled line, and
      `/auth/google` returns `401` rather than panicking.

---

# Frontend

## Environment

`frontend/.env.example` and `src/vite-env.d.ts`:

```ts
/** Google OAuth Web client ID. Same value as the API's CHATAPP_GOOGLE_CLIENT_ID —
 *  the backend checks it as the token's `aud`, so a mismatch fails every sign-in.
 *  Unset hides the Google button entirely. */
readonly VITE_GOOGLE_CLIENT_ID?: string
```

Inlined at build time, like `VITE_API_BASE_URL` — setting it in Vercel does nothing until the next
build.

While you are in `.env.example`: its current comments still describe httpOnly cookies and
`Access-Control-Allow-Credentials`, which have not been true since the bearer-token migration. Fix
them in this PR.

## Types — `src/types/google-gsi.d.ts`

GIS is loaded from Google's CDN, so it has no types of its own. Declare the three functions this
app calls rather than adding `@types/google.accounts` — the ambient surface is large and this is
the whole of it:

```ts
interface GoogleCredentialResponse {
  /** The ID token. This is what `POST /auth/google` wants. */
  credential: string
  select_by: string
}

interface GoogleIdConfiguration {
  client_id: string
  callback: (response: GoogleCredentialResponse) => void
  auto_select?: boolean
  cancel_on_tap_outside?: boolean
  ux_mode?: 'popup' | 'redirect'
}

interface GoogleButtonConfiguration {
  type?: 'standard' | 'icon'
  theme?: 'outline' | 'filled_blue' | 'filled_black'
  size?: 'small' | 'medium' | 'large'
  text?: 'signin_with' | 'signup_with' | 'continue_with'
  shape?: 'rectangular' | 'pill' | 'circle' | 'square'
  logo_alignment?: 'left' | 'center'
  width?: number
}

declare namespace google.accounts.id {
  function initialize(config: GoogleIdConfiguration): void
  function renderButton(parent: HTMLElement, options: GoogleButtonConfiguration): void
  function disableAutoSelect(): void
}
```

## Loading GIS — `src/lib/google-gsi.ts`

Inject the script on demand instead of putting it in `index.html`: the chat page is where users
spend their session and it has no use for it.

```ts
const SRC = 'https://accounts.google.com/gsi/client'

// Module-level, so two mounts (or React's double-invoked effects in dev) share
// one <script> and one load.
let loading: Promise<void> | null = null

export function loadGoogleScript(): Promise<void> {
  if (loading) return loading

  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SRC
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => {
      // Let a later mount retry: a blocked or flaky load should not disable the
      // button for the rest of the page's life.
      loading = null
      reject(new Error('failed to load Google Identity Services'))
    }
    document.head.appendChild(script)
  })

  return loading
}
```

## API + hook

```ts
// modules/auth/api/auth-api.ts
/** Signs in or signs up — the backend decides which, and reports it as `created`. */
google: (idToken: string) =>
  apiFetch<GoogleAuthTokens>('/auth/google', {
    method: 'POST',
    body: { id_token: idToken },
    skipRefresh: true,
  }),
```

```ts
// types/api.ts
export interface GoogleAuthTokens extends AuthTokens {
  /** True when this call created the account rather than signing in to one. */
  created: boolean
}
```

```ts
// modules/auth/hooks/use-auth.ts — same shape as useLogin, which it deliberately mirrors.
export function useGoogleAuth() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (idToken: string) => authApi.google(idToken),
    onSuccess: async (tokens) => {
      setTokens({ access: tokens.access_token, refresh: tokens.refresh_token })
      await queryClient.invalidateQueries({
        queryKey: queryKeys.currentUser,
        refetchType: 'all',
      })
    },
  })
}
```

`useLogout` gains one line, in the same `onSettled` that clears the tokens:

```ts
// Without this, GIS re-signs the user in on their next visit and "log out"
// visibly fails to hold.
window.google?.accounts.id.disableAutoSelect()
```

## Component — `modules/auth/components/GoogleAuthButton.tsx`

```
useEffect: loadGoogleScript()
  → google.accounts.id.initialize({ client_id, callback, auto_select: false })
  → google.accounts.id.renderButton(containerRef.current, {...})
```

Four things this component has to get right:

1. **The callback must not be a dependency.** GIS captures it at `initialize` time; re-running
   `initialize` on every render to keep it fresh would tear the button down mid-interaction. Keep
   the latest callback in a ref and have the registered function read `ref.current`.
2. **Clear the container before `renderButton`.** In development React invokes effects twice, and
   `renderButton` appends — you get two buttons. `container.innerHTML = ''` first.
3. **`width` is a number, and capped at 400.** There is no fluid mode. Measure the container with
   a `ResizeObserver` and re-render the button on change, clamped to `Math.min(width, 400)`. The
   `AuthPage` tab indicator already does exactly this measuring dance — follow it.
4. **Render nothing at all when `VITE_GOOGLE_CLIENT_ID` is unset**, including the divider. A
   button that cannot work is worse than no button.

Button options, chosen against the project's dark surfaces (`--color-gray-800` card on
`--color-gray-900`):

```ts
{
  type: 'standard',
  theme: 'filled_black',   // the only theme that doesn't glare on this card
  size: 'large',           // ~44px, matching the Button atom's py-3 height
  text: 'continue_with',   // reads correctly under both tabs — see placement
  shape: 'rectangular',    // rounded-lg is as close as GIS gets to the atom
  logo_alignment: 'left',
}
```

Errors from the mutation render below the button in the form's existing error style —
`role="alert" className="font-manrope text-error-500 text-sm"` — with `error.message` from
`ApiError`, so the `409` and the unverified-email `422` say something actionable. A failed script
load renders the same way: *"Google sign-in is unavailable right now."*

On success: `navigate('/')`, exactly as `LoginForm` does.

## Placement — `AuthPage`

The button goes in `AuthPage`, **below** `FORM_COMPONENT.get(currentTab)` — not inside `LoginForm`
and `SignupForm`.

Two reasons, and the first is a bug you would otherwise ship: the forms are swapped by
`FORM_COMPONENT.get(currentTab)`, so a button inside them is unmounted and re-rendered on every tab
switch, re-initializing GIS and re-creating its iframe each time. Second, "Continue with Google"
is genuinely one action — it signs up and signs in — so duplicating it per tab would misrepresent
it. `text: 'continue_with'` is the wording that stays honest under both tabs.

```tsx
{FORM_COMPONENT.get(currentTab)}

{/* Rendered once, outside the tab swap, so GIS initializes exactly once. */}
<GoogleAuthButton />
```

With a divider above it, in the muted token the sidebar already uses for secondary text:

```tsx
<div className="my-6 flex items-center gap-3">
  <div className="h-px flex-1 bg-white-08" />
  <span className="font-manrope text-xs text-gray-300">or</span>
  <div className="h-px flex-1 bg-white-08" />
</div>
```

## Not in scope

- **One Tap** (`google.accounts.id.prompt()`), the auto-shown sign-in card. It is a separate UX
  decision with its own FedCM behaviour, and the button works without it.
- **Avatars from `picture`.** The `Avatar` atom derives from the username, and adding a second
  source is feature 4's territory (storage, hotlinking, a URL that expires).
- **Setting a password on a Google-only account**, and **unlinking**. Both need `/auth/me`-scoped
  endpoints and a settings screen, neither of which exists.

## Acceptance criteria (frontend)

- [ ] The Google button renders on both tabs, does not flicker or re-mount when switching between
      them, and appears exactly once.
- [ ] Signing in with a new Google account lands on `/` as a logged-in user with a sensible
      username, in one interaction.
- [ ] Signing in with a Google account whose email matches an existing password account shows that
      account's chats and friends.
- [ ] An unverified-email account shows the backend's message, not a generic failure, and stays on
      `/auth`.
- [ ] Closing the Google popup without choosing leaves the page usable and shows no error.
- [ ] Logging out and returning to `/auth` does **not** silently sign the user back in.
- [ ] With `VITE_GOOGLE_CLIENT_ID` unset, the auth page renders exactly as it does today — no
      button, no divider, no console error.
- [ ] With the GIS script blocked (offline, or blocked in devtools), the email/password forms still
      work and the button area shows the unavailable message.
- [ ] After a Google sign-in, the WebSocket connects and messages arrive — the socket path is
      unaware of how the session started.

<a id="open-questions"></a>
## Open questions

- **Should a new Google user choose their username?** Auto-derivation gets them into the app in one
  click, at the cost of `joao.rambo2` for anyone unlucky. The alternative is a one-time
  "choose your username" step after the popup, or a rename endpoint later. Specified as
  auto-derive; flag if the sharing experience matters more than the click.
- **Should `/auth/me` report the provider?** A settings screen ("Connected: Google") would need it,
  and it is one more field on a response that has none of them. Left off until something renders it.
