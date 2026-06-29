import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { config } from '../config.js'

// JSON-file-backed store of vanity (custom) app subdomains. A vanity name is GLOBAL — once an admin
// approves "my-portfolio" for a user, that user's app named "my-portfolio" routes at
// my-portfolio.app.sisp.com (no -username suffix). Pending+approved names are both reserved so two
// users can't claim the same one. Single-process, atomic writes (mirrors approvals.js).
const FILE = config.vanityFile
let cache = null
let q = Promise.resolve()

const RE = /^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$/ // DNS label, 2-40 chars

// Names nobody may claim. A vanity lands on *.app.sisp.com (and *.sisp.freeddns.org externally),
// so these infra/service labels would otherwise shadow real endpoints or invite impersonation.
const RESERVED = new Set([
  'www', 'api', 'app', 'apps', 'admin', 'administrator', 'root',
  'mail', 'smtp', 'imap', 'pop', 'ftp', 'sftp', 'ssh', 'ns', 'ns1', 'ns2', 'dns', 'vpn', 'proxy', 'gateway', 'router', 'localhost', 'host',
  'static', 'assets', 'cdn', 'files', 'file', 'download', 'downloads', 'upload', 'uploads', 'media',
  'auth', 'sso', 'login', 'logout', 'oauth', 'authelia', 'account', 'accounts', 'register', 'signup', 'signin',
  'portal', 'dashboard', 'status', 'health', 'healthz', 'metrics', 'grafana', 'prometheus', 'kibana', 'monitoring', 'alert', 'alertmanager',
  'jupyter', 'jupyterhub', 'rstudio', 'galaxy', 'zulip', 'leantime', 'apphub', 'hub', 'mapdrive',
  'node1', 'node2', 'node3', 'node4', 'slurm', 'postgres', 'db', 'database', 'redis', 'minio', 's3', 'registry', 'harbor',
  'sisp', 'siriraj', 'support', 'help', 'contact', 'about', 'blog', 'docs', 'doc', 'wiki', 'git', 'gitlab', 'github',
  'test', 'demo', 'example', 'staging', 'prod', 'production', 'internal', 'private', 'public', 'secure', 'ssl', 'tls', 'cert', 'ca', 'console', 'manage', 'management',
])
function isReservedVanity(name) {
  return RESERVED.has(name) || config.reservedUsers.has(name)
}

async function load() {
  if (cache) return cache
  try { cache = JSON.parse(await readFile(FILE, 'utf8')) } catch { cache = { names: [] } }
  if (!Array.isArray(cache.names)) cache.names = []
  return cache
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

export function isValidVanity(name) {
  return typeof name === 'string' && RE.test(name)
}

export async function listVanity() {
  return (await load()).names.slice().sort((a, b) => b.createdAt - a.createdAt)
}

export async function pendingVanityCount() {
  return (await load()).names.filter((n) => n.status === 'pending').length
}

// Self-service availability check (no writes). available=true means requestVanity() will succeed
// for this user. Lets people find a free name themselves instead of filing a request.
export async function checkVanity({ user, name }) {
  const nm = String(name || '').toLowerCase()
  if (!isValidVanity(nm)) return { name: nm, available: false, reason: 'invalid' }
  if (isReservedVanity(nm)) return { name: nm, available: false, reason: 'reserved' }
  const taken = (await load()).names.find((n) => n.name === nm && n.status !== 'denied')
  if (taken) return { name: nm, available: taken.owner === user, reason: taken.owner === user ? 'yours' : 'taken' }
  return { name: nm, available: true, reason: 'ok' }
}

// Claim a vanity name. Self-service: granted IMMEDIATELY when it's valid, not reserved, and free
// (first-come, globally unique). No admin step — admins can still release a name later if needed.
export async function requestVanity({ user, name }) {
  const data = await load()
  const nm = String(name || '').toLowerCase()
  if (!isValidVanity(nm)) { const e = new Error('Name must be 2–40 chars: letters, digits, hyphens'); e.status = 400; throw e }
  if (isReservedVanity(nm)) { const e = new Error('That name is reserved — pick another'); e.status = 400; throw e }
  const taken = data.names.find((n) => n.name === nm && n.status !== 'denied')
  if (taken) {
    if (taken.owner !== user) { const e = new Error('That name is already taken'); e.status = 409; throw e }
    // Idempotent for the owner; upgrade any legacy 'pending' record to approved.
    if (taken.status !== 'approved') { taken.status = 'approved'; taken.decidedBy = 'auto'; taken.decidedAt = Date.now(); await save() }
    return taken
  }
  const now = Date.now()
  const rec = { name: nm, owner: user, status: 'approved', createdAt: now, decidedBy: 'auto', decidedAt: now }
  data.names.push(rec)
  await save()
  return rec
}

export async function decideVanity(name, decision, admin) {
  const data = await load()
  const rec = data.names.find((n) => n.name === String(name || '').toLowerCase() && n.status === 'pending')
  if (!rec) return null
  rec.status = decision === 'approve' ? 'approved' : 'denied'
  rec.decidedBy = admin
  rec.decidedAt = Date.now()
  await save()
  return rec
}

// Release a vanity name (admin, or the owner giving it up).
export async function removeVanity(name, requester, isAdmin) {
  const data = await load()
  const nm = String(name || '').toLowerCase()
  const rec = data.names.find((n) => n.name === nm)
  if (!rec) return false
  if (!isAdmin && rec.owner !== requester) { const e = new Error('Not your name'); e.status = 403; throw e }
  data.names = data.names.filter((n) => n.name !== nm)
  await save()
  return true
}

// Set of approved vanity names owned by a user (used at launch to route without the -username suffix).
export async function approvedVanityFor(user) {
  return new Set((await load()).names.filter((n) => n.status === 'approved' && n.owner === user).map((n) => n.name))
}
