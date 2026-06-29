import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { config } from '../config.js'
import { HttpError } from './http.js'
import { newId } from './id.js'
import { loadTemplates, getTemplate, publicTemplate } from './templates.js'

// User/admin-defined catalog presets. A custom template is a saved launch config on top of a
// built-in execution backend (its `base`): same image/runner, preset resources + entrypoint/
// command/folder. scope='shared' (admin, everyone sees) or 'personal' (owner only).
const FILE = config.customTemplatesFile
const CATEGORIES = new Set(['Notebook', 'App', 'Tooling', 'Static'])
let cache = null
let q = Promise.resolve()

async function load() {
  if (cache) return cache
  try {
    cache = JSON.parse(await readFile(FILE, 'utf8'))
  } catch {
    cache = { templates: [] }
  }
  if (!Array.isArray(cache.templates)) cache.templates = []
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

// A launchable built-in usable as an execution backend: either it carries a baked image, or
// it's a "bring your own image" backend (the user supplies a .sif from their locker).
function validBase(id) {
  const b = getTemplate(id)
  return b && (b.image || b.byoImage) ? b : null
}

// "Bring your own .sif" backends store the locker-relative image path as the entrypoint. Mirror
// the sudo wrapper's shape (<=128 chars, no traversal, .sif) so a bad path fails here with a
// clear message instead of deep inside SLURM.
function validateByo(base, def) {
  const img = String(def?.entrypoint ?? '').trim()
  if (!img) throw new HttpError(400, 'Enter the path to your .sif image in your locker')
  if (img.length > 128 || img.includes('..') || img.startsWith('/') || !/^[A-Za-z0-9._/-]+\.sif$/.test(img)) {
    throw new HttpError(400, 'Image path must be a locker-relative .sif file (letters, numbers, and . _ - /)')
  }
  if (!String(def?.command ?? '').trim()) {
    throw new HttpError(400, base.kind === 'batch' ? 'Enter the command to run in the container' : 'Enter a start command that listens on $PORT')
  }
}

// Custom preset -> full internal template (incl. image + preset* fields for launch).
export function synth(c) {
  const base = validBase(c.base)
  if (!base) return null
  return {
    id: c.id,
    name: c.name,
    category: CATEGORIES.has(c.category) ? c.category : base.category,
    description: c.description || base.description,
    icon: c.icon || base.icon,
    kind: base.kind || 'app',
    image: base.image,
    needsEntrypoint: base.needsEntrypoint,
    preinstalled: base.preinstalled,
    defaults: {
      cpus: c.cpus ?? base.defaults.cpus,
      memoryMb: c.memoryMb ?? base.defaults.memoryMb,
      timeMinutes: c.timeMinutes ?? base.defaults.timeMinutes,
    },
    limits: base.limits,
    enabled: true,
    custom: true,
    base: c.base,
    scope: c.scope,
    owner: c.owner,
    presetEntrypoint: c.entrypoint || undefined,
    presetCommand: c.command || undefined,
    presetFolder: c.folder || undefined,
  }
}

// Built-in OR custom, by id — full internal object (used by launch).
export async function resolveTemplate(id) {
  const builtin = getTemplate(id)
  if (builtin) return builtin
  const c = (await load()).templates.find((t) => t.id === id)
  return c ? synth(c) : null
}

// Public catalog for a given user: built-ins + shared customs + the user's own personal ones.
export async function templatesFor(user) {
  const builtins = loadTemplates().map(publicTemplate)
  const customs = (await load()).templates
    .filter((c) => c.scope === 'shared' || c.owner === user.username)
    .map(synth)
    .filter(Boolean)
    .map(publicTemplate)
  return [...builtins, ...customs]
}

const clampInt = (v, min, max, dflt) => {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.min(Math.max(n, min), max)
}

export async function createCustom(def, user) {
  const base = validBase(def?.base)
  if (!base) throw new HttpError(400, 'Pick a valid base app for the template')
  if (base.byoImage) validateByo(base, def)
  const scope = def?.scope === 'shared' ? 'shared' : 'personal'
  if (scope === 'shared' && user.role !== 'admin') throw new HttpError(403, 'Only admins can publish shared templates')
  const name = String(def?.name ?? '').trim().slice(0, 60)
  if (!name) throw new HttpError(400, 'A template name is required')
  const data = await load()
  if (data.templates.length >= 500) throw new HttpError(429, 'Template limit reached')

  const rec = {
    id: newId('tpl'),
    name,
    icon: String(def?.icon ?? base.icon).trim().slice(0, 40) || base.icon,
    category: CATEGORIES.has(def?.category) ? def.category : base.category,
    description: String(def?.description ?? '').trim().slice(0, 240) || base.description,
    base: def.base,
    scope,
    owner: user.username,
    cpus: clampInt(def?.cpus, 1, base.limits.maxCpus, base.defaults.cpus),
    memoryMb: clampInt(def?.memoryMb, 256, base.limits.maxMemoryMb, base.defaults.memoryMb),
    timeMinutes: clampInt(def?.timeMinutes, 5, base.limits.maxTimeMinutes, base.defaults.timeMinutes),
    entrypoint: def?.entrypoint ? String(def.entrypoint).trim().slice(0, 200) : undefined,
    command: def?.command ? String(def.command).trim().slice(0, 2000) : undefined,
    folder: def?.folder ? String(def.folder).trim().replace(/^\/+|\/+$/g, '').slice(0, 200) : undefined,
    createdAt: Date.now(),
  }
  data.templates.push(rec)
  await save()
  return synth(rec)
}

export async function removeCustom(id, user) {
  const data = await load()
  const t = data.templates.find((x) => x.id === id)
  if (!t) throw new HttpError(404, 'Template not found')
  const mayDelete = user.role === 'admin' || t.owner === user.username
  if (!mayDelete) throw new HttpError(403, 'Not your template')
  data.templates = data.templates.filter((x) => x.id !== id)
  await save()
  return { ok: true }
}
