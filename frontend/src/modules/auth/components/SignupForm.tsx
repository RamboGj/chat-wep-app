import { Button } from '@/components/atoms/Button/Button'
import { Input } from '@/components/atoms/Input/Input'
import type { ComponentProps } from 'react'

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface SignupFormProps extends ComponentProps<'form'> {}

export function SignupForm({ ...rest }: SignupFormProps) {
  return (
    <form
      className="flex flex-col space-y-4 mt-12 animate-showContent"
      {...rest}
    >
      <Input
        label="Username"
        type="text"
        name="username"
        id="username"
        placeholder="john_doe"
      />

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

      <Input
        label="Confirm Password"
        type="password"
        name="confirm_password"
        id="confirm_password"
        placeholder="••••••••"
      />

      <Button className="mt-10" label="Create account" type="submit" />
    </form>
  )
}
