import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-10 w-full rounded-md border border-border bg-surface px-3 text-sm text-ink',
          'placeholder:text-ink-muted/70',
          'focus:border-brand',
          'disabled:cursor-not-allowed disabled:opacity-55',
          className,
        )}
        {...rest}
      />
    )
  },
)
