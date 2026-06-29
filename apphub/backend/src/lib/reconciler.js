import { config } from '../config.js'
import { isTerminal } from './store.js'
import { baseHost } from './routes-table.js'

// Single-writer reconcile loop (ADR-005). It is the ONLY thing that mutates instance
// lifecycle state and the route table, so there is no multi-writer race on routes.map.
// GET /api/apps reads cached store state and never reconciles (RISKS #8).
export function createReconciler({ store, slurm, routes, log = console }) {
  let busy = false
  let rerun = false
  let timer = null

  function urlFor(rec) {
    return `https://${baseHost(rec)}.${config.appDomain}/`
  }
  // External URL for apps the owner marked public (served on :8443, no login).
  function publicUrlFor(rec) {
    return rec.public ? `https://${baseHost(rec)}.${config.publicDomain}:${config.externalPort}/` : null
  }

  async function reconcileOne(rec) {
    if (!rec.jobId) return
    const s = await slurm.status(rec.jobId)

    // Time-limit enforcement (expiring -> cancel).
    if (rec.state === 'running' && rec.timeLimitMinutes != null && rec.startedAt) {
      const elapsed = (Date.now() - rec.startedAt) / 60000
      if (elapsed >= rec.timeLimitMinutes) {
        await slurm.cancel(rec.jobId)
        await store.update(rec.id, { state: 'stopped', url: null, message: 'Time limit reached' })
        return
      }
      if (elapsed >= rec.timeLimitMinutes - 5 && rec.state !== 'expiring') {
        await store.update(rec.id, { state: 'expiring' })
      }
    }

    switch (s.state) {
      case 'PENDING':
        if (rec.state !== 'queued') await store.update(rec.id, { state: 'queued', node: s.node ?? rec.node, message: 'Queued — waiting for an allocation…' })
        break
      case 'RUNNING':
        if (s.ready) {
          if (rec.state !== 'running' && rec.state !== 'expiring') {
            await store.update(rec.id, {
              state: 'running',
              node: s.node ?? rec.node,
              startedAt: rec.startedAt || Date.now(),
              // batch jobs have no web UI -> no route/URL
              url: rec.kind === 'batch' ? null : urlFor(rec),
              publicUrl: rec.kind === 'batch' ? null : publicUrlFor(rec),
              message: undefined,
            })
          }
        } else if (rec.state !== 'starting') {
          await store.update(rec.id, { state: 'starting', node: s.node ?? rec.node, message: `Starting on ${s.node ?? 'a node'}…` })
        }
        break
      case 'FAILED':
        await store.update(rec.id, { state: 'failed', url: null, message: 'The job failed to run' })
        break
      case 'GONE':
        // Job left the queue. If it had been running, it finished/was stopped. Batch jobs are
        // expected to end (often faster than a reconcile tick) — treat a GONE batch job as
        // finished and point to logs (exit status is unavailable while sacct/slurmdbd is down).
        if (rec.state === 'running' || rec.state === 'expiring') await store.update(rec.id, { state: 'stopped', url: null, message: 'Session ended' })
        else if (rec.kind === 'batch') await store.update(rec.id, { state: 'stopped', url: null, message: 'Job finished — check the job logs/output' })
        else await store.update(rec.id, { state: 'failed', url: null, message: 'The job ended before starting' })
        break
      default:
        break
    }
  }

  async function tick() {
    if (busy) { rerun = true; return }
    busy = true
    try {
      const all = await store.all()
      const active = all.filter((r) => !isTerminal(r.state))
      for (const rec of active) {
        try { await reconcileOne(rec) } catch (e) { log.error?.(`[reconcile] ${rec.id}: ${e.message}`) }
      }
      // Publish the desired route map from the freshest state (debounced inside).
      routes.publish(await store.all())

      // Reverse-reconcile (light): surface running SLURM jobs we don't track (ADR-005).
      try {
        const known = new Set(all.map((r) => r.jobId).filter(Boolean))
        const queued = await slurm.queue()
        for (const j of queued) {
          if (j.jobId && !known.has(j.jobId)) log.warn?.(`[reconcile] untracked job ${j.jobId} (${j.name || '?'} / ${j.owner || '?'})`)
        }
      } catch { /* queue best-effort */ }
    } finally {
      busy = false
      if (rerun) { rerun = false; queueMicrotask(tick) }
    }
  }

  return {
    start() {
      tick()
      timer = setInterval(tick, config.reconcileMs)
      if (timer.unref) timer.unref()
    },
    stop() { if (timer) clearInterval(timer) },
    runNow: tick,
  }
}
