import type {
  DeliveryCapabilitySnapshot,
  SubmitSessionSnapshot,
  SubmissionGuardResult,
} from '../types'

/**
 * 产品域：发送锁 acquire 之前的提交门禁。
 * 仅依赖会话快照，不涉及配置就绪判断；权威完整性由 Host 负责。
 */
export function evaluatePreLockSubmission(
  snapshot: SubmitSessionSnapshot,
): SubmissionGuardResult {
  if (!snapshot.sessionId) {
    return {
      ok: false,
      reason: 'no_session',
      queueReason: 'no_session',
      userFeedback: 'silent',
    }
  }

  if (snapshot.restoringSessionId === snapshot.sessionId) {
    return {
      ok: false,
      reason: 'restoring',
      queueReason: 'restoring',
      userFeedback: 'restoring_toast',
    }
  }

  return { ok: true }
}

/**
 * 产品域：发送锁 acquire 之后、乐观 user 消息之前的投递门禁。
 * HITL soft-blocking 自动跳过由 {@link evaluateHitlOnSubmit} 单独处理。
 */
export function evaluateDeliverySubmission(
  snapshot: SubmitSessionSnapshot,
  delivery: DeliveryCapabilitySnapshot,
): SubmissionGuardResult {
  const sessionId = snapshot.sessionId
  if (!sessionId) {
    return {
      ok: false,
      reason: 'no_session',
      queueReason: 'no_session',
      userFeedback: 'silent',
    }
  }

  // ：HITL 不挡直送。审批 / hard ask 期间 Composer 可展开发送；消息进 host
  // ConversationRunQueue。禁止「按钮能点、门禁静默拒」双口径。soft ask 仍由
  // evaluateHitlOnSubmit 在提交时跳过面板。

  if (delivery.sendRoute === 'unavailable') {
    return {
      ok: false,
      reason: 'no_runtime',
      queueReason: 'no_runtime',
      userFeedback: 'device_required_toast',
    }
  }

  if (!delivery.modelConfigured) {
    return {
      ok: false,
      reason: 'no_model',
      queueReason: 'no_model',
      userFeedback: 'model_required_toast',
    }
  }

  return { ok: true }
}
