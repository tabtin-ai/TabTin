/**
 * messageWriteGate — 会话消息列表的**写入门控**（原 messageAuthority，）。
 *
 * ## 解决什么问题
 *
 * `messagesBySessionId` 此前有 6+ 个无序写入方：加载同步、MESSAGE_COMMITTED 整页
 * 重拉、ROLLBACK WS 收敛、流终态同步、WS 重连对账、回退截断。服务端投影的异步写回
 * 与本地权威变更（回退截断）竞态——sync 在截断前发起、截断后写回，把被回退的消息
 * 整页覆盖回来（ 打包版消息复活的直接根因）。
 *
 * ## 机制
 *
 * 1. **epoch 门控**：本地结构性变更（回退截断 / unrevert 恢复 / 权威整表替换）调
 *    `recordStructuralMutation` bump epoch。服务端 sync 在**发起 fetch 前**捕获
 *    epoch，写回时经 `commitServerMerge` 校验——期间 epoch 变了说明拉到的是过期
 *    投影，丢弃写回（freshness 标 stale，下次 sync 基于新状态重来）。
 * 2. **restoring 互斥**：回退管线进行中（`restoringSessionId === sessionId`），
 *    服务端写回一律丢弃。provider 由 useChatStore 注册（单一真相，不双写标志位）。
 * 3. **自发回退广播抑制**：发起端完成 rollback/unrevert API 后调
 *    `expectSelfRollbackBroadcast` 登记期望；Django 广播的 ROLLBACK/UNREVERT 回流
 *    到发起端时 `consumeSelfRollbackBroadcast` 命中 → 跳过整页重拉（本机 runtime
 *    已是权威，重拉只会引入竞态）。观察端无登记，照常收敛。
 * 4. **本机驱动判定**：hub（agentService/index.ts）注册 provider，
 *    暴露「该会话是否由本机 runtime 驱动」——MESSAGE_COMMITTED 据此在本机驱动会话
 *    上收窄为定向 id 对账，不再整页重拉。
 *
 * ## 为什么是零依赖 leaf
 *
 * 消费方横跨 hub（index.ts / streamMessageHandler）与 store 侧（checkpointSlice /
 * sessionFreshness / sessionCrudSlice）。hub/index.ts 静态 import 了
 * streamMessageHandler，任何「handler → hub/index」的反向 import 都会成环（madge
 * 守卫）。故本模块不 import 任何 store / hub，双方通过 provider 注册在此汇合——
 * 与 `stores/chat/shared/storeAccessRegistry` 同款模式。
 */

import type { ChatMessage } from '@tabtin/chat-client'
import { createLogger } from '@/utils/logger'

const log = createLogger('MessageWriteGate')

/**
 * 自发回退广播期望的过期时间。广播正常在 rollback API 返回后数秒内回流；TTL 只为
 * 兜底「WS 事件丢失导致期望永不被消费」的泄漏——过期条目在下次 consume 时清除，
 * 不会误吞后续其他设备发起的回退广播。
 */
const SELF_ROLLBACK_BROADCAST_TTL_MS = 5 * 60_000

interface WriteGateEntry {
  /** 结构性变更计数。服务端 sync 以「发起时 epoch == 写回时 epoch」为写回前提。 */
  epoch: number
  /** 自发 rollback/unrevert 广播期望（值为过期时间戳，FIFO 消费）。 */
  expectedSelfRollbackBroadcasts: number[]
}

const _entries = new Map<string, WriteGateEntry>()

function getEntry(sessionId: string): WriteGateEntry {
  let entry = _entries.get(sessionId)
  if (!entry) {
    entry = { epoch: 0, expectedSelfRollbackBroadcasts: [] }
    _entries.set(sessionId, entry)
  }
  return entry
}

// ── provider 注册（storeAccessRegistry 同款汇合点模式）──────────────────────

type SessionPredicate = (sessionId: string) => boolean
type SessionMessagesReader = (sessionId: string) => ChatMessage[]

let _restoringProvider: SessionPredicate | null = null
let _sessionMessagesReader: SessionMessagesReader | null = null

/** @internal 由 useChatStore module body 注册：该会话回退管线是否进行中。 */
export function registerRestoringSessionProvider(fn: SessionPredicate): void {
  _restoringProvider = fn
}

/**
 * @internal 由 useChatStore module body 注册：读取某会话当前消息列表。让服务层门面
 * （sessionMessages）能取消息真相而**不静态 import store**——依赖倒置，store 注入实现。
 */
export function registerSessionMessagesReader(fn: SessionMessagesReader): void {
  _sessionMessagesReader = fn
}

/** 读取某会话当前消息列表（provider 未注册时返回空数组）。 */
export function readSessionMessages(sessionId: string): ChatMessage[] {
  return _sessionMessagesReader?.(sessionId) ?? []
}

// ── 服务端 sync 写回 provider（ 阶段0：斩 sessionFreshness ↔ useChatStore 环）──

export interface ServerReconcileOptions {
  advanceWatermark?: boolean
  syncWatermark?: string
}

export interface ServerReconcileResult {
  changed: boolean
  newCount: number
  dropped: boolean
}

type ServerMessagesReconciler = (
  sessionId: string,
  fetchEpoch: number,
  fresh: ChatMessage[],
  opts: ServerReconcileOptions,
) => ServerReconcileResult

let _serverMessagesReconciler: ServerMessagesReconciler | null = null

/** @internal 由 useChatStore module body 注册：服务端 sync 写回（reconcileFromServer）。 */
export function registerServerMessagesReconciler(fn: ServerMessagesReconciler): void {
  _serverMessagesReconciler = fn
}

/**
 * 提交服务端 sync 拉取到的消息给 store 写回权威。provider 未注册时返回空结果
 * （newCount=0 / changed=false / dropped=false），caller（freshness）据此走
 * markFresh 分支，不误标 stale。
 */
export function reconcileServerMessages(
  sessionId: string,
  fetchEpoch: number,
  fresh: ChatMessage[],
  opts: ServerReconcileOptions,
): ServerReconcileResult {
  return (
    _serverMessagesReconciler?.(sessionId, fetchEpoch, fresh, opts)
    ?? { changed: false, newCount: 0, dropped: false }
  )
}

/** 该会话回退管线是否进行中（provider 未注册时视为否）。 */
export function isSessionRestoring(sessionId: string): boolean {
  return _restoringProvider?.(sessionId) === true
}

// ── epoch 门控 ──────────────────────────────────────────────────────────────

/** 服务端 sync 发起 fetch 前捕获，与写回时比对。 */
export function getMessagesEpoch(sessionId: string): number {
  return _entries.get(sessionId)?.epoch ?? 0
}

/**
 * 登记一次本地结构性变更（回退截断 / unrevert 恢复 / 权威整表替换），使所有
 * 在此之前发起、尚未写回的服务端 sync 作废。
 */
export function recordStructuralMutation(sessionId: string, label: string): void {
  const entry = getEntry(sessionId)
  entry.epoch += 1
  log.info(`structural mutation [${label}] sid=${sessionId.slice(0, 8)} epoch=${entry.epoch}`)
}

export type ServerMergeOutcome = 'committed' | 'stale-epoch' | 'restoring'

/**
 * 服务端 sync 写回的唯一入口。`fetchEpoch` 为发起 fetch 前捕获的 epoch；校验通过
 * 才执行 `apply`（store 写入 + IDB cache），否则丢弃并返回丢弃原因。
 *
 * 校验与 apply 之间无 await，JS 单线程保证原子性。
 */
export function commitServerMerge(
  sessionId: string,
  fetchEpoch: number,
  apply: () => void,
): ServerMergeOutcome {
  if (isSessionRestoring(sessionId)) {
    log.warn(`server merge dropped (restoring) sid=${sessionId.slice(0, 8)}`)
    return 'restoring'
  }
  const currentEpoch = getMessagesEpoch(sessionId)
  if (currentEpoch !== fetchEpoch) {
    log.warn(
      `server merge dropped (stale epoch ${fetchEpoch} != ${currentEpoch}) sid=${sessionId.slice(0, 8)}`,
    )
    return 'stale-epoch'
  }
  apply()
  return 'committed'
}

// ── 自发回退广播抑制 ────────────────────────────────────────────────────────

/** 发起端 rollback / unrevert API 成功后登记：接下来回流的一条广播是自己触发的。 */
export function expectSelfRollbackBroadcast(sessionId: string): void {
  getEntry(sessionId).expectedSelfRollbackBroadcasts.push(Date.now() + SELF_ROLLBACK_BROADCAST_TTL_MS)
}

/**
 * ROLLBACK / UNREVERT 广播到达时调用：命中未过期的期望（FIFO 消费一条）返回 true，
 * 调用方据此跳过整页重拉。
 */
export function consumeSelfRollbackBroadcast(sessionId: string): boolean {
  const entry = _entries.get(sessionId)
  if (!entry) return false
  const now = Date.now()
  // 先清掉已过期的期望（WS 事件丢失的泄漏兜底），再消费队头。
  entry.expectedSelfRollbackBroadcasts = entry.expectedSelfRollbackBroadcasts.filter(exp => exp > now)
  if (entry.expectedSelfRollbackBroadcasts.length === 0) return false
  entry.expectedSelfRollbackBroadcasts.shift()
  return true
}

// ── 测试工具 ────────────────────────────────────────────────────────────────

/** Test-only：清空全部写入门控状态与 provider。 */
export function __resetMessageWriteGateForTest(): void {
  _entries.clear()
  _restoringProvider = null
  _sessionMessagesReader = null
  _serverMessagesReconciler = null
}
