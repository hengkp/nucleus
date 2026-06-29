import { forwardRef, type SelectHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'
import { Icon } from './Icon'

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <div className="relative">
        <select
          ref={ref}
          className={cn(
            'h-10 w-full appearance-none rounded-md border border-border bg-surface px-3 pr-9 text-sm text-ink',
            'focus:border-brand',
            'disabled:cursor-not-allowed disabled:opacity-55',
            className,
          )}
          {...rest}
        >
          {children}
        </select>
        <Icon name="arrow-down-s-line" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-muted" />
      </div>
    )
  },
)
