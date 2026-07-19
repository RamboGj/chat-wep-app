import { useId, type ComponentProps } from 'react'
import { tv } from 'tailwind-variants'

export type LogoSize = 'sm' | 'md' | 'lg' | 'xl'
export type LogoVariant = 'gradient' | 'outline' | 'light'

export interface LogoProps extends ComponentProps<'div'> {
  size?: LogoSize
  variant?: LogoVariant
  /** Hide the "Pulse" wordmark and render the mark on its own. */
  markOnly?: boolean
}

/**
 * Brand gradient as a raw declaration: the mark keeps the design's 135deg
 * violet ramp in every variant that uses it, including the SVG fill below.
 */
const GRADIENT =
  'bg-[linear-gradient(135deg,var(--color-brand-500),var(--color-brand-400))]'

const logo = tv({
  slots: {
    root: 'flex items-center',
    // Radius is 30% of the box, per the design's clearspace note, so the mark
    // keeps its squircle proportions at every size.
    mark: 'flex shrink-0 items-center justify-center rounded-[30%]',
    wordmark: 'font-sora font-extrabold tracking-[-0.01em] text-gray-100',
  },
  variants: {
    size: {
      sm: { root: 'gap-2.5', mark: 'size-9', wordmark: 'text-[17px]' },
      md: { root: 'gap-3.5', mark: 'size-11', wordmark: 'text-[22px]' },
      lg: { root: 'gap-4', mark: 'size-14', wordmark: 'text-[30px]' },
      xl: { root: 'gap-6', mark: 'size-30', wordmark: 'text-[40px]' },
    },
    variant: {
      gradient: { mark: GRADIENT },
      outline: { mark: 'bg-gray-700 border border-white-08' },
      light: { mark: 'bg-gray-100' },
    },
  },
  defaultVariants: {
    size: 'md',
    variant: 'gradient',
  },
})

const GLYPH_SIZE: Record<LogoSize, number> = {
  sm: 20,
  md: 24,
  lg: 30,
  xl: 60,
}

export function Logo({
  size = 'md',
  variant = 'gradient',
  markOnly = false,
  className,
  ...rest
}: LogoProps) {
  const gradientId = useId()
  const { root, mark, wordmark } = logo({ size, variant })

  // On the light tile the glyph carries the brand colour; on the outline tile it
  // carries the gradient itself, so the ramp is never lost.
  const glyphFill =
    variant === 'outline'
      ? `url(#${gradientId})`
      : variant === 'light'
        ? 'var(--color-brand-500)'
        : '#fff'

  return (
    <div className={root({ className })} {...rest}>
      <div className={mark()}>
        <svg
          width={GLYPH_SIZE[size]}
          height={GLYPH_SIZE[size]}
          viewBox="0 0 24 24"
          fill="none"
          role="img"
          aria-label="Pulse"
        >
          <path
            d="M12 3C7.03 3 3 6.58 3 11c0 2.39 1.19 4.53 3.08 6.02-.1.98-.42 2.28-1.18 3.48-.1.16.03.36.22.33 1.94-.28 3.36-1.05 4.24-1.65.86.22 1.77.32 2.64.32 4.97 0 9-3.58 9-8s-4.03-8-9-8z"
            fill={glyphFill}
          />
          {variant === 'outline' && (
            <defs>
              <linearGradient id={gradientId} x1="3" y1="3" x2="21" y2="19">
                <stop stopColor="var(--color-brand-500)" />
                <stop offset="1" stopColor="var(--color-brand-400)" />
              </linearGradient>
            </defs>
          )}
        </svg>
      </div>

      {!markOnly && <span className={wordmark()}>Pulse</span>}
    </div>
  )
}
