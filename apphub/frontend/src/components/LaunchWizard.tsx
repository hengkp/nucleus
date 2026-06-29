import { useEffect, useMemo, useState } from 'react'
import { Modal } from './Modal'
import { Button } from './Button'
import { Icon } from './Icon'
import { Field } from './Field'
import { Input } from './Input'
import { FolderInput } from './FolderInput'
import { Slider } from './Slider'
import { Badge } from './Badge'
import { cn } from '@/lib/cn'
import { gb, timeLimitLabel } from '@/lib/format'
import { api } from '@/lib/api'
import { useToast } from '@/lib/toast'
import type { Instance, Template, VanityCheck, Visibility } from '@/lib/types'

// Guided launch. A novice can accept recommended settings and press Launch immediately;
// resources are folded behind "Customize" (progressive disclosure). The 80% stay on the
// happy path; power users get full control.
const ALL_PRESETS: { label: string; minutes: number | null }[] = [
  { label: '2 hours', minutes: 120 },
  { label: '8 hours', minutes: 480 },
  { label: '24 hours', minutes: 1440 },
  { label: '2 days', minutes: 2880 },
  { label: '3 days', minutes: 4320 },
]

const VIS_OPTIONS: { value: Visibility; icon: string }[] = [
  { value: 'private', icon: 'lock-line' },
  { value: 'team', icon: 'group-line' },
]

export function LaunchWizard({
  template,
  onClose,
  onLaunched,
}: {
  template: Template | null
  onClose: () => void
  onLaunched: (i: Instance) => void
}) {
  const toast = useToast()
  const [advanced, setAdvanced] = useState(false)
  const [name, setName] = useState('')
  const [cpus, setCpus] = useState(template?.defaults.cpus ?? 2)
  const [memoryMb, setMemoryMb] = useState(template?.defaults.memoryMb ?? 8192)
  const [timeMinutes, setTimeMinutes] = useState<number | null>(template?.defaults.timeMinutes ?? 480)
  const [entrypoint, setEntrypoint] = useState(template?.presetEntrypoint ?? (template?.needsEntrypoint ? 'app.py' : ''))
  const [folder, setFolder] = useState(template?.presetFolder ?? '')
  const [command, setCommand] = useState(template?.presetCommand ?? '')
  const [makePublic, setMakePublic] = useState(false)
  const [visibility, setVisibility] = useState<Visibility>('private')
  const [busy, setBusy] = useState(false)
  // Self-service custom URL: type a name, see availability live, claim it instantly if free.
  const [vanityOpen, setVanityOpen] = useState(false)
  const [vanityInput, setVanityInput] = useState('')
  const [vanityCheck, setVanityCheck] = useState<VanityCheck | null>(null)
  const [vanityChecking, setVanityChecking] = useState(false)
  const [claiming, setClaiming] = useState(false)
  const isBatch = template?.kind === 'batch'

  // Re-seed all controls when a different template is opened (effect, not render-time setState).
  useEffect(() => {
    if (!template) return
    setCpus(template.defaults.cpus)
    setMemoryMb(template.defaults.memoryMb)
    setTimeMinutes(template.defaults.timeMinutes)
    setEntrypoint(template.presetEntrypoint ?? (template.needsEntrypoint ? 'app.py' : ''))
    setFolder(template.presetFolder ?? '')
    setCommand(template.presetCommand ?? '')
    setMakePublic(false)
    setName('')
    setVisibility('private')
    setAdvanced(false)
    setVanityOpen(false)
    setVanityInput('')
    setVanityCheck(null)
  }, [template?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced availability check while the custom-URL panel is open.
  useEffect(() => {
    if (!vanityOpen) return
    const nm = vanityInput.trim().toLowerCase()
    setVanityCheck(null)
    if (!nm) { setVanityChecking(false); return }
    setVanityChecking(true)
    let cancelled = false
    const t = setTimeout(async () => {
      try { const r = await api.checkVanity(nm); if (!cancelled) setVanityCheck(r) }
      catch { if (!cancelled) setVanityCheck(null) }
      finally { if (!cancelled) setVanityChecking(false) }
    }, 400)
    return () => { cancelled = true; clearTimeout(t) }
  }, [vanityInput, vanityOpen])

  async function claimVanity() {
    const nm = vanityInput.trim().toLowerCase()
    if (!nm) return
    setClaiming(true)
    try {
      await api.requestVanity(nm)
      setName(nm)
      setVanityOpen(false)
      toast.push(`Reserved ${nm}.app.sisp.com, it's yours`, 'ok')
    } catch (e) {
      toast.push(e instanceof Error ? e.message : 'Could not claim that name', 'err')
    } finally {
      setClaiming(false)
    }
  }

  // Only offer presets the template's time ceiling actually allows.
  const presets = useMemo(
    () => (template ? ALL_PRESETS.filter((p) => p.minutes !== null && p.minutes <= template.limits.maxTimeMinutes) : []),
    [template?.id], // eslint-disable-line react-hooks/exhaustive-deps
  )

  if (!template) return null
  const tpl = template
  const memGbMax = Math.round(tpl.limits.maxMemoryMb / 1024)

  async function launch() {
    setBusy(true)
    try {
      // Defensive client-side clamp mirroring the backend (ADR-006 / RISKS): never send
      // a request that exceeds the template envelope or asks for public visibility.
      const time = timeMinutes === null ? null : Math.min(timeMinutes, tpl.limits.maxTimeMinutes)
      const inst = await api.launch({
        templateId: tpl.id,
        name: name.trim() || undefined,
        cpus: Math.min(cpus, tpl.limits.maxCpus),
        memoryMb: Math.min(memoryMb, tpl.limits.maxMemoryMb),
        timeMinutes: time,
        entrypoint: entrypoint || undefined,
        command: isBatch ? command || undefined : undefined,
        folder: folder.trim() || undefined,
        public: !isBatch && makePublic,
        visibility: visibility === 'public' ? 'private' : visibility,
      })
      toast.push(`Launching ${inst.name}. It will appear on your dashboard.`, 'ok')
      onLaunched(inst)
      onClose()
    } catch (e) {
      toast.push(e instanceof Error ? e.message : 'Launch failed', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={!!template} onClose={onClose} title={isBatch ? `Run job: ${tpl.name}` : `Launch ${tpl.name}`} size="md">
      <div className="p-5">
        <div className="flex items-start gap-3 rounded-md bg-surface-2/60 p-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-gradient-to-br from-brand to-brand-strong text-white">
            <Icon name={tpl.icon} className="text-xl" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink">{tpl.description}</p>
            {tpl.preinstalled && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {tpl.preinstalled.map((p) => (
                  <Badge key={p} tone="brand">{p}</Badge>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="mt-5 space-y-4">
          <Field label="Name (optional)" hint="A short label so you can find this session later. Your URL becomes name-<you>.app.sisp.com, unless you claim a custom URL under Advanced options, which drops your username.">
            {(id) => (
              <Input id={id} value={name} placeholder={tpl.id} onChange={(e) => setName(e.target.value)} maxLength={40} />
            )}
          </Field>
          <Field label="Folder in your locker (optional)" hint="For example projects/my-site. The folder to run or serve from. Leave blank to use your locker root.">
            {(id) => <FolderInput id={id} value={folder} placeholder="projects/my-site" onChange={setFolder} />}
          </Field>

          {tpl.needsEntrypoint && !isBatch && (
            <Field label={tpl.byoImage ? 'Container image (.sif)' : 'Entry file'} hint={tpl.byoImage ? 'Apptainer/Singularity image path inside your locker, e.g. containers/myapp.sif.' : 'Path inside your workspace to run.'}>
              {(id) => <Input id={id} value={entrypoint} onChange={(e) => setEntrypoint(e.target.value)} placeholder={tpl.byoImage ? 'containers/myapp.sif' : 'app.py'} />}
            </Field>
          )}

          {isBatch && (
            <Field label="Command to run" hint="Runs as a SLURM job on a compute node. Output appears in your workspace + the job's logs.">
              {(id) => (
                <textarea
                  id={id}
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  rows={3}
                  placeholder={'e.g.  python train.py --epochs 50\n     or  bash analyze.sh'}
                  className="tabular w-full rounded-md border border-border bg-surface px-3 py-2 text-xs text-ink focus:border-brand"
                />
              )}
            </Field>
          )}

          <div className="space-y-1.5">
            <span className="block text-xs font-medium text-ink">Run time</span>
            <div role="radiogroup" aria-label="Run time" className="flex flex-wrap gap-2">
              {presets.map((t) => (
                <button
                  key={t.label}
                  role="radio"
                  aria-checked={timeMinutes === t.minutes}
                  onClick={() => setTimeMinutes(t.minutes)}
                  className={cn(
                    'min-h-10 rounded-md border px-3 text-xs font-medium transition-colors',
                    timeMinutes === t.minutes
                      ? 'border-brand bg-brand-tint text-brand'
                      : 'border-border text-ink-muted hover:border-brand/40 hover:text-ink',
                  )}
                >
                  {t.label}
                </button>
              ))}
              {/* Unlimited: runs until the user stops it (SLURM UNLIMITED partition). */}
              <button
                role="radio"
                aria-checked={timeMinutes === null}
                onClick={() => setTimeMinutes(null)}
                title="Runs until you stop it, no time limit"
                className={cn(
                  'min-h-10 rounded-md border px-3 text-xs font-medium transition-colors',
                  timeMinutes === null
                    ? 'border-brand bg-brand-tint text-brand'
                    : 'border-border text-ink-muted hover:border-brand/40 hover:text-ink',
                )}
              >
                Until I stop it
              </button>
            </div>
          </div>

          <button
            onClick={() => setAdvanced((a) => !a)}
            className="flex min-h-10 items-center gap-1.5 text-xs font-medium text-brand hover:text-brand-strong"
            aria-expanded={advanced}
          >
            <Icon name={advanced ? 'subtract-line' : 'add-line'} />
            Advanced options
          </button>

          {advanced && (
            <div className="space-y-4 rounded-md border border-border p-4">
              {/* Custom URL (claim a name with no username) */}
              {!isBatch && (
                <div>
                  {!vanityOpen ? (
                    <button
                      type="button"
                      onClick={() => { setVanityOpen(true); setVanityInput(name.trim().toLowerCase()) }}
                      className="text-xs font-medium text-brand hover:text-brand-strong"
                    >
                      <Icon name="links-line" className="mr-1" />Use a custom URL (no username)
                    </button>
                  ) : (
                    <div className="rounded-md border border-border p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-ink">Custom URL</span>
                        <button type="button" onClick={() => setVanityOpen(false)} className="text-2xs text-ink-muted hover:text-ink">Cancel</button>
                      </div>
                      <p className="mt-1 text-2xs text-ink-muted">Granted right away if the name is free. No admin approval, and it drops your username from the link.</p>
                      <div className="mt-2 flex items-stretch gap-2">
                        <div className="flex flex-1 items-center rounded-md border border-border bg-surface focus-within:border-brand">
                          <input
                            value={vanityInput}
                            onChange={(e) => setVanityInput(e.target.value.toLowerCase())}
                            placeholder="my-portfolio"
                            maxLength={40}
                            aria-label="Custom URL name"
                            className="tabular w-full bg-transparent px-2.5 py-2 text-xs text-ink outline-none"
                          />
                          <span className="whitespace-nowrap pr-2.5 font-mono text-2xs text-ink-muted">.app.sisp.com</span>
                        </div>
                        <Button size="sm" variant="primary" loading={claiming} disabled={!vanityCheck?.available} onClick={claimVanity}>
                          Claim and use
                        </Button>
                      </div>
                      <div className="mt-1.5 min-h-[1rem] text-2xs">
                        {vanityChecking && <span className="text-ink-muted"><Icon name="loader-4-line" className="mr-1 animate-spin" />checking</span>}
                        {!vanityChecking && vanityCheck && vanityInput.trim() && (
                          vanityCheck.available ? (
                            <span className="text-ok"><Icon name="checkbox-circle-line" className="mr-1" />{vanityCheck.reason === 'yours' ? 'Already yours, ready to use' : 'Available'}</span>
                          ) : (
                            <span className="text-err"><Icon name="close-circle-line" className="mr-1" />{
                              vanityCheck.reason === 'taken' ? 'Already taken, try another' :
                              vanityCheck.reason === 'reserved' ? 'Reserved name, try another' :
                              'Use 2 to 40 letters, digits, or hyphens'
                            }</span>
                          )
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Make public (external, no login) */}
              {!isBatch && (
                <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border p-3">
                  <input
                    type="checkbox"
                    checked={makePublic}
                    onChange={(e) => setMakePublic(e.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-brand"
                  />
                  <span className="text-xs">
                    <span className="block font-medium text-ink">Make public (external, no login)</span>
                    <span className="block text-ink-muted">
                      Also reachable from outside at <span className="font-mono">&lt;name&gt;.sisp.freeddns.org:8443</span> with
                      no sign in, which is handy for portfolios and demos. Anyone with the link can open it, so leave it off for anything with data.
                    </span>
                  </span>
                </label>
              )}

              {/* Resources */}
              <div className="grid gap-4 sm:grid-cols-2">
                <Slider
                  aria-label="CPU cores"
                  value={cpus}
                  min={1}
                  max={tpl.limits.maxCpus}
                  onChange={setCpus}
                  format={(v) => `${v} CPU`}
                />
                <Slider
                  aria-label="Memory in gigabytes"
                  value={Math.round(memoryMb / 1024)}
                  min={1}
                  max={memGbMax}
                  onChange={(v) => setMemoryMb(v * 1024)}
                  format={(v) => `${v} GB`}
                  maxLabel={`${memGbMax} GB`}
                />
                <div className={cn('space-y-1.5 sm:col-span-2', isBatch && 'hidden')}>
                  <span className="block text-xs font-medium text-ink">Visibility</span>
                  <div role="radiogroup" aria-label="Visibility" className="flex gap-2">
                    {VIS_OPTIONS.map((v) => (
                      <button
                        key={v.value}
                        role="radio"
                        aria-checked={visibility === v.value}
                        onClick={() => setVisibility(v.value)}
                        className={cn(
                          'flex min-h-10 flex-1 items-center justify-center rounded-md border px-3 text-xs font-medium capitalize',
                          visibility === v.value ? 'border-brand bg-brand-tint text-brand' : 'border-border text-ink-muted hover:text-ink',
                        )}
                      >
                        <Icon name={v.icon} className="mr-1.5" />
                        {v.value}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3.5">
        <p className="tabular text-2xs text-ink-muted">
          {cpus} CPU | {gb(memoryMb)} | {timeLimitLabel(timeMinutes)}
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={isBatch ? 'play-line' : 'rocket-2-line'} loading={busy} onClick={launch}>
            {isBatch ? 'Submit job' : 'Launch app'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
