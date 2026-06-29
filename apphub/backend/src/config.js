import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Minimal .env loader (no dependency). Only sets vars that aren't already in env.
function loadDotEnv() {
  try {
    const raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    }
  } catch {
    /* no .env — fine */
  }
}
loadDotEnv()

const env = process.env
const bool = (v, d = false) => (v === undefined ? d : v === '1' || v === 'true')
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])

// Single source of truth for reserved accounts — kept in sync with the sbatch wrapper
// denylist so the two trust boundaries can't drift (review LOW).
export const DEFAULT_RESERVED = ['root', 'nodeadmin', 'admin', 'daemon', 'bin', 'sys', 'slurm', 'postgres', 'nobody']

export const config = {
  listen: env.APPHUB_LISTEN || '8792',
  // For a TCP port, bind loopback by default — never all interfaces (review CRITICAL #2).
  bind: env.APPHUB_BIND || '127.0.0.1',
  devAuth: bool(env.APPHUB_DEV_AUTH, false),
  proxySecret: env.APPHUB_PROXY_SECRET || '',
  maxInstancesPerUser: Number(env.APPHUB_MAX_PER_USER || 8),
  // Self-service extend ("top-up"): each click adds this much, up to the hard cap. Beyond the
  // cap, users request the admin-approved persistent track.
  extendStepMinutes: Number(env.APPHUB_EXTEND_STEP_MIN || 720), // +12h per click
  timeMaxMinutes: Number(env.APPHUB_TIME_MAX_MIN || 10080), // 7-day ceiling for top-ups
  nodeEnv: env.NODE_ENV || '',
  headerUser: (env.APPHUB_HEADER_USER || 'x-remote-user').toLowerCase(),
  headerGroups: (env.APPHUB_HEADER_GROUPS || 'x-remote-groups').toLowerCase(),
  slurmMode: env.APPHUB_SLURM_MODE || 'mock',
  sbatchWrapper: env.APPHUB_SBATCH_WRAPPER || '',
  fileHelper: env.APPHUB_FILE_HELPER || '',
  databaseUrl: env.DATABASE_URL || '',
  stateFile: env.APPHUB_STATE_FILE || './.data/state.json',
  approvalsFile: env.APPHUB_APPROVALS_FILE || './.data/approvals.json',
  customTemplatesFile: env.APPHUB_CUSTOM_TEMPLATES_FILE || './.data/custom-templates.json',
  vanityFile: env.APPHUB_VANITY_FILE || './.data/vanity.json',
  routesMap: env.APPHUB_ROUTES_MAP || './.data/routes.map',
  // Public/external route map: host(on publicDomain) -> upstream, for apps the owner marked public.
  // These are served on :8443 WITHOUT Authelia (anonymous) — for portfolios/demos.
  publicRoutesMap: env.APPHUB_PUBLIC_ROUTES_MAP || './.data/routes.public.map',
  nginxReload: env.APPHUB_NGINX_RELOAD || '',
  appDomain: env.APPHUB_APP_DOMAIN || 'app.sisp.com',
  // External wildcard domain (NAT'd from the router on :8443). A public app at
  // <name>.app.sisp.com is also reachable at <name>.<publicDomain>:8443.
  publicDomain: env.APPHUB_PUBLIC_DOMAIN || 'sisp.freeddns.org',
  externalPort: env.APPHUB_EXTERNAL_PORT || '8443',
  reservedUsers: new Set(list(env.APPHUB_RESERVED_USERS).concat(DEFAULT_RESERVED)),

  // Cluster topology — hard-coded IP allowlist (ADR-003: never trust job-written hosts).
  // Verified live (2026-06-27 pre-flight): each node is 112 cores / 515600 MB (~503 GiB),
  // i.e. ~448 cores / ~2 TB total. node1 runs the control plane (slurmctld + LDAP + nginx +
  // Postgres) and is drained from scheduling.
  nodes: [
    { name: 'node1', host: '192.168.0.25', controlPlane: true, cpuTotal: 112, memTotalMb: 515600 },
    { name: 'node2', host: '192.168.0.26', controlPlane: false, cpuTotal: 112, memTotalMb: 515600 },
    { name: 'node3', host: '192.168.0.27', controlPlane: false, cpuTotal: 112, memTotalMb: 515600 },
    { name: 'node4', host: '192.168.0.28', controlPlane: false, cpuTotal: 112, memTotalMb: 515600 },
  ],

  // Port range handed to app instances on compute nodes (host-firewalled from the LAN).
  portRange: { min: 31000, max: 31999 },

  // Reconcile cadence — backend-paced, independent of any client (ADR-006 / RISKS #8).
  reconcileMs: Number(env.APPHUB_RECONCILE_MS || 5000),

  // Self-service "set my drive password": seeds sambaNTPassword from the password the user
  // already uses (no rotation). Disabled unless configured (needs the samba-pwsync bind).
  drivePassword: {
    enabled: bool(env.APPHUB_DRIVE_PW_ENABLED, false),
    ldapUri: env.APPHUB_LDAP_URI || 'ldap://127.0.0.1',
    peopleBase: env.APPHUB_LDAP_PEOPLE_BASE || 'ou=People,dc=siriraj,dc=local',
    pwsyncDN: env.APPHUB_PWSYNC_DN || 'cn=samba-pwsync,dc=siriraj,dc=local',
    pwsyncPassword: env.APPHUB_PWSYNC_PASSWORD || '',
    domainSid: env.APPHUB_SAMBA_DOMAIN_SID || '',
  },
}

// node name -> IP, for squeue %N -> upstream derivation (ADR-003).
export const NODE_IP = new Map(config.nodes.map((n) => [n.name, n.host]))
export const ALLOWED_IPS = new Set(config.nodes.map((n) => n.host))

// Fail-closed boot checks (review CRITICAL #1, HIGH devAuth). Returns fatal messages.
export function bootGuards() {
  const fatal = []
  const looksProd = !!config.databaseUrl || config.slurmMode === 'slurm' || config.nodeEnv === 'production'
  if (config.devAuth && looksProd) {
    fatal.push('APPHUB_DEV_AUTH must be OFF in production (DATABASE_URL / slurm mode / NODE_ENV=production detected).')
  }
  if (!config.devAuth && !config.proxySecret) {
    fatal.push('APPHUB_PROXY_SECRET is required when APPHUB_DEV_AUTH is off (header-trust must fail closed).')
  }
  return fatal
}

export function roleForGroups(groups) {
  if (groups.includes('sisp-admins')) return 'admin'
  if (groups.includes('apphub-power')) return 'power'
  return 'researcher'
}
