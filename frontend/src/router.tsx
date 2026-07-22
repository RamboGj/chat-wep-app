import { createBrowserRouter, Outlet, redirect } from 'react-router'
import { queryClient } from '@/lib/query-client'
import { currentUserQueryOptions } from '@/modules/auth/hooks/use-auth'
import { AuthPage } from '@/modules/auth/pages/AuthPage'
import { ChatPage } from '@/modules/chat/pages/ChatPage'

/** Shared by both guards: resolves the session, or null if there isn't one. */
async function loadUser() {
  // ensureQueryData shares the cache entry with useCurrentUser, so the guard
  // and the page never fetch /auth/me twice.
  return queryClient
    .ensureQueryData(currentUserQueryOptions)
    .catch(() => null) // API unreachable: treat as signed out
}

async function requireUser() {
  // redirect() returns a Response — it has to be thrown, not returned, or the
  // router treats it as loader data and renders the element anyway.
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
