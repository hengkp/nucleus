import { useEffect, useState } from 'react'
import { Modal } from './Modal'
import { Button } from './Button'
import { Icon } from './Icon'
import { cn } from '@/lib/cn'
import { api } from '@/lib/api'
import type { FileEntry, Share } from '@/lib/types'

// Browse the shared NAS areas (and lab lockers) and pick an absolute path — so a pipeline input can
// point straight at shared data (e.g. /mnt/rarecyte-folder/...) with no copying. Listing runs AS the
// user server-side, so you only see what your account may actually read.
export function FileBrowser({
  open,
  onClose,
  onPick,
  mode,
}: {
  open: boolean
  onClose: () => void
  onPick: (absPath: string) => void
  mode: 'file' | 'dir'
}) {
  const [shares, setShares] = useState<Share[]>([])
  const [share, setShare] = useState<Share | null>(null)
  const [sub, setSub] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string>()

  useEffect(() => {
    if (!open) return
    setShare(null); setSub(''); setEntries([]); setErr(undefined)
    api.listShares().then(setShares).catch(() => setShares([]))
  }, [open])

  useEffect(() => {
    if (!open || !share) return
    let cancelled = false
    setLoading(true); setErr(undefined)
    api
      .listFiles(sub, share.path)
      .then((l) => { if (!cancelled) setEntries(l.entries) })
      .catch((e) => { if (!cancelled) { setEntries([]); setErr(e instanceof Error ? e.message : 'Cannot read this folder') } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, share, sub])

  const currentAbs = share ? share.path + (sub ? `/${sub}` : '') : ''
  const segs = sub ? sub.split('/') : []
  const up = () => { if (sub) setSub(segs.slice(0, -1).join('/')); else setShare(null) }

  const visible = entries.filter((e) => mode === 'file' || e.type === 'dir')

  return (
    <Modal open={open} onClose={onClose} title={mode === 'file' ? 'Choose a file' : 'Choose a folder'} size="md">
      <div className="p-5">
        {/* Breadcrumb */}
        <div className="mb-3 flex flex-wrap items-center gap-1 text-xs">
          <button onClick={() => { setShare(null); setSub('') }} className="font-medium text-brand hover:text-brand-strong">Shared areas</button>
          {share && (
            <>
              <Icon name="arrow-right-s-line" className="text-ink-muted" />
              <button onClick={() => setSub('')} className="font-medium text-brand hover:text-brand-strong">{share.label}</button>
              {segs.map((s, i) => (
                <span key={i} className="flex items-center gap-1">
                  <Icon name="arrow-right-s-line" className="text-ink-muted" />
                  <button onClick={() => setSub(segs.slice(0, i + 1).join('/'))} className="text-ink hover:text-brand">{s}</button>
                </span>
              ))}
            </>
          )}
        </div>

        {!share ? (
          <div className="max-h-72 overflow-auto rounded-md border border-border">
            {shares.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-ink-muted">No shared areas available.</div>
            ) : (
              shares.map((s) => (
                <button key={s.id} onClick={() => { setShare(s); setSub('') }} className="flex w-full items-center gap-2 border-b border-border px-3 py-2.5 text-left text-sm text-ink last:border-0 hover:bg-surface-2">
                  <Icon name="hard-drive-2-line" className="text-brand" />
                  <span className="flex-1 truncate">{s.label}</span>
                  <span className="font-mono text-2xs text-ink-muted">{s.path}</span>
                </button>
              ))
            )}
          </div>
        ) : (
          <>
            <div className="max-h-72 overflow-auto rounded-md border border-border">
              <button onClick={up} className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-xs text-ink-muted hover:bg-surface-2">
                <Icon name="corner-left-up-line" /> Up one level
              </button>
              {loading ? (
                <div className="px-3 py-4 text-center text-xs text-ink-muted"><Icon name="loader-4-line" className="animate-spin" /> Loading...</div>
              ) : err ? (
                <div className="px-3 py-4 text-center text-xs text-err">{err}</div>
              ) : visible.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-ink-muted">Empty folder.</div>
              ) : (
                visible.map((e) => (
                  <button
                    key={e.name}
                    onClick={() => (e.type === 'dir' ? setSub(sub ? `${sub}/${e.name}` : e.name) : onPick(`${currentAbs}/${e.name}`))}
                    className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-sm last:border-0 hover:bg-surface-2"
                  >
                    <Icon name={e.type === 'dir' ? 'folder-line' : 'file-line'} className={cn(e.type === 'dir' ? 'text-brand' : 'text-ink-muted')} />
                    <span className="flex-1 truncate text-ink">{e.name}</span>
                    {e.type === 'dir' && <Icon name="arrow-right-s-line" className="text-ink-muted" />}
                  </button>
                ))
              )}
            </div>
            <p className="mt-2 truncate font-mono text-2xs text-ink-muted">{currentAbs || '/mnt'}</p>
          </>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3.5">
        <p className="text-2xs text-ink-muted">{mode === 'file' ? 'Click a file to use it.' : 'Open the folder you want, then use it.'}</p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {mode === 'dir' && <Button variant="primary" icon="check-line" disabled={!share} onClick={() => onPick(currentAbs)}>Use this folder</Button>}
        </div>
      </div>
    </Modal>
  )
}
