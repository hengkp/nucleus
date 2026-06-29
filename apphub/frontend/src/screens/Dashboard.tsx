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
import { SkeletonCard } from '@/components/Skeleton'
import { EmptyState } from '@/components/EmptyState'
import { useLive, CADENCE } from '@/lib/live'
import { api } from '@/lib/api'
import { useSession } from '@/lib/session'
import { useFavorites } from '@/lib/favorites'
import { useToast } from '@/lib/toast'
import { gb } from '@/lib/format'
import type { Instance, Template } from '@/lib/types'

export function Dashboard() {
  const navigate = useNavigate()
  const toast = useToast()
  const { session } = useSession()
  const [wizard, setWizard] = useState<Template | null>(null)

  const instances = useLive(() => api.listInstances(), { intervalMs: CADENCE.fast })
  const shared = useLive(() => api.listSharedInstances(), { intervalMs: CADENCE.slow })
  const cluster = useLive(() => api.getCluster(), { intervalMs: CADENCE.slow })
  const templates = useLive(() => api.listTemplates(), { intervalMs: 600_000 })

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
          <h2 className="text-sm font-semibold text-ink">Your running apps</h2>
          {instances.stale && <Badge tone="warn">data delayed</Badge>}
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
    </>
  )
}
