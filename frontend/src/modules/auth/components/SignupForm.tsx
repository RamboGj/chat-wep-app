import { useState, type ComponentProps } from 'react'
import { Button } from '@/components/atoms/Button/Button'
import { Input } from '@/components/atoms/Input/Input'
import { ZSignUpSchema } from '@/utils/validation/auth'
import {
  FORM_ERROR,
  requestFieldErrors,
  zodFieldErrors,
  type FieldErrors,
} from '@/utils/validation/form-errors'
import { useSignup } from '../hooks/use-auth'

interface SignupFormProps extends ComponentProps<'form'> {
  /** Called with the new account's email once it has been created. */
  onCreated: (email: string) => void
}

export function SignupForm({ onCreated, ...rest }: SignupFormProps) {
  const [values, setValues] = useState({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
  })
  const [errors, setErrors] = useState<FieldErrors>({})

  const signup = useSignup()

  function handleChange(field: keyof typeof values) {
    return (event: { target: { value: string } }) => {
      setValues((current) => ({ ...current, [field]: event.target.value }))
    }
  }

  function submit() {
    const parsed = ZSignUpSchema.safeParse(values)
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error))
      return
    }

    setErrors({})
    const { username, email, password } = parsed.data

    signup.mutate(
      { username, email, password },
      {
        // No tokens are minted by signup, so hand off to the log in tab.
        onSuccess: () => onCreated(email),
        onError: (error) => setErrors(requestFieldErrors(error)),
      },
    )
  }

  return (
    <form
      className="flex flex-col space-y-4 mt-12 animate-showContent"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      noValidate
      {...rest}
    >
      <Input
        label="Username"
        type="text"
        name="username"
        id="username"
        placeholder="john_doe"
        autoComplete="username"
        value={values.username}
        onChange={handleChange('username')}
        error={errors.username}
      />

      <Input
        label="Email"
        type="email"
        name="email"
        id="email"
        placeholder="john@example.com"
        autoComplete="email"
        value={values.email}
        onChange={handleChange('email')}
        error={errors.email}
      />

      <Input
        label="Password"
        type="password"
        name="password"
        id="password"
        placeholder="••••••••"
        autoComplete="new-password"
        value={values.password}
        onChange={handleChange('password')}
        error={errors.password}
      />

      <Input
        label="Confirm Password"
        type="password"
        name="confirm_password"
        id="confirm_password"
        placeholder="••••••••"
        autoComplete="new-password"
        value={values.confirmPassword}
        onChange={handleChange('confirmPassword')}
        error={errors.confirmPassword}
      />

      {errors[FORM_ERROR] && (
        <p role="alert" className="font-manrope text-error-500 text-sm">
          {errors[FORM_ERROR]}
        </p>
      )}

      <Button
        className="mt-10"
        label="Create account"
        type="submit"
        loading={signup.isPending}
      />
    </form>
  )
}
