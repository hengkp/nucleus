import { Link, useNavigate, useParams } from 'react-router-dom'
import { Card } from '@/components/Card'
import { Button } from '@/components/Button'
import { Icon } from '@/components/Icon'
import { Badge } from '@/components/Badge'
import { StatusDot } from '@/components/StatusDot'
import { Skeleton } from '@/components/Skeleton'
import { EmptyState } from '@/components/EmptyState'
import { useLive, CADENCE } from '@/lib/live'
import { api } from '@/lib/api'
import { useToast } from '@/lib/toast'
import { gb, remaining } from '@/lib/format'

export function InstanceDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const inst = useLive(() => api.getInstance(id), { intervalMs: CADENCE.fast })
  const logs = useLive(() => api.getInstanceLogs(id), { intervalMs: CADENCE.fast })
  const i = inst.data

  if (inst.loading) return <Skeleton className="h-40 w-full" />
  if (!i) return <EmptyState icon="error-warning-line" title="Instance not found" action={<Button onClick={() => navigate('/')}>Back to dashboard</Button>} />

  const live = i.state === 'running'
  const openable = !!i.url && (i.state === 'running' || i.state === 'expiring')

  async function stop() {
    await api.stopInstance(id)
    toast.push('Stopping...', 'info')
    inst.refresh()
  }
  async function extend() {
    await api.extendInstance(id, 120)
    toast.push('Extended by 2 hours', 'ok')
    inst.refresh()
  }

  const Meta = ({ icon, label, value }: { icon: string; label: string; value: string }) => (
    <div className="flex items-center gap-2.5">
      <Icon name={icon} className="text-ink-muted" />
      <div>
        <p className="text-2xs text-ink-muted">{label}</p>
        <p className="tabular text-sm text-ink">{value}</p>
      </div>
    </div>
  )

  return (
    <>
      <Link to="/" className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
        <Icon name="arrow-left-line" /> Dashboard
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-md bg-gradient-to-br from-brand to-brand-strong text-white">
            <Icon name={i.icon} className="text-2xl" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-ink">{i.name}</h1>
            <p className="text-sm text-ink-muted">{i.templateName}</p>
            <div className="mt-1.5"><StatusDot state={i.state} /></div>
          </div>
        </div>
        <div className="flex gap-2">
          {i.timeLimitMinutes !== null && live && <Button variant="secondary" icon="timer-line" onClick={extend}>Extend 2h</Button>}
          {i.state !== 'stopped' && <Button variant="danger" icon="stop-circle-line" onClick={stop}>Stop</Button>}
          <Button variant="primary" icon="external-link-line" disabled={!openable} onClick={() => i.url && window.open(i.url, '_blank', 'noopener')}>
            Open app
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-1">
          <h2 className="mb-3 text-sm font-semibold text-ink">Details</h2>
          <div className="space-y-3">
            <Meta icon="server-line" label="Node" value={i.node ?? '-'} />
            <Meta icon="cpu-line" label="CPU" value={`${i.cpus} cores`} />
            <Meta icon="ram-2-line" label="Memory" value={gb(i.memoryMb)} />
            <Meta icon="timer-line" label="Time" value={remaining(i.elapsedMinutes, i.timeLimitMinutes)} />
            <Meta icon={i.visibility === 'private' ? 'lock-line' : 'group-line'} label="Visibility" value={i.visibility} />
          </div>
          {i.url && (
            <div className="mt-4 rounded-md bg-surface-2/60 p-2.5">
              <p className="text-2xs text-ink-muted">URL</p>
              <p className="tabular truncate text-xs text-brand">{i.url}</p>
            </div>
          )}
        </Card>

        <Card className="overflow-hidden lg:col-span-2">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Icon name="terminal-line" className="text-ink-muted" /> Logs
            </h2>
            {i.state === 'running' && <Badge tone="ok">live</Badge>}
          </div>
          <pre className="tabular max-h-80 overflow-auto bg-[var(--surface-2)] p-4 text-xs leading-relaxed text-ink-muted">
            {logs.data ?? 'Loading logs...'}
          </pre>
        </Card>
      </div>
    </>
  )
}
