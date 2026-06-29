import type { Role } from '@/lib/types'

export interface NavItem {
  to: string
  label: string
  icon: string
  /** minimum role to see this item */
  minRole?: Role
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: 'dashboard-3-line' },
  { to: '/catalog', label: 'App catalog', icon: 'apps-2-line' },
  { to: '/pipelines', label: 'Pipelines', icon: 'flow-chart' },
  { to: '/queue', label: 'Job queue', icon: 'stack-line' },
  { to: '/workspace', label: 'Workspace', icon: 'folder-3-line' },
  { to: '/guide', label: 'User guide', icon: 'book-open-line' },
  { to: '/support', label: 'Support', icon: 'lifebuoy-line' },
  { to: '/admin', label: 'Admin', icon: 'shield-check-line', minRole: 'admin' },
  { to: '/settings', label: 'Settings', icon: 'settings-3-line' },
]

const RANK: Record<Role, number> = { researcher: 0, power: 1, admin: 2 }

export function visibleNav(role: Role | undefined): NavItem[] {
  const r = role ?? 'researcher'
  return NAV.filter((n) => !n.minRole || RANK[r] >= RANK[n.minRole])
}
