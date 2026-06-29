import { cn } from '@/lib/cn'
import type { HTMLAttributes } from 'react'

export function Card({ className, interactive, ...rest }: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-md border border-border bg-surface shadow-1',
        interactive && 'cursor-pointer transition-all duration-[120ms] hover:border-brand/50 hover:shadow-2',
        className,
      )}
      {...rest}
    />
  )
}
