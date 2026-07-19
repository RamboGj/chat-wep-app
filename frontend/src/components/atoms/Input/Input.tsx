import type { ComponentProps } from 'react'
import { tv } from 'tailwind-variants'

interface InputProps extends ComponentProps<'input'> {
  label?: string
  error?: string
}

const input = tv({
  slots: {
    wrapper: 'flex flex-col gap-y-2',
    labelWrapper: 'font-manrope font-normal text-gray-300 text-sm',
    inputWrapper:
      'px-4 py-2 rounded-lg bg-gray-600 hover:bg-gray-700 ring-1 ring-gray-500 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:bg-gray-700 placeholder:font-manrope font-manrope text-gray-100 placeholder:text-gray-300 transition-all duration-500',
    errorWrapper: 'font-manrope text-error-500 text-xs',
  },
  variants: {
    invalid: {
      true: { inputWrapper: 'ring-error-500 focus:ring-error-500' },
    },
  },
})

export function Input({ label, error, className, ...rest }: InputProps) {
  const { inputWrapper, labelWrapper, wrapper, errorWrapper } = input({
    invalid: Boolean(error),
  })

  const errorId = error && rest.id ? `${rest.id}-error` : undefined

  return (
    <fieldset className={wrapper()}>
      {label && (
        <label className={labelWrapper()} htmlFor={rest.id}>
          {label}
        </label>
      )}

      <input
        className={inputWrapper({ className })}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        {...rest}
      />

      {error && (
        <span id={errorId} className={errorWrapper()}>
          {error}
        </span>
      )}
    </fieldset>
  )
}
