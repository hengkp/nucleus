// Wire types — mirror the plain-Node control plane (ADR-005). Kept deliberately small.
// NOTE: these are compile-time types only; responses are not yet validated at runtime.
// Runtime zod validation in the HTTP client is a follow-up for the backend-integration
// slice (zod is already a dependency). Until then the client tolerates optional fields.

export type Role = 'researcher' | 'power' | 'admin'

export interface User {
  username: string
  displayName: string
  role: Role
  uid: number
  groups: string[]
}

export interface Session {
  authenticated: boolean
  user?: User & { power?: boolean }
}

export interface HostingRequest {
  id: string
  user: string
  kind: string
  detail: string
  /** quota requests: the asked-for simultaneous-apps limit (applied on approve) */
  requested?: number | null
  status: 'pending' | 'approved' | 'denied'
  createdAt: number
  decidedBy: string | null
  decidedAt: number | null
}

/** The caller's own launch quota + usage (GET /api/quota). */
export interface QuotaInfo {
  limit: number
  used: number
  defaultLimit: number
  max: number
  pendingRequest: { id: string; requested: number | null } | null
}

/** One row of the admin quota table (GET /api/admin/quotas). */
export interface AdminQuotaRow {
  user: string
  limit: number
  override: boolean
  active: number
  pendingRequested?: number | null
}

export interface UploadResult {
  ok: boolean
  sha256: string
  size: number
}

export type TemplateCategory = 'Notebook' | 'App' | 'Tooling' | 'Static'

export interface Template {
  id: string
  name: string
  category: TemplateCategory
  description: string
  /** Remix Icon name without the ri- prefix, e.g. "terminal-box-line" */
  icon: string
  /** 'app' = web app instance (gets a URL); 'batch' = a one-off SLURM job (no URL). */
  kind?: 'app' | 'batch'
  preinstalled?: string[]
  needsEntrypoint?: boolean
  defaults: { cpus: number; memoryMb: number; timeMinutes: number }
  limits: { maxCpus: number; maxMemoryMb: number; maxTimeMinutes: number }
  enabled: boolean
  /** bring-your-own-image backend: the user supplies a .sif path (stored as the entrypoint). */
  byoImage?: boolean
  /** custom (user/admin-defined) templates */
  custom?: boolean
  base?: string
  scope?: 'shared' | 'personal'
  owner?: string
  presetEntrypoint?: string
  presetCommand?: string
  presetFolder?: string
}

export interface NewTemplate {
  name: string
  base: string
  scope: 'shared' | 'personal'
  category?: TemplateCategory
  icon?: string
  description?: string
  cpus?: number
  memoryMb?: number
  timeMinutes?: number
  entrypoint?: string
  command?: string
  folder?: string
}

export type InstanceState =
  | 'queued'
  | 'starting'
  | 'running'
  | 'expiring'
  | 'stopped'
  | 'failed'

export type Visibility = 'private' | 'team' | 'public'

export interface Instance {
  id: string
  name: string
  kind?: 'app' | 'batch'
  templateId: string
  templateName: string
  icon: string
  owner: string
  node: string | null
  cpus: number
  memoryMb: number
  state: InstanceState
  /** Present once routed; the only source of the Open action (ADR-003/006). */
  url: string | null
  /** External URL on :8443 when the app is marked public (anonymous). */
  publicUrl?: string | null
  /** Opt-in: reachable externally without login. */
  public?: boolean
  /** Routed at <name>.app (no -username) via an approved vanity reservation. */
  vanity?: boolean
  visibility: Visibility
  startedAt: number | null
  timeLimitMinutes: number | null // null = no limit (qos_unlimited)
  elapsedMinutes: number
  message?: string
}

export interface VanityName {
  name: string
  owner: string
  status: 'pending' | 'approved' | 'denied'
  createdAt: number
  decidedBy: string | null
  decidedAt: number | null
}

// Result of the self-service availability check. `available` = requestVanity() will succeed.
export interface VanityCheck {
  name: string
  available: boolean
  reason: 'ok' | 'yours' | 'taken' | 'reserved' | 'invalid'
}

// Nextflow pipeline launcher.
export interface Pipeline {
  id: string
  name: string
  repo: string
  revision: string
  icon?: string
  category?: string
  description: string
  docs?: string
  defaults: { cpus: number; memoryMb: number; timeMinutes: number }
  /** true for user-added pipelines (removable by the owner/admin) */
  custom?: boolean
  owner?: string
}
// A user-added pipeline (Tower-style: a Git repo + revision).
export interface NewPipeline {
  name: string
  repo: string
  revision?: string
  description?: string
  icon?: string
  /** optional explicit https URL to a nextflow_schema.json (overrides auto-derive) */
  schemaUrl?: string
}
// Result of probing a repo for a buildable parameter form (nextflow_schema.json).
export interface PipelineProbe {
  found: boolean
  reason?: 'norepo' | 'unreachable' | 'missing' | 'http' | 'parse' | string
  url: string | null
  sections: number
  title?: string | null
  status?: number
  message?: string
}
export interface LaunchPipelineRequest {
  pipelineId: string
  runName?: string
  params: Record<string, unknown>
  outdir?: string
  revision?: string
  cpus?: number
  memoryMb?: number
  timeMinutes?: number | null
  /** comma-separated nextflow -profile list, e.g. "test" */
  profiles?: string
  /** contents of an uploaded nextflow config, layered after the managed one */
  configText?: string
}
// nextflow_schema.json is large/loose; the form renderer walks it structurally.
export type PipelineSchema = Record<string, unknown>

export interface LaunchRequest {
  templateId: string
  name?: string
  cpus: number
  memoryMb: number
  timeMinutes: number | null
  entrypoint?: string
  /** shell command for batch (kind='batch') jobs */
  command?: string
  /** subfolder within the user's locker to run/serve from (e.g. a static-site dir) */
  folder?: string
  visibility: Visibility
  /** opt-in: also expose externally on :8443 without login (portfolios/demos) */
  public?: boolean
}

export interface FileEntry {
  type: 'dir' | 'file'
  name: string
  size: number
  mtime: number
}
export interface FileListing {
  path: string
  entries: FileEntry[]
}

// A browsable shared NAS area (top-level /mnt mount) for picking pipeline inputs without copying.
export interface Share {
  id: string
  label: string
  path: string
}

export interface NodeStat {
  name: string
  host: string
  state: 'up' | 'drain' | 'down' | 'control'
  cpuTotal: number
  cpuUsed: number
  memTotalMb: number
  memUsedMb: number
  /** true for node1 — control-plane-only, never schedules user jobs (ADR-002). */
  controlPlane: boolean
}

export interface Cluster {
  nodes: NodeStat[]
  totals: { cpuTotal: number; cpuUsed: number; memTotalMb: number; memUsedMb: number }
}

export interface Job {
  id: string
  name: string
  owner: string
  state: 'PENDING' | 'RUNNING' | 'COMPLETING' | 'FAILED'
  partition: string
  node: string | null
  elapsedMinutes: number
  timeLimitMinutes: number | null
  /** epoch ms the job was submitted (AppHub record or squeue %V); null if unknown */
  submittedAt?: number | null
  /** true = a cluster job not managed by AppHub (e.g. submitted from a terminal). Shown in
   *  the queue with a "cluster" badge; the owner or an admin can still cancel it. */
  external?: boolean
}
