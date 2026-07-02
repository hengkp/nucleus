import { createServer } from 'node:http'
import { existsSync, unlinkSync, chmodSync } from 'node:fs'
import { config, bootGuards } from './config.js'
import { sendJson, sendText, sendNoContent, readJsonBody, HttpError } from './lib/http.js'
import { resolveIdentity, isReserved } from './lib/auth.js'
import { normalizeLaunch, uniqueName } from './lib/validate.js'
import { resolveTemplate, templatesFor, createCustom, removeCustom } from './lib/custom-templates.js'
import { createStore, publicInstance, isTerminal } from './lib/store.js'
import { createSlurm } from './lib/slurm.js'
import { createRouteTable } from './lib/routes-table.js'
import { createReconciler } from './lib/reconciler.js'
import { buildCluster, buildJobs } from './lib/cluster.js'
import { buildLogs } from './lib/logs.js'
import { setDrivePassword } from './lib/drive-password.js'
import { changePassword } from './lib/change-password.js'
import { listFiles, statFile, makeDir, makeFile, removePath, renamePath, hashFile, dirSize, readStream, zipStream, writeStream } from './lib/files.js'
import { listShares } from './lib/shares.js'
import { createRequest, listRequests, pendingCount, decideRequest, isPowerUser, getQuotaLimit, setQuotaLimit, allQuotaOverrides } from './lib/approvals.js'
import { listVanity, checkVanity, requestVanity, decideVanity, removeVanity, approvedVanityFor, isValidVanity } from './lib/vanity.js'
import { pipelinesFor, resolvePipeline, publicPipeline, fetchSchema, buildNextflowRun, pipelineSlug, addCustomPipeline, removeCustomPipeline, probeSchema } from './lib/pipelines.js'
import { newId } from './lib/id.js'

// Fail closed on unsafe configuration before doing anything (review CRITICAL/HIGH).
const fatal = bootGuards()
if (fatal.length) {
  for (const m of fatal) console.error('[apphub] FATAL: ' + m)
  process.exit(1)
}

const store = await createStore()
await store.init()
const slurm = createSlurm(config.slurmMode)
const routes = createRouteTable()
const reconciler = createReconciler({ store, slurm, routes })

function canSee(rec, user) {
  // private = owner/admin only; team + public = shared with any authenticated lab member.
  return user.role === 'admin' || rec.owner === user.username || rec.visibility !== 'private'
}
function canControl(rec, user) {
  return user.role === 'admin' || rec.owner === user.username
}

// ---- handlers -------------------------------------------------------------
async function listApps(req, res, user) {
  const all = await store.all()
  const url = new URL(req.url, 'http://localhost')
  const scope = url.searchParams.get('scope')
  if (scope === 'shared') {
    // team/public apps owned by OTHERS (the "Shared with me" view)
    const shared = all.filter((r) => r.owner !== user.username && r.visibility !== 'private' && !isTerminal(r.state))
    return sendJson(res, 200, shared.map(publicInstance))
  }
  if (scope === 'all') {
    // cluster-wide view for the Admin tab ONLY. The default (personal) view is owner-only
    // for everyone, admins included — an admin's dashboard shows their own apps, not the lab's.
    requireAdmin(user)
    return sendJson(res, 200, all.map(publicInstance))
  }
  const mine = all.filter((r) => r.owner === user.username)
  sendJson(res, 200, mine.map(publicInstance))
}

async function launchApp(req, res, user) {
  if (isReserved(user.username)) throw new HttpError(403, 'This account may not launch user apps')

  // Per-user launch quota (default config.defaultQuota, per-user override set by an admin or
  // granted via an approved quota request). maxInstancesPerUser stays the hard ceiling.
  const active = (await store.all()).filter((r) => r.owner === user.username && !isTerminal(r.state))
  const quota = await getQuotaLimit(user.username)
  if (active.length >= quota) {
    throw new HttpError(429, `You already have ${active.length} active apps (your quota is ${quota}). Stop one first, or request a higher quota from the dashboard.`)
  }

  const body = await readJsonBody(req)
  const template = await resolveTemplate(body?.templateId)
  if (!template) throw new HttpError(400, 'Unknown template')
  const spec = normalizeLaunch(body, template)
  // Vanity URL: if the chosen name is a vanity the admin approved for this user, route it at
  // <name>.app.sisp.com (no -username) and DON'T uniquify — the vanity reservation already
  // guarantees global uniqueness. Otherwise auto-uniquify so two of this user's apps never collide
  // on a host (which would emit a duplicate nginx route key).
  const isVanity = spec.kind !== 'batch' && (await approvedVanityFor(user.username)).has(spec.name)
  if (!isVanity) spec.name = uniqueName(spec.name, new Set(active.map((r) => r.name)))
  // Custom-template presets supply defaults the wizard may not have sent.
  if (template.custom) {
    spec.entrypoint = spec.entrypoint || template.presetEntrypoint
    spec.command = spec.command || template.presetCommand
    spec.folder = spec.folder || template.presetFolder
  }

  const isBatch = spec.kind === 'batch'
  const rec = {
    id: newId(isBatch ? 'job' : 'inst'),
    name: spec.name,
    kind: spec.kind,
    templateId: template.id,
    templateName: template.name,
    icon: template.icon,
    owner: user.username,
    uid: user.uid,
    node: null,
    cpus: spec.cpus,
    memoryMb: spec.memoryMb,
    timeLimitMinutes: spec.timeMinutes,
    visibility: spec.visibility,
    vanity: isVanity,
    public: !isBatch && !!spec.public, // opt-in: reachable externally on :8443 without login
    entrypoint: spec.entrypoint,
    command: spec.command,
    folder: spec.folder,
    state: 'queued',
    url: null,
    port: undefined,
    jobId: undefined,
    startedAt: null,
    message: 'Queued — waiting for an allocation…',
    createdAt: Date.now(),
  }
  await store.create(rec)

  try {
    // Web apps get a routed port; batch jobs do not (no web UI).
    let port
    if (!isBatch) {
      port = await store.allocatePort(rec.id)
      await store.update(rec.id, { port })
      rec.port = port
    }
    const { jobId, node } = await slurm.launch({
      templateId: template.base || template.id,
      kind: spec.kind,
      image: template.image,
      owner: user.username,
      uid: user.uid,
      name: rec.name,
      cpus: rec.cpus,
      memoryMb: rec.memoryMb,
      timeMinutes: rec.timeLimitMinutes,
      entrypoint: rec.entrypoint,
      command: rec.command,
      folder: rec.folder,
      port,
    })
    await store.update(rec.id, { jobId, node: node ?? null })
  } catch (e) {
    await store.update(rec.id, { state: 'failed', message: `Could not start: ${e.message}` })
    await store.freePort(rec.id)
    throw new HttpError(502, `Launch failed: ${e.message}`)
  }

  await store.audit({ actor: user.username, action: 'launch', target: rec.id, detail: { template: template.id, cpus: rec.cpus, memoryMb: rec.memoryMb } })
  reconciler.runNow()
  const fresh = await store.get(rec.id)
  sendJson(res, 201, publicInstance(fresh))
}

async function getApp(_req, res, user, id) {
  const rec = await store.get(id)
  if (!rec || !canSee(rec, user)) throw new HttpError(404, 'Not found')
  sendJson(res, 200, publicInstance(rec))
}

async function stopApp(_req, res, user, id) {
  const rec = await store.get(id)
  if (!rec) throw new HttpError(404, 'Not found')
  if (!canControl(rec, user)) throw new HttpError(403, 'Not your instance')
  if (rec.jobId) await slurm.cancel(rec.jobId)
  await store.update(id, { state: 'stopped', url: null, message: 'Stopped' })
  await store.freePort(id)
  await store.audit({ actor: user.username, action: 'stop', target: id })
  reconciler.runNow()
  sendNoContent(res)
}

// Self-service "top-up" extend. Adds time (default +12h) up to a hard cap, and actually
// raises the running SLURM job's wall-clock limit (scontrol) so the extension is real.
async function extendApp(req, res, user, id) {
  const rec = await store.get(id)
  if (!rec) throw new HttpError(404, 'Not found')
  if (!canControl(rec, user)) throw new HttpError(403, 'Not your instance')
  if (rec.timeLimitMinutes == null) throw new HttpError(400, 'This app has no time limit to extend')
  const body = await readJsonBody(req)
  const add = Math.min(Math.max(Number(body?.addMinutes) || config.extendStepMinutes, 1), config.extendStepMinutes)
  const next = Math.min(rec.timeLimitMinutes + add, config.timeMaxMinutes)
  if (next <= rec.timeLimitMinutes) {
    throw new HttpError(409, `Already at the ${Math.round(config.timeMaxMinutes / 60)}h limit. Request the persistent track for longer runs.`)
  }
  // Push the new limit to SLURM first; only persist if the cluster accepted it.
  if (rec.jobId && slurm.setTimeLimit) {
    try { await slurm.setTimeLimit(rec.jobId, next) }
    catch (e) { throw new HttpError(502, `Could not extend the running job: ${e.message}`) }
  }
  await store.update(id, { state: rec.state === 'expiring' ? 'running' : rec.state, timeLimitMinutes: next })
  await store.audit({ actor: user.username, action: 'extend', target: id, detail: { addMinutes: add, newLimit: next } })
  sendJson(res, 200, publicInstance(await store.get(id)))
}

async function appLogs(_req, res, user, id) {
  const rec = await store.get(id)
  if (!rec || !canSee(rec, user)) throw new HttpError(404, 'Not found')
  sendText(res, 200, await buildLogs(rec))
}

async function drivePassword(req, res, user) {
  const body = await readJsonBody(req)
  await setDrivePassword(user.username, String(body?.password ?? ''))
  await store.audit({ actor: user.username, action: 'drive-password-set', target: user.username })
  sendNoContent(res)
}

async function changePasswordHandler(req, res, user) {
  const body = await readJsonBody(req)
  await changePassword(user.username, String(body?.currentPassword ?? ''), String(body?.newPassword ?? ''))
  await store.audit({ actor: user.username, action: 'password-changed', target: user.username })
  sendNoContent(res)
}

// Cancel any SLURM job the caller owns (admins: any job). Works for AppHub instances and
// raw cluster jobs alike.
async function cancelJob(_req, res, user, jobId) {
  const all = await store.all()
  const inst = all.find((r) => String(r.jobId) === String(jobId))
  let owner = inst?.owner
  if (!owner) {
    const q = await slurm.queue().catch(() => [])
    owner = q.find((j) => String(j.jobId) === String(jobId))?.owner
  }
  if (!owner) throw new HttpError(404, 'Job not found')
  if (user.role !== 'admin' && owner !== user.username) throw new HttpError(403, 'Not your job')
  await slurm.forceCancel(jobId)
  if (inst) await store.update(inst.id, { state: 'stopped', url: null, message: 'Cancelled' })
  await store.audit({ actor: user.username, action: 'cancel-job', target: String(jobId) })
  reconciler.runNow()
  sendNoContent(res)
}

function requireAdmin(user) {
  if (user.role !== 'admin') throw new HttpError(403, 'Admins only')
}
function qparam(req, key) {
  return new URL(req.url, 'http://localhost').searchParams.get(key) || ''
}

async function getFiles(req, res, user) {
  // Optional ?root=<abs /mnt share> browses a shared NAS area read-only (as the user); default = locker.
  const root = qparam(req, 'root')
  if (root && !root.startsWith('/mnt/')) throw new HttpError(400, 'Shared root must be under /mnt')
  sendJson(res, 200, await listFiles(user.username, qparam(req, 'path'), root))
}
async function getShares(_req, res, _user) {
  sendJson(res, 200, listShares())
}

async function mkdirFile(req, res, user) {
  const body = await readJsonBody(req)
  await makeDir(user.username, body?.path)
  await store.audit({ actor: user.username, action: 'file-mkdir', target: String(body?.path || '') })
  sendJson(res, 201, { ok: true })
}

async function mkfileFile(req, res, user) {
  const body = await readJsonBody(req)
  await makeFile(user.username, body?.path)
  await store.audit({ actor: user.username, action: 'file-create', target: String(body?.path || '') })
  sendJson(res, 201, { ok: true })
}

async function renameFile(req, res, user) {
  const body = await readJsonBody(req)
  await renamePath(user.username, body?.path, body?.dest)
  await store.audit({ actor: user.username, action: 'file-rename', target: String(body?.path || ''), detail: { dest: body?.dest } })
  sendJson(res, 200, { ok: true })
}

async function deleteFile(req, res, user) {
  const body = await readJsonBody(req)
  await removePath(user.username, body?.path)
  await store.audit({ actor: user.username, action: 'file-delete', target: String(body?.path || '') })
  sendJson(res, 200, { ok: true })
}

async function hashFileHandler(req, res, user) {
  sendJson(res, 200, await hashFile(user.username, qparam(req, 'path')))
}

async function dirSizeHandler(req, res, user) {
  sendJson(res, 200, await dirSize(user.username, qparam(req, 'path')))
}

// Streaming download — bounded memory for any file size. Content-Length lets the browser
// detect a truncated transfer (completeness guarantee on the read side).
async function downloadFile(req, res, user) {
  const path = qparam(req, 'path')
  const st = await statFile(user.username, path) // 404 if missing
  if (st.type !== 'file') throw new HttpError(400, 'Not a file')
  const safeName = (st.name || 'download').replace(/[\r\n"]/g, '_')
  const child = readStream(user.username, path)
  let errbuf = ''
  child.stderr.on('data', (d) => (errbuf += d))
  child.on('error', () => { if (!res.headersSent) sendJson(res, 502, { error: 'Download failed' }) })
  res.on('close', () => { try { child.kill('SIGKILL') } catch { /* */ } })
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(st.size),
    'Content-Disposition': `attachment; filename="${safeName}"`,
    'Cache-Control': 'no-store',
  })
  child.stdout.pipe(res)
  await store.audit({ actor: user.username, action: 'file-download', target: path })
}

// Streaming folder download as a .zip (like Google Drive). Built on the fly, no temp file.
async function zipFolder(req, res, user) {
  const path = qparam(req, 'path')
  const st = await statFile(user.username, path) // 404 if missing
  if (st.type !== 'dir') throw new HttpError(400, 'Not a folder')
  const name = (path.split('/').pop() || 'folder').replace(/[\r\n"]/g, '_')
  const child = zipStream(user.username, path)
  child.stderr.on('data', () => {})
  child.on('error', () => { if (!res.headersSent) sendJson(res, 502, { error: 'Zip failed' }) })
  res.on('close', () => { try { child.kill('SIGKILL') } catch { /* */ } })
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${name}.zip"`,
    'Cache-Control': 'no-store',
  })
  child.stdout.pipe(res)
  await store.audit({ actor: user.username, action: 'file-zip', target: path })
}

// Streaming upload — pipes the request body through the helper (temp -> hash -> size check ->
// atomic rename). Server returns the verified sha256. A dropped connection never commits.
async function uploadFile(req, res, user) {
  const path = qparam(req, 'path')
  const sha = qparam(req, 'sha') || undefined
  const len = Number(req.headers['content-length'])
  const result = await writeStream(user.username, path, req, {
    expectedSha: sha,
    expectedSize: Number.isFinite(len) ? len : undefined,
  })
  await store.audit({ actor: user.username, action: 'file-upload', target: path, detail: { size: result.size } })
  sendJson(res, 201, { ok: true, ...result })
}

// ---- approvals / hosting requests ----------------------------------------
async function postRequest(req, res, user) {
  const body = await readJsonBody(req)
  const r = await createRequest({ user: user.username, kind: body?.kind || 'host-app', detail: body?.detail, requested: body?.requested })
  await store.audit({ actor: user.username, action: 'request', target: r.id, detail: { kind: r.kind, requested: r.requested ?? undefined } })
  sendJson(res, 201, r)
}

// ---- launch quotas ---------------------------------------------------------
// Own quota + usage (shown on the dashboard, with a "request more" flow).
async function getQuotaHandler(_req, res, user) {
  const all = await store.all()
  const used = all.filter((r) => r.owner === user.username && !isTerminal(r.state)).length
  const limit = await getQuotaLimit(user.username)
  const pendingReq = (await listRequests()).find((r) => r.user === user.username && r.kind === 'quota' && r.status === 'pending')
  sendJson(res, 200, {
    limit,
    used,
    defaultLimit: config.defaultQuota,
    max: config.maxInstancesPerUser,
    pendingRequest: pendingReq ? { id: pendingReq.id, requested: pendingReq.requested } : null,
  })
}

async function requestQuotaHandler(req, res, user) {
  const body = await readJsonBody(req)
  const requested = Math.round(Number(body?.limit))
  if (!Number.isFinite(requested) || requested < 1 || requested > config.maxInstancesPerUser) {
    throw new HttpError(400, `Requested quota must be between 1 and ${config.maxInstancesPerUser}.`)
  }
  const current = await getQuotaLimit(user.username)
  if (requested <= current) throw new HttpError(400, `Your quota is already ${current}.`)
  const r = await createRequest({
    user: user.username,
    kind: 'quota',
    detail: String(body?.reason || '').slice(0, 500) || `Requesting a quota of ${requested} simultaneous apps.`,
    requested,
  })
  await store.audit({ actor: user.username, action: 'quota-request', target: r.id, detail: { requested } })
  sendJson(res, 201, r)
}

// Admin: everyone's quota + live usage, and per-user set/clear.
async function adminQuotasHandler(_req, res, user) {
  requireAdmin(user)
  const [all, overrides, requests] = await Promise.all([store.all(), allQuotaOverrides(), listRequests()])
  const users = new Map()
  for (const [u, limit] of Object.entries(overrides)) users.set(u, { user: u, limit, override: true, active: 0 })
  for (const r of all) {
    if (isTerminal(r.state)) continue
    if (!users.has(r.owner)) users.set(r.owner, { user: r.owner, limit: config.defaultQuota, override: false, active: 0 })
    users.get(r.owner).active += 1
  }
  for (const r of requests) {
    if (r.kind !== 'quota' || r.status !== 'pending') continue
    if (!users.has(r.user)) users.set(r.user, { user: r.user, limit: config.defaultQuota, override: false, active: 0 })
    users.get(r.user).pendingRequested = r.requested
  }
  const rows = [...users.values()].sort((a, b) => b.active - a.active || a.user.localeCompare(b.user))
  sendJson(res, 200, { quotas: rows, defaultLimit: config.defaultQuota, max: config.maxInstancesPerUser })
}

async function setQuotaHandler(req, res, user, target) {
  requireAdmin(user)
  if (!/^[a-z_][a-z0-9._-]{0,31}$/.test(target)) throw new HttpError(400, 'Invalid username')
  const body = await readJsonBody(req)
  const limit = body?.limit === null ? null : Math.round(Number(body?.limit))
  if (limit !== null && (!Number.isFinite(limit) || limit < 1 || limit > config.maxInstancesPerUser)) {
    throw new HttpError(400, `Quota must be between 1 and ${config.maxInstancesPerUser} (or null to reset to the default).`)
  }
  const result = await setQuotaLimit(target, limit, user.username)
  await store.audit({ actor: user.username, action: 'quota-set', target, detail: { limit: result.limit, override: result.override } })
  sendJson(res, 200, result)
}
async function getRequests(_req, res, user) {
  requireAdmin(user)
  sendJson(res, 200, { requests: await listRequests(), pending: await pendingCount() })
}
function decideHandler(decision) {
  return async (_req, res, user, id) => {
    requireAdmin(user)
    const r = await decideRequest(id, decision, user.username)
    if (!r) throw new HttpError(404, 'Request not found')
    await store.audit({ actor: user.username, action: `request-${decision}`, target: id })
    sendJson(res, 200, r)
  }
}

// Admin: prune terminal (stopped/failed) AppHub instances so they leave the queue/lists.
async function clearFinished(_req, res, user) {
  requireAdmin(user)
  const all = await store.all()
  const dead = all.filter((r) => isTerminal(r.state))
  for (const r of dead) await store.remove(r.id)
  await store.audit({ actor: user.username, action: 'clear-finished', target: 'queue', detail: { count: dead.length } })
  sendJson(res, 200, { cleared: dead.length })
}

// ---- catalog templates ----------------------------------------------------
async function listTemplatesHandler(_req, res, user) {
  sendJson(res, 200, await templatesFor(user))
}
async function createTemplateHandler(req, res, user) {
  const body = await readJsonBody(req)
  const t = await createCustom(body, user)
  await store.audit({ actor: user.username, action: 'template-create', target: t.id, detail: { scope: t.scope, base: t.base } })
  sendJson(res, 201, t)
}
async function deleteTemplateHandler(_req, res, user, id) {
  await removeCustom(id, user)
  await store.audit({ actor: user.username, action: 'template-delete', target: id })
  sendNoContent(res)
}

// ---- vanity URLs (self-service custom subdomains) -------------------------
async function listVanityHandler(_req, res, user) {
  const all = await listVanity()
  sendJson(res, 200, user.role === 'admin' ? all : all.filter((v) => v.owner === user.username))
}
// Live availability check — lets any user verify a name themselves before claiming it.
async function checkVanityHandler(req, res, user) {
  const name = new URL(req.url, 'http://localhost').searchParams.get('name') || ''
  sendJson(res, 200, await checkVanity({ user: user.username, name }))
}
async function requestVanityHandler(req, res, user) {
  const body = await readJsonBody(req)
  const rec = await requestVanity({ user: user.username, name: body?.name })
  await store.audit({ actor: user.username, action: 'vanity-claim', target: rec.name, detail: { status: rec.status } })
  sendJson(res, 201, rec)
}
async function decideVanityHandler(req, res, user, name) {
  requireAdmin(user)
  const body = await readJsonBody(req)
  const rec = await decideVanity(name, body?.decision === 'approve' ? 'approve' : 'deny', user.username)
  if (!rec) throw new HttpError(404, 'No pending request for that name')
  await store.audit({ actor: user.username, action: 'vanity-decide', target: name, detail: { decision: rec.status } })
  sendJson(res, 200, rec)
}
async function removeVanityHandler(_req, res, user, name) {
  await removeVanity(name, user.username, user.role === 'admin')
  await store.audit({ actor: user.username, action: 'vanity-remove', target: name })
  sendNoContent(res)
}
// Toggle whether an app is reachable externally (on :8443) without login.
async function setPublicHandler(req, res, user, id) {
  const rec = await store.get(id)
  if (!rec) throw new HttpError(404, 'Not found')
  if (user.role !== 'admin' && rec.owner !== user.username) throw new HttpError(403, 'Not your app')
  const body = await readJsonBody(req)
  await store.update(id, { public: !!body?.public })
  await store.audit({ actor: user.username, action: 'set-public', target: id, detail: { public: !!body?.public } })
  await reconciler.runNow()
  sendJson(res, 200, publicInstance(await store.get(id)))
}

// ---- Nextflow pipeline launcher -------------------------------------------
async function listPipelinesHandler(_req, res, user) {
  sendJson(res, 200, (await pipelinesFor(user.username)).map(publicPipeline))
}
async function pipelineSchemaHandler(_req, res, user, id) {
  const p = await resolvePipeline(id, user.username)
  if (!p) throw new HttpError(404, 'Unknown pipeline')
  sendJson(res, 200, await fetchSchema(p))
}
async function pipelineProbeHandler(req, res, _user) {
  const u = new URL(req.url, 'http://localhost')
  sendJson(res, 200, await probeSchema({
    repo: u.searchParams.get('repo') || '',
    revision: u.searchParams.get('revision') || '',
    schemaUrl: u.searchParams.get('schemaUrl') || '',
  }))
}
async function addPipelineHandler(req, res, user) {
  const body = await readJsonBody(req)
  const p = await addCustomPipeline(body, user)
  await store.audit({ actor: user.username, action: 'pipeline-add', target: p.id, detail: { repo: p.repo, rev: p.revision } })
  sendJson(res, 201, publicPipeline(p))
}
async function removePipelineHandler(_req, res, user, id) {
  await removeCustomPipeline(id, user)
  await store.audit({ actor: user.username, action: 'pipeline-remove', target: id })
  sendNoContent(res)
}
async function launchPipelineHandler(req, res, user) {
  if (isReserved(user.username)) throw new HttpError(403, 'This account may not launch pipelines')
  const active = (await store.all()).filter((r) => r.owner === user.username && !isTerminal(r.state))
  const pipeQuota = await getQuotaLimit(user.username)
  if (active.length >= pipeQuota) {
    throw new HttpError(429, `You already have ${active.length} active apps/runs (your quota is ${pipeQuota}). Stop one first, or request a higher quota from the dashboard.`)
  }
  const body = await readJsonBody(req)
  const p = await resolvePipeline(body?.pipelineId, user.username)
  if (!p) throw new HttpError(400, 'Unknown pipeline')
  if (body?.configText && String(body.configText).length > 20000) throw new HttpError(400, 'Custom config is too large (20k char max)')
  const clamp = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d }
  const cpus = clamp(body?.cpus, 1, 112, p.defaults.cpus)
  const memoryMb = clamp(body?.memoryMb, 1024, 500000, p.defaults.memoryMb)
  const timeLimitMinutes = body?.timeMinutes === null ? null : clamp(body?.timeMinutes, 10, 20160, p.defaults.timeMinutes)
  const id = newId('job')
  const built = buildNextflowRun({ user: user.username, pipeline: p, params: body?.params, runName: body?.runName, outdir: body?.outdir, revision: body?.revision, runId: id, profiles: body?.profiles, configText: body?.configText })
  const name = uniqueName(pipelineSlug(body?.runName, p.id), new Set(active.map((r) => r.name)))
  const rec = {
    id, name, kind: 'batch', templateId: 'nextflow', templateName: p.name, icon: p.icon || 'flow-chart',
    owner: user.username, uid: user.uid, node: null, cpus, memoryMb, timeLimitMinutes,
    visibility: 'private', vanity: false, public: false,
    command: built.command, pipeline: p.id, pipelineName: p.name, runDir: built.runDir, outdir: built.outdir,
    state: 'queued', url: null, port: undefined, jobId: undefined, startedAt: null,
    message: 'Queued — waiting for an allocation…', createdAt: Date.now(),
  }
  await store.create(rec)
  try {
    const { jobId, node } = await slurm.launch({ templateId: 'nextflow', kind: 'batch', owner: user.username, uid: user.uid, name, cpus, memoryMb, timeMinutes: timeLimitMinutes, command: built.command })
    await store.update(id, { jobId, node: node ?? null })
  } catch (e) {
    await store.update(id, { state: 'failed', message: `Could not start: ${e.message}` })
    throw new HttpError(502, `Launch failed: ${e.message}`)
  }
  await store.audit({ actor: user.username, action: 'pipeline-launch', target: id, detail: { pipeline: p.id, rev: built.revision } })
  reconciler.runNow()
  sendJson(res, 201, publicInstance(await store.get(id)))
}

// ---- router ---------------------------------------------------------------
const ROUTES = [
  ['GET', /^\/healthz$/, async (_q, res) => sendJson(res, 200, { ok: true, slurm: slurm.mode, store: store.kind }), true],
  ['GET', /^\/api\/session$/, async (_q, res, user) =>
    sendJson(res, 200, user ? { authenticated: true, user: { ...user, power: await isPowerUser(user.username) } } : { authenticated: false }), true],
  ['DELETE', /^\/api\/session$/, async (_q, res) => sendNoContent(res), true],
  ['GET', /^\/api\/templates$/, listTemplatesHandler],
  ['POST', /^\/api\/templates$/, createTemplateHandler],
  ['DELETE', /^\/api\/templates\/([^/]+)$/, deleteTemplateHandler],
  ['GET', /^\/api\/apps$/, listApps],
  ['POST', /^\/api\/apps$/, launchApp],
  ['GET', /^\/api\/apps\/([^/]+)$/, getApp],
  ['POST', /^\/api\/apps\/([^/]+)\/stop$/, stopApp],
  ['POST', /^\/api\/apps\/([^/]+)\/extend$/, extendApp],
  ['GET', /^\/api\/apps\/([^/]+)\/logs$/, appLogs],
  ['POST', /^\/api\/drive-password$/, drivePassword],
  ['POST', /^\/api\/change-password$/, changePasswordHandler],
  ['GET', /^\/api\/cluster\/nodes$/, async (_q, res) => sendJson(res, 200, await buildCluster(slurm))],
  ['GET', /^\/api\/jobs$/, async (_q, res, user) => sendJson(res, 200, await buildJobs(store, user, slurm))],
  ['POST', /^\/api\/jobs\/([^/]+)\/cancel$/, cancelJob],
  ['POST', /^\/api\/admin\/clear-finished$/, clearFinished],
  ['GET', /^\/api\/files$/, getFiles],
  ['GET', /^\/api\/shares$/, getShares],
  ['GET', /^\/api\/files\/hash$/, hashFileHandler],
  ['GET', /^\/api\/files\/dirsize$/, dirSizeHandler],
  ['GET', /^\/api\/files\/download$/, downloadFile],
  ['GET', /^\/api\/files\/zip$/, zipFolder],
  ['POST', /^\/api\/files\/upload$/, uploadFile],
  ['POST', /^\/api\/files\/mkdir$/, mkdirFile],
  ['POST', /^\/api\/files\/mkfile$/, mkfileFile],
  ['POST', /^\/api\/files\/rename$/, renameFile],
  ['POST', /^\/api\/files\/delete$/, deleteFile],
  ['POST', /^\/api\/requests$/, postRequest],
  ['GET', /^\/api\/quota$/, getQuotaHandler],
  ['POST', /^\/api\/quota\/request$/, requestQuotaHandler],
  ['GET', /^\/api\/admin\/quotas$/, adminQuotasHandler],
  ['POST', /^\/api\/admin\/quotas\/([^/]+)$/, setQuotaHandler],
  ['GET', /^\/api\/admin\/requests$/, getRequests],
  ['POST', /^\/api\/admin\/requests\/([^/]+)\/approve$/, decideHandler('approve')],
  ['POST', /^\/api\/admin\/requests\/([^/]+)\/deny$/, decideHandler('deny')],
  ['GET', /^\/api\/pipelines$/, listPipelinesHandler],
  ['GET', /^\/api\/pipelines\/probe$/, pipelineProbeHandler],
  ['POST', /^\/api\/pipelines$/, addPipelineHandler],
  ['POST', /^\/api\/pipelines\/launch$/, launchPipelineHandler],
  ['GET', /^\/api\/pipelines\/([^/]+)\/schema$/, pipelineSchemaHandler],
  ['DELETE', /^\/api\/pipelines\/([^/]+)$/, removePipelineHandler],
  ['GET', /^\/api\/vanity$/, listVanityHandler],
  ['GET', /^\/api\/vanity\/check$/, checkVanityHandler],
  ['POST', /^\/api\/vanity$/, requestVanityHandler],
  ['POST', /^\/api\/vanity\/([^/]+)\/decide$/, decideVanityHandler],
  ['DELETE', /^\/api\/vanity\/([^/]+)$/, removeVanityHandler],
  ['POST', /^\/api\/apps\/([^/]+)\/public$/, setPublicHandler],
]

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname
  const user = resolveIdentity(req)

  for (const [method, pattern, handler, allowAnon] of ROUTES) {
    if (req.method !== method) continue
    const m = pattern.exec(path)
    if (!m) continue
    try {
      if (!allowAnon && !user) throw new HttpError(401, 'Authentication required')
      let param = ''
      try { param = decodeURIComponent(m[1] || '') } catch { throw new HttpError(400, 'Malformed path') }
      await handler(req, res, user, param)
    } catch (e) {
      if (e instanceof HttpError) sendJson(res, e.status, { error: e.message })
      else if (e && Number.isInteger(e.status) && e.status >= 400 && e.status < 600) sendJson(res, e.status, { error: e.message })
      else {
        console.error('[apphub] 500', e)
        sendJson(res, 500, { error: 'Internal error' })
      }
    }
    return
  }
  sendJson(res, 404, { error: 'Not found' })
})

const isPort = /^\d+$/.test(String(config.listen))
// TCP binds loopback by default (review CRITICAL #2); a path is a unix socket.
const listenOpts = isPort ? { port: Number(config.listen), host: config.bind } : { path: config.listen }

if (!isPort && existsSync(config.listen)) {
  try { unlinkSync(config.listen) } catch { /* ignore */ }
}

server.listen(listenOpts, () => {
  if (!isPort) { try { chmodSync(config.listen, 0o660) } catch { /* best effort */ } }
  const where = isPort ? `${config.bind}:${config.listen}` : config.listen
  console.log(`[apphub] control plane listening on ${where} — slurm=${slurm.mode} store=${store.kind} devAuth=${config.devAuth}`)
  reconciler.start()
})

// Never crash the control plane on an unexpected async error (review concurrency).
process.on('unhandledRejection', (e) => console.error('[apphub] unhandledRejection', e))

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    reconciler.stop()
    server.close(() => process.exit(0))
  })
}
