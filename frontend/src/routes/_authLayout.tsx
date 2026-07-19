import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { queryClient } from '@/lib/query-client'
import { currentUserQueryOptions } from '@/modules/auth/hooks/use-auth'

export const Route = createFileRoute('/_authLayout')({
  beforeLoad: async () => {
    // Someone already signed in has no business on the login screen.
    const user = await queryClient
      .ensureQueryData(currentUserQueryOptions)
      .catch(() => null)

    if (user) {
      throw redirect({ to: '/' })
    }
  },
  component: AuthLayout,
})

function AuthLayout() {
  return <Outlet />
}
