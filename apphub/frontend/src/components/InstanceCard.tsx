import { Card } from './Card'
import { Icon } from './Icon'
import { Badge } from './Badge'
import { Button } from './Button'
import { StatusDot } from './StatusDot'
import { cn } from '@/lib/cn'
import { gb, remaining } from '@/lib/format'
import type { Instance } from '@/lib/types'

// The core object users reason about: a "deployment" of an app. The Open action is
// derived strictly from instance.url (ADR-006) — never shown as ready until routed.
function TimeRing({ elapsed, limit }: { elapsed: number; limit: number | null }) {
  if (limit === null) {
    return <Icon name="infinity-line" className="text-ink-muted" label="No time limit" />
  }
  const frac = Math.min(1, elapsed / limit)
  const r = 9
  const c = 2 * Math.PI * r
  const tone = frac > 0.9 ? 'var(--err)' : frac > 0.75 ? 'var(--warn)' : 'var(--brand)'
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" className="-rotate-90">
      <circle cx="12" cy="12" r={r} fill="none" stroke="var(--surface-2)" strokeWidth="2.5" />
      <circle
        cx="12"
        cy="12"
        r={r}
        fill="none"
        stroke={tone}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - frac)}
      />
    </svg>
  )
}

export function InstanceCard({
  instance,
  onOpen,
  onStop,
  onDetail,
  onExtend,
}: {
  instance: Instance
  onOpen: (i: Instance) => void
  onStop: (i: Instance) => void
  onDetail: (i: Instance) => void
  onExtend?: (i: Instance) => void
}) {
  const live = instance.state === 'running'
  const busy = instance.state === 'queued' || instance.state === 'starting'
  // Openable strictly from a registered route — an 'expiring' app is still reachable.
  const openable = !!instance.url && (instance.state === 'running' || instance.state === 'expiring')
  const extendable = !!onExtend && instance.timeLimitMinutes != null && (instance.state === 'running' || instance.state === 'expiring')

  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-white',
            live ? 'bg-gradient-to-br from-brand to-brand-strong' : 'bg-surface-2 text-ink-muted',
          )}
        >
          <Icon name={instance.icon} className="text-xl" />
        </div>
        <div className="min-w-0 flex-1">
          <button onClick={() => onDetail(instance)} className="block max-w-full truncate text-left text-sm font-semibold text-ink hover:text-brand">
            {instance.name}
          </button>
          <p className="truncate text-2xs text-ink-muted">{instance.templateName}</p>
        </div>
        <StatusDot state={instance.state} />
      </div>

      <div className="mt-3 flex items-center gap-3 text-2xs text-ink-muted">
        <span className="inline-flex items-center gap-1">
          <Icon name="server-line" /> {instance.node ?? '—'}
        </span>
        <span className="tabular inline-flex items-center gap-1">
          <Icon name="cpu-line" /> {instance.cpus}
        </span>
        <span className="tabular inline-flex items-center gap-1">
          <Icon name="ram-2-line" /> {gb(instance.memoryMb)}
        </span>
        {instance.visibility !== 'private' && <Badge tone="blue">{instance.visibility}</Badge>}
      </div>

      {busy && instance.message && (
        <p className="mt-3 rounded-sm bg-surface-2 px-2.5 py-1.5 text-2xs text-ink-muted">{instance.message}</p>
      )}

      <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
        <div className="flex items-center gap-2 text-2xs text-ink-muted">
          <TimeRing elapsed={instance.elapsedMinutes} limit={instance.timeLimitMinutes} />
          <span className="tabular">{remaining(instance.elapsedMinutes, instance.timeLimitMinutes)}</span>
          {extendable && (
            <button title="Add 12 hours" onClick={() => onExtend!(instance)} className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-brand hover:bg-brand-tint">
              <Icon name="time-line" />+12h
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {(instance.state === 'stopped' || instance.state === 'failed') ? (
            <Button size="sm" variant="ghost" icon="delete-bin-line" onClick={() => onStop(instance)}>
              Remove
            </Button>
          ) : (
            <Button size="sm" variant="danger" icon="stop-circle-line" onClick={() => onStop(instance)} disabled={busy}>
              Stop
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            icon="external-link-line"
            disabled={!openable}
            onClick={() => onOpen(instance)}
          >
            Open
          </Button>
        </div>
      </div>
    </Card>
  )
}
