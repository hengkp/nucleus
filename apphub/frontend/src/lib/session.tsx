import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from './api'
import type { Session } from './types'

interface SessionCtx {
  session: Session | null
  loading: boolean
  refresh: () => void
}

const Ctx = createContext<SessionCtx | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = () => {
    setLoading(true)
    api
      .getSession()
      .then(setSession)
      .catch(() => setSession({ authenticated: false }))
      .finally(() => setLoading(false))
  }

  useEffect(refresh, [])

  return <Ctx.Provider value={{ session, loading, refresh }}>{children}</Ctx.Provider>
}

export function useSession(): SessionCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useSession must be used within SessionProvider')
  return c
}
