import { createFileRoute, Outlet } from '@tanstack/react-router'

export const Route = createFileRoute('/_authLayout')({
  component: AuthLayout,
})

function AuthLayout() {
  return <Outlet />
}
