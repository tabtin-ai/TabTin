# @tabtin/tabdoc-ui

TabDoc 共享 React 宿主上下文包。

当前提供：

- `AppHostClientProvider`
- `useAppHostClient`
- `TabDocHostActionsProvider`
- `useTabDocHostActions`
- `TabDocTableEmbedRuntimeProvider`
- `useTabDocTableEmbedRuntime`
- `api-client`
- `useDocList`
- `useDocEditor`
- 版本历史由共享的 `@tabtin/collab-core` `VersionPanel` 提供
- `sanitizeSchema`

目标是让 Electron / Web 的 TabDoc panel 组件树围绕同一套 host contract 组织，而不是继续各自维护一份本地 context。

## 本地开发与测试

### 配置文件：只认 `vitest.config.ts`

Vitest / CI 都直接读 **`vitest.config.ts`**。`tsconfig.json` 的 `include` 只有 `src/**/*`，**不会**在 `pnpm build` 时编译根目录配置。

若工作区里突然出现（多为 IDE 保存或误跑 `tsc`）：

- `vitest.config.js`
- `vitest.config.d.ts` / `vitest.config.d.ts.map`

它们是**本地编译产物，不是功能改动**，已在 `.gitignore` 忽略。删掉即可：

```bash
rm -f vitest.config.js vitest.config.d.ts vitest.config.d.ts.map
```

### 跑测试前要有的 `dist/`

`@tabtin/tabdoc-ui` 依赖若干 workspace 包的 **已构建 `dist/`**（例如 `collab-core` → 先要 `@tabtin/config`）。本地若只改了 `tabdoc-ui` 却报 `Cannot find module '@tabtin/config'`，先构建依赖链：

```bash
# 与 CI（tabdoc-ui-unit.yml）一致：按拓扑构建全部 workspace 依赖
pnpm --filter "@tabtin/tabdoc-ui^..." build

pnpm --filter @tabtin/tabdoc-ui test      # 默认绿集（排除 DEBT）
pnpm --filter @tabtin/tabdoc-ui test:debt # 单独啃老债用例
```

### 测试分层（DEBT）

见 `vitest.config.ts` 顶部注释：`offlineCache`、`editor-selectors` 暂不进默认 CI，修通后从 `DEBT_TEST_PATHS` 移除。
