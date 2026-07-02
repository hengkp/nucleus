import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { config } from '../config.js'
import { newId } from './id.js'

// Lightweight JSON-file-backed approvals store. Holds hosting/access requests and the set of
// users granted "power" (host-your-own-app) after approval. Single-process, atomic writes.
const FILE = config.approvalsFile
let cache = null
let q = Promise.resolve()

async function load() {
  if (cache) return cache
  try {
    cache = JSON.parse(await readFile(FILE, 'utf8'))
  } catch {
    cache = { requests: [], powerUsers: [] }
  }
  if (!Array.isArray(cache.requests)) cache.requests = []
  if (!Array.isArray(cache.powerUsers)) cache.powerUsers = []
  if (!cache.quotas || typeof cache.quotas !== 'object') cache.quotas = {}
  return cache
}

// Per-user simultaneous-apps quota. Bounded to [1, maxInstancesPerUser] — the existing
// hard ceiling keeps one user from exhausting the port pool no matter what is granted.
function clampQuota(n) {
  const v = Math.round(Number(n))
  if (!Number.isFinite(v)) return null
  return Math.min(Math.max(v, 1), config.maxInstancesPerUser)
}

export async function getQuotaLimit(user) {
  const data = await load()
  return clampQuota(data.quotas[user]) ?? config.defaultQuota
}

export async function setQuotaLimit(user, limit, admin) {
  const data = await load()
  if (limit === null || limit === undefined || limit === '') {
    delete data.quotas[user] // back to the default
  } else {
    const v = clampQuota(limit)
    if (v === null) throw new Error('invalid quota')
    data.quotas[user] = v
  }
  await save()
  return { user, limit: await getQuotaLimit(user), override: user in data.quotas, setBy: admin }
}

export async function allQuotaOverrides() {
  const data = await load()
  return { ...data.quotas }
}

async function save() {
  await mkdir(dirname(FILE), { recursive: true })
  q = q.then(async () => {
    const tmp = `${FILE}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8')
    await rename(tmp, FILE)
  })
  return q
}

export async function listRequests() {
  return (await load()).requests.slice().sort((a, b) => b.createdAt - a.createdAt)
}

export async function pendingCount() {
  return (await load()).requests.filter((r) => r.status === 'pending').length
}

export async function createRequest({ user, kind, detail, requested }) {
  const data = await load()
  const k = String(kind || 'host-app').slice(0, 40)
  const open = data.requests.find((r) => r.user === user && r.kind === k && r.status === 'pending')
  if (open) return open
  const req = {
    id: newId('req'),
    user,
    kind: k,
    detail: String(detail || '').slice(0, 500),
    // quota requests carry the asked-for limit so approving applies it in one click
    requested: k === 'quota' ? clampQuota(requested) : null,
    status: 'pending',
    createdAt: Date.now(),
    decidedBy: null,
    decidedAt: null,
  }
  data.requests.push(req)
  await save()
  return req
}

export async function decideRequest(id, decision, admin) {
  const data = await load()
  const req = data.requests.find((r) => r.id === id)
  if (!req) return null
  req.status = decision === 'approve' ? 'approved' : 'denied'
  req.decidedBy = admin
  req.decidedAt = Date.now()
  if (req.status === 'approved' && req.kind === 'host-app' && !data.powerUsers.includes(req.user)) {
    data.powerUsers.push(req.user)
  }
  // Approving a quota request grants the asked-for limit immediately.
  if (req.status === 'approved' && req.kind === 'quota') {
    const v = clampQuota(req.requested)
    if (v !== null) data.quotas[req.user] = v
  }
  if (req.status === 'denied') {
    const i = data.powerUsers.indexOf(req.user)
    if (i >= 0 && req.kind === 'host-app') data.powerUsers.splice(i, 1)
  }
  await save()
  return req
}

export async function isPowerUser(user) {
  return (await load()).powerUsers.includes(user)
}
