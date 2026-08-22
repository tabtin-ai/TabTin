/**
 * sendCooldown —— 发送 / 插队的 per-session 冷却窗口（防抖）。
 *
 * ## 为什么需要
 *
 * 手速快 / 连点会在极短时间内连发多条消息或反复插队，制造大量并发的 abort +
 * 新流交叠，放大「旧流尾部错乱」「发送锁竞态」等问题。给每个会话的「发送」与
 * 「插队（中断并发送）」加一段固定冷却：冷却窗口内的重复触发**直接忽略**（输入
 * 内容保留在输入框，不丢消息），并驱动 UI 按钮在窗口内禁用。
 *
 * ## 语义
 *
 * - **忽略式冷却**（非延迟发送 / 非入队）：窗口内第二次触发直接被吞掉。
 * - **per-session**：每个会话各自计时，互不影响。
 * - **发送与插队共享同一会话冷却**：表达「同一会话每 500ms 至多一次发起动作」。
 * - 冷却到期时清掉登记，触发订阅组件重渲染以恢复按钮。
 */

import { create } from 'zustand'

/** 发送 / 插队冷却时长（ms）。 */
export const SEND_COOLDOWN_MS = 500

interface SendCooldownStore {
  /** sessionId → 冷却截止时间戳（ms）。到期后条目被删除。 */
  cooldownUntilBySessionId: Record<string, number>
  /** 记录一次已被接受的发送 / 插队触发，开启该会话冷却窗口。 */
  beginSendCooldown: (sessionId: string) => void
}

const _timers = new Map<string, ReturnType<typeof setTimeout>>()

export const useSendCooldownStore = create<SendCooldownStore>((set) => ({
  cooldownUntilBySessionId: {},
  beginSendCooldown: (sessionId: string) => {
    if (!sessionId) return
    // 调用点契约：ChatInput.handleSend 在 finalize 前 beginSendCooldown。
    // `isSendOnCooldown` 守卫再调本函数，故冷却窗口内不会重复开窗——无需清理上一个计时器
    // （上一个必已自删）。_timers 仅用于自删与 __resetSendCooldownForTest 的测试清理。
    set((s) => ({
      cooldownUntilBySessionId: {
        ...s.cooldownUntilBySessionId,
        [sessionId]: Date.now() + SEND_COOLDOWN_MS,
      },
    }))
    const t = setTimeout(() => {
      _timers.delete(sessionId)
      set((s) => {
        const next = { ...s.cooldownUntilBySessionId }
        delete next[sessionId]
        return { cooldownUntilBySessionId: next }
      })
    }, SEND_COOLDOWN_MS)
    _timers.set(sessionId, t)
  },
}))

/**
 * 纯判定：该会话是否仍在发送 / 插队冷却窗口内（供触发点守卫，非响应式）。
 */
export function isSendOnCooldown(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  const until = useSendCooldownStore.getState().cooldownUntilBySessionId[sessionId]
  return until !== undefined && Date.now() < until
}

/** Test-only：清空全部冷却登记与计时器。 */
export function __resetSendCooldownForTest(): void {
  for (const t of _timers.values()) clearTimeout(t)
  _timers.clear()
  useSendCooldownStore.setState({ cooldownUntilBySessionId: {} })
}
