import { cn } from '@/lib/cn'
import { Icon } from './Icon'
import type { InstanceState } from '@/lib/types'

// Status is NEVER color-alone (WCAG): dot + label + icon together.
const MAP: Record<InstanceState, { label: string; color: string; icon: string; pulse?: boolean }> = {
  running: { label: 'Running', color: 'text-ok', icon: 'checkbox-circle-fill' },
  queued: { label: 'Queued', color: 'text-warn', icon: 'time-line', pulse: true },
  starting: { label: 'Starting', color: 'text-warn', icon: 'loader-2-line', pulse: true },
  expiring: { label: 'Expiring', color: 'text-warn', icon: 'alarm-warning-line' },
  stopped: { label: 'Stopped', color: 'text-ink-muted', icon: 'stop-circle-line' },
  failed: { label: 'Failed', color: 'text-err', icon: 'close-circle-fill' },
}

export function StatusDot({ state, withLabel = true, className }: { state: InstanceState; withLabel?: boolean; className?: string }) {
  const s = MAP[state]
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <Icon name={s.icon} className={cn('text-sm', s.color, s.pulse && 'animate-pulse-ring')} label={withLabel ? undefined : s.label} />
      {withLabel && <span className={cn('text-xs font-medium', s.color)}>{s.label}</span>}
    </span>
  )
}
