import { readFileSync } from 'node:fs'

// Browsable SHARED NAS areas (top-level /mnt mounts) users can point a pipeline input at without
// copying data into their locker. Computed from /proc/mounts so new data shares appear
// automatically; clearly-administrative shares are excluded. Actual read access is still enforced
// per-user by the OS (the file helper browses AS the user), so this list is only for discovery.
const DENY = new Set(['galaxy-app', 'admin_dept', 'admin_sp', 'hr', 'it_others', 'purchasing', 'filing'])
const LABELS = {
  sisplockers: 'Lab lockers & projects',
  'rarecyte-folder': 'Rarecyte',
  CRCproject: 'CRC project',
  MutationProfile: 'Mutation Profile',
  allflash: 'All-flash (HPC scratch)',
}

export function listShares() {
  let mounts = ''
  try { mounts = readFileSync('/proc/mounts', 'utf8') } catch { return [] }
  const seen = new Set()
  const out = []
  for (const line of mounts.split('\n')) {
    const mp = line.split(' ')[1]
    if (!mp || !mp.startsWith('/mnt/')) continue
    const name = mp.slice('/mnt/'.length)
    if (!name || name.includes('/')) continue // top-level shares only
    if (DENY.has(name) || seen.has(name)) continue
    seen.add(name)
    out.push({ id: name, label: LABELS[name] || name, path: mp })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label))
}
