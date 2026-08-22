const tabTinPreset = require('../../packages/tailwind-preset/index.cjs')

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [tabTinPreset],
  darkMode: ["class"],
  content: [
    './src/renderer/src/**/*.{ts,tsx}',
    './src/renderer/index.html',
    '../../packages/smartsheet-ui/src/**/*.{ts,tsx}',
    '../../packages/table-ui/src/**/*.{ts,tsx}',
    '../../packages/crawlspace-core/src/**/*.{ts,tsx}',
    '../../packages/table-engine-canvas/src/**/*.{ts,tsx}',
    '../../packages/table-engine-canvas/node_modules/@teable/ui-lib/dist/**/*.js',
    '../../packages/tabdoc-ui/src/**/*.{ts,tsx}',
    '../../packages/tabslide/dist/**/*.js',
    '../../packages/collab-core/src/**/*.{ts,tsx}',
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        'type-cron': 'hsl(var(--type-cron) / <alpha-value>)',
        'type-webhook': 'hsl(var(--type-webhook) / <alpha-value>)',
        'type-agent': 'hsl(var(--type-agent) / <alpha-value>)',
        brand: {
          50: 'hsl(var(--brand-50) / <alpha-value>)',
          100: 'hsl(var(--brand-100) / <alpha-value>)',
          200: 'hsl(var(--brand-200) / <alpha-value>)',
          300: 'hsl(var(--brand-300) / <alpha-value>)',
          400: 'hsl(var(--brand-400) / <alpha-value>)',
          500: 'hsl(var(--brand-500) / <alpha-value>)',
          600: 'hsl(var(--brand-600) / <alpha-value>)',
          700: 'hsl(var(--brand-700) / <alpha-value>)',
          800: 'hsl(var(--brand-800) / <alpha-value>)',
          900: 'hsl(var(--brand-900) / <alpha-value>)',
          950: 'hsl(var(--brand-950) / <alpha-value>)',
        },
      },
      borderRadius: {
        xl: "0.5rem",
        lg: "0.375rem",
        md: "var(--radius)",
        sm: "0.125rem",
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Text"',
          '"Segoe UI"',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          'sans-serif',
        ],
        mono: [
          '"SF Mono"',
          '"JetBrains Mono"',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },
      spacing: {
        'sidebar': '280px',
        'list': '320px',
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 0.15s ease-out",
        "progress-indeterminate": "progress-indeterminate 1.5s infinite linear",
      },
      keyframes: {
        "progress-indeterminate": {
          "0%": { transform: "translateX(-100%) scaleX(0.2)" },
          "50%": { transform: "translateX(0%) scaleX(0.5)" },
          "100%": { transform: "translateX(100%) scaleX(0.2)" },
        },
        "accordion-down": {
          from: { height: 0 },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: 0 },
        },
        "fade-in": {
          from: { opacity: 0 },
          to: { opacity: 1 },
        },
      },
    },
  },
  plugins: [require("tailwindcss-animate"), require("@tailwindcss/typography")],
}
