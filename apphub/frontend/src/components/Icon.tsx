import { cn } from '@/lib/cn'

// Single seam for iconography. Today it renders the Remix Icon webfont; ADR-006 calls
// for subsetting to inline SVGs for production first-paint — when that happens, only
// this component changes. Pass the ri name WITHOUT the `ri-` prefix.
export function Icon({
  name,
  className,
  label,
}: {
  name: string
  className?: string
  /** If provided, the icon is announced to screen readers; otherwise it is decorative. */
  label?: string
}) {
  return (
    <i
      className={cn(`ri-${name}`, 'leading-none', className)}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    />
  )
}
