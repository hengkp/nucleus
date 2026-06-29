import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '@/components/Icon'
import { ThemeToggle } from '@/components/ThemeToggle'
import { Badge } from '@/components/Badge'
import { useSession } from '@/lib/session'
import { api, IS_MOCK } from '@/lib/api'

function openCmdk() {
  window.dispatchEvent(new Event('apphub:open-cmdk'))
}

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const { session } = useSession()
  const user = session?.user
  const [menu, setMenu] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenu(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface/80 px-4 backdrop-blur">
      <button onClick={onMenu} aria-label="Open menu" className="flex h-9 w-9 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 lg:hidden">
        <Icon name="menu-line" className="text-xl" />
      </button>

      <button
        onClick={openCmdk}
        className="hidden h-9 w-72 items-center gap-2 rounded-md border border-border bg-surface-2/60 px-3 text-left text-sm text-ink-muted hover:border-brand/40 sm:flex"
      >
        <Icon name="search-line" />
        <span className="flex-1">Search or jump to...</span>
        <kbd className="rounded border border-border px-1.5 py-0.5 text-2xs">Ctrl K</kbd>
      </button>

      <div className="flex-1" />

      {IS_MOCK && <Badge tone="warn">Demo data</Badge>}
      <ThemeToggle />

      <div className="relative" ref={ref}>
        <button onClick={() => setMenu((m) => !m)} className="flex items-center gap-2 rounded-md p-1 pr-2 hover:bg-surface-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-xs font-semibold text-white">
            {(user?.displayName ?? '?').slice(0, 1).toUpperCase()}
          </span>
          <span className="hidden text-sm font-medium text-ink sm:block">{user?.displayName ?? '...'}</span>
          <Icon name="arrow-down-s-line" className="text-ink-muted" />
        </button>
        {menu && (
          <div className="animate-scale-in absolute right-0 top-11 w-56 rounded-md border border-border bg-surface p-1.5 shadow-2">
            <div className="px-2.5 py-2">
              <p className="text-sm font-medium text-ink">{user?.displayName}</p>
              <p className="tabular text-2xs text-ink-muted">
                {user?.username} | uid {user?.uid}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {user?.groups.map((g) => (
                  <Badge key={g} tone="neutral">
                    {g}
                  </Badge>
                ))}
              </div>
            </div>
            <div className="my-1 border-t border-border" />
            <button onClick={() => { setMenu(false); navigate('/settings') }} className="flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left text-sm text-ink hover:bg-surface-2">
              <Icon name="settings-3-line" /> Settings
            </button>
            <button
              onClick={async () => { await api.logout(); window.location.assign('/') }}
              className="flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left text-sm text-ink hover:bg-surface-2"
            >
              <Icon name="logout-box-r-line" /> Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
