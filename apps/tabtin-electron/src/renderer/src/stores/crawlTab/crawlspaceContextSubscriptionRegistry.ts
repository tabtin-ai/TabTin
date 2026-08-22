/**
 * Crawlspace Context Subscription Registry
 *
 * Module-level registry that owns the lifecycle of the per-crawlspace
 * `crawlspaceContextClient.subscribe(...)` calls.
 *
 * # 设计动机（Wave 3.1）
 *
 * 用户高频在 hot Space 之间切换。把订阅"持有者"提到 store 层带来两层收益：
 *
 * 1. **缩短同步链路（立即生效）**：
 *    之前主进程 snapshot 要走 `component effect listener → setSnapshotState
 *    → effect 4 合并 deferred → store.applyCrawlspaceContextSnapshot` 才到
 *    cache，跨多次 React 调度。现在 listener 直接写 store cache，单帧响应。
 *
 * 2. **支撑 Activity 模式（Wave 2c 落地后真正生效）**：
 *    `<Activity>` 会 unmount hidden 子树——届时 component effect 会真正
 *    cleanup 订阅，导致 hidden 期间 snapshot 被丢弃，切回需要 IPC round-trip
 *    （~50ms 延迟 + 闪烁）。store 层订阅在 hidden 期间持续接收推送，切回
 *    第一帧组件直接读 store 中的最新数据，零延迟、零闪烁。
 *
 *    短期上当下 SpaceWorkbenchHost 用 `display:none`（Wave 2c 之前），组件
 *    不 unmount → effect 不 cleanup → 订阅不会被组件层取消；本 Wave 主要
 *    收益是上面第 1 点。但当 LRU 驱逐发生 (`MAX_HOT_SCENES`)，组件确实
 *    会 unmount——那个场景下本 Wave 的"切回零闪烁"立即生效。
 *
 * 跨多 hot Space 时 IPC 总成本不变（crawlspaceContextClient 是单例 connection）。
 *
 * # 实现要点
 *
 * - subscription 是全局资源（IPC connection 是单例），用 module-private Map
 *   维护 `crawlspaceId → unsubscribe` 比 zustand state 更合适——unsubscribe
 *   函数本身不该序列化、不该触发 React 重渲染。
 * - listener 通过 `configureCrawlspaceContextSubscription(applier)` 注入，
 *   避免 registry → store 的循环 import。store 创建后立即注入即可。
 * - 同一 crawlspaceId 重复 ensure 是幂等的——已订阅则直接返回。
 * - 内置两道 race 防御：
 *   - `active` flag：release 后任何路径（含 in-flight `getContext` promise）
 *     都不再 invoke applier，防止幽灵 cache 写入。
 *   - `latestUpdatedAt`：迟到的旧 snapshot 不覆盖较新 cache。
 */

import {
  crawlspaceContextClient,
  type CrawlspaceContextSnapshot,
} from '../../crawlspace/electron/crawlspace-context-client'
import { createLogger } from '@/utils/logger'

const log = createLogger('CrawlspaceCtxSub')

type SnapshotApplier = (
  crawlspaceId: string,
  snapshot: CrawlspaceContextSnapshot,
) => void

interface SubscriptionEntry {
  unsubscribe: () => void
  /** false 后任何路径（包括 in-flight getContext promise）都不应再 invoke applier。 */
  active: boolean
  /** 已处理的最新 snapshot updatedAt——防止迟到 snapshot 覆盖较新 cache。 */
  latestUpdatedAt: number
}

const subscriptions = new Map<string, SubscriptionEntry>()
let applier: SnapshotApplier | null = null

/**
 * 已 warn 过 IPC 不可用的 csId 集合——用于把同 csId 的反复 warn 降级为
 * console.debug，避免日志噪音淹没（CrawlspaceWorkspace 重 mount + zustand
 * subscribe diff 期间 ensure 反复触发）。entry 写入 Map 后清掉对应记录。
 */
const warnedUnavailableCsIds = new Set<string>()

/**
 * 注入 snapshot applier。store 创建后调用一次即可。
 * 重复调用会覆盖旧 applier（用于 hot reload / 测试 reset）。
 */
export function configureCrawlspaceContextSubscription(
  fn: SnapshotApplier,
): void {
  applier = fn
}

/**
 * 确保给定 crawlspaceId 已订阅主进程 context。幂等。
 *
 * 调用时机：`ensureCrawlspaceContextCache(csId)` 时同步触发——业务实体一旦"应当
 * 显示"，订阅就持续到 close。
 *
 * 注意：`crawlspaceContextClient.subscribe` 内部会立即拉取一次完整 snapshot
 * 并 dispatch，所以 ensure 之后第一帧 store 就已经写入了最新数据。
 *
 * # Race 防御
 *
 * - `active` flag 防止"释放后 in-flight getContext promise 写回已删除 cache"——
 *   crawlspaceContextClient.subscribe 内部初始 getContext 走的不是
 *   listenersMap 路由（直接闭包持有 listener），unsubscribe 后该 promise
 *   仍可触达 listener。
 * - `latestUpdatedAt` 防止迟到 snapshot 覆盖较新 cache——多条 IPC 路径
 *   （changed / context-diff / 初始 getContext）顺序不保证。
 */
export function ensureCrawlspaceContextSubscription(crawlspaceId: string): void {
  if (subscriptions.has(crawlspaceId)) return

  const entry: SubscriptionEntry = {
    unsubscribe: () => {},
    active: true,
    latestUpdatedAt: 0,
  }

  const unsubscribeClient = crawlspaceContextClient.subscribe(crawlspaceId, snapshot => {
    if (!entry.active) return
    if (!snapshot || snapshot.crawlspaceId !== crawlspaceId) return
    if (!applier) {
      log.warn('snapshot dropped: applier not configured', { crawlspaceId })
      return
    }
    const updatedAt =
      typeof snapshot.updatedAt === 'number' && Number.isFinite(snapshot.updatedAt)
        ? snapshot.updatedAt
        : Date.now()
    // 去重契约：第一帧（latestUpdatedAt === 0）必须放行；之后只放行严格更新
    // 的 snapshot。用 `<=` 而不是 `<`，避免依赖 client 层的 `===` 去重——
    // 即使 client 改去重策略，registry 也保证同一 updatedAt 不重复 invoke applier。
    if (entry.latestUpdatedAt > 0 && updatedAt <= entry.latestUpdatedAt) return
    entry.latestUpdatedAt = updatedAt
    try {
      applier(crawlspaceId, snapshot)
    } catch (error) {
      // 隔离 applier 异常——不让单帧错误冒泡到 client.dispatchSnapshot.forEach
      // （会破坏同 IPC 推送下其他订阅者的 dispatch）。下一次 snapshot 仍能正常处理。
      log.error('applier threw, snapshot dropped', { crawlspaceId, error })
    }
  })

  // client 在 IPC 不可用时返回 null —— 不写入 subscriptions Map 让下一次 ensure
  // 重试。否则 has() 会永久短路，IPC 恢复后再 ensure 永远是"伪订阅"。
  if (!unsubscribeClient) {
    // 同 csId 反复触发 ensure（CrawlspaceWorkspace 重 mount 等场景）时，仅
    // 第一次 warn 提醒；后续降级为 debug 避免噪音。
    if (warnedUnavailableCsIds.has(crawlspaceId)) {
      log.debug('subscribe still failing (IPC unavailable)', { crawlspaceId })
    } else {
      warnedUnavailableCsIds.add(crawlspaceId)
      log.warn('subscribe failed (IPC unavailable), will retry on next ensure', { crawlspaceId })
    }
    return
  }

  entry.unsubscribe = unsubscribeClient
  subscriptions.set(crawlspaceId, entry)
  // IPC 恢复成功——清掉 warn 记录，下次再失败时重新 warn 一次。
  warnedUnavailableCsIds.delete(crawlspaceId)
}

/**
 * 释放给定 crawlspaceId 的订阅。
 *
 * 调用时机：`closeCrawlspace(csId)` / `purgeCrawlspaceData(csId)` 时——业务
 * 实体被销毁，不再需要订阅。先标 active=false 再 unsubscribe，确保 in-flight
 * promise 也无法 invoke applier。
 */
export function releaseCrawlspaceContextSubscription(crawlspaceId: string): void {
  const entry = subscriptions.get(crawlspaceId)
  if (!entry) return
  entry.active = false
  entry.unsubscribe()
  subscriptions.delete(crawlspaceId)
}

/**
 * 释放所有订阅（保留 applier 注入）。
 *
 * 调用时机：`clearAll()` 切账号 / 清 store 时——业务实体集合整体重置，
 * 但 applier 仍指向 store 单例，下一轮 ensureCrawlspaceContextCache 会
 * 再次填充 subscriptions。
 */
export function releaseAllCrawlspaceContextSubscriptions(): void {
  for (const entry of subscriptions.values()) {
    entry.active = false
    entry.unsubscribe()
  }
  subscriptions.clear()
}

/**
 * 测试用：彻底 reset（清订阅 + applier + warn 记录）。生产代码不应调用——
 * applier 一旦清掉，下次 ensureCrawlspaceContextSubscription 会静默丢弃 snapshot。
 */
export function resetCrawlspaceContextSubscriptionRegistry(): void {
  releaseAllCrawlspaceContextSubscriptions()
  applier = null
  warnedUnavailableCsIds.clear()
}

/**
 * 调试 / 测试用：检查 crawlspaceId 是否已订阅。
 */
export function hasCrawlspaceContextSubscription(crawlspaceId: string): boolean {
  return subscriptions.has(crawlspaceId)
}
