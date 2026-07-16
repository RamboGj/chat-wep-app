import type { ComponentProps } from 'react'

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface SignupFormProps extends ComponentProps<'form'> {}

export function SignupForm({ ...rest }: SignupFormProps) {
  return (
    <form {...rest}>
      <fieldset>
        <label htmlFor="username">Username</label>
        <input
          type="text"
          name="username"
          id="username"
          placeholder="john_doe"
        />
      </fieldset>

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

      <fieldset>
        <label htmlFor="confirm_password">Confirm Password</label>
        <input
          type="password"
          name="confirm_password"
          id="confirm_password"
          placeholder="••••••••"
        />
      </fieldset>

      <button type="submit">Create account</button>
    </form>
  )
}
