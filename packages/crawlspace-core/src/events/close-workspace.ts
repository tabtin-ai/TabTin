/**
 * close-workspace —— 跨 Space"关闭某个 crawlspace"的统一入口。
 *
 * # 设计动机（Wave 3.3）
 *
 * 用户在 Space A 操作"关闭 Space B"时，无论 Space B 当前是不是 visible，
 * 应该立即生效。原本 listener 在 `CrawlspaceShell` 的 `useEffect` 里注册
 * （Set 多 listener 模型），Wave 2c 落地后 `<Activity hidden>` 让整棵 Shell
 * 子树 effect 走 cleanup → listener 退订 → close 请求**丢失**。
 *
 * 本模块改成 module-level **single handler 注入**模型——跟 Wave 3.1 的
 * `crawlspaceContextSubscriptionRegistry`（applier 注入）风格对齐：
 *
 * - handler 由 store 层在 store 创建后注入，与 React 组件生命周期解耦
 * - close 请求按 `crawlspaceId` 路由到 `useCrawlTabStore.closeCrawlspace(...)`，
 *   store 是全局 state，hot/hidden/cold/已 unmount 各形态下都能正确处理
 * - 不再需要"per-cs 各注册一份 listener"——close 是低频事件，全局单 handler
 *   足够；多 listener 反而让"谁负责哪个 cs"的归属语义模糊
 *
 * # 跟 Wave 3.1 / Wave 3.2 的协同
 *
 * - Wave 3.1：context subscribe 已经在 store 层（驱逐时同步 release）
 * - Wave 3.2：useRunManager 通过 `shouldKeepRunOnCleanup` 守卫识别"hidden vs
 *   真销毁"，真销毁路径仍走 endRun
 * - Wave 3.3（本模块）：close 请求 → handler → store.closeCrawlspace → set 删
 *   config → SpaceWorkbenchHost 不再渲染该 Space → CrawlspaceWorkspace 真
 *   unmount → useRunManager 守卫返 false → endRun 完成闭环
 *
 * # 失败路径
 *
 * - handler 未注入（应用未完成 store 初始化）→ requestCloseWorkspace 返 false，
 *   调用方负责 fallback（典型：直接调 store.closeCrawlspace）。生产路径下
 *   handler 在 useCrawlTabStore 模块加载时立即注入，所以这条 fallback 主要
 *   用于 SSR / 测试环境。
 * - handler 同步抛错 / Promise 拒绝 → 仅 console.warn，不冒泡（避免一个 cs
 *   的 close 失败拖垮整个事件总线；调用方收到的是 `true`，因为 handler 已
 *   被分派）。
 */

export type CloseWorkspaceRequest = {
  crawlspaceId: string
  reason?: string
}

export type CloseWorkspaceHandler = (
  request: CloseWorkspaceRequest,
) => void | Promise<void>

let handler: CloseWorkspaceHandler | null = null

/**
 * 注入 close handler。store 创建后调用一次即可。
 *
 * 重复调用会覆盖旧 handler（用于 HMR / 测试 reset）。
 * 传 `null` 显式清除（用于切账号 / shutdown 场景）。
 */
export function setCloseWorkspaceHandler(
  fn: CloseWorkspaceHandler | null,
): void {
  handler = fn
}

/**
 * 派发 close 请求。
 *
 * 返回值语义：
 * - `true`：handler 已分派（不代表关闭已完成——handler 是 async）。调用方可
 *   信赖 store 层会异步完成清理。
 * - `false`：handler 未注入或 crawlspaceId 缺失。调用方需要 fallback（典型：
 *   直接调 store.closeCrawlspace）以避免请求丢失。
 *
 * handler 同步异常或 Promise 拒绝会被 swallow（仅 warn）——单 cs 失败不应
 * 拖垮事件总线，调用方仍认为请求被处理。
 */
export function requestCloseWorkspace(request: CloseWorkspaceRequest): boolean {
  if (!request?.crawlspaceId) {
    return false
  }
  if (!handler) {
    return false
  }
  try {
    const result = handler(request)
    if (result && typeof (result as Promise<void>).then === 'function') {
      ;(result as Promise<void>).catch(error => {
        console.warn(
          '[close-workspace] handler 异步异常（忽略）:',
          { crawlspaceId: request.crawlspaceId, reason: request.reason, error },
        )
      })
    }
  } catch (error) {
    console.warn(
      '[close-workspace] handler 同步抛错（忽略，仍视为已分派）:',
      { crawlspaceId: request.crawlspaceId, reason: request.reason, error },
    )
  }
  return true
}

/**
 * 测试用：检查 handler 是否已注入。生产代码不应调用。
 */
export function hasCloseWorkspaceHandler(): boolean {
  return handler !== null
}
