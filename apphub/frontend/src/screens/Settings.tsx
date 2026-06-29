import { useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { Card } from '@/components/Card'
import { Icon } from '@/components/Icon'
import { Badge } from '@/components/Badge'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { Field } from '@/components/Field'
import { Input } from '@/components/Input'
import { cn } from '@/lib/cn'
import { useTheme, type ThemePref } from '@/lib/theme'
import { useSession } from '@/lib/session'
import { useToast } from '@/lib/toast'
import { api } from '@/lib/api'

const THEMES: { value: ThemePref; label: string; icon: string }[] = [
  { value: 'light', label: 'Light', icon: 'sun-line' },
  { value: 'dark', label: 'Dark', icon: 'moon-line' },
  { value: 'system', label: 'System', icon: 'computer-line' },
]

function DrivePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast()
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()

  async function submit() {
    setErr(undefined)
    if (pw !== confirm) { setErr('The passwords do not match.'); return }
    if (!pw) { setErr('Enter your lab password.'); return }
    setBusy(true)
    try {
      await api.setDrivePassword(pw)
      toast.push('Network-drive access enabled.', 'ok')
      setPw(''); setConfirm('')
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not enable drive access')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Enable network-drive access" size="sm">
      <div className="space-y-4 p-5">
        <p className="text-sm text-ink-muted">
          Enter your <span className="font-medium text-ink">lab password</span> to enable mapping your files as a
          network drive. This does <span className="font-medium text-ink">not</span> change your password — it just lets
          the file gateway recognize you.
        </p>
        <Field label="Lab password" error={err}>
          {(id) => <Input id={id} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" autoFocus />}
        </Field>
        <Field label="Confirm password">
          {(id) => <Input id={id} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="current-password" />}
        </Field>
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon="hard-drive-2-line" loading={busy} onClick={submit}>Enable drive access</Button>
      </div>
    </Modal>
  )
}

export function Settings() {
  const { pref, setPref } = useTheme()
  const { session } = useSession()
  const u = session?.user
  const [drivePwOpen, setDrivePwOpen] = useState(false)

  return (
    <>
      <PageHeader title="Settings" subtitle="Personalize AppHub and review your account." />

      <div className="space-y-6">
        <Card className="p-5">
          <h2 className="mb-1 text-sm font-semibold text-ink">Appearance</h2>
          <p className="mb-4 text-xs text-ink-muted">Choose how AppHub looks. Saved to this browser.</p>
          <div className="grid max-w-md grid-cols-3 gap-3">
            {THEMES.map((t) => (
              <button
                key={t.value}
                onClick={() => setPref(t.value)}
                className={cn(
                  'flex flex-col items-center gap-2 rounded-md border px-3 py-4 text-xs font-medium transition-colors',
                  pref === t.value ? 'border-brand bg-brand-tint text-brand' : 'border-border text-ink-muted hover:text-ink',
                )}
              >
                <Icon name={t.icon} className="text-xl" />
                {t.label}
              </button>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold text-ink">Account</h2>
          <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
            <div><dt className="text-2xs text-ink-muted">Name</dt><dd className="text-sm text-ink">{u?.displayName}</dd></div>
            <div><dt className="text-2xs text-ink-muted">Username</dt><dd className="tabular text-sm text-ink">{u?.username}</dd></div>
            <div><dt className="text-2xs text-ink-muted">UID</dt><dd className="tabular text-sm text-ink">{u?.uid ?? '—'}</dd></div>
            <div><dt className="text-2xs text-ink-muted">Role</dt><dd className="text-sm capitalize text-ink">{u?.role}</dd></div>
            <div className="sm:col-span-2">
              <dt className="mb-1 text-2xs text-ink-muted">Groups</dt>
              <dd className="flex flex-wrap gap-1">{u?.groups.map((g) => <Badge key={g} tone="neutral">{g}</Badge>)}</dd>
            </div>
          </dl>
        </Card>

        <Card className="flex items-start gap-3 p-5">
          <Icon name="key-2-line" className="mt-0.5 text-ink-muted" />
          <div className="flex-1">
            <p className="text-sm font-medium text-ink">Network-drive access</p>
            <p className="text-xs text-ink-muted">Enable mapping your locker as a drive on Windows/macOS. Uses your existing lab password — nothing is changed.</p>
          </div>
          <Button variant="secondary" icon="hard-drive-2-line" onClick={() => setDrivePwOpen(true)}>Enable</Button>
        </Card>
      </div>

      <DrivePasswordModal open={drivePwOpen} onClose={() => setDrivePwOpen(false)} />
    </>
  )
}
