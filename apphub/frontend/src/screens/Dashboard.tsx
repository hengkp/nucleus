import { useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { InstanceCard } from '@/components/InstanceCard'
import { LaunchWizard } from '@/components/LaunchWizard'
import { ResourceGauge } from '@/components/ResourceGauge'
import { Card } from '@/components/Card'
import { Badge } from '@/components/Badge'
import { Icon } from '@/components/Icon'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { Field } from '@/components/Field'
import { Input } from '@/components/Input'
import { SkeletonCard } from '@/components/Skeleton'
import { EmptyState } from '@/components/EmptyState'
import { useLive, CADENCE } from '@/lib/live'
import { api } from '@/lib/api'
import { useSession } from '@/lib/session'
import { useFavorites } from '@/lib/favorites'
import { useToast } from '@/lib/toast'
import { gb } from '@/lib/format'
import type { Instance, QuotaInfo, Template } from '@/lib/types'

function QuotaRequestModal({ quota, open, onClose, onSent }: { quota: QuotaInfo; open: boolean; onClose: () => void; onSent: () => void }) {
  const toast = useToast()
  const [limit, setLimit] = useState(String(Math.min(quota.limit + 1, quota.max)))
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()

  async function submit() {
    setErr(undefined)
    const n = Math.round(Number(limit))
    if (!Number.isFinite(n) || n <= quota.limit || n > quota.max) {
      setErr(`Pick a number between ${quota.limit + 1} and ${quota.max}.`)
      return
    }
    setBusy(true)
    try {
      await api.requestQuota(n, reason)
      toast.push('Quota request sent to the admins.', 'ok')
      onSent(); onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not send the request')
    } finally { setBusy(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="Request a higher quota" size="sm">
      <div className="space-y-4 p-5">
        <p className="text-sm text-ink-muted">
          You can run <span className="font-medium text-ink">{quota.limit}</span> apps at the same time.
          Ask the admins for more (up to {quota.max}); approval applies it immediately.
        </p>
        <Field label={`New limit (${quota.limit + 1}-${quota.max})`} error={err}>
          {(id) => <Input id={id} type="number" min={quota.limit + 1} max={quota.max} value={limit} onChange={(e) => setLimit(e.target.value)} autoFocus />}
        </Field>
        <Field label="Why do you need it? (optional)">
          {(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. QuPath + two notebooks for the imaging project" />}
        </Field>
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon="send-plane-line" loading={busy} onClick={submit}>Send request</Button>
      </div>
    </Modal>
  )
}

export function Dashboard() {
  const navigate = useNavigate()
  const toast = useToast()
  const { session } = useSession()
  const [wizard, setWizard] = useState<Template | null>(null)

  const instances = useLive(() => api.listInstances(), { intervalMs: CADENCE.fast })
  const shared = useLive(() => api.listSharedInstances(), { intervalMs: CADENCE.slow })
  const cluster = useLive(() => api.getCluster(), { intervalMs: CADENCE.slow })
  const templates = useLive(() => api.listTemplates(), { intervalMs: 600_000 })
  const quota = useLive(() => api.getQuota(), { intervalMs: CADENCE.slow })
  const [quotaOpen, setQuotaOpen] = useState(false)

  const { favoriteIds } = useFavorites(session?.user?.username ?? '')
  const active = (instances.data ?? []).filter((i) => i.state !== 'stopped' && i.state !== 'failed')
  const allTemplates = templates.data ?? []
  const starred = allTemplates.filter((t) => favoriteIds.includes(t.id))
  // Show favorites if any, else a sensible default set.
  const favorites = (starred.length ? starred : allTemplates.filter((t) => t.enabled)).slice(0, 4)

  function openInstance(i: Instance) {
    if (i.url) window.open(i.url, '_blank', 'noopener')
  }
  async function stopInstance(i: Instance) {
    await api.stopInstance(i.id)
    toast.push(`Stopped ${i.name}`, 'info')
    instances.refresh()
  }
  async function extendInstance(i: Instance) {
    try {
      const next = await api.extendInstance(i.id, 720)
      toast.push(`Extended ${i.name} to ${Math.round((next.timeLimitMinutes ?? 0) / 60)}h total`, 'ok')
      instances.refresh()
    } catch (e) {
      toast.push(e instanceof Error ? e.message : 'Could not extend', 'err')
    }
  }

  const firstName = session?.user?.displayName?.split(' ')[0] ?? 'there'

  return (
    <>
      <PageHeader
        title={`Welcome back, ${firstName}`}
        subtitle="Launch an app or jump back into a running session."
        actions={
          <Button variant="primary" icon="apps-2-line" onClick={() => navigate('/catalog')}>
            Browse apps
          </Button>
        }
      />

      {/* Cluster health */}
      <Card className="mb-6 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Icon name="pulse-line" className="text-brand" /> Cluster health
          </h2>
          {cluster.data && (
            <span className="tabular text-2xs text-ink-muted">
              {cluster.data.totals.cpuUsed}/{cluster.data.totals.cpuTotal} CPU |{' '}
              {gb(cluster.data.totals.memUsedMb)}/{gb(cluster.data.totals.memTotalMb)}
            </span>
          )}
        </div>
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          {(cluster.data?.nodes ?? []).map((n) => (
            <div key={n.name} className="space-y-2">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-ink">{n.name}</span>
                {n.controlPlane ? (
                  <Badge tone="blue">control plane</Badge>
                ) : (
                  <Badge tone={n.state === 'up' ? 'ok' : 'warn'}>{n.state}</Badge>
                )}
              </div>
              <ResourceGauge label="CPU" used={n.cpuUsed} total={n.cpuTotal} />
              <ResourceGauge label="RAM" used={Math.round(n.memUsedMb / 1024)} total={Math.round(n.memTotalMb / 1024)} unit=" GB" />
            </div>
          ))}
          {!cluster.data && <p className="text-sm text-ink-muted">Loading cluster...</p>}
        </div>
      </Card>

      {/* Quick launch */}
      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold text-ink">Quick launch</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {favorites.map((t) => (
            <button
              key={t.id}
              onClick={() => setWizard(t)}
              className="flex items-center gap-3 rounded-md border border-border bg-surface p-3 text-left transition-all hover:border-brand/50 hover:shadow-2"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-md bg-gradient-to-br from-brand to-brand-strong text-white">
                <Icon name={t.icon} className="text-lg" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-ink">{t.name}</span>
                <span className="tabular block text-2xs text-ink-muted">{t.defaults.cpus} CPU | {gb(t.defaults.memoryMb)}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* Your apps */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            Your running apps
            {quota.data && (
              <span className={`tabular text-2xs font-normal ${quota.data.used >= quota.data.limit ? 'text-warn' : 'text-ink-muted'}`}>
                {quota.data.used}/{quota.data.limit} of your quota
              </span>
            )}
          </h2>
          <div className="flex items-center gap-2">
            {instances.stale && <Badge tone="warn">data delayed</Badge>}
            {quota.data && (quota.data.pendingRequest ? (
              <Badge tone="warn">quota request pending{quota.data.pendingRequest.requested ? ` (${quota.data.pendingRequest.requested})` : ''}</Badge>
            ) : quota.data.limit < quota.data.max ? (
              <button onClick={() => setQuotaOpen(true)} className="text-2xs text-brand hover:underline">
                <Icon name="add-circle-line" className="mr-0.5" />Request more
              </button>
            ) : null)}
          </div>
        </div>
        {instances.loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        ) : active.length === 0 ? (
          <EmptyState
            image="/brand/empty-state.png"
            title="No apps running yet"
            description="Launch JupyterLab, RStudio, or any template to start analyzing. It runs on its own slice of the cluster."
            action={<Button variant="primary" icon="apps-2-line" onClick={() => navigate('/catalog')}>Browse the catalog</Button>}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {active.map((i) => (
              <InstanceCard key={i.id} instance={i} onOpen={openInstance} onStop={stopInstance} onExtend={extendInstance} onDetail={(x) => navigate(`/app/${x.id}`)} />
            ))}
          </div>
        )}
      </section>

      {(shared.data ?? []).length > 0 && (
        <section className="mt-6">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
            <Icon name="group-line" className="text-brand" /> Shared with you
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(shared.data ?? []).map((i) => (
              <Card key={i.id} className="flex items-center gap-3 p-4">
                <span className="flex h-9 w-9 items-center justify-center rounded-md bg-gradient-to-br from-brand to-brand-strong text-white">
                  <Icon name={i.icon} className="text-lg" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{i.name}</span>
                  <span className="block truncate text-2xs text-ink-muted">{i.templateName} | {i.owner}</span>
                </span>
                <Button size="sm" variant="secondary" icon="external-link-line" disabled={!i.url} onClick={() => i.url && window.open(i.url, '_blank', 'noopener')}>Open</Button>
              </Card>
            ))}
          </div>
        </section>
      )}

      <LaunchWizard template={wizard} onClose={() => setWizard(null)} onLaunched={() => instances.refresh()} />
      {quota.data && (
        <QuotaRequestModal quota={quota.data} open={quotaOpen} onClose={() => setQuotaOpen(false)} onSent={() => quota.refresh()} />
      )}
    </>
  )
}
