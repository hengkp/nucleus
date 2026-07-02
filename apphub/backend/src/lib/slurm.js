import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { config, NODE_IP, ALLOWED_IPS } from '../config.js'

const pexec = promisify(execFile)

// Job state vocabulary the reconciler consumes (decoupled from SLURM's strings):
//   PENDING | STARTING | RUNNING | GONE | FAILED   (+ ready flag for RUNNING)

export function createSlurm(mode) {
  return mode === 'slurm' ? realSlurm() : mockSlurm()
}

// Parse SLURM duration ("d-hh:mm:ss" / "hh:mm:ss" / "mm:ss") to minutes; null = unlimited.
function slurmDurToMin(s) {
  if (!s || /UNLIMITED|INVALID|NOT_SET|N\/A/i.test(s)) return null
  let days = 0
  let rest = s.trim()
  if (rest.includes('-')) { const [d, r] = rest.split('-'); days = Number(d) || 0; rest = r }
  const p = rest.split(':').map((x) => Number(x) || 0)
  let h = 0, m = 0, sec = 0
  if (p.length === 3) [h, m, sec] = p
  else if (p.length === 2) [m, sec] = p
  else if (p.length === 1) [m] = p
  return days * 1440 + h * 60 + m + Math.round(sec / 60)
}

// ---------------------------------------------------------------- mock
function mockSlurm() {
  const jobs = new Map()
  let seq = 4800
  const computeNodes = config.nodes.filter((n) => !n.controlPlane)

  function leastLoaded(cpus) {
    const load = new Map(computeNodes.map((n) => [n.name, 0]))
    for (const j of jobs.values()) {
      if (!j.cancelled) load.set(j.node, (load.get(j.node) || 0) + j.cpus)
    }
    let best = computeNodes[0].name
    for (const n of computeNodes) if ((load.get(n.name) || 0) < (load.get(best) || 0)) best = n.name
    return best
  }

  return {
    mode: 'mock',
    async launch(spec) {
      const jobId = String(++seq)
      const node = leastLoaded(spec.cpus)
      jobs.set(jobId, { jobId, cpus: spec.cpus, mem: spec.memoryMb, node, startedAt: Date.now(), cancelled: false, name: spec.name, owner: spec.owner, persistent: spec.timeMinutes === null })
      return { jobId, node }
    },
    async status(jobId) {
      const j = jobs.get(jobId)
      if (!j) return { state: 'GONE' }
      if (j.cancelled) return { state: 'GONE', node: j.node }
      const elapsed = Date.now() - j.startedAt
      if (elapsed < 2000) return { state: 'PENDING', node: j.node }
      if (elapsed < 5000) return { state: 'RUNNING', ready: false, node: j.node }
      return { state: 'RUNNING', ready: true, node: j.node }
    },
    async cancel(jobId) {
      const j = jobs.get(jobId)
      if (j) j.cancelled = true
    },
    async forceCancel(jobId) {
      const j = jobs.get(String(jobId))
      if (j) j.cancelled = true
    },
    async setTimeLimit(jobId, minutes) {
      const j = jobs.get(String(jobId))
      if (j) j.timeLimitMinutes = minutes
    },
    async queue() {
      const out = []
      for (const j of jobs.values()) {
        if (j.cancelled) continue
        const s = await this.status(j.jobId)
        out.push({
          jobId: j.jobId, name: j.name, owner: j.owner, node: j.node, slurmState: s.state,
          partition: j.persistent ? 'persistent' : 'inter',
          elapsedMinutes: Math.floor((Date.now() - j.startedAt) / 60000),
          timeLimitMinutes: j.timeLimitMinutes ?? null,
        })
      }
      return out
    },
    async nodeLoads() {
      const load = new Map(config.nodes.map((n) => [n.name, { cpu: 0, mem: 0 }]))
      for (const j of jobs.values()) {
        if (j.cancelled) continue
        const l = load.get(j.node)
        if (l) { l.cpu += j.cpus; l.mem += j.mem }
      }
      return load
    },
  }
}

// ---------------------------------------------------------------- real
function realSlurm() {
  async function run(cmd, args) {
    const { stdout } = await pexec(cmd, args, { timeout: 15000, maxBuffer: 4_000_000 })
    return stdout
  }

  return {
    mode: 'slurm',
    // Submit AS the user through the fail-closed sudo wrapper (ADR-002/005). The wrapper
    // refuses uid<10000, gid!=100000, reserved users, and asserts getent agreement.
    async launch(spec) {
      if (!config.sbatchWrapper) throw new Error('APPHUB_SBATCH_WRAPPER not configured')
      const args = [
        config.sbatchWrapper,
        '--user', spec.owner,
        '--template', spec.templateId,
        '--cpus', String(spec.cpus),
        '--mem', String(spec.memoryMb),
        '--time', spec.timeMinutes === null ? 'UNLIMITED' : String(spec.timeMinutes),
        '--name', spec.name,
      ]
      if (spec.port) args.push('--port', String(spec.port))
      if (spec.entrypoint) args.push('--entrypoint', spec.entrypoint)
      if (spec.command) args.push('--command', spec.command)
      if (spec.folder) args.push('--folder', spec.folder)
      const stdout = await run('sudo', args)
      const m = stdout.match(/(\d{3,})/)
      if (!m) throw new Error('Could not parse job id from wrapper output')
      return { jobId: m[1], node: null }
    },
    async status(jobId) {
      // squeue %T (state) %N (node). Empty output => job left the queue.
      const stdout = await run('squeue', ['-h', '-j', jobId, '-o', '%T|%N']).catch(() => '')
      const line = stdout.trim().split('\n')[0]
      if (!line) return { state: 'GONE' }
      const [st, nodeName] = line.split('|')
      const node = nodeName && NODE_IP.has(nodeName) ? nodeName : null
      if (/PENDING|CONFIGURING/.test(st)) return { state: 'PENDING', node }
      if (/RUNNING|COMPLETING/.test(st)) return { state: 'RUNNING', ready: true, node }
      if (/FAIL|CANCEL|TIMEOUT|NODE_FAIL|BOOT_FAIL|DEADLINE|OUT_OF_MEMORY/.test(st)) return { state: 'FAILED', node }
      return { state: 'PENDING', node }
    },
    async cancel(jobId) {
      await run('sudo', ['scancel', String(jobId)]).catch(() => run('scancel', [String(jobId)]).catch(() => {}))
    },
    // explicit privileged cancel (root) for owner/admin-initiated cancels of any job
    async forceCancel(jobId) {
      await run('sudo', ['scancel', String(jobId)]).catch(() => {})
    },
    // Raise (or lower) a running job's wall-clock limit. root scontrol is privileged; all
    // partitions are MaxTime=UNLIMITED so any cap up to our app limit is accepted.
    async setTimeLimit(jobId, minutes) {
      const min = Math.max(1, Math.round(minutes))
      await run('sudo', ['scontrol', 'update', `JobId=${String(jobId)}`, `TimeLimit=${min}`])
    },
    async queue() {
      // %V = submission time (ISO-like, cluster-local). Parsed to epoch ms for the queue UI.
      const stdout = await run('squeue', ['-h', '-a', '-o', '%i|%j|%u|%N|%T|%P|%M|%l|%V']).catch(() => '')
      return stdout.trim().split('\n').filter(Boolean).map((l) => {
        const [jobId, name, owner, nodeName, slurmState, partition, elapsed, timelimit, submit] = l.split('|')
        const submittedAt = submit ? Date.parse(submit) : NaN
        return {
          jobId, name, owner,
          node: NODE_IP.has(nodeName) ? nodeName : nodeName || null,
          slurmState, partition,
          elapsedMinutes: slurmDurToMin(elapsed) ?? 0,
          timeLimitMinutes: slurmDurToMin(timelimit),
          submittedAt: Number.isFinite(submittedAt) ? submittedAt : null,
        }
      })
    },
    async nodeLoads() {
      // Per-node allocated CPU/MEM from sinfo. Falls back to empty on error.
      const load = new Map(config.nodes.map((n) => [n.name, { cpu: 0, mem: 0 }]))
      try {
        const stdout = await run('sinfo', ['-h', '-N', '-o', '%n|%C|%e|%m'])
        for (const l of stdout.trim().split('\n')) {
          const [name, cpuCol] = l.split('|')
          if (!load.has(name)) continue
          // %C = allocated/idle/other/total
          const alloc = Number((cpuCol || '').split('/')[0]) || 0
          load.get(name).cpu = alloc
        }
      } catch { /* leave zeros */ }
      return load
    },
  }
}

// Map a squeue node name to an allowlisted upstream IP (ADR-003: never trust elsewhere).
export function nodeUpstream(nodeName, port) {
  const ip = NODE_IP.get(nodeName)
  if (!ip || !ALLOWED_IPS.has(ip) || !port) return null
  return `${ip}:${port}`
}
