/**
 * ActiveRunBinding — 当前 hosted turn 的显式身份（ 方案 A）。
 *
 * 解决：abort / 插队 / DONE 用「最后一条 assistant」启发式，导致「已中断」
 * 标到新 turn。本模块维护 `runId ↔ activeAssistantMessageId`；中断瞬间
 * 快照到 `interrupted`，供乐观徽标与迟到 DONE 归因。
 *
 * 与 sessionRunProjection（busy）平行：投影管忙闲，本模块管中断归因身份。
 */

export type InterruptedRunSnapshot = {
  runId: string | null
  messageId: string | null
}

export type ActiveRunBinding = {
  runId: string | null
  activeAssistantMessageId: string | null
  /**
   * 用户中断瞬间快照。新 turn 的 message_start 会改写 active*，
   * 但 interrupted 保留到对应 abort DONE 收口或显式 clear。
   */
  interrupted: InterruptedRunSnapshot | null
}

const EMPTY: ActiveRunBinding = {
  runId: null,
  activeAssistantMessageId: null,
  interrupted: null,
}

const bindings = new Map<string, ActiveRunBinding>()

function clone(binding: ActiveRunBinding): ActiveRunBinding {
  return {
    runId: binding.runId,
    activeAssistantMessageId: binding.activeAssistantMessageId,
    interrupted: binding.interrupted
      ? {
          runId: binding.interrupted.runId,
          messageId: binding.interrupted.messageId,
        }
      : null,
  }
}

export function getActiveRunBinding(sessionId: string): ActiveRunBinding {
  if (!sessionId) return clone(EMPTY)
  return clone(bindings.get(sessionId) ?? EMPTY)
}

/** message_start / run_sync：绑定当前 open 的 assistant 与 run。 */
export function bindActiveRun(
  sessionId: string,
  input: { runId?: string | null; assistantMessageId?: string | null },
): void {
  if (!sessionId) return
  const prev = bindings.get(sessionId) ?? EMPTY
  const nextRunId = input.runId?.trim()
  const nextMessageId = input.assistantMessageId?.trim()
  bindings.set(sessionId, {
    runId: nextRunId || prev.runId,
    activeAssistantMessageId: nextMessageId || prev.activeAssistantMessageId,
    interrupted: prev.interrupted,
  })
}

/**
 * 用户停止 / 插队：冻结当前绑定为 interrupted 快照。
 * 无 run 且无 message 时返回 null。
 */
export function snapshotInterruptedBinding(
  sessionId: string,
): InterruptedRunSnapshot | null {
  if (!sessionId) return null
  const prev = bindings.get(sessionId) ?? EMPTY
  const runId = prev.runId
  const messageId = prev.activeAssistantMessageId
  if (!runId && !messageId) return null
  const interrupted: InterruptedRunSnapshot = { runId, messageId }
  bindings.set(sessionId, {
    runId: prev.runId,
    activeAssistantMessageId: prev.activeAssistantMessageId,
    interrupted,
  })
  return interrupted
}

/** Host promote 回传的 abortedRunId 补全 / 校正快照。 */
export function noteAbortedRunId(
  sessionId: string,
  abortedRunId: string | null | undefined,
): void {
  const runId = abortedRunId?.trim()
  if (!sessionId || !runId) return
  const prev = bindings.get(sessionId) ?? EMPTY
  const messageId =
    prev.interrupted?.messageId
    ?? (prev.runId === runId ? prev.activeAssistantMessageId : null)
  bindings.set(sessionId, {
    runId: prev.runId,
    activeAssistantMessageId: prev.activeAssistantMessageId,
    interrupted: { runId, messageId },
  })
}

/** abort DONE 收口后清 interrupted。 */
export function clearInterruptedBinding(
  sessionId: string,
  abortedRunId?: string | null,
): void {
  if (!sessionId) return
  const prev = bindings.get(sessionId)
  if (!prev?.interrupted) return
  if (abortedRunId && prev.interrupted.runId && prev.interrupted.runId !== abortedRunId) {
    return
  }
  bindings.set(sessionId, {
    runId: prev.runId,
    activeAssistantMessageId: prev.activeAssistantMessageId,
    interrupted: null,
  })
}

/** 会话清理。 */
export function clearActiveRunBinding(sessionId: string): void {
  bindings.delete(sessionId)
}

/** 登录 / 登出 / 切组织：清全部绑定。 */
export function clearAllActiveRunBindings(): void {
  bindings.clear()
}

/** Test-only */
export function __resetActiveRunBindingsForTest(): void {
  clearAllActiveRunBindings()
}
