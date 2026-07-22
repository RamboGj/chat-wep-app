# Forms and validation

zod defines the shape, react-hook-form drives the form, and the backend's `422` gets mapped
back onto the same field names. All three agree because they all use the API's field names.

## Schemas

`src/utils/validation/<domain>.ts`. Named `ZXxxSchema`. Export the inferred type alongside.

```ts
import { z } from 'zod'

export const ZPasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters long')
  .regex(/[A-Z]/, 'Must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Must contain at least one special character')

export const ZSignUpSchema = z
  .object({
    username: z.string().min(3, '…').max(99, '…'),
    email: z.email('Invalid e-mail'),
    password: ZPasswordSchema,
    confirmPassword: ZPasswordSchema,
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  })

export type SignUpValues = z.infer<typeof ZSignUpSchema>
```

Every rule carries a **user-facing message**. A zod default like `"String must contain at
least 8 character(s)"` reaching the UI is a bug.

`.refine()` for cross-field rules, and always give it a `path` — without one the error lands
on the form root instead of the field, and the user sees a banner next to a field that looks
fine.

Note zod v4 spells email `z.email()`, not `z.string().email()`.

**Do not reuse a strength schema on login.** `ZLoginSchema` uses `z.string().min(1)` for the
password on purpose: the strength rules apply when *choosing* a password, not when typing an
existing one. Enforcing them at login rejects valid older passwords and advertises the policy
to anyone probing the form.

Mirror the backend's rules, but treat client validation as UX only — the Go `validator` is the
authority, and every rule here exists to save a round trip, not to secure anything.

## The form

react-hook-form + `zodResolver`. `mode: 'onTouched'` — validate a field once the user has left
it, then live afterwards. Validating on every keystroke from the start shouts at people who
are still typing.

```tsx
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'

export function SignupForm() {
  const signup = useSignup()

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<SignUpValues>({
    resolver: zodResolver(ZSignUpSchema),
    mode: 'onTouched',
    defaultValues: { username: '', email: '', password: '', confirmPassword: '' },
  })

  const onSubmit = handleSubmit(async (values) => {
    try {
      await signup.mutateAsync(values)
      navigate('/auth')
    } catch (error) {
      applyFieldErrors(setError, error)
    }
  })

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col space-y-4">
      <Input
        label="Email"
        id="email"
        type="email"
        autoComplete="email"
        placeholder="john@example.com"
        error={errors.email?.message}
        {...register('email')}
      />

      {errors.root && (
        <p role="alert" className="font-manrope text-error-500 text-sm">
          {errors.root.message}
        </p>
      )}

      <Button label="Create account" type="submit" loading={isSubmitting} />
    </form>
  )
}
```

Points that are easy to get wrong:

- **`noValidate` on the `<form>`.** Otherwise the browser's native bubbles fire before zod and
  the user sees two different error styles.
- **Spread `{...register(name)}` last** so its `ref`/`onChange`/`onBlur` are not clobbered by
  an earlier prop.
- **Give every input an `id`.** `Input` wires `htmlFor` and `aria-describedby` off it; without
  one the error text is not announced to a screen reader.
- **Use `isSubmitting`, not `mutation.isPending`,** for the button. It covers validation and
  the request as one span, and stays true through the post-success navigation.
- **`defaultValues` for every field.** Omitting them starts the input uncontrolled and React
  warns the moment a value arrives.
- `register('confirmPassword')` — field names are the schema's keys, and for anything sent to
  the API those are the backend's `snake_case` names.

## Mapping server errors back onto fields

`src/utils/validation/form-errors.ts` already normalizes an unknown error into a flat
`Record<string, string>`:

```ts
export const FORM_ERROR = '_form'

/** Maps a failed request onto the form: 422 has per-field messages, others don't. */
export function requestFieldErrors(error: unknown): FieldErrors {
  if (error instanceof ApiError) {
    if (Object.keys(error.fields).length > 0) return error.fields
    return { [FORM_ERROR]: error.message }
  }
  return { [FORM_ERROR]: 'Unable to reach the server. Please try again.' }
}
```

`ApiError.fields` is populated by `lib/api.ts` from the backend's `422` body, which is the Go
`Evaluator`'s flat `field → message` map. Anything else (`409`, `500`, a network failure) has
no field, so it becomes a form-level message.

To feed that into react-hook-form, route it through `setError`, sending the form-level key to
`root`:

```ts
import type { UseFormSetError, FieldValues, Path } from 'react-hook-form'
import { FORM_ERROR, requestFieldErrors } from '@/utils/validation/form-errors'

export function applyFieldErrors<T extends FieldValues>(
  setError: UseFormSetError<T>,
  error: unknown,
) {
  for (const [field, message] of Object.entries(requestFieldErrors(error))) {
    setError(field === FORM_ERROR ? ('root' as Path<T>) : (field as Path<T>), {
      type: 'server',
      message,
    })
  }
}
```

A `setError` on `root` is cleared on the next submit and never blocks it, which is what you
want for "email already taken" — the user edits the field and tries again.

**This only works while schema keys match API field names.** The moment a form camelCases a
field the backend calls `first_name`, the server error silently lands on a field that does not
exist and the user sees nothing at all.

## Non-form validation

`zodFieldErrors(error: ZodError)` exists for the manual `safeParse` pattern used by the current
`LoginForm`/`SignupForm`. Keep using it there; prefer `zodResolver` for anything new. It keeps
the **first** message per field, deliberately matching the backend `Evaluator`'s behaviour, so
a field never shows a different number of errors depending on which side rejected it.
