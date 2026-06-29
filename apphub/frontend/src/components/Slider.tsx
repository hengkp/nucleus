import { cn } from '@/lib/cn'

// Range control used by the launch wizard for CPU / RAM / time. Shows the live value
// and the ceiling so non-technical users see the bound, not a raw number.
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  format = String,
  maxLabel,
  className,
  'aria-label': ariaLabel,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  format?: (v: number) => string
  maxLabel?: string
  className?: string
  'aria-label'?: string
}) {
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-baseline justify-between">
        <span className="tabular text-sm font-medium text-ink">{format(value)}</span>
        <span className="text-2xs text-ink-muted">max {maxLabel ?? format(max)}</span>
      </div>
      <input
        type="range"
        aria-label={ariaLabel}
        aria-valuetext={format(value)}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-2 w-full cursor-pointer appearance-none rounded-full
          [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand [&::-webkit-slider-thumb]:shadow
          [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full
          [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-brand"
        style={{
          background: `linear-gradient(to right, var(--brand) ${fill}%, var(--surface-2) ${fill}%)`,
        }}
      />
    </div>
  )
}
