import type { TFunction } from 'i18next'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useComposerPresetStore } from '@/stores/useComposerPresetStore'
import type { ChatAttachment } from '../../types'
import type { ChatInputSendOptions } from '../chatInputTypes'
import type { ComposerSendRoute } from './resolveComposerSendRoute'

export interface ComposerSendDispatchInput {
  sendRoute: ComposerSendRoute
  message: string
  skillSendOptions: ChatInputSendOptions | undefined
  finalAttachments: ChatAttachment[] | undefined
  finalBlocks: Array<Record<string, unknown>> | undefined
  sessionId: string | null
  resolvedPresetScopeId: string | null
  allowInterruptedEditRecovery: boolean
  onSend: (message: string, attachments?: ChatAttachment[], contextBlocks?: Array<Record<string, unknown>>, options?: ChatInputSendOptions) => void
  stopVoiceForSubmit: () => void
  clearInputState: () => void
  t: TFunction
}

function clearReplyAndPresets(
  sessionId: string | null,
  replyTarget: ChatInputSendOptions['replyTo'] | null,
  resolvedPresetScopeId: string | null,
) {
  if (sessionId && replyTarget) useChatStore.getState().clearReplyTarget(sessionId)
  if (resolvedPresetScopeId) useComposerPresetStore.getState().clearAllPresets(resolvedPresetScopeId)
}

export async function dispatchComposerSend(input: ComposerSendDispatchInput): Promise<void> {
  const replyTarget = input.sessionId
    ? useChatStore.getState().replyTargetBySessionId[input.sessionId] ?? null
    : null

  const sendOptions: ChatInputSendOptions | undefined =
    (input.skillSendOptions || replyTarget || input.allowInterruptedEditRecovery)
      ? {
          ...(input.skillSendOptions ?? {}),
          ...(replyTarget ? { replyTo: replyTarget } : {}),
          ...(input.allowInterruptedEditRecovery ? { allowInterruptedEditRecovery: true } : {}),
        }
      : undefined

  input.stopVoiceForSubmit()
  input.onSend(input.message, input.finalAttachments, input.finalBlocks, sendOptions)
  // ：发送区持稿 + loading，ACK 成功后再清（requestComposerClearAfterSend）。
  // 失败时正文留在输入框可改可重试。reply / preset 仍立即清，避免重复挂载。
  clearReplyAndPresets(input.sessionId, replyTarget, input.resolvedPresetScopeId)
}
