import { useCallback } from 'react'
import { toast } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { isAttachmentStillUploading } from './useComposerAttachmentUploads'
import { MAX_MESSAGE_CHARS } from './chatInputConstants'
import type { ChatInputProps } from './chatInputTypes'
import type { ContextRef } from '../types'
import type { PresetInstance } from '../composer-presets/registry/types'
import { prepareComposerSendContent } from './send/prepareComposerSendContent'
import { mergePresetSendPayload } from './send/mergePresetSendPayload'
import { finalizeComposerSend } from './send/finalizeComposerSend'
import type { SlashCommandOption } from '../skill/skillSlashCommand'
import type { ChatAttachment } from '../types'

export interface UseChatInputSendInput {
  input: string
  attachments: ChatAttachment[]
  allContextRefs: ContextRef[]
  conversationReferenceRefs: ContextRef[]
  hasActivePresets: boolean
  activePresets: PresetInstance[]
  /** 仅表示会员/模型/权限等硬门禁；余额风险不应阻止服务端 funding preview。 */
  disabled: boolean
  wsDisconnected: boolean
  sessionId: string | null
  spaceId: string | null
  resolvedPresetScopeId: string | null
  slashOptions: SlashCommandOption[]
  buildContextBlocks: () => Array<Record<string, unknown>> | undefined
  clearInputState: () => void
  stopVoiceForSubmit: () => void
  handleManualCompact: (focus: string) => Promise<void>
  onSend: ChatInputProps['onSend']
  allowInterruptedEditRecovery: boolean
}

export function useChatInputSend({
  input,
  attachments,
  allContextRefs,
  conversationReferenceRefs,
  hasActivePresets,
  activePresets,
  disabled: hardDisabled,
  wsDisconnected,
  sessionId,
  spaceId,
  resolvedPresetScopeId,
  slashOptions,
  buildContextBlocks,
  clearInputState,
  stopVoiceForSubmit,
  handleManualCompact,
  onSend,
  allowInterruptedEditRecovery,
}: UseChatInputSendInput) {
  const { t } = useTranslation('chat')

  const handleSend = useCallback(() => {
    if (attachments.some(isAttachmentStillUploading)) {
      toast.warning(t('input.attachmentUploading', { defaultValue: '附件上传中，请稍候' }))
      return
    }
    if (attachments.some((att) => att.status === 'error')) {
      toast.warning(t('input.attachmentUploadFailed', {
        defaultValue: '有附件上传失败，请移除后重试',
      }))
      return
    }
    if (attachments.some((att) => att.status !== 'ready' || !att.fileId?.trim())) {
      toast.warning(t('input.attachmentUploading', { defaultValue: '附件上传中，请稍候' }))
      return
    }

    const prepared = prepareComposerSendContent({
      input,
      attachmentsCount: attachments.length,
      contextRefsCount: allContextRefs.length,
      hasActivePresets,
      conversationReferenceRefs,
      slashOptions,
    })

    if (prepared.compactArgs !== null) {
      void handleManualCompact(prepared.compactArgs)
      return
    }

    if (prepared.unrecognizedSlashToken) {
      toast.warning(t('input.unrecognizedSkillSlash', {
        token: prepared.unrecognizedSlashToken,
        defaultValue: '{{token}} 不是当前 Agent 已启用的 Skill。请从 / 列表选择，或先在 Agent 技能设置中添加并启用。',
      }))
      return
    }

    if (!prepared.hasContent || hardDisabled) {
      return
    }

    if (prepared.message.length > MAX_MESSAGE_CHARS) {
      toast.error(t('message_too_long', { max: MAX_MESSAGE_CHARS.toLocaleString() }))
      return
    }

    const mergedBlocks = buildContextBlocks() ?? []
    const presetPayload = mergePresetSendPayload({
      hasActivePresets,
      resolvedPresetScopeId,
      activePresets,
      mergedBlocks,
      mergedAttachments: [...attachments],
      t,
    })
    if (!presetPayload.ok) return

    const finalize = () => {
      finalizeComposerSend({
        prepared,
        presetPayload,
        disabled: hardDisabled,
        wsDisconnected,
        sessionId,
        resolvedPresetScopeId,
        allowInterruptedEditRecovery,
        onSend,
        stopVoiceForSubmit,
        clearInputState,
        t,
      })
    }

    // 正常资金路由不需要用户决策，不在每次发送前预览或弹 toast。
    // 真正的放行与扣费仍由服务端 enforce precheck 决定。
    finalize()
  }, [
    activePresets,
    allContextRefs.length,
    allowInterruptedEditRecovery,
    attachments,
    buildContextBlocks,
    clearInputState,
    conversationReferenceRefs,
    hardDisabled,
    handleManualCompact,
    hasActivePresets,
    input,
    onSend,
    resolvedPresetScopeId,
    sessionId,
    slashOptions,
    spaceId,
    stopVoiceForSubmit,
    t,
    wsDisconnected,
  ])

  return { handleSend }
}
