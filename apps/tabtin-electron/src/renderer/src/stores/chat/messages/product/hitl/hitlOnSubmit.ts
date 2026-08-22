import type { AskUserRequestState } from '../../../shared/types'

/** 产品域：soft-blocking AskUser 在新消息提交时的处理计划（纯数据，无 IPC）。 */
export type SoftAskUserSubmitPlan = {
  clearPendingAskUser: true
  clearAskUserSubmitting: true
  ipcSkip?: {
    interruptId: string
    threadId?: string
  }
  appendAutoSkippedSystemMessage: true
}

export type HitlOnSubmitResult =
  | { action: 'none' }
  | { action: 'apply_soft_skip'; plan: SoftAskUserSubmitPlan }

/**
 * 产品域：用户在有 pending AskUser 时提交新消息。
 * hard-blocking 已在 delivery guard 阻断；此处只处理 soft-blocking 自动跳过。
 */
export function evaluateHitlOnSubmit(
  pendingAskUser: AskUserRequestState | undefined,
  runtimeBridgeAvailable: boolean,
): HitlOnSubmitResult {
  if (!pendingAskUser) {
    return { action: 'none' }
  }

  if ((pendingAskUser.blockingPolicy ?? 'soft') === 'hard') {
    return { action: 'none' }
  }

  const plan: SoftAskUserSubmitPlan = {
    clearPendingAskUser: true,
    clearAskUserSubmitting: true,
    appendAutoSkippedSystemMessage: true,
  }

  const interruptId = pendingAskUser.interruptId
  if (interruptId && runtimeBridgeAvailable) {
    plan.ipcSkip = {
      interruptId,
      threadId: pendingAskUser.threadId,
    }
  }

  return { action: 'apply_soft_skip', plan }
}

/** 产品域：soft skip 后写入 store 的 pending/submitting 补丁形状。 */
export function buildSoftAskUserStoreClearPatch(
  sessionId: string,
  pendingBySessionId: Record<string, AskUserRequestState>,
  submittingBySessionId: Record<string, boolean>,
): {
  pendingAskUserBySessionId: Record<string, AskUserRequestState>
  askUserSubmittingBySessionId: Record<string, boolean>
} {
  const nextPendingAskUser = { ...pendingBySessionId }
  delete nextPendingAskUser[sessionId]
  const nextSubmitting = { ...submittingBySessionId }
  delete nextSubmitting[sessionId]
  return {
    pendingAskUserBySessionId: nextPendingAskUser,
    askUserSubmittingBySessionId: nextSubmitting,
  }
}
