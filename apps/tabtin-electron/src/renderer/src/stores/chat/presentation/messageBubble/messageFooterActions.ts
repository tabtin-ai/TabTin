export interface StandardFooterVisibilityInput {
  previewMode?: boolean
  isStreamingTailMessage: boolean
  isLastInTurn: boolean
  isMiniMessage: boolean
  isErrorEnvelope: boolean
  isEditing: boolean
  isPushNotification: boolean
  hasStandardFooterContent: boolean
}

export function shouldRenderStandardMessageFooter(input: StandardFooterVisibilityInput): boolean {
  return !input.previewMode
    && !input.isStreamingTailMessage
    && input.isLastInTurn
    && !input.isMiniMessage
    && !input.isErrorEnvelope
    && !input.isEditing
    && !input.isPushNotification
    && input.hasStandardFooterContent
}

export interface RegenerateActionVisibilityInput {
  sessionId?: string | null
  hasRegenerateSource: boolean
  isActiveSession: boolean
  isUser: boolean
  isLastAssistantMsg: boolean
  isStreaming: boolean
  isRestoring: boolean
  runStateSuspended: boolean
  /** ：失败 Project Task 会话隐藏「重新生成 / 确认并重新发送」 */
  projectTaskResendBlocked?: boolean
}

export function shouldShowRegenerateAction(input: RegenerateActionVisibilityInput): boolean {
  return !!input.sessionId
    && input.hasRegenerateSource
    && input.isActiveSession
    && !input.isUser
    && input.isLastAssistantMsg
    && !input.isStreaming
    && !input.isRestoring
    && !input.runStateSuspended
    && !input.projectTaskResendBlocked
}

export interface RollbackActionVisibilityInput {
  isActiveSession: boolean
  isUser: boolean
  canPreviewRollback: boolean
  isStreaming: boolean
  isRestoring: boolean
  isLastAssistantMsg: boolean
}

/**
 * 「回退到此处」与「重新生成」二选一：最后一条 assistant 消息只给「重新生成」
 * （shouldShowRegenerateAction 以 isLastAssistantMsg 为条件），其后的 assistant
 * 消息才给「回退到此处」，避免最后一条同时出现两个语义重叠的按钮。
 */
export function shouldShowRollbackAction(input: RollbackActionVisibilityInput): boolean {
  return input.isActiveSession
    && !input.isUser
    && input.canPreviewRollback
    && !input.isStreaming
    && !input.isRestoring
    && !input.isLastAssistantMsg
}
