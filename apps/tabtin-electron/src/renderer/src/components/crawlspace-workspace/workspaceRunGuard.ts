/**
 * Wave 3.2：CrawlspaceWorkspace 的 Run cleanup 守卫工厂
 *
 * # 业务目标
 *
 * `useRunManager` 的 effect cleanup 触发时（unmount / Activity hidden / 其他
 * 依赖飘移），调用方需要告诉 hook 「当前是不是仍要保活」。逻辑由这里集中：
 *
 *   保活 = spaceId 仍在 `useWorkbenchSceneStore.hotSceneIds`
 *          AND
 *          `useCrawlTabStore.crawlspaceConfigById[crawlspaceId]` 仍存在
 *
 * 任一不满足就让 hook 走 endRun，覆盖三类释放场景：
 *   - hot LRU 驱逐：spaceId 离开 hotSceneIds（其他 syncer 不关心 config）
 *   - 用户关 crawlspace：closeCrawlspace 删掉 config
 *   - 删 Space：onSpaceDeleted → purgeCrawlspaceData 删掉 config
 *
 * Activity hidden（仍 hot 仍 config）→ 双条件 true → 保活，配合 React 19.2
 * `<Activity>` 让 visible 时同 hook 实例的 ensureRun() 复用旧 runId。
 *
 * # 与 Wave 3.1 syncer 的协作链路
 *
 * 守卫**不**直接监听 hot 变化，是被组件 unmount 间接触发的。完整链路（hot
 * LRU 驱逐场景）：
 *
 *   user activate Space-D
 *     → useWorkbenchSceneStore.appendHotScene → slice(-3) 把 Space-A 挤出
 *     → hotSceneIds 变化广播
 *         ├─ crawlspaceHotSubscriptionSyncer 监听 → release subscription（Wave 3.1）
 *         └─ SpaceWorkbenchHost.hotSpaces 重算 → 不再渲染 Space-A 子树
 *             → CrawlspaceWorkspace unmount
 *             → useRunManager effect cleanup
 *             → 调本守卫 → 双条件 false → endRun（Wave 3.2）
 *
 * 两条路径是「hot 集合驱动业务侧资源生命周期」的两个层面：
 *   - 全局资源（IPC subscription）→ syncer push 模型
 *   - 实例资源（Run）→ hook pull 模型（hook 只能从自己的 cleanup 触发）
 *
 * # 为什么独立成一个 utility
 *
 * 把双条件查询提到独立 pure-ish 函数，是为了写**真正的黑盒测试**——直接 mock
 * 两个 store 的 getState 返回值，验证 4 种 (hot, config) 组合的输出。如果保留
 * 在 CrawlspaceWorkspace 内的 useCallback 闭包里，单测只能 mock 整个闭包返回
 * 值，无法守卫"双条件逻辑本身被改坏"的回归——比如未来有人去掉 config 检查，
 * Wave 3.2 的产品决策表第 1 条就被静默推翻。
 *
 * # 故意不订阅响应式 store 更新
 *
 * 守卫函数是**一次性查询**：cleanup 触发那一刻调用、看一眼、返回布尔值。所以
 * 用 `useStoreXxx.getState()` 直接拉最新值即可，不需要 subscribe。这也避免
 * 了把守卫闭包做成响应式带来的 stale closure 风险。
 */

import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import {
  useWorkbenchSceneStore,
  toWorkbenchSceneId,
} from '@stores/useWorkbenchSceneStore'

export interface WorkspaceRunGuardInput {
  /** 当前 crawlspace 所属的 spaceId（多对一映射的 space 维度） */
  spaceId: string | null | undefined
  /** 当前 crawlspace 的稳定 id */
  crawlspaceId: string
}

/**
 * 创建一个查询闭包：cleanup 触发时调用，true 表示保活、false 表示放手 endRun。
 *
 * 守卫闭包的"按需读取"语义：
 * - 不缓存任何中间值
 * - 每次调用都读 `useWorkbenchSceneStore.getState()` 与 `useCrawlTabStore.getState()`
 * - try/catch 兜底——store 抛异常视作"放手 endRun"，更安全（避免 Run 永远活）
 */
export function createWorkspaceRunGuard(
  input: WorkspaceRunGuardInput,
): () => boolean {
  const { spaceId, crawlspaceId } = input

  return () => {
    if (!spaceId) return false
    try {
      const sceneId = toWorkbenchSceneId(spaceId)
      const sceneState = useWorkbenchSceneStore.getState()
      if (!sceneState.hotSceneIds.includes(sceneId)) return false
      const config = useCrawlTabStore.getState().crawlspaceConfigById[crawlspaceId]
      return Boolean(config)
    } catch (err) {
      // 任何 store 抛异常时退守"放手 endRun" —— 比"留个孤儿 Run 永远活"更安全。
      console.warn('[workspaceRunGuard] store 查询异常，默认放手 endRun:', err)
      return false
    }
  }
}
