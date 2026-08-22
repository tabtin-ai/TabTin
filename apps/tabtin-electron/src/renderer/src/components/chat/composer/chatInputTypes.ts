import type { Model, AskUserAnswer, ContextTier, ModelParamOverrides, ModelParamValue } from '@tabtin/chat-client'
import type {
  AgentModeName,
  AskUserRequestState,
  ApprovalRequestState,
} from '../../../stores/chat/shared/types'
import type { ChatAttachment, ContextRef, ContextRefType } from '../types'
import type { PerToolApprovalDecision } from '../approval/ApprovalPanel'

export interface ChatInputSendOptions {
  displayMessage?: string
  /** 仅主 Composer 透传，允许 Stop 将本轮输入恢复为可编辑草稿。 */
  allowInterruptedEditRecovery?: boolean
  /**
   *  斜杠命令直链 Skill：用户通过 `/skill args` 明确选定 Skill 时携带。
   * 透传到 runtime，首次 LLM 调用前确定性展开，消除斜杠场景冗余的第二条 user 输入。
   */
  skillSlashInvoke?: {
    skillKey: string
    args?: string
  }
  /** 当前发送所在的 Space，由 ChatPanel / split pane 注入，避免全局 selectedSpace race。 */
  spaceId?: string | null
  /** 当前 workspace tab scope，由上层 ChatPanel 注入；不是用户/LLM 可控字段。 */
  tabScopeKey?: string | null
  /**  引用回复：本条消息引用的被引用消息（来自 store 的 replyTarget）。 */
  replyTo?: {
    messageId: string
    preview: { role: 'user' | 'assistant' | 'system' | 'tool'; author?: string; text: string }
  }
}

export interface ChatInputProps {
  onSend: (message: string, attachments?: ChatAttachment[], contextBlocks?: Array<Record<string, unknown>>, options?: ChatInputSendOptions) => void
  /** 默认 Stop：已发送不恢复（输入区只有一个停止钮） */
  onStop?: () => void
  /** 仅主 Composer 开启；供气泡 Edit / 改口路径登记本轮快照，不用于 Stop 自动回填。 */
  allowInterruptedEditRecovery?: boolean
  disabled?: boolean
  disabledReason?: string | null
  isStreaming?: boolean
  contextRefs?: ContextRef[]
  onAddContextRef?: (
    type: ContextRefType,
    resourceId: string,
    label: string,
    extra?: Partial<ContextRef>,
  ) => void
  onRemoveContextRef?: (id: string) => void
  onClearContextRefs?: () => void
  /** 是否展示添加附件 / Skill / MCP / 引用入口；权限受限会话可关闭。 */
  showAddMenu?: boolean
  models?: Model[]
  currentModel?: Model | null
  onModelChange?: (modelId: string, tierId?: string, controlChange?: { key: string; value: ModelParamValue }) => void
  /** 当前会话是否允许修改模型及其运行参数；不影响输入框发言能力。 */
  canChangeModel?: boolean
  /** 无模型修改权限时，仅展示服务端会话详情中的模型名称。 */
  readOnlyModelName?: string | null
  currentContextTier?: ContextTier | null
  currentModelParamOverrides?: ModelParamOverrides | null
  isLoadingModels?: boolean
  modelLoadError?: string | null
  onRetryLoadModels?: () => void
  pendingApproval?: ApprovalRequestState | null
  onApprovalSubmit?: (decisions: PerToolApprovalDecision[]) => void
  isApprovalSubmitting?: boolean
  onApprovalDismiss?: (reason: 'expired' | 'manual') => void
  pendingAskUser?: AskUserRequestState | null
  onAskUserSubmit?: (answers: AskUserAnswer[]) => void
  onAskUserTextSubmit?: (text: string) => void
  onAskUserFieldsSubmit?: (fieldValues: Record<string, unknown>) => void
  onAskUserApprovalSubmit?: (approved: boolean) => void
  onAskUserSkip?: () => void
  isAskUserSubmitting?: boolean
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    contextTokens: number
    contextSource?: 'last_call' | 'turn_accum' | 'post_compact' | 'none'
    contextWindow: number
    estimatedCost?: number
    creditsConsumed?: number
    cacheReadTokens?: number
    hasCacheReadTokens?: boolean
    compactInputTokens?: number
    reasoningTokens?: number
    chargeFailed?: boolean
    isByok?: boolean
    hasMixedBilling?: boolean
  } | null
  /**
   * Agent 仍在处理或排队中的条数（停止铬 / 在线黄条）。
   */
  queueCount?: number
  /** ：点发送 → Host ACK 期间，发送钮显示 loading */
  isSendInFlight?: boolean
  compactLeft?: boolean
  chatMessages?: Array<{ role: string; content: string }>
  spaceId?: string | null
  spaceName?: string | null
  onExecutionSpaceChange?: (spaceId: string) => void
  tabScopeKey?: string | null
  sessionId?: string | null
  presetScopeId?: string | null
  fieldTableId?: string | null
  fieldTableName?: string | null
  contextDisplay?: { icon: string; label: string; name?: string | null } | null
  modeAccessory?: React.ReactNode
  /**
   * @deprecated 工作空间底栏切换仍读此 prop；Agent 身份请用 canChangeAgent。
   */
  enableAgentPicker?: boolean
  /** ：个人正式会话也可换 Agent；勿与 enableAgentPicker 绑死 */
  canChangeAgent?: boolean
  /** opaque draft scope，透传给 Agent 身份选择 */
  draftScopeKey?: string | null
  /** 是否展示 Agent 身份（与 Mode 正交，） */
  showAgentIdentity?: boolean
  /** 新任务欢迎首屏：输入区加高（首屏比例） */
  composerWelcomeLayout?: boolean
  dropApiRef?: React.MutableRefObject<{
    ingestFiles: (files: File[]) => void
    ingestAttachments?: (attachments: ChatAttachment[]) => void
  } | null>
  acceptGlobalInputEvents?: boolean
}

export interface ChatInputChromeProps extends ChatInputProps {
  agentMode: AgentModeName
  setAgentMode: (mode: AgentModeName) => void
  input: string
  setInput: React.Dispatch<React.SetStateAction<string>>
  attachments: ChatAttachment[]
  isManualCompacting: boolean
  isDragOver: boolean
  mentionOpen: boolean
  mentionQuery: string
  slashOpen: boolean
  slashQuery: string
  slashActiveIndex: number
  setSlashActiveIndex: React.Dispatch<React.SetStateAction<number>>
  snapshotModalOpen: boolean
  setSnapshotModalOpen: (open: boolean) => void
  debugAgentId: string
  setDebugAgentId: (id: string) => void
  debugAgentOptions: Array<{ id: string; label: string }>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  effectiveSnapshots: any[]
  effectiveCloudMessages: import('@tabtin/chat-client').ChatMessage[]
  cloudMessageCount: number
  showLlmSnapshotButton: boolean
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  fileInputRef: React.RefObject<HTMLInputElement | null>
  toolbarRef: React.RefObject<HTMLDivElement | null>
  presetBtnRef: React.RefObject<HTMLButtonElement | null>
  presetPickerOpen: boolean
  setPresetPickerOpen: React.Dispatch<React.SetStateAction<boolean>>
  queueBarDismissed: boolean
  setQueueBarDismissed: React.Dispatch<React.SetStateAction<boolean>>
  hasAvailablePresets: boolean
  showExecutionSpaceIndicator: boolean
  canSwitchExecutionSpace: boolean
  executionSpaceTooltip: string
  replyTarget: ChatInputSendOptions['replyTo'] | null | undefined
  resolvedPresetScopeId: string | null
  conversationReferenceRefs: ContextRef[]
  chipContextRefs: ContextRef[]
  hasActivePresets: boolean
  hasCurrentComposerDraft: boolean
  pendingInterruptedMessage: boolean
  handleRestoreInterruptedMessage: () => void
  handleDiscardInterruptedMessage: () => void
  handleMentionSelect: (item: import('../types').MentionItem) => void
  setMentionOpen: (open: boolean) => void
  slashOptions: import('../skill/skillSlashCommand').SlashCommandOption[]
  /** 未按 query 过滤的完整斜杠目录（pill 高亮 / 发送解析） */
  slashCatalog: import('../skill/skillSlashCommand').SlashCommandOption[]
  closeSkillSlash: () => void
  handleSkillSlashSelect: (option: import('../skill/skillSlashCommand').SlashCommandOption) => void
  removeAttachment: (id: string) => void
  wsStatus: string
  reconnectAttempt: number
  wsDisconnected: boolean
  handleReconnect: () => Promise<void>
  voiceEnabled: boolean
  voiceShortcut: string
  micGate: ReturnType<typeof import('../voice/useMicrophonePermissionGate').useMicrophonePermissionGate>
  isVoiceActive: boolean
  voiceState: ReturnType<typeof import('../voice/useVoiceRecording').useVoiceRecording>['state']
  voice: ReturnType<typeof import('../voice/useVoiceRecording').useVoiceRecording>
  handleMicPreconnect: () => void
  handleMicClick: () => void
  handleInput: (event: React.ChangeEvent<HTMLTextAreaElement>) => void
  handleKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  handlePaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void
  handleDragOver: (event: React.DragEvent) => void
  handleDragLeave: (event: React.DragEvent) => void
  handleDrop: (event: React.DragEvent) => void
  handleFileSelect: () => void
  handleFileInputChange: (event: React.ChangeEvent<HTMLInputElement>) => void
  handleStop: () => void
  uploadProgress: number | undefined
  isUploadingAttachments: boolean
  handleCancelUpload: () => void
  sessionTodos: import('@stores/chat/shared/types').TodoItem[]
  hasAttachments: boolean
  hasContent: boolean
  canSendMessage: boolean
  isSendCoolingDown: boolean
  queueStatusType: 'streaming' | null
  compactModelSelector: boolean
  ringContextWindow: number
  acceptTypes: string
  agentGatewayStatus: string
  handleSend: () => void
  /** Host 级插队最新排队项（空回车 / Zap） */
  handleInterruptLatest?: () => void
}
