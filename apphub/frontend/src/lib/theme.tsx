import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

export type ThemePref = 'light' | 'dark' | 'system'
const KEY = 'apphub.theme'

interface ThemeCtx {
  pref: ThemePref
  resolved: 'light' | 'dark'
  setPref: (p: ThemePref) => void
  toggle: () => void
}

const Ctx = createContext<ThemeCtx | null>(null)

function resolve(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return pref
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(
    () => (localStorage.getItem(KEY) as ThemePref) || 'system',
  )
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolve(pref))

  const apply = useCallback((p: ThemePref) => {
    const r = resolve(p)
    setResolved(r)
    document.documentElement.classList.toggle('dark', r === 'dark')
  }, [])

  const setPref = useCallback(
    (p: ThemePref) => {
      setPrefState(p)
      localStorage.setItem(KEY, p)
      apply(p)
    },
    [apply],
  )

  useEffect(() => {
    apply(pref)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => pref === 'system' && apply('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [pref, apply])

  const toggle = useCallback(
    () => setPref(resolved === 'dark' ? 'light' : 'dark'),
    [resolved, setPref],
  )

  return <Ctx.Provider value={{ pref, resolved, setPref, toggle }}>{children}</Ctx.Provider>
}

export function useTheme(): ThemeCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useTheme must be used within ThemeProvider')
  return c
}
