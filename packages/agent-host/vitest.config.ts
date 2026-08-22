import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    // Prefer package.json "exports.source" so workspace packages resolve to TS.
    conditions: ['source', 'import', 'module', 'default'],
    alias: {
      // 与 agent-runtime 同款：让 sharp / vi.mock 链路走 file-pipeline src。
      '@tabtin/file-pipeline': path.resolve(__dirname, '../file-pipeline/src/index.ts'),
    },
  },
  test: {
    include: [
      'src/**/__tests__/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    globals: true,
    server: {
      deps: {
        // sharp 是原生模块，不能被 vite 打包。
        external: ['sharp'],
      },
    },
  },
})
