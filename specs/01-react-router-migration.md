# Feature 1 — TanStack Router → React Router

Replace `@tanstack/react-router` with **React Router v7** at **strict behavioural parity**. No new
routes, no new guards, no change to what any screen renders. This is a dependency swap, and the
only way to review it is that nothing about the app changes.

Frontend only — the Go API is untouched.

## What exists today

File-based routing. `@tanstack/router-plugin/vite` scans `src/routes/` and generates
`src/routeTree.gen.ts`, which `main.tsx` feeds to `createRouter`.

| File | Path | Behaviour |
|---|---|---|
| `routes/__root.tsx` | — | Wraps `QueryClientProvider` + `<Outlet/>` + devtools |
| `routes/index.tsx` | `/` | `beforeLoad` guard → `ChatPage`; redirects to `/auth` when signed out |
| `routes/_authLayout.tsx` | — (pathless) | `beforeLoad` guard → redirects to `/` when **already** signed in |
| `routes/_authLayout/auth.tsx` | `/auth` | `AuthPage` |
| `routes/about.tsx` | `/about` | `<div>Hello from About!</div>` — scaffolding leftover |

Both guards call `queryClient.ensureQueryData(currentUserQueryOptions).catch(() => null)`, so the
guard and the page share one `/auth/me` fetch. `.catch(() => null)` deliberately treats an
unreachable API as signed out.

`useNavigate` is imported from `@tanstack/react-router` in exactly one place:
`modules/chat/pages/ChatPage.tsx` (post-logout redirect to `/auth`).

## Target

Programmatic route objects via `createBrowserRouter`, defined in one file. File-based routing is
dropped: five routes do not justify a codegen step, and `routeTree.gen.ts` is a generated artifact
currently committed to git.

### Packages

```sh
npm i react-router
npm rm @tanstack/react-router @tanstack/react-router-devtools @tanstack/router \
       @tanstack/router-plugin
```

Use **`react-router` v7**, not `react-router-dom` — v7 exports the DOM bindings from the main
package, and `react-router-dom` is a deprecated compatibility re-export.

`@tanstack/react-query` **stays**. Only the router is being replaced; the two are unrelated
despite the shared vendor name. Do not remove `@tanstack/react-query` or `query-client.ts`.

### Files

```
delete   src/routeTree.gen.ts
delete   src/routes/__root.tsx
delete   src/routes/_authLayout.tsx
delete   src/routes/_authLayout/auth.tsx
delete   src/routes/index.tsx
delete   src/routes/about.tsx          ← scaffolding; see "/about" below
create   src/router.tsx                ← the whole route tree
edit     src/main.tsx
edit     src/modules/chat/pages/ChatPage.tsx   ← one import line
edit     vite.config.ts                ← drop the tanstackRouter() plugin
create   frontend/vercel.json          ← SPA fallback; see "Deployment"
```

### `/about`

Delete it. It is unreferenced Vite-template scaffolding — nothing links to it and it renders a
placeholder string. If you would rather keep the route, port it verbatim; do not treat this
migration as the moment to build a real About page.

## Route tree

```tsx
// src/router.tsx
import { createBrowserRouter, Outlet, redirect } from 'react-router'
import { queryClient } from '@/lib/query-client'
import { currentUserQueryOptions } from '@/modules/auth/hooks/use-auth'
import { AuthPage } from '@/modules/auth/pages/AuthPage'
import { ChatPage } from '@/modules/chat/pages/ChatPage'

/** Shared by both guards: resolves the session, or null if there isn't one. */
async function loadUser() {
  // ensureQueryData shares the cache entry with useCurrentUser, so the guard
  // and the page never fetch /auth/me twice.
  return queryClient.ensureQueryData(currentUserQueryOptions).catch(() => null)
}

async function requireUser() {
  if (!(await loadUser())) throw redirect('/auth')
  return null
}

async function requireAnonymous() {
  // Someone already signed in has no business on the login screen.
  if (await loadUser()) throw redirect('/')
  return null
}

export const router = createBrowserRouter([
  {
    // Pathless layout: the MVP's __root.tsx, minus the devtools.
    element: <Outlet />,
    children: [
      { path: '/', loader: requireUser, element: <ChatPage /> },
      { path: '/auth', loader: requireAnonymous, element: <AuthPage /> },
    ],
  },
])
```

### Translation table

| TanStack | React Router | Note |
|---|---|---|
| `createFileRoute('/x')({...})` | a route object in the array | |
| `beforeLoad` | `loader` | RR has no separate pre-load hook; the guard *is* the loader |
| `throw redirect({ to: '/x' })` | `throw redirect('/x')` | RR's `redirect` returns a `Response`; it must still be **thrown**, not returned, from a guard that renders nothing |
| `_authLayout.tsx` (pathless) | a child route array under a `path`-less parent | |
| `createRouter({ routeTree })` | `createBrowserRouter([...])` | |
| `<RouterProvider router={router}/>` | same import from `react-router` | |
| `useNavigate()` → `navigate({ to: '/auth' })` | `navigate('/auth')` | object arg → string |
| `declare module` `Register` block | delete | RR v7 has no equivalent registration |

### `main.tsx`

Move `QueryClientProvider` **above** `RouterProvider`. In the MVP it sat inside the root route's
component; that worked, but loaders run outside React and already reach the module-level
`queryClient` directly, so nesting it under the router buys nothing and makes the provider
boundary harder to reason about.

```tsx
import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './lib/query-client'
import { router } from './router'

const rootElement = document.getElementById('root')!
if (!rootElement.innerHTML) {
  ReactDOM.createRoot(rootElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  )
}
```

The `!rootElement.innerHTML` check is a TanStack scaffolding artifact guarding against
double-mount. Harmless — keep or drop, but don't spend review time on it.

### `vite.config.ts`

Remove the `tanstackRouter({...})` plugin and its import. **Leave everything else alone** — the
`@` alias, the `/api` dev proxy with `ws: true` and `changeOrigin: false`, Tailwind, and the React
Compiler babel preset are all unrelated to routing and all load-bearing. In particular the proxy
comment about single-origin cookies still applies.

### `ChatPage.tsx`

One line:

```diff
-import { useNavigate } from '@tanstack/react-router'
+import { useNavigate } from 'react-router'
```

and inside `handleLogout`:

```diff
-      onSettled: () => navigate({ to: '/auth' }),
+      onSettled: () => navigate('/auth'),
```

## Loader semantics — the one real behavioural risk

TanStack's `beforeLoad` and React Router's `loader` both run on every navigation to the route, so
the guards are equivalent. The difference worth knowing:

- **A thrown `redirect()` must be thrown.** Returning it from the loader makes React Router treat
  the `Response` as loader *data* and render the element anyway — the guard silently stops
  guarding. This is the single most likely way to ship a broken migration that looks fine on a
  happy-path click-through.
- **Loaders block the first paint.** `ensureQueryData` resolves from cache after the first call,
  so this is one `/auth/me` round-trip on cold load — the same as today. No spinner is specified;
  matching the MVP means a brief blank frame, which is what TanStack did too.
- **`errorElement` is not specified.** A loader that throws something other than a `redirect`
  currently has no handler in either router. Out of scope; don't add one here.

## Deployment

`createBrowserRouter` uses the History API, so **every path must serve `index.html`**. The app is
on Vercel; a hard reload or a direct link to `/auth` 404s without a rewrite. Add:

```json
// frontend/vercel.json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

This is worth verifying against production even though the MVP has the same requirement — if
`/auth` currently survives a hard refresh on the deployed site, the fallback is already in place
via framework detection and this file is belt-and-braces.

The Vite dev server handles the fallback on its own; no dev-side change.

## Deferred — not in this spec

`ChatPage` keeps chat selection in `useState`, so the open conversation has no URL. Moving it to
`/chats/:chatId` is the obvious payoff of owning the router, and it would give feature 3 a
shareable group link for free. It is deliberately **excluded**: it changes `ChatPage`, the
sidebar, the mobile back button, and the empty state all at once, and bundling that with a
dependency swap makes both unreviewable. Do it as a follow-up.

## Acceptance criteria

- [ ] `npm ls @tanstack/react-router` reports nothing; `routeTree.gen.ts` is deleted and not
      regenerated by `npm run build`.
- [ ] `npm run build` (`tsc -b && vite build`) passes with no type errors.
- [ ] Signed out, visiting `/` redirects to `/auth`.
- [ ] Signed in, visiting `/auth` redirects to `/`.
- [ ] Logging in lands on the chat screen; logging out lands on `/auth`.
- [ ] With the API stopped, `/` redirects to `/auth` rather than hanging or erroring
      (`.catch(() => null)` preserved).
- [ ] `/auth/me` is requested **once** on a cold load of `/`, not twice — check the network tab;
      this is what `ensureQueryData` sharing the cache entry buys.
- [ ] Browser back/forward moves between `/` and `/auth` correctly.
- [ ] A hard refresh on `/auth` serves the app, both in `vite dev` and on the Vercel deployment.
- [ ] The WebSocket still connects and messages still arrive — the socket is opened by
      `ChatPage`, so a mount regression shows up here first.
