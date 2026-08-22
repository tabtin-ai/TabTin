import { describe, expect, it } from 'vitest'

import {
  shouldRenderStandardMessageFooter,
  shouldShowRegenerateAction,
  shouldShowRollbackAction,
  type RegenerateActionVisibilityInput,
  type RollbackActionVisibilityInput,
  type StandardFooterVisibilityInput,
} from '@stores/chat/presentation/messageBubble/messageFooterActions'

const STANDARD_FOOTER_BASE: StandardFooterVisibilityInput = {
  previewMode: false,
  isStreamingTailMessage: false,
  isLastInTurn: true,
  isMiniMessage: false,
  isErrorEnvelope: false,
  isEditing: false,
  isPushNotification: false,
  hasStandardFooterContent: true,
}

const REGENERATE_BASE: RegenerateActionVisibilityInput = {
  sessionId: 'session-1',
  hasRegenerateSource: true,
  isActiveSession: true,
  isUser: false,
  isLastAssistantMsg: true,
  isStreaming: false,
  isRestoring: false,
  runStateSuspended: false,
}

const ROLLBACK_BASE: RollbackActionVisibilityInput = {
  isActiveSession: true,
  isUser: false,
  canPreviewRollback: true,
  isStreaming: false,
  isRestoring: false,
  isLastAssistantMsg: false,
}

describe('message footer action visibility', () => {
  it('#2522 纯 thinking/tool/rich content blocks 也允许渲染标准助手工具栏', () => {
    expect(shouldRenderStandardMessageFooter(STANDARD_FOOTER_BASE)).toBe(true)
  })

  it('#2522 没有文本也没有 content blocks 时不渲染标准助手工具栏', () => {
    expect(shouldRenderStandardMessageFooter({
      ...STANDARD_FOOTER_BASE,
      hasStandardFooterContent: false,
    })).toBe(false)
  })

  it('#2522 tool_artifact 与 error_envelope 不走标准助手工具栏', () => {
    expect(shouldRenderStandardMessageFooter({
      ...STANDARD_FOOTER_BASE,
      isMiniMessage: true,
    })).toBe(false)
    expect(shouldRenderStandardMessageFooter({
      ...STANDARD_FOOTER_BASE,
      isErrorEnvelope: true,
    })).toBe(false)
  })

  it('#2522 只有最后一条可执行助手消息展示重新生成', () => {
    expect(shouldShowRegenerateAction(REGENERATE_BASE)).toBe(true)
  })

  it('#2522 缺 session 或处于运行态时不展示无效的重新生成按钮', () => {
    expect(shouldShowRegenerateAction({
      ...REGENERATE_BASE,
      sessionId: null,
    })).toBe(false)
    expect(shouldShowRegenerateAction({
      ...REGENERATE_BASE,
      hasRegenerateSource: false,
    })).toBe(false)
    expect(shouldShowRegenerateAction({
      ...REGENERATE_BASE,
      isStreaming: true,
    })).toBe(false)
    expect(shouldShowRegenerateAction({
      ...REGENERATE_BASE,
      isLastAssistantMsg: false,
    })).toBe(false)
  })

  it('#6913 失败 Project Task 会话隐藏重新生成', () => {
    expect(shouldShowRegenerateAction({
      ...REGENERATE_BASE,
      projectTaskResendBlocked: true,
    })).toBe(false)
  })

  it('#4528 非最后一条 assistant 消息展示「回退到此处」', () => {
    expect(shouldShowRollbackAction(ROLLBACK_BASE)).toBe(true)
  })

  it('#4528 最后一条 assistant 消息不展示「回退到此处」（与重新生成二选一）', () => {
    expect(shouldShowRollbackAction({
      ...ROLLBACK_BASE,
      isLastAssistantMsg: true,
    })).toBe(false)
  })

  it('#4528 回退按钮的二选一与重新生成互斥：同一条最后消息只出现其一', () => {
    // 最后一条：重新生成显示、回退隐藏
    expect(shouldShowRegenerateAction({ ...REGENERATE_BASE, isLastAssistantMsg: true })).toBe(true)
    expect(shouldShowRollbackAction({ ...ROLLBACK_BASE, isLastAssistantMsg: true })).toBe(false)
    // 非最后一条：回退显示、重新生成隐藏
    expect(shouldShowRegenerateAction({ ...REGENERATE_BASE, isLastAssistantMsg: false })).toBe(false)
    expect(shouldShowRollbackAction({ ...ROLLBACK_BASE, isLastAssistantMsg: false })).toBe(true)
  })

  it('#4528 用户消息 / 流式 / 恢复中 / 非活跃会话不展示「回退到此处」', () => {
    expect(shouldShowRollbackAction({ ...ROLLBACK_BASE, isUser: true })).toBe(false)
    expect(shouldShowRollbackAction({ ...ROLLBACK_BASE, isStreaming: true })).toBe(false)
    expect(shouldShowRollbackAction({ ...ROLLBACK_BASE, isRestoring: true })).toBe(false)
    expect(shouldShowRollbackAction({ ...ROLLBACK_BASE, isActiveSession: false })).toBe(false)
    expect(shouldShowRollbackAction({ ...ROLLBACK_BASE, canPreviewRollback: false })).toBe(false)
  })
})
