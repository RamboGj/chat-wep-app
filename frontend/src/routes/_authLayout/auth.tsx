import { createFileRoute } from '@tanstack/react-router'
import { AuthPage } from '../../modules/auth/pages/AuthPage'

export const Route = createFileRoute('/_authLayout/auth')({
  component: AuthRoutePage,
})

function AuthRoutePage() {
  return <AuthPage />
}
