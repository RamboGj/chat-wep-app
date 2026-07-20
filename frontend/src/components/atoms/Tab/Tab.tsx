import type { ComponentProps } from 'react'
import { tv } from 'tailwind-variants'

interface TabProps extends ComponentProps<'button'> {
  title: string
  value: string
  active?: boolean
}

const tab = tv({
  base: 'relative z-10 flex items-center px-6 sm:px-12 py-2 justify-center rounded-[9px] border-0 font-sora font-semibold text-sm bg-transparent text-gray-300 hover:cursor-pointer transition-colors duration-300',
  variants: {
    active: {
      true: 'text-white',
    },
  },
})

export function Tab({ title, active, className, ...rest }: TabProps) {
  const tabStyles = tab({ active, className })

  return (
    <button
      data-active={active}
      aria-label={title}
      className={tabStyles}
      {...rest}
    >
      {title}
    </button>
  )
}
