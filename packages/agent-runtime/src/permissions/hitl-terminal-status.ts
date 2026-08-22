/**
 * HITL 终态 status 推导（ · 第二刀语义单点）。
 *
 * 抽离原因：`local-permission-handler.ts` 已 1030+
 * 行，`deriveTerminalStatus` + CANCELLED/EXPIRED outcome 集合是独立可测的
 * 「wire decision → HitlStatus」映射逻辑，放独立文件更好断言、更好复用（`hitl-terminal-status.test.ts`
 * 也已经直接对着「7 场景」表跑）。
 *
 * # 语义表（wire outcome → HitlStatus → engine decision）
 *
 *   | wire outcome  | 触发                                       | HitlStatus  | engine decision |
 *   |---------------|--------------------------------------------|-------------|-----------------|
 *   | 'allow' / 'approve' | 用户主动批准                         | resolved    | allow           |
 *   | 'deny'  / 'reject'  | 用户主动拒绝                         | resolved    | deny            |
 *   | 'cancelled'         | mode 切换 / 用户 dismiss / rollback   | cancelled   | deny            |
 *   | 'expired'           | 服务端过期扫描回灌（预留通道）        | expired     | deny            |
 *
 * runtime `Promise.race` timeout / waiter reject 也归 expired（用户没及时响应）；
 * 'cancelled_by_rollback' 由 host `applyCancelledByRollbackToHitl` 在入口降级
 * 成 'cancelled' + rejection_message，本模块不需再感知。
 */

import type { HitlStatus } from '../event/events/persist-events.js'

// 严档优先：一条 outcome ∈ EXPIRED_OUTCOMES → 全批 expired；否则一条 outcome
// ∈ CANCELLED_OUTCOMES → 全批 cancelled；其余（allow/deny 或全非法）→ resolved。
const CANCELLED_OUTCOMES: ReadonlySet<string> = new Set(['cancelled'])
const EXPIRED_OUTCOMES: ReadonlySet<string> = new Set(['expired'])

/**
 * wire decision 的四档 outcome + 前端历史命名 fallback。
 *
 * - 'allow' | 'deny'：用户主动决策（→ HitlStatus 'resolved'）
 * - 'cancelled'：mode 切换 / rollback 广播 / renderer dismiss（→ 'cancelled'）
 * - 'expired'：服务端过期回灌（→ 'expired'，预留通道）
 *
 * engine 面向的 `PermissionDecisionResult` 仍是 'allow' | 'deny' 二元。
 */
export type PermissionWireDecisionOutcome =
  | 'allow' | 'deny'          // wire 协议规范值 + 前端历史命名
  | 'approve' | 'reject'
  | 'cancelled' | 'expired'   // 终态语义（Django `mark_tool_approval_resolved_from_payload` 消费）

export interface PermissionWireDecisionLike {
  outcome?: PermissionWireDecisionOutcome
  decision?: 'allow' | 'deny' | 'approve' | 'reject'
  type?: string
}

/**
 * 从本轮全部 wire decisions 推导 `HitlInteractionEvent` 的终态 status。
 *
 * 优先级（先严后宽）：
 *   1. 任何 decision outcome ∈ EXPIRED_OUTCOMES → 'expired'
 *   2. 任何 decision outcome ∈ CANCELLED_OUTCOMES → 'cancelled'
 *   3. 至少一条 outcome 是 allow/deny → 'resolved'
 *   4. 空数组 / 全非法值 → 'resolved'（fail-safe：至少要收口 pending）
 *
 * 混合场景：mode 切换 IPC 走 `cancelAllPendingHitlRequests` 时构造单条
 * `{tool_call_id: '__mode_switch_cancel__', outcome: 'cancelled'}`，与用户
 * 主动 allow/deny 决策不会同批出现；`applyCancelledByRollbackToHitl` 也是全
 * cancelled 一批。所以「混合优先取严」在真实场景里等价于「有 cancelled 就 cancelled」。
 */
export function deriveTerminalStatus(
  wireDecisions: PermissionWireDecisionLike[] | undefined,
): Extract<HitlStatus, 'resolved' | 'cancelled' | 'expired'> {
  if (!wireDecisions || wireDecisions.length === 0) return 'resolved'
  for (const d of wireDecisions) {
    const raw = d.outcome ?? d.decision ?? d.type
    if (typeof raw !== 'string') continue
    if (EXPIRED_OUTCOMES.has(raw)) return 'expired'
    if (CANCELLED_OUTCOMES.has(raw)) return 'cancelled'
  }
  return 'resolved'
}
