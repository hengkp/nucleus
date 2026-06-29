import { Card } from './Card'
import { Icon } from './Icon'
import { Badge } from './Badge'
import { Button } from './Button'
import { cn } from '@/lib/cn'
import type { Template } from '@/lib/types'

// The whole card is clickable → opens the configure/launch wizard. A star toggles favorite.
export function TemplateCard({
  template,
  onLaunch,
  isFavorite = false,
  onToggleFavorite,
  onDelete,
}: {
  template: Template
  onLaunch: (t: Template) => void
  isFavorite?: boolean
  onToggleFavorite?: (t: Template) => void
  onDelete?: (t: Template) => void
}) {
  return (
    <Card interactive className="group flex cursor-pointer flex-col p-4" onClick={() => onLaunch(template)}>
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-brand to-brand-strong text-white">
          <Icon name={template.icon} className="text-xl" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-ink">{template.name}</h3>
            {!template.enabled && <Badge tone="warn">Approval</Badge>}
            {template.custom && <Badge tone="blue">{template.scope === 'shared' ? 'shared' : 'mine'}</Badge>}
          </div>
          <p className="text-2xs uppercase tracking-wide text-ink-muted">{template.category}</p>
        </div>
        {onDelete && template.custom && (
          <button
            aria-label="Delete template"
            title="Delete template"
            onClick={(e) => { e.stopPropagation(); onDelete(template) }}
            className="flex h-8 w-8 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-2 hover:text-err"
          >
            <Icon name="delete-bin-6-line" className="text-base" />
          </button>
        )}
        {onToggleFavorite && (
          <button
            aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            aria-pressed={isFavorite}
            onClick={(e) => { e.stopPropagation(); onToggleFavorite(template) }}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-sm hover:bg-surface-2',
              isFavorite ? 'text-warn' : 'text-ink-muted',
            )}
          >
            <Icon name={isFavorite ? 'star-fill' : 'star-line'} className="text-base" />
          </button>
        )}
      </div>

      <p className="mt-3 line-clamp-2 text-xs text-ink-muted">{template.description}</p>

      {template.preinstalled && template.preinstalled.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {template.preinstalled.slice(0, 3).map((p) => (
            <Badge key={p} tone="neutral">{p}</Badge>
          ))}
          {template.preinstalled.length > 3 && <Badge tone="neutral">+{template.preinstalled.length - 3}</Badge>}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
        <span className="tabular text-2xs text-ink-muted">
          {template.defaults.cpus} CPU · {(template.defaults.memoryMb / 1024).toFixed(0)} GB to start
        </span>
        <Button size="sm" variant="primary" icon="settings-3-line" onClick={(e) => { e.stopPropagation(); onLaunch(template) }}>
          Configure
        </Button>
      </div>
    </Card>
  )
}
