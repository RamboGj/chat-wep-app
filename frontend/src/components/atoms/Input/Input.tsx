import type { ComponentProps } from 'react'
import { tv } from 'tailwind-variants'

interface InputProps extends ComponentProps<'input'> {
  label?: string
}

const input = tv({
  slots: {
    wrapper: 'flex flex-col gap-y-1',
    labelWrapper: 'font-manrope font-normal text-gray-300 text-sm',
    inputWrapper:
      'px-4 py-2 rounded-lg bg-gray-600 hover:bg-gray-700 ring-1 ring-gray-500 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:bg-gray-700 placeholder:font-manrope font-manrope text-gray-100 placeholder:text-gray-300 transition-all duration-500',
  },
})

export function Input({ label, className, ...rest }: InputProps) {
  const { inputWrapper, labelWrapper, wrapper } = input({ className })

  return (
    <fieldset className={wrapper()}>
      {label && (
        <label className={labelWrapper()} htmlFor={rest.id}>
          {label}
        </label>
      )}
      <input className={inputWrapper()} {...rest} />
    </fieldset>
  )
}
