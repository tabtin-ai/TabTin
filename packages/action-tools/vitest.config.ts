import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Prefer package.json "exports.source" so workspace packages resolve to TS
    // without requiring a full monorepo build (Wave 3 worktree hydrate).
    conditions: ['source', 'import', 'module', 'default'],
    alias: {
      '@tabtin/terminal-core': path.resolve(__dirname, '../terminal-core/src/index.ts'),
      '@tabtin/browser-core': path.resolve(__dirname, '../browser-core/src/index.ts'),
      '@tabtin/os-errors': path.resolve(__dirname, '../os-errors/src/index.ts'),
      '@tabtin/safe-fs': path.resolve(__dirname, '../safe-fs/src/index.ts'),
      '@tabtin/shared/storage-paths': path.resolve(__dirname, '../tabtin-shared/src/storage-paths.ts'),
      '@tabtin/shared': path.resolve(__dirname, '../tabtin-shared/src/index.ts'),
      '@tabtin/env-sanitize': path.resolve(__dirname, '../env-sanitize/src/index.ts'),
    },
  },
  test: {
    globals: true,
    include: [
      'src/**/__tests__/**/*.test.ts',
      // verify-tsup-externals 等 build-tooling 脚本的测试
      'scripts/__tests__/**/*.test.{ts,mjs}',
    ],
  },
})
