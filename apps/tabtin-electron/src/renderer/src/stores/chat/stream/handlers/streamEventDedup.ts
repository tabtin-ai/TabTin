/**
 * 跨源（IPC + WS）stream event 去重 —— 业务级 `arrival_seq` 「先到先处理、后到丢弃」。
 *
 * 背景：
 *   - 本窗口发起的 turn 同时走 IPC（`sendMessageAction`，低延迟）与 relay→WS
 *     （`useObserverStreamMirror`，多端事实流）两路；跨端（mobile 发起、本端旁观）
 *     只走 WS。#1979 曾用「session 级 IPC 权威」整段挡掉 WS，导致跨端消息不上屏。
 *   - 正解：两路都消费，靠**事件源（agent-runtime）统一分配**的 `arrival_seq` 在消费
 *     入口去重——同一逻辑事件无论先到 IPC 还是先到 WS，第一条处理、第二条丢弃。
 *
 * 为什么 key 用 `arrival_seq`：
 *   - 进程级全局单调、daemon（agent-runtime `stamp-event.ts`）唯一分配；
 *   - Django relay 只覆盖 `_seq`（Redis INCR），**不动** `arrival_seq`，故 IPC 与 WS
 *     两路看到的同一事件 `arrival_seq` 一致；
 *   - daemon retry 走新 `nextArrivalSeq()` → 新 key，不会被误判为重复丢弃。
 *
 * 契约：
 *   - **无 `arrival_seq` 的事件一律放行**（不去重）——host 合成事件（message_persisted /
 *     host catch errorEvent）、Django 自发事件（message_committed）等没有 daemon 业务键，
 *     去重它们会误伤；它们各有自己的幂等/兜底路径。
 *   - 两个 handler 实例（IPC handler in sendMessageAction、observer handler in
 *     useObserverStreamMirror）**共享**本模块的 session 级缓存，故放模块级而非 handler 闭包。
 *   - per-session LRU（FIFO 淘汰）防长会话内存增长；`clearStreamEventDedup` 在会话清理时调用。
 */

/** 每个 session 最多记忆的近期 arrival_seq 数量（FIFO 淘汰最旧）。 */
const DEDUP_CACHE_LIMIT = 8192

/**
 * 去重键：优先 `event_id`（ 纯身份，一次发射一次、包装/转发/回声只搬运不重造），
 * 缺失时回落 `arrival_seq`（老 daemon / 老数据 / host 合成事件）。string 与 number
 * 不会撞车（event_id 形如 `nonce-1k`，arrival_seq 是纯数字）。
 */
type DedupKey = string | number

interface SessionDedupState {
  seen: Set<DedupKey>
  order: DedupKey[]
}

const _dedupBySessionId = new Map<string, SessionDedupState>()

/**
 * 标记并判断某 session 的某条事件（按 `event_id` / `arrival_seq` 身份键）是否应处理。
 *
 * @returns `true` 表示首次见到（应处理）；`false` 表示重复（后到，应丢弃）。
 */
export function markStreamEventSeen(sessionId: string, key: DedupKey): boolean {
  if (!sessionId) return true
  let state = _dedupBySessionId.get(sessionId)
  if (!state) {
    state = { seen: new Set<DedupKey>(), order: [] }
    _dedupBySessionId.set(sessionId, state)
  }
  if (state.seen.has(key)) return false
  state.seen.add(key)
  state.order.push(key)
  if (state.order.length > DEDUP_CACHE_LIMIT) {
    const evicted = state.order.shift()
    if (evicted !== undefined) state.seen.delete(evicted)
  }
  return true
}

/** 清理某 session 的去重缓存（会话清理 / 切走时调用，避免内存堆积）。 */
export function clearStreamEventDedup(sessionId: string): void {
  _dedupBySessionId.delete(sessionId)
}

/** Test-only：清空全部去重状态。 */
export function __resetStreamEventDedupForTest(): void {
  _dedupBySessionId.clear()
}
