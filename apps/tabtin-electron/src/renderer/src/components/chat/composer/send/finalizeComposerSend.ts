import { toast } from '@tabtin/smartsheet-ui'
import type { TFunction } from 'i18next'
import { useSendCooldownStore } from '@/stores/chat/execution/sendCooldown'
import { isSendOnCooldown } from '@/stores/chat/execution/sendCooldown'
import type { ChatInputProps } from '../chatInputTypes'
import { resolveComposerSendRoute } from './resolveComposerSendRoute'
import { dispatchComposerSend } from './dispatchComposerSend'
import type { PreparedComposerSendContent } from './prepareComposerSendContent'
import type { MergedPresetSendPayload } from './mergePresetSendPayload'

export function finalizeComposerSend(input: {
  prepared: PreparedComposerSendContent
  presetPayload: MergedPresetSendPayload
  disabled: boolean
  wsDisconnected: boolean
  sessionId: string | null
  resolvedPresetScopeId: string | null
  allowInterruptedEditRecovery: boolean
  onSend: ChatInputProps['onSend']
  stopVoiceForSubmit: () => void
  clearInputState: () => void
  t: TFunction
}): void {
  if (!input.presetPayload.ok) return

  const sendRoute = resolveComposerSendRoute({
    hasContent: input.prepared.hasContent,
    disabled: !!input.disabled,
    messageTooLong: false,
    wsDisconnected: input.wsDisconnected,
    onCooldown: isSendOnCooldown(input.sessionId),
  })

  if (sendRoute === 'reject') {
    if (input.wsDisconnected && input.prepared.hasContent) {
      input.stopVoiceForSubmit()
      toast.error(input.t('input.wsDisconnectedSendBlocked', {
        defaultValue: '连接已断开，请恢复连接后再发送',
      }))
    }
    return
  }

  if (input.sessionId) useSendCooldownStore.getState().beginSendCooldown(input.sessionId)

  void dispatchComposerSend({
    sendRoute,
    message: input.prepared.message,
    skillSendOptions: input.prepared.skillSendOptions,
    finalAttachments: input.presetPayload.finalAttachments.length > 0 ? input.presetPayload.finalAttachments : undefined,
    finalBlocks: input.presetPayload.finalBlocks.length > 0 ? input.presetPayload.finalBlocks : undefined,
    sessionId: input.sessionId,
    resolvedPresetScopeId: input.resolvedPresetScopeId,
    allowInterruptedEditRecovery: input.allowInterruptedEditRecovery,
    onSend: input.onSend,
    stopVoiceForSubmit: input.stopVoiceForSubmit,
    clearInputState: input.clearInputState,
    t: input.t,
  })
}
