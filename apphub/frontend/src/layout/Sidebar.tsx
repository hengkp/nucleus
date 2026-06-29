import { NavLink } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { Icon } from '@/components/Icon'
import { useSession } from '@/lib/session'
import { visibleNav } from './nav'

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { session } = useSession()
  const items = visibleNav(session?.user?.role)

  return (
    <aside className="flex h-full w-60 flex-col border-r border-border bg-surface">
      <div className="flex h-14 items-center gap-2.5 px-4">
        <img src="/brand/logo.png" alt="" className="h-7 w-7" />
        <div className="leading-tight">
          <p className="text-sm font-semibold text-ink">AppHub</p>
          <p className="text-2xs text-ink-muted">SISP cluster</p>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 px-2.5 py-2">
        {items.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive ? 'bg-brand-tint text-brand' : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
              )
            }
          >
            {({ isActive }) => (
              <>
                <Icon name={isActive ? n.icon.replace('-line', '-fill') : n.icon} className="text-lg" />
                {n.label}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-border p-3">
        <a
          href="https://mapdrive.sisp.com"
          className="flex items-center gap-2.5 rounded-md px-3 py-2 text-xs text-ink-muted hover:bg-surface-2 hover:text-ink"
        >
          <Icon name="hard-drive-2-line" className="text-base" />
          Map a network drive
          <Icon name="external-link-line" className="ml-auto text-sm" />
        </a>
      </div>
    </aside>
  )
}
