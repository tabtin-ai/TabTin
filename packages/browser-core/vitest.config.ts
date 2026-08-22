import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // browser-core 单测直接跑源码，避免 fresh worktree 中 workspace exports
      // 指向未预构建的 dist/index.js 或 dist/types.js。
      '@tabtin/security-policy': resolve(__dirname, '../security-policy/src/index.ts'),
      '@tabtin/agent-modes/types': resolve(__dirname, '../agent-modes/src/types.ts'),
      '@tabtin/agent-modes': resolve(__dirname, '../agent-modes/src/index.ts'),
      '@tabtin/crawl-contracts': resolve(__dirname, '../crawl-contracts/src/index.ts'),
    },
  },
})
