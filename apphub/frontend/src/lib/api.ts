import type {
  AdminQuotaRow,
  Cluster,
  FileListing,
  HostingRequest,
  Instance,
  Job,
  QuotaInfo,
  LaunchRequest,
  NewTemplate,
  Session,
  Share,
  Pipeline,
  NewPipeline,
  LaunchPipelineRequest,
  PipelineSchema,
  PipelineProbe,
  Template,
  UploadResult,
  VanityCheck,
  VanityName,
} from './types'
import { createMockApi } from './mockApi'

export interface UploadOptions {
  sha256?: string
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

// The capability the whole UI is built against. The mock and the real HTTP client
// implement the same surface, so screens never know which is live.
export interface AppHubApi {
  getSession(): Promise<Session>
  /** In-app login: posts credentials to Authelia (behind nginx at /authelia). */
  login(username: string, password: string): Promise<void>
  logout(): Promise<void>
  listTemplates(): Promise<Template[]>
  /** create a custom catalog template (admin: shared; any user: personal) */
  createTemplate(def: NewTemplate): Promise<Template>
  /** delete a custom template (owner or admin) */
  deleteTemplate(id: string): Promise<void>
  listInstances(): Promise<Instance[]>
  /** every user's instances — Admin tab only (backend enforces the role) */
  listAllInstances(): Promise<Instance[]>
  /** the caller's launch quota + current usage */
  getQuota(): Promise<QuotaInfo>
  /** ask the admins for a higher simultaneous-apps quota */
  requestQuota(limit: number, reason?: string): Promise<HostingRequest>
  /** admin: everyone's quota + usage */
  adminQuotas(): Promise<{ quotas: AdminQuotaRow[]; defaultLimit: number; max: number }>
  /** admin: set a per-user quota override (null = back to the default) */
  setUserQuota(user: string, limit: number | null): Promise<{ user: string; limit: number; override: boolean }>
  /** team/public apps shared by other users */
  listSharedInstances(): Promise<Instance[]>
  getInstance(id: string): Promise<Instance | null>
  launch(req: LaunchRequest): Promise<Instance>
  stopInstance(id: string): Promise<void>
  extendInstance(id: string, addMinutes: number): Promise<Instance>
  getCluster(): Promise<Cluster>
  listJobs(): Promise<Job[]>
  /** cancel a SLURM job (own job; admins: any) */
  cancelJob(jobId: string): Promise<void>
  /** admin: prune finished (stopped/failed) instances from the queue/lists */
  clearFinished(): Promise<{ cleared: number }>
  /** listing of a path within the user's locker, or within a shared /mnt root when `root` is set */
  listFiles(path: string, root?: string): Promise<FileListing>
  /** browsable shared NAS areas (for picking pipeline inputs without copying) */
  listShares(): Promise<Share[]>
  /** create a folder at the given locker-relative path */
  mkdir(path: string): Promise<void>
  /** create an empty file at the given locker-relative path */
  mkfile(path: string): Promise<void>
  /** move/rename a path within the locker (dest = full relative path) */
  renamePath(path: string, dest: string): Promise<void>
  /** delete a file or folder (recursive) */
  deletePath(path: string): Promise<void>
  /** sha256 of a file (integrity verification) */
  hashFile(path: string): Promise<{ sha256: string }>
  /** folder content size in bytes (-1 = unknown/too large) */
  dirSize(path: string): Promise<{ size: number }>
  /** read a (small) text file's contents */
  readFileText(path: string): Promise<string>
  /** direct download URL (browser navigates to it to save the file) */
  fileDownloadUrl(path: string): string
  /** download a folder as a streamed .zip */
  fileZipUrl(path: string): string
  /** streamed, hash-verified upload */
  uploadFile(path: string, file: File | Blob, opts?: UploadOptions): Promise<UploadResult>
  /** hosting/access requests */
  listRequests(): Promise<{ requests: HostingRequest[]; pending: number }>
  createRequest(detail: string): Promise<HostingRequest>
  decideRequest(id: string, decision: 'approve' | 'deny'): Promise<HostingRequest>
  /** vanity (custom) URLs — self-service global app subdomains (unique = granted instantly) */
  listVanity(): Promise<VanityName[]>
  /** live availability check so users can find a free name themselves */
  checkVanity(name: string): Promise<VanityCheck>
  /** claim a name — succeeds immediately when valid, unique, and not reserved */
  requestVanity(name: string): Promise<VanityName>
  /** legacy admin decision (kept for any pending records) */
  decideVanity(name: string, decision: 'approve' | 'deny'): Promise<VanityName>
  /** release a name (owner or admin) so it's free again */
  removeVanity(name: string): Promise<void>
  /** toggle whether an app is reachable externally on :8443 without login */
  setPublic(id: string, isPublic: boolean): Promise<Instance>
  /** Nextflow pipeline launcher: catalog, per-pipeline param schema, and run submission */
  listPipelines(): Promise<Pipeline[]>
  getPipelineSchema(id: string): Promise<PipelineSchema>
  launchPipeline(req: LaunchPipelineRequest): Promise<Instance>
  /** probe a repo for a buildable parameter form (nextflow_schema.json) before adding it */
  probePipeline(repo: string, revision?: string, schemaUrl?: string): Promise<PipelineProbe>
  /** add a user-defined pipeline (Git repo + revision) */
  addPipeline(def: NewPipeline): Promise<Pipeline>
  /** remove a user-defined pipeline (owner or admin) */
  removePipeline(id: string): Promise<void>
  getInstanceLogs(id: string): Promise<string>
  /** Seed the SMB/drive password from the user's existing lab password (no rotation). */
  setDrivePassword(password: string): Promise<void>
  /** Change the lab password (updates the LDAP login password and the drive hash together). */
  changePassword(currentPassword: string, newPassword: string): Promise<void>
}

function redirectToLogin(): never {
  // Session missing/expired — reload to the SPA root, which renders the in-app login.
  window.location.assign('/')
  throw new Error('unauthenticated')
}

async function json<T>(res: Response): Promise<T> {
  if (res.status === 401) redirectToLogin()
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  // Tolerate empty bodies (204 No Content / void endpoints like stop/logout).
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

function createHttpApi(): AppHubApi {
  const base = '/api'
  const get = <T>(p: string) => fetch(base + p, { credentials: 'same-origin' }).then(json<T>)
  const send = <T>(p: string, method: string, body?: unknown) =>
    fetch(base + p, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(json<T>)

  return {
    getSession: async () => {
      const res = await fetch(base + '/session', { credentials: 'same-origin' })
      if (res.status === 401) return { authenticated: false }
      return json<Session>(res)
    },
    login: async (username, password) => {
      const res = await fetch('/authelia/api/firstfactor', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password, keepMeLoggedIn: true, targetURL: window.location.origin + '/' }),
      })
      const data = await res.json().catch(() => ({}) as { status?: string })
      if (!res.ok || data?.status !== 'OK') throw new Error('Invalid username or password')
    },
    logout: async () => {
      await fetch('/authelia/api/logout', { method: 'POST', credentials: 'same-origin' })
    },
    listTemplates: () => get<Template[]>('/templates'),
    createTemplate: (def) => send<Template>('/templates', 'POST', def),
    deleteTemplate: (id) => send<void>(`/templates/${encodeURIComponent(id)}`, 'DELETE'),
    listInstances: () => get<Instance[]>('/apps'),
    listAllInstances: () => get<Instance[]>('/apps?scope=all'),
    getQuota: () => get<QuotaInfo>('/quota'),
    requestQuota: (limit, reason) => send<HostingRequest>('/quota/request', 'POST', { limit, reason }),
    adminQuotas: () => get<{ quotas: AdminQuotaRow[]; defaultLimit: number; max: number }>('/admin/quotas'),
    setUserQuota: (user, limit) => send<{ user: string; limit: number; override: boolean }>(`/admin/quotas/${encodeURIComponent(user)}`, 'POST', { limit }),
    listSharedInstances: () => get<Instance[]>('/apps?scope=shared'),
    getInstance: async (id) => {
      // 404 -> null so this matches the mock's "not found" semantics (contract fix).
      const res = await fetch(`${base}/apps/${encodeURIComponent(id)}`, { credentials: 'same-origin' })
      if (res.status === 404) return null
      return json<Instance>(res)
    },
    launch: (req) => send<Instance>('/apps', 'POST', req),
    stopInstance: (id) => send<void>(`/apps/${encodeURIComponent(id)}/stop`, 'POST'),
    extendInstance: (id, addMinutes) =>
      send<Instance>(`/apps/${encodeURIComponent(id)}/extend`, 'POST', { addMinutes }),
    getCluster: () => get<Cluster>('/cluster/nodes'),
    listJobs: () => get<Job[]>('/jobs'),
    cancelJob: (jobId) => send<void>(`/jobs/${encodeURIComponent(jobId)}/cancel`, 'POST'),
    clearFinished: () => send<{ cleared: number }>('/admin/clear-finished', 'POST'),
    listFiles: (path, root) => get<FileListing>(`/files?path=${encodeURIComponent(path)}${root ? `&root=${encodeURIComponent(root)}` : ''}`),
    listShares: () => get<Share[]>('/shares'),
    mkdir: (path) => send<void>('/files/mkdir', 'POST', { path }),
    mkfile: (path) => send<void>('/files/mkfile', 'POST', { path }),
    renamePath: (path, dest) => send<void>('/files/rename', 'POST', { path, dest }),
    deletePath: (path) => send<void>('/files/delete', 'POST', { path }),
    hashFile: (path) => get<{ sha256: string }>(`/files/hash?path=${encodeURIComponent(path)}`),
    dirSize: (path) => get<{ size: number }>(`/files/dirsize?path=${encodeURIComponent(path)}`),
    readFileText: async (path) => {
      const res = await fetch(`${base}/files/download?path=${encodeURIComponent(path)}`, { credentials: 'same-origin' })
      if (res.status === 401) redirectToLogin()
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      return res.text()
    },
    fileDownloadUrl: (path) => `${base}/files/download?path=${encodeURIComponent(path)}`,
    fileZipUrl: (path) => `${base}/files/zip?path=${encodeURIComponent(path)}`,
    uploadFile: (path, file, opts = {}) =>
      new Promise<UploadResult>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        const q = `${base}/files/upload?path=${encodeURIComponent(path)}${opts.sha256 ? `&sha=${opts.sha256}` : ''}`
        xhr.open('POST', q)
        xhr.withCredentials = true
        xhr.setRequestHeader('content-type', 'application/octet-stream')
        if (opts.onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) opts.onProgress!(e.loaded / e.total) }
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText || '{}'))
          else if (xhr.status === 401) { redirectToLogin() }
          else {
            let msg = `${xhr.status}`
            try { msg = JSON.parse(xhr.responseText).error || msg } catch { /* */ }
            reject(new Error(msg))
          }
        }
        xhr.onerror = () => reject(new Error('Upload failed (network error)'))
        if (opts.signal) opts.signal.addEventListener('abort', () => xhr.abort())
        xhr.onabort = () => reject(new Error('Upload cancelled'))
        xhr.send(file)
      }),
    listRequests: () => get<{ requests: HostingRequest[]; pending: number }>('/admin/requests'),
    createRequest: (detail) => send<HostingRequest>('/requests', 'POST', { kind: 'host-app', detail }),
    decideRequest: (id, decision) => send<HostingRequest>(`/admin/requests/${encodeURIComponent(id)}/${decision}`, 'POST'),
    listVanity: () => get<VanityName[]>('/vanity'),
    checkVanity: (name) => get<VanityCheck>(`/vanity/check?name=${encodeURIComponent(name)}`),
    requestVanity: (name) => send<VanityName>('/vanity', 'POST', { name }),
    decideVanity: (name, decision) => send<VanityName>(`/vanity/${encodeURIComponent(name)}/decide`, 'POST', { decision }),
    removeVanity: (name) => send<void>(`/vanity/${encodeURIComponent(name)}`, 'DELETE'),
    setPublic: (id, isPublic) => send<Instance>(`/apps/${encodeURIComponent(id)}/public`, 'POST', { public: isPublic }),
    listPipelines: () => get<Pipeline[]>('/pipelines'),
    probePipeline: (repo, revision, schemaUrl) =>
      get<PipelineProbe>(`/pipelines/probe?repo=${encodeURIComponent(repo)}&revision=${encodeURIComponent(revision || '')}&schemaUrl=${encodeURIComponent(schemaUrl || '')}`),
    getPipelineSchema: (id) => get<PipelineSchema>(`/pipelines/${encodeURIComponent(id)}/schema`),
    launchPipeline: (req) => send<Instance>('/pipelines/launch', 'POST', req),
    addPipeline: (def) => send<Pipeline>('/pipelines', 'POST', def),
    removePipeline: (id) => send<void>(`/pipelines/${encodeURIComponent(id)}`, 'DELETE'),
    getInstanceLogs: async (id) => {
      const res = await fetch(`${base}/apps/${encodeURIComponent(id)}/logs`, { credentials: 'same-origin' })
      if (res.status === 401) redirectToLogin()
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      return res.text()
    },
    setDrivePassword: (password) => send<void>('/drive-password', 'POST', { password }),
    changePassword: (currentPassword, newPassword) =>
      send<void>('/change-password', 'POST', { currentPassword, newPassword }),
  }
}

const useMock = import.meta.env.VITE_USE_MOCK !== '0'

export const api: AppHubApi = useMock ? createMockApi() : createHttpApi()
export const IS_MOCK = useMock
