import { useState, type ComponentProps } from 'react'
import { useNavigate } from 'react-router'
import { Input } from '@/components/atoms/Input/Input'
import { Button } from '@/components/atoms/Button/Button'
import { ZLoginSchema } from '@/utils/validation/auth'
import {
  FORM_ERROR,
  requestFieldErrors,
  zodFieldErrors,
  type FieldErrors,
} from '@/utils/validation/form-errors'
import { useLogin } from '../hooks/use-auth'

interface LoginFormProps extends ComponentProps<'form'> {
  defaultEmail?: string
  notice?: string
}

export function LoginForm({ defaultEmail = '', notice, ...rest }: LoginFormProps) {
  const [values, setValues] = useState({ email: defaultEmail, password: '' })
  const [errors, setErrors] = useState<FieldErrors>({})

  const login = useLogin()
  const navigate = useNavigate()

  function handleChange(field: keyof typeof values) {
    return (event: { target: { value: string } }) => {
      setValues((current) => ({ ...current, [field]: event.target.value }))
    }
  }

  async function submit() {
    const parsed = ZLoginSchema.safeParse(values)
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error))
      return
    }

    setErrors({})
    try {
      await login.mutateAsync(parsed.data)
      navigate('/')
    } catch (error) {
      setErrors(requestFieldErrors(error))
    }
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
      {notice && (
        <p role="status" className="font-manrope text-sm text-success-500">
          {notice}
        </p>
      )}

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
        autoComplete="current-password"
        value={values.password}
        onChange={handleChange('password')}
        error={errors.password}
      />

      {errors[FORM_ERROR] && (
        <p role="alert" className="font-manrope text-error-500 text-sm">
          {errors[FORM_ERROR]}
        </p>
      )}

      <Button
        className="mt-10"
        label="Log in"
        type="submit"
        loading={login.isPending}
      />
    </form>
  )
}
