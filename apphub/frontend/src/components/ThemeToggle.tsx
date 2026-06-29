import { useTheme } from '@/lib/theme'
import { Icon } from './Icon'

export function ThemeToggle() {
  const { resolved, toggle } = useTheme()
  return (
    <button
      onClick={toggle}
      aria-label={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} theme`}
      title={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} theme`}
      className="flex h-9 w-9 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink"
    >
      <Icon name={resolved === 'dark' ? 'sun-line' : 'moon-line'} className="text-lg" />
    </button>
  )
}
