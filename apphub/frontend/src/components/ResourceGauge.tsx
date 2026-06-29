import { cn } from '@/lib/cn'
import { pct } from '@/lib/format'

// Per-node CPU/RAM utilization strip for the dashboard cluster-health view.
export function ResourceGauge({
  label,
  used,
  total,
  unit,
  className,
}: {
  label: string
  used: number
  total: number
  unit?: string
  className?: string
}) {
  const p = pct(used, total)
  const tone = p >= 90 ? 'bg-err' : p >= 70 ? 'bg-warn' : 'bg-brand'
  return (
    <div className={cn('space-y-1', className)}>
      <div className="flex items-baseline justify-between text-2xs">
        <span className="text-ink-muted">{label}</span>
        <span className="tabular text-ink-muted">
          {used}
          {unit} / {total}
          {unit} | {p}%
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div className={cn('h-full rounded-full transition-all duration-500', tone)} style={{ width: `${p}%` }} />
      </div>
    </div>
  )
}
