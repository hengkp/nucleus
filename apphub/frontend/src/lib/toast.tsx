import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import { cn } from './cn'

type ToastKind = 'ok' | 'err' | 'info'
interface Toast {
  id: number
  kind: ToastKind
  message: string
}

interface ToastCtx {
  push: (message: string, kind?: ToastKind) => void
}

const Ctx = createContext<ToastCtx | null>(null)
let tid = 1

const ICONS: Record<ToastKind, string> = {
  ok: 'checkbox-circle-fill',
  err: 'error-warning-fill',
  info: 'information-fill',
}
const TONE: Record<ToastKind, string> = {
  ok: 'text-ok',
  err: 'text-err',
  info: 'text-accent-blue',
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = tid++
    setToasts((t) => [...t, { id, kind, message }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200)
  }, [])

  return (
    <Ctx.Provider value={{ push }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className="animate-scale-in flex items-start gap-2.5 rounded-md border border-border bg-surface p-3 shadow-2"
          >
            <Icon name={ICONS[t.kind]} className={cn('mt-0.5 text-base', TONE[t.kind])} />
            <p className="text-sm text-ink">{t.message}</p>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export function useToast(): ToastCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useToast must be used within ToastProvider')
  return c
}
