/**
 * abortGrace —— 用户主动中止后的短暂宽限期登记。
 *
 * ## 为什么需要
 *
 * `abortStream` 会**乐观地**立刻清掉 streaming 状态（停止按钮消失），但底层
 * abort 可能静默失败（本地 host 查不到 session、signal 未触达 run 等），run
 * 继续跑、事件继续流入，而 streaming 状态没有任何回翻路径——用户从 UI 上
 * 彻底失去停止手段。
 *
 * 修法是「streaming 自愈」：streamMessageHandler 收到新的 `message_start`
 * （run 每轮 LLM 迭代都会发）而会话不在 streaming 时，把 streaming 状态加
 * 回来、恢复停止按钮。但 abort **成功**时也可能有 in-flight 的尾部事件在
 * 中止后几百毫秒内到达——若无宽限期，自愈会把刚停下的会话又翻回「对话中」
 * 造成按钮闪烁。本模块登记「最近一次 abort 请求时间」，自愈只在宽限期外生效：
 * 真没停住的 run 会在后续迭代持续发 message_start，宽限期不影响最终自愈。
 */

const GRACE_MS = 5_000

const lastAbortRequestedAt = new Map<string, number>()
const pendingWithdrawals = new Set<string>()

/** abortStream / abortStreamAndWait 发起中止时调用。 */
export function markAbortRequested(sessionId: string): void {
  lastAbortRequestedAt.set(sessionId, Date.now())
  // 防泄漏：map 只会随「用户点停止」增长，条目极少；超过 100 条时清掉过期项。
  if (lastAbortRequestedAt.size > 100) {
    const cutoff = Date.now() - GRACE_MS
    for (const [sid, ts] of lastAbortRequestedAt) {
      if (ts < cutoff) lastAbortRequestedAt.delete(sid)
    }
  }
}

/** 撤回投影尚未完成时持续丢弃旧流，不受短暂 abort grace 的时间限制。 */
export function markWithdrawalPending(sessionId: string): void {
  pendingWithdrawals.add(sessionId)
}

export function clearWithdrawalPending(sessionId: string): void {
  pendingWithdrawals.delete(sessionId)
}

export function isWithdrawalPending(sessionId: string): boolean {
  return pendingWithdrawals.has(sessionId)
}

/** 是否仍处于 abort 请求后的宽限期内（此期间不做 streaming 自愈）。 */
export function isWithinAbortGrace(sessionId: string): boolean {
  const ts = lastAbortRequestedAt.get(sessionId)
  return ts !== undefined && Date.now() - ts < GRACE_MS
}

/** Test-only：清空登记。 */
export function __resetAbortGraceForTest(): void {
  lastAbortRequestedAt.clear()
  pendingWithdrawals.clear()
}
