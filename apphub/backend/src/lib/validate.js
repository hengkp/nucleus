import { HttpError } from './http.js'

// Produce a DNS-safe slug for the per-instance host. REJECTS over-length input rather
// than silently truncating — silent truncation can collide two users' hosts and cause a
// cross-user misroute (ADR-003 / ARCHITECTURE backend section).
export function slugFromName(raw, fallback) {
  const input = (raw ?? '').toString().trim()
  if (!input) {
    const fb = fallback.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
    return fb || 'app'
  }
  if (input.length > 40) throw new HttpError(400, 'Name must be 40 characters or fewer')
  const slug = input.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!slug) throw new HttpError(400, 'Name must contain letters or numbers')
  return slug
}

// Make a name unique among a set of already-taken names by appending -2, -3, … The per-instance
// host is `${name}-${owner}.app`, so two same-named apps from one user would share a URL AND emit
// a duplicate key into the nginx routes map (which fails `nginx -t`). Keeps the result a valid
// <=40-char slug by trimming the base before the suffix.
export function uniqueName(base, taken) {
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`
    const candidate = (base.slice(0, 40 - suffix.length).replace(/-+$/, '') || 'app') + suffix
    if (!taken.has(candidate)) return candidate
  }
  return `${base.slice(0, 30)}-x`
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}

// Validate + clamp a launch request to the template's envelope. The server is the
// authority on resources/visibility — the client's values are advisory (RISKS, ADR-006).
export function normalizeLaunch(body, template) {
  if (!template) throw new HttpError(400, 'Unknown template')
  if (!template.enabled) throw new HttpError(403, 'This template requires approval before launch')

  const name = slugFromName(body?.name, template.id)
  const isBatch = template.kind === 'batch'

  // Optional folder = a subpath inside the user's locker to run/serve from (e.g. a static
  // site project dir). Relative, no traversal, no leading slash.
  let folder = String(body?.folder ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (folder) {
    if (folder.includes('..') || folder.length > 200 || !/^[A-Za-z0-9._ \/-]+$/.test(folder)) {
      throw new HttpError(400, 'Invalid folder path')
    }
  }

  // Custom templates can satisfy "needs an entry file" / "needs a command" from their saved
  // presets, so the launch wizard doesn't have to re-enter them (launchApp merges presets in).
  if (!isBatch && template.needsEntrypoint && !(body?.entrypoint && String(body.entrypoint).trim()) && !template.presetEntrypoint) {
    throw new HttpError(400, 'This template needs an entry file')
  }
  let command
  if (isBatch) {
    command = String(body?.command ?? '').trim()
    if (!command && !template.presetCommand) throw new HttpError(400, 'A command to run is required')
    if (command.length > 4000) throw new HttpError(400, 'Command is too long')
  }

  const cpus = clampInt(body?.cpus, 1, template.limits.maxCpus, template.defaults.cpus)
  const memoryMb = clampInt(body?.memoryMb, 256, template.limits.maxMemoryMb, template.defaults.memoryMb)

  let timeMinutes
  if (body?.timeMinutes === null) timeMinutes = null
  else timeMinutes = clampInt(body?.timeMinutes, 1, template.limits.maxTimeMinutes, template.defaults.timeMinutes)

  // private/team only — 'public' visibility is never self-assertable (RISKS #27). External exposure
  // is a SEPARATE explicit opt-in (`public` flag below), which only changes routing (adds an
  // anonymous :8443 route), not the in-app visibility model. Batch jobs are private + never public.
  const visibility = isBatch ? 'private' : body?.visibility === 'team' ? 'team' : 'private'

  return {
    name,
    kind: isBatch ? 'batch' : 'app',
    cpus,
    memoryMb,
    timeMinutes,
    entrypoint: !isBatch && body?.entrypoint ? String(body.entrypoint).trim() : undefined,
    command,
    folder: folder || undefined,
    visibility,
    public: !isBatch && body?.public === true,
  }
}
