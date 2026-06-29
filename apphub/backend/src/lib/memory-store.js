import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pickFreePort } from './store.js'

// File-backed in-memory store for dev. Atomic-ish persistence via temp+rename.
export function createMemoryStore(stateFile) {
  const file = resolve(process.cwd(), stateFile)
  let state = { instances: {}, audit: [] }
  let saveTimer = null

  try {
    state = JSON.parse(readFileSync(file, 'utf8'))
    state.instances ||= {}
    state.audit ||= []
  } catch {
    /* fresh */
  }

  function save() {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      try {
        mkdirSync(dirname(file), { recursive: true })
        const tmp = `${file}.tmp`
        writeFileSync(tmp, JSON.stringify(state, null, 2))
        renameSync(tmp, file)
      } catch (e) {
        console.error('[store] save failed', e.message)
      }
    }, 100)
  }

  return {
    kind: 'memory',
    async init() {},
    async all() {
      return Object.values(state.instances)
    },
    async get(id) {
      return state.instances[id] || null
    },
    async create(rec) {
      state.instances[rec.id] = rec
      save()
      return rec
    },
    async update(id, patch) {
      const cur = state.instances[id]
      if (!cur) return null
      Object.assign(cur, patch)
      save()
      return cur
    },
    async remove(id) {
      delete state.instances[id]
      save()
    },
    // Single-process: pickFreePort over current instances is sufficient; Postgres uses
    // FOR UPDATE SKIP LOCKED for the multi-writer guarantee.
    async allocatePort(_instanceId) {
      const port = pickFreePort(Object.values(state.instances))
      if (!port) throw new Error('No free ports in range')
      return port
    },
    // No-op for memory: pickFreePort already ignores terminal instances' ports.
    async freePort(_instanceId) {},
    async audit(entry) {
      state.audit.push({ ...entry, at: Date.now() })
      if (state.audit.length > 5000) state.audit = state.audit.slice(-4000)
      save()
    },
    async listAudit(limit = 200) {
      return state.audit.slice(-limit).reverse()
    },
  }
}
