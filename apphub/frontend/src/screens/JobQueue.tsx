import { useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { Card } from '@/components/Card'
import { Badge } from '@/components/Badge'
import { Icon } from '@/components/Icon'
import { Button } from '@/components/Button'
import { Skeleton } from '@/components/Skeleton'
import { EmptyState } from '@/components/EmptyState'
import { cn } from '@/lib/cn'
import { useLive, CADENCE } from '@/lib/live'
import { api } from '@/lib/api'
import { useSession } from '@/lib/session'
import { useToast } from '@/lib/toast'
import { duration } from '@/lib/format'
import type { Job } from '@/lib/types'

const STATE_TONE: Record<Job['state'], 'ok' | 'warn' | 'neutral' | 'err'> = {
  RUNNING: 'ok',
  PENDING: 'warn',
  COMPLETING: 'neutral',
  FAILED: 'err',
}
const STATE_LABEL: Record<Job['state'], string> = {
  RUNNING: 'running',
  PENDING: 'pending',
  COMPLETING: 'completed',
  FAILED: 'failed',
}
const FILTERS = ['all', 'RUNNING', 'PENDING'] as const

export function JobQueue() {
  const jobs = useLive(() => api.listJobs(), { intervalMs: CADENCE.fast })
  const { session } = useSession()
  const toast = useToast()
  const isAdmin = session?.user?.role === 'admin'
  const me = session?.user?.username
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const rows = (jobs.data ?? []).filter((j) => filter === 'all' || j.state === filter)
  const canCancel = (j: Job) => (isAdmin || j.owner === me) && (j.state === 'RUNNING' || j.state === 'PENDING')
  const cancellable = rows.filter(canCancel)

  function toggle(id: string) {
    setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function toggleAll() {
    setSel((s) => (s.size === cancellable.length && cancellable.length > 0 ? new Set() : new Set(cancellable.map((j) => j.id))))
  }
  async function cancelOne(j: Job) {
    setBusy(true)
    try { await api.cancelJob(j.id); toast.push(`Cancelled ${j.name}`, 'info'); jobs.refresh() }
    catch (e) { toast.push(e instanceof Error ? e.message : 'Cancel failed', 'err') }
    finally { setBusy(false) }
  }
  async function cancelSelected() {
    setBusy(true)
    const ids = [...sel]
    let ok = 0
    for (const id of ids) { try { await api.cancelJob(id); ok++ } catch { /* keep going */ } }
    toast.push(`Cancelled ${ok}/${ids.length} job(s)`, ok ? 'ok' : 'err')
    setSel(new Set()); jobs.refresh(); setBusy(false)
  }
  async function clearFinished() {
    setBusy(true)
    try { const { cleared } = await api.clearFinished(); toast.push(`Cleared ${cleared} finished job(s)`, 'ok'); jobs.refresh() }
    catch (e) { toast.push(e instanceof Error ? e.message : 'Clear failed', 'err') }
    finally { setBusy(false) }
  }

  return (
    <>
      <PageHeader
        title="Job queue"
        subtitle="See what's running now and what's waiting for free compute."
        actions={
          isAdmin ? (
            <div className="flex items-center gap-2">
              {sel.size > 0 && (
                <Button variant="danger" icon="close-circle-line" loading={busy} onClick={cancelSelected}>
                  Cancel {sel.size} selected
                </Button>
              )}
              <Button variant="secondary" icon="brush-line" loading={busy} onClick={clearFinished}>
                Clear finished
              </Button>
            </div>
          ) : undefined
        }
      />

      <div className="mb-4 flex gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              'min-h-10 rounded-md border px-3 text-xs font-medium capitalize',
              filter === f ? 'border-brand bg-brand-tint text-brand' : 'border-border text-ink-muted hover:text-ink',
            )}
          >
            {f.toLowerCase()}
          </button>
        ))}
      </div>

      <Card className="flex max-h-[calc(100vh-15rem)] flex-col overflow-hidden">
        <div className={cn('grid shrink-0 gap-2 border-b border-border bg-surface-2/50 px-4 py-2.5 text-2xs font-medium uppercase tracking-wide text-ink-muted', isAdmin ? 'grid-cols-[1.5rem_5rem_1fr_8rem_6rem_6rem_5rem]' : 'grid-cols-[5rem_1fr_8rem_6rem_6rem_5rem]')}>
          {isAdmin && (
            <input type="checkbox" aria-label="select all jobs" disabled={cancellable.length === 0} checked={cancellable.length > 0 && sel.size === cancellable.length} onChange={toggleAll} className="h-4 w-4 accent-[var(--brand)] disabled:opacity-30" />
          )}
          <span>Job</span><span>Name</span><span>Owner</span><span>Node</span><span>Elapsed</span><span></span>
        </div>
        <div className="flex-1 overflow-y-auto">
        {jobs.loading ? (
          <div className="space-y-2 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState icon="stack-line" title="No jobs in this view" />
        ) : (
          rows.map((j) => (
            <div key={j.id} className={cn('grid items-center gap-2 border-b border-border px-4 py-2.5 text-sm last:border-0', isAdmin ? 'grid-cols-[1.5rem_5rem_1fr_8rem_6rem_6rem_5rem]' : 'grid-cols-[5rem_1fr_8rem_6rem_6rem_5rem]')}>
              {isAdmin && (
                <input type="checkbox" aria-label={`select ${j.name}`} disabled={!canCancel(j)} checked={sel.has(j.id)} onChange={() => toggle(j.id)} className="h-4 w-4 accent-[var(--brand)] disabled:opacity-30" />
              )}
              <span className="tabular text-ink-muted">{j.id}</span>
              <span className="flex items-center gap-2 truncate text-ink">
                <Badge tone={STATE_TONE[j.state]}>{STATE_LABEL[j.state]}</Badge>
                <span className="truncate">{j.name}</span>
                {j.external && <Badge tone="neutral">cluster</Badge>}
              </span>
              <span className="tabular truncate text-ink-muted">{j.owner}</span>
              <span className="tabular text-ink-muted">{j.node ?? <span className="inline-flex items-center gap-1"><Icon name="time-line" /> queued</span>}</span>
              <span className="tabular text-ink-muted">{duration(j.elapsedMinutes)}</span>
              <span className="text-right">
                {canCancel(j) && (
                  <button title="Cancel job" aria-label={`cancel ${j.name}`} onClick={() => cancelOne(j)} disabled={busy} className="text-ink-muted hover:text-err disabled:opacity-40">
                    <Icon name="close-circle-line" className="text-base" />
                  </button>
                )}
              </span>
            </div>
          ))
        )}
        </div>
      </Card>
      {isAdmin && cancellable.length > 0 && (
        <p className="mt-2 text-2xs text-ink-muted">Tip: select jobs with the checkboxes to cancel several at once. You can cancel any user's jobs as an admin.</p>
      )}
    </>
  )
}
