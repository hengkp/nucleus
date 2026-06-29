export function gb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB` : `${mb} MB`
}

export function pct(used: number, total: number): number {
  return total > 0 ? Math.round((used / total) * 100) : 0
}

export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

/** "3h 12m left" / "no time limit" / "—" */
export function remaining(elapsed: number, limit: number | null): string {
  if (limit === null) return 'no time limit'
  const left = Math.max(0, limit - elapsed)
  return `${duration(left)} left`
}

export function timeLimitLabel(limit: number | null): string {
  return limit === null ? 'No limit' : duration(limit)
}
