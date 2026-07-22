# Routing — React Router v7

The app is migrating **from TanStack Router to React Router**. The full plan, including
deletions, lives in [`specs/01-react-router-migration.md`](../../../../../specs/01-react-router-migration.md).
This file is the shape to write against.

Import from **`react-router`**. `react-router-dom` still resolves but is a legacy re-export;
mixing the two in one app gives you two copies of the router context and a "useNavigate may be
used only in the context of a Router" error that points nowhere useful.

## The route tree

Routes are a code-defined array in `src/router.tsx`. No file conventions, no codegen, no
`routeTree.gen.ts`.

```tsx
import { createBrowserRouter, Outlet, redirect } from 'react-router'
import { queryClient } from '@/lib/query-client'
import { currentUserQueryOptions } from '@/modules/auth/hooks/use-auth'
import { AuthPage } from '@/modules/auth/pages/AuthPage'
import { ChatPage } from '@/modules/chat/pages/ChatPage'

async function requireUser() {
  const user = await queryClient.ensureQueryData(currentUserQueryOptions)
  if (!user) throw redirect('/auth')
  return null
}

async function requireAnonymous() {
  const user = await queryClient.ensureQueryData(currentUserQueryOptions)
  if (user) throw redirect('/')
  return null
}

export const router = createBrowserRouter([
  {
    element: <Outlet />,
    children: [
      { path: '/', loader: requireUser, element: <ChatPage /> },
      { path: '/auth', loader: requireAnonymous, element: <AuthPage /> },
    ],
  },
])
```

### Three things that will bite

**1. A `redirect()` must be thrown, never returned.** Returning it makes React Router treat the
`Response` as loader *data* and render the element anyway. The guard silently stops guarding,
and it presents as a rendering bug rather than an auth bug — the protected page just appears
for logged-out users.

**2. Loaders run outside React.** No hooks. Import the `queryClient` singleton from
`@/lib/query-client` directly — this is why it lives in its own module rather than being
created in `main.tsx`.

**3. Use `ensureQueryData`, not `fetchQuery`.** `ensureQueryData` returns the cached value when
it is fresh; `fetchQuery` always hits the network, so every navigation would re-request
`/auth/me`. The `staleTime` on `currentUserQueryOptions` only does its job with `ensureQueryData`.

Because `currentUserQueryOptions` is shared, the loader's fetch populates the same cache entry
`useCurrentUser()` reads — the guard and the component never issue two requests for the same
answer.

## Providers

`QueryClientProvider` must sit **above** `RouterProvider`. Loaders use the imported singleton
so they work either way, but components rendered by routes need the provider above them.

```tsx
import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@/lib/query-client'
import { router } from './router'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
```

The TanStack setup had no `QueryClientProvider` in `main.tsx` at all. Adding it is part of the
migration, not an optional extra — without it every `useQuery` throws.

Note also that the `declare module '@tanstack/react-router'` type-registration block goes away;
React Router needs no equivalent.

## Translation table

| TanStack Router | React Router |
|---|---|
| `createRouter({ routeTree })` | `createBrowserRouter([...])` |
| file in `src/routes/` | an object in the `router.tsx` array |
| `createFileRoute('/path')({ … })` | `{ path: '/path', element: … }` |
| `beforeLoad` (guard) | `loader` (guard) |
| `throw redirect({ to: '/auth' })` | `throw redirect('/auth')` |
| `navigate({ to: '/auth' })` | `navigate('/auth')` |
| `navigate({ to: '/c/$id', params: { id } })` | `navigate(\`/c/${id}\`)` |
| `Route.useParams()` | `useParams()` |
| `Route.useSearch()` | `useSearchParams()` |
| `<Link to="/x" />` | `<Link to="/x" />` (unchanged) |
| `component:` | `element:` (a JSX element, not a component reference) |
| `routeTree.gen.ts` | deleted |
| `tanstackRouter()` vite plugin | removed from `vite.config.ts` |

`element:` takes **`<ChatPage />`**, not `ChatPage`. Passing the reference renders nothing and
throws no error.

## Search params

React Router has no typed search-param parsing. `useSearchParams` returns a
`URLSearchParams` — values are `string | null` and must be parsed and validated at the call
site. If a route grows non-trivial params, validate them with a zod schema from
`utils/validation/` rather than hand-rolling checks.

## Deployment

An SPA on a static host needs every path rewritten to `index.html`, or a hard refresh on
`/auth` 404s. `frontend/vercel.json`:

```json
{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
```

## Deliberately not done yet

Chat selection stays in `ChatPage` component state — it does **not** move to `/chats/:chatId`.
That is a UX change (deep-linkable chats, back-button history) and belongs in its own change,
not smuggled into a dependency swap. Keeping the migration to strict behavioural parity is what
makes it reviewable: if anything about navigation looks different afterwards, it is a bug.
