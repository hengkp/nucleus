import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTheme } from '@/lib/theme'
import { Icon } from './Icon'
import { cn } from '@/lib/cn'

interface Command {
  id: string
  label: string
  icon: string
  hint?: string
  run: () => void
}

// ⌘K / Ctrl-K palette — keyboard-first navigation for power users (Linear pattern).
export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const navigate = useNavigate()
  const { toggle } = useTheme()
  const inputRef = useRef<HTMLInputElement>(null)

  const commands = useMemo<Command[]>(
    () => [
      { id: 'dash', label: 'Go to Dashboard', icon: 'dashboard-3-line', run: () => navigate('/') },
      { id: 'catalog', label: 'Launch an app...', icon: 'apps-2-line', hint: 'Catalog', run: () => navigate('/catalog') },
      { id: 'pipelines', label: 'Run a pipeline...', icon: 'flow-chart', hint: 'Nextflow', run: () => navigate('/pipelines') },
      { id: 'queue', label: 'Go to Job queue', icon: 'stack-line', run: () => navigate('/queue') },
      { id: 'files', label: 'Go to Workspace', icon: 'folder-3-line', run: () => navigate('/workspace') },
      { id: 'guide', label: 'Open the User guide', icon: 'book-open-line', run: () => navigate('/guide') },
      { id: 'support', label: 'Get support', icon: 'lifebuoy-line', run: () => navigate('/support') },
      { id: 'settings', label: 'Open Settings', icon: 'settings-3-line', run: () => navigate('/settings') },
      { id: 'theme', label: 'Toggle light / dark theme', icon: 'contrast-2-line', run: toggle },
    ],
    [navigate, toggle],
  )

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? commands.filter((c) => c.label.toLowerCase().includes(s)) : commands
  }, [q, commands])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    const onOpen = () => setOpen(true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('apphub:open-cmdk', onOpen)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('apphub:open-cmdk', onOpen)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setQ('')
      setActive(0)
      setTimeout(() => inputRef.current?.focus(), 10)
    }
  }, [open])

  useEffect(() => setActive(0), [q])

  // keep the highlighted option in view during arrow-key navigation
  useEffect(() => {
    const el = document.getElementById(`cmdk-opt-${filtered[active]?.id}`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, filtered])

  if (!open) return null

  const choose = (c: Command) => {
    c.run()
    setOpen(false)
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]">
      <div className="animate-fade-in fixed inset-0 bg-ink/40 backdrop-blur-sm" onClick={() => setOpen(false)} aria-hidden />
      <div
        role="dialog"
        aria-label="Command palette"
        className="animate-scale-in relative z-10 w-full max-w-lg overflow-hidden rounded-lg border border-border bg-surface shadow-2"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Icon name="command-line" className="text-ink-muted" />
          <input
            ref={inputRef}
            value={q}
            role="combobox"
            aria-expanded
            aria-controls="cmdk-list"
            aria-label="Search commands"
            aria-activedescendant={filtered[active] ? `cmdk-opt-${filtered[active].id}` : undefined}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
              else if (e.key === 'Enter' && filtered[active]) { e.preventDefault(); choose(filtered[active]) }
              else if (e.key === 'Escape') setOpen(false)
            }}
            placeholder="Type a command or search..."
            className="h-12 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-muted/70"
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 text-2xs text-ink-muted">esc</kbd>
        </div>
        <ul id="cmdk-list" role="listbox" aria-label="Commands" className="max-h-72 overflow-y-auto p-1.5">
          {filtered.length === 0 && <li className="px-3 py-6 text-center text-sm text-ink-muted">No matching commands</li>}
          {filtered.map((c, i) => (
            <li key={c.id} id={`cmdk-opt-${c.id}`} role="option" aria-selected={i === active}>
              <button
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(c)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-sm px-3 py-2 text-left text-sm',
                  i === active ? 'bg-brand-tint text-brand' : 'text-ink hover:bg-surface-2',
                )}
              >
                <Icon name={c.icon} className="text-base" />
                <span className="flex-1">{c.label}</span>
                {c.hint && <span className="text-2xs text-ink-muted">{c.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
