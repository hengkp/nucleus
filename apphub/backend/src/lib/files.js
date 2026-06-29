import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { config } from '../config.js'
import { HttpError } from './http.js'

const pexec = promisify(execFile)

// Normalize + validate a locker-relative path. The real security boundary is runuser (the
// op runs AS the user) plus realpath-confinement in the helper, so we allow ordinary
// filename characters — only a `..` path segment (traversal) and control chars (which would
// also break the tab/newline-delimited list output) are rejected. `requireNonEmpty` forbids
// the empty (locker-root) path for ops that act on a specific item.
function clean(subpath, requireNonEmpty = false) {
  const sub = String(subpath ?? '').replace(/^\/+|\/+$/g, '')
  if (sub.length > 4096) throw new HttpError(400, 'Path is too long')
  if (/[\x00-\x1f\x7f]/.test(sub)) throw new HttpError(400, 'Invalid characters in path')
  if (sub.split('/').some((s) => s === '..')) throw new HttpError(400, 'Path traversal is not allowed')
  if (requireNonEmpty && !sub) throw new HttpError(400, 'A file or folder name is required')
  return sub
}

function ensureConfigured() {
  if (!config.fileHelper) throw new HttpError(503, 'File manager is not configured on this server.')
}

// Run a capture-style op (everything except read/write streaming).
async function run(username, op, args = {}) {
  ensureConfigured()
  const argv = [config.fileHelper, '--user', username, '--op', op]
  if (args.path !== undefined) argv.push('--path', args.path)
  if (args.path2 !== undefined) argv.push('--path2', args.path2)
  if (args.sha !== undefined) argv.push('--sha', args.sha)
  if (args.rootPath !== undefined) argv.push('--rootpath', args.rootPath)
  try {
    const { stdout } = await pexec('sudo', argv, { timeout: 20000, maxBuffer: 8_000_000 })
    return stdout
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString().trim().slice(0, 200)
    // Map helper exit codes to friendly HTTP errors.
    if (/already exists|destination exists/.test(msg)) throw new HttpError(409, msg)
    if (/no such|missing|not a (dir|file)/.test(msg)) throw new HttpError(404, msg || 'Not found')
    if (/out of locker|bad |refuse|reserved|traversal/.test(msg)) throw new HttpError(400, msg)
    throw new HttpError(502, msg || `File operation failed (${op})`)
  }
}

// rootPath (optional) = an absolute SHARED NAS root under /mnt to browse read-only (instead of the
// locker). The helper enforces "/mnt only + read-only" and still runs as the user (perms apply).
export async function listFiles(username, subpath = '', rootPath = '') {
  const sub = clean(subpath)
  if (rootPath && !/^\/mnt\/[^\0]+$/.test(rootPath)) throw new HttpError(400, 'Shared root must be under /mnt')
  const stdout = await run(username, 'list', { path: sub, rootPath: rootPath || undefined })
  const entries = stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [type, size, mtime, ...n] = l.split('\t')
      return { type, size: Number(size) || 0, mtime: Number(mtime) || 0, name: n.join('\t') }
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
  return { path: sub, entries }
}

export async function statFile(username, subpath) {
  const sub = clean(subpath, true)
  const [type, size, mtime] = (await run(username, 'stat', { path: sub })).trim().split('\t')
  return { type, size: Number(size) || 0, mtime: Number(mtime) || 0, name: sub.split('/').pop() }
}

export const makeDir = (username, subpath) => run(username, 'mkdir', { path: clean(subpath, true) }).then(() => ({ ok: true }))
export const makeFile = (username, subpath) => run(username, 'mkfile', { path: clean(subpath, true) }).then(() => ({ ok: true }))
export const removePath = (username, subpath) => run(username, 'delete', { path: clean(subpath, true) }).then(() => ({ ok: true }))
export const renamePath = (username, src, dst) =>
  run(username, 'rename', { path: clean(src, true), path2: clean(dst, true) }).then(() => ({ ok: true }))
export const hashFile = (username, subpath) => run(username, 'hash', { path: clean(subpath, true) }).then((s) => ({ sha256: s.trim() }))
// Folder content size in bytes (-1 = unknown / timed out on a very large tree).
export const dirSize = (username, subpath) =>
  run(username, 'dirsize', { path: clean(subpath, true) }).then((s) => ({ size: Number(s.trim()) }))

// Streaming download: returns the child process. Caller pipes child.stdout to the response
// and must handle stderr/exit. Memory stays bounded for arbitrarily large files.
export function readStream(username, subpath) {
  ensureConfigured()
  const sub = clean(subpath, true)
  return spawn('sudo', [config.fileHelper, '--user', username, '--op', 'read', '--path', sub], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

// Streaming .zip of a folder (entry-by-entry; bounded memory). Caller pipes child.stdout.
export function zipStream(username, subpath) {
  ensureConfigured()
  const sub = clean(subpath, true)
  return spawn('sudo', [config.fileHelper, '--user', username, '--op', 'zipdir', '--path', sub], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

// Streaming upload: pipes `source` into the helper's stdin (-> temp file -> hash -> atomic
// rename). Resolves with the server-computed {sha256, size}. If `expectedSha` is given, the
// helper rejects on mismatch so a corrupt/partial transfer never becomes a committed file.
export function writeStream(username, subpath, source, { expectedSha, expectedSize } = {}) {
  ensureConfigured()
  const sub = clean(subpath, true)
  const argv = [config.fileHelper, '--user', username, '--op', 'write', '--path', sub]
  if (expectedSha) {
    if (!/^[a-f0-9]{64}$/.test(expectedSha)) return Promise.reject(new HttpError(400, 'Invalid expected hash'))
    argv.push('--sha', expectedSha)
  }
  if (expectedSize != null && Number.isFinite(expectedSize)) argv.push('--size', String(expectedSize))
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', argv, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = '', settled = false
    const fail = (e) => { if (!settled) { settled = true; reject(e) } }
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.stdin.on('error', () => {}) // swallow EPIPE if the child exits early
    child.on('error', (e) => fail(new HttpError(502, e.message)))
    child.on('close', (code) => {
      if (settled) return
      if (code === 0) {
        settled = true
        const [sha256, size] = out.trim().split('\t')
        resolve({ sha256, size: Number(size) || 0 })
      } else {
        const msg = err.trim().slice(0, 200)
        fail(new HttpError(code === 75 ? 422 : /already exists|directory/.test(msg) ? 409 : 502, msg || 'Upload failed'))
      }
    })
    // If the client aborts mid-upload, kill the helper so it never commits a partial file.
    const onAbort = () => { try { child.kill('SIGKILL') } catch { /* */ } fail(new HttpError(400, 'Upload aborted')) }
    source.on('error', onAbort)
    source.on('aborted', onAbort)
    source.pipe(child.stdin)
  })
}
