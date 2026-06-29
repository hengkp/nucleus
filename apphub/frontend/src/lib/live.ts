import { useCallback, useEffect, useRef, useState } from 'react'

// The single seam for "live" data. Today it polls; swapping to SSE/WebSocket later
// is a one-file change (ADR-006). Cadence is intentionally calm unless the backend
// has proven its read path is cheap — otherwise N users polling fast would recreate
// the original concurrency hang (Problem B).
const READ_IS_CHEAP = import.meta.env.VITE_APPS_READ_IS_CHEAP === '1'

export const CADENCE = {
  // active tab / inactive tab, in ms
  fast: READ_IS_CHEAP ? 5_000 : 30_000,
  slow: READ_IS_CHEAP ? 20_000 : 60_000,
}

export interface LiveResult<T> {
  data: T | undefined
  error: Error | undefined
  loading: boolean
  /** true when the data is older than 2× the polling interval (show a StaleBadge). */
  stale: boolean
  refresh: () => void
}

export function useLive<T>(
  fetcher: () => Promise<T>,
  opts: { intervalMs?: number; enabled?: boolean } = {},
): LiveResult<T> {
  const { intervalMs = CADENCE.fast, enabled = true } = opts
  const [data, setData] = useState<T>()
  const [error, setError] = useState<Error>()
  const [loading, setLoading] = useState(true)
  const [stale, setStale] = useState(false)
  const lastOk = useRef<number>(0)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const run = useCallback(async () => {
    try {
      const next = await fetcherRef.current()
      setData(next)
      setError(undefined)
      lastOk.current = Date.now()
      setStale(false)
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: number | undefined

    const schedule = () => {
      const hidden = typeof document !== 'undefined' && document.hidden
      // Hidden tabs back off, but never poll FASTER than the caller's interval
      // (a deliberately slow 10-min poller must not speed up when backgrounded).
      const wait = hidden ? Math.max(CADENCE.slow, intervalMs) : intervalMs
      timer = window.setTimeout(async () => {
        if (cancelled) return
        await run()
        if (lastOk.current && Date.now() - lastOk.current > intervalMs * 2) setStale(true)
        schedule()
      }, wait)
    }

    run().then(schedule)
    const onVis = () => {
      if (!document.hidden) run()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [enabled, intervalMs, run])

  return { data, error, loading, stale, refresh: run }
}
