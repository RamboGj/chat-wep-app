import type { ComponentProps } from 'react'
import { Input } from '../../../components/atoms/Input/Input'
import { Button } from '@/components/atoms/Button/Button'

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface LoginFormProps extends ComponentProps<'form'> {}

export function LoginForm({ ...rest }: LoginFormProps) {
  return (
    <form
      className="flex flex-col space-y-4 mt-12 animate-showContent"
      {...rest}
    >
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

      <Button className="mt-10" label="Log in" type="submit" />
    </form>
  )
}
