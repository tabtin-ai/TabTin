import tseslint from 'typescript-eslint';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import reactPlugin from 'eslint-plugin-react';
import tabtinPlugin from './eslint-rules/index.js';

export default tseslint.config(
  {
    files: ['**/*.ts', '**/*.tsx'],
  },
  ...tseslint.configs.recommended,
  {
    plugins: {
      'react-hooks': reactHooksPlugin,
      'react': reactPlugin,
      'tabtin': tabtinPlugin,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
      'prefer-const': 'warn',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react/no-unknown-property': 'off',
      // contract Wave 1-B：默认 off；只在 renderer/src 范围内开 error（见下方 override）。
      // 主进程 / preload / 测试代码里有大量历史 `catch {}`，需要专门 wave 配合迁移工具
      // 一起治理；本批次先把 renderer 端两个反模式收敛掉。
      'tabtin/no-empty-catch': 'off',
    },
  },
  //  网络请求收口护栏：禁直 fetch 拼业务 API URL → 走 apiService.request /
  // apiRequest / electronFetch（或 table-core 的 tableFetch 注入通道）。
  // 作用域 = 跑在 renderer（Chromium）环境、受 CORS 约束的代码：
  //   - renderer 进程：apps/tabtin-electron/src/renderer/src/**
  //   - 数据包 table-core 源码：packages/table-core/src/**（同样跑在 renderer/web）
  // 注意：跑在 Node / daemon 的包（agent-runtime / action-tools 等）不纳入 —— 其
  // fetch 不经 Chromium、不受 CORS，强行收口只会引入无谓 IPC 依赖。preload / main /
  // 其他 apps 不受此规则约束（已登记到主战场 §五遗留池，待后续 wave 一起治理）。
  {
    files: [
      'apps/tabtin-electron/src/renderer/src/**/*.{ts,tsx}',
      'packages/table-core/src/**/*.{ts,tsx}',
    ],
    rules: {
      'tabtin/no-direct-fetch-in-renderer': 'error',
    },
  },
  // contract Wave 1-B：renderer 端反模式收敛。
  //   禁空 catch 静默吞错 → 出口为 catch 上方写 `// fail-soft: <理由>` 注释
  // 范围限于 renderer 进程；preload / main / 其他 apps 不受此规则约束（已登记到
  // 主战场 §五遗留池，待后续 wave 配套迁移工具一起治理）。
  {
    files: ['apps/tabtin-electron/src/renderer/src/**/*.{ts,tsx}'],
    rules: {
      'tabtin/no-empty-catch': 'error',
      // 2026-05-05 react-virtual 死循环治理：MessageList 等 8 处 useVirtualizer
      // 因 inline getItemKey/estimateSize/getScrollElement 触发 "Maximum update
      // depth exceeded" 死循环（参考 TanStack/virtual#1092）。这条规则在 PR 阶段
      // 静态拦截 inline 反模式，避免回归。详见 eslint-rules/use-virtualizer-stable-callbacks.js。
      'tabtin/use-virtualizer-stable-callbacks': 'error',
      // 2026-05-07 Wave 5 DX 保障：在 React effect 内引导走 useScoped* 包装 hook
      // （`apps/tabtin-electron/src/renderer/src/hooks/spaceActivity/`），避免
      // hot-Space 子树未来被无意中引入 zombie effect（Space 隐藏后副作用仍在跑）。
      //
      // 严格度选 `warn`：
      //   1) 全仓裸用密度高（hot-Space 子树外尤甚），一上来 error 直接 break baseline
      //   2) 治理是分级的——本 Wave 只引入信号，迁移由后续 Wave 配合 codemod 推进
      //   3) 合理例外（譬如组件本身就是"全局 hotkey 注册器"）走 `// eslint-disable-next-line` 标注
      //
      // 未来收紧路径：hot-Space 子树（components/{chat, context-space, crawl,
      // crawlspace-workspace} + layout/SpaceWorkbenchHost* / SpaceChatRailHost*）
      // 升 error；其他范围保持 warn。详见 eslint-rules/prefer-scoped-activity-effects.js。
      'tabtin/prefer-scoped-activity-effects': 'warn',
    },
  },
  // chat store 领域化：禁止 import 已删除的扁平双轨路径
  {
    files: ['apps/tabtin-electron/src/renderer/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: [
              '**/stores/chat/handlers/**',
              '**/stores/chat/slices/**',
              '**/stores/chat/actions/**',
              '**/stores/chat/utils/**',
              '**/stores/chat/runtime/**',
            ],
            message: 'chat store 已领域化，请改用 stores/chat/{session,messages,stream,hitl,execution,...}/ 路径。',
          },
        ],
      }],
    },
  },
  // Electron UI primitive 收敛（2026-06 设计系统收敛）：业务组件优先从
  // `@components/ui` 导入 Button/Input/Dialog/Popover/Toast 等通用 primitive。
  // `@components/ui` 负责 re-export `@tabtin/smartsheet-ui` 并承载 renderer 专用
  // primitive（如 OverlayScrim）。这里先用 warn 暴露历史直连，后续按模块迁移后
  // 再收紧为 error。
  {
    files: ['apps/tabtin-electron/src/renderer/src/components/**/*.{ts,tsx}'],
    ignores: ['apps/tabtin-electron/src/renderer/src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['warn', {
        paths: [
          {
            name: '@tabtin/smartsheet-ui',
            message: '业务组件请优先从 @components/ui 导入通用 UI primitive；@components/ui 是 Electron 应用层统一入口。',
          },
        ],
      }],
    },
  },
  // 设计语言治理（2026-05-04 chat 设计统一波次）：把 chat 模块的「容器零彩色 +
  // 状态色 token 化」契约钉死。详见 eslint-rules/no-chat-design-violations.js。
  //
  // 范围：仅 chat 模块；warn 级别——不阻塞 CI，让 warning 数量作为治理进度仪表盘。
  // 漂移会先变成 warning 出现在 PR diff 里，触达 reviewer。
  {
    files: ['apps/tabtin-electron/src/renderer/src/components/chat/**/*.{ts,tsx}'],
    rules: {
      'tabtin/no-chat-design-violations': 'warn',
    },
  },
  // 设计系统 token 全域守门（2026-06 样式统一收敛 阶段0）：把 design-system.md
  // §2/§3/§4/§10 的高频 token 违规钉成 renderer 全域信号——禁用默认字号 / 像素字号 /
  // 违规透明度 /50 /70 / 硬编码 z-index / 浮层实底 bg-popover。详见
  // eslint-rules/no-design-system-violations.js。
  //
  // 范围：renderer/src 全域；warn 级别——不阻塞构建，warning 数量作为收敛进度仪表盘，
  // 新代码自然合规，历史违规随阶段 1-5 迁移清零。裸 button/input / 手写 modal 的收敛
  // 不由本规则承担（属组件替换，交由阶段迁移 + review）。
  {
    files: ['apps/tabtin-electron/src/renderer/src/**/*.{ts,tsx}'],
    rules: {
      'tabtin/no-design-system-violations': 'warn',
    },
  },
  // cli-routes path 契约（2026-05-20 djangoRequest 两端归一化）：
  // cli-routes 是 Electron / Daemon 两端 cli-server 共享的路由实现；两端
  // djangoRequest 内部都把 baseUrl 归一成带 /api 结尾再用 joinApiPath 拼接。
  // path 自带 /api 前缀会被自动剥并触发 dev warn（日志噪音 + Daemon serverUrl
  // 哪天真带 /api 后缀就会双前缀 404）。这条规则把"path 自带 /api"在 PR 阶段
  // 拦截掉。详见 eslint-rules/no-api-prefix-in-cli-routes.js。
  {
    files: ['packages/cli-routes/src/routes/**/*.ts'],
    rules: {
      'tabtin/no-api-prefix-in-cli-routes': 'error',
    },
  },
  // tabslide 复杂度治理（2026-06-10）：把圈复杂度（单函数分支数）与嵌套深度
  // 钉成治理信号。warn 级别——不阻塞 CI，warning 数量作为复杂度债务收敛进度的
  // 仪表盘，与 chat 设计规则同款思路。漂移会先以 warning 出现在 PR diff 里，
  // 触达 reviewer，后续可按需收紧或下放阈值。
  {
    files: ['packages/tabslide/**/*.{ts,tsx}'],
    rules: {
      complexity: ['warn', 15],
      'max-depth': ['warn', 4],
    },
  },
  // agent-runtime 复杂度治理：先沿用 tabslide 的 warning 口径，把生产源码的
  // 单函数分支数和嵌套深度纳入包级 lint 信号；测试文件不纳入复杂度统计。
  {
    files: ['packages/agent-runtime/src/**/*.{ts,tsx}'],
    ignores: [
      'packages/agent-runtime/src/**/__tests__/**/*.{ts,tsx}',
      'packages/agent-runtime/src/**/*.test.{ts,tsx}',
    ],
    rules: {
      complexity: ['warn', 15],
      'max-depth': ['warn', 4],
    },
  },
  // chat 组件复杂度治理：与 tabslide / agent-runtime 同口径，把单函数分支数与
  // 嵌套深度钉成 warn 信号；不阻塞 CI，warning 数量作为复杂度债务仪表盘。
  // 测试文件不纳入复杂度统计。
  {
    files: [
      'apps/tabtin-electron/src/renderer/src/components/chat/**/*.{ts,tsx}',
    ],
    ignores: [
      'apps/tabtin-electron/src/renderer/src/components/chat/**/__tests__/**/*.{ts,tsx}',
      'apps/tabtin-electron/src/renderer/src/components/chat/**/*.{test,spec}.{ts,tsx}',
    ],
    rules: {
      complexity: ['warn', 15],
      'max-depth': ['warn', 4],
    },
  },
  // daemon 复杂度治理：与 tabslide / agent-runtime / chat 同口径，把生产源码的
  // 单函数分支数和嵌套深度纳入包级 lint 信号；测试文件不纳入复杂度统计。
  {
    files: ['apps/tabtin-daemon/src/**/*.{ts,tsx}'],
    ignores: [
      'apps/tabtin-daemon/src/**/__tests__/**/*.{ts,tsx}',
      'apps/tabtin-daemon/src/**/*.{test,spec}.{ts,tsx}',
    ],
    rules: {
      complexity: ['warn', 15],
      'max-depth': ['warn', 4],
    },
  },
  {
    ignores: [
      '**/dist/**',
      // Wave 6.3 治理：smartsheet-ui / table-core 的 `pnpm test` 会 `tsc -p
      // tsconfig.test.json` 生成 `.test-dist/`（commonjs 形态），lint 走过去
      // 看到的是源码 transpile 后的中间产物——新增/编辑 src 文件触发 .test-dist
      // 重生 → lint 计数随测试运行次数上下漂移，污染 baseline 信号。跟 `dist/`
      // 同源，统一 ignore。
      '**/.test-dist/**',
      '**/node_modules/**',
      '**/.generated/**',
      '**/build/**',
      '**/.turbo/**',
      'open-source/**',
      // 本地/生成产物与宿主模块目录：根 lint 不应扫入（venv、静态收集物、鸿蒙 oh_modules 等）。
      'apps/tabtin_django/venv/**', // Python 虚拟环境（pip 装的 JS 工具自带 .ts 文件）
      'apps/tabtin_django/staticfiles/**', // collectstatic 收集的第三方静态资源
      'apps/tabtin-harmony/oh_modules/**', // 鸿蒙工程的 npm modules 等价目录
      'packages/table-kernel/**',
    ],
  },
  // LH2-X3 守门规则（2026-04-17）：
  //   `@tabtin/agent-runtime` 的根入口与 `/engine` 子入口都是 god-barrel，会副作用
  //   re-export `local-permission-handler.js` (node:crypto) / `session/storage.js`
  //   (node:fs) / `compact/micro-compact.js` (node:fs) 等 Node-only 模块。
  //   renderer / web / preload 等浏览器侧编译路径上**只能**：
  //     - 走更细粒度的 sub-export：`@tabtin/agent-runtime/agent-modes`、
  //       `@tabtin/agent-runtime/engine/types`（纯类型/字面量）；
  //     - 或者用 `import type`（esbuild 会 elide，不进 vite 模块图）。
  //   这条 lint 规则把"renderer 值导入 god-barrel"在 PR 阶段就拦截掉，避免回归
  //   到 LH2-X3 那种 `__vite-browser-external` 抹除 `node:*` → 命名导入找不到
  //   的 build 失败。
  {
    files: [
      'apps/tabtin-electron/src/renderer/**/*.{ts,tsx}',
      'apps/tabtin-electron/src/preload/**/*.{ts,tsx}',
      'apps/tabtin-web/**/*.{ts,tsx}',
      'apps/admindash/**/*.{ts,tsx}',
    ],
    rules: {
      // `allowTypeImports: true` 让 `import type { ... } from '@tabtin/agent-runtime/engine'`
      // 仍然合法（esbuild 会 elide，不进 vite 模块图）；只拦截值导入。
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [
          {
            name: '@tabtin/agent-runtime',
            message: '禁止在浏览器侧值导入 @tabtin/agent-runtime god-barrel（会拖入 node:crypto/node:fs 等 Node-only 模块）。改走 @tabtin/agent-runtime/agent-modes、@tabtin/agent-runtime/engine/types 等纯子路径，或使用 `import type`。详见 LH2-X3 修复说明。',
            allowTypeImports: true,
          },
          {
            name: '@tabtin/agent-runtime/engine',
            message: '禁止在浏览器侧值导入 @tabtin/agent-runtime/engine god-barrel（会拖入 local-permission-handler 的 node:crypto、session/storage 的 node:fs 等）。改走 @tabtin/agent-runtime/agent-modes、@tabtin/agent-runtime/engine/types 等纯子路径，或使用 `import type`。详见 LH2-X3 修复说明。',
            allowTypeImports: true,
          },
          {
            name: '@tabtin/agent-host',
            message: '禁止在浏览器侧值导入 @tabtin/agent-host 根入口（会拖入 Node-only 宿主实现）。改走明确的 browser-safe 子路径，或使用 `import type`。',
            allowTypeImports: true,
          },
          {
            name: '@tabtin/agent-host/delivery',
            message: '禁止在浏览器侧值导入 @tabtin/agent-host/delivery 聚合入口（会拖入文件 outbox 等 Node-only 实现）。改走 @tabtin/agent-host/delivery/usage-metadata-projection 等 browser-safe 子路径，或使用 `import type`。',
            allowTypeImports: true,
          },
        ],
      }],
    },
  },
);
