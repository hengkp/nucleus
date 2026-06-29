import { Icon } from './Icon'
import { Input } from './Input'
import { cn } from '@/lib/cn'

// A small visual icon chooser plus a free-text field (any Remix Icon name) and a link to the full
// gallery. Used wherever a template/pipeline wants a custom icon.
const COMMON_ICONS = [
  'rocket-2-line', 'box-3-line', 'flask-line', 'terminal-box-line', 'code-box-line', 'cpu-line',
  'bar-chart-box-line', 'line-chart-line', 'database-2-line', 'server-line', 'cloud-line', 'table-line',
  'microscope-line', 'dna-line', 'test-tube-line', 'brain-line', 'leaf-line', 'plant-line',
  'flow-chart', 'layout-masonry-line', 'slideshow-line', 'plug-line', 'html5-line', 'book-open-line',
]

export function IconPicker({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {COMMON_ICONS.map((ic) => (
          <button
            key={ic}
            type="button"
            aria-label={ic}
            title={ic}
            onClick={() => onChange(ic)}
            className={cn('grid h-9 w-9 place-items-center rounded-md border', value === ic ? 'border-brand bg-brand-tint text-brand' : 'border-border text-ink-muted hover:text-ink')}
          >
            <Icon name={ic} className="text-lg" />
          </button>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder || 'or type a Remix Icon name, e.g. rocket-2-line'} />
        <a href="https://remixicon.com/" target="_blank" rel="noreferrer" className="whitespace-nowrap text-2xs font-medium text-brand hover:text-brand-strong">
          Browse all ↗
        </a>
      </div>
    </div>
  )
}
