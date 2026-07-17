import type { ComponentProps } from 'react'
import { tv } from 'tailwind-variants'

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: 'default' | 'ghost'
  label: string
}

const button = tv({
  slots: {
    wrapper:
      'rounded-lg hover:cursor-pointer py-3 px-8 bg-brand-500 hover:bg-brand-400 focus:border-0 outline-1 outline-white-08  transition-colors duration-300 outline-offset-[-2px]',
    labelWrapper: 'text-white text-sm font-sora font-bold',
  },
})

export function Button({
  //   variant = 'default',
  className,
  label,
  ...rest
}: ButtonProps) {
  const { labelWrapper, wrapper } = button({ className })

  return (
    <button className={wrapper({ className })} {...rest}>
      <span className={labelWrapper()}>{label}</span>
    </button>
  )
}
