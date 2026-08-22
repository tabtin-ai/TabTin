import {
  useState,
  useRef,
  useCallback,
} from 'react'
import { useAgentGatewayStatus } from '@/hooks/useAgentGatewayStatus'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useContextInjectionStore } from '@/stores/useContextInjectionStore'
import { type ChatAttachment, type ContextRef } from '../types'
import type { ChatInputProps } from './chatInputTypes'

const EMPTY_CONTEXT_REFS: ContextRef[] = []
import { useChatInputSend } from './useChatInputSend'
import { useChatInputManualCompact } from './useChatInputManualCompact'
import { useChatInputAttachments } from './useChatInputAttachments'
import { useChatInputKeyboard } from './useChatInputKeyboard'
import { useChatInputPaste } from './useChatInputPaste'
import { useChatInputDropHandlers } from './useChatInputDrop'
import { useChatInputLlmDebugState } from './useChatInputLlmDebugState'
import { useChatInputDraftLifecycle } from './useChatInputDraftLifecycle'
import { useChatInputComposerUiState } from './useChatInputComposerUiState'
import { useChatInputPrefillRecovery } from './useChatInputPrefillRecovery'
import { useChatInputVoiceIntegration } from './useChatInputVoiceIntegration'
import { useChatInputSlashMentionState } from './useChatInputSlashMentionState'
import { useChatInputTextareaInput } from './useChatInputTextareaInput'
import { useChatInputDerivedSendState } from './useChatInputDerivedSendState'
import { useChatInputAgentMode } from './useChatInputAgentMode'
import { useChatInputWsState } from './useChatInputWsState'
import {
  useChatInputBrowserAnnotationListener,
  useChatInputPendingAttachmentClaim,
} from './useChatInputBrowserAnnotationListener'
import { useChatInputComposerDraftFlags } from './useChatInputComposerDraftFlags'
import { useChatInputUploadState } from './useChatInputUploadState'
import { useChatInputContextRefPartitions } from './useChatInputContextRefPartitions'
import { useChatInputClearState, useChatInputFileHandlers } from './useChatInputClearState'
import {
  resolveComposerAttachmentScopeId,
  useChatInputAttachmentPersistence,
} from './useChatInputAttachmentPersistence'
import { useComposerAutoFocus } from './useComposerAutoFocus'
import { type OrchestrationParts } from './buildChatInputChromeProps'

export function useChatInputOrchestrationCore(props: ChatInputProps): OrchestrationParts {
  const {
    onSend,
    onStop,
    allowInterruptedEditRecovery = false,
    disabled = false,
    isStreaming = false,
    contextRefs = [],
    onAddContextRef,
    onClearContextRefs,
    currentModel = null,
    currentContextTier = null,
    queueCount = 0,
    tokenUsage = null,
    chatMessages = [],
    spaceId = null,
    spaceName = null,
    onExecutionSpaceChange,
    enableAgentPicker = false,
    sessionId = null,
    presetScopeId = null,
    draftScopeKey = null,
    dropApiRef,
    acceptGlobalInputEvents = true,
  } = props

  const agentGatewayStatus = useAgentGatewayStatus()
  const replyTarget = useChatStore(s => (sessionId ? s.replyTargetBySessionId[sessionId] ?? null : null))
  const { agentMode, setAgentMode } = useChatInputAgentMode(
    sessionId,
    acceptGlobalInputEvents,
    draftScopeKey,
  )

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const draft = useChatInputDraftLifecycle(sessionId, spaceId, textareaRef)
  const { input, setInput, inputRef, inputHistoryRef, historyIndexRef, lastHistoryCommitRef, draftKey } = draft

  // 进入对话 / 切会话 / 发送期 disabled 解除后拉回输入焦点（分屏非活跃不抢）
  useComposerAutoFocus({
    textareaRef,
    draftKey,
    sessionId,
    disabled,
    acceptGlobalInputEvents,
  })

  const attachmentScopeId = resolveComposerAttachmentScopeId(presetScopeId, sessionId)
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [isManualCompacting, setIsManualCompacting] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)

  const llmDebug = useChatInputLlmDebugState(sessionId)
  const composerUi = useChatInputComposerUiState(
    spaceName,
    queueCount,
    onExecutionSpaceChange,
    enableAgentPicker,
  )
  const ws = useChatInputWsState()

  const slashMention = useChatInputSlashMentionState({
    input,
    setInput,
    textareaRef,
    spaceId,
    sessionId,
    onAddContextRef,
  })
  const {
    mentionOpen,
    mentionQuery,
    slashOpen,
    slashQuery,
    slashActiveIndex,
    setSlashActiveIndex,
    setMentionQuery,
    setMentionAnchorPos,
    setSlashOpen,
    setSlashQuery,
    setSlashAnchorPos,
    slashOptions,
    slashCatalog,
    closeSkillSlash,
    handleMentionSelect,
    handleSkillSlashSelect,
    setMentionOpen,
  } = slashMention

  const voiceIntegration = useChatInputVoiceIntegration({
    chatMessages,
    setInput,
    textareaRef,
    input,
    acceptGlobalInputEvents,
    disabled,
    wsDisconnected: ws.wsDisconnected,
  })

  // 与 pending 附件同口径：按 presetScopeId 直读 store，避免 ChatContent memo /
  // Activity 显隐时 props 停在空数组，而交接引用其实已写入 `__draft__:{spaceId}`。
  const storeContextRefs = useContextInjectionStore(
    useCallback(
      (state) => {
        const scopeId = presetScopeId ?? null
        if (!scopeId) return null
        return state.contextRefsByScopeId[scopeId] ?? EMPTY_CONTEXT_REFS
      },
      [presetScopeId],
    ),
  )
  const allContextRefs = storeContextRefs ?? contextRefs
  useChatInputBrowserAnnotationListener({ acceptGlobalInputEvents, setAttachments, onAddContextRef })
  // 领取「composer 未挂载时排队」的附件（ 工作台浏览器注释兜底 /  切页 stash）
  useChatInputPendingAttachmentClaim(presetScopeId, sessionId, setAttachments)
  const { discardAttachmentDraft } = useChatInputAttachmentPersistence(attachmentScopeId, attachments)

  const {
    attachmentsUploading,
    cancelAllUploads,
    addFiles,
    removeAttachment,
  } = useChatInputAttachments(attachments, setAttachments)

  const {
    conversationReferenceRefs,
    chipContextRefs,
    buildContextBlocks,
  } = useChatInputContextRefPartitions(allContextRefs)

  const draftFlags = useChatInputComposerDraftFlags({
    presetScopeId,
    sessionId,
    input,
    attachmentsCount: attachments.length,
    contextRefCount: allContextRefs.length,
    replyTarget,
  })
  const {
    resolvedPresetScopeId,
    activePresets,
    hasActivePresets,
    hasCurrentComposerDraft,
  } = draftFlags

  const clearInputState = useChatInputClearState({
    draftKey,
    attachmentScopeId,
    discardAttachmentDraft,
    setInput,
    inputRef,
    inputHistoryRef,
    historyIndexRef,
    lastHistoryCommitRef,
    cancelAllUploads,
    attachments,
    setAttachments,
    onClearContextRefs,
    setMentionOpen,
    closeSkillSlash,
    textareaRef,
  })

  const prefillRecovery = useChatInputPrefillRecovery({
    sessionId,
    input,
    onAddContextRef,
    setInput,
    setAttachments,
    textareaRef,
    clearInputState,
    hasCurrentComposerDraft,
  })

  const { handleManualCompact } = useChatInputManualCompact({
    sessionId,
    spaceId,
    attachments,
    allContextRefs,
    hasActivePresets,
    activePresets,
    isManualCompacting,
    setIsManualCompacting,
    currentModel,
    currentContextTier,
    agentMode,
    clearInputState,
  })

  const { handleSend } = useChatInputSend({
    input,
    attachments,
    allContextRefs,
    conversationReferenceRefs,
    hasActivePresets,
    activePresets,
    disabled,
    wsDisconnected: ws.wsDisconnected,
    sessionId: sessionId ?? null,
    spaceId,
    resolvedPresetScopeId,
    slashOptions: slashCatalog,
    buildContextBlocks,
    clearInputState,
    stopVoiceForSubmit: voiceIntegration.stopVoiceForSubmit,
    handleManualCompact,
    onSend,
    allowInterruptedEditRecovery,
  })

  const handleInterruptLatest = useCallback(() => {
    if (!sessionId) return
    void useChatStore.getState().interruptAndPromoteLatestHostPending(sessionId)
  }, [sessionId])

  const { handleKeyDown } = useChatInputKeyboard({
    slashOpen,
    mentionOpen,
    slashOptions,
    slashCatalog,
    slashActiveIndex,
    setSlashActiveIndex,
    closeSkillSlash,
    handleSkillSlashSelect,
    handleSend,
    handleInterruptLatest,
    queueCount,
    isStreaming: !!isStreaming,
    input,
    inputHistoryRef,
    historyIndexRef,
    setInput,
    textareaRef,
  })

  const { handleInput } = useChatInputTextareaInput({
    setInput,
    inputHistoryRef,
    historyIndexRef,
    lastHistoryCommitRef,
    mentionOpen,
    slashOpen,
    setMentionOpen,
    setMentionQuery,
    setMentionAnchorPos,
    setSlashOpen,
    setSlashQuery,
    setSlashAnchorPos,
    setSlashActiveIndex,
    closeSkillSlash,
  })

  const { handlePaste } = useChatInputPaste({
    input,
    setInput,
    inputRef,
    allContextRefs,
    onAddContextRef,
    onRemoveContextRef: props.onRemoveContextRef,
    addFiles,
  })

  const {
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useChatInputDropHandlers({
    setIsDragOver,
    addFiles,
    onAddContextRef,
    resolvedPresetScopeId,
    dropApiRef,
    setAttachments,
  })

  const {
    handleFileSelect,
    handleFileInputChange,
    handleStop,
  } = useChatInputFileHandlers(fileInputRef, addFiles, onStop)

  const uploadState = useChatInputUploadState(sessionId)

  const derivedSendState = useChatInputDerivedSendState({
    input,
    attachments,
    allContextRefs,
    hasActivePresets,
    disabled,
    isManualCompacting,
    attachmentsUploading,
    queueCount,
    sessionId,
    compactModelSelector: composerUi.compactModelSelector,
    tokenUsage,
    currentContextTier,
    currentModel,
  })

  return {
    props,
    agentMode,
    setAgentMode,
    input,
    setInput,
    attachments,
    isManualCompacting,
    isDragOver,
    slashMention: {
      mentionOpen,
      mentionQuery,
      slashOpen,
      slashQuery,
      slashActiveIndex,
      setSlashActiveIndex,
      handleMentionSelect,
      setMentionOpen,
      slashOptions,
      slashCatalog,
      closeSkillSlash,
      handleSkillSlashSelect,
    },
    llmDebug,
    composerUi,
    draftFlags: {
      resolvedPresetScopeId,
      hasActivePresets,
      hasCurrentComposerDraft,
    },
    contextRefs: {
      conversationReferenceRefs,
      chipContextRefs,
    },
    prefillRecovery,
    ws,
    voiceIntegration,
    handlers: {
      handleInput,
      handleKeyDown,
      handlePaste,
      handleDragOver,
      handleDragLeave,
      handleDrop,
      handleFileSelect,
      handleFileInputChange,
      handleStop,
      handleSend,
      handleInterruptLatest,
      removeAttachment,
    },
    uploadState,
    derivedSendState,
    refs: { textareaRef, fileInputRef },
    replyTarget,
    agentGatewayStatus,
  }
}
