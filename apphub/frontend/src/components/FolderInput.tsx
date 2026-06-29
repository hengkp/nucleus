import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { api } from '@/lib/api'

// A locker-relative folder input with live suggestions. Typing or clicking the folder button opens
// a popover that lists the subfolders at the path entered so far (from the user's own locker, via
// the files API); picking one drills in. The value stays a plain relative path the launch APIs use.
export function FolderInput({
  value,
  onChange,
  id,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  id?: string
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [dirs, setDirs] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  // The folder we list = everything before the last "/"; the bit after it filters the suggestions.
  const lastSlash = value.lastIndexOf('/')
  const parent = lastSlash >= 0 ? value.slice(0, lastSlash) : ''
  const prefix = (lastSlash >= 0 ? value.slice(lastSlash + 1) : value).toLowerCase()

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    api
      .listFiles(parent)
      .then((l) => { if (!cancelled) setDirs(l.entries.filter((e) => e.type === 'dir').map((e) => e.name)) })
      .catch(() => { if (!cancelled) setDirs([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, parent])

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const matches = dirs.filter((d) => d.toLowerCase().startsWith(prefix))
  const pick = (name: string) => onChange((parent ? parent + '/' : '') + name + '/') // trailing slash → drill in

  return (
    <div ref={boxRef} className="relative">
      <div className="flex items-center rounded-md border border-border bg-surface focus-within:border-brand">
        <input
          id={id}
          value={value}
          placeholder={placeholder}
          onChange={(e) => { onChange(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          className="tabular w-full bg-transparent px-3 py-2 text-sm text-ink outline-none"
        />
        <button type="button" aria-label="Browse folders" onClick={() => setOpen((o) => !o)} className="px-2.5 text-ink-muted hover:text-brand">
          <Icon name="folder-open-line" />
        </button>
      </div>
      {open && (
        <div className="absolute z-30 mt-1 max-h-56 w-full overflow-auto rounded-md border border-border bg-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-2xs text-ink-muted">
            <span className="truncate">in /{parent || '(locker root)'}</span>
            {loading && <Icon name="loader-4-line" className="animate-spin" />}
          </div>
          {matches.length === 0 ? (
            <div className="px-3 py-2 text-2xs text-ink-muted">{loading ? 'Loading...' : 'No matching subfolders'}</div>
          ) : (
            matches.map((d) => (
              <button key={d} type="button" onClick={() => pick(d)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-2">
                <Icon name="folder-line" className="text-ink-muted" />
                {d}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
