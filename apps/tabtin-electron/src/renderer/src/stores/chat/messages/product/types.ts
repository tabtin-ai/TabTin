import type { QueueFlushFailReason } from '../../../../components/chat/types'
import type {
  ApprovalRequestState,
  AskUserRequestState,
} from '../../shared/types'

/** 产品域：用户提交一条消息前的会话上下文快照（无 store / IPC）。 */
export interface SubmitSessionSnapshot {
  sessionId: string | null
  restoringSessionId: string | null
  pendingApprovalBySessionId: Record<string, ApprovalRequestState>
  pendingAskUserBySessionId: Record<string, AskUserRequestState>
}

/** 产品域：投递目标判定输入（只读 route，不做派发）。 */
export interface DeliveryCapabilitySnapshot {
  sendRoute: 'runtime' | 'gateway' | 'unavailable'
  modelConfigured: boolean
}

export type SubmissionRejectReason =
  | 'no_session'
  | 'restoring'
  | 'awaiting_approval'
  | 'awaiting_ask_user'
  | 'no_runtime'
  | 'no_model'
  | 'project_task_run_required'

/** 阻断提交时，action 层如何反馈用户（产品规则，不含具体 toast 文案实现）。 */
export type SubmissionUserFeedback =
  | 'silent'
  | 'restoring_toast'
  | 'device_required_toast'
  | 'model_required_toast'
  | 'project_task_run_required_toast'

export type BlockedSubmission = {
  ok: false
  reason: SubmissionRejectReason
  queueReason: QueueFlushFailReason
  userFeedback: SubmissionUserFeedback
}

export type AllowedSubmission = {
  ok: true
}

export type SubmissionGuardResult = BlockedSubmission | AllowedSubmission

export function isBlockedSubmission(
  result: SubmissionGuardResult,
): result is BlockedSubmission {
  return result.ok === false
}
