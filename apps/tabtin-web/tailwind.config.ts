import type { Config } from 'tailwindcss'
import animate from 'tailwindcss-animate'

const tabTinPreset = require('@tabtin/tailwind-preset')

const config: Config = {
  presets: [tabTinPreset],
  darkMode: ['class'],
  content: [
    './index.html',
    './src/**/*.{ts,tsx,js,jsx}',
    '../../packages/smartsheet-ui/src/**/*.{ts,tsx}',
    '../../packages/table-engine-canvas/src/**/*.{ts,tsx}',
    '../../packages/table-engine-canvas/node_modules/@teable/ui-lib/dist/**/*.js',
    '../../packages/table-ui/src/**/*.{ts,tsx}',
    '../../packages/tabdoc-ui/src/**/*.{ts,tsx}',
    '../../packages/collab-core/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        canvas: 'hsl(var(--canvas))',
        'type-webhook': 'hsl(var(--type-webhook) / <alpha-value>)',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
      },
    },
  },
  plugins: [animate],
}

export default config
