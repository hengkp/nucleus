import { useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { Card } from '@/components/Card'
import { Badge } from '@/components/Badge'
import { Icon } from '@/components/Icon'
import { Button } from '@/components/Button'
import { StatusDot } from '@/components/StatusDot'
import { EmptyState } from '@/components/EmptyState'
import { cn } from '@/lib/cn'
import { useLive, CADENCE } from '@/lib/live'
import { api } from '@/lib/api'
import { useSession } from '@/lib/session'
import { useToast } from '@/lib/toast'
import { gb } from '@/lib/format'
import type { Instance } from '@/lib/types'

export function Admin() {
  const { session } = useSession()
  const toast = useToast()
  const instances = useLive(() => api.listInstances(), { intervalMs: CADENCE.fast })
  const reqs = useLive(() => api.listRequests(), { intervalMs: CADENCE.slow })
  const vanities = useLive(() => api.listVanity(), { intervalMs: CADENCE.slow })
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [deciding, setDeciding] = useState<string>()

  if (session?.user?.role !== 'admin') {
    return <EmptyState icon="shield-keyhole-line" title="Admins only" description="This area is for the lab admin team." />
  }

  const all = instances.data ?? []
  const active = all.filter((i) => i.state !== 'stopped' && i.state !== 'failed')
  const stoppable = (i: Instance) => i.state !== 'stopped' && i.state !== 'failed'
  const stoppableList = all.filter(stoppable)
  const requests = reqs.data?.requests ?? []
  const pending = requests.filter((r) => r.status === 'pending')

  function toggle(id: string) { setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n }) }
  function toggleAll() {
    setSel((s) => (s.size === stoppableList.length && stoppableList.length > 0 ? new Set() : new Set(stoppableList.map((i) => i.id))))
  }
  async function stopOne(i: Instance) {
    setBusy(true)
    try { await api.stopInstance(i.id); toast.push(`Stopped ${i.name}`, 'info'); instances.refresh() }
    catch (e) { toast.push(e instanceof Error ? e.message : 'Stop failed', 'err') } finally { setBusy(false) }
  }
  async function stopSelected() {
    setBusy(true)
    const ids = [...sel]; let ok = 0
    for (const id of ids) { try { await api.stopInstance(id); ok++ } catch { /* keep going */ } }
    toast.push(`Stopped ${ok}/${ids.length} instance(s)`, ok ? 'ok' : 'err')
    setSel(new Set()); instances.refresh(); setBusy(false)
  }
  async function decide(id: string, decision: 'approve' | 'deny') {
    setDeciding(id)
    try { await api.decideRequest(id, decision); toast.push(decision === 'approve' ? 'Request approved' : 'Request denied', 'ok'); reqs.refresh() }
    catch (e) { toast.push(e instanceof Error ? e.message : 'Action failed', 'err') } finally { setDeciding(undefined) }
  }
  const vanityList = vanities.data ?? []
  async function decideV(name: string, decision: 'approve' | 'deny') {
    setDeciding(name)
    try { await api.decideVanity(name, decision); toast.push(`Vanity ${name} ${decision === 'approve' ? 'approved' : 'denied'}`, 'ok'); vanities.refresh() }
    catch (e) { toast.push(e instanceof Error ? e.message : 'Action failed', 'err') } finally { setDeciding(undefined) }
  }
  async function releaseV(name: string) {
    setDeciding(name)
    try { await api.removeVanity(name); toast.push(`Released ${name}.app.sisp.com`, 'ok'); vanities.refresh() }
    catch (e) { toast.push(e instanceof Error ? e.message : 'Action failed', 'err') } finally { setDeciding(undefined) }
  }

  const Stat = ({ icon, label, value }: { icon: string; label: string; value: string | number }) => (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-brand-tint text-brand"><Icon name={icon} className="text-lg" /></div>
        <div><p className="text-2xs text-ink-muted">{label}</p><p className="tabular text-xl font-semibold text-ink">{value}</p></div>
      </div>
    </Card>
  )

  const allChecked = stoppableList.length > 0 && sel.size === stoppableList.length

  return (
    <>
      <PageHeader
        title="Admin"
        subtitle="Cluster-wide control of instances, approvals, and audit."
        actions={sel.size > 0 ? <Button variant="danger" icon="stop-circle-line" loading={busy} onClick={stopSelected}>Stop {sel.size} selected</Button> : undefined}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat icon="rocket-2-line" label="Running instances" value={active.length} />
        <Stat icon="group-line" label="Active users" value={new Set(active.map((i) => i.owner)).size} />
        <Stat icon="time-line" label="Pending approvals" value={reqs.data?.pending ?? 0} />
      </div>

      {/* Approvals */}
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Hosting & access requests</h2>
        <button onClick={() => reqs.refresh()} className="text-2xs text-ink-muted hover:text-ink"><Icon name="refresh-line" className="mr-1" />refresh</button>
      </div>
      <Card className="mb-6 overflow-hidden">
        {reqs.loading && !reqs.data ? (
          <div className="p-4"><Badge tone="neutral">Loading...</Badge></div>
        ) : pending.length === 0 ? (
          <div className="flex items-center gap-2 p-4 text-sm text-ink-muted"><Icon name="checkbox-circle-line" className="text-ok" /> No requests awaiting approval.</div>
        ) : (
          pending.map((r) => (
            <div key={r.id} className="flex flex-col gap-3 border-b border-border p-4 last:border-0 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <Icon name="shield-user-line" className="mt-0.5 text-warn" />
                <div>
                  <p className="text-sm font-medium text-ink">{r.user} | <span className="font-normal text-ink-muted">{r.kind}</span></p>
                  <p className="text-2xs text-ink-muted">{r.detail || 'No details provided.'}</p>
                  <p className="text-2xs text-ink-muted">{new Date(r.createdAt).toLocaleString()}</p>
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="ghost" icon="close-line" loading={deciding === r.id} onClick={() => decide(r.id, 'deny')}>Deny</Button>
                <Button size="sm" variant="primary" icon="check-line" loading={deciding === r.id} onClick={() => decide(r.id, 'approve')}>Approve</Button>
              </div>
            </div>
          ))
        )}
        {requests.some((r) => r.status !== 'pending') && (
          <div className="border-t border-border bg-surface-2/40 px-4 py-2 text-2xs text-ink-muted">
            Recent: {requests.filter((r) => r.status !== 'pending').slice(0, 4).map((r) => `${r.user} ${r.status}`).join(' | ')}
          </div>
        )}
      </Card>

      {/* Custom URLs — self-service (granted automatically when unique) */}
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Custom URLs <span className="font-normal text-ink-muted">| self-service</span></h2>
        <button onClick={() => vanities.refresh()} className="text-2xs text-ink-muted hover:text-ink"><Icon name="refresh-line" className="mr-1" />refresh</button>
      </div>
      <Card className="mb-6 overflow-hidden">
        <div className="border-b border-border bg-surface-2/40 px-4 py-2 text-2xs text-ink-muted">
          Names are granted automatically when valid, unique, and not reserved, with no approval needed. Release one here to free it up.
        </div>
        {vanityList.length === 0 ? (
          <div className="flex items-center gap-2 p-4 text-sm text-ink-muted"><Icon name="links-line" className="text-ink-muted" /> No custom URLs claimed yet.</div>
        ) : (
          vanityList.map((v) => (
            <div key={v.name} className="flex flex-col gap-3 border-b border-border p-4 last:border-0 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <Icon name="links-line" className={cn('mt-0.5', v.status === 'pending' ? 'text-warn' : 'text-brand')} />
                <div>
                  <p className="text-sm font-medium text-ink">{v.name}<span className="font-normal text-ink-muted">.app.sisp.com</span></p>
                  <p className="text-2xs text-ink-muted">{v.owner} | {v.status} | {new Date(v.createdAt).toLocaleString()}</p>
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                {v.status === 'pending' && (
                  <Button size="sm" variant="primary" icon="check-line" loading={deciding === v.name} onClick={() => decideV(v.name, 'approve')}>Approve</Button>
                )}
                <Button size="sm" variant="ghost" icon="delete-bin-line" loading={deciding === v.name} onClick={() => releaseV(v.name)}>Release</Button>
              </div>
            </div>
          ))
        )}
      </Card>

      {/* Instances */}
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">All instances</h2>
        <button onClick={() => instances.refresh()} className="text-2xs text-ink-muted hover:text-ink"><Icon name="refresh-line" className="mr-1" />refresh</button>
      </div>
      <Card className="flex max-h-[calc(100vh-22rem)] flex-col overflow-hidden">
        <div className="grid shrink-0 grid-cols-[1.5rem_1fr_8rem_5rem_7rem_6rem_4rem] gap-2 border-b border-border bg-surface-2/50 px-4 py-2.5 text-2xs font-medium uppercase tracking-wide text-ink-muted">
          <input type="checkbox" aria-label="select all instances" disabled={stoppableList.length === 0} checked={allChecked} onChange={toggleAll} className="h-4 w-4 accent-[var(--brand)] disabled:opacity-30" />
          <span>Instance</span><span>Owner</span><span>Node</span><span>Resources</span><span>State</span><span></span>
        </div>
        <div className="flex-1 overflow-y-auto">
        {all.length === 0 ? (
          <div className="p-4"><Badge tone="neutral">No instances</Badge></div>
        ) : (
          all.map((i) => (
            <div key={i.id} className="grid grid-cols-[1.5rem_1fr_8rem_5rem_7rem_6rem_4rem] items-center gap-2 border-b border-border px-4 py-2.5 text-sm last:border-0">
              <input type="checkbox" aria-label={`select ${i.name}`} disabled={!stoppable(i)} checked={sel.has(i.id)} onChange={() => toggle(i.id)} className="h-4 w-4 accent-[var(--brand)] disabled:opacity-30" />
              <span className="flex items-center gap-2 truncate text-ink"><Icon name={i.icon} className="text-ink-muted" /><span className="truncate">{i.name}</span>{i.visibility !== 'private' && <Badge tone="blue">{i.visibility}</Badge>}</span>
              <span className="tabular truncate text-ink-muted">{i.owner}</span>
              <span className="tabular text-ink-muted">{i.node ?? '-'}</span>
              <span className="tabular text-ink-muted">{i.cpus}c | {gb(i.memoryMb)}</span>
              <StatusDot state={i.state} withLabel={false} />
              <span className="text-right">{stoppable(i) && <button title="Stop" onClick={() => stopOne(i)} disabled={busy} className={cn('text-ink-muted hover:text-err disabled:opacity-40')}><Icon name="stop-circle-line" /></button>}</span>
            </div>
          ))
        )}
        </div>
      </Card>
    </>
  )
}
