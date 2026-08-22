import type { ChatAttachment } from '../../../../components/chat/types'
import { message as notify } from '@tabtin/smartsheet-ui/message'
import i18n from '@/i18n'
import { resolvePresetBlocks } from '../../../../components/chat/composer-presets/resolvePresetBlocks'
import { resolveComposerPresetSkillInvoke } from '../actions/composerPresetPrompt'
import { isAttachmentReadyForHostSend } from '../product/delivery/attachmentSendGate'
import { prefillComposerAfterBlockedSend } from './prefillComposerAfterBlockedSend'
import { toSerializableAttachments } from '../actions/sendDispatchInputs'
import { useChatRuntimeStore } from '../../../useChatRuntimeStore'
import type { SendMessageOptions } from '../actions/sendMessageTypes'
import type { PendingUserSend } from './optimisticUserSend'

export type PrepareOutboundSendMaterialResult =
  | { ok: false }
  | {
      ok: true
      uploadedAttachments: ChatAttachment[] | undefined
      contextBlocks: Array<Record<string, unknown>> | undefined
      effectiveSkillSlashInvoke: { skillKey: string; args?: string } | undefined
    }

/**
 * 附件 ready 门禁、composer preset 解析、skill invoke、中断编辑恢复登记。
 * 附件回写只改 pending draft（发送区持稿，不上时间线）。
 */
export async function prepareOutboundSendMaterial(params: {
  sessionId: string
  message: string
  visibleMessage: string
  attachments: ChatAttachment[] | undefined
  contextBlocks: Array<Record<string, unknown>> | undefined
  options: SendMessageOptions | undefined
  pending: PendingUserSend
  log: { warn: (...args: unknown[]) => void }
  setSendInFlight: (sessionId: string, inFlight: boolean) => void
}): Promise<PrepareOutboundSendMaterialResult> {
  const {
    sessionId,
    message,
    visibleMessage,
    attachments,
    options,
    pending,
    log,
    setSendInFlight,
  } = params
  let contextBlocks = params.contextBlocks

  const hasAttachments = Boolean(attachments && attachments.length > 0)
  const readyAttachments = (attachments ?? []).filter(isAttachmentReadyForHostSend)
  if (hasAttachments) {
    const notReady = (attachments ?? []).filter((att) => !isAttachmentReadyForHostSend(att))
    if (notReady.length > 0) {
      log.warn('[sendMessage] attachments not ready at send', {
        count: notReady.length,
        statuses: notReady.map((att) => att.status),
      })
      notify.warning(i18n.t('chat:input.attachmentUploading', {
        defaultValue: '附件上传中，请稍候',
      }))
      setSendInFlight(sessionId, false)
      prefillComposerAfterBlockedSend(sessionId, visibleMessage, attachments, contextBlocks)
      return { ok: false }
    }
    pending.applyReadyAttachments(readyAttachments)
  }
  const uploadedAttachments = readyAttachments.length > 0 ? readyAttachments : undefined

  if (contextBlocks && contextBlocks.length > 0) {
    const hasPending = contextBlocks.some(b => b.type === '_composer_preset_pending')
    if (hasPending) {
      contextBlocks = await resolvePresetBlocks(contextBlocks, uploadedAttachments ?? [])
    }
  }

  const effectiveSkillSlashInvoke =
    options?.skillSlashInvoke ?? resolveComposerPresetSkillInvoke(contextBlocks ?? []) ?? undefined

  if (options?.allowInterruptedEditRecovery) {
    useChatRuntimeStore.getState().setActiveSubmittedMessageForSession(sessionId, {
      clientMessageId: pending.clientMessageId,
      localMessageId: pending.userMessageId,
      message,
      attachments: toSerializableAttachments(uploadedAttachments),
      contextBlocks: contextBlocks && contextBlocks.length > 0 ? contextBlocks : undefined,
      replyTo: pending.replyTo,
    })
  }

  return {
    ok: true,
    uploadedAttachments,
    contextBlocks,
    effectiveSkillSlashInvoke,
  }
}
