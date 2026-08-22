/**
 * BrowserEnv renderer 端镜像快照。
 *
 * # 它做什么
 *
 * 把主进程 `BrowserEnvironmentService` 的 environments + bindings 全量镜像
 * 到 renderer 内存里——同步 getter（`getPartitionForSpaceSync`）让 zustand
 * action / React 同步回调能立即拿到 Space 的真实 partition。
 *
 * # 为什么需要
 *
 * 主进程 BES 本地化后**永远立即可用**，但 IPC 仍是异步往返
 * （ipcRenderer invoke 模式）。renderer 端最高频的消费者
 * （`tabsSlice::createWorkspace`）是同步调用栈，不能在每次创建 workspace
 * 时 await 一次 IPC——会破坏整个 zustand 同步 API 契约且影响 React effect
 * 的渲染时序。镜像方案：
 *
 *   1. App 启动时异步调一次 `browserEnv.list()` 拉取全量快照（毫秒级返回）
 *   2. 订阅 `browserEnv.onChanged` 事件接收增量变更
 *   3. 暴露同步 `getPartitionForSpaceSync(spaceId)` 让消费者立即拿到真实值
 *   4. 暴露 `subscribe(cb)` 让消费者订阅"快照变化"事件，进行 workspace
 *      partition 字段的升级（启动期镜像未就绪时创建的 workspace 默认走
 *      `'tabtin:env:default'`，镜像加载 / 用户改绑定后会被升级到正确值）
 *
 * # 启动期窗口处理
 *
 * 镜像未就绪（`browserEnv.list()` IPC 还在飞）时，`getPartitionForSpaceSync`
 * 返回默认 env 的 partition key `'tabtin:env:default'`。这是**真实的默认 env
 * partition**——本地化退役后默认 env 一定存在，所以这一帧没解析到的
 * Space 拿到的是"默认绑定"的真实 partition，行为正确（绑到独立 env 的
 * Space 在镜像就绪后会被升级到正确 partition）。
 *
 * 调用方需要区分"未就绪 → 默认"和"已就绪但无显式绑定 → 默认"两种语义时，
 * 改用 `getPartitionStatus(spaceId)` —— 后者返回 `{ partition, ready, isExplicit }`。
 *
 * # 失败 + 重试策略
 *
 * `browserEnv.list()` 抛错或返回 `success: false` 时：
 *   1. 写入 `lastError` 并 `notifyListeners()` —— 让消费方感知"加载失败但
 *      不再加载中"，可以走兜底逻辑（如保留默认 partition 而不是无限等待）。
 *   2. 安排一次 5s 后的 retry（指数退避：5s → 30s → 120s 上限）。
 *   3. 同时仍订阅 `browser-env:changed` —— 主进程下次广播会触发额外 refresh。
 *
 * # 与 Wave 1 之前的区别
 *
 * Wave 1 之前：renderer 端有 pending 占位 + cache miss / prime / generation /
 * LRU / writePartitionHook 一整套补丁堆，因为主进程 BES 启动期需要异步等
 * 后端 bootstrap，pending 期 cookie 不能落盘。
 *
 * Wave 2 之后：主进程 BES 同步立即可用 → renderer 镜像只需要 "异步初始化
 * 一次 + onChanged 增量" 两件事；pending 概念在主进程 / renderer 两侧都
 * 彻底消失。
 */

import type {
  BrowserEnvBinding,
  BrowserEnvironment,
} from '@shared/types/browser-env'
import { buildOrganizationBrowserPartition } from '@shared/types/browser-env'
import { ensureLegacyOk } from '@/services/legacy-result'

/**
 * 默认 env 的 partition key —— 与主进程 `BrowserEnvLocalStore.DEFAULT_ENV_PARTITION_KEY`
 * 同源（本地化退役 ADR-3）。
 *
 * 暴露给消费者 / 测试做断言。**不要**在 renderer 端创建 workspace 时硬
 * 编码这个常量——总是走 `getPartitionForSpaceSync(spaceId)`，未来如果
 * 默认 env 改名/迁移，只需改主进程一处。
 */
export const DEFAULT_ENV_PARTITION = 'tabtin:env:default'

/**
 * 命名 session crawlspace 的 partition 前缀（BR-29）。
 *
 * **为什么命名 session 必须用独立 partition**：命名 session 在产品语义上是
 * 一个**隔离的浏览器身份**——用户/Agent 用它登录另一个账号、或做"不污染真实
 * 登录态"的探查。它绝不能与 Space 绑定的 env partition（`tabtin:env:*`，承载
 * 真实登录态）共用 cookie 罐。旧实现里 `ensureNamedCrawlspace` 没传显式
 * partition，落回 `getPartitionForSpaceSync(spaceId)` → `tabtin:env:default`，
 * 于是命名 session 直接读到 Google/GitHub 等默认环境 Cookie（dogfood Case 7）。
 *
 * **为什么前缀不能是 `tabtin:env:`**：`tabsSlice` 的镜像升级 listener 只对
 * `tabtin:env:*` 前缀做"按 spaceId 重解析 → 升级回 env partition"。若 session
 * partition 也用该前缀，listener 会把它"升级"回 Space env partition，隔离当场
 * 失效。独立前缀 `tabtin:session:` 让 listener 跳过它（`isManagedEnvPartition`
 * 返回 false），同时 `CookieSyncService` 只监听 env partition、也不会把默认
 * 环境 Cookie 同步进来。
 *
 * partition 取自 crawlspaceId（`cs-session-{spaceId8}-{name}`，由
 * `ensureNamedCrawlspace` 确定且对 (spaceId, sessionName) 稳定），保证同名
 * session 复开时复用同一持久化 cookie 罐。
 */
export const SESSION_PARTITION_PREFIX = 'tabtin:session:'

/** 由命名 session 的 crawlspaceId 推导其独立隔离 partition。 */
export function buildSessionPartition(crawlspaceId: string): string {
  return `${SESSION_PARTITION_PREFIX}${crawlspaceId}`
}

// ── Organization 级浏览器 partition 解析（边界改造 Phase 3a） ─────────────────
//
// 边界正典 §1.4：普通浏览器 cookie 基于 **Organization profile**。renderer 侧把
// "当前活跃 organization id" 注入一个解析器（生产装配在 app-shell-init →
// `useOrganizationStore.getEffectiveOrganizationId`），让 `getPartitionForSpaceSync`
// 的非显式绑定分支返回 `tabtin:organization:{id}:browser`。
//
// **opt-in**：未注入解析器时回落到历史默认 env partition（`tabtin:env:default`），
// 既有单测无需改动即保持绿；解析器一旦装配，普通浏览器即走 organization 共享罐。

let organizationIdResolver: (() => string | null | undefined) | null = null

/** 注入 / 替换"当前活跃 organization id"解析器。传 null 解除（回落默认 env partition）。 */
export function setOrganizationIdResolver(resolver: (() => string | null | undefined) | null): void {
  organizationIdResolver = resolver
}

/**
 * 通知"organization 解析结果可能变了" —— 复用 browser-env 镜像的 listener 通道，
 * 让 `tabsSlice` 的 partition 升级扫描重跑。
 *
 * 为什么需要（review P1 / 边界改造 Phase 3a）：partition 升级 listener 只由
 * browser-env 镜像事件（env CRUD / BES start）驱动；而普通浏览器 partition 现在
 * 取决于"当前 organization"（来自 organization store，另一个真相源）。启动早期 organization
 * 未就绪时建的 view 会占位 `tabtin:env:default`，**若不在 organization 就绪后补一次
 * 通知，这些占位 view 不会被升级到 organization 罐** → 同 organization 内"一部分 tab 登录、
 * 一部分没登录"。app-shell-init 订阅 organization 变化后调本函数补这道通知。
 *
 * 走的是既有"partition 升级 → crawl-view mismatch → ViewFactory destroy+recreate"
 * 闭环（承重墙：不热改 partition）。注意：升级 gate `isManagedEnvPartition` 仅认
 * `tabtin:env:*`，所以本通知只会把 `tabtin:env:default` 占位升级到 organization 罐；
 * 已是 `tabtin:organization:A` 的 view 在切到 organization B 时**不会**被本通知迁移
 * （那属于"已开 view 跨 organization 迁移"，per-space 载体阶段不处理，见 ）。
 */
export function notifyOrganizationResolverChanged(): void {
  notifyListeners()
}

/**
 * 当前活跃 organization 的浏览器共享 partition；拿不到 organization（未注入 / 抛错 /
 * 未登录 / 启动早期）时回落到默认 env partition。
 *
 * 这是"普通浏览器共享 cookie 罐"的单一来源——凭据导入 / onboarding /
 * AgentOrganizationButton 等所有"写共享罐 / 探共享罐"的消费方都应取这里，避免
 * 浏览面（organization 罐）与导入面（默认 env 罐）指向不同罐导致登录态串不上。
 */
export function getOrganizationBrowserPartition(): string {
  if (!organizationIdResolver) return DEFAULT_ENV_PARTITION
  let organizationId: string | null | undefined
  try {
    organizationId = organizationIdResolver()
  } catch (err) {
    console.warn('[browserEnvSnapshot] organizationIdResolver 抛错,回落默认 env partition:', err)
    return DEFAULT_ENV_PARTITION
  }
  return buildOrganizationBrowserPartition(organizationId) || DEFAULT_ENV_PARTITION
}

/** 失败重试退避序列（毫秒）—— 抵 600s 上限后停止重试，等 onChanged 唤起。 */
const RETRY_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000]

interface SnapshotState {
  /** mirror 是否已经成功拉到至少一份快照。 */
  ready: boolean
  /** spaceId → 真实 partition_key（仅显式 binding；默认 env 走 fallback）。 */
  partitionBySpace: Map<string, string>
  /** 最近一次 IPC 失败信息；成功后清空。供 listener 判断"加载失败但不再 in-flight"。 */
  lastError: string | null
}

let state: SnapshotState = {
  ready: false,
  partitionBySpace: new Map(),
  lastError: null,
}

const listeners = new Set<() => void>()
let unsubFromIpc: (() => void) | null = null
let initStarted = false

// 失败重试状态
let retryAttempt = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null

// orphan binding 警告去重 —— 同一个 environment_id 只 warn 一次,防止 dogfood
// 期数据持续异常时控制台被刷屏。
const warnedOrphanEnvIds = new Set<string>()

/** 仅在测试代码中使用：可注入 mock window.tabtin。 */
type BrowserEnvIpcShape = {
  list?: () => Promise<unknown>
  onChanged?: (
    cb: (payload: { reason: string; spaceId?: string; environmentId?: string }) => void,
  ) => () => void
}

function readBrowserEnvIpc(): BrowserEnvIpcShape | null {
  if (typeof window === 'undefined') return null
  const tabtin = (window as unknown as { tabtin?: { browserEnv?: BrowserEnvIpcShape } }).tabtin
  return tabtin?.browserEnv ?? null
}

/**
 * 把后端响应里的 environments + bindings 折叠成 spaceId → partition 索引。
 *
 * 容错：未知 environment_id 的 binding 会触发一次 console.warn（按
 * environment_id 去重，避免刷屏），随后丢弃该 binding 不阻断后续逻辑。
 * 这是排查"为什么某 Space 看不到自己绑的 env"时的关键观测点 —— 数据
 * 异常通常指向 BES 写盘的悬空引用。
 */
function indexBindings(
  environments: BrowserEnvironment[],
  bindings: BrowserEnvBinding[],
): Map<string, string> {
  const envById = new Map<string, BrowserEnvironment>()
  for (const env of environments) envById.set(env.id, env)
  const out = new Map<string, string>()
  for (const b of bindings) {
    if (!b || typeof b.space_id !== 'string' || !b.space_id) continue
    const env = envById.get(b.environment_id)
    if (!env || !env.partition_key) {
      if (!warnedOrphanEnvIds.has(b.environment_id)) {
        warnedOrphanEnvIds.add(b.environment_id)
        console.warn(
          '[browserEnvSnapshot] orphan binding：找不到 environment，已跳过',
          { environment_id: b.environment_id, space_id: b.space_id },
        )
      }
      continue
    }
    out.set(b.space_id, env.partition_key)
  }
  return out
}

function notifyListeners(): void {
  // 复制一份 —— listener 在回调里调 unsubscribe 是合法路径
  const snap = Array.from(listeners)
  for (const cb of snap) {
    try {
      cb()
    } catch (err) {
      console.warn('[browserEnvSnapshot] listener 执行失败:', err)
    }
  }
}

function clearRetryTimer(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

function scheduleRetry(): void {
  if (retryTimer !== null) return
  const delay = RETRY_BACKOFF_MS[Math.min(retryAttempt, RETRY_BACKOFF_MS.length - 1)]
  retryAttempt += 1
  retryTimer = setTimeout(() => {
    retryTimer = null
    void refreshFromIpc()
  }, delay)
}

async function refreshFromIpc(): Promise<void> {
  const api = readBrowserEnvIpc()
  if (!api?.list) {
    // IPC 还没 ready（preload 未注入或未挂载） —— 安排一次 retry 等 preload 装好。
    state = { ...state, lastError: 'browser-env IPC unavailable' }
    notifyListeners()
    scheduleRetry()
    return
  }
  try {
    // contract W2-β：channel `browser-env:list` 在 LEGACY_HANDLERS 内（preload 透传 raw
    // `{success, environments, bindings, error}`）。ensureLegacyOk 拦 main 端 success:false
    // 转 throw —— 避免 caller 把 `{success: false, error: 'BACKEND_DOWN'}` 当成功路径处理
    // （environments 字段 undefined → []，state.ready 误置 true，调用方拿到 default partition
    // 但 lastError 永远不写入，retry 不触发）。envelope `ok:false` 走 invokeIpc 短路 throw。
    const result = await api.list()
    ensureLegacyOk(result, 'browserEnv.list')
    const typedRes = result as { environments?: BrowserEnvironment[]; bindings?: BrowserEnvBinding[] }
    const environments: BrowserEnvironment[] = Array.isArray(typedRes.environments)
      ? typedRes.environments
      : []
    const bindings: BrowserEnvBinding[] = Array.isArray(typedRes.bindings) ? typedRes.bindings : []
    state = {
      ready: true,
      partitionBySpace: indexBindings(environments, bindings),
      lastError: null,
    }
    retryAttempt = 0
    clearRetryTimer()
    notifyListeners()
  } catch (err) {
    // 主进程 BES 本地化后理论上不会失败；防御性日志 + retry。
    // catch 同时覆盖了"IPC throw"（W2-α 后）和"运行时崩"两种情况。
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[browserEnvSnapshot] 拉取 BrowserEnv 快照失败，已安排重试:', err)
    state = { ...state, lastError: msg }
    notifyListeners()
    scheduleRetry()
  }
}

/**
 * 订阅主进程 `browser-env:changed` 广播，refresh 镜像。幂等。
 */
function ensureIpcSubscription(): void {
  if (unsubFromIpc) return
  const api = readBrowserEnvIpc()
  if (!api?.onChanged) return
  try {
    const unsub = api.onChanged(() => {
      // 任何变更都全量 refresh —— BrowserEnv 数据量极小（<10 个 env），
      // 全量拉取比维护精确 diff 简单且不会有"漏字段"的隐患。
      void refreshFromIpc()
    })
    unsubFromIpc = typeof unsub === 'function' ? unsub : null
  } catch (err) {
    console.warn('[browserEnvSnapshot] 订阅 onChanged 失败:', err)
  }
}

/**
 * 启动镜像 —— 应该在 App boot 期被调一次。重复调用幂等。
 *
 * 异步触发首次拉取 + 订阅事件；调用方不必 await（同步消费者会先拿到
 * 默认 partition，之后 listener 触发升级）。
 */
export function ensureBrowserEnvSnapshotStarted(): void {
  if (initStarted) return
  initStarted = true
  ensureIpcSubscription()
  void refreshFromIpc()
}

/**
 * 镜像状态查询 —— 同步返回完整三态信息。
 *
 * 返回字段：
 *   - `partition`：spaceId 应该用的 partition（永远非空 string）
 *   - `ready`：mirror 是否已成功拉到至少一份快照（`false` = 启动期未就绪 /
 *     失败重试中）
 *   - `isExplicit`：spaceId 是否有显式 env binding（`true` 表示绑到独立 env，
 *     `false` 表示走 Organization 共享罐 / 镜像未就绪）
 *
 * partition 解析（边界改造 Phase 3a）：
 *   1. 有显式 env binding → 该 env 的 partition_key（legacy 独立环境）
 *   2. 否则 → 当前 Organization 的共享浏览器 partition（`getOrganizationBrowserPartition`，
 *      无 organization 时回落默认 env partition）
 *
 * 调用方需要区分"启动期窗口"和"用户没绑定 → 走默认"两种语义时使用此函数。
 * 仅查 partition 字符串走 `getPartitionForSpaceSync`，更轻量。
 */
export function getPartitionStatus(
  spaceId: string | undefined | null,
): { partition: string; ready: boolean; isExplicit: boolean } {
  ensureBrowserEnvSnapshotStarted()
  const ready = state.ready
  if (typeof spaceId !== 'string' || !spaceId) {
    return { partition: getOrganizationBrowserPartition(), ready, isExplicit: false }
  }
  const explicit = state.partitionBySpace.get(spaceId)
  if (explicit) {
    return { partition: explicit, ready, isExplicit: true }
  }
  return { partition: getOrganizationBrowserPartition(), ready, isExplicit: false }
}

/**
 * 同步查询 Space 应使用的 partition。
 *
 * 返回值语义（边界改造 Phase 3a）：
 *   - 镜像有该 spaceId 的显式 env binding → 返回绑定 env 的 partition_key
 *   - 否则（无显式 binding / 镜像未就绪 / 无 spaceId）→ 当前 Organization 的共享
 *     浏览器 partition（`getOrganizationBrowserPartition`，无 organization 时回落默认
 *     env partition）
 *
 * **永远返回非空 string**，调用方无需判空。如果需要区分"未就绪"还是
 * "已就绪但无显式绑定"，改用 `getPartitionStatus`。
 */
export function getPartitionForSpaceSync(spaceId: string | undefined | null): string {
  return getPartitionStatus(spaceId).partition
}

/**
 * 镜像就绪状态简化查询 —— 等价于 `getPartitionStatus(undefined).ready`。
 */
export function isMirrorReady(): boolean {
  return state.ready
}

/**
 * 订阅"镜像更新"事件 —— 每次成功拉取完成 / 失败更新 lastError /
 * `onChanged` 触发 refresh 完成 都会通知。返回 unsubscribe 函数。
 *
 * 典型消费：tabsSlice 订阅后扫描所有 workspace config，把 partition 字段
 * 升级到 `getPartitionForSpaceSync` 的最新值（用户改绑定后已打开的
 * workspace 自动跟随）。
 */
export function subscribeBrowserEnvSnapshot(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** 仅测试用：清空镜像 + 解除 IPC 订阅 + 重置 listener / retry / orphan 警告集合 / organization 解析器。 */
export function __resetBrowserEnvSnapshotForTests(): void {
  state = { ready: false, partitionBySpace: new Map(), lastError: null }
  listeners.clear()
  organizationIdResolver = null
  try {
    unsubFromIpc?.()
  } catch {
    /* ignore */
  }
  unsubFromIpc = null
  initStarted = false
  retryAttempt = 0
  clearRetryTimer()
  warnedOrphanEnvIds.clear()
}

/** 仅测试用：诊断当前镜像内容。 */
export function __getBrowserEnvSnapshotForTests(): {
  ready: boolean
  partitionBySpace: ReadonlyMap<string, string>
  lastError: string | null
} {
  return {
    ready: state.ready,
    partitionBySpace: state.partitionBySpace,
    lastError: state.lastError,
  }
}
