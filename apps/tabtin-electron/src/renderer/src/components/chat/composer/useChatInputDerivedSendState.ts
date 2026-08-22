import type { Model, ContextTier } from '@tabtin/chat-client'
import { useSendCooldownStore } from '@/stores/chat/execution/sendCooldown'
import { computeComposerAcceptTypes } from './modelAttachmentCapabilities'

interface DerivedSendStateParams {
  input: string
  attachments: Array<unknown>
  allContextRefs: Array<unknown>
  hasActivePresets: boolean
  disabled: boolean
  isManualCompacting: boolean
  attachmentsUploading: boolean
  /** Agent 排队 / 处理中条数（在线） */
  queueCount: number
  sessionId: string | null | undefined
  compactModelSelector: boolean
  tokenUsage: {
    contextWindow: number
  } | null | undefined
  currentContextTier: ContextTier | null | undefined
  currentModel: Model | null | undefined
}

/** 在线 Host 排队黄条；断网不再展示离线缓冲条。 */
export function computeQueueStatusType(queueCount: number): 'streaming' | null {
  return queueCount > 0 ? 'streaming' : null
}

/**
 * 停止铬 = 真 busy，或在线排队非空。
 */
export function computeShowComposerStopChrome(
  isStreaming: boolean | undefined,
  queueCount: number,
): boolean {
  if (isStreaming) return true
  return queueCount > 0
}

function computeRingContextWindow(
  tokenUsage: DerivedSendStateParams['tokenUsage'],
  currentContextTier: ContextTier | null | undefined,
  currentModel: Model | null | undefined,
): number {
  return tokenUsage?.contextWindow
    || currentContextTier?.max_input_tokens
    || currentModel?.context_window_tokens
    || currentModel?.max_tokens
    || 0
}

export function useChatInputDerivedSendState(params: DerivedSendStateParams) {
  const {
    input,
    attachments,
    allContextRefs,
    hasActivePresets,
    disabled,
    isManualCompacting,
    attachmentsUploading,
    queueCount,
    sessionId,
    compactModelSelector,
    tokenUsage,
    currentContextTier,
    currentModel,
  } = params

  const hasAttachments = attachments.length > 0
  const hasContent = input.trim().length > 0 || hasAttachments || allContextRefs.length > 0 || hasActivePresets
  const canSendMessage = hasContent && !disabled && !isManualCompacting && !attachmentsUploading
  const isSendCoolingDown = useSendCooldownStore(
    s => (sessionId ? (s.cooldownUntilBySessionId[sessionId] ?? 0) > Date.now() : false),
  )

  return {
    hasAttachments,
    hasContent,
    canSendMessage,
    isSendCoolingDown,
    queueStatusType: computeQueueStatusType(queueCount),
    compactModelSelector,
    ringContextWindow: computeRingContextWindow(tokenUsage, currentContextTier, currentModel),
    acceptTypes: computeComposerAcceptTypes(),
  }
}
