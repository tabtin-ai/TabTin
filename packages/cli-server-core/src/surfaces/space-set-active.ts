/**
 * space/set-active — 切换当前活跃的 Space 上下文。
 *
 * 将原 `ipc-registry.ts:324-362` 的 `space:setActive` handler 迁移。
 *
 * 逻辑：
 *   1. 解析 organizationRoot 或回退到平台工作区路径
 *      `{spacesRoot}/{organizationId}/spaces/{sp}/`（2026-05-04 重构后布局）
 *   2. 预建目录（让 Folder UI 检测到"Agent workspace exists"）
 *   3. 调 setCLISpaceContext 更新 CLI Server 全局状态
 *
 * 设计：工厂模式 `createSpaceSetActiveSurface(deps)`，把路径解析和
 * 全局状态设置抽成依赖接口，避免 surface 定义直接导入 Electron
 * 或 terminal-core 的模块。
 */

import { definePlatformSurface } from '../surface/define-platform-surface.js'

// ─── 依赖接口 ─────────────────────────────────────────────────────

/**
 * space:setActive 的外部依赖。
 *
 * 各函数由宿主在工厂调用时注入：
 *   - setCLISpaceContext: 更新 CLI Server 全局 Space 状态
 *   - resolveSpaceWorkspaceRoot: 从 spacesRoot + (wt, sp) 推导 workspace 路径
 *   - resolveSpacesRoot: 获取 workspace 父前缀
 *   - ensureDir: 递归创建目录（fs.mkdirSync(path, {recursive:true})）
 *   - logWarn: 日志输出（目录创建失败等非致命错误）
 */
export interface SpaceSetActiveDeps {
  setCLISpaceContext(
    spaceId: string | null,
    crawlspaceId?: string | null,
    organizationId?: string | null,
    resolvedRoot?: string | null,
  ): void
  resolveSpaceWorkspaceRoot(
    spacesRoot: string,
    organizationId: string | undefined,
    spaceId: string,
  ): string
  resolveSpacesRoot(): string
  ensureDir(path: string): void
  logWarn(message: string, error: unknown): void
}

// ─── 输入 / 输出类型 ──────────────────────────────────────────────

export interface SpaceSetActiveInput {
  spaceId: string | null
  crawlspaceId?: string | null
  organizationId?: string | null
  organizationRoot?: string | null
}

export interface SpaceSetActiveOutput {
  success: boolean
}

// ─── 工厂 ─────────────────────────────────────────────────────────

/**
 * 创建 space/set-active PlatformSurface。
 *
 * 调用时机：ipc-registry 或 Daemon 启动链路。
 */
export function createSpaceSetActiveSurface(deps: SpaceSetActiveDeps) {
  const spaceSetActive = definePlatformSurface({
    module: 'space',
    verb: 'set-active',
    kind: 'local',
    risk: 'write', // ：改 CLI Space 上下文，可能 ensureDir
    errorCodes: [] as const,
    bindings: { ipc: true, http: true },
    // 原 channel 名 `space:setActive`（camelCase）不符合 D-5 命名规则，
    // 用 alias 保持 renderer 调用方兼容——不需要改前端代码。
    aliases: ['space:setActive'],

    handler: async (
      input: SpaceSetActiveInput,
    ): Promise<SpaceSetActiveOutput> => {
      const params = input ?? { spaceId: null }

      // 解析工作区根路径——单根契约（docs/single-root-space-prd.md §2.2）下的
      // 真相单源约定：renderer 调用时**应当**始终把 `organizationRoot` 设成当前 Space
      // 绑定 Agent 的 `working_dir`（在 packages/app-shell `selectSpace` 已落实）。
      //
      // 当 Agent 没设 working_dir（organizationRoot 为 null）时回退到平台工作区
      // `{spacesRoot}/{organizationId}/spaces/{sp}/`，避免 runtime cwd 拿到 null 直接挂掉；
      // 这是兜底 Agent "半残"状态下的工作目录（`agent-working-dir-prd.md` §3）。
      let resolvedRoot = params.organizationRoot ?? null
      if (!resolvedRoot && params.spaceId) {
        try {
          resolvedRoot = deps.resolveSpaceWorkspaceRoot(
            deps.resolveSpacesRoot(),
            params.organizationId ?? undefined,
            params.spaceId,
          )
          // 预建目录：让 Folder UI 在下次刷新时检测到 workspace
          deps.ensureDir(resolvedRoot)
        } catch (err) {
          deps.logWarn(
            '[space:set-active] failed to ensure space workspace root:',
            err,
          )
        }
      }

      deps.setCLISpaceContext(
        params.spaceId,
        params.crawlspaceId,
        params.organizationId,
        resolvedRoot,
      )
      return { success: true }
    },
  })

  return { spaceSetActive }
}
