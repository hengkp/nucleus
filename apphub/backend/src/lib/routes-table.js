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
  // Sit next to the upstreams map so nginx can `include` them from the same dir. The app
  // vhost uses these to enforce owner-only access: only the owner (or, for team/public apps,
  // any authenticated lab member) may reach an app URL — Authelia proves WHO you are, these
  // prove WHICH app is yours.
  const ownersFile = resolve(dirname(file), 'routes.owners')
  const visFile = resolve(dirname(file), 'routes.visibility')
  let timer = null
  let lastInternal = null
  let lastPublic = null
  let lastOwners = null
  let lastVis = null
  let pendingInstances = null
  // In-memory host -> {owner, visibility} for the per-request authz check (no DB hit per app
  // request). Refreshed on every publish from the reconciler.
  let hostMeta = new Map()

  // Build every map in one pass. Dedup by host so a stray collision can't break `nginx -t`.
  function render(instances) {
    const internal = []
    const pub = []
    const owners = []
    const visibility = []
    const meta = new Map()
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
      const vis = i.visibility === 'team' || i.visibility === 'public' ? i.visibility : 'private'
      internal.push(`${host} ${upstream}; # instance=${i.id} owner=${i.owner}`)
      owners.push(`${host} ${i.owner};`)
      visibility.push(`${host} ${vis};`)
      meta.set(host, { owner: i.owner, visibility: vis })
      if (i.public) {
        const phost = `${bh}.${config.publicDomain}`
        if (!seenPub.has(phost)) { seenPub.add(phost); pub.push(`${phost} ${upstream}; # instance=${i.id} owner=${i.owner} public`) }
      }
    }
    return {
      internal: internal.sort().join('\n') + '\n',
      public: pub.sort().join('\n') + '\n',
      owners: owners.sort().join('\n') + '\n',
      visibility: visibility.sort().join('\n') + '\n',
      meta,
    }
  }

  function writeAtomic(target, content) {
    mkdirSync(dirname(target), { recursive: true })
    const tmp = `${target}.tmp`
    writeFileSync(tmp, content)
    renameSync(tmp, target)
  }

  function flush() {
    timer = null
    const { internal, public: pub, owners, visibility, meta } = render(pendingInstances || [])
    pendingInstances = null
    hostMeta = meta // refresh the authz lookup even when the map text is unchanged
    if (internal === lastInternal && pub === lastPublic && owners === lastOwners && visibility === lastVis) return
    try {
      if (internal !== lastInternal) { writeAtomic(file, internal); lastInternal = internal }
      if (pub !== lastPublic) { writeAtomic(publicFile, pub); lastPublic = pub }
      if (owners !== lastOwners) { writeAtomic(ownersFile, owners); lastOwners = owners }
      if (visibility !== lastVis) { writeAtomic(visFile, visibility); lastVis = visibility }
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
    // {owner, visibility} for an app host, from the last published set (used by /api/authz).
    metaFor(host) {
      return hostMeta.get(host) || null
    },
  }
}
