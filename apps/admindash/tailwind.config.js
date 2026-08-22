const tabTinPreset = require('@tabtin/tailwind-preset')

/** @type {import('tailwindcss').Config} */
export default {
  presets: [tabTinPreset],
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx,js,jsx}'],
  theme: {
    extend: {
      colors: {
        'type-ai': 'hsl(var(--type-ai) / <alpha-value>)',
        'type-ai-foreground': 'hsl(var(--type-ai-foreground) / <alpha-value>)',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [],
}
