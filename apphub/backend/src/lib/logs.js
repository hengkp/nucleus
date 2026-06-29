import { readFile } from 'node:fs/promises'
import { config } from '../config.js'

// In prod the runner writes a per-instance log under a local (non-CIFS) path; readiness
// and logs must never block on a CIFS stall (RISKS #22), so this is a plain local read
// with a synthesized fallback for mock / missing files.
export async function buildLogs(rec) {
  if (config.slurmMode === 'slurm') {
    const path = `/var/lib/apphub/logs/${rec.id}.log`
    try {
      return await readFile(path, 'utf8')
    } catch {
      return `[apphub] no log yet for ${rec.id} (state=${rec.state})`
    }
  }
  const node = rec.node ?? 'a node'
  return [
    `[apphub] submitting job for ${rec.name} (template ${rec.templateId})`,
    `[slurm] job ${rec.jobId ?? '?'} — requested ${rec.cpus} CPU / ${(rec.memoryMb / 1024).toFixed(0)} GB on ${node}`,
    `[apptainer] starting ${rec.templateId}.sif (--contain, loopback bind 127.0.0.1:${rec.port ?? '?'})`,
    rec.url ? `[runner] listening — route registered: ${rec.url}` : `[runner] waiting for service to come up…`,
    `[apphub] instance state: ${rec.state}`,
  ].join('\n')
}
