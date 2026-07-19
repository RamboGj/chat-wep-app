import type { ComponentProps } from 'react'
import { tv } from 'tailwind-variants'
import { avatarColor, initials } from '@/lib/format'

export interface AvatarProps extends ComponentProps<'div'> {
  name: string
  size?: 'sm' | 'md' | 'lg'
  /** Renders the presence dot. Omit entirely when presence is unknown. */
  online?: boolean
  /** Border colour of the presence dot, matched to the surface behind it. */
  ringColor?: string
}

const avatar = tv({
  slots: {
    root: 'relative shrink-0',
    tile: 'flex items-center justify-center rounded-full font-sora font-bold text-white',
    dot: 'absolute -bottom-px -right-px rounded-full bg-success-500 border-2',
  },
  variants: {
    size: {
      sm: { tile: 'size-8.5 text-[13px]', dot: 'size-2.5' },
      md: { tile: 'size-10 text-sm', dot: 'size-3' },
      lg: { tile: 'size-11.5 text-[15px]', dot: 'size-3' },
    },
  },
  defaultVariants: {
    size: 'md',
  },
})

export function Avatar({
  name,
  size = 'md',
  online,
  ringColor = 'var(--color-gray-800)',
  className,
  ...rest
}: AvatarProps) {
  const { root, tile, dot } = avatar({ size })

  return (
    <div className={root({ className })} {...rest}>
      <div className={tile()} style={{ background: avatarColor(name) }}>
        {initials(name)}
      </div>

      {online && <div className={dot()} style={{ borderColor: ringColor }} />}
    </div>
  )
}
