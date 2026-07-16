import { createFileRoute, useNavigate } from '@tanstack/react-router'

export const Route = createFileRoute('/_authLayout/login')({
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()

  navigate({
    to: '/',
  })

  return <div>hi login!</div>
}
