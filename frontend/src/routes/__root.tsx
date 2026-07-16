import { createRootRoute, Outlet } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { queryClient } from '../lib/query-client'

export function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
      <TanStackRouterDevtools />
    </QueryClientProvider>
  )
}

export interface RootRouteContext {
  queryClient: QueryClient
}

export const Route = createRootRoute({
  component: RootLayout,
})
