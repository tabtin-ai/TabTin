import type { ChatInputProps, ChatInputChromeProps } from './chatInputTypes'

export type OrchestrationParts = {
  props: ChatInputProps
  agentMode: ChatInputChromeProps['agentMode']
  setAgentMode: ChatInputChromeProps['setAgentMode']
  input: string
  setInput: ChatInputChromeProps['setInput']
  attachments: ChatInputChromeProps['attachments']
  isManualCompacting: boolean
  isDragOver: boolean
  slashMention: Pick<
    ChatInputChromeProps,
    | 'mentionOpen'
    | 'mentionQuery'
    | 'slashOpen'
    | 'slashQuery'
    | 'slashActiveIndex'
    | 'setSlashActiveIndex'
    | 'handleMentionSelect'
    | 'setMentionOpen'
    | 'slashOptions'
    | 'slashCatalog'
    | 'closeSkillSlash'
    | 'handleSkillSlashSelect'
  >
  llmDebug: Pick<
    ChatInputChromeProps,
    | 'snapshotModalOpen'
    | 'setSnapshotModalOpen'
    | 'debugAgentId'
    | 'setDebugAgentId'
    | 'debugAgentOptions'
    | 'effectiveSnapshots'
    | 'effectiveCloudMessages'
    | 'cloudMessageCount'
    | 'showLlmSnapshotButton'
  >
  composerUi: Pick<
    ChatInputChromeProps,
    | 'toolbarRef'
    | 'presetBtnRef'
    | 'presetPickerOpen'
    | 'setPresetPickerOpen'
    | 'queueBarDismissed'
    | 'setQueueBarDismissed'
    | 'hasAvailablePresets'
    | 'showExecutionSpaceIndicator'
    | 'canSwitchExecutionSpace'
    | 'executionSpaceTooltip'
  >
  draftFlags: Pick<
    ChatInputChromeProps,
    | 'resolvedPresetScopeId'
    | 'hasActivePresets'
    | 'hasCurrentComposerDraft'
  >
  contextRefs: Pick<
    ChatInputChromeProps,
    'conversationReferenceRefs' | 'chipContextRefs'
  >
  prefillRecovery: Pick<
    ChatInputChromeProps,
    | 'pendingInterruptedMessage'
    | 'handleRestoreInterruptedMessage'
    | 'handleDiscardInterruptedMessage'
  >
  ws: Pick<
    ChatInputChromeProps,
    'wsStatus' | 'reconnectAttempt' | 'wsDisconnected' | 'handleReconnect'
  >
  voiceIntegration: Pick<
    ChatInputChromeProps,
    | 'voiceEnabled'
    | 'voiceShortcut'
    | 'micGate'
    | 'isVoiceActive'
    | 'voiceState'
    | 'voice'
    | 'handleMicPreconnect'
    | 'handleMicClick'
  >
  handlers: Pick<
    ChatInputChromeProps,
    | 'handleInput'
    | 'handleKeyDown'
    | 'handlePaste'
    | 'handleDragOver'
    | 'handleDragLeave'
    | 'handleDrop'
    | 'handleFileSelect'
    | 'handleFileInputChange'
    | 'handleStop'
    | 'handleSend'
    | 'handleInterruptLatest'
    | 'removeAttachment'
  >
  uploadState: Pick<
    ChatInputChromeProps,
    | 'uploadProgress'
    | 'isUploadingAttachments'
    | 'handleCancelUpload'
    | 'sessionTodos'
  >
  derivedSendState: Pick<
    ChatInputChromeProps,
    | 'hasAttachments'
    | 'hasContent'
    | 'canSendMessage'
    | 'isSendCoolingDown'
    | 'queueStatusType'
    | 'compactModelSelector'
    | 'ringContextWindow'
    | 'acceptTypes'
  >
  refs: {
    textareaRef: ChatInputChromeProps['textareaRef']
    fileInputRef: ChatInputChromeProps['fileInputRef']
  }
  replyTarget: ChatInputChromeProps['replyTarget']
  agentGatewayStatus: ChatInputChromeProps['agentGatewayStatus']
}

export function buildChatInputChromeProps(parts: OrchestrationParts): ChatInputChromeProps {
  const {
    props,
    agentMode,
    setAgentMode,
    input,
    setInput,
    attachments,
    isManualCompacting,
    isDragOver,
    slashMention,
    llmDebug,
    composerUi,
    draftFlags,
    contextRefs,
    prefillRecovery,
    ws,
    voiceIntegration,
    handlers,
    uploadState,
    derivedSendState,
    refs,
    replyTarget,
    agentGatewayStatus,
  } = parts

  return {
    ...props,
    agentMode,
    setAgentMode,
    input,
    setInput,
    attachments,
    isManualCompacting,
    isDragOver,
    ...slashMention,
    ...llmDebug,
    ...refs,
    ...composerUi,
    replyTarget,
    ...draftFlags,
    ...contextRefs,
    ...prefillRecovery,
    ...handlers,
    ...ws,
    ...voiceIntegration,
    ...uploadState,
    ...derivedSendState,
    agentGatewayStatus,
  }
}
