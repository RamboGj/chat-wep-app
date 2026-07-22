---
name: react-chat-frontend
description: Build frontend features for this real-time chat app in React + TypeScript. Use whenever adding or changing UI, API clients, TanStack Query hooks, forms, routes, or WebSocket cache logic. Encodes the module-per-domain architecture, the apiFetch/ApiError contract, zod + react-hook-form validation, tailwind-variants styling, and the in-progress TanStack Router → React Router migration.
---

# react-chat-frontend

Conventions for the **chat app frontend** (Vite + React 19 + TypeScript). Every feature added
here MUST follow the structure and idioms below. The backend counterpart is the
**`go-chat-backend`** skill (`backend/.claude/skills/`); the two are designed to be read
together, because most of the bugs in this project live in the contract between them.

## When to use

Invoke this skill before writing or changing any frontend code: a new page, component, hook,
API call, form, route, or anything that folds WebSocket events into the query cache.

Read the relevant spec first. Feature specs live in **`specs/`** at the repo root (full-stack:
each file covers backend and frontend in one place). The specs define *what* to build; this
skill defines *how*.

## Stack

| Concern | Choice |
|---|---|
| Framework | React 19 (`react`, `react-dom`) |
| Build | Vite 8, `@vitejs/plugin-react` |
| Compiler | **React Compiler** enabled (`babel-plugin-react-compiler` via `@rolldown/plugin-babel`) |
| Language | TypeScript (strict), path alias `@/*` → `./src/*` |
| Routing | **Migrating: TanStack Router → React Router v7** (see below) |
| Server state | **TanStack Query v5** (`@tanstack/react-query`) — stays, only the *router* is replaced |
| Forms | react-hook-form + `@hookform/resolvers/zod` |
| Validation | **zod v4** |
| Styling | Tailwind CSS v4 (`@tailwindcss/vite`) + `tailwind-variants` (`tv`) |
| Icons | `lucide-react` |
| Formatting | Prettier (no semicolons, single quotes) + ESLint 10 |

The dev server proxies `/api` to the Go backend (`vite.config.ts`) with `changeOrigin: false`
and `ws: true`. **Do not "fix" `changeOrigin`** — preserving the `Origin` header is what lets
the backend's WebSocket upgrade check pass, and staying same-origin is what lets the httpOnly
auth cookies through without CORS.

## Project structure

```
frontend/src/
├── main.tsx                       # composition root: providers + RouterProvider
├── index.css                      # Tailwind v4 config + design tokens (CSS custom properties)
├── router.tsx                     # (target) createBrowserRouter route tree
├── routes/                        # (current) TanStack file-based routes + routeTree.gen.ts — being removed
├── lib/                           # cross-cutting, framework-level, domain-free
│   ├── api.ts                     # apiFetch + ApiError + the 401-refresh-retry
│   ├── query-client.ts            # the QueryClient singleton
│   ├── query-keys.ts              # every cache key in the app
│   └── format.ts                  # pure display helpers (initials, avatarColor, …)
├── types/api.ts                   # hand-written mirrors of the Go JSON shapes
├── utils/validation/              # zod schemas + form-error mapping
├── components/atoms/<Name>/<Name>.tsx   # domain-free, reusable primitives
└── modules/<domain>/              # one folder per domain: auth, chat, friends
    ├── api/<domain>-api.ts        # thin apiFetch wrappers, one exported object
    ├── hooks/use-<domain>.ts      # TanStack Query hooks
    ├── components/                # domain-specific components
    └── pages/                     # route-level components
```

**The module boundary is the rule that matters.** Anything specific to auth, chat, or friends
lives under `modules/<domain>/`. Anything domain-free and reusable is an atom or a `lib/`
helper. If a component in `modules/chat/` needs something from `modules/friends/`, that is a
signal the thing belongs in `components/` or `lib/` — not an invitation to import across
modules.

## Golden-path conventions (non-negotiable)

1. **Every request goes through `apiFetch`** (`@/lib/api`). Never call `fetch` directly for
   API routes. `apiFetch` sets `credentials: 'include'`, serializes the body, parses errors
   into `ApiError`, and — on a `401` — refreshes the access cookie once and retries. Auth
   endpoints pass `skipRefresh: true` so they don't recurse.

   The one legitimate exception is the direct-to-bucket image `PUT`, which is not an API route
   and needs `XMLHttpRequest` for upload progress.

2. **API modules are thin.** `modules/<domain>/api/<domain>-api.ts` exports a single object
   whose methods map 1:1 onto backend endpoints. They may unwrap an envelope
   (`.then((r) => r.chats)`) or reverse a page, but they hold no React and no cache logic.

3. **Every cache key comes from `queryKeys`** (`@/lib/query-keys`). Never inline a key array
   at a call site — the WebSocket handlers write to the same keys the queries read, and an
   inlined key that drifts by one segment fails silently as a stale UI, not an error.

4. **Server state is TanStack Query; local state is `useState`.** Do not mirror fetched data
   into component state. To update after a mutation, prefer `invalidateQueries`; use
   `setQueryData` when you have the authoritative new value (which is how every WebSocket
   event is applied).

5. **`types/api.ts` is hand-maintained and mirrors the Go structs.** Each interface carries a
   comment naming its Go source (`/** services.ChatSummary */`). Field names are the backend's
   `snake_case` — do **not** camelCase them; the wire format is the contract. When a spec adds
   a backend field, add it here in the same change.

6. **React Compiler is on — do not hand-write `useMemo` / `useCallback` / `memo` for
   performance.** The compiler handles memoization. `useCallback` is still correct when a
   function is a declared dependency of an effect (as in `use-chat.ts`), but never add one
   "to avoid re-renders."

7. **Atoms extend their native element's props.** `interface ButtonProps extends
   ComponentProps<'button'>`, spread `...rest` onto the element, and accept `className` so
   callers can adjust layout. Style with `tv()`; never build class strings by concatenation.

8. **The WebSocket echo is the only path a message takes into the cache.** The backend fans
   out to all participants *including the sender*, so a sent message returns over the socket
   and that echo doubles as the ack. Nothing is inserted optimistically for messages — adding
   an optimistic insert reintroduces a duplicate-reconciliation problem that currently does
   not exist. (Optimistic updates are fine elsewhere — e.g. zeroing an unread count.)

## Routing — migration in progress

The app is moving **from TanStack Router to React Router v7**. Until it lands, `src/routes/`
and `src/routeTree.gen.ts` are still live. The full migration plan is
[`specs/01-react-router-migration.md`](../../../../specs/01-react-router-migration.md).

When writing new routing code, target React Router:

- Import from **`react-router`**, not `react-router-dom`.
- Routes are a **code-defined array** in `src/router.tsx` via `createBrowserRouter` — no file
  conventions, no codegen, no `routeTree.gen.ts`.
- `useNavigate()` takes a **string**: `navigate('/auth')`, not `navigate({ to: '/auth' })`.
- Auth guards are **loaders** that `throw redirect('/auth')`.

**A `redirect()` must be thrown, never returned.** Returning it makes React Router treat the
`Response` as loader *data* and render the element anyway — the guard silently stops guarding,
and the failure looks like a rendering bug rather than an auth bug.

Loaders run outside React, so they cannot use hooks. Import the `queryClient` singleton from
`@/lib/query-client` and call `ensureQueryData(currentUserQueryOptions)` — this is exactly why
the client lives in its own module and why `currentUserQueryOptions` is exported from
`modules/auth/hooks/use-auth.ts` rather than being inlined in `useQuery`. One shared
`queryOptions` object means a route load and a component render never fire two `/auth/me`
requests.

See `references/routing.md`.

## Forms

Forms use **react-hook-form** with `zodResolver`, against a schema from
`@/utils/validation/`. Schemas are named `ZXxxSchema` and export their inferred type. Server
errors are mapped back onto fields with `requestFieldErrors` from
`@/utils/validation/form-errors`, which turns a `422` into per-field messages and anything
else into a `FORM_ERROR` banner.

> **Note the existing state:** `LoginForm.tsx` and `SignupForm.tsx` currently use manual
> `useState` + `safeParse` + `zodFieldErrors`, not react-hook-form, and `react-hook-form` is
> present in `node_modules` as a peer of `@hookform/resolvers` but is **not listed in
> `package.json`**. Before writing the first RHF form, run `npm i react-hook-form` so the
> dependency is declared. New forms should use RHF; migrate the two existing ones only when
> you are already touching them, not as a drive-by.

See `references/forms-and-validation.md`.

## Styling

Tailwind v4, configured in `src/index.css` via `@theme` — there is **no `tailwind.config.js`**.
Design tokens are CSS custom properties (`--color-brand-500`, `--color-gray-800`,
`--color-success-500`, `--color-error-500`, the `white-*` alpha ramp) exposed as Tailwind
utilities (`bg-brand-500`, `text-gray-300`). Fonts are `font-sora` (headings, buttons) and
`font-manrope` (body, labels).

**Always use a token, never a raw hex or an arbitrary value.** When a color must be passed to
an inline `style` (a dynamic border, a computed background), reference the variable:
`var(--color-gray-800)` — see `Avatar.tsx`.

Variants come from `tailwind-variants`. Use `slots` when a component styles more than one
element, and pass `className` through to the root slot so callers can adjust layout without
overriding appearance.

## Commands

```sh
npm run dev        # Vite dev server (proxies /api → localhost:3080)
npm run build      # tsc -b && vite build — typecheck is part of the build
npm run lint       # eslint
npm run format     # prettier --write .
npm run preview    # serve the production build
```

`npm run build` is the typecheck. Run it before declaring frontend work done — `npm run dev`
will happily run code that `tsc -b` rejects.

## Reference files

- `references/module-pattern.md` — adding a domain feature end-to-end, with a worked trace
  from Go handler to rendered component.
- `references/forms-and-validation.md` — zod schemas, react-hook-form + zodResolver, and
  mapping backend `422`s onto fields.
- `references/routing.md` — the React Router target shape, guard loaders, and the
  TanStack → React Router translation table.
- `references/realtime.md` — the socket lifecycle and the rules for folding events into the
  query cache.
