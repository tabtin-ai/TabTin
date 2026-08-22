/**
 * Mode switch IPC — ModeSwitchProposalCard 用户审批入口 + setAgentMode 通知主进程。
 *
 * Phase 3 F13：去掉 modeTransitionReminder 返回字段（renderer 不消费，
 *   mode transition reminder 由主进程 mode-switch-handler 内部置 flag，下一轮
 *   query iteration 0 由 mode-reminder-injector hook 直接读 + 注入）。
 */

export type ModeSwitchOutcome = 'approved' | 'cancelled'

export interface ModeSwitchExecuteRequest {
  sessionId: string
  proposalId: string
  outcome: ModeSwitchOutcome
}

export interface ModeSwitchExecuteResult {
  success: boolean
  outcome?: ModeSwitchOutcome
}

export async function executeModeSwitch(
  request: ModeSwitchExecuteRequest,
): Promise<ModeSwitchExecuteResult> {
  const ipc = window.tabtin?.agentEngine
  if (!ipc?.executeModeSwitch) {
    throw new Error('IPC bridge missing executeModeSwitch')
  }
  const ack = await ipc.executeModeSwitch(request)
  if (!ack || ack.success !== true) {
    throw new Error(ack?.error ?? 'Mode switch failed (Unknown IPC error)')
  }
  return {
    success: true,
    outcome: ack.outcome,
  }
}

// ─── Phase 3 F8/F9：UI setAgentMode 直接 IPC 通知主进程 ────────────

export interface NotifyModeSwitchedPayload {
  sessionId: string
  /** 切换前 mode（可选；用于注入 mode transition reminder） */
  fromMode?: string
  /** 切换后 mode */
  toMode: string
}

export interface NotifyModeSwitchedResult {
  success: boolean
  cancelledHitlBatchCount?: number
  modeTransitionReminderSet?: boolean
}

/**
 * 主进程同步 mode 切换通知：renderer setAgentMode 后立刻调本服务，
 * 让主进程立即 cancel 该 session 的 pending HITL（F8）+ 记录一次 mode transition
 * reminder（F9，任意合法 mode 切换）。
 *
 * 失败不抛——UI 切 mode 的主路径不应被 IPC 失败阻断；返回 `success: false`
 * 给调用方做 telemetry/log。
 */
export async function notifyModeSwitched(
  payload: NotifyModeSwitchedPayload,
): Promise<NotifyModeSwitchedResult> {
  const ipc = window.tabtin?.agentEngine
  if (!ipc?.notifyModeSwitched) {
    return { success: false }
  }
  try {
    const ack = await ipc.notifyModeSwitched(payload)
    return {
      success: ack?.success === true,
      cancelledHitlBatchCount: ack?.cancelledHitlBatchCount,
      modeTransitionReminderSet: ack?.modeTransitionReminderSet,
    }
  } catch {
    return { success: false }
  }
}
