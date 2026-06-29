import { useMemo, useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { TemplateCard } from '@/components/TemplateCard'
import { LaunchWizard } from '@/components/LaunchWizard'
import { Modal } from '@/components/Modal'
import { Field } from '@/components/Field'
import { Input } from '@/components/Input'
import { FolderInput } from '@/components/FolderInput'
import { IconPicker } from '@/components/IconPicker'
import { Icon } from '@/components/Icon'
import { Card } from '@/components/Card'
import { Button } from '@/components/Button'
import { Badge } from '@/components/Badge'
import { SkeletonCard } from '@/components/Skeleton'
import { EmptyState } from '@/components/EmptyState'
import { cn } from '@/lib/cn'
import { useLive } from '@/lib/live'
import { api } from '@/lib/api'
import { useFavorites } from '@/lib/favorites'
import { useSession } from '@/lib/session'
import { useToast } from '@/lib/toast'
import { useConfirm } from '@/lib/confirm'
import type { NewTemplate, Template, TemplateCategory } from '@/lib/types'

const ORDER: TemplateCategory[] = ['Notebook', 'App', 'Tooling', 'Static']
const CATEGORIES: TemplateCategory[] = ['Notebook', 'App', 'Tooling', 'Static']

function NewTemplateModal({
  open,
  onClose,
  bases,
  isAdmin,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  bases: Template[]
  isAdmin: boolean
  onCreated: () => void
}) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [base, setBase] = useState(bases[0]?.id ?? '')
  const [category, setCategory] = useState<TemplateCategory>('App')
  const [icon, setIcon] = useState('')
  const [description, setDescription] = useState('')
  const [scope, setScope] = useState<'shared' | 'personal'>('personal')
  const [entrypoint, setEntrypoint] = useState('')
  const [command, setCommand] = useState('')
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const baseTpl = bases.find((b) => b.id === base)
  const byo = !!baseTpl?.byoImage

  async function save() {
    if (!name.trim()) { toast.push('Give the template a name', 'err'); return }
    if (!base) { toast.push('Pick a base app', 'err'); return }
    setBusy(true)
    try {
      const def: NewTemplate = {
        name: name.trim(),
        base,
        scope: isAdmin ? scope : 'personal',
        category,
        icon: icon.trim() || undefined,
        description: description.trim() || undefined,
        entrypoint: entrypoint.trim() || undefined,
        command: command.trim() || undefined,
        folder: folder.trim() || undefined,
      }
      await api.createTemplate(def)
      toast.push(`Saved template "${def.name}"`, 'ok')
      setName(''); setIcon(''); setDescription(''); setEntrypoint(''); setCommand(''); setFolder('')
      onCreated()
      onClose()
    } catch (e) {
      toast.push(e instanceof Error ? e.message : 'Could not save template', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New catalog template" size="md">
      <div className="space-y-4 p-5">
        <p className="text-xs text-ink-muted">A template is a saved launch preset on top of a base app. It appears in the catalog so you (or everyone) can launch it in one click.</p>
        <Field label="Template name">
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My lab dashboard" maxLength={60} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Base app (execution engine)">
            {(id) => (
              <select id={id} value={base} onChange={(e) => setBase(e.target.value)} className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand">
                {bases.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            )}
          </Field>
          <Field label="Category">
            {(id) => (
              <select id={id} value={category} onChange={(e) => setCategory(e.target.value as TemplateCategory)} className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand">
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
          </Field>
        </div>
        <Field label="Description (optional)">
          {(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={baseTpl?.description} maxLength={240} />}
        </Field>
        <Field label="Folder in locker (optional)" hint="Where the app runs or serves from. Pick from your own folders.">
          {(id) => <FolderInput id={id} value={folder} onChange={setFolder} placeholder="projects/my-site" />}
        </Field>
        <Field label="Icon (optional)">
          {() => <IconPicker value={icon} onChange={setIcon} placeholder={baseTpl?.icon ? `default: ${baseTpl.icon}` : undefined} />}
        </Field>
        {(baseTpl?.needsEntrypoint || byo) && (
          <Field label={byo ? 'Container image (.sif) path in your locker' : 'Entry file (optional)'} hint={byo ? 'For example containers/myapp.sif. The image must already be in your locker.' : undefined}>
            {(id) => <Input id={id} value={entrypoint} onChange={(e) => setEntrypoint(e.target.value)} placeholder={byo ? 'containers/myapp.sif' : 'app.py'} />}
          </Field>
        )}
        {(baseTpl?.kind === 'batch' || byo) && (
          <Field
            label={byo ? (baseTpl?.kind === 'batch' ? 'Command to run in the container' : 'Start command (must listen on $PORT)') : 'Command (optional)'}
            hint={byo ? (baseTpl?.kind === 'batch' ? 'For example python /opt/run.py' : 'For example python -m http.server $PORT --bind 0.0.0.0') : undefined}
          >
            {(id) => <Input id={id} value={command} onChange={(e) => setCommand(e.target.value)} placeholder={byo ? (baseTpl?.kind === 'batch' ? 'python /opt/run.py' : 'streamlit run app.py --server.port $PORT --server.address 0.0.0.0') : 'python train.py'} />}
          </Field>
        )}
        {isAdmin && (
          <div className="space-y-1.5">
            <span className="block text-xs font-medium text-ink">Who can see it</span>
            <div className="flex gap-2">
              {(['personal', 'shared'] as const).map((s) => (
                <button key={s} onClick={() => setScope(s)} className={cn('flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-medium capitalize', scope === s ? 'border-brand bg-brand-tint text-brand' : 'border-border text-ink-muted hover:text-ink')}>
                  <Icon name={s === 'shared' ? 'group-line' : 'lock-line'} />{s === 'shared' ? 'Everyone (shared)' : 'Only me'}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon="save-line" loading={busy} onClick={save}>Save template</Button>
      </div>
    </Modal>
  )
}

export function Catalog() {
  const templates = useLive(() => api.listTemplates(), { intervalMs: 600_000 })
  const { session } = useSession()
  const toast = useToast()
  const { confirm, prompt } = useConfirm()
  const me = session?.user?.username
  const isAdmin = session?.user?.role === 'admin'
  const { isFavorite, toggle } = useFavorites(me ?? '')
  const [q, setQ] = useState('')
  const [wizard, setWizard] = useState<Template | null>(null)
  const [creating, setCreating] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const canHost = isAdmin || session?.user?.role === 'power' || !!session?.user?.power

  const all = templates.data ?? []
  const bases = all.filter((t) => !t.custom && t.enabled && t.id !== 'host-app')
  const mine = all.filter((t) => t.custom && (t.owner === me || isAdmin))

  const groups = useMemo(() => {
    const s = q.trim().toLowerCase()
    const list = all.filter(
      (t) => t.enabled && !t.byoImage && (!s || t.name.toLowerCase().includes(s) || t.description.toLowerCase().includes(s) || t.preinstalled?.some((p) => p.toLowerCase().includes(s))),
    )
    return ORDER.map((cat) => ({ cat, items: list.filter((t) => t.category === cat) })).filter((g) => g.items.length)
  }, [all, q])

  async function requestHosting() {
    const detail = (await prompt({ title: 'Request a persistent app', message: 'Tell the admins what you want to host so they can approve the persistent (never-expiring) track.', label: 'Describe the app', placeholder: 'image, ports, and why you need it', multiline: true }))?.trim()
    if (!detail) return
    setRequesting(true)
    try { await api.createRequest(detail); toast.push('Request sent to the admins for approval.', 'ok') }
    catch (e) { toast.push(e instanceof Error ? e.message : 'Could not send request', 'err') }
    finally { setRequesting(false) }
  }
  async function removeTemplate(t: Template) {
    const ok = await confirm({ title: 'Delete template', message: <>Delete the template <b className="text-ink">{t.name}</b>? This removes it from the catalog.</>, confirmLabel: 'Delete', tone: 'danger' })
    if (!ok) return
    try { await api.deleteTemplate(t.id); toast.push('Template deleted', 'ok'); templates.refresh() }
    catch (e) { toast.push(e instanceof Error ? e.message : 'Delete failed', 'err') }
  }

  return (
    <>
      <PageHeader
        title="App catalog"
        subtitle="Pick a template. Each one is preconfigured for common analysis tasks."
        actions={<Button variant="primary" icon="add-line" onClick={() => setCreating(true)}>New template</Button>}
      />

      <div className="relative mb-6 max-w-md">
        <Icon name="search-line" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
        <Input aria-label="Search apps and packages" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search apps, packages (e.g. seurat)..." className="pl-9" />
      </div>

      {templates.loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : groups.length === 0 ? (
        <EmptyState icon="search-line" title="No apps match" description="Try a different search term." />
      ) : (
        <div className="space-y-8">
          {groups.map((g) => (
            <section key={g.cat}>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">{g.cat}</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {g.items.map((t) => (
                  <TemplateCard
                    key={t.id}
                    template={t}
                    onLaunch={setWizard}
                    isFavorite={isFavorite(t.id)}
                    onToggleFavorite={(x) => toggle(x.id)}
                    onDelete={t.custom && (t.owner === me || isAdmin) ? removeTemplate : undefined}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Manage custom templates */}
      {mine.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">Your templates</h2>
          <Card className="overflow-hidden">
            {mine.map((t) => (
              <div key={t.id} className="flex items-center gap-3 border-b border-border px-4 py-2.5 text-sm last:border-0">
                <Icon name={t.icon} className="text-ink-muted" />
                <span className="min-w-0 flex-1 truncate text-ink">{t.name}</span>
                <Badge tone={t.scope === 'shared' ? 'blue' : 'neutral'}>{t.scope}</Badge>
                <span className="hidden text-2xs text-ink-muted sm:inline">base: {t.base}</span>
                <button title="Delete template" onClick={() => removeTemplate(t)} className="text-ink-muted hover:text-err"><Icon name="delete-bin-6-line" /></button>
              </div>
            ))}
          </Card>
        </section>
      )}

      {/* Host-your-own request */}
      <Card className="mt-8 flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-md bg-brand-tint text-brand"><Icon name="box-3-line" className="text-xl" /></div>
          <div>
            <p className="text-sm font-semibold text-ink">Need a long-running or persistent app?</p>
            <p className="text-xs text-ink-muted">Apps top up in 12h steps (up to 7 days). For a never-expiring hosted service, request the persistent track, which is a one-time admin approval.</p>
          </div>
        </div>
        {canHost ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ok"><Icon name="checkbox-circle-fill" /> You're approved for persistent apps</span>
        ) : (
          <Button variant="secondary" icon="send-plane-line" loading={requesting} onClick={requestHosting}>Request access</Button>
        )}
      </Card>

      <NewTemplateModal open={creating} onClose={() => setCreating(false)} bases={bases} isAdmin={isAdmin} onCreated={() => templates.refresh()} />
      <LaunchWizard template={wizard} onClose={() => setWizard(null)} onLaunched={() => { /* dashboard refetches */ }} />
    </>
  )
}
