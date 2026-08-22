import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    // Prefer package.json "exports.source" so workspace packages resolve to TS
    // without requiring a full monorepo build (Wave 3 worktree hydrate / tool-error-ssot identity path).
    conditions: ['source', 'import', 'module', 'default'],
    alias: {
      '@tabtin/config': path.resolve(__dirname, '../tabtin-config/src/index.ts'),
      '@tabtin/anti-detect': path.resolve(__dirname, '../anti-detect/src/index.ts'),
      '@tabtin/crawl-integration': path.resolve(__dirname, '../crawl-integration/src/index.ts'),
      '@tabtin/agent-wire': path.resolve(__dirname, '../agent-wire/src/index.ts'),

      // W4 (2026-05-13)：让 vitest 加载 file-pipeline 的 src 而非 dist，让
      // `vi.mock('@tabtin/local-docparse')` 在 file-pipeline → local-docparse
      // 这条跨包 import 链路上能 hoist 拦截到。dist 路径（pnpm symlink）下
      // vitest module graph 不会重新 transform .js，hoist 失效。
      '@tabtin/file-pipeline': path.resolve(__dirname, '../file-pipeline/src/index.ts'),
      '@tabtin/file-pipeline-errors': path.resolve(__dirname, '../file-pipeline-errors/src/index.ts'),
      '@tabtin/tool-errors': path.resolve(__dirname, '../tool-errors/src/index.ts'),
      '@tabtin/local-docparse': path.resolve(__dirname, '../local-docparse/src/index.ts'),
      '@tabtin/lsp-runtime': path.resolve(__dirname, '../lsp-runtime/src/index.ts'),
      // tool-error-ssot.contract.test.ts：identity 断言需解析到 src（无 dist 也可跑）。
      '@tabtin/action-tools/errors': path.resolve(__dirname, '../action-tools/src/errors/public.ts'),
      '@tabtin/action-tools/headless': path.resolve(__dirname, '../action-tools/src/headless.ts'),
      '@tabtin/action-tools/tools': path.resolve(__dirname, '../action-tools/src/tools/public.ts'),
      '@tabtin/action-tools': path.resolve(__dirname, '../action-tools/src/index.ts'),
      '@tabtin/browser-core': path.resolve(__dirname, '../browser-core/src/index.ts'),
      '@tabtin/security-policy': path.resolve(__dirname, '../security-policy/src/index.ts'),
      '@tabtin/os-errors': path.resolve(__dirname, '../os-errors/src/index.ts'),
      '@tabtin/safe-fs': path.resolve(__dirname, '../safe-fs/src/index.ts'),
      // 终端假运行根治 v3 P1-1：`terminal-state-relay-nak-seam.test.ts` 端到端接缝
      // 要验证 WS client 的 `*.nak→ok:false` 修复。解析到 dist 会用上一次构建（可能
      // 滞后于本次 src 改动）→ 假绿/假红；指向 src 让接缝测试始终跑当前源码。
      // 此别名只影响该接缝测试——agent-runtime/src 自身不 import 此包（已核）。
      '@tabtin/ws-gateway-client': path.resolve(__dirname, '../ws-gateway-client/src/index.ts'),
      '@tabtin/terminal-core': path.resolve(__dirname, '../terminal-core/src/index.ts'),
      '@tabtin/agent-modes': path.resolve(__dirname, '../agent-modes/src/index.ts'),
      '@tabtin/shared/storage-paths': path.resolve(__dirname, '../tabtin-shared/src/storage-paths.ts'),
      '@tabtin/shared': path.resolve(__dirname, '../tabtin-shared/src/index.ts'),
      '@tabtin/env-sanitize': path.resolve(__dirname, '../env-sanitize/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    globals: true,
  },
});
