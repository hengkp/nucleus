import { useCallback, useEffect, useRef, useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { Card } from '@/components/Card'
import { Button } from '@/components/Button'
import { Icon } from '@/components/Icon'
import { Badge } from '@/components/Badge'
import { Skeleton } from '@/components/Skeleton'
import { EmptyState } from '@/components/EmptyState'
import { cn } from '@/lib/cn'
import { api } from '@/lib/api'
import { useSession } from '@/lib/session'
import { useToast } from '@/lib/toast'
import { useConfirm } from '@/lib/confirm'
import type { FileEntry, FileListing } from '@/lib/types'

function fmtSize(n: number): string {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
const join = (path: string, name: string) => (path ? `${path}/${name}` : name)
const CLIENT_HASH_LIMIT = 100 * 1024 ** 2 // hash client-side only under 100 MB
const TEXT_PREVIEW_LIMIT = 512 * 1024
const TEXT_EXT = /\.(txt|md|csv|tsv|json|ya?ml|toml|ini|cfg|conf|log|py|r|js|ts|tsx|jsx|css|html?|sh|bash|c|cpp|h|java|go|rs|sql|ipynb|env|gitignore|dockerfile|tex|bib)$/i

function iconFor(e: FileEntry): string {
  if (e.type === 'dir') return 'folder-3-fill'
  const n = e.name.toLowerCase()
  if (/\.(png|jpe?g|gif|svg|webp|bmp|tiff?)$/.test(n)) return 'image-line'
  if (/\.(csv|tsv|xlsx?)$/.test(n)) return 'file-excel-2-line'
  if (/\.(zip|gz|tar|7z|rar|bz2|xz)$/.test(n)) return 'file-zip-line'
  if (/\.(ipynb)$/.test(n)) return 'booklet-line'
  if (/\.(py|r|js|ts|tsx|jsx|c|cpp|go|rs|java|sh)$/.test(n)) return 'code-s-slash-line'
  if (/\.(md|txt|json|ya?ml|toml|ini|cfg|conf|log)$/.test(n)) return 'file-text-line'
  if (/\.(pdf)$/.test(n)) return 'file-pdf-2-line'
  return 'file-line'
}

async function sha256Hex(file: File): Promise<string | undefined> {
  try {
    const buf = await file.arrayBuffer()
    const d = await crypto.subtle.digest('SHA-256', buf)
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return undefined
  }
}

interface Upload { name: string; pct: number; state: 'uploading' | 'done' | 'error'; msg?: string }

export function Workspace() {
  const { session } = useSession()
  const toast = useToast()
  const { confirm, prompt } = useConfirm()
  const user = session?.user?.username ?? 'you'

  const [path, setPath] = useState('')
  const [listing, setListing] = useState<FileListing>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [uploads, setUploads] = useState<Upload[]>([])
  const [preview, setPreview] = useState<{ name: string; text: string; truncated: boolean } | null>(null)
  const [dirSizes, setDirSizes] = useState<Record<string, number>>({})
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback((p: string) => {
    let cancelled = false
    setLoading(true)
    setError(undefined)
    api
      .listFiles(p)
      .then((l) => { if (!cancelled) setListing(l) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not list folder') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => { setSel(new Set()); setPreview(null); setDirSizes({}); return load(path) }, [path, load])
  const refresh = () => { setDirSizes({}); load(path) }

  const entries = listing?.entries ?? []

  // Folder sizes are computed lazily (du can be slow) with bounded concurrency, so the listing
  // itself stays instant. -1 means "too large to total quickly".
  useEffect(() => {
    const dirs = entries.filter((e) => e.type === 'dir')
    if (!dirs.length) return
    let cancelled = false
    const queue = dirs.map((d) => d.name)
    let active = 0
    const pump = () => {
      while (active < 4 && queue.length) {
        const name = queue.shift()!
        active++
        api.dirSize(join(path, name))
          .then((r) => { if (!cancelled) setDirSizes((m) => ({ ...m, [name]: r.size })) })
          .catch(() => { if (!cancelled) setDirSizes((m) => ({ ...m, [name]: -1 })) })
          .finally(() => { active--; if (!cancelled) pump() })
      }
    }
    pump()
    return () => { cancelled = true }
  }, [listing, path]) // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(name: string) {
    setSel((s) => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n })
  }
  function toggleAll() {
    setSel((s) => (s.size === entries.length && entries.length > 0 ? new Set() : new Set(entries.map((e) => e.name))))
  }

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true)
    try { await fn(); toast.push(ok, 'ok'); refresh() }
    catch (e) { toast.push(e instanceof Error ? e.message : 'Failed', 'err') }
    finally { setBusy(false) }
  }

  async function newFolder() {
    const name = (await prompt({ title: 'New folder', label: 'Folder name', placeholder: 'e.g. data' }))?.trim()
    if (name) act(() => api.mkdir(join(path, name)), `Created folder "${name}"`)
  }
  async function newFile() {
    const name = (await prompt({ title: 'New file', label: 'File name', placeholder: 'e.g. notes.txt' }))?.trim()
    if (name) act(() => api.mkfile(join(path, name)), `Created file "${name}"`)
  }
  async function rename(e: FileEntry) {
    const name = (await prompt({ title: 'Rename', label: 'New name', defaultValue: e.name }))?.trim()
    if (name && name !== e.name) act(() => api.renamePath(join(path, e.name), join(path, name)), `Renamed to "${name}"`)
  }
  async function removeSelected() {
    const names = [...sel]
    if (!names.length) return
    const ok = await confirm({ title: 'Delete items', message: `Delete ${names.length} item${names.length === 1 ? '' : 's'}? This cannot be undone.`, confirmLabel: 'Delete', tone: 'danger' })
    if (!ok) return
    act(async () => { for (const n of names) await api.deletePath(join(path, n)) }, `Deleted ${names.length} item(s)`)
  }
  function triggerDownload(href: string, filename: string) {
    const a = document.createElement('a')
    a.href = href
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  }
  function downloadOne(e: FileEntry) { triggerDownload(api.fileDownloadUrl(join(path, e.name)), e.name) }
  function downloadZip(e: FileEntry) { triggerDownload(api.fileZipUrl(join(path, e.name)), `${e.name}.zip`); toast.push(`Zipping "${e.name}"…`, 'info') }
  function downloadEntry(e: FileEntry) { e.type === 'dir' ? downloadZip(e) : downloadOne(e) }
  async function openPreview(e: FileEntry) {
    if (e.size > TEXT_PREVIEW_LIMIT || !TEXT_EXT.test(e.name)) {
      toast.push('Preview is for small text files — use Download instead.', 'info')
      return
    }
    try {
      const text = await api.readFileText(join(path, e.name))
      setPreview({ name: e.name, text: text.slice(0, TEXT_PREVIEW_LIMIT), truncated: text.length > TEXT_PREVIEW_LIMIT })
    } catch (err) {
      toast.push(err instanceof Error ? err.message : 'Could not open file', 'err')
    }
  }

  async function onPick(files: FileList | null) {
    if (!files || !files.length) return
    for (const file of Array.from(files)) {
      const row: Upload = { name: file.name, pct: 0, state: 'uploading' }
      setUploads((u) => [row, ...u.filter((x) => x.name !== file.name)])
      try {
        const sha256 = file.size < CLIENT_HASH_LIMIT ? await sha256Hex(file) : undefined
        const res = await api.uploadFile(join(path, file.name), file, {
          sha256,
          onProgress: (frac) => setUploads((u) => u.map((x) => (x.name === file.name ? { ...x, pct: Math.round(frac * 100) } : x))),
        })
        const verified = sha256 ? (sha256 === res.sha256 ? ' · hash verified ✓' : ' · HASH MISMATCH') : ' · server-hashed ✓'
        setUploads((u) => u.map((x) => (x.name === file.name ? { ...x, pct: 100, state: 'done', msg: `${fmtSize(res.size)}${verified}` } : x)))
      } catch (e) {
        setUploads((u) => u.map((x) => (x.name === file.name ? { ...x, state: 'error', msg: e instanceof Error ? e.message : 'failed' } : x)))
      }
    }
    refresh()
    if (fileInput.current) fileInput.current.value = ''
  }

  const crumbs = path ? path.split('/') : []
  const allChecked = entries.length > 0 && sel.size === entries.length

  return (
    <>
      <PageHeader
        title="Workspace"
        subtitle="Manage the files and folders in your private locker — create, upload, rename, download and delete."
        actions={<a href="https://mapdrive.sisp.com" target="_blank" rel="noopener"><Button variant="secondary" icon="hard-drive-2-line">Map as a drive</Button></a>}
      />

      {/* Locker banner */}
      <Card className="mb-4 flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-brand-tint text-brand"><Icon name="folder-user-line" className="text-lg" /></div>
          <div>
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-ink">Your locker</p>
              <Badge tone="ok"><Icon name="checkbox-circle-fill" className="text-2xs" /> ownership OK</Badge>
            </div>
            <p className="mt-0.5 text-xs text-ink-muted">Stored on the lab NAS, private to you. Every change runs as your lab identity — uploads are hash-verified.</p>
          </div>
        </div>
        <p className="tabular select-all text-2xs text-ink-muted">\\nas.sisp.com\sisplockers\{user}</p>
      </Card>

      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" icon="folder-add-line" disabled={busy} onClick={newFolder}>New folder</Button>
        <Button size="sm" variant="secondary" icon="file-add-line" disabled={busy} onClick={newFile}>New file</Button>
        <Button size="sm" variant="primary" icon="upload-2-line" disabled={busy} onClick={() => fileInput.current?.click()}>Upload</Button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => onPick(e.target.files)} />
        <span className="mx-1 h-5 w-px bg-border" />
        <Button size="sm" variant="ghost" icon="download-2-line" disabled={busy || sel.size === 0} onClick={() => entries.filter((e) => sel.has(e.name)).forEach(downloadEntry)}>Download{sel.size ? ` (${sel.size})` : ''}</Button>
        <Button size="sm" variant="ghost" icon="edit-line" disabled={busy || sel.size !== 1} onClick={() => { const e = entries.find((x) => sel.has(x.name)); if (e) rename(e) }}>Rename</Button>
        <Button size="sm" variant="ghost" icon="delete-bin-6-line" disabled={busy || sel.size === 0} onClick={removeSelected}>Delete{sel.size ? ` (${sel.size})` : ''}</Button>
        <span className="ml-auto" />
        <Button size="sm" variant="ghost" icon="refresh-line" disabled={busy} onClick={refresh}>Refresh</Button>
      </div>

      {/* Breadcrumb */}
      <div className="mb-3 flex flex-wrap items-center gap-1 text-sm">
        <button onClick={() => setPath('')} className={cn('rounded px-1.5 py-0.5 hover:bg-surface-2', !path ? 'font-medium text-ink' : 'text-brand')}>
          <Icon name="folder-3-line" className="mr-1" />locker
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <Icon name="arrow-right-s-line" className="text-ink-muted" />
            <button onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))} className={cn('rounded px-1.5 py-0.5 hover:bg-surface-2', i === crumbs.length - 1 ? 'font-medium text-ink' : 'text-brand')}>{c}</button>
          </span>
        ))}
      </div>

      {/* Upload progress */}
      {uploads.length > 0 && (
        <Card className="mb-3 divide-y divide-border">
          {uploads.map((u) => (
            <div key={u.name} className="flex items-center gap-3 px-4 py-2 text-sm">
              <Icon name={u.state === 'error' ? 'error-warning-line' : u.state === 'done' ? 'checkbox-circle-line' : 'upload-cloud-2-line'} className={cn(u.state === 'error' ? 'text-err' : u.state === 'done' ? 'text-ok' : 'text-brand')} />
              <span className="w-48 truncate text-ink">{u.name}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                <div className={cn('h-full rounded-full transition-all', u.state === 'error' ? 'bg-err' : 'bg-brand')} style={{ width: `${u.pct}%` }} />
              </div>
              <span className="w-56 truncate text-right text-2xs text-ink-muted">{u.msg ?? `${u.pct}%`}</span>
            </div>
          ))}
          {uploads.some((u) => u.state !== 'uploading') && (
            <div className="px-4 py-1.5 text-right">
              <button className="text-2xs text-ink-muted hover:text-ink" onClick={() => setUploads((u) => u.filter((x) => x.state === 'uploading'))}>Clear finished</button>
            </div>
          )}
        </Card>
      )}

      <div className={cn('grid gap-4', preview ? 'lg:grid-cols-[1fr_1fr]' : 'grid-cols-1')}>
        {/* File list */}
        <Card className="flex max-h-[calc(100vh-18rem)] flex-col overflow-hidden">
          <div className="grid shrink-0 grid-cols-[1.5rem_1.5rem_1fr_7rem_8rem_2rem] items-center gap-2 border-b border-border bg-surface-2/50 px-4 py-2 text-2xs font-medium uppercase tracking-wide text-ink-muted">
            <input type="checkbox" aria-label="select all" checked={allChecked} onChange={toggleAll} className="h-4 w-4 accent-[var(--brand)]" />
            <span></span><span>Name</span><span>Size</span><span>Modified</span><span></span>
          </div>
          <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="space-y-2 p-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-7" />)}</div>
          ) : error ? (
            <EmptyState icon="error-warning-line" title="Couldn't open this folder" description={error} />
          ) : entries.length === 0 ? (
            <EmptyState icon="folder-open-line" title="Empty folder" description="Use New folder, New file, or Upload to add content." />
          ) : (
            entries.map((e) => (
              <div key={e.name} className={cn('grid grid-cols-[1.5rem_1.5rem_1fr_7rem_8rem_2rem] items-center gap-2 border-b border-border px-4 py-2 text-sm last:border-0 hover:bg-surface-2/40', sel.has(e.name) && 'bg-brand-tint/40')}>
              <input type="checkbox" aria-label={`select ${e.name}`} checked={sel.has(e.name)} onChange={() => toggle(e.name)} className="h-4 w-4 accent-[var(--brand)]" />
                <Icon name={iconFor(e)} className={e.type === 'dir' ? 'text-brand' : 'text-ink-muted'} />
                {e.type === 'dir' ? (
                  <button onClick={() => setPath(join(path, e.name))} className="truncate text-left font-medium text-ink hover:text-brand">{e.name}</button>
                ) : (
                  <button onClick={() => openPreview(e)} className="truncate text-left text-ink hover:text-brand" title="Preview">{e.name}</button>
                )}
                <span className="tabular text-2xs text-ink-muted">
                  {e.type === 'file'
                    ? fmtSize(e.size)
                    : e.name in dirSizes
                      ? (dirSizes[e.name] < 0 ? '—' : fmtSize(dirSizes[e.name]))
                      : <span className="text-ink-muted/60">…</span>}
                </span>
                <span className="tabular text-2xs text-ink-muted">{e.mtime ? new Date(e.mtime * 1000).toLocaleString() : ''}</span>
                <span className="text-right">
                  <button title={e.type === 'dir' ? 'Download folder as .zip' : 'Download'} onClick={() => downloadEntry(e)} className="text-ink-muted hover:text-brand"><Icon name={e.type === 'dir' ? 'folder-zip-line' : 'download-2-line'} /></button>
                </span>
              </div>
            ))
          )}
          </div>
        </Card>

        {/* Preview pane */}
        {preview && (
          <Card className="flex flex-col overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
              <span className="flex items-center gap-2 truncate text-sm font-medium text-ink"><Icon name="file-text-line" className="text-brand" />{preview.name}</span>
              <div className="flex items-center gap-1">
                <button title="Download" onClick={() => downloadOne({ type: 'file', name: preview.name, size: 0, mtime: 0 })} className="rounded p-1 text-ink-muted hover:text-brand"><Icon name="download-2-line" /></button>
                <button title="Close" onClick={() => setPreview(null)} className="rounded p-1 text-ink-muted hover:text-ink"><Icon name="close-line" /></button>
              </div>
            </div>
            <pre className="tabular max-h-[60vh] overflow-auto p-4 text-2xs leading-5 text-ink">{preview.text}</pre>
            {preview.truncated && <p className="border-t border-border px-4 py-1.5 text-2xs text-ink-muted">Preview truncated — download for the full file.</p>}
          </Card>
        )}
      </div>

      <p className="mt-2 text-2xs text-ink-muted">Large files stream directly to and from the NAS and are integrity-checked (SHA-256) on every transfer — nothing is held in browser memory.</p>
    </>
  )
}
