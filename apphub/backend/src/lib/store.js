import { config } from '../config.js'
import { createMemoryStore } from './memory-store.js'

// Pick the store: Postgres when DATABASE_URL is set (prod), else a file-backed in-memory
// store (dev). pg is imported lazily so dev never needs it installed/running.
export async function createStore() {
  if (config.databaseUrl) {
    const { createPostgresStore } = await import('./postgres-store.js')
    return createPostgresStore(config.databaseUrl)
  }
  return createMemoryStore(config.stateFile)
}

const TERMINAL = new Set(['stopped', 'failed'])

// Shared: choose a free port in the configured range given the live instances.
// Both stores call this for the in-process check; Postgres additionally enforces a
// partial-unique index as the real race guard (ADR-005).
export function pickFreePort(instances) {
  const used = new Set(instances.filter((i) => !TERMINAL.has(i.state) && i.port).map((i) => i.port))
  for (let p = config.portRange.min; p <= config.portRange.max; p++) {
    if (!used.has(p)) return p
  }
  return null
}

// Internal record -> public Instance shape the SPA expects (strips port/token/jobId).
export function publicInstance(r) {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind ?? 'app',
    templateId: r.templateId,
    templateName: r.templateName,
    icon: r.icon,
    owner: r.owner,
    node: r.node ?? null,
    cpus: r.cpus,
    memoryMb: r.memoryMb,
    state: r.state,
    url: r.url ?? null,
    publicUrl: r.publicUrl ?? null,
    public: !!r.public,
    vanity: !!r.vanity,
    visibility: r.visibility,
    startedAt: r.startedAt ?? null,
    timeLimitMinutes: r.timeLimitMinutes ?? null,
    elapsedMinutes: r.startedAt ? Math.floor((Date.now() - r.startedAt) / 60000) : 0,
    message: r.message,
  }
}

export function isTerminal(state) {
  return TERMINAL.has(state)
}
