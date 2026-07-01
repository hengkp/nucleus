import type {
  AppHubApi,
  UploadOptions,
} from './api'
import type {
  Cluster,
  HostingRequest,
  Instance,
  Job,
  LaunchRequest,
  NodeStat,
  Session,
  LaunchPipelineRequest,
  NewPipeline,
  Pipeline,
  PipelineSchema,
  Template,
  UploadResult,
  VanityCheck,
  VanityName,
} from './types'

// In-browser fake backend so the SPA runs with no cluster. It advances instance
// state on a timer (queued -> starting -> running) so the live UI feels real, and
// mirrors the resource-clamping + private/team-only rules of the real backend.

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
let seq = 100
const id = (p: string) => `${p}-${(seq++).toString(36)}`

const MOCK_USER = {
  username: 'kriengkraip',
  displayName: 'Kriengkrai P.',
  role: 'power' as const,
  uid: 10012,
  groups: ['sisp', 'apphub-power'],
}

const TEMPLATES: Template[] = [
  {
    id: 'jupyterlab',
    name: 'JupyterLab',
    category: 'Notebook',
    description: 'Interactive Python/R notebooks for analysis work.',
    icon: 'terminal-box-line',
    preinstalled: ['Python 3.11', 'numpy', 'pandas', 'scanpy'],
    defaults: { cpus: 2, memoryMb: 8192, timeMinutes: 480 },
    limits: { maxCpus: 64, maxMemoryMb: 262144, maxTimeMinutes: 1440 },
    enabled: true,
  },
  {
    id: 'jupyter-scrnaseq',
    name: 'Jupyter single-cell RNA-seq',
    category: 'Notebook',
    description: 'Scanpy/anndata stack preloaded for single-cell workflows.',
    icon: 'dna-line',
    preinstalled: ['scanpy', 'anndata', 'scvi-tools', 'leidenalg', 'harmonypy'],
    defaults: { cpus: 4, memoryMb: 32768, timeMinutes: 480 },
    limits: { maxCpus: 64, maxMemoryMb: 393216, maxTimeMinutes: 1440 },
    enabled: true,
  },
  {
    id: 'rstudio',
    name: 'RStudio Server',
    category: 'Notebook',
    description: 'RStudio session for R analysis and package work.',
    icon: 'bar-chart-box-line',
    preinstalled: ['R 4.4', 'tidyverse', 'BiocManager'],
    defaults: { cpus: 2, memoryMb: 8192, timeMinutes: 480 },
    limits: { maxCpus: 64, maxMemoryMb: 262144, maxTimeMinutes: 1440 },
    enabled: true,
  },
  {
    id: 'rstudio-seurat',
    name: 'RStudio Seurat',
    category: 'Notebook',
    description: 'Seurat single-cell toolkit ready to go.',
    icon: 'microscope-line',
    preinstalled: ['Seurat 5', 'SeuratObject', 'presto', 'harmony'],
    defaults: { cpus: 4, memoryMb: 32768, timeMinutes: 480 },
    limits: { maxCpus: 64, maxMemoryMb: 393216, maxTimeMinutes: 1440 },
    enabled: true,
  },
  {
    id: 'streamlit',
    name: 'Streamlit',
    category: 'App',
    description: 'Launch a Streamlit app from a workspace folder.',
    icon: 'layout-masonry-line',
    needsEntrypoint: true,
    defaults: { cpus: 2, memoryMb: 4096, timeMinutes: 240 },
    limits: { maxCpus: 32, maxMemoryMb: 131072, maxTimeMinutes: 720 },
    enabled: true,
  },
  {
    id: 'gradio',
    name: 'Gradio',
    category: 'App',
    description: 'Serve a Gradio interface from a Python entrypoint.',
    icon: 'slideshow-line',
    needsEntrypoint: true,
    defaults: { cpus: 2, memoryMb: 8192, timeMinutes: 240 },
    limits: { maxCpus: 32, maxMemoryMb: 131072, maxTimeMinutes: 720 },
    enabled: true,
  },
  {
    id: 'fastapi',
    name: 'Flask / FastAPI',
    category: 'App',
    description: 'Python web API via uvicorn from a workspace module.',
    icon: 'plug-line',
    needsEntrypoint: true,
    defaults: { cpus: 2, memoryMb: 4096, timeMinutes: 240 },
    limits: { maxCpus: 32, maxMemoryMb: 131072, maxTimeMinutes: 720 },
    enabled: true,
  },
  {
    id: 'static-html',
    name: 'Static site',
    category: 'Static',
    description: 'Serve a workspace folder as a static website.',
    icon: 'html5-line',
    defaults: { cpus: 1, memoryMb: 1024, timeMinutes: 240 },
    limits: { maxCpus: 8, maxMemoryMb: 16384, maxTimeMinutes: 720 },
    enabled: true,
  },
  {
    id: 'batch-job',
    name: 'Batch job / Run a script',
    category: 'Tooling',
    description: 'Run any command or script as a SLURM job across the cluster. No web UI; output goes to your workspace and the job logs.',
    icon: 'terminal-line',
    kind: 'batch',
    defaults: { cpus: 4, memoryMb: 16384, timeMinutes: 240 },
    limits: { maxCpus: 112, maxMemoryMb: 515600, maxTimeMinutes: 4320 },
    enabled: true,
  },
  {
    id: 'host-app',
    name: 'Host my own app',
    category: 'Tooling',
    description: 'Bring an Apptainer image and host a long-running service.',
    icon: 'box-3-line',
    defaults: { cpus: 2, memoryMb: 4096, timeMinutes: 240 },
    limits: { maxCpus: 32, maxMemoryMb: 131072, maxTimeMinutes: 1440 },
    enabled: false,
  },
]

const mockCustom: Template[] = []

// Topology matches the live cluster (pre-flight 2026-06-27): 112 cores / ~503 GiB per node.
const NODES: NodeStat[] = [
  { name: 'node1', host: '192.168.0.25', state: 'control', cpuTotal: 112, cpuUsed: 14, memTotalMb: 515600, memUsedMb: 160000, controlPlane: true },
  { name: 'node2', host: '192.168.0.26', state: 'up', cpuTotal: 112, cpuUsed: 8, memTotalMb: 515600, memUsedMb: 64000, controlPlane: false },
  { name: 'node3', host: '192.168.0.27', state: 'up', cpuTotal: 112, cpuUsed: 73, memTotalMb: 515600, memUsedMb: 320000, controlPlane: false },
  { name: 'node4', host: '192.168.0.28', state: 'up', cpuTotal: 112, cpuUsed: 41, memTotalMb: 515600, memUsedMb: 210000, controlPlane: false },
]

const instances: Instance[] = [
  {
    id: 'inst-seurat-1',
    name: 'pbmc-reanalysis',
    templateId: 'rstudio-seurat',
    templateName: 'RStudio Seurat',
    icon: 'microscope-line',
    owner: 'kriengkraip',
    node: 'node2',
    cpus: 4,
    memoryMb: 32768,
    state: 'running',
    url: 'https://pbmc-reanalysis-kriengkraip.app.sisp.com/',
    visibility: 'private',
    startedAt: Date.now() - 1000 * 60 * 96,
    timeLimitMinutes: 480,
    elapsedMinutes: 96,
  },
  {
    id: 'inst-jl-1',
    name: 'qc-notebook',
    templateId: 'jupyter-scrnaseq',
    templateName: 'Jupyter single-cell RNA-seq',
    icon: 'dna-line',
    owner: 'kriengkraip',
    node: 'node3',
    cpus: 4,
    memoryMb: 32768,
    state: 'starting',
    url: null,
    visibility: 'private',
    startedAt: null,
    timeLimitMinutes: 480,
    elapsedMinutes: 0,
    message: 'Allocating on node3...',
  },
  {
    id: 'inst-app-1',
    name: 'lab-dashboard',
    templateId: 'streamlit',
    templateName: 'Streamlit',
    icon: 'layout-masonry-line',
    owner: 'kriengkraip',
    node: 'node4',
    cpus: 2,
    memoryMb: 4096,
    state: 'running',
    url: 'https://lab-dashboard-kriengkraip.app.sisp.com/',
    visibility: 'team',
    startedAt: Date.now() - 1000 * 60 * 420,
    timeLimitMinutes: 480,
    elapsedMinutes: 420,
  },
]

const jobs: Job[] = [
  { id: '4821', name: 'pbmc-reanalysis', owner: 'kriengkraip', state: 'RUNNING', partition: 'inter', node: 'node2', elapsedMinutes: 96, timeLimitMinutes: 480 },
  { id: '4823', name: 'qc-notebook', owner: 'kriengkraip', state: 'PENDING', partition: 'inter', node: null, elapsedMinutes: 0, timeLimitMinutes: 480 },
  { id: '4817', name: 'lab-dashboard', owner: 'kriengkraip', state: 'RUNNING', partition: 'inter', node: 'node4', elapsedMinutes: 420, timeLimitMinutes: 480 },
  { id: '4790', name: 'galaxy', owner: 'nodeadmin', state: 'RUNNING', partition: 'persistent', node: 'node3', elapsedMinutes: 2880, timeLimitMinutes: null },
]

// ---- mock locker filesystem (dev only) -----------------------------------
type MEntry = { type: 'dir' | 'file'; size: number; mtime: number; content?: string }
const mfs = new Map<string, MEntry>()
const fnow = () => Math.floor(Date.now() / 1000)
;(() => {
  const d = (p: string) => mfs.set(p, { type: 'dir', size: 0, mtime: fnow() })
  const f = (p: string, size: number, content?: string) => mfs.set(p, { type: 'file', size, mtime: fnow(), content })
  d('projects'); d('raw-data'); d('static-site'); d('static-site/css'); d('static-site/js'); d('static-site/assets')
  f('README.md', 1840, '# My locker\n\nFiles here are private to you.\n')
  f('analysis.ipynb', 90422)
  f('static-site/index.html', 4096, '<!doctype html>\n<h1>Hello from my static site</h1>\n')
})()
function mfsChildren(p: string) {
  const prefix = p ? `${p}/` : ''
  const out: { type: 'dir' | 'file'; name: string; size: number; mtime: number }[] = []
  for (const [k, v] of mfs) {
    if (!k.startsWith(prefix)) continue
    const rest = k.slice(prefix.length)
    if (!rest || rest.includes('/')) continue
    out.push({ type: v.type, name: rest, size: v.size, mtime: v.mtime })
  }
  return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
}
const norm = (p: string) => (p || '').replace(/^\/+|\/+$/g, '')

const mockVanity: VanityName[] = []
const mockPipelines: Pipeline[] = []
const VANITY_RE = /^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$/
const VANITY_RESERVED = new Set(['www', 'api', 'app', 'apps', 'admin', 'root', 'auth', 'sso', 'login', 'apphub', 'jupyter', 'rstudio', 'galaxy', 'sisp', 'siriraj', 'static', 'mail', 'test', 'demo'])
function evalVanity(name: string, user: string): VanityCheck {
  const nm = (name || '').toLowerCase()
  if (!VANITY_RE.test(nm)) return { name: nm, available: false, reason: 'invalid' }
  if (VANITY_RESERVED.has(nm)) return { name: nm, available: false, reason: 'reserved' }
  const taken = mockVanity.find((v) => v.name === nm && v.status !== 'denied')
  if (taken) return { name: nm, available: taken.owner === user, reason: taken.owner === user ? 'yours' : 'taken' }
  return { name: nm, available: true, reason: 'ok' }
}
const mockRequests: HostingRequest[] = [
  { id: 'req-seed1', user: 'ryanr', kind: 'host-app', detail: 'Host my kmer dashboard (Apptainer image, persistent).', status: 'pending', createdAt: Date.now() - 3600_000, decidedBy: null, decidedAt: null },
]

// Advance lifecycle so the UI shows live transitions.
function tick() {
  for (const inst of instances) {
    if (inst.state === 'queued') {
      inst.state = 'starting'
      inst.message = `Allocating on ${inst.node ?? 'a node'}...`
    } else if (inst.state === 'starting') {
      inst.state = 'running'
      inst.startedAt = Date.now()
      inst.url = inst.kind === 'batch' ? null : `https://${inst.name}-${inst.owner}.app.sisp.com/`
      inst.message = undefined
      const job = jobs.find((j) => j.name === inst.name)
      if (job) { job.state = 'RUNNING'; job.node = inst.node }
    } else if (inst.state === 'running' && inst.startedAt) {
      inst.elapsedMinutes = Math.floor((Date.now() - inst.startedAt) / 60000)
    }
  }
}
setInterval(tick, 4000)

export function createMockApi(): AppHubApi {
  return {
    async getSession(): Promise<Session> {
      await delay(120)
      return { authenticated: true, user: MOCK_USER }
    },
    async login(username, password) {
      await delay(300)
      if (!username || !password) throw new Error('Invalid username or password')
    },
    async logout() {
      await delay(80)
    },
    async listTemplates() {
      await delay(140)
      return structuredClone([...TEMPLATES, ...mockCustom])
    },
    async createTemplate(def) {
      await delay(160)
      const base = TEMPLATES.find((t) => t.id === def.base)
      if (!base) throw new Error('Pick a valid base app')
      if (!def.name?.trim()) throw new Error('A template name is required')
      const t: Template = {
        id: id('tpl'),
        name: def.name.trim(),
        category: def.category ?? base.category,
        description: def.description?.trim() || base.description,
        icon: def.icon?.trim() || base.icon,
        kind: base.kind,
        needsEntrypoint: base.needsEntrypoint,
        preinstalled: base.preinstalled,
        defaults: { cpus: def.cpus ?? base.defaults.cpus, memoryMb: def.memoryMb ?? base.defaults.memoryMb, timeMinutes: def.timeMinutes ?? base.defaults.timeMinutes },
        limits: base.limits,
        enabled: true,
        custom: true,
        base: def.base,
        scope: def.scope,
        owner: MOCK_USER.username,
        presetEntrypoint: def.entrypoint,
        presetCommand: def.command,
        presetFolder: def.folder,
      }
      mockCustom.push(t)
      return structuredClone(t)
    },
    async deleteTemplate(tid) {
      await delay(120)
      const i = mockCustom.findIndex((t) => t.id === tid)
      if (i >= 0) mockCustom.splice(i, 1)
    },
    async listInstances() {
      await delay(160)
      return structuredClone(instances)
    },
    async listSharedInstances() {
      await delay(160)
      return [
        {
          id: 'inst-shared-1', name: 'lab-viewer', kind: 'app', templateId: 'streamlit', templateName: 'Streamlit',
          icon: 'layout-masonry-line', owner: 'saners', node: 'node3', cpus: 2, memoryMb: 4096,
          state: 'running', url: 'https://lab-viewer-saners.app.sisp.com/', visibility: 'team',
          startedAt: Date.now() - 1000 * 60 * 30, timeLimitMinutes: 480, elapsedMinutes: 30,
        },
      ] as Instance[]
    },
    async getInstance(iid) {
      await delay(120)
      const f = instances.find((i) => i.id === iid)
      return f ? structuredClone(f) : null
    },
    async launch(req: LaunchRequest) {
      await delay(420)
      const tpl = TEMPLATES.find((t) => t.id === req.templateId)
      if (!tpl) throw new Error('Unknown template')
      // Server-side clamp + private/team only (mirrors createAppRecord).
      const cpus = Math.min(req.cpus, tpl.limits.maxCpus)
      const memoryMb = Math.min(req.memoryMb, tpl.limits.maxMemoryMb)
      const timeMinutes = req.timeMinutes === null ? null : Math.min(req.timeMinutes, tpl.limits.maxTimeMinutes)
      const visibility = req.visibility === 'public' ? 'private' : req.visibility
      const node = ['node2', 'node3', 'node4'][Math.floor(Date.now() / 1000) % 3]
      const inst: Instance = {
        id: id('inst'),
        name: (req.name || tpl.id).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40),
        templateId: tpl.id,
        templateName: tpl.name,
        kind: tpl.kind ?? 'app',
        icon: tpl.icon,
        owner: MOCK_USER.username,
        node,
        cpus,
        memoryMb,
        state: 'queued',
        url: null,
        visibility,
        startedAt: null,
        timeLimitMinutes: timeMinutes,
        elapsedMinutes: 0,
        message: 'Queued, waiting for an allocation...',
      }
      instances.unshift(inst)
      jobs.unshift({
        id: String(4800 + instances.length),
        name: inst.name,
        owner: inst.owner,
        state: 'PENDING',
        partition: timeMinutes === null ? 'persistent' : 'inter',
        node: null,
        elapsedMinutes: 0,
        timeLimitMinutes: timeMinutes,
      })
      return structuredClone(inst)
    },
    async stopInstance(iid) {
      await delay(220)
      const inst = instances.find((i) => i.id === iid)
      if (inst) { inst.state = 'stopped'; inst.url = null; inst.message = 'Stopped' }
      const job = jobs.find((j) => j.name === inst?.name)
      if (job) job.state = 'COMPLETING'
    },
    async extendInstance(iid, addMinutes) {
      await delay(180)
      const inst = instances.find((i) => i.id === iid)
      if (!inst) throw new Error('Not found')
      if (inst.timeLimitMinutes !== null) inst.timeLimitMinutes += addMinutes
      return structuredClone(inst)
    },
    async getCluster(): Promise<Cluster> {
      await delay(140)
      const totals = NODES.reduce(
        (a, n) => ({
          cpuTotal: a.cpuTotal + n.cpuTotal,
          cpuUsed: a.cpuUsed + n.cpuUsed,
          memTotalMb: a.memTotalMb + n.memTotalMb,
          memUsedMb: a.memUsedMb + n.memUsedMb,
        }),
        { cpuTotal: 0, cpuUsed: 0, memTotalMb: 0, memUsedMb: 0 },
      )
      return { nodes: structuredClone(NODES), totals }
    },
    async listJobs() {
      await delay(150)
      return structuredClone(jobs)
    },
    async cancelJob(jobId) {
      await delay(180)
      const inst = instances.find((i) => jobs.find((j) => j.id === jobId && j.name === i.name))
      if (inst) { inst.state = 'stopped'; inst.url = null }
      const job = jobs.find((j) => j.id === jobId)
      if (job) job.state = 'COMPLETING'
    },
    async clearFinished() {
      await delay(150)
      let cleared = 0
      for (let i = instances.length - 1; i >= 0; i--) {
        if (instances[i].state === 'stopped' || instances[i].state === 'failed') { instances.splice(i, 1); cleared++ }
      }
      return { cleared }
    },
    async listFiles(path, root) {
      await delay(120)
      if (root) {
        // Mock shared-root browse: a couple of folders + a samplesheet so the picker is usable in dev.
        return path
          ? { path, entries: [{ type: 'file' as const, name: 'samplesheet.csv', size: 412, mtime: fnow() }] }
          : { path: '', entries: [{ type: 'dir' as const, name: 'fastq', size: 0, mtime: fnow() }, { type: 'dir' as const, name: 'references', size: 0, mtime: fnow() }, { type: 'file' as const, name: 'samplesheet.csv', size: 412, mtime: fnow() }] }
      }
      const p = norm(path)
      return { path: p, entries: mfsChildren(p) }
    },
    async listShares() {
      await delay(80)
      return [
        { id: 'sisplockers', label: 'Lab lockers & projects', path: '/mnt/sisplockers' },
        { id: 'rarecyte-folder', label: 'Rarecyte', path: '/mnt/rarecyte-folder' },
        { id: 'CRCproject', label: 'CRC project', path: '/mnt/CRCproject' },
      ]
    },
    async mkdir(path) {
      await delay(120)
      const p = norm(path)
      if (mfs.has(p)) throw new Error('already exists')
      mfs.set(p, { type: 'dir', size: 0, mtime: fnow() })
    },
    async mkfile(path) {
      await delay(120)
      const p = norm(path)
      if (mfs.has(p)) throw new Error('already exists')
      mfs.set(p, { type: 'file', size: 0, mtime: fnow(), content: '' })
    },
    async renamePath(path, dest) {
      await delay(140)
      const s = norm(path), d = norm(dest)
      if (!mfs.has(s)) throw new Error('source missing')
      if (mfs.has(d)) throw new Error('destination exists')
      for (const [k, v] of [...mfs]) {
        if (k === s || k.startsWith(`${s}/`)) {
          mfs.delete(k)
          mfs.set(d + k.slice(s.length), v)
        }
      }
    },
    async deletePath(path) {
      await delay(140)
      const s = norm(path)
      for (const k of [...mfs.keys()]) if (k === s || k.startsWith(`${s}/`)) mfs.delete(k)
    },
    async hashFile(path) {
      await delay(120)
      const e = mfs.get(norm(path))
      const seed = (e?.content ?? String(e?.size ?? '')).length
      return { sha256: (seed.toString(16).padStart(2, '0').repeat(32)).slice(0, 64) }
    },
    async dirSize(path) {
      await delay(250)
      const p = norm(path), prefix = p ? `${p}/` : ''
      let size = 0
      for (const [k, v] of mfs) if (v.type === 'file' && (k === p || k.startsWith(prefix))) size += v.size
      return { size }
    },
    async readFileText(path) {
      await delay(120)
      const e = mfs.get(norm(path))
      if (!e || e.type !== 'file') throw new Error('not a file')
      return e.content ?? '(binary or empty file, open it by mapping the drive)'
    },
    fileDownloadUrl(path) {
      return `#mock-download:${norm(path)}`
    },
    fileZipUrl(path) {
      return `#mock-zip:${norm(path)}`
    },
    async uploadFile(path, file, opts: UploadOptions = {}): Promise<UploadResult> {
      const p = norm(path)
      for (let i = 1; i <= 5; i++) { await delay(120); opts.onProgress?.(i / 5) }
      const text = file instanceof File && file.type.startsWith('text') ? await file.text().catch(() => undefined) : undefined
      mfs.set(p, { type: 'file', size: file.size, mtime: fnow(), content: text })
      return { ok: true, sha256: 'mock'.padEnd(64, '0'), size: file.size }
    },
    async listRequests() {
      await delay(120)
      return { requests: structuredClone(mockRequests), pending: mockRequests.filter((r) => r.status === 'pending').length }
    },
    async createRequest(detail) {
      await delay(150)
      const r: HostingRequest = { id: id('req'), user: MOCK_USER.username, kind: 'host-app', detail, status: 'pending', createdAt: Date.now(), decidedBy: null, decidedAt: null }
      mockRequests.unshift(r)
      return structuredClone(r)
    },
    async decideRequest(rid, decision) {
      await delay(150)
      const r = mockRequests.find((x) => x.id === rid)
      if (!r) throw new Error('Request not found')
      r.status = decision === 'approve' ? 'approved' : 'denied'
      r.decidedBy = MOCK_USER.username
      r.decidedAt = Date.now()
      return structuredClone(r)
    },
    async listVanity() {
      await delay(80)
      return structuredClone(mockVanity)
    },
    async checkVanity(name) {
      await delay(60)
      return evalVanity(name, MOCK_USER.username)
    },
    async requestVanity(name) {
      await delay(120)
      const c = evalVanity(name, MOCK_USER.username)
      if (!c.available) {
        if (c.reason === 'taken') throw new Error('That name is already taken')
        if (c.reason === 'reserved') throw new Error('That name is reserved, pick another')
        throw new Error('Name must be 2-40 chars: letters, digits, hyphens')
      }
      const nm = name.toLowerCase()
      const existing = mockVanity.find((v) => v.name === nm && v.owner === MOCK_USER.username)
      if (existing) { existing.status = 'approved'; return structuredClone(existing) }
      const v = { name: nm, owner: MOCK_USER.username, status: 'approved' as const, createdAt: Date.now(), decidedBy: 'auto', decidedAt: Date.now() }
      mockVanity.unshift(v)
      return structuredClone(v)
    },
    async decideVanity(name, decision) {
      await delay(120)
      const v = mockVanity.find((x) => x.name === name)
      if (!v) throw new Error('No such vanity name')
      v.status = decision === 'approve' ? 'approved' : 'denied'
      v.decidedBy = MOCK_USER.username
      v.decidedAt = Date.now()
      return structuredClone(v)
    },
    async removeVanity(name) {
      await delay(80)
      const i = mockVanity.findIndex((x) => x.name === name)
      if (i >= 0) mockVanity.splice(i, 1)
    },
    async setPublic(iid, isPublic) {
      await delay(120)
      const inst = instances.find((x) => x.id === iid)
      if (!inst) throw new Error('Not found')
      inst.public = isPublic
      inst.publicUrl = isPublic ? `https://${inst.name}-${inst.owner}.sisp.freeddns.org:8443/` : null
      return structuredClone(inst)
    },
    async listPipelines() {
      await delay(80)
      return [
        { id: 'rnaseq', name: 'nf-core/rnaseq', repo: 'nf-core/rnaseq', revision: '3.14.0', icon: 'dna-line', category: 'Transcriptomics', description: 'Bulk RNA-seq: QC, trimming, alignment, quantification.', docs: 'https://nf-co.re/rnaseq', defaults: { cpus: 12, memoryMb: 65536, timeMinutes: 1440 } },
        { id: 'sarek', name: 'nf-core/sarek', repo: 'nf-core/sarek', revision: '3.4.4', icon: 'git-branch-line', category: 'Somatic mutations', description: 'Germline and somatic variant calling.', docs: 'https://nf-co.re/sarek', defaults: { cpus: 16, memoryMb: 98304, timeMinutes: 2880 } },
        { id: 'hello', name: 'Hello (smoke test)', repo: 'nextflow-io/hello', revision: 'master', icon: 'play-circle-line', category: 'Test', description: 'Tiny pipeline; runs in seconds, no parameters.', docs: 'https://github.com/nextflow-io/hello', defaults: { cpus: 1, memoryMb: 2048, timeMinutes: 30 } },
        ...structuredClone(mockPipelines),
      ]
    },
    async probePipeline(repo: string, _revision?: string, schemaUrl?: string) {
      await delay(200)
      const looksNfCore = /nf-core\//i.test(repo) || (schemaUrl ?? '').includes('nextflow_schema')
      return looksNfCore
        ? { found: true, url: schemaUrl || `https://raw.githubusercontent.com/${repo}/main/nextflow_schema.json`, sections: 6, title: repo }
        : { found: false, reason: 'missing' as const, url: null, sections: 0 }
    },
    async addPipeline(def: NewPipeline) {
      await delay(120)
      const p: Pipeline = {
        id: `pipe-${Math.random().toString(36).slice(2, 8)}`, name: def.name, repo: def.repo,
        revision: def.revision || 'main', icon: def.icon || 'git-branch-line', category: 'Custom',
        description: def.description || `${def.repo} @ ${def.revision || 'main'}`, docs: '#',
        defaults: { cpus: 8, memoryMb: 32768, timeMinutes: 1440 }, custom: true, owner: MOCK_USER.username,
      }
      mockPipelines.unshift(p)
      return structuredClone(p)
    },
    async removePipeline(id: string) {
      await delay(80)
      const i = mockPipelines.findIndex((x) => x.id === id)
      if (i >= 0) mockPipelines.splice(i, 1)
    },
    async getPipelineSchema() {
      await delay(120)
      return {
        $defs: {
          input_output_options: {
            title: 'Input/output options', description: 'Define where the pipeline reads and writes.',
            required: ['input'],
            properties: {
              input: { type: 'string', format: 'file-path', description: 'Path to a comma-separated samplesheet.' },
              genome: { type: 'string', description: 'Reference genome (iGenomes key).', enum: ['GRCh38', 'GRCm39'] },
              save_reference: { type: 'boolean', description: 'Save the generated reference files.', default: false },
            },
          },
        },
      } as PipelineSchema
    },
    async launchPipeline(req: LaunchPipelineRequest) {
      await delay(200)
      const inst: Instance = {
        id: `job-${Math.random().toString(36).slice(2, 10)}`,
        name: (req.runName || req.pipelineId).toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
        kind: 'batch', templateId: 'nextflow', templateName: req.pipelineId, icon: 'dna-line',
        owner: MOCK_USER.username, node: null, cpus: req.cpus ?? 12, memoryMb: req.memoryMb ?? 65536,
        state: 'queued', url: null, visibility: 'private', startedAt: null,
        timeLimitMinutes: req.timeMinutes ?? 1440, elapsedMinutes: 0, message: 'Queued, demo run',
      }
      instances.unshift(inst)
      return structuredClone(inst)
    },
    async setDrivePassword(password) {
      await delay(400)
      if (!password) throw new Error('Password is required')
      // Demo only — no real LDAP/Samba behind the mock.
    },
    async changePassword(currentPassword, newPassword) {
      await delay(500)
      if (!currentPassword) throw new Error('Your current password is incorrect.')
      if (!newPassword || newPassword.length < 8) throw new Error('Your new password must be at least 8 characters.')
      if (newPassword === currentPassword) throw new Error('The new password must be different from your current one.')
      // Demo only — no real LDAP/Samba behind the mock.
    },
    async getInstanceLogs(iid) {
      await delay(120)
      const inst = instances.find((i) => i.id === iid)
      if (!inst) return ''
      return [
        `[${new Date().toISOString()}] apphub: submitting job for ${inst.name}`,
        `[slurm] allocated ${inst.cpus} CPU / ${(inst.memoryMb / 1024).toFixed(0)} GB on ${inst.node}`,
        `[apptainer] starting ${inst.templateId}.sif (--contain, loopback bind)`,
        `[runner] listening on 127.0.0.1, registering route ${inst.url ?? '(pending)'}`,
        `[apphub] instance ${inst.state}`,
      ].join('\n')
    },
  }
}
