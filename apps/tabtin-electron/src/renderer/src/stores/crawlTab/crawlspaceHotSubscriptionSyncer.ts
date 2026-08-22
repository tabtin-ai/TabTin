/**
 * Hot 集合 → context 订阅释放同步器
 *
 * 设计动机（Wave 3.1 复核）：
 * 总控《产品决策》：「Run 在 hot Space "切走但仍 hot" 时不结束——只在 Space
 * 被 hot 集合驱逐或显式关闭时 endRun」。Wave 3.1 把 context 订阅提升到 store
 * 层后，"切走但仍 hot"（subscribe 保留）、"显式关闭"（closeCrawlspace 释放）
 * 已覆盖；唯独"hot 集合驱逐"的释放被遗漏——`useWorkbenchSceneStore` 的
 * `appendHotScene` 用 `slice(-MAX_HOT_SCENES)` 直接挤掉旧 sceneId，被驱逐的
 * Space 在 SpaceWorkbenchHost 中不再渲染，但 store 层订阅仍持续接收主进程
 * snapshot——CPU 永久浪费 + cache 无限累积。
 *
 * 本 syncer 监听 `useWorkbenchSceneStore.hotSceneIds` 变化，每次变化时
 * diff 出"上一帧 hot 但本帧不再 hot"的 spaceId，通过 `crawlspaceConfigById`
 * 找到对应 crawlspaceId 调 `releaseCrawlspaceContextSubscription`。
 *
 * # 释放策略：保留 cache 不清
 *
 * harness 决策：驱逐 = 释放订阅 + **保留 cache**。
 * - 只调 `releaseCrawlspaceContextSubscription`（仅释放 IPC 订阅 + 标 active=false）
 * - 不调 `closeCrawlspace` / `purgeCrawlspaceData`（保留 cache / seeds / config）
 * - 用户切回该 Space 时：CrawlspaceWorkspace 重挂载 → ensureCrawlspaceContextCache
 *   → ensureCrawlspaceContextSubscription 重建订阅 → 主进程立即推送首帧覆盖 cache
 *
 * 体感：切回瞬间显示驱逐前的旧 cache（可能稍陈旧但远好于空白），1 帧后被
 * 主进程最新 snapshot 覆盖。
 *
 * # 与已有释放路径的关系（幂等保证）
 *
 * 三条释放路径：
 * 1. `closeCrawlspace(csId)` —— 用户显式关闭
 * 2. `purgeCrawlspaceData(csId)` —— 业务实体被销毁
 * 3. 本 syncer —— hot 集合驱逐
 *
 * 三者可能重复触发（比如用户关闭一个 cs 同时该 cs 所属 spaceId 被驱逐）。
 * `releaseCrawlspaceContextSubscription` 内部 `if (!entry) return` 是天然幂等。
 *
 * # spaceId → crawlspaceId 多对一 + hot 期间 cs 增删的 race
 *
 * 一个 spaceId 可能对应多个 crawlspaceId（默认 + sessionName 各种 session）。
 * 驱逐 spaceId 时所有关联的 crawlspaceId 都需释放。
 *
 * 关键：syncer **不缓存** prev csId 集合。每次 listener 触发都用
 * `prevState.hotSceneIds` + 当前最新 `crawlspaceConfigById` 现算 prev csIds。
 *
 * 这样能 catch 到 hot 期间动态新增的 cs（典型场景：spaceId-A 已 hot，
 * 用户在 A 内创建一个 sessionName workspace 触发 ensureCrawlspaceContextCache
 * 建立 cs-a2 的订阅；hot 不变，syncer 不感知；当 spaceId-A 离开 hot 时，
 * prev 用最新 config 计算得 {cs-a1, cs-a2}，两者都被正确释放）。若缓存 prev
 * csId set，cs-a2 就会永久泄漏。
 *
 * # 性能（早退优化）
 *
 * `useWorkbenchSceneStore.appendHotScene` 在 sceneId 已在 hot 内时仍返回
 * 新数组（filter+push 重排），listener 触发但 spaceIds 集合不变。先比较
 * spaceIds set，相等就跳过 O(N) config 扫描——避免常态切换的无谓 CPU。
 */

import {
  useWorkbenchSceneStore,
  fromWorkbenchSceneId,
  type WorkbenchSceneId,
} from '../useWorkbenchSceneStore'
import { releaseCrawlspaceContextSubscription } from './crawlspaceContextSubscriptionRegistry'
import type { CrawlspaceConfig } from './types'

type GetCrawlspaceConfigById = () => Record<string, CrawlspaceConfig>

let installed = false
let unsubscribe: (() => void) | null = null
let getCrawlspaceConfigById: GetCrawlspaceConfigById | null = null

function collectHotSpaceIds(
  hotSceneIds: ReadonlyArray<WorkbenchSceneId>,
): Set<string> {
  const spaceIds = new Set<string>()
  for (const sceneId of hotSceneIds) {
    const spaceId = fromWorkbenchSceneId(sceneId)
    if (spaceId) spaceIds.add(spaceId)
  }
  return spaceIds
}

function computeHotCsIds(
  hotSpaceIds: ReadonlySet<string>,
  configs: Record<string, CrawlspaceConfig>,
): Set<string> {
  const result = new Set<string>()
  for (const config of Object.values(configs)) {
    if (config.spaceId && hotSpaceIds.has(config.spaceId)) {
      result.add(config.crawlspaceId)
    }
  }
  return result
}

function sameSpaceIdSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

function applyHotChange(
  prevSceneIds: ReadonlyArray<WorkbenchSceneId>,
  currSceneIds: ReadonlyArray<WorkbenchSceneId>,
): void {
  const prevHotSpaceIds = collectHotSpaceIds(prevSceneIds)
  const currHotSpaceIds = collectHotSpaceIds(currSceneIds)

  // 早退：sceneId 重排但 spaceIds 集合不变（典型场景：activateForegroundSpace
  // 把已 hot 的 sceneId 移到末尾），跳过 O(N) config 扫描。
  if (sameSpaceIdSet(prevHotSpaceIds, currHotSpaceIds)) return

  const configs = getCrawlspaceConfigById?.() ?? {}
  const prevHotCsIds = computeHotCsIds(prevHotSpaceIds, configs)
  const currHotCsIds = computeHotCsIds(currHotSpaceIds, configs)

  for (const csId of prevHotCsIds) {
    if (!currHotCsIds.has(csId)) {
      releaseCrawlspaceContextSubscription(csId)
    }
  }
}

/**
 * 启动 syncer。幂等——重复调用静默返回。
 * 在 useCrawlTabStore.ts module-level 调用一次即可。
 */
export function installCrawlspaceHotSubscriptionSyncer(
  getConfigs: GetCrawlspaceConfigById,
): void {
  if (installed) return
  installed = true
  getCrawlspaceConfigById = getConfigs

  unsubscribe = useWorkbenchSceneStore.subscribe((state, prevState) => {
    if (state.hotSceneIds === prevState.hotSceneIds) return
    applyHotChange(prevState.hotSceneIds, state.hotSceneIds)
  })
}

/**
 * 测试用：reset 内部状态 + 解除订阅。生产代码不应调用。
 */
export function __resetCrawlspaceHotSubscriptionSyncerForTests(): void {
  unsubscribe?.()
  unsubscribe = null
  getCrawlspaceConfigById = null
  installed = false
}
