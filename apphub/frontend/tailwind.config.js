/** @type {import('tailwindcss').Config} */
// Semantic tokens only. Raw hex lives in src/index.css (light + dark). Components
// must reference these names, never literal colors — this is the design contract.
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        border: 'var(--border)',
        ink: 'var(--ink)',
        'ink-muted': 'var(--ink-muted)',
        brand: 'var(--brand)',
        'brand-strong': 'var(--brand-strong)',
        'brand-tint': 'var(--brand-tint)',
        'accent-blue': 'var(--accent-blue)',
        ok: 'var(--ok)',
        warn: 'var(--warn)',
        err: 'var(--err)',
        queued: 'var(--queued)',
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        // Bumped one step for readability (esp. mobile): 13 / 14 / 15 / 16 / 18 / 22 / 28 / 36.
        '2xs': ['0.8125rem', { lineHeight: '1.125rem' }],
        xs: ['0.875rem', { lineHeight: '1.25rem' }],
        sm: ['0.9375rem', { lineHeight: '1.4375rem' }],
        base: ['1rem', { lineHeight: '1.5rem' }],
        lg: ['1.125rem', { lineHeight: '1.625rem' }],
        xl: ['1.375rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.75rem', { lineHeight: '2.125rem' }],
        '3xl': ['2.25rem', { lineHeight: '2.5rem' }],
      },
      borderRadius: {
        sm: '6px',
        md: '10px',
        lg: '16px',
      },
      boxShadow: {
        1: '0 1px 2px rgba(16,32,29,.06)',
        2: '0 8px 24px rgba(16,32,29,.10)',
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'scale-in': {
          from: { opacity: '0', transform: 'translateY(4px) scale(.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'pulse-ring': {
          '0%,100%': { opacity: '1' },
          '50%': { opacity: '.45' },
        },
      },
      animation: {
        'fade-in': 'fade-in .12s ease-out',
        'scale-in': 'scale-in .2s cubic-bezier(0.22,0.61,0.36,1)',
        'pulse-ring': 'pulse-ring 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
