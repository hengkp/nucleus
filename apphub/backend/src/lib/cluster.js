import { config } from '../config.js'
import { isTerminal } from './store.js'

// Build the cluster-health view from SLURM node loads (sinfo in prod, in-memory in mock).
// node1 carries a small synthetic control-plane baseline so the dashboard reflects that
// it is busy serving the platform, not schedulable for user jobs.
export async function buildCluster(slurm) {
  const loads = await slurm.nodeLoads()
  const nodes = config.nodes.map((n) => {
    const l = loads.get(n.name) || { cpu: 0, mem: 0 }
    const cpuUsed = n.controlPlane ? Math.max(l.cpu, 6) : l.cpu
    const memUsedMb = n.controlPlane ? Math.max(l.mem, 41000) : l.mem
    return {
      name: n.name,
      host: n.host,
      state: n.controlPlane ? 'control' : 'up',
      cpuTotal: n.cpuTotal,
      cpuUsed: Math.min(cpuUsed, n.cpuTotal),
      memTotalMb: n.memTotalMb,
      memUsedMb: Math.min(memUsedMb, n.memTotalMb),
      controlPlane: n.controlPlane,
    }
  })
  const totals = nodes.reduce(
    (a, n) => ({
      cpuTotal: a.cpuTotal + n.cpuTotal,
      cpuUsed: a.cpuUsed + n.cpuUsed,
      memTotalMb: a.memTotalMb + n.memTotalMb,
      memUsedMb: a.memUsedMb + n.memUsedMb,
    }),
    { cpuTotal: 0, cpuUsed: 0, memTotalMb: 0, memUsedMb: 0 },
  )
  return { nodes, totals }
}

function mapSlurmState(s) {
  if (!s) return 'RUNNING'
  if (/PEND|CONFIG/i.test(s)) return 'PENDING'
  if (/RUN/i.test(s)) return 'RUNNING'
  if (/COMPL/i.test(s)) return 'COMPLETING'
  if (/FAIL|CANCEL|TIMEOUT|OOM|NODE_FAIL|DEADLINE|BOOT_FAIL/i.test(s)) return 'FAILED'
  return 'RUNNING'
}

// The Job-queue view: AppHub-managed instances PLUS every other SLURM job the user owns
// (so the queue shows all of a user's jobs, not just apphub launches, including ones
// submitted from a terminal). Owner-scoped; admins see all. Raw cluster jobs are flagged
// external; the owner or an admin can still cancel them (cancelJob resolves the owner from
// squeue and runs scancel).
export async function buildJobs(store, user, slurm) {
  const all = await store.all()
  const isAdmin = user && user.role === 'admin'
  const scoped = isAdmin ? all : all.filter((r) => r.owner === user?.username)
  const managed = scoped
    .filter((r) => r.jobId)
    .map((r) => ({
      id: r.jobId,
      name: r.name,
      owner: r.owner,
      state:
        r.state === 'running' || r.state === 'expiring'
          ? 'RUNNING'
          : r.state === 'queued' || r.state === 'starting'
            ? 'PENDING'
            : isTerminal(r.state) && r.state === 'failed'
              ? 'FAILED'
              : 'COMPLETING',
      partition: r.timeLimitMinutes === null ? 'persistent' : 'inter',
      node: r.node ?? null,
      elapsedMinutes: r.startedAt ? Math.floor((Date.now() - r.startedAt) / 60000) : 0,
      timeLimitMinutes: r.timeLimitMinutes ?? null,
      submittedAt: r.createdAt ?? null,
      external: false,
    }))

  const known = new Set(managed.map((j) => j.id))
  let external = []
  try {
    const q = (await slurm.queue()) || []
    const qScoped = isAdmin ? q : q.filter((j) => j.owner === user?.username)
    external = qScoped
      .filter((j) => j.jobId && !known.has(j.jobId))
      .map((j) => ({
        id: j.jobId,
        name: j.name || j.jobId,
        owner: j.owner || '?',
        state: mapSlurmState(j.slurmState),
        partition: j.partition || '—',
        node: j.node ?? null,
        elapsedMinutes: j.elapsedMinutes ?? 0,
        timeLimitMinutes: j.timeLimitMinutes ?? null,
        submittedAt: j.submittedAt ?? null,
        external: true,
      }))
  } catch {
    /* squeue best-effort */
  }
  return [...managed, ...external]
}
