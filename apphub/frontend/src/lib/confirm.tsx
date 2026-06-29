import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { Icon } from '@/components/Icon'
import { cn } from './cn'

// App-themed replacements for window.confirm / window.prompt so destructive actions and quick
// inputs use the same Modal styling as the rest of the app (not the browser's default chrome).

interface ConfirmOpts {
  title: string
  message?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
  icon?: string
}
interface PromptOpts {
  title: string
  message?: ReactNode
  label?: string
  placeholder?: string
  defaultValue?: string
  confirmLabel?: string
  multiline?: boolean
}
interface ConfirmCtx {
  confirm: (o: ConfirmOpts) => Promise<boolean>
  prompt: (o: PromptOpts) => Promise<string | null>
}

const Ctx = createContext<ConfirmCtx | null>(null)

type State =
  | { kind: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: 'prompt'; opts: PromptOpts; resolve: (v: string | null) => void }
  | null

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(null)
  const [value, setValue] = useState('')

  const confirm = useCallback(
    (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ kind: 'confirm', opts, resolve })),
    [],
  )
  const prompt = useCallback(
    (opts: PromptOpts) =>
      new Promise<string | null>((resolve) => {
        setValue(opts.defaultValue ?? '')
        setState({ kind: 'prompt', opts, resolve })
      }),
    [],
  )

  const settle = (result: boolean | string | null) => {
    setState((s) => {
      if (s) (s.resolve as (v: boolean | string | null) => void)(result)
      return null
    })
  }
  const cancel = () => settle(state?.kind === 'prompt' ? null : false)
  const accept = () => settle(state?.kind === 'prompt' ? value : true)

  const danger = state?.kind === 'confirm' && state.opts.tone === 'danger'
  const confirmLabel = state?.opts.confirmLabel ?? (state?.kind === 'prompt' ? 'OK' : danger ? 'Delete' : 'Confirm')
  const cancelLabel = (state?.kind === 'confirm' && state.opts.cancelLabel) || 'Cancel'
  const headIcon = state?.kind === 'confirm' ? state.opts.icon ?? (danger ? 'error-warning-line' : 'question-line') : null

  return (
    <Ctx.Provider value={{ confirm, prompt }}>
      {children}
      <Modal open={!!state} onClose={cancel} title={state?.opts.title ?? ''} size="sm">
        {state && (
          <>
            <div className="p-5">
              <div className="flex items-start gap-3">
                {headIcon && (
                  <span className={cn('mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full', danger ? 'bg-err/10 text-err' : 'bg-brand-tint text-brand')}>
                    <Icon name={headIcon} className="text-lg" />
                  </span>
                )}
                <div className="min-w-0 flex-1 space-y-3">
                  {state.opts.message && <p className="text-sm leading-relaxed text-ink-muted">{state.opts.message}</p>}
                  {state.kind === 'prompt' && (
                    <div className="space-y-1.5">
                      {state.opts.label && <span className="block text-xs font-medium text-ink">{state.opts.label}</span>}
                      {state.opts.multiline ? (
                        <textarea
                          autoFocus
                          value={value}
                          onChange={(e) => setValue(e.target.value)}
                          placeholder={state.opts.placeholder}
                          rows={3}
                          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brand"
                        />
                      ) : (
                        <input
                          autoFocus
                          value={value}
                          onChange={(e) => setValue(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') accept() }}
                          placeholder={state.opts.placeholder}
                          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brand"
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
              <Button variant="ghost" onClick={cancel}>{cancelLabel}</Button>
              <Button variant={danger ? 'danger' : 'primary'} onClick={accept}>{confirmLabel}</Button>
            </div>
          </>
        )}
      </Modal>
    </Ctx.Provider>
  )
}

export function useConfirm(): ConfirmCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useConfirm must be used within ConfirmProvider')
  return c
}
