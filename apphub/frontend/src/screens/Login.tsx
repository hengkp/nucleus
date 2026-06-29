import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/Button'
import { Field } from '@/components/Field'
import { Input } from '@/components/Input'
import { Icon } from '@/components/Icon'
import { IS_MOCK, api } from '@/lib/api'
import { useSession } from '@/lib/session'

// Split layout: brand panel (left) + LDAP credentials (right). The form logs in via the
// in-app auth call (Authelia behind nginx); in mock/dev it just continues to the app.
export function Login() {
  const navigate = useNavigate()
  const { refresh } = useSession()
  const [busy, setBusy] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string>()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(undefined)
    setBusy(true)
    try {
      if (!IS_MOCK) await api.login(username, password)
      refresh()
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed')
      setBusy(false)
    }
  }

  return (
    <div className="grid h-full lg:grid-cols-2">
      {/* Brand panel */}
      <div
        className="relative hidden overflow-hidden bg-ink lg:flex lg:flex-col lg:justify-between lg:p-12"
        style={{ backgroundImage: 'url(/brand/login-hero.png)', backgroundSize: 'cover', backgroundPosition: 'center' }}
      >
        {/* dark overlay so white text stays readable over the imagery */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink/80 via-ink/30 to-ink/10" />
        <div className="relative flex items-center gap-3 text-white">
          <img src="/brand/logo.png" alt="" className="h-9 w-9 brightness-0 invert" />
          <span className="text-lg font-semibold">SISP AppHub</span>
        </div>
        <div className="relative max-w-md text-white">
          <h1 className="text-3xl font-semibold leading-tight">Your lab's analysis apps, one click away.</h1>
          <p className="mt-3 text-sm text-white/80">
            Launch JupyterLab, RStudio, Galaxy and more across the cluster, with no terminal and no setup. Each session
            runs on its own slice of compute so nothing hangs.
          </p>
          <div className="mt-8 flex flex-wrap gap-4 text-xs text-white/80">
            <span className="tabular inline-flex items-center gap-1.5"><Icon name="cpu-line" /> 112 CPU</span>
            <span className="tabular inline-flex items-center gap-1.5"><Icon name="ram-2-line" /> 512 GB RAM</span>
            <span className="tabular inline-flex items-center gap-1.5"><Icon name="server-line" /> 4 nodes</span>
          </div>
        </div>
        <p className="relative text-xs text-white/70">Siriraj Integrative Systems Pharmacology | node1.sisp.com</p>
      </div>

      {/* Credentials */}
      <div className="flex items-center justify-center bg-bg p-6">
        <form onSubmit={submit} className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <img src="/brand/logo.png" alt="" className="h-8 w-8" />
            <span className="text-lg font-semibold text-ink">SISP AppHub</span>
          </div>
          <h2 className="text-xl font-semibold text-ink">Sign in</h2>
          <p className="mt-1 text-sm text-ink-muted">Use your lab (LDAP) account.</p>

          <div className="mt-6 space-y-4">
            <Field label="Username" error={error}>
              {(id) => <Input id={id} autoFocus value={username} onChange={(e) => setUsername(e.target.value)} placeholder="" autoComplete="username" />}
            </Field>
            <Field label="Password">
              {(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="your lab password" autoComplete="current-password" />}
            </Field>
            <Button type="submit" variant="primary" className="w-full" loading={busy} iconRight="arrow-right-line">
              Sign in
            </Button>
          </div>

          {IS_MOCK && (
            <p className="mt-4 rounded-md bg-surface-2 px-3 py-2 text-2xs text-ink-muted">
              Demo mode. Any credentials continue to the app.
            </p>
          )}

          <p className="mt-6 text-center text-2xs text-ink-muted">
            Trouble signing in? Contact the admin team.
          </p>
        </form>
      </div>
    </div>
  )
}
