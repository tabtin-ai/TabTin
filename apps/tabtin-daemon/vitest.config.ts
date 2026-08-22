import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: true,
  },
  resolve: {
    alias: {
      '@tabtin/config': resolve(__dirname, '../../packages/tabtin-config/src/index.ts'),
      '@tabtin/checkpoint-core': resolve(__dirname, '../../packages/checkpoint-core/src/index.ts'),
      // @tabtin/shared 子路径直读 src——否则 vitest 经 exports 的 import 条件
      // 消费 dist，改 shared 源码不重建时单测测的是 stale 产物（同  病根）。
      '@tabtin/shared/sentry-scrub': resolve(__dirname, '../../packages/tabtin-shared/src/sentry-scrub.ts'),
      '@tabtin/shared/diagnostics-redact': resolve(__dirname, '../../packages/tabtin-shared/src/diagnostics-redact.ts'),
      '@tabtin/shared/storage-paths': resolve(__dirname, '../../packages/tabtin-shared/src/storage-paths.ts'),
    },
  },
})
