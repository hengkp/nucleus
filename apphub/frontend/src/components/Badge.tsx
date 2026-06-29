import { cn } from '@/lib/cn'
import type { ReactNode } from 'react'

type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'err' | 'blue'

const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-ink-muted border-border',
  brand: 'bg-brand-tint text-brand border-transparent',
  ok: 'bg-transparent text-ok border-ok/30',
  warn: 'bg-transparent text-warn border-warn/30',
  err: 'bg-transparent text-err border-err/30',
  blue: 'bg-transparent text-accent-blue border-accent-blue/30',
}

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}
