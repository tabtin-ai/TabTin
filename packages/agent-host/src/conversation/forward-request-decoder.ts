/**
 * `agent.prompt.forward` envelope → shared ForwardConversationRequest.
 *
 * Both hosts (Electron, Daemon) route inbound wire envelopes through this
 * decoder. It runs `PromptForwardPayloadSchema.safeParse` once — schema
 * failure and missing-content are surfaced as distinct outcomes so the
 * platform adapter can decide whether to reply with a terminal error
 * (Daemon: relay `stream.done(error)`; Electron: lifecycle error).
 *
 * Keeping the parse here is the single decode path: `daemon.ts` no longer
 * re-runs `safeParse` inside `routeToLocalAgentHost`; it consumes the
 * typed `parsedPayload` and camelCase fields on the returned request.
 */
import {
  decodeWirePendingApprovals,
  decodeWirePendingSingleHitl,
} from '@tabtin/agent-runtime'
import type { AgentModeName } from '@tabtin/agent-modes'
import type { AppContext } from '../hooks/index.js'
import type {
  ContentBlock,
  SerializedPendingApproval,
  SerializedPendingSingleHitl,
} from '@tabtin/agent-runtime/engine'
import type { WorkspaceSnapshot } from '@tabtin/security-policy'
import {
  PromptForwardPayloadSchema,
  type PromptForwardPayload,
  type AgentBackendConfig,
  type AttachmentStrategy,
  type AuthorizationRules,
  type DevicePermissions,
  type ExecutionLimits,
  type OperationSwitches,
  type SubagentConfigDto,
} from '@tabtin/agent-wire'
import {
  decodeCloudPressureThresholds,
  type HostRuntimeOptionsLogger,
} from '../configuration/host-runtime-options.js'
import {
  deriveRelaySessionId,
} from './conversation-identity.js'
import { decodeForwardWorkspaceSnapshot } from './workspace-snapshot-decoder.js'

export interface ForwardRequestLogger extends HostRuntimeOptionsLogger {
  debug(message: string): void
}

export interface ForwardEnvelope {
  payload?: unknown
  thread_id?: string
}

export interface ForwardConversationRequest {
  prompt: string
  interruptActive?: boolean
  threadId: string
  runId?: string
  relaySessionId?: string
  taskId?: string
  modelId?: string
  systemPrompt?: string
  agentId?: string
  /** ：执行场 Workspace id（wire `payload.workspace_id`）。 */
  workspaceId?: string
  clientMessageId?: string
  senderUserId?: string
  yoloMode?: boolean
  approvalMode?: string
  /**
   * ：Agent 已授权的最高审批档位（Django 权威值）。host 用来做升档闸门
   * AND，与 `approvalMode` (requested) 一起决定 effective grant。
   */
  approvalGrant?: 'always_ask' | 'auto' | 'full_access'
  customRules?: string
  /** ：Agent 展示名（wire `agent_name`）→ 用户消息前 `<context type="agent-profile">` */
  agentName?: string
  personalRules?: string
  organizationId?: string
  organizationName?: string
  spaceId?: string
  spaceName?: string
  attachments?: Array<{
    type: string
    file_id?: string
    filename?: string
    mime_type?: string
    size?: number
    url?: string
    preview_url?: string
  }>
  /** ：用户 context / 结构化块（wire `user_message_blocks`） */
  userMessageBlocks?: Array<Record<string, unknown>>
  /**
   *  / ：斜杠 / quick-use Skill 直链（wire `skill_slash_invoke`）。
   * Host 写入 runtime `skillSlashInvoke`；缺省时可从 composer_preset 派生。
   */
  skillSlashInvoke?: { skillKey: string; args?: string }
  appContext?: AppContext
  workspaceSnapshot?: WorkspaceSnapshot
  agentMode?: AgentModeName
  interactionMode?: 'interactive' | 'solo' | 'scheduled' | 'batch'
  isGroupSpace?: boolean
  history?: Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }>
  modelContextWindow?: number
  modelMaxOutput?: number
  cloudPressureThresholds?: {
    microCompactStart: number
    llmSummaryStart: number
    emergencyStart: number
  }
  modelSupportsVision?: boolean
  /** ：当前模型是否支持原生视频输入（video_url） */
  modelSupportsVideoInput?: boolean
  /** ：当前模型是否支持原生文档输入（file_url） */
  modelSupportsDocumentInput?: boolean
  modelSupportsFunctionCalling?: boolean
  modelCapabilitiesConfig?: Record<string, unknown>
  modelProvider?: string
  pendingApprovalsSerialized?: SerializedPendingApproval[]
  /**
   * ：单 HITL 断点恢复（ask_* / permission_request）未决快照，
   * 与 `pendingApprovalsSerialized` 对称从 wire `interrupt_state.pending_single_hitl`
   * 解出。
   */
  pendingSingleHitlSerialized?: SerializedPendingSingleHitl[]
  /** W7b M3：用户在 Space Settings → Security 配置的细粒度操作开关。 */
  operationSwitches?: OperationSwitches
  /** W7b M3：类别级授权规则（read/write/install/...），主要给 Daemon 用。 */
  authorizationRules?: AuthorizationRules
  /** W7b M3：设备权限（screen_capture/launch_app/...）；桌面 Daemon 目前不消费。 */
  devicePermissions?: DevicePermissions
  /** W7b M3：执行预算（max_iterations_per_run / max_credits_per_run）。 */
  executionLimits?: ExecutionLimits
  /** W7b M3：是否启用 memory 能力（buildSystemPrompt 注入 `<agent_memory_capability>` 段）。 */
  memoryCapability?: boolean
  /** work_mode：Agent 工作目录类型（code/doc/mixed）；host 侧枚举守卫后注入 `<work_mode>` 段。 */
  workingDirType?: string
  /** Space.working_dir（wire: `workspace_root`）；见 。 */
  workingDir?: string
  /** 附件解析策略（FR-18）：本地优先 / 云端优先。 */
  attachmentStrategy?: AttachmentStrategy
  /**
   * W7c · Stage 4：当前 Space 启用的 App 能力图谱；host 装配 `<apps>` 段。
   *
   * 已归一化为 camelCase（与 Electron `QueryRequest.enabledApps` 同构），
   * daemon 端仍可通过 `parsedPayload.enabled_apps` 拿原始 snake_case wire 值。
   */
  enabledApps?: Array<{
    key: string
    cliKey?: string
    displayName: string
    capability: string
    aliases?: readonly string[]
  }>
  /** W7c · Stage 4：CLI 工具命令清单（`tabtin capabilities tools`）。 */
  cliReference?: string
  /** ：Django 端已计算的 disabled apps（禁用工具白名单基线）。 */
  disabledApps?: string[]
  /** 显式 disabled tool prefix；未提供时由 disabledApps + KNOWN_TOOL_DOMAIN_ALIASES 派生。 */
  disabledToolPrefixes?: string[]
  /** Agent backend 配置（type + disabled_*)：host 需要 type 判分流。 */
  agentConfig?: AgentBackendConfig
  /** PRD 06 §5.3.1：子 Agent 配置（模板 + 策略 + 运行时参数）。 */
  subagentConfig?: SubagentConfigDto
  /** 计费幂等作用域。 */
  billingIdempotencyScope?: string
  /** 用户可见文本；prompt 仍用于 runtime 实际执行。 */
  displayMessage?: string
  /**  引用回复：被引用的消息 id + 内容快照。 */
  replyToMessageId?: string
  replyToPreview?: Record<string, unknown>
  /** @deprecated v3：预留 legacy authorization_preset 供 Daemon fallback；v3 已下线。 */
  authorizationPreset?: string
  /**
   * 原始 zod-parsed payload。高频字段已 camelCase 化，仅少数场景（跨轮 history
   * kill switch 需要读 agent_config、authorizationPreset 精确白名单）需要透穿。
   */
  parsedPayload?: PromptForwardPayload
}

export interface ForwardDecodeSuccess {
  ok: true
  request: ForwardConversationRequest
}

export interface ForwardDecodeFailure {
  ok: false
  reason: 'schema_invalid' | 'missing_content'
  error: string
}

export type ForwardDecodeResult = ForwardDecodeSuccess | ForwardDecodeFailure

export function hasUserInputContent(
  prompt: unknown,
  attachments: ReadonlyArray<unknown> | undefined,
  userMessageBlocks?: ReadonlyArray<unknown>,
): boolean {
  return hasTextContent(prompt)
    || Boolean(attachments?.some(hasValidUserAttachment))
    || Boolean(userMessageBlocks?.some(hasValidUserMessageBlock))
}

/**
 * Backward-compatible wrapper. Callers that only care about "did we get a
 * runnable request" keep the null shape; adapters that must report on
 * schema failure should call `decodeForwardRequestDetailed` and forward
 * the `error` string to their reporting channel.
 */
export function decodeForwardRequest(
  envelope: ForwardEnvelope,
  logger: ForwardRequestLogger,
): ForwardConversationRequest | null {
  const result = decodeForwardRequestDetailed(envelope, logger)
  return result.ok ? result.request : null
}

export function decodeForwardRequestDetailed(
  envelope: ForwardEnvelope,
  logger: ForwardRequestLogger,
): ForwardDecodeResult {
  const rawPayload = envelope.payload && typeof envelope.payload === 'object'
    && !Array.isArray(envelope.payload)
    ? envelope.payload as Record<string, unknown>
    : {}

  const parsed = PromptForwardPayloadSchema.safeParse(rawPayload)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')
    const errorMessage = `Invalid prompt.forward payload: ${detail}`
    logger.warn(`[forward-decoder] ${errorMessage}`)
    return { ok: false, reason: 'schema_invalid', error: errorMessage }
  }

  const payload = parsed.data
  const taskId = payload.task_id
  const userMessageBlocks = normalizeUserMessageBlocks(payload.user_message_blocks)
  if (!taskId || !hasUserInputContent(payload.prompt, payload.attachments, userMessageBlocks)) {
    return {
      ok: false,
      reason: 'missing_content',
      error: 'agent.prompt.forward payload missing task_id or user content',
    }
  }

  const threadId = deriveRelaySessionId(envelope.thread_id) ?? taskId

  const request: ForwardConversationRequest = {
    prompt: payload.prompt,
    interruptActive: rawPayload.interrupt_active === true ? true : undefined,
    threadId,
    runId: payload.run_id,
    taskId,
    modelId: payload.model_id,
    systemPrompt: payload.system_prompt,
    agentId: payload.agent_id,
    /** ：执行场 Workspace id，wire schema 已收紧为必填字符串。 */
    workspaceId: payload.workspace_id,
    clientMessageId: payload.client_message_id,
    senderUserId: normalizeString(payload.sender_user_id),
    yoloMode: payload.yolo_mode === true ? true : undefined,
    approvalMode: payload.approval_mode,
    approvalGrant: payload.approval_grant,
    customRules: normalizeString(payload.custom_rules),
    agentName: normalizeString(payload.agent_name),
    personalRules: normalizeString(payload.personal_rules),
    // wire schema 未登记 organization_id — 保留 legacy 透传路径（source-contract
    // 测试锚点：本行必须提到 `organization_id`）。
    organizationId: typeof (rawPayload as { organization_id?: unknown }).organization_id === 'string'
      ? (rawPayload as { organization_id: string }).organization_id
      : undefined,
    organizationName: normalizeString(payload.organization_name),
    spaceId: normalizeString(payload.space_id),
    spaceName: normalizeString(payload.space_name),
    attachments: normalizeAttachments(payload.attachments),
    userMessageBlocks,
    skillSlashInvoke: decodeSkillSlashInvoke(payload.skill_slash_invoke),
    appContext: decodeAppContext(payload.app_context, logger),
    workspaceSnapshot: decodeForwardWorkspaceSnapshot(
      payload.workspace_snapshot,
      logger,
    ),
    agentMode: decodeAgentMode(payload.agent_mode),
    interactionMode: payload.interaction_mode,
    isGroupSpace: payload.is_group_space === true ? true : undefined,
    history: decodeHistory(payload.history),
    // wire schema 未定义模型能力字段（context_window_tokens 等）——旧
    // Electron 路径通过读原始 payload 取值。zod strip 会丢掉这些扩展字段，
    // 故此处从 rawPayload 而非 payload 取，保持行为兼容。
    modelContextWindow: decodePositiveNumber(rawPayload.context_window_tokens),
    modelMaxOutput: decodePositiveNumber(rawPayload.max_output_tokens),
    cloudPressureThresholds: decodeCloudPressureThresholds(payload.pressure_thresholds, logger),
    modelSupportsVision: rawPayload.supports_vision === true ? true : undefined,
    modelSupportsVideoInput: rawPayload.supports_video_input === true ? true : undefined,
    modelSupportsDocumentInput:
      rawPayload.supports_document_input === true ? true : undefined,
    modelSupportsFunctionCalling:
      rawPayload.supports_function_calling === false ? false : undefined,
    modelCapabilitiesConfig: decodeRecord(rawPayload.capabilities_config),
    modelProvider: normalizeString(rawPayload.provider),
    pendingApprovalsSerialized: extractPendingApprovals(payload, logger),
    pendingSingleHitlSerialized: extractPendingSingleHitl(payload, logger),
    operationSwitches: payload.operation_switches,
    authorizationRules: payload.authorization_rules,
    devicePermissions: payload.device_permissions,
    executionLimits: payload.execution_limits,
    memoryCapability: typeof payload.memory_capability === 'boolean'
      ? payload.memory_capability
      : undefined,
    workingDirType: normalizeString(payload.working_dir_type),
    workingDir: normalizeString(
      (rawPayload as { workspace_root?: unknown }).workspace_root
        ?? (payload as { workspace_root?: unknown }).workspace_root,
    ),
    attachmentStrategy: payload.attachment_strategy,
    enabledApps: decodeEnabledApps(payload.enabled_apps),
    cliReference: normalizeString(payload.cli_reference ?? undefined),
    disabledApps: payload.agent_config?.disabled_apps,
    disabledToolPrefixes: payload.agent_config?.disabled_tool_prefixes,
    agentConfig: payload.agent_config,
    subagentConfig: payload.subagent_config,
    billingIdempotencyScope: payload.billing_idempotency_scope,
    displayMessage: payload.display_message,
    replyToMessageId: payload.reply_to_message_id,
    replyToPreview: payload.reply_to_preview,
    authorizationPreset: readLegacyAuthorizationPreset(rawPayload),
    parsedPayload: payload,
  }

  return { ok: true, request }
}

function readLegacyAuthorizationPreset(raw: Record<string, unknown>): string | undefined {
  const value = raw.authorization_preset
  return typeof value === 'string' ? value : undefined
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function decodeSkillSlashInvoke(
  value: unknown,
): ForwardConversationRequest['skillSlashInvoke'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as { skill_key?: unknown; args?: unknown }
  const skillKey = typeof raw.skill_key === 'string' ? raw.skill_key.trim() : ''
  if (!skillKey) return undefined
  const args = typeof raw.args === 'string' ? raw.args : undefined
  return args !== undefined ? { skillKey, args } : { skillKey }
}

function normalizeAttachments(
  value: unknown,
): ForwardConversationRequest['attachments'] {
  if (!Array.isArray(value) || value.length === 0) return undefined
  return value as ForwardConversationRequest['attachments']
}

function hasValidUserMessageBlock(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const type = (value as Record<string, unknown>).type
  return typeof type === 'string' && type.trim().length > 0
}

function normalizeUserMessageBlocks(
  value: unknown,
): ForwardConversationRequest['userMessageBlocks'] {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const blocks: Array<Record<string, unknown>> = []
  for (const entry of value) {
    if (!hasValidUserMessageBlock(entry)) continue
    blocks.push(entry as Record<string, unknown>)
  }
  return blocks.length > 0 ? blocks : undefined
}

function decodeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function decodePositiveNumber(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function decodeLegacyWorkspaceScopeKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const scopeKey = value.trim()
  if (
    (scopeKey.startsWith('conversation:') && scopeKey.length > 'conversation:'.length)
    || (scopeKey.startsWith('desktop:') && scopeKey.length > 'desktop:'.length)
  ) {
    return scopeKey
  }
  return undefined
}

/**
 * 将 wire `app_context` 解成宿主 `AppContext`。
 *
 * `PromptForwardPayloadSchema` 对非法 Focus 已 `.catch(undefined)` 降级
 * （ P1-6）；此处再做轻量类型守卫，非对象 → undefined，避免阻断正文。
 */
function decodeAppContext(
  raw: unknown,
  logger: ForwardRequestLogger,
): AppContext | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    logger.warn('[forward-decoder] app_context not an object, stripped')
    return undefined
  }
  const appContext = raw as AppContext
  const legacyScopeKey = decodeLegacyWorkspaceScopeKey(
    (raw as Record<string, unknown>)._invoked_from,
  )
  if (!legacyScopeKey) return appContext

  // 旧 Electron 远程消息把发起标签桶放在 `_invoked_from`；Host 的 CLI scope
  // lease 读取 camelCase 字段。仅对真实 workspace scope 做兼容归一化，避免把
  // `tabchat_mention` 等普通来源标记误当标签桶。显式新字段始终优先。
  const explicitTabScopeKey = normalizeString(appContext.tabScopeKey)
  const explicitWorkspaceScopeKey = normalizeString(appContext.workspaceScopeKey)
  const effectiveScopeKey = explicitWorkspaceScopeKey ?? explicitTabScopeKey ?? legacyScopeKey
  return {
    ...appContext,
    tabScopeKey: explicitTabScopeKey ?? effectiveScopeKey,
    workspaceScopeKey: explicitWorkspaceScopeKey ?? effectiveScopeKey,
  }
}

function decodeAgentMode(raw: unknown): AgentModeName | undefined {
  return raw === 'ask'
    || raw === 'agent'
    || raw === 'plan'
    || raw === 'study'
    || raw === 'group'
    || raw === 'yolo'
    ? raw
    : undefined
}

function decodeEnabledApps(
  raw: unknown,
): ForwardConversationRequest['enabledApps'] {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  type Camel = NonNullable<ForwardConversationRequest['enabledApps']>[number]
  const mapped: Camel[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const obj = entry as Record<string, unknown>
    const key = typeof obj.key === 'string' && obj.key.trim() ? obj.key : undefined
    const displayName = typeof obj.display_name === 'string' && obj.display_name.trim()
      ? obj.display_name
      : undefined
    const capability = typeof obj.capability === 'string' && obj.capability.trim()
      ? obj.capability
      : undefined
    if (!key || !displayName || !capability) continue
    const cliKey = typeof obj.cli_key === 'string' && obj.cli_key.trim() ? obj.cli_key : undefined
    const aliasesRaw = obj.aliases
    const aliases = Array.isArray(aliasesRaw)
      ? (aliasesRaw as unknown[]).filter((a): a is string => typeof a === 'string' && a.length > 0)
      : undefined
    mapped.push({
      key,
      displayName,
      capability,
      ...(cliKey ? { cliKey } : {}),
      ...(aliases && aliases.length > 0 ? { aliases } : {}),
    })
  }
  return mapped.length > 0 ? mapped : undefined
}

function decodeHistory(raw: unknown): ForwardConversationRequest['history'] {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  return raw as ForwardConversationRequest['history']
}

function hasTextContent(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function hasValidImageSource(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return hasTextContent((value as Record<string, unknown>).url)
}

function hasValidUserAttachment(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.type === 'image') return hasValidImageSource(record)
  return hasTextContent(record.url)
    || hasTextContent(record.file_id)
    || hasTextContent(record.filename)
}

function extractPendingApprovals(
  payload: PromptForwardPayload,
  logger: ForwardRequestLogger,
): SerializedPendingApproval[] | undefined {
  const interruptState = payload.interrupt_state
  if (!interruptState) return undefined
  const rawList = interruptState.pending_approvals
  if (!Array.isArray(rawList) || rawList.length === 0) return undefined

  const decoded = decodeWirePendingApprovals(rawList, (level, message) => {
    if (level === 'warn') logger.warn(message)
    else logger.debug(message)
  })
  return decoded.length > 0 ? decoded : undefined
}

function extractPendingSingleHitl(
  payload: PromptForwardPayload,
  logger: ForwardRequestLogger,
): SerializedPendingSingleHitl[] | undefined {
  const interruptState = payload.interrupt_state
  if (!interruptState) return undefined
  const rawList = (interruptState as { pending_single_hitl?: unknown }).pending_single_hitl
  if (!Array.isArray(rawList) || rawList.length === 0) return undefined

  const decoded = decodeWirePendingSingleHitl(rawList, (level, message) => {
    if (level === 'warn') logger.warn(message)
    else logger.debug(message)
  })
  return decoded.length > 0 ? decoded : undefined
}
