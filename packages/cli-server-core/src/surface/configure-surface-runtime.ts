/**
 * Surface 运行时上下文注入。
 *
 * 与 `@tabtin/cli-routes` 的 `configureCLIRoutes` 模式完全对齐：
 * 宿主（Electron / Daemon）在启动时调一次 `configureSurfaceRuntime`，
 * 之后所有 surface handler 通过 `getSurfaceContext()` 拿上下文。
 *
 * 为什么不直接复用 configureCLIRoutes 注入的 bindings？
 *   - configureCLIRoutes 注入的是 CLI routes 专用依赖（含 getActionExecutor
 *     等 surface 不关心的东西）
 *   - SurfaceContext 面向 surface handler，字段是 handler 真正需要的最小集
 *   - 两者各有自己的"未配置时抛错"守卫，职责清晰
 */

import type { SurfaceContext } from './types.js'

/** 模块级 singleton——宿主启动时写入一次 */
let _runtimeCtx: SurfaceContext | null = null

/**
 * 注入 surface 运行时上下文。宿主启动时调一次。
 *
 * 典型调用位置：
 *   - Electron: `apps/tabtin-electron/src/main/cli/cli-server.ts` 启动链路
 *   - Daemon:   `apps/tabtin-daemon/src/cli/cli-server.ts` 启动链路
 *
 * 多次调用合法（热重载场景），后者覆盖前者。
 */
export function configureSurfaceRuntime(ctx: SurfaceContext): void {
  _runtimeCtx = ctx
}

/**
 * 获取 surface 运行时上下文。
 *
 * 未配置时抛错——与 `cli-routes/host-bindings.ts:72-76` 的守卫模式
 * 一致。这保证"忘了在宿主启动时注入"能在第一次 surface 调用时
 * 立即暴露，而不是静默拿到 null 后在 handler 深处炸。
 */
export function getSurfaceContext(): SurfaceContext {
  if (!_runtimeCtx) {
    throw new Error(
      '[PlatformSurface] configureSurfaceRuntime() 必须在任何 surface handler 执行前调用。' +
      '请在宿主启动链路（cli-server.ts）中注入 SurfaceContext。',
    )
  }
  return _runtimeCtx
}

/**
 * 清空运行时上下文——仅供测试使用。
 */
export function _clearSurfaceRuntime(): void {
  _runtimeCtx = null
}
