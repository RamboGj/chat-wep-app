import type { ComponentProps } from 'react'
import { tv } from 'tailwind-variants'

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: 'default' | 'gradient' | 'ghost'
  label: string
  loading?: boolean
}

const button = tv({
  slots: {
    wrapper:
      'rounded-lg hover:cursor-pointer py-3 px-8 focus:border-0 outline-1 outline-white-08 transition-colors duration-300 outline-offset-[-2px] disabled:cursor-not-allowed disabled:opacity-60',
    labelWrapper: 'text-white text-sm font-sora font-bold',
  },
  variants: {
    variant: {
      default: { wrapper: 'bg-brand-500 hover:bg-brand-400' },
      gradient: {
        wrapper:
          'bg-[linear-gradient(135deg,var(--color-brand-500),var(--color-brand-400))] hover:brightness-110',
      },
      ghost: {
        wrapper:
          'bg-transparent outline-white-12 hover:outline-white-25 disabled:opacity-40',
        labelWrapper: 'font-manrope font-normal text-gray-300',
      },
    },
  },
  defaultVariants: {
    variant: 'default',
  },
})

export function Button({
  variant = 'default',
  className,
  label,
  loading = false,
  disabled,
  ...rest
}: ButtonProps) {
  const { labelWrapper, wrapper } = button({ variant })

  return (
    <button
      className={wrapper({ className })}
      disabled={disabled ?? loading}
      aria-busy={loading}
      {...rest}
    >
      <span className={labelWrapper()}>{loading ? 'Please wait…' : label}</span>
    </button>
  )
}
