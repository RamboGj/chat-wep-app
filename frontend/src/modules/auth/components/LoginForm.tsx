import type { ComponentProps } from 'react'
import { Input } from '../../../components/atoms/Input/Input'

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface LoginFormProps extends ComponentProps<'form'> {}

export function LoginForm({ ...rest }: LoginFormProps) {
  return (
    <form className="flex flex-col space-y-4 mt-12" {...rest}>
      <Input
        label="Email"
        type="email"
        name="email"
        id="email"
        placeholder="john@example.com"
      />

      <Input
        label="Password"
        type="password"
        name="password"
        id="password"
        placeholder="••••••••"
      />

      <button type="submit">Log in</button>
    </form>
  )
}
