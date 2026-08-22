import { existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

const localPackages = resolve(__dirname, '../../packages')

function resolvePackagesRoot(): string {
  if (existsSync(resolve(localPackages, 'smartsheet-ui/node_modules'))) {
    return localPackages
  }
  try {
    const gitFile = readFileSync(resolve(__dirname, '../../.git'), 'utf8')
    const match = gitFile.match(/^gitdir:\s*(.+)$/m)
    const gitDir = match?.[1]?.trim()
    if (!gitDir) return localPackages
    const mainGit = gitDir.replace(/\/worktrees\/[^/]+$/, '')
    const mainPackages = resolve(mainGit, '../packages')
    if (existsSync(resolve(mainPackages, 'smartsheet-ui/node_modules'))) {
      return mainPackages
    }
  } catch {
    // 普通 checkout：继续用本仓库 packages
  }
  return localPackages
}

const packagesRoot = resolvePackagesRoot()

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'src/**/*.spec.ts',
      'src/**/*.spec.tsx',
      'scripts/**/*.test.ts',
    ],
    setupFiles: ['src/__tests__/setup.ts'],
    // 单库 dev 整理把连接端口集中到仓库根 `.env`，但 vitest 的 envDir 是本包，
    // 读不到根 `.env`；`@tabtin/config` 的 `readEnv()` 会回退 `process.env`，故在此给
    // 测试一个合法 API base（单库 dev 默认 6060；单测不打真实后端，仅满足配置校验）。
    env: {
      TABTIN_API_BASE_URL: 'http://127.0.0.1:6060/api',
      VITE_API_BASE_URL: 'http://127.0.0.1:6060/api',
    },
  },
  resolve: {
    alias: {
      '@tabtin/checkpoint-core': resolve(packagesRoot, 'checkpoint-core/src/index.ts'),
      '@tabtin/pty-core': resolve(packagesRoot, 'pty-core/src/index.ts'),
      // Wave 3.2：直跑 src，避免改了 packages/crawlspace-core 但忘 build 时
      // 测试拿的是 stale dist。
      '@tabtin/crawlspace-core': resolve(packagesRoot, 'crawlspace-core/src/index.ts'),
      // Wave 4a：smartsheet-ui 的 main 指向 dist/index.cjs，未 build 时跑 store 测试会
      // 在 useAuthStore.ts:10 触发 packageEntryFailure。直跑 src 让 store 测试不依赖
      // pre-build 产物（同 crawlspace-core 等的处理模式）。
      // toast-native / message-native：shim 内部引用；测试直跑 src。
      '@tabtin/smartsheet-ui/toast-native': resolve(packagesRoot, 'smartsheet-ui/src/toast.ts'),
      '@tabtin/smartsheet-ui/message-native': resolve(packagesRoot, 'smartsheet-ui/src/message.ts'),
      '@tabtin/smartsheet-ui/toast': resolve(packagesRoot, 'smartsheet-ui/src/toast.ts'),
      '@tabtin/smartsheet-ui/message': resolve(packagesRoot, 'smartsheet-ui/src/message.ts'),
      '@tabtin/smartsheet-ui/i18n': resolve(packagesRoot, 'smartsheet-ui/src/i18n.ts'),
      '@tabtin/smartsheet-ui': resolve(packagesRoot, 'smartsheet-ui/src/index.ts'),
      '@tabtin/storage-manager': resolve(packagesRoot, 'storage-manager/src/index.ts'),
      '@tabtin/oss-client': resolve(packagesRoot, 'oss-client/src/index.ts'),
      '@tabtin/app-shell/agent-config-v2': resolve(packagesRoot, 'app-shell/src/utils/agent-config-v2.ts'),
      '@tabtin/app-shell': resolve(packagesRoot, 'app-shell/src/index.ts'),
      '@tabtin/tabdoc-ui/api-client': resolve(packagesRoot, 'tabdoc-ui/src/api-client.ts'),
      '@tabtin/tabdoc-ui/find-request': resolve(packagesRoot, 'tabdoc-ui/src/docFindRequest.ts'),
      '@tabtin/tabdoc-ui/rehype-sanitize-schema': resolve(packagesRoot, 'tabdoc-ui/src/rehypeSanitizeSchema.ts'),
      '@tabtin/tabdoc-ui/use-doc-editor': resolve(packagesRoot, 'tabdoc-ui/src/useDocEditor.ts'),
      '@tabtin/tabdoc-ui/use-doc-list': resolve(packagesRoot, 'tabdoc-ui/src/useDocList.ts'),
      '@tabtin/tabdoc-ui/use-collaborative-doc-editor': resolve(packagesRoot, 'tabdoc-ui/src/useCollaborativeDocEditor.ts'),
      '@tabtin/tabdoc-ui/editor': resolve(packagesRoot, 'tabdoc-ui/src/editor/index.ts'),
      '@tabtin/tabdoc-ui/ports': resolve(packagesRoot, 'tabdoc-ui/src/ports.ts'),
      '@tabtin/tabdoc-ui': resolve(packagesRoot, 'tabdoc-ui/src/index.ts'),
      '@tabtin/table-core': resolve(packagesRoot, 'table-core/src/index.ts'),
      '@tabtin/table-engine/collab': resolve(packagesRoot, 'table-engine/src/collab/index.ts'),
      '@tabtin/table-engine/sync': resolve(packagesRoot, 'table-engine/src/sync/index.ts'),
      '@tabtin/table-engine': resolve(packagesRoot, 'table-engine/src/index.ts'),
      '@tabtin/table-ui/clipboard': resolve(packagesRoot, 'table-ui/src/controller/useDataGridClipboard.ts'),
      '@tabtin/table-ui': resolve(packagesRoot, 'table-ui/src/index.ts'),
      '@tabtin/table-host-runtime': resolve(packagesRoot, 'table-host-runtime/src/index.ts'),
      // Wave 4a：widget-tokens 同样未 build，RichWidget.test.tsx 在 Wave 4.6 一组用例
      // 里 dynamic import 它的 WIDGET_CSP / themeBundle 进行字面对齐——直跑 src。
      '@tabtin/widget-tokens': resolve(packagesRoot, 'widget-tokens/src/index.ts'),
      '@': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@components': resolve(__dirname, 'src/renderer/src/components'),
      '@stores': resolve(__dirname, 'src/renderer/src/stores'),
      '@services': resolve(__dirname, 'src/renderer/src/services'),
      '@hooks': resolve(__dirname, 'src/renderer/src/hooks'),
      '@utils': resolve(__dirname, 'src/renderer/src/utils'),
      '@types': resolve(__dirname, 'src/renderer/src/types'),
      // App 平台 H1 / Wave B-B2：marketplace App 物料根目录别名（与 electron.vite.config.ts 同步）
      '@apps-marketplace': resolve(packagesRoot, 'apps'),
      // App 平台 H1 / Wave B-B2：跨包 chat-client 引用（marketplace App 物料下不能走 node_modules 解析）
      '@tabtin/chat-client': resolve(packagesRoot, 'tabtin-chat-client/src/index.ts'),
      '@tabtin/smartsheet-adapter-electron/renderer': resolve(
        __dirname,
        '../../packages/smartsheet-adapter-electron/src/api-adapter.ts'
      ),
      // W4a 三轮 C-P0-4：integration test 真复用 proxy-provider SSE 解析路径
      // agent-prompt dist 再导出 leaf 子路径；vitest 不走 package exports 时需直指源码。
      '@tabtin/agent-runtime/engine/user-context-wrapper': resolve(
        __dirname,
        '../../packages/agent-runtime/src/engine/context/user-context-wrapper.ts'
      ),
      '@tabtin/agent-runtime/plugins': resolve(
        __dirname,
        '../../packages/agent-runtime/src/plugins/index.ts'
      ),
      '@tabtin/agent-runtime/providers/proxy-provider': resolve(
        __dirname,
        '../../packages/agent-runtime/src/providers/proxy-provider.ts'
      ),
      '@tabtin/agent-runtime/official-plugins': resolve(
        __dirname,
        '../../packages/agent-runtime/src/official-plugins/index.ts'
      ),
      // todoTimeline 直接复用 runtime 状态机；测试必须读取当前源码，避免 ignored dist
      // 未重建时把新增状态误判成非法输入。
      '@tabtin/agent-runtime/todo': resolve(
        __dirname,
        '../../packages/agent-runtime/src/todo/todo-state-machine.ts'
      ),
      '@tabtin/agent-host/tools': resolve(localPackages, 'agent-host/src/tools/index.ts'),
      // 精确子路径必须放在 delivery 聚合入口之前；Vite 的字符串 alias 会把
      // ``@tabtin/agent-host/delivery/*`` 继续拼到 ``index.ts`` 后面而解析失败。
      '@tabtin/agent-host/delivery/usage-metadata-projection': resolve(
        localPackages,
        'agent-host/src/delivery/usage-metadata-projection.ts'
      ),
      '@tabtin/agent-host/delivery': resolve(localPackages, 'agent-host/src/delivery/index.ts'),
      // Browser route focused tests 在 fresh linked worktree 中不应依赖 workspace
      // packages 的预构建 dist；这里按实际 route import 链直跑源码入口。
      '@tabtin/ws-gateway-client': resolve(packagesRoot, 'ws-gateway-client/src/index.ts'),
      '@tabtin/local-embedding': resolve(packagesRoot, 'local-embedding/src/index.ts'),
      '@tabtin/agent-wire': resolve(packagesRoot, 'agent-wire/src/index.ts'),
      '@tabtin/contracts/agent': resolve(packagesRoot, 'contracts/src/agent/index.ts'),
      '@tabtin/agent-orb': resolve(packagesRoot, 'agent-orb/src/index.ts'),
      '@tabtin/cli-server-core/surfaces': resolve(packagesRoot, 'cli-server-core/src/surfaces'),
      '@tabtin/cli-server-core': resolve(packagesRoot, 'cli-server-core/src/index.ts'),
      '@tabtin/action-tools/impl': resolve(packagesRoot, 'action-tools/src/impl/public.ts'),
      '@tabtin/browser-core/url-policy': resolve(packagesRoot, 'browser-core/src/url-policy/index.ts'),
      '@tabtin/browser-core': resolve(packagesRoot, 'browser-core/src/index.ts'),
      '@tabtin/security-policy/approval-contract': resolve(
        packagesRoot,
        'security-policy/src/approval-contract.ts'
      ),
      '@tabtin/security-policy': resolve(packagesRoot, 'security-policy/src/index.ts'),
      '@tabtin/agent-modes/types': resolve(packagesRoot, 'agent-modes/src/types.ts'),
      '@tabtin/agent-modes': resolve(packagesRoot, 'agent-modes/src/index.ts'),
      '@tabtin/crawl-contracts': resolve(packagesRoot, 'crawl-contracts/src/index.ts'),
      '@tabtin/api-client': resolve(packagesRoot, 'api-client/src/index.ts'),
      '@tabtin/config': resolve(packagesRoot, 'tabtin-config/src/index.ts'),
      '@tabtin/markdown-resource-autolink': resolve(packagesRoot, 'markdown-resource-autolink/src/index.ts'),
      '@tabtin/terminal-core': resolve(packagesRoot, 'terminal-core/src/index.ts'),
      '@tabtin/env-sanitize': resolve(packagesRoot, 'env-sanitize/src/index.ts'),
      '@tabtin/shared/use-countdown': resolve(packagesRoot, 'tabtin-shared/src/use-countdown.ts'),
      '@tabtin/shared/use-caps-lock-warning': resolve(packagesRoot, 'tabtin-shared/src/use-caps-lock-warning.ts'),
      '@tabtin/shared/storage-paths': resolve(packagesRoot, 'tabtin-shared/src/storage-paths.ts'),
      '@tabtin/shared/identity-avatar': resolve(packagesRoot, 'tabtin-shared/src/identity-avatar.ts'),
      '@tabtin/shared/diagnostics-redact': resolve(packagesRoot, 'tabtin-shared/src/diagnostics-redact.ts'),
      '@tabtin/shared/sentry-scrub': resolve(packagesRoot, 'tabtin-shared/src/sentry-scrub.ts'),
      '@tabtin/shared': resolve(packagesRoot, 'tabtin-shared/src/index.ts'),
    },
  },
})
