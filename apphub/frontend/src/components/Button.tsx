import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'
import { Icon } from './Icon'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-white border-brand hover:bg-brand-strong hover:border-brand-strong',
  secondary: 'bg-surface text-ink border-border hover:border-brand hover:text-brand',
  ghost: 'bg-transparent text-ink-muted border-transparent hover:bg-surface-2 hover:text-ink',
  danger: 'bg-transparent text-err border-border hover:bg-err hover:text-white hover:border-err',
}
const SIZES: Record<Size, string> = {
  sm: 'h-8 px-2.5 text-xs gap-1.5 rounded-sm',
  md: 'h-10 px-3.5 text-sm gap-2 rounded-md',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: string
  iconRight?: string
  loading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, iconRight, loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap border font-medium transition-colors duration-[120ms]',
        'disabled:cursor-not-allowed disabled:opacity-55',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Icon name="loader-4-line" className="animate-spin text-base" />
      ) : (
        icon && <Icon name={icon} className="text-base" />
      )}
      {children}
      {iconRight && !loading && <Icon name={iconRight} className="text-base" />}
    </button>
  )
})
