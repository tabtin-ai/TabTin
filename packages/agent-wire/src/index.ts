/**
 * @tabtin/agent-wire
 *
 * Shared wire protocol definitions for TabTin external Agent communication.
 * Single source of truth for event types, payload schemas, and adaptation logic
 * across Daemon, Backend, and Frontend.
 */

// ─── Event Constants ─────────────────────────────────────────────────
export {
  StreamEvents,
  SessionEvents,
  UserEvents,
  ChatSessionEvents,
  OrganizationEvents,
  PromptEvents,
  PermissionEvents,
  // 新协议（Wave 1 引入；Wave 7 老协议下线后只剩这一组）
  ContentBlockEvents,
  isContentBlockEvent,
  isStreamEvent,
  isSessionEvent,
  isUserEvent,
  stripStreamPrefix,
  stripSessionPrefix,
  stripUserPrefix,
  UserEventPayloadSchema,
} from './events.js';

// W4a 阶段曾在此 re-export 一个名为 `tabtin-tool-runtime` 的 `model_id` 占位
// 字符串常量，作为 daemon / Django / Renderer 三端识别 mini-message 的字面量
// 契约——该 cross-package export 在协议层 `message_kind` 重构后**故意不再保留**
// 识别工具产出 mini-message 改走 wire 层的 `message_kind === 'tool_artifact'`
// 字段；占位字符串单源存活在 `@tabtin/agent-runtime::envelope-emitter.ts` 内部，
// 不再有跨包 import 路径。

export type {
  StreamEventType,
  SessionEventType,
  UserEventType,
  ChatSessionEventType,
  OrganizationEventType,
  PromptEventType,
  PermissionEventType,
  ContentBlockEventType,
  UserEventPayload,
} from './events.js';

// ─── Speaker Identity (PRD 06 §5.1.2) ───────────────────────────────
export type {
  SpeakerKind,
  InheritMode,
  SpeakerIdentity,
} from './speaker.js';

// ─── Subagent completion envelope ( Wave1) ─────────────────────
export {
  SubagentTerminalStatusSchema,
  SubagentLifecycleStatusSchema,
  SubagentCompletionStatsSchema,
  SubagentCompletionEnvelopeSchema,
  SubagentCompletedNotificationPayloadSchema,
  createSubagentCompletionPayload,
  terminalStatusToLifecycle,
} from './subagent-completion.js';
export type {
  SubagentTerminalStatus,
  SubagentLifecycleStatus,
  SubagentCompletionStats,
  SubagentCompletionEnvelope,
  SubagentCompletedNotificationPayload,
  BuildSubagentCompletionEnvelopeInput,
} from './subagent-completion.js';

// ─── Common Types & Schemas ──────────────────────────────────────────
// Shared cross-SDK types re-exported from @tabtin/contracts/agent
export {
  PermissionDecisionSchema,
  PermissionModeSchema,
  TurnEndStatusSchema,
  UsageReportSchema,
  PERMISSION_TIMEOUTS,
  PlanEntrySchema,
  RiskLevelSchema,
  PROTOCOL_VERSION,
  GatewayRoleSchema,
  GatewayEnvelopeSchema,
} from '@tabtin/contracts/agent';

export type {
  PermissionDecision,
  PermissionMode,
  TurnEndStatus,
  UsageReport,
  PlanEntry,
  RiskLevel,
  GatewayRole,
  GatewayEnvelope,
} from '@tabtin/contracts/agent';

// Agent-wire internal types & schemas
export {
  SourceMetaSchema,
  AgentBackendConfigSchema,
  /** @deprecated v3 不再使用预设 */
  AuthorizationPresetSchema,
  KNOWN_TOOL_DOMAIN_ALIASES,
  resolveDisabledToolPrefixes,
  matchDisabledToolDomain,
  matchDisabledToolPrefix,
} from './common.js';

export type {
  SourceMeta,
  AgentBackendConfig,
  AuthorizationPreset,
  BaseStreamEvent,
  ActionableEvent,
} from './common.js';

// ─── Stream Event Schemas (Backend → Frontend) ──────────────────────
// W4.5 第三波 C1（2026-05-13）：删除 AssistantPhaseSchema / StreamAssistantSchema /
// StreamReasoningSchema / ToolPhaseSchema / StreamToolSchema 的 export——上游
// schema 已物理删（详见 stream.ts 顶部 docblock）。
export {
  LifecyclePhaseSchema,
  StreamLifecycleSchema,
  StepStatusSchema,
  StreamStepSchema,
  StreamDoneSchema,
  CompactionPhaseSchema,
  CompactionStatsSchema,
  StreamCompactionSchema,
  StreamSystemNoticeSchema,
  KNOWN_SYSTEM_NOTICE_TYPES,
} from './stream.js';

export type {
  LifecyclePhase,
  StreamLifecycle,
  StreamStep,
  StreamDone,
  CompactionPhase,
  CompactionStats,
  StreamCompaction,
  StreamSystemNotice,
  KnownSystemNoticeType,
} from './stream.js';

// ─── ContentBlock Type 单源（W4c · W4b-P1-1 子项 d）────────────────────
// 22 case 字符串列表（轻量，无 zod 依赖）—— Renderer dispatcher / Daemon
// lite-blocks-collector / Django reassembler 三处 import 派生使用。
export {
  STANDARD_BLOCK_TYPES,
  TABTIN_BLOCK_TYPES,
  ALL_BLOCK_TYPES,
  ALL_BLOCK_TYPE_SET,
  isKnownBlockType,
} from './block-types.js'
export type { ContentBlockType } from './block-types.js'

// ─── ContentBlock Streaming Schemas (新协议，Wave 1 引入) ──────────────
// Anthropic Messages API 对齐，6 件套事件 + 22 case ContentBlock。
// 设计参考：v2 总控 §2.2 + §2.3；W0 PoC 报告 + 本仓 stream-content-block.ts 顶部 docblock。
export {
  PROTOCOL_VERSION_V2,
  CitationSchema,
  ImageSourceSchema,
  DocumentSourceSchema,
  ToolExecutionMetadataSchema,
  CodeExecutionResultContentSchema,
  ToolResultInlineBlockSchema,
  ContentBlockSchema,
  TextBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ThinkingBlockSchema,
  RedactedThinkingBlockSchema,
  ImageBlockSchema,
  DocumentBlockSchema,
  ServerToolUseBlockSchema,
  WebSearchToolResultBlockSchema,
  CodeExecutionToolResultBlockSchema,
  BashCodeExecutionToolResultBlockSchema,
  TextEditorCodeExecutionToolResultBlockSchema,
  McpToolUseBlockSchema,
  McpToolResultBlockSchema,
  ContainerUploadBlockSchema,
  SearchResultBlockSchema,
  TabTinRichContentBlockSchema,
  LocalFileArtifactRichContentBlockSchema,
  OssFileArtifactRichContentBlockSchema,
  TabTinComposerPresetBlockSchema,
  TabTinAskUserFieldsBlockSchema,
  TabTinSkillInvocationBlockSchema,
  TabTinSourceRefBlockSchema,
  TabTinApprovalRequestBlockSchema,
  StreamEnvelopeBaseSchema,
  MessageStartSchema,
  MessageKindSchema,
  MessageDeltaSchema,
  MessageStopSchema,
  MessageUsageSchema,
  MessageStopReasonSchema,
  ContentBlockStartSchema,
  ContentBlockDeltaSchema,
  ContentBlockDeltaPayloadSchema,
  ContentBlockStopSchema,
  AnyContentBlockStreamEventSchema,
  // W4c-L5 · W4.5 第二波 B1：MessageStop.error_info 协议字段
  ErrorInfoSchema,
  PartialReasonSchema,
} from './stream-content-block.js';

export type {
  Citation,
  ImageSource,
  DocumentSource,
  ToolExecutionMetadata,
  CodeExecutionResultContent,
  ToolResultInlineBlock,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ServerToolUseBlock,
  ThinkingBlock,
  RedactedThinkingBlock,
  ImageBlock,
  DocumentBlock,
  TabTinSourceRefBlock,
  TabTinSkillInvocationBlock,
  TabTinApprovalRequestBlock,
  TabTinRichContentBlock,
  LocalFileArtifactRichContentBlock,
  OssFileArtifactRichContentBlock,
  TabTinSnapshot,
  StreamEnvelopeBase,
  MessageStart,
  MessageKind,
  MessageDelta,
  MessageStop,
  MessageUsage,
  MessageStopReason,
  ContentBlockStart,
  ContentBlockDelta,
  ContentBlockDeltaPayload,
  ContentBlockStop,
  AnyContentBlockStreamEvent,
  ErrorInfo,
  PartialReason,
} from './stream-content-block.js';

export {
  LocalFileArtifactPayloadSchema,
  LocalFileArtifactSelfCheckSchema,
} from './local-file-artifact.js';

export type {
  LocalFileArtifactPayload,
  LocalFileArtifactSelfCheck,
} from './local-file-artifact.js';

export {
  OssFileArtifactPayloadSchema,
} from './oss-file-artifact.js';

export type {
  OssFileArtifactPayload,
} from './oss-file-artifact.js';

// ─── Prompt / Permission Schemas (Backend → Daemon) ─────────────────
export {
  PromptAppContextSchema,
  PromptForwardPayloadSchema,
  PromptCancelPayloadSchema,
  SubagentCancelPayloadSchema,
  PermissionResponsePayloadSchema,
  PermissionResetSessionPayloadSchema,
  ToolDiscoveryPayloadSchema,
  // W7b M3: 授权策略 / 执行限制 sub-schemas
  OperationSwitchValueSchema,
  OperationSwitchesSchema,
  AuthorizationActionSchema,
  AuthorizationRulesSchema,
  DevicePermissionsSchema,
  ExecutionLimitsSchema,
  AttachmentStrategySchema,
  // PRD 06 §5.3.1: 子 Agent 配置 sub-schemas
  InheritModeSchema,
  SubAgentTemplateDtoSchema,
  SubAgentPolicyDtoSchema,
  SubAgentRuntimeConfigDtoSchema,
  SubagentConfigDtoSchema,
  // PRD 05 v0.4 §7.1 W3-轮 1: crash resume schema（嵌入 PromptForwardPayload）
  InterruptStateSchema,
  InterruptStatePendingApprovalSchema,
} from './prompt.js';

export type {
  PromptForwardPayload,
  PromptCancelPayload,
  SubagentCancelPayload,
  PermissionResponsePayload,
  PermissionResetSessionPayload,
  ToolDiscoveryPayload,
  OperationSwitches,
  AuthorizationRules,
  DevicePermissions,
  ExecutionLimits,
  AttachmentStrategy,
  SubAgentTemplateDto,
  SubAgentPolicyDto,
  SubAgentRuntimeConfigDto,
  SubagentConfigDto,
  InterruptState,
  InterruptStatePendingApproval,
} from './prompt.js';

// ─── Plan Proposal ───────────────────────────────────────────────────
// `plan_create` 工具落库后通过 `agent.stream.plan_proposal` 事件向渲染端
// 推送 plan 草稿快照；渲染端据此在 chat 流插入 inline 卡片（PlanProposalCard）。
// 「执行」交互完全在 UI 层完成，不再有 plan_exit 工具或审批 IPC 通道。
export {
  PlanProposalEventPayloadSchema,
  PlanRefSchema,
  planRefKey,
  planRefEquals,
  parsePlanRefKey,
  resolvePlanRef,
  planRefToLegacyId,
} from './plan-proposal.js';

export type {
  PlanProposalEventPayload,
  PlanProposalTodo,
  PlanRef,
} from './plan-proposal.js';

// ─── Mode Switch Proposal (Phase 3 / D1) ─────────────────────────────
export {
  ModeSwitchProposalEventPayloadSchema,
} from './mode-switch-proposal.js';

export type {
  ModeSwitchProposalEventPayload,
} from './mode-switch-proposal.js';

// ─── Approval Events (PRD 05 §7.4 / §7.5, v0.4 W1.5 batch 升格) ────
// v0.4：plan_approval_required 已下线（plan-execute-handler 独立通道）；
// review_required → approval_requested 一刀切。事件 schema 升格 batch：
// `batch_id` + `action_requests[]` + `decisions[]`。详见 `approval.ts` 顶部。
export {
  PlanGuardDenyCodeSchema,
  ApprovalScopeSchema,
  DecisionReasonSchema,
  ApprovalAskHintSchema,
  RuntimeModeSchema,
  ApproverIdentitySchema,
  ApprovalSkillContextSchema,
  ApprovalBatchContextSchema,
  ApprovalActionRequestSchema,
  ApprovalDecisionSchema,
  ApprovalRequestedPayloadSchema,
  ApprovalOutcomeSchema,
  ApprovalResolvedPayloadSchema,
  ApprovalRequestedEventSchema,
  ApprovalResolvedEventSchema,
  LocalRtUserResponseDecisionSchema,
  LocalRtUserResponsePayloadSchema,
  // Ask 三件套（W4 R3 / 2026-05-11，三件套并存）：
  //   - ask_user：单/多选问题（兼容 ask_choice 场景）
  //   - ask_form：多字段结构化表单
  //   - request_approval：destructive 操作授权（含 risk_level）
  AskUserRequestSchema,
  AskUserResponseSchema,
  AskFormRequestSchema,
  AskFormResponseSchema,
  RequestApprovalRequestSchema,
  RequestApprovalResponseSchema,
  AskInteractionRequestSchema,
  APPROVAL_REQUESTED_EVENT_TYPE,
  APPROVAL_RESOLVED_EVENT_TYPE,
  // 单 HITL 终态事件
  SINGLE_HITL_RESOLVED_EVENT_TYPE,
  SingleHitlResolvedOutcomeSchema,
  SingleHitlResolvedPayloadSchema,
  SingleHitlResolvedEventSchema,
} from './approval.js';

export type {
  PlanGuardDenyCode,
  ApprovalScope,
  DecisionReason,
  ApprovalAskHint,
  RuntimeMode,
  ApproverIdentity,
  ApprovalSkillContext,
  ApprovalBatchContext,
  ApprovalActionRequest,
  ApprovalDecision,
  ApprovalRequestedPayload,
  ApprovalOutcome,
  ApprovalResolvedPayload,
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  LocalRtUserResponseDecision,
  LocalRtUserResponsePayload,
  // Ask 三件套类型（W4 R3 / 2026-05-11）
  AskUserOption,
  AskUserQuestion,
  AskUserRequest,
  AskUserResponse,
  AskFormRequest,
  AskFormResponse,
  RequestApprovalRequest,
  RequestApprovalResponse,
  AskInteractionRequest,
  // 单 HITL 终态类型
  SingleHitlResolvedOutcome,
  SingleHitlResolvedPayload,
  SingleHitlResolvedEvent,
} from './approval.js';

// ─── Access Barrier HITL ────────────────────────────────────────────────────
export {
  AccessBarrierKindSchema,
  AccessBarrierActionIdSchema,
  AccessBarrierSchema,
  AccessBarrierResolutionSchema,
  ACCESS_BARRIER_REQUIRED_EVENT_TYPE,
  AccessBarrierRequiredPayloadSchema,
  AccessBarrierRequiredEventSchema,
} from './access-barrier.js';

export type {
  AccessBarrierKind,
  AccessBarrierActionId,
  AccessBarrier,
  AccessBarrierResolution,
  AccessBarrierRequiredPayload,
  AccessBarrierRequiredEvent,
} from './access-barrier.js';

// ─── CLI Envelope ────────────────────────────────────────────────────
export { okResponse, errResponse } from './cli-envelope.js';
export type {
  CliOkResponse,
  CliErrorResponse,
  CliErrorDetail,
  CliErrorCode,
  CliResponse,
  OkResponseOptions,
  ErrResponseOptions,
} from './cli-envelope.js';

// ─── Unified ErrorCode Taxonomy ──────────────────────────────────────
// Source of truth for IPC / CLI / HTTP failure responses. Mirrored to
// Python (apps/tabtin_django/apps/services/common/error_codes.py) and Go
// (packages/tabtin-cli-go/internal/errcode/codes.go); kept in sync by
// scripts/check-error-codes-sync.py (blocking step in infra-gate.sh).
export { ERROR_CODES, isErrorCode } from './error-codes.js';
export type { ErrorCode } from './error-codes.js';

// ─── Monitor Protocol (Backend ↔ Device) ─────────────────────────────
export {
  MonitorActionEvents,
  MonitorDeviceEvents,
  MonitorStartSchema,
  MonitorStopSchema,
  MonitorEventSchema,
  MonitorHeartbeatSchema,
  MonitorStreamEndedSchema,
  MonitorFailedSchema,
  MonitorDeviceMessageSchema,
} from './monitor.js';

export type {
  MonitorActionEventType,
  MonitorDeviceEventType,
  MonitorStart,
  MonitorStop,
  MonitorEvent,
  MonitorHeartbeat,
  MonitorStreamEnded,
  MonitorFailed,
  MonitorDeviceMessage,
} from './monitor.js';

// ─── CLI session fork proxy (Electron / Daemon) ─────────────────────
export {
  proxyChatSessionFork,
  isSuccessfulHttpStatus,
} from './session-fork-proxy.js';
export type {
  DjangoHttpResult,
  SessionForkDjangoRequest,
  SessionForkBody,
  ProxySessionForkOutcome,
} from './session-fork-proxy.js';

// ─── Risk level vocabulary  ───────────────────────────────────
export {
  ApprovalWireRiskLevelSchema,
  normalizeToWireRiskLevel,
  normalizeToRegistrationRiskLevel,
  inferWireRiskLevelFromTool,
  inferWireRiskLevelForToolCall,
} from './risk-level.js';
export type {
  ToolRegistrationRiskLevel,
  ApprovalWireRiskLevel,
  ToolRiskSource,
} from './risk-level.js';

// ─── Run sync  ────────────────────────────────────────────────
export {
  AgentRunSyncStatusSchema,
  AgentRunSyncPayloadSchema,
  isAgentRunSyncBusy,
} from './run-sync.js';
export type {
  AgentRunSyncStatus,
  AgentRunSyncPayload,
} from './run-sync.js';

// ─── SSE Adapter ─────────────────────────────────────────────────────
export { mapWsEventToSse } from './sse-adapter.js';
export type { SseEvent } from './sse-adapter.js';
