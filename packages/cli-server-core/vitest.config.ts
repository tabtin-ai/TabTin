import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: true,
  },
  resolve: {
    alias: {
      '@tabtin/cli-routes': resolve(__dirname, '../cli-routes/src/index.ts'),
      '@tabtin/agent-wire': resolve(__dirname, '../agent-wire/src/index.ts'),
    },
  },
})
