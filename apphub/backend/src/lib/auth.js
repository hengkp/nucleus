import { timingSafeEqual } from 'node:crypto'
import { config, roleForGroups } from '../config.js'

const GROUP_RE = /^[a-z0-9-]{1,32}$/ // ADR-001: group cns must be split/inject-safe

function titleCase(u) {
  return u.replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// Resolve the caller's identity. In production this comes ONLY from headers that nginx /
// sisp-sso injected, and only when the shared proxy secret matches (so a direct request
// to the unix socket / port cannot spoof identity). The backend never trusts inbound
// X-Remote-* without the secret. (ADR-001, RISKS #4.)
export function resolveIdentity(req) {
  if (config.devAuth) {
    return {
      username: 'kriengkraip',
      displayName: 'Kriengkrai P. (dev)',
      role: 'power',
      uid: 10012,
      groups: ['sisp', 'apphub-power'],
    }
  }

  // Header-trust must FAIL CLOSED: with no configured secret we cannot establish that a
  // request came from the trusted edge, so we trust nobody (review CRITICAL #1). The boot
  // guard also refuses to start in this state, but defend here too.
  if (!config.proxySecret) return null
  const presented = Buffer.from(String(req.headers['x-auth-proxy'] || ''))
  const expected = Buffer.from(config.proxySecret)
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null

  const username = (req.headers[config.headerUser] || '').toString().trim()
  if (!username) return null

  const rawGroups = (req.headers[config.headerGroups] || '').toString()
  const groups = rawGroups
    .split(/[,\s]+/)
    .map((g) => g.trim())
    .filter((g) => g && GROUP_RE.test(g)) // drop malformed entries (defense in depth)

  // Don't coerce a missing/invalid uid to 0 (root); leave it null (review LOW). The
  // sbatch wrapper re-resolves the real uid via getent regardless.
  const uidRaw = Number(req.headers['x-remote-uid'])
  const uid = Number.isInteger(uidRaw) && uidRaw > 0 ? uidRaw : null
  const displayName = (req.headers['x-remote-name'] || '').toString().trim() || titleCase(username)

  return { username, displayName, role: roleForGroups(groups), uid, groups }
}

export function isReserved(username) {
  return config.reservedUsers.has(username)
}
