import { useEffect, useMemo, useState, type ChangeEvent, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { Card } from '@/components/Card'
import { Icon } from '@/components/Icon'
import { Button } from '@/components/Button'
import { Badge } from '@/components/Badge'
import { Input } from '@/components/Input'
import { Field } from '@/components/Field'
import { FolderInput } from '@/components/FolderInput'
import { FileBrowser } from '@/components/FileBrowser'
import { Slider } from '@/components/Slider'
import { Skeleton } from '@/components/Skeleton'
import { EmptyState } from '@/components/EmptyState'
import { cn } from '@/lib/cn'
import { useLive, CADENCE } from '@/lib/live'
import { api } from '@/lib/api'
import { useToast } from '@/lib/toast'
import { useConfirm } from '@/lib/confirm'
import type { Pipeline, Instance, InstanceState, PipelineProbe } from '@/lib/types'

// A param group rendered from nextflow_schema.json (the same file nf-core launch reads).
type Prop = Record<string, unknown>
type Group = { key: string; title: string; description?: string; required: string[]; props: [string, Prop][] }

// Runtime presets (mirrors the app launcher's time chips).
const RUNTIME_PRESETS: [string, number][] = [['4h', 4], ['12h', 12], ['1 day', 24], ['2 days', 48], ['3 days', 72], ['7 days', 168]]
const MAX_CPU = 112
const MAX_GB = 503
// Icons a user can pick for an added pipeline (valid Remix Icon names).
const PIPELINE_ICONS = ['flow-chart', 'dna-line', 'git-branch-line', 'bubble-chart-line', 'microscope-line', 'test-tube-line', 'virus-line', 'leaf-line', 'bar-chart-box-line', 'database-2-line']

function groupsFromSchema(schema: Record<string, unknown> | null): Group[] {
  if (!schema) return []
  const defs = ((schema.$defs as Record<string, Prop>) || (schema.definitions as Record<string, Prop>) || {})
  const out: Group[] = []
  for (const [key, g] of Object.entries(defs)) {
    const props = Object.entries(((g as Prop).properties as Record<string, Prop>) || {})
    if (!props.length) continue
    out.push({ key, title: (g.title as string) || key, description: g.description as string, required: ((g.required as string[]) || []), props })
  }
  return out
}
function defaultsFromSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const v: Record<string, unknown> = {}
  for (const g of groupsFromSchema(schema)) for (const [name, def] of g.props) {
    if (def.default !== undefined) v[name] = def.default
  }
  return v
}

const STATE_TONE: Record<InstanceState, 'ok' | 'warn' | 'neutral' | 'err'> = {
  queued: 'warn', starting: 'warn', running: 'ok', expiring: 'warn', stopped: 'neutral', failed: 'err',
}

export function Pipelines() {
  const nav = useNavigate()
  const toast = useToast()
  const { confirm } = useConfirm()
  const pipelines = useLive(() => api.listPipelines(), { intervalMs: CADENCE.slow })
  const runs = useLive(() => api.listInstances(), { intervalMs: CADENCE.fast })
  const [sel, setSel] = useState<Pipeline | null>(null)
  const [schema, setSchema] = useState<Record<string, unknown> | null>(null)
  const [schemaErr, setSchemaErr] = useState<string>()
  const [loadingSchema, setLoadingSchema] = useState(false)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [runName, setRunName] = useState('')
  const [outdir, setOutdir] = useState('')
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [profiles, setProfiles] = useState('')
  const [configText, setConfigText] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [np, setNp] = useState({ name: '', repo: '', revision: '', icon: 'flow-chart', schemaUrl: '' })
  const [addBusy, setAddBusy] = useState(false)
  const [probe, setProbe] = useState<PipelineProbe | null>(null)
  const [probing, setProbing] = useState(false)
  const [query, setQuery] = useState('')
  const [cpus, setCpus] = useState(0)
  const [memGb, setMemGb] = useState(0)
  const [hours, setHours] = useState(0)
  const [pendingImport, setPendingImport] = useState<Record<string, unknown> | null>(null)
  const [configFileName, setConfigFileName] = useState('')
  const [help, setHelp] = useState<{ title: string; desc: string; required?: string[] } | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [browseParam, setBrowseParam] = useState<{ name: string; mode: 'file' | 'dir' } | null>(null)

  useEffect(() => {
    if (!sel) return
    let cancelled = false
    setSchema(null); setSchemaErr(undefined); setValues({}); setLoadingSchema(true); setHelp(null); setConfigFileName('')
    api.getPipelineSchema(sel.id)
      .then((s) => {
        if (cancelled) return
        setSchema(s)
        const defs = defaultsFromSchema(s)
        // Apply a config that was imported FOR this pipeline; otherwise start from defaults.
        const imp = pendingImport && pendingImport.pipelineId === sel.id ? pendingImport : null
        setValues({ ...defs, ...((imp?.params as Record<string, unknown>) || {}) })
        setRunName(imp ? String(imp.runName || '') : '')
        setOutdir(imp ? String(imp.outdir || '') : '')
        setProfiles(imp ? String(imp.profiles || '') : '')
        setConfigText(imp ? String(imp.configText || '') : '')
        setCpus(imp?.cpus ? Number(imp.cpus) : sel.defaults.cpus)
        setMemGb(imp?.memoryMb ? Math.round(Number(imp.memoryMb) / 1024) : Math.round(sel.defaults.memoryMb / 1024))
        setHours(imp?.timeMinutes ? Math.max(1, Math.round(Number(imp.timeMinutes) / 60)) : Math.max(1, Math.round(sel.defaults.timeMinutes / 60)))
        if (imp) setPendingImport(null)
      })
      .catch((e) => { if (!cancelled) setSchemaErr(e instanceof Error ? e.message : 'Could not load parameters') })
      .finally(() => { if (!cancelled) setLoadingSchema(false) })
    return () => { cancelled = true }
  }, [sel?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Live readiness check while adding a pipeline: does the repo publish a buildable param form?
  useEffect(() => {
    if (!showAdd) return
    const repo = np.repo.trim()
    setProbe(null)
    if (!repo) { setProbing(false); return }
    setProbing(true)
    let cancelled = false
    const t = setTimeout(async () => {
      try { const r = await api.probePipeline(repo, np.revision.trim(), np.schemaUrl.trim()); if (!cancelled) setProbe(r) }
      catch { if (!cancelled) setProbe(null) }
      finally { if (!cancelled) setProbing(false) }
    }, 500)
    return () => { cancelled = true; clearTimeout(t) }
  }, [showAdd, np.repo, np.revision, np.schemaUrl])

  const groups = useMemo(() => groupsFromSchema(schema), [schema])
  const required = useMemo(() => groups.flatMap((g) => g.required), [groups])
  const set = (name: string, v: unknown) => setValues((p) => ({ ...p, [name]: v }))
  const toggleGroup = (k: string) => setOpenGroups((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })
  // Open the first section + any with required fields by default (others collapsed, nf-core style).
  useEffect(() => {
    setOpenGroups(new Set(groups.filter((g, i) => i === 0 || g.required.length > 0).map((g) => g.key)))
  }, [groups])

  // Params the user actually set (non-empty, non-default-unless-required) -> nextflow params.
  function buildParams() {
    const params: Record<string, unknown> = {}
    for (const g of groups) for (const [name, def] of g.props) {
      const v = values[name]
      if (v === undefined || v === '') continue
      if (v === def.default && !required.includes(name)) continue
      params[name] = v
    }
    return params
  }

  async function launch() {
    if (!sel) return
    const missing = required.filter((r) => values[r] === undefined || values[r] === '')
    if (missing.length) { toast.push(`Please fill in: ${missing.join(', ')}`, 'err'); return }
    setBusy(true)
    try {
      const inst = await api.launchPipeline({
        pipelineId: sel.id,
        runName: runName.trim() || undefined,
        outdir: outdir.trim() || undefined,
        params: buildParams(),
        profiles: profiles.trim() || undefined,
        configText: configText.trim() || undefined,
        cpus, memoryMb: memGb * 1024, timeMinutes: hours * 60,
      })
      toast.push(`Run "${inst.name}" submitted. Track it on the Dashboard and Job queue.`, 'ok')
      nav('/')
    } catch (e) {
      toast.push(e instanceof Error ? e.message : 'Launch failed', 'err')
    } finally { setBusy(false) }
  }

  // Export the whole form as a reusable JSON; import prefills it (selecting the pipeline first
  // if needed). The "params" block is also a valid nextflow -params-file on its own.
  function exportConfig() {
    if (!sel) return
    const cfg = { pipelineId: sel.id, repo: sel.repo, revision: sel.revision, runName: runName.trim() || undefined, outdir: outdir.trim() || undefined, params: buildParams(), profiles: profiles.trim() || undefined, configText: configText.trim() || undefined, cpus, memoryMb: memGb * 1024, timeMinutes: hours * 60 }
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${runName.trim() || sel.id}.apphub-pipeline.json`
    a.click()
    URL.revokeObjectURL(a.href)
    toast.push('Config exported', 'ok')
  }
  function importConfig(json: Record<string, unknown>) {
    const id = String(json?.pipelineId || '')
    const p = (pipelines.data ?? []).find((x) => x.id === id)
    if (!p) { toast.push('That config is for a pipeline not in your catalog, add it first.', 'err'); return }
    if (sel && sel.id === p.id) {
      setValues((v) => ({ ...v, ...((json.params as Record<string, unknown>) || {}) }))
      setRunName(String(json.runName || '')); setOutdir(String(json.outdir || '')); setProfiles(String(json.profiles || '')); setConfigText(String(json.configText || '')); setConfigFileName('')
      if (json.cpus) setCpus(Number(json.cpus))
      if (json.memoryMb) setMemGb(Math.round(Number(json.memoryMb) / 1024))
      if (json.timeMinutes) setHours(Math.max(1, Math.round(Number(json.timeMinutes) / 60)))
      toast.push('Config imported', 'ok')
    } else {
      setPendingImport(json); setSel(p); toast.push(`Config imported into ${p.name}`, 'ok')
    }
  }
  function onImportFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    f.text().then((t) => { try { importConfig(JSON.parse(t)) } catch { toast.push('That is not a valid config file', 'err') } })
    e.target.value = ''
  }

  async function addPipeline() {
    if (!np.name.trim() || !np.repo.trim()) { toast.push('Name and repository are required', 'err'); return }
    setAddBusy(true)
    try {
      const p = await api.addPipeline({ name: np.name.trim(), repo: np.repo.trim(), revision: np.revision.trim() || undefined, icon: np.icon, schemaUrl: np.schemaUrl.trim() || undefined })
      toast.push(`Added ${p.name}`, 'ok'); setShowAdd(false); setNp({ name: '', repo: '', revision: '', icon: 'flow-chart', schemaUrl: '' }); setProbe(null); pipelines.refresh(); setSel(p)
    } catch (e) { toast.push(e instanceof Error ? e.message : 'Could not add pipeline', 'err') }
    finally { setAddBusy(false) }
  }
  async function removePipeline(p: Pipeline, ev: MouseEvent) {
    ev.stopPropagation()
    const ok = await confirm({ title: 'Remove pipeline', message: <>Remove <b className="text-ink">{p.name}</b> from your pipelines? This only takes it out of your catalog, and it does not delete any run output.</>, confirmLabel: 'Remove', tone: 'danger' })
    if (!ok) return
    try { await api.removePipeline(p.id); toast.push(`Removed ${p.name}`, 'info'); pipelines.refresh() }
    catch (e) { toast.push(e instanceof Error ? e.message : 'Remove failed', 'err') }
  }

  // Themed config-file picker (replaces the browser's default "No file chosen").
  function onConfigFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    f.text().then((t) => { setConfigText(t); setConfigFileName(f.name) })
    e.target.value = ''
  }
  // Set the right-hand help panel for whichever section the user hovers / focuses.
  const helpFor = (title: string, desc: string, req?: string[]) => () => setHelp({ title, desc, required: req })

  function renderField(name: string, def: Prop) {
    const type = def.type as string
    const val = values[name]
    const desc = (def.description as string) || (def.help_text as string) || ''
    const req = required.includes(name)
    const label = `${name}${req ? ' *' : ''}`
    if (type === 'boolean') {
      return (
        <label key={name} className="flex cursor-pointer items-start gap-2.5 py-1.5">
          <input type="checkbox" checked={!!val} onChange={(e) => set(name, e.target.checked)} className="mt-0.5 h-4 w-4 accent-brand" />
          <span className="text-xs"><span className="font-medium text-ink">{name}</span>{desc && <span className="block text-ink-muted">{desc}</span>}</span>
        </label>
      )
    }
    const enumVals = def.enum as (string | number)[] | undefined
    const fmt = def.format as string | undefined
    const isPath = type === 'string' && (fmt === 'file-path' || fmt === 'directory-path' || fmt === 'path')
    return (
      <Field key={name} label={label} hint={desc}>
        {(id) =>
          enumVals ? (
            <select id={id} value={String(val ?? '')} onChange={(e) => set(name, e.target.value)} className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand">
              <option value="">(default)</option>
              {enumVals.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
            </select>
          ) : type === 'integer' || type === 'number' ? (
            <Input id={id} type="number" value={val === undefined ? '' : String(val)} onChange={(e) => set(name, e.target.value === '' ? '' : Number(e.target.value))} />
          ) : isPath ? (
            <div className="flex items-center gap-2">
              <Input id={id} value={val === undefined ? '' : String(val)} placeholder={def.default !== undefined ? String(def.default) : '/mnt/... or a path/URL'} onChange={(e) => set(name, e.target.value)} />
              <Button type="button" size="sm" variant="secondary" icon="folder-open-line" onClick={() => setBrowseParam({ name, mode: fmt === 'directory-path' ? 'dir' : 'file' })}>Browse</Button>
            </div>
          ) : (
            <Input id={id} value={val === undefined ? '' : String(val)} placeholder={def.default !== undefined ? String(def.default) : ''} onChange={(e) => set(name, e.target.value)} />
          )
        }
      </Field>
    )
  }

  const nfRuns = (runs.data ?? []).filter((i) => i.templateId === 'nextflow')

  // ----- detail (a pipeline is selected) -----
  if (sel) {
    const defaultHelp: { title: string; desc: string; required?: string[] } = {
      title: 'Set up your run',
      desc: 'Hover or focus any section to see what it controls. Complete the sections marked required, then click Launch run. Use Import config to prefill everything from a saved run.',
    }
    const shown = help ?? defaultHelp
    const hResources = helpFor('Resources', 'The SLURM allocation your run gets. Nextflow runs the whole pipeline inside this one allocation and schedules tasks within it, so give it enough CPU and memory for your largest step. Max runtime is a ceiling: the job stops if it runs over.')
    const hRun = helpFor('Run details', 'Name this run so it is easy to find on the Dashboard and Job queue, and choose where results land in your locker. Leave them blank to use the pipeline name and the default nextflow-runs/ folder.')
    const hParamsEmpty = helpFor('Parameters', 'This pipeline does not publish a parameter form. Set any options with a custom config below, then launch.')
    const hConfig = helpFor('Profiles & custom config', 'Profiles are named -profile presets from the pipeline (for example, test for nf-core test data). The custom config layers on top of the lab defaults, so you can override process resources, switch the executor, or pass extra params.')
    // Section navigation + readiness (nf-core launch style): jump links, per-section completion,
    // an overall progress bar, "Show hidden params", and a launch shortcut.
    const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    // The page scrolls inside <main id="app-scroll">, not the window — scroll that container to the top.
    const backToTop = () => {
      const c = document.getElementById('app-scroll')
      if (c) c.scrollTo({ top: 0, behavior: 'smooth' })
      else document.getElementById('pipeline-top')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    const groupComplete = (g: Group) => g.required.every((r) => values[r] !== undefined && values[r] !== '')
    const reqFilled = required.filter((r) => values[r] !== undefined && values[r] !== '').length
    const reqTotal = required.length
    const ready = reqTotal === 0 || reqFilled === reqTotal
    const hiddenCount = groups.reduce((n, g) => n + g.props.filter(([, d]) => d.hidden).length, 0)
    const shownGroups = groups.filter((g) => g.props.some(([, d]) => showHidden || !d.hidden))
    const toc: { id: string; title: string; status: 'ok' | 'todo' | 'opt' }[] = [
      { id: 'sec-resources', title: 'Resources', status: 'ok' },
      { id: 'sec-run', title: 'Run details', status: 'opt' },
      ...shownGroups.map((g) => ({ id: `sec-${g.key}`, title: g.title, status: (g.required.length ? (groupComplete(g) ? 'ok' : 'todo') : 'opt') as 'ok' | 'todo' | 'opt' })),
      { id: 'sec-config', title: 'Profiles & custom config', status: 'opt' as const },
    ]
    return (
      <>
        <button id="pipeline-top" onClick={() => setSel(null)} className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:text-brand-strong">
          <Icon name="arrow-left-line" /> All pipelines
        </button>
        <PageHeader title={sel.name} subtitle={`${sel.description}  |  rev ${sel.revision}`} />

        {loadingSchema ? (
          <div className="space-y-2"><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
        ) : schemaErr ? (
          <Card className="p-5 text-sm text-err"><Icon name="error-warning-line" className="mr-1" />{schemaErr}</Card>
        ) : (
          <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start lg:gap-6">
            {/* LEFT — the form */}
            <div className="space-y-5">
              {/* Import / Export at the top, kept apart from "Add a pipeline" so the two don't get confused. */}
              <div className="flex flex-wrap items-center justify-end gap-2">
                <input type="file" accept=".json,application/json" id="nf-import" className="hidden" onChange={onImportFile} />
                <Button size="sm" variant="ghost" icon="upload-2-line" onClick={() => document.getElementById('nf-import')?.click()}>Import config</Button>
                <Button size="sm" variant="ghost" icon="download-2-line" onClick={exportConfig}>Export config</Button>
              </div>

              {/* Resources — moved to the top (sliders, like the app launcher). */}
              <div id="sec-resources" onMouseEnter={hResources} onFocusCapture={hResources}>
                <Card className="space-y-4 p-5">
                  <div>
                    <h3 className="font-semibold text-ink">Resources</h3>
                    <p className="mt-1 text-xs text-ink-muted">The run gets this SLURM allocation, and Nextflow keeps the whole pipeline within it. Bump it up for bigger inputs.</p>
                  </div>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <Slider aria-label="CPU cores" value={Math.min(cpus, MAX_CPU)} min={1} max={MAX_CPU} onChange={setCpus} format={(v) => `${v} CPU`} maxLabel={`${MAX_CPU}`} />
                    <Slider aria-label="Memory in gigabytes" value={Math.min(memGb, MAX_GB)} min={1} max={MAX_GB} onChange={setMemGb} format={(v) => `${v} GB`} maxLabel={`${MAX_GB} GB`} />
                  </div>
                  <div className="space-y-1.5">
                    <span className="block text-xs font-medium text-ink">Max runtime</span>
                    <div role="radiogroup" aria-label="Max runtime" className="flex flex-wrap gap-2">
                      {RUNTIME_PRESETS.map(([label, h]) => (
                        <button key={h} role="radio" aria-checked={hours === h} onClick={() => setHours(h)}
                          className={cn('min-h-10 rounded-md border px-3 text-xs font-medium transition-colors', hours === h ? 'border-brand bg-brand-tint text-brand' : 'border-border text-ink-muted hover:border-brand/40 hover:text-ink')}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </Card>
              </div>

              {/* Run details */}
              <div id="sec-run" onMouseEnter={hRun} onFocusCapture={hRun}>
                <Card className="space-y-4 p-5">
                  <Field label="Run name (optional)" hint="A label for this run. Blank uses the pipeline name.">
                    {(id) => <Input id={id} value={runName} placeholder={`${sel.id}-run`} onChange={(e) => setRunName(e.target.value)} maxLength={40} />}
                  </Field>
                  <Field label="Output folder in your locker (optional)" hint="e.g. results/my-run. Blank writes under nextflow-runs/.">
                    {(id) => <FolderInput id={id} value={outdir} placeholder="results/my-run" onChange={setOutdir} />}
                  </Field>
                </Card>
              </div>

              {groups.length === 0 ? (
                <div id="sec-params" onMouseEnter={hParamsEmpty} onFocusCapture={hParamsEmpty}>
                  <Card className="space-y-2 p-5 text-sm">
                    <div className="flex items-start gap-2 text-ink">
                      <Icon name="information-line" className="mt-0.5 text-brand" />
                      <span><b>No parameter form for this pipeline.</b> It does not publish a <span className="font-mono text-xs">nextflow_schema.json</span>, so AppHub cannot build a form automatically.</span>
                    </div>
                    <p className="pl-6 text-xs text-ink-muted">You can still run it: set options with the custom config below. To get a form, add a <span className="font-mono">nextflow_schema.json</span> to the pipeline repo (<a className="text-brand hover:text-brand-strong" href="https://nf-co.re/docs/contributing/pipelines/parameters" target="_blank" rel="noreferrer">nf-core schema docs</a>), or re-add the pipeline with a direct schema URL.</p>
                  </Card>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">Parameters</span>
                    <div className="flex gap-3 text-2xs font-medium text-brand">
                      <button onClick={() => setOpenGroups(new Set(shownGroups.map((g) => g.key)))} className="hover:text-brand-strong">Expand all</button>
                      <button onClick={() => setOpenGroups(new Set())} className="hover:text-brand-strong">Collapse all</button>
                    </div>
                  </div>
                  {shownGroups.map((g) => {
                    const open = openGroups.has(g.key)
                    const visible = g.props.filter(([, d]) => showHidden || !d.hidden)
                    if (visible.length === 0) return null
                    const gh = helpFor(g.title, g.description || 'Parameters for this section of the pipeline.', g.required)
                    return (
                      <div key={g.key} id={`sec-${g.key}`} onMouseEnter={gh} onFocusCapture={gh}>
                        <Card className="overflow-hidden">
                          <button type="button" onClick={() => toggleGroup(g.key)} className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left hover:bg-surface-2/40">
                            <span className="min-w-0">
                              <span className="flex items-center gap-2 font-semibold text-ink">{g.title}{g.required.length > 0 && <Badge tone="brand">required</Badge>}</span>
                              {g.description && <span className="mt-0.5 block truncate text-xs text-ink-muted">{g.description}</span>}
                            </span>
                            <Icon name="arrow-down-s-line" className={cn('shrink-0 text-xl text-ink-muted transition-transform', open && 'rotate-180')} />
                          </button>
                          {open && <div className="space-y-3 border-t border-border px-5 py-4">{visible.map(([name, def]) => renderField(name, def))}</div>}
                        </Card>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Profiles + uploaded config (Tower-style) */}
              <div id="sec-config" onMouseEnter={hConfig} onFocusCapture={hConfig}>
                <Card className="space-y-4 p-5">
                  <h3 className="font-semibold text-ink">Profiles &amp; custom config</h3>
                  <Field label="Nextflow profiles (optional)" hint="Comma-separated -profile list. For example, test for nf-core test data.">
                    {(id) => <Input id={id} value={profiles} placeholder="test" onChange={(e) => setProfiles(e.target.value)} />}
                  </Field>
                  <div>
                    <span className="block text-xs font-medium text-ink">Custom config file (optional)</span>
                    <p className="mt-1 text-2xs text-ink-muted">Upload or paste a nextflow config. It layers on top of the lab config, so you can set process resources, the executor, extra params, and so on.</p>
                    <div className="mt-2 flex items-center gap-3">
                      <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:border-brand/40 hover:text-brand">
                        <Icon name="upload-2-line" /> Choose config file
                        <input type="file" accept=".config,.conf,.txt" className="hidden" onChange={onConfigFile} />
                      </label>
                      <span className="truncate text-xs text-ink-muted">{configFileName || 'No file chosen'}</span>
                    </div>
                    <textarea value={configText} onChange={(e) => setConfigText(e.target.value)} rows={4}
                      placeholder={"process { withName: 'FASTQC' { cpus = 4 } }"}
                      className="tabular mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 text-xs text-ink focus:border-brand" />
                  </div>
                </Card>
              </div>

              {/* Launch bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface-2/50 p-4">
                <p className="text-xs text-ink-muted">Runs as a SLURM job using Singularity | {cpus} CPU | {memGb} GB | up to {hours}h.</p>
                <Button variant="primary" icon="play-line" loading={busy} onClick={launch}>Launch run</Button>
              </div>
            </div>

            {/* RIGHT — floating nav + readiness (nf-core launch style) */}
            <aside className="mt-5 lg:mt-0 lg:sticky lg:top-6">
              <Card className="p-4">
                <div className="flex items-center justify-between">
                  <span className="text-2xs font-medium uppercase tracking-wide text-ink-muted">On this page</span>
                  <span className={cn('text-2xs font-medium', ready ? 'text-ok' : 'text-ink-muted')}>{reqTotal > 0 ? `${reqFilled}/${reqTotal} required` : 'Ready'}</span>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                  <div className={cn('h-full rounded-full transition-all', ready ? 'bg-ok' : 'bg-brand')} style={{ width: `${reqTotal ? Math.round((reqFilled / reqTotal) * 100) : 100}%` }} />
                </div>

                <nav className="mt-3 space-y-0.5">
                  {toc.map((s) => (
                    <button key={s.id} type="button" onClick={() => scrollTo(s.id)}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink">
                      <Icon name={s.status === 'ok' ? 'checkbox-circle-fill' : s.status === 'todo' ? 'error-warning-line' : 'checkbox-blank-circle-line'}
                        className={cn('shrink-0', s.status === 'ok' ? 'text-ok' : s.status === 'todo' ? 'text-warn' : 'text-ink-muted/40')} />
                      <span className="truncate">{s.title}</span>
                    </button>
                  ))}
                </nav>

                <div className="mt-3 space-y-2.5 border-t border-border pt-3">
                  {hiddenCount > 0 && (
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-muted">
                      <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} className="h-3.5 w-3.5 accent-brand" />
                      Show hidden params ({hiddenCount})
                    </label>
                  )}
                  <Button variant="primary" icon="play-line" className="w-full" loading={busy} disabled={!ready} onClick={launch}>Launch run</Button>
                  {!ready && <p className="text-center text-2xs text-warn">Fill the required sections to launch.</p>}
                  <button type="button" onClick={backToTop} className="flex w-full items-center justify-center gap-1 text-2xs text-ink-muted hover:text-ink"><Icon name="arrow-up-line" />Back to top</button>
                </div>

                <div className="mt-3 border-t border-border pt-3">
                  <span className="text-2xs font-medium uppercase tracking-wide text-ink-muted">About this section</span>
                  <h4 className="mt-1 text-xs font-semibold text-ink">{shown.title}</h4>
                  <p className="mt-0.5 text-2xs leading-relaxed text-ink-muted">{shown.desc}</p>
                </div>
              </Card>
            </aside>
          </div>
        )}
        <FileBrowser
          open={!!browseParam}
          mode={browseParam?.mode ?? 'file'}
          onClose={() => setBrowseParam(null)}
          onPick={(abs) => { if (browseParam) set(browseParam.name, abs); setBrowseParam(null) }}
        />
      </>
    )
  }

  // ----- catalog -----
  const list = pipelines.data ?? []
  const ql = query.trim().toLowerCase()
  const filtered = ql ? list.filter((p) => `${p.name} ${p.repo} ${p.category ?? ''} ${p.description}`.toLowerCase().includes(ql)) : list
  return (
    <>
      <PageHeader
        title="Pipelines"
        subtitle="Run Nextflow / nf-core pipelines on the cluster. Pick one, fill the form, and click run."
        actions={<Button variant="primary" icon="add-line" onClick={() => setShowAdd((s) => !s)}>Add a pipeline</Button>}
      />

      {showAdd && (
        <Card className="mb-5 space-y-3 p-5">
          <h3 className="font-semibold text-ink">Add a pipeline</h3>
          <p className="text-xs text-ink-muted">Point AppHub at any Nextflow pipeline by its Git repo. nf-core repos get a parameter form automatically; others can still be run with a custom config at launch.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Name">{(id) => <Input id={id} value={np.name} placeholder="My pipeline" onChange={(e) => setNp({ ...np, name: e.target.value })} />}</Field>
            <Field label="Repository" hint="nf-core/rnaseq or an https git URL">{(id) => <Input id={id} value={np.repo} placeholder="nf-core/rnaseq" onChange={(e) => setNp({ ...np, repo: e.target.value })} />}</Field>
            <Field label="Revision (optional)">{(id) => <Input id={id} value={np.revision} placeholder="main" onChange={(e) => setNp({ ...np, revision: e.target.value })} />}</Field>
          </div>
          <Field label="Schema URL (optional)" hint="Direct https link to a nextflow_schema.json. Leave blank to auto-find it from the repo.">
            {(id) => <Input id={id} value={np.schemaUrl} placeholder="https://raw.githubusercontent.com/owner/repo/main/nextflow_schema.json" onChange={(e) => setNp({ ...np, schemaUrl: e.target.value })} />}
          </Field>

          {/* Auto-detect: does this repo give us a parameter form? */}
          {np.repo.trim() && (
            <div className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
              probing ? 'border-border text-ink-muted' : probe?.found ? 'border-ok/40 bg-ok/5 text-ink' : 'border-warn/40 bg-warn/5 text-ink')}>
              {probing ? (
                <><Icon name="loader-4-line" className="mt-0.5 animate-spin text-ink-muted" /><span>Checking the repo for a parameter form...</span></>
              ) : probe?.found ? (
                <><Icon name="checkbox-circle-fill" className="mt-0.5 text-ok" /><span>Parameter form found: <b>{probe.sections}</b> section{probe.sections === 1 ? '' : 's'}. The launch form will be built automatically.</span></>
              ) : (
                <><Icon name="error-warning-line" className="mt-0.5 text-warn" /><span>No <span className="font-mono">nextflow_schema.json</span> found{probe?.reason === 'unreachable' ? ' (could not reach the URL)' : ''}. You can still add and run it with a custom config, or paste a Schema URL above.</span></>
              )}
            </div>
          )}

          <div>
            <div className="flex items-center justify-between">
              <span className="block text-xs font-medium text-ink">Icon</span>
              <a href="https://remixicon.com/" target="_blank" rel="noreferrer" className="text-2xs font-medium text-brand hover:text-brand-strong">Browse all icons</a>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {PIPELINE_ICONS.map((ic) => (
                <button key={ic} type="button" aria-label={`icon ${ic}`} onClick={() => setNp({ ...np, icon: ic })}
                  className={cn('grid h-9 w-9 place-items-center rounded-md border', np.icon === ic ? 'border-brand bg-brand-tint text-brand' : 'border-border text-ink-muted hover:text-ink')}>
                  <Icon name={ic} className="text-lg" />
                </button>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button variant="primary" icon="add-line" loading={addBusy} onClick={addPipeline}>Add pipeline</Button>
          </div>
        </Card>
      )}

      {list.length > 0 && (
        <div className="relative mb-4 max-w-md">
          <Icon name="search-line" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search pipelines by name, repo, or category"
            className="w-full rounded-md border border-border bg-surface py-2 pl-9 pr-3 text-sm text-ink outline-none focus:border-brand" />
        </div>
      )}

      {pipelines.loading && !pipelines.data ? (
        <div className="grid gap-4 sm:grid-cols-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>
      ) : filtered.length === 0 ? (
        <EmptyState icon="flow-chart" title={query ? 'No matching pipelines' : 'No pipelines yet'} description={query ? 'Try a different search term.' : 'Use "Add a pipeline" to point AppHub at a Git repo.'} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {filtered.map((p) => (
            <Card key={p.id} interactive onClick={() => setSel(p)} className="relative flex gap-4 p-5">
              {p.custom && (
                <button title="Remove pipeline" aria-label={`remove ${p.name}`} onClick={(e) => removePipeline(p, e)} className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded text-ink-muted hover:bg-surface-2 hover:text-err">
                  <Icon name="close-line" />
                </button>
              )}
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-brand-tint text-brand"><Icon name={p.icon || 'flow-chart'} className="text-xl" /></div>
              <div className="min-w-0">
                <div className="flex items-center gap-2"><h3 className="font-semibold text-ink">{p.name}</h3>{p.category && <Badge tone="neutral">{p.category}</Badge>}</div>
                <p className="mt-1 text-sm leading-relaxed text-ink-muted">{p.description}</p>
                <p className="mt-1 font-mono text-2xs text-ink-muted">rev {p.revision}</p>
              </div>
            </Card>
          ))}
        </div>
      )}

      {nfRuns.length > 0 && (
        <>
          <h2 className="mb-2 mt-8 text-sm font-semibold text-ink">Recent pipeline runs</h2>
          <Card className="overflow-hidden">
            {nfRuns.slice(0, 12).map((i: Instance) => (
              <div key={i.id} className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5 text-sm last:border-0">
                <span className="flex min-w-0 items-center gap-2 text-ink"><Icon name="dna-line" className="text-ink-muted" /><span className="truncate">{i.name}</span><span className="truncate text-2xs text-ink-muted">{i.templateName}</span></span>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="truncate text-2xs text-ink-muted">{i.message}</span>
                  <Badge tone={STATE_TONE[i.state]}>{i.state}</Badge>
                </span>
              </div>
            ))}
            <button onClick={() => nav('/queue')} className={cn('block w-full px-4 py-2 text-center text-2xs text-ink-muted hover:bg-surface-2')}>See all in the Job queue</button>
          </Card>
        </>
      )}
    </>
  )
}
