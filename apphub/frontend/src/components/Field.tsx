import { useId, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string
  hint?: string
  error?: string
  /** render-prop so the control gets the generated id for the label association */
  children: (id: string) => ReactNode
  className?: string
}) {
  const id = useId()
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-xs font-medium text-ink">
        {label}
      </label>
      {children(id)}
      {error ? (
        <p className="text-2xs text-err">{error}</p>
      ) : hint ? (
        <p className="text-2xs text-ink-muted">{hint}</p>
      ) : null}
    </div>
  )
}
