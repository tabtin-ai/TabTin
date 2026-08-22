/**
 * Cookie Sync Service —— Wave 2b 任务 E。
 *
 * @mode electron-only
 *
 * ## 模式限制（Wave 2b 真·收尾补丁 P2-新-2 文档化）
 *
 * 本服务依赖 Electron 的 `session.fromPartition(...).cookies.on('changed', ...)`
 * 监听 cookie 变更——这是 Electron / Chromium 特有 API。**Daemon 模式
 * （`apps/tabtin-daemon`）运行在纯 Node.js 环境，没有 Electron session**，
 * 因此 Daemon 模式下**不启用**本服务。
 *
 * 用户感知：Daemon 模式下 "跨 Space 共享登录态" 不工作。V2 规划路径参考 PRD
 * §十三（V1 已知限制）。
 *
 * ## 它做什么
 *
 * 把"属于同一登录环境"的多个 Electron partition 的 Cookie 保持一致：
 * 用户在 Space A 的 TabWeb 里登录 github.com，其他共享同一 BrowserEnvironment
 * 的 Space 打开 github.com 时就已经是登录态。
 *
 * 实现方式：对每个被监听的 partition 订阅 ``session.cookies.on('changed')``，
 * 当 cookie 变更时，把这次变更反向写到同环境下其他所有 partition 的 session 里。
 *
 * ## 设计决策（每一条都是折衷 — 请在改之前先理解）
 *
 * 1. **按 target partition 计数的细粒度防环** ——
 *    - 同步写入期间（``cookies.set`` / ``cookies.remove``）Chromium 会在目标
 *      partition 触发 ``changed`` 事件，如果不防环就会 B→A、A→B 循环。
 *    - 用 ``syncingTargets: Map<partition, count>`` 记录 "此刻正被 flushBatch
 *      写入的目标 partition"。handler 只在**自己所在的 partition 位于
 *      syncingTargets**时 drop 事件——这是回流事件必然携带的标志。
 *    - 为什么不是全局 boolean / 全局 count：三视角 review 发现 **源 partition
 *      自己**在 flushBatch 执行期间若又发生 cookie 变化（比如登录流程陆续
 *      写 5 次 Set-Cookie，debounce 窗口刚过第一批正在 flush 时，第 6 个
 *      Set-Cookie 抵达），全局防环会连源 partition 的新写入一起吞掉，导致
 *      这次变化**永久丢失**（既不在 pending 里，下次 flush 也无从得知）。
 *      细粒度方案只屏蔽 "目标 partition 回流" 这个必要场景，源 partition
 *      的新写入照常进 pending，下一次 debounce 刷新被带走。
 *    - 用 Map<partition, count> 而非 Set：同一 target 可能被多个 env 的
 *      flushBatch 并发写入（只要它出现在多个 env 的集合里，这在旧 partition
 *      迁移窗口期或误配置时可能出现），count>0 才意味着 "有人正在同步到它"。
 *
 * 2. **per-partition debounce 300ms** ——
 *    - 页面加载 / 登录流程一次会写入 5 ~ 30 条 cookie；不 debounce 会让同步
 *      变成"逐条串行写"导致每条都有 RTT 放大。
 *    - debounce 用 ``pending`` Map 按 ``(domain, path, name)`` 去重，保证
 *      "同一 cookie 在窗口内多次变化"只同步一次到最新值。
 *    - 窗口 300ms 的来源：Electron Chromium cookie commit 批次 ~50-200ms；
 *      300ms 覆盖绝大部分连续变更，又不会让用户"登录一处 1 秒后才在别处生效"
 *      变成可感的 UX 延迟（P99 <350ms）。
 *
 * 3. **每次 ``browser-env:changed`` 全量 rebuild ``partitionsByEnv``** ——
 *    - Wave 2a 的 ``BrowserEnvChangePayload`` 不带 ``previousEnvironmentId``，
 *      做精准 diff 需要额外在本服务维护镜像态。
 *    - 规模：一个用户典型有 <=5 个环境 + <=50 个 Space = <=55 个 partition 监听。
 *      全量 rebuild = 1 次 ``listEnvironmentsSync`` + 1 次 ``listBindingsSync``
 *      + O(N) 的 Set 构造 + diff watch/unwatch —— 亚毫秒级开销。
 *    - 简单方案收益 > 精细方案；accepted。
 *
 * 4. **cookie 删除同步是 feature 不是 bug** ——
 *    用户在 Space A 主动登出 github.com → A 的 session cookie 被清 → 同步
 *    清理 env 下其他所有 partition 的 github.com cookie。语义与 PD-1 一致：
 *    共享身份 = 共享登录**状态**（进与出都共享）。若用户想要 "A 登出 B 保
 *    留"，正确做法是把 B 放到独立环境；不是改本服务。
 *
 * 5. **只监听 env partition** ——
 *    - 本地化退役 Wave 1（ADR-9）：删除对 ``tabtin:crawlspace:{space_id}`` 的
 *      legacy 监听。理由：项目无任何 legacy 数据(无用户)，且本地化后所有
 *      Space 都直接走 env partition。监听集只剩 `tabtin:env:{id}`，模型清爽。
 *
 * 6. **cause 过滤** ——
 *    跳过 ``expired`` / ``evicted`` / ``expired-overwrite`` —— 这些是 Chromium
 *    自动生命周期事件，不该广播给别 partition（它们自己的引擎也会做同样清理）。
 *    只广播 ``explicit`` / ``overwrite`` / ``inserted*``。
 *
 * 7. **跳过已过期 cookie** ——
 *    Set-Cookie 可能带过去的 ``expirationDate`` 用于 "删除" 语义；Chromium 内部
 *    会同步清理。我们在同步到目标 partition 时显式跳过已过期的（若 cookie.expirationDate
 *    已在过去），避免垃圾数据写入目标。
 *
 * ## 未覆盖的边界（进遗留）
 *
 * - **cookie TTL 跨时区偏移**：``expirationDate`` 是 UNIX 秒级时间戳，Electron
 *   内部已统一成 UTC，本服务不做额外换算。
 * - **跨 Env 写入放大风险**：如果同一个 partition 意外出现在多个 env 的集合里
 *   （理论上 BrowserEnvironmentService 保证不会，但防御性假设），其 cookie
 *   变化会向两个 env 的 target 扇出——**事实上是后端绑定配置错误的"表面症状"**，
 *   应由后端保证互斥；本服务不主动去重。
 */

import { session as electronSession } from 'electron'
import type { Cookie, Event as ElectronEvent, Session } from 'electron'

import { createLogger } from '../logger'
import {
  getBrowserEnvironmentService,
  type BrowserEnvironmentService,
} from './BrowserEnvironmentService'

const log = createLogger('CookieSync')

const DEBOUNCE_MS = 300

type PartitionKey = string
type EnvId = string

/** Electron ``cookies.on('changed')`` 里 ``cause`` 的字面量联合。 */
type CookieChangeCause =
  | 'inserted'
  | 'inserted-no-change-overwrite'
  | 'inserted-no-value-change-overwrite'
  | 'explicit'
  | 'overwrite'
  | 'expired'
  | 'evicted'
  | 'expired-overwrite'

interface WatchEntry {
  envId: EnvId
  ses: Session
  handler: (
    event: ElectronEvent,
    cookie: Cookie,
    cause: CookieChangeCause,
    removed: boolean,
  ) => void
  /** 按 cookie key（domain|path|name）去重的待同步批次。 */
  pending: Map<string, { cookie: Cookie; removed: boolean }>
  timer: NodeJS.Timeout | null
}

export interface CookieSyncDeps {
  /** 可注入用于测试 —— 默认使用单例 BrowserEnvironmentService。 */
  service?: BrowserEnvironmentService
  /** 可注入用于测试 —— 默认用 Electron ``session.fromPartition``。 */
  sessionFactory?: (partitionKey: string) => Session
  /** 可注入用于测试：覆盖 debounce 窗口。 */
  debounceMs?: number
}

export class CookieSyncService {
  private readonly sessionFactory: (partitionKey: string) => Session
  private readonly debounceMs: number
  private service: BrowserEnvironmentService | null
  private partitionsByEnv = new Map<EnvId, Set<PartitionKey>>()
  private watched = new Map<PartitionKey, WatchEntry>()
  /**
   * 按 target partition 的防环计数 —— flushBatch 把 cookie 同步到 target
   * 之前 ``syncingTargets[target]++``，结束时 --，归 0 时 delete。handler
   * 只在自己所在 partition 的 count > 0 时 drop（这是回流事件的唯一信号）。
   *
   * 为什么不是全局 boolean（外部可见名 ``isSyncing``）：旧实现会吞掉**源
   * partition 在 flush 期间的新用户写入**（event 被 drop 且不进 pending →
   * 永久丢失）。按 target 计数后，源 partition 的 handler 总能把新事件
   * 加入 pending，下一次 debounce 刷新带走。
   *
   * 为什么是 count 而非 Set：并发 flush 可能写到同一 target（罕见但可能），
   * count 保证 "所有 flush 都结束" 才解除屏蔽。
   */
  private syncingTargets = new Map<PartitionKey, number>()
  /** 仅供注释/诊断参考：任意 target 正在被同步。外部不应依赖此方法做正确性判定。 */
  private get isSyncing(): boolean {
    return this.syncingTargets.size > 0
  }
  private started = false
  private unsubscribeChange: (() => void) | null = null

  constructor(deps: CookieSyncDeps = {}) {
    this.service = deps.service ?? null
    this.sessionFactory =
      deps.sessionFactory ?? ((p: string) => electronSession.fromPartition(p))
    this.debounceMs = deps.debounceMs ?? DEBOUNCE_MS
  }

  /**
   * 启动服务：拉取当前环境映射 → 建立 session 监听 → 订阅 env changed 事件。
   *
   * 失败降级：任何环节抛出都只 warn，不阻断。BrowserEnvironmentService 若未
   * ready 则 ``listEnvironmentsSync()`` 返回空数组，本服务启动后但监听集为空；
   * 后续 ``change`` 事件到达时会重建。
   */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    if (!this.service) this.service = getBrowserEnvironmentService()
    try {
      this.rebuildPartitionsByEnv()
      this.unsubscribeChange = this.service.onChanged(() => {
        try {
          this.rebuildPartitionsByEnv()
        } catch (err) {
          log.warn('browser-env:changed 触发的 rebuild 失败（不阻塞）:', err)
        }
      })
      log.info(
        `已启动：${this.watched.size} 个 partition 已监听，跨 ${this.partitionsByEnv.size} 个环境`,
      )
    } catch (err) {
      log.warn('启动期 rebuild 失败；将等待首次 browser-env:changed 事件兜底', err)
    }
  }

  /**
   * 应用退出时调用 —— 解除所有 session 监听 + 清理待发同步窗口。幂等。
   */
  stop(): void {
    if (!this.started) return
    this.started = false
    try {
      this.unsubscribeChange?.()
    } catch {
      /* ignore */
    }
    this.unsubscribeChange = null
    for (const partition of Array.from(this.watched.keys())) {
      this.unwatchPartition(partition)
    }
    this.partitionsByEnv.clear()
  }

  /** 诊断接口。 */
  getStats(): {
    watchedPartitions: number
    environments: number
    envMap: Record<EnvId, PartitionKey[]>
  } {
    const envMap: Record<EnvId, PartitionKey[]> = {}
    for (const [envId, set] of this.partitionsByEnv) envMap[envId] = Array.from(set)
    return {
      watchedPartitions: this.watched.size,
      environments: this.partitionsByEnv.size,
      envMap,
    }
  }

  // ── 私有实现 ──────────────────────────────────────────────────

  /**
   * 从 BrowserEnvironmentService 读取 envs 快照，重建 partition ↔ env 的映射。
   * 增量 diff：新增 → watch，删除 → unwatch，env 变化 → 重新 wire。
   *
   * 本地化退役 Wave 1（ADR-9）：只注入 `env.partition_key`，不再为每个 Space
   * 注入 legacy `tabtin:crawlspace:{space_id}`。本地化后所有 Space 都直接走
   * env partition，没有 legacy 数据需要同步。
   */
  private rebuildPartitionsByEnv(): void {
    const svc = this.service
    if (!svc) return
    const envs = svc.listEnvironmentsSync()

    const nextByEnv = new Map<EnvId, Set<PartitionKey>>()
    const partitionEnv = new Map<PartitionKey, EnvId>()

    for (const env of envs) {
      const set = new Set<PartitionKey>()
      if (env.partition_key) {
        set.add(env.partition_key)
        partitionEnv.set(env.partition_key, env.id)
      }
      nextByEnv.set(env.id, set)
    }

    // diff old -> new
    for (const partition of Array.from(this.watched.keys())) {
      const nextEnv = partitionEnv.get(partition)
      if (!nextEnv) {
        this.unwatchPartition(partition)
        continue
      }
      const current = this.watched.get(partition)
      if (current && current.envId !== nextEnv) {
        this.unwatchPartition(partition)
        this.watchPartition(partition, nextEnv)
      }
    }

    for (const [partition, envId] of partitionEnv) {
      if (!this.watched.has(partition)) {
        this.watchPartition(partition, envId)
      }
    }

    this.partitionsByEnv = nextByEnv
  }

  private watchPartition(partition: PartitionKey, envId: EnvId): void {
    if (this.watched.has(partition)) return
    try {
      const prefixed = partition.startsWith('persist:') ? partition : `persist:${partition}`
      const ses = this.sessionFactory(prefixed)
      const entry: WatchEntry = {
        envId,
        ses,
        handler: () => {},
        pending: new Map(),
        timer: null,
      }
      const handler = (
        _event: ElectronEvent,
        cookie: Cookie,
        cause: CookieChangeCause,
        removed: boolean,
      ) => {
        // 防环：只有"自己作为 target 正在被 flushBatch 写入"时才丢弃——源
        // partition 的新用户写入永远进 pending（即使全局有其他 flush 在进行）。
        if ((this.syncingTargets.get(partition) ?? 0) > 0) return
        if (cause === 'expired' || cause === 'evicted' || cause === 'expired-overwrite') return
        if (
          !removed &&
          typeof cookie.expirationDate === 'number' &&
          cookie.expirationDate * 1000 < Date.now()
        ) {
          return
        }
        entry.pending.set(cookieKey(cookie), { cookie, removed })
        if (!entry.timer) {
          entry.timer = setTimeout(() => {
            entry.timer = null
            const batch = Array.from(entry.pending.values())
            entry.pending.clear()
            void this.flushBatch(envId, partition, batch)
          }, this.debounceMs)
        }
      }
      entry.handler = handler
      ses.cookies.on('changed', handler)
      this.watched.set(partition, entry)
    } catch (err) {
      log.warn(`监听 partition 失败：${partition}`, err)
    }
  }

  private unwatchPartition(partition: PartitionKey): void {
    const entry = this.watched.get(partition)
    if (!entry) return
    try {
      entry.ses.cookies.off('changed', entry.handler)
    } catch {
      /* ignore */
    }
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    entry.pending.clear()
    this.watched.delete(partition)
  }

  private async flushBatch(
    envId: EnvId,
    sourcePartition: PartitionKey,
    batch: Array<{ cookie: Cookie; removed: boolean }>,
  ): Promise<void> {
    if (batch.length === 0) return
    const set = this.partitionsByEnv.get(envId)
    if (!set) return
    const targets: PartitionKey[] = []
    for (const p of set) {
      if (p !== sourcePartition) targets.push(p)
    }
    if (targets.length === 0) return

    const acquired: PartitionKey[] = []
    for (const t of targets) {
      this.syncingTargets.set(t, (this.syncingTargets.get(t) ?? 0) + 1)
      acquired.push(t)
    }
    try {
      for (const target of targets) {
        const prefixed = target.startsWith('persist:') ? target : `persist:${target}`
        let ses: Session
        try {
          ses = this.sessionFactory(prefixed)
        } catch (err) {
          log.warn(`无法取到目标 session（${target}），跳过`, err)
          continue
        }
        for (const { cookie, removed } of batch) {
          try {
            const url = buildCookieUrl(cookie)
            if (removed) {
              await ses.cookies.remove(url, cookie.name)
            } else {
              await ses.cookies.set(toSetDetails(cookie, url))
            }
          } catch (err) {
            log.debug(
              `同步失败：${sourcePartition} -> ${target}, cookie=${cookie.name}@${cookie.domain ?? ''}`,
              err,
            )
          }
        }
      }
    } finally {
      for (const t of acquired) {
        const next = (this.syncingTargets.get(t) ?? 0) - 1
        if (next <= 0) this.syncingTargets.delete(t)
        else this.syncingTargets.set(t, next)
      }
    }
  }
}

// ── 工具函数 ──────────────────────────────────────────────────

function cookieKey(c: Cookie): string {
  return `${c.domain ?? ''}|${c.path ?? '/'}|${c.name}`
}

function buildCookieUrl(c: Cookie): string {
  const domain = c.domain ?? ''
  const cleanDomain = domain.startsWith('.') ? domain.slice(1) : domain
  const protocol = c.secure ? 'https' : 'http'
  const path = c.path ?? '/'
  return `${protocol}://${cleanDomain || 'localhost'}${path}`
}

function toSetDetails(c: Cookie, url: string): Electron.CookiesSetDetails {
  const sameSite = c.sameSite && c.sameSite !== 'unspecified' ? c.sameSite : 'lax'
  const secure = sameSite === 'no_restriction' ? true : (c.secure ?? false)
  const details: Electron.CookiesSetDetails = {
    url: sameSite === 'no_restriction' ? url.replace(/^http:/, 'https:') : url,
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure,
    httpOnly: c.httpOnly,
    sameSite,
  }
  if (typeof c.expirationDate === 'number') {
    details.expirationDate = c.expirationDate
  }
  return details
}

// ── 模块级单例 ──────────────────────────────────────────────────

let _instance: CookieSyncService | null = null

export function getCookieSyncService(): CookieSyncService {
  if (!_instance) _instance = new CookieSyncService()
  return _instance
}

/** 仅测试用：重置单例。 */
export function __resetCookieSyncServiceForTests(): void {
  if (_instance) {
    try {
      _instance.stop()
    } catch {
      /* ignore */
    }
  }
  _instance = null
}
