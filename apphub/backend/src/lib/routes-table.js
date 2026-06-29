import { mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { exec } from 'node:child_process'
import { config } from '../config.js'
import { nodeUpstream } from './slurm.js'

// Owns the nginx route maps:
//  - internal map (config.routesMap):       <host>.app.sisp.com       -> upstream  (ALL routed apps, SSO-gated)
//  - public  map (config.publicRoutesMap):  <host>.sisp.freeddns.org  -> upstream  (apps the owner marked public; served on :8443 WITHOUT Authelia)
// where <host> is the bare name for an approved vanity app, else <name>-<owner>.
// Writes are debounced + atomic (temp+rename); the nginx reload is coalesced (ADR-003 / RISKS #8).
export function baseHost(i) {
  return i.vanity ? i.name : `${i.name}-${i.owner}`
}

export function createRouteTable() {
  const file = resolve(process.cwd(), config.routesMap)
  const publicFile = resolve(process.cwd(), config.publicRoutesMap)
  let timer = null
  let lastInternal = null
  let lastPublic = null
  let pendingInstances = null

  // Build both maps in one pass. Dedup by host so a stray collision can't break `nginx -t`.
  function render(instances) {
    const internal = []
    const pub = []
    const seen = new Set()
    const seenPub = new Set()
    const ordered = [...instances].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    for (const i of ordered) {
      if (i.state !== 'running' && i.state !== 'expiring') continue
      if (i.kind === 'batch') continue
      const upstream = nodeUpstream(i.node, i.port)
      if (!upstream) continue
      const bh = baseHost(i)
      const host = `${bh}.${config.appDomain}`
      if (seen.has(host)) { console.error(`[routes] dropping duplicate host ${host} (instance=${i.id})`); continue }
      seen.add(host)
      internal.push(`${host} ${upstream}; # instance=${i.id} owner=${i.owner}`)
      if (i.public) {
        const phost = `${bh}.${config.publicDomain}`
        if (!seenPub.has(phost)) { seenPub.add(phost); pub.push(`${phost} ${upstream}; # instance=${i.id} owner=${i.owner} public`) }
      }
    }
    return { internal: internal.sort().join('\n') + '\n', public: pub.sort().join('\n') + '\n' }
  }

  function writeAtomic(target, content) {
    mkdirSync(dirname(target), { recursive: true })
    const tmp = `${target}.tmp`
    writeFileSync(tmp, content)
    renameSync(tmp, target)
  }

  function flush() {
    timer = null
    const { internal, public: pub } = render(pendingInstances || [])
    pendingInstances = null
    if (internal === lastInternal && pub === lastPublic) return
    try {
      if (internal !== lastInternal) { writeAtomic(file, internal); lastInternal = internal }
      if (pub !== lastPublic) { writeAtomic(publicFile, pub); lastPublic = pub }
    } catch (e) {
      console.error('[routes] write failed', e.message)
      return
    }
    if (config.nginxReload) {
      // The reload command runs `nginx -t` and only reloads on success (the deploy ships a wrapper).
      exec(config.nginxReload, (err, _out, stderr) => {
        if (err) console.error('[routes] nginx reload failed', stderr || err.message)
      })
    }
  }

  return {
    file,
    publicFile,
    publish(instances) {
      pendingInstances = instances
      if (!timer) timer = setTimeout(flush, 300)
    },
    current() {
      try { return readFileSync(file, 'utf8') } catch { return '' }
    },
  }
}
