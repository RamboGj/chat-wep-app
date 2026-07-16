import type { ComponentProps } from 'react'

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface LoginFormProps extends ComponentProps<'form'> {}

export function LoginForm({ ...rest }: LoginFormProps) {
  return (
    <form {...rest}>
      <fieldset>
        <label htmlFor="email">Email</label>
        <input
          type="email"
          name="email"
          id="email"
          placeholder="john@example.com"
        />
      </fieldset>

      <fieldset>
        <label htmlFor="password">Password</label>
        <input
          type="password"
          name="password"
          id="password"
          placeholder="••••••••"
        />
      </fieldset>

      <button type="submit">Log in</button>
    </form>
  )
}
