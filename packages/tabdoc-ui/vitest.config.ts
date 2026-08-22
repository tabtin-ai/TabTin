import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * 渐进式测试策略
 *
 * 配置源文件仅此 .ts；勿提交 vitest.config.js / .d.ts（见 packages/tabdoc-ui/.gitignore、README）。
 *
 * - 默认 `pnpm test` / CI：只跑未列入 DEBT 的用例（当前绿集 13 条）
 * - 修某条老债：从 DEBT_TEST_PATHS 删掉对应路径，跑通后再保留在默认集
 * - 单独啃老债：`pnpm test:debt`（不阻塞 CI）
 *
 * | 路径 | 卡点 | 解禁条件 |
 * |------|------|----------|
 * | offlineCache.test.ts | IndexedDB mock 不完整 | fake-indexeddb 或 vitest setup |
 * | editor-selectors/link-selector.test.ts | novel/react-tweet 拉入 .css | vitest css mock / 改导入边界 |
 */
const DEBT_TEST_PATHS = [
  'src/__tests__/offlineCache.test.ts',
  'src/__tests__/editor-selectors/**',
] as const

export default defineConfig({
  resolve: {
    alias: {
      '@tabtin/app-host-sdk': fileURLToPath(new URL('../app-host-sdk/src/index.ts', import.meta.url)),
      // 协作 slash 集成测需要 StarterKit，但不想经过 novel→react-tweet CSS
      '@tiptap/starter-kit': fileURLToPath(
        new URL('../../node_modules/.pnpm/@tiptap+starter-kit@2.27.2/node_modules/@tiptap/starter-kit/dist/index.js', import.meta.url),
      ),
      '@tiptap/suggestion': fileURLToPath(
        new URL('../../node_modules/.pnpm/@tiptap+suggestion@2.27.2_@tiptap+core@2.27.2_@tiptap+pm@2.27.2__@tiptap+pm@2.27.2/node_modules/@tiptap/suggestion/dist/index.js', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'src/**/__tests__/**/*.ts',
      'src/**/__tests__/**/*.tsx',
    ],
    exclude: ['dist/**', 'node_modules/**', ...DEBT_TEST_PATHS],
  },
})
