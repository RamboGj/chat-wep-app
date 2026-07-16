import type { ComponentProps } from 'react'
import { tv } from 'tailwind-variants'

interface TabProps extends ComponentProps<'button'> {
  title: string
  value: string
  active?: boolean
}

const tab = tv({
  base: 'flex items-center px-12 py-2 justify-center rounded-[9px] border-0 font-sora font-semibold text-sm bg-gray-800 text-gray-400 data-[active=true]:text-brand-100 data-[active=true]:bg-brand-500 data-[active=false]:hover:bg-gray-700 hover:cursor-pointer transition-color duration-300',
})

export function Tab({ title, active, className, ...rest }: TabProps) {
  const tabStyles = tab({ className })

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
