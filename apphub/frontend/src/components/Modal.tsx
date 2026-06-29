import { useEffect, useId, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Icon } from './Icon'

export function Modal({
  open,
  onClose,
  title,
  children,
  size = 'md',
  ariaLabel,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  size?: 'sm' | 'md' | 'lg'
  /** required when no `title` is provided, so the dialog has an accessible name */
  ariaLabel?: string
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    if (!open) return
    const prevFocus = document.activeElement as HTMLElement | null

    // Move focus into the dialog on open.
    const panel = panelRef.current
    const focusFirst = () => {
      const focusable = panel?.querySelector<HTMLElement>(
        'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])',
      )
      ;(focusable ?? panel)?.focus()
    }
    const t = setTimeout(focusFirst, 10)

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === 'Tab' && panel) {
        // Trap focus within the dialog.
        const items = Array.from(
          panel.querySelectorAll<HTMLElement>(
            'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => el.offsetParent !== null)
        if (items.length === 0) return
        const first = items[0]
        const last = items[items.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      clearTimeout(t)
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
      prevFocus?.focus?.() // restore focus to the trigger
    }
  }, [open, onClose])

  if (!open) return null
  const width = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl' }[size]

  return (
    // Outer scroll container + an inner flex wrapper that is at least viewport-tall: the panel
    // centers when it fits and the whole thing scrolls (top reachable) when it's taller. This
    // avoids the old "tall modal sits low and runs off the bottom of the screen" problem.
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="animate-fade-in fixed inset-0 bg-ink/40 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className="relative flex min-h-full items-center justify-center p-4 sm:p-6">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          aria-label={title ? undefined : ariaLabel}
          tabIndex={-1}
          className={cn('animate-scale-in relative z-10 w-full rounded-lg border border-border bg-surface shadow-2 outline-none', width)}
        >
        {title && (
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <h2 id={titleId} className="text-base font-semibold text-ink">
              {title}
            </h2>
            <button
              onClick={onClose}
              aria-label="Close"
              className="flex h-10 w-10 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-2 hover:text-ink"
            >
              <Icon name="close-line" className="text-lg" />
            </button>
          </div>
        )}
          {children}
        </div>
      </div>
    </div>
  )
}
