import { Icon } from './Icon'
import type { ReactNode } from 'react'

export function EmptyState({
  icon = 'inbox-line',
  image,
  title,
  description,
  action,
}: {
  icon?: string
  /** optional illustration shown instead of the icon chip (e.g. /brand/empty-state.png) */
  image?: string
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border bg-surface/50 px-6 py-14 text-center">
      {image ? (
        <img src={image} alt="" className="mb-4 h-28 w-28 object-contain" />
      ) : (
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-lg bg-brand-tint">
          <Icon name={icon} className="text-2xl text-brand" />
        </div>
      )}
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-ink-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
