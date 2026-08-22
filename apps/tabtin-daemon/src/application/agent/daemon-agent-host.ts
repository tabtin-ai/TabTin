/**
 * DaemonAgentHost — Local agent-runtime host for the headless Daemon.
 *
 * Isomorphic counterpart of ElectronAgentHost. Runs the same agent-runtime
 * engine but uses WS (DaemonGatewayClient) instead of Electron IPC for:
 *   - Receiving query triggers (via agent.prompt.forward with runtime_mode='local')
 *   - Pushing stream events (via relay_events batched WS messages)
 *   - HITL flow: ApprovalRequested batch + ask_choice / ask_form / request_approval
 *     three-tool family (Wave 5 + Wave 6 ask_question 拆分；老 review_required /
 *     ask_user_required 命名已下线，runtime / Daemon → relay 不再产生)
 *
 * Lifecycle: created by TabTinDaemon.start(), disposed by TabTinDaemon.stop().
 */

import {
  join,
  dirname,
} from 'node:path';
import { getDaemonHomePath } from '@tabtin/shared/storage-paths';
import {
  existsSync,
  promises as fsPromises,
} from 'node:fs';
import {
  AgentHost,
  ConversationRunCancelledError,
  HostTrackerScheduler,
  MessageDeliveryOutbox,
} from '@tabtin/agent-host'
import type {
  AgentOwnerAdapter,
  HostQuery,
} from '@tabtin/agent-host'
import {
  assembleHostPromptContext,
  buildAttachmentMessageBlocks,
  filterHostPromptContextBlocks,
  rememberAttributionFromPersistEvent,
  resolveComposerPresetSkillInvoke,
  resolveHostContextBlocks,
} from '@tabtin/agent-host/conversation'
import type { AgentTransportEnvelope } from '@tabtin/agent-host/realtime'
import { DaemonAgentTransport } from './daemon-agent-transport.js'
import type {
  AgentEngineCompactSessionInput,
  AgentEngineCompactSessionOutput,
} from '@tabtin/cli-server-core/surfaces/agent-engine';
import type {
  AgentRuntime,
  ContentBlock,
  EngineConfig,
  Message,
  ModelCatalogEntry,
  SerializedPendingApproval,
  SerializedPendingSingleHitl,
  StreamEvent,
} from '@tabtin/agent-runtime/engine';
//  批次 13：engine barrel 收敛为 engine-only。非 engine 目录的符号
// （runtime 组装根 / session / subagent / providers / telemetry / agent-modes /
// permissions / host / capability injectors）改从包入口 `@tabtin/agent-runtime` import。
import type { AgentModeName } from '@tabtin/agent-modes'
import type { AppContext } from '@tabtin/agent-host/hooks';
import {
  AgentError,
  clearAllActivePlansForSession,
  isValidModelRef,
  isInTurnPushNotificationUser,
} from '@tabtin/agent-runtime';
import {
  correlateSourceClientEvent,
  resolveRelaySessionIdForReconcile,
  NotificationIdleDrain,
  RelaySessionOrchestrator,
  SessionPauseController,
  formatFallbackAttachmentText,
  resolveFileAttachmentsShell,
  type NotificationDrainContext,
  type RelaySessionStorageView,
  type DeliveryTransportPort,
  type DeliveryDurableLayer,
} from '@tabtin/agent-host/delivery'
import {
  executionOwnerScopeId,
  type RuntimeCacheKey,
  type RuntimeResourceFactory,
  type RuntimeSessionRequest,
} from '@tabtin/agent-host/runtime'
import {
  normalizeDaemonRuntimeExtraKey,
  type DaemonRuntimeExtraKey,
} from './runtime/daemon-runtime-key.js'
export {
  normalizeDaemonRuntimeExtraKey,
  daemonRuntimeExtraKeysMatch,
  type DaemonRuntimeExtraKey,
} from './runtime/daemon-runtime-key.js'
import {
  extractAbortIdentityCandidates,
  resolveConversationAbortKeys,
  resolveConversationStateKeys,
  applyAuthoritativeSecurityMutate,
  type ForwardConversationRequest,
  type ForwardDecodeFailure,
  type QueryPipelineSession,
  type QueryTurnDataPort,
  type QueryTurnSessionView,
} from '@tabtin/agent-host/conversation'
// ：per-session 串行执行器 + FIFO 队列（host 侧 busy/queue 唯一真相源）。
// 子代理历史恢复·方案 A：子/孙代理 persist_message 也落父会话 message-blocks.jsonl（判定事件类型用）。
import { randomUUID } from 'node:crypto';
import {
  classifyError,
  deriveCacheType,
  deriveReasoningHistoryPolicy,
  FALLBACK_MODEL_CAPABILITIES,
  isReportableRunError,
} from '@tabtin/agent-runtime/engine';
// 路径权限治理 W7 / L1：派生 EffectivePolicy.planModeGuardActive
// ：子 Agent 模板策略层快照 + 原始记录映射（agent-tool 经 template_id 消费）。
import {
  SessionStorage,
  SnapshotStorage,
  EventStorage,
  SubagentManager,
  cancelSubagent,
  EventEmitter,
  RuntimeLifecycleEvent,
  TelemetryEvents,
  emitTelemetryEvent,
  clearSyncAccountDir,
  ownersMatch,
  ToolLogWriter,
  cleanupOldToolLogs,
  toolOutputToString,
  resolveWorkspaceSessionArchiveDir,
  setHumanInteractionHooks,
} from '@tabtin/agent-runtime'
//  / ：宿主启动期一次性把旧 platform-data 布局迁到新 dataRoot 布局
// （与 ElectronAgentHost 同款；Daemon 单 owner，登录态在 config.user_id 就绪）。
import { migrateLegacyPlatformDataToDataRoot } from '@tabtin/shared'
import {
  normalizeWorkspaceRoot,
  isToolLifecycleNotice,
} from '@tabtin/agent-runtime/engine';
// ：系统提示词装配的权威真相源在 agent-runtime。Daemon 不再直接调
import type { WorkingDirType } from '@tabtin/agent-prompt';
// W7c · Stage 4 Daemon 路径对齐（治理 07 §F.4）：LSP runtime singleton + 诊断
// 注入。与 ElectronAgentHost 同款使用 `initializeLspServerManager` lazy 启动
// LSP server，第一次 session 创建时用当前 workspace root init；TABTIN_DISABLE_LSP=1
// 由 lsp-runtime 内部处理，与 Electron 行为一致。
import {
  resolvePlatformDataRoot,
  resolveDataRoot,
  SHELL_NOTIFICATION_KIND,
  resolveBackgroundTaskRelayThreadId,
  reconcileManagedTasks,
  killProcessTreeByPid,
  type NotificationEnvelope,
  type NotificationQueueUnsubscribe,
  type BackgroundTaskCompletedPayload,
  type ManagedTaskStore,
  type PersistedManagedTask,
  type ManagedTaskReconcileRecord,
  type ManagedTaskReconcileDeps,
  type ReconcileTerminalState,
} from '@tabtin/terminal-core';
// W1.2 /  Stage 6d：RuntimeBundle 持有 bootstrap 结果类型（装配在 assembly）。
import type { NativeBackendBootstrapResult } from '@tabtin/agent-host/native';
// ShellCap 接 PtyManagerBridge — 装配点拿 bridge。
// bootstrap 顺序（agent-bridge.ts L544-548）：
//   PtyManager.initialize() 完成 → daemon.ts 调 setPtyManagerBridge →
//   此处 resolvePtyManagerBridge 拿到真实 bridge → 装配 ShellCap
// W7c · Stage 4 Daemon 路径对齐（治理 07 §F.5）：Daemon 端 run-observation injector
// 显式降级实现 —— Daemon 当前没 host-side observation 源（autofill / RunSessionManager
// 在 Electron 主进程），injector 恒返回空数组但暴露 ``isNoop`` / ``reason`` 元信息
// 供 P5 audit 显式登记差异。详见同名文件 doc-string。
// Agent Host 归位：live runtime 装配（build/soft/rebuild + createRuntimeForSession
// + 各 loader）迁入独立模块，本文件退回 headless 平台外壳。
import { DaemonRuntimeAssembly } from './runtime/daemon-runtime-assembly.js';
import { AgentSessionState } from './session/agent-session-state.js';
import { AgentPersistenceSupervisor } from './agent-persistence-supervisor.js';
import { captureRunError } from '../../platform/observability/logging/sentry.js';
import type {
  AgentTerminalPort,
  CatalogEntryContract,
  DaemonHostStateContract,
  DaemonQueryRequestContract,
  DaemonQueryResult as DaemonQueryResultContract,
  RuntimeBuildInputContract,
  RuntimeCarryForwardContract,
} from './contracts.js';
// Capability + capability 装配 helper（5 件套）：
// - TabDataCap 已随 Wave 4a (2026-05-01) D4 全删 FC 一并删除（Agent 走 `tabtin table *` CLI）
// - TabDocCap 已随 Wave 12 (2026-05-04) 退役（Agent 走 `tabtin doc *` CLI）
// ：平台目录类 Cap（SkillsCap）已迁至共享宿主包。
// ：临时隐藏 skill 名单（tabvideo）由宿主注入。
import { TEMPORARILY_HIDDEN_SKILLS } from '@tabtin/agent-host/capabilities';
import type { PersistedEntryOwner } from '@tabtin/agent-runtime';
// W4a S3-S5（PR2）：live 依赖重绑 + 完成回调契约类型（与 Electron 对称）。
import {
  daemonHostRuntimeOptions,
  type AttachmentStrategy,
} from '@tabtin/agent-host/configuration'
const {
  resolveAttachmentStrategy,
  resolveMaxLocalFileSizeMb,
  resolveSyncPersistence
} = daemonHostRuntimeOptions
import type { TelemetryEventName } from '@tabtin/agent-runtime';
import { installDaemonTelemetrySink } from '../../platform/observability/telemetry/telemetry-sink.js';
import type { AgentGatewayPort } from './agent-gateway-port.js';
import type { DaemonConfig } from '../../base/types/daemon-config.js';
import type { Logger } from '../../platform/observability/logging/logger.js';
import { LocalRuntimeEvents } from '@tabtin/ws-gateway-client';
import {
  PromptEvents,
  PromptCancelPayloadSchema,
  SubagentCancelPayloadSchema,
} from '@tabtin/agent-wire';
import { DaemonToolProvider } from './daemon-tool-provider.js';
import { applyCancelledByRollbackToHitl } from '@tabtin/agent-runtime/permissions';
import { type SkillCredentialResolverHandle } from '@tabtin/agent-host/credentials';
import {
  createAgentConfigClient,
  type AgentConfigClient,
} from '@tabtin/agent-host/policy';
import { RecallIndex } from '@tabtin/search';
import { getDaemonSemanticScorer } from './semantic-scorer.js';
import {
  initSkillsModule,
  disposeSkillsModule,
  resolveDefaultInteropRoots,
  type SkillsModuleHandle,
} from '@tabtin/agent-host/skills';
import { SkillEnablementMapCache } from '@tabtin/agent-runtime/skills';
import { fetchSkillEnablementMap } from './fetch-skill-enablement-map.js';
import {
  fetchHostTrackerSnapshot,
  finalizeHostTrackerRun,
  fireHostTracker,
  prepareHostTrackerRun,
  reconcileHostTrackerLifecycle,
  type HostTrackerAuth,
} from './host-tracker-cloud.js';
// Memory v2 阶段 3：memory-injector hook 复用 memory_search 工具同款 helper。
// 项目规则自动加载（AGENTS.md MVP）：rules-injector hook 复用 readProjectRules
// 读盘 helper（mtime 缓存 + 截断），与 Electron 宿主 import 同一份。
import {
  deriveApiBaseUrl,
  joinApiPath,
  API_ENDPOINTS,
} from '@tabtin/config';
import {
  isChatAudioAttachment,
  formatChatAudioTranscriptBody,
  transcribeChatAudioAttachment,
} from '@tabtin/media-capabilities/audio';
import {
  isChatVideoAttachment,
  formatChatVideoUploadedBody,
  formatBlockedChatDocumentError,
  planChatAttachmentsForPromptInjection,
  runtimeTypeForChatVideoAttachment,
} from '@tabtin/media-capabilities/video';
// W3：UserInteractiveChannel 桥接 + ApprovalMemoStore 装配（与 Electron 同构）。
// 生产链路 100% 走 `@tabtin/security-policy` `judge()` 主路径——历史 6 层
// PermissionPipeline（driver / layers / 配套接口）已整体清退。
import {
  buildBackgroundTaskTerminalResult,
  runBackgroundTaskExitFlush,
  killProcessGroupSafe as killProcessGroupSafeCore,
  type ExitFlushStore,
} from '@tabtin/agent-runtime';
import {
  FilePipelineErrorCode,
  formatFilePipelineErrorChinesePrompt,
  isFilePipelineErrorCode,
} from '../../platform/content/document/localDocParse.js';
import type { DocParserPort } from '../../base/content/doc-parser-port.js';
import {
  setFileHistoryLogger,
  removeFileHistory,
  clearAllFileHistory,
} from '../../platform/workspace/file-history/file-history-registry.js';
// W4 (2026-05-13)：持久通道改造——不再直接 import parseLocalAttachment，改走
// `@tabtin/file-pipeline` 的 `FileResolver`。channel 只决定策略 + 装配 prompt。
import {
  createDefaultFileResolver,
  type FileResolver,
} from '@tabtin/file-pipeline';
import {
  errorClassToFallback,
  assessCloudSummaryQuality,
} from '@tabtin/local-docparse';

// W4 lazy singleton：Daemon 共享一个 FileResolver 实例（无状态）。
let _daemonFileResolver: FileResolver | null = null;
function getDaemonFileResolver(): FileResolver {
  if (!_daemonFileResolver) _daemonFileResolver = createDefaultFileResolver();
  return _daemonFileResolver;
}

// ─── Types ──────────────────────────────────────────────────────────

export interface DaemonQueryRequest extends DaemonQueryRequestContract {
  prompt: string;
  sessionId: string;
  taskId?: string;
  relaySessionId?: string;
  threadId?: string;
  modelId?: string;
  /** ：当前模型是否支持原生视频输入（来自 prompt.forward supports_video_input） */
  modelSupportsVideoInput?: boolean;
  /** ：当前模型是否支持原生文档输入（来自 prompt.forward supports_document_input） */
  modelSupportsDocumentInput?: boolean;
  systemPrompt?: string;
  maxTurns?: number;
  agentId?: string;
  authorizationPreset?: 'cautious' | 'collaborative' | 'full_auto' | 'server_auto';
  /**
   * wire `payload.yolo_mode` — Agent 级 gate 的客户端声称值。
   *
   * YOLO PRD v3 review M2 后**降级为 bootstrap / telemetry 信号**：权威源
   * 是 handleQueryInternal 入口经 `agentConfigClient.fetchAuthoritativeAgentConfig`
   * 现拉的 Django `Agent.agent_config.security.allow_yolo_mode`；本字段仅
   * 用于「客户端声称 vs 服务端实际」的日志比对，不再决定 session gate。
   */
  yoloMode?: boolean;
  /**
   *  三档审批策略：对话级请求的审批档位（wire `payload.approval_mode`）。
   * 缺省 / 非法值 → build-policy 走 legacy 归一（agent_mode='yolo' → 'auto'）。
   */
  approvalMode?: string;
  /**
   * ：Agent 已授权的最高审批档位（wire `payload.approval_grant`）。
   *
   * YOLO PRD v3 review M2 后**降级为 bootstrap / telemetry 信号**——权威源
   * 是 handleQueryInternal 入口经 `agentConfigClient.fetchAuthoritativeAgentConfig`
   * 现拉的 Django `Agent.agent_config.security.approval_grant`。wire 值仅
   * 用于「客户端声称 vs 服务端实际」的日志比对（与 Electron IPC payload
   * `approvalGrant` 同构），不再决定 session gate。
   */
  approvalGrant?: string;
  /**
   * Hilt v3 / W6 M2：客户端工作区快照（Space sandbox + TabCode/TabFolder + 附件）。
   *
   * Daemon 没有自己的 TabCode UI，只能由主控端 Electron 通过 prompt.forward
   * 透传过来。daemon.ts 从 wire payload 解析后注入；createRuntimeForSession
   * 把它喂给 DaemonToolProvider + buildJudgePolicy 工厂闭包，让 judge 在
   * Daemon 端跟 Electron 同构走 v3 工作区判决。
   *
   * 缺省 → daemon 自己用 sandbox 目录兜底（详见 createRuntimeForSession 内
   * `workspaceSnapshotV3` 字面量旁的注释）。
   */
  workspaceSnapshot?: import('@tabtin/security-policy').WorkspaceSnapshot;
  /**
   * LH2-D3：用户 ID 覆盖（多租户 Daemon 场景预留）。
   *
   * 默认走 `DaemonConfig.user_id`（install token 持久化的单 owner）；
   * 如果 Django `prompt.forward` payload 显式带 `user_id`（例如未来 Daemon
   * 共享设备给多个用户），覆盖到本字段——`DaemonAgentHost.resolveOwner`
   * 优先级：request.userId → config.user_id → 抛错。
   *
   * 当前 Daemon 是单设备 / 单 owner 模型，绝大多数场景不传本字段。
   */
  userId?: string;
  /**
   * ：配置页「人设与规则」（wire `custom_rules`）。写入 session.agentProfile，
   * 由 agent-profile hook 贴用户消息前注入；不再进 system `<custom_rules>`。
   */
  customRules?: string;
  /**
   * ：Agent 展示名（wire `agent_name`）。写入 session.agentProfile，
   * 由 agent-profile hook 贴用户消息前注入。
   */
  agentName?: string;
  /**
   * 分层规则·个人基线层（设置 IA Phase 3 §8.6）。Daemon 路由从
   * agent.prompt.forward payload.personal_rules 解出（Django 已 per-owner 读
   * owner UserProfile.personal_rules）。host 组装 system `<custom_rules>`；
   * Agent 专属规则走 customRules → agent-profile。（团队基线层已下线。）
   */
  personalRules?: string;
  attachments?: Array<{
    type: string;
    file_id?: string;
    filename?: string;
    mime_type?: string;
    size?: number;
    url?: string;
    preview_url?: string;
  }>;
  /**
   * ：用户 context / 结构化块（wire `user_message_blocks`）。
   * 与 Electron IPC `QueryRequest.userMessageBlocks` 同构；进本机 transcript。
   */
  userMessageBlocks?: Array<Record<string, unknown>>;
  /**
   *  / ：斜杠 / quick-use Skill 直链（wire `skill_slash_invoke`）。
   * 缺省时 Host 可从 composer_preset.skill_key 派生。
   */
  skillSlashInvoke?: { skillKey: string; args?: string };
  /**
   * FR-18 Phase 2 (H2-E)：附件解析策略。
   * - `local_first`（默认）：本地优先，失败/不支持切云端
   * - `cloud_only`：保留旧行为，全部走云端 DocParse（W4 移除 `cloud_first` 死配置）
   * - `cloud_only`：保留旧行为，全部走云端 DocParse
   *
   * 来源优先级：
   *   1. 本字段（Django `prompt.forward` payload.attachment_strategy）
   *   2. env `TABTIN_ATTACHMENT_STRATEGY`
   *   3. 默认 `'local_first'`
   *
   * 与 Electron `QueryRequest.attachmentStrategy` 字段语义完全一致。
   */
  attachmentStrategy?: AttachmentStrategy;
  /**
   * W7a：用户在远端客户端选择的 Agent Mode。
   *
   * 与 Electron `QueryRequest.agentMode` 完全对称。来源：Django 从
   * `prompt.forward` payload.agent_mode 透传。缺省 / 未知值走 'agent'
   * fallback（保持向后兼容；resolveAgentModeName 在 host 内部处理）。
   *
   * 透传链路：客户端 → Django ChatService → PromptForwardService →
   * `payload.agent_mode` → daemon.ts `routeToLocalAgentHost` → 本字段 →
   * DaemonToolProvider.agentMode + buildSystemPrompt({agentMode}) +
   * EngineConfig.agentMode。
   */
  agentMode?: AgentModeName;
  /**
   * 交互档（HITL 四态）。forward payload.interaction_mode 透传——无人值守任务
   * （Tracker）传 'scheduled' 让本 session HITL fail-fast。缺省 → 'interactive'。
   */
  interactionMode?: 'interactive' | 'solo' | 'scheduled' | 'batch';
  /**
   * W7a：当前 chat 所属 Space id。
   *
   * 与 Electron 通过 `getCLISpaceId()` 取的差异：Daemon 没有 CLI 上下文
   * 模块（CLI 服务面向命令行客户端，与本地 Agent 是两码事）；Space id 由
   * Django 从 prompt.forward 携带过来（payload.space_id 或从 thread_id
   * 解出）。缺省时 plan-tools / context injector 的 spaceId 走 undefined
   * （behavior：context injector 跳过 space_id 行；plan-tools 不注册）。
   */
  spaceId?: string;
  workspaceId?: string;
  /**
   * W7a：当前 Tab/App 上下文（用户聚焦的 App + 打开的标签）。
   *
   * 与 Electron `QueryRequest.appContext` 完全对称。Daemon 自身没有 GUI 不
   * 知道用户聚焦在哪——必须由远端客户端通过 Django 携带。来源：
   * Django `prompt.forward` payload.app_context（W7a 后续协议补齐）。
   *
   * 注入到 `createContextInjector` middleware 后，每轮 LLM 前作为
   * `<context>...</context>` user message 插入 messages 最前面，让 Agent
   * 知道用户正在看什么。缺省 / 空对象 → context injector 跳过该轮注入。
   */
  appContext?: AppContext;
  /**
   * R4.2 (review fix)：当前 Space 启用的 App 能力图谱（Electron QueryRequest
   * 同名字段对称）。烘焙到 `<apps>` 段告诉远程客户端的 Agent 这个 Space 里能
   * 用哪些 App、每个能做什么。
   *
   * 来源：Django `prompt.forward` payload.enabled_apps（Electron / mobile / Web
   * 主控端通过 chat.send_message app_context.enabled_apps 上传 → forward_runner
   * 透传到 Daemon）。缺省 → `<apps>` 段跳过（向后兼容老客户端）。
   *
   * 不进入 runtime cache key（与 Electron 同款决策，Space rename / 罕见的
   * enable/disable 容忍重建延迟到下一次客户端发起 query 时）。
   */
  enabledApps?: ReadonlyArray<{ key: string; cliKey?: string; displayName: string; capability: string; aliases?: readonly string[] }>;
  /**
   * W7c · Stage 4 Daemon 路径对齐（agent-prompt 治理 99 §阶段 4）。
   *
   * Space / Organization 人类可读名（来自 Django ``prompt.forward.space_name`` /
   * ``organization_name``）。烘焙到 ``runtimeIdentity`` 让 ``<environment>`` 段
   * 显"团队：研究组 / 空间：研究 Space"而不是裸 UUID（07 §F.1）。
   * 缺省 → 段退化为只显 ID（向后兼容）。
   */
  spaceName?: string;
  organizationName?: string;
  /**
   * W7c · Stage 4 Daemon 路径对齐。CLI 工具命令清单（``tabtin commands``
   * 的输出文本）。
   *
   * 来源优先级：
   *   1. Django ``prompt.forward.cli_reference``（如果上游能更高频缓存）
   *   2. Daemon 自己 spawn ``tabtin commands --format json`` 兜底
   *
   * 烘焙到 ``<cli_capabilities>`` 段（07 §F.1）。两路径任一有值即注入；都没有就跳过段。
   */
  cliReference?: string;
  /**
   * W7a · 跨轮记忆 · 历史装填（按时间升序）。
   *
   * 与 Electron `QueryRequest.history` 完全对称。来源：客户端通过
   * `@tabtin/agent-runtime/history` 的 `selectRecentHistoryForRuntime`
   * 生成 → Django `prompt.forward` payload.history 透传。
   *
   * Daemon 调用 `buildInitialMessages(history, userMessage)` 拼成
   * `initialMessages` 交给引擎。`content` 支持 `string | ContentBlock[]`。
   *
   * 省略 / 空数组 → 引擎只看到本轮 user，等价 feature flag off。
   */
  history?: Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }>;
  /**
   * W7b M3 (PRD 真相 A2)：用户在 Settings 里配置的细粒度操作开关
   * （git_read/git_push/rm/mv/db_write/...）。
   *
   * 来源：Django `prompt.forward` payload.operation_switches（仅 local runtime 路径）。
   * 用法：DaemonToolProvider 在 getPresetPolicy(authorizationPreset) 之后调用
   * `mergeOperationSwitches(preset, operationSwitches)` 合并到最终 policy，
   * 让 PolicyEvaluator 在 run_terminal_command 命令拦截阶段看到用户自定义值。
   *
   * 缺省时走 preset 默认值（行为完全等同旧版）。
   */
  operationSwitches?: Record<string, 'allow' | 'confirm' | 'block'>;
  disabledApps?: string[];
  disabledToolPrefixes?: string[];
  /**
   * W7b M3：用户配置的设备权限（screen_capture/launch_app/...）。
   * 桌面 Daemon 当前不消费但保留以备 Mobile Daemon / Cloud Sandbox 复用。
   * 当桌面 Daemon 后续接入 desktop control 类工具（screencapture/applescript）时
   * 直接合并到对应工具的 policy 即可。
   */
  devicePermissions?: Record<string, 'allow' | 'confirm' | 'block'>;
  /**
   * W7b M3 (PRD 真相 A3)：执行预算。
   *
   * `max_iterations_per_run` → DaemonAgentHost.handleQuery 转成
   * `runtime.query({ maxTurns })`，让 Settings 里"最大迭代轮数"在本地
   * runtime 真正生效。Django 端透传 `payload.execution_limits`，结构为
   * `{ max_iterations_per_run?: number, max_credits_per_run?: number }`。
   * 缺省时 runtime 走内置 DEFAULT_MAX_TURNS。
   */
  executionLimits?: {
    max_iterations_per_run?: number;
    max_credits_per_run?: number;
  };
  /**
   * W7b M3：是否启用 memory 能力。`true` 时 buildSystemPrompt 注入
   * `<agent_memory_capability>` 段（声明"你有跨会话记忆能力"），让 LLM
   * 不再开场说"我没有记忆"。具体记忆条目仍由 Django Memory v2 通过
   * context-injector 在每轮 LLM 前 in-context 注入。
   */
  memoryCapability?: boolean;
  /**
   * work_mode：Agent 工作目录类型（code/doc/mixed）。`buildSystemPrompt` 据此
   * 注入对应 `<work_mode>` 默认执行策略段（只设行为默认，不放松强制安全）。
   *
   * 来源：Django `prompt_forward_service` 从 `Agent.working_dir_type` 读出后写入
   * wire payload `working_dir_type`（daemon.ts 解出透传）。缺省 / 非法值时
   * buildSystemPrompt 跳过段注入，与 memoryCapability 同构。
   */
  workingDirType?: WorkingDirType;
  /**
   * v0.1 BYOK：当前选中模型是否为 BYOK（provider_scope='organization'|'user'）。
   * Django prompt.forward payload 透传。Daemon 转入 TabTinProxyProvider，
   * 让 503/429/401 错误分支区分 BYOK 与平台通道，给用户展示准确文案。
   */
  isByokMode?: boolean;
  /**
   *  第三波：云端 AdminDash 配置的压缩分档阈值（camelCase，已由
   * `decodeCloudPressureThresholds` 从 wire `payload.pressure_thresholds`
   * 解码校验）。优先级：云端 > env 旋钮（`TABTIN_PRESSURE_THRESHOLDS`）>
   * runtime 默认。缺省 / 畸形 → undefined 回落 env / 默认（兼容旧 Django）。
   */
  cloudPressureThresholds?: { microCompactStart: number; llmSummaryStart: number; emergencyStart: number };
  /**
   * M2.5（方案 B）：客户端生成的 user 消息 UUID。
   *
   * runtime 在主轮开头 yield `agent.stream.user` 事件时用此 id，Django
   * `relay_message_writer` 据 `client_event_id` 幂等 upsert MySQL ChatMessage。
   *
   * 历史背景：此前 Daemon 完全没发 `agent.stream.user` relay → 所有 user 消息
   * 不入库。2026-04-22 方案 B 拍板后由 runtime 统一 yield，Daemon 只需透传此 id。
   * 未传时 runtime 自动生成 UUID。详见
   *
   * 来源：Django `prompt.forward` payload.client_message_id（客户端生成）。
   */
  clientMessageId?: string;
  /** Django 签发并由 LLM Proxy 回查 AgentMentionJob 的计费幂等作用域。 */
  billingIdempotencyScope?: string;
  /** 用户可见文本；prompt 可携带隐藏上下文，落库/回显应使用本字段。 */
  displayMessage?: string;
  /**  引用回复目标，由 Django prompt.forward 透传。 */
  replyTo?: {
    messageId: string;
    preview?: { role: string; author?: string; text: string };
  };
  /**
   * 2026-05-23 push 通知重构 commit 4：本次 query 触发来源。
   *
   * 透传到 runtime `QueryParams.triggeredBy` → USER event payload `triggered_by`。
   *
   * - WS 入口（`agent.prompt.forward`）默认 `'user'` 或不传 → 常规用户消息
   * - host 内部 `_tryDrain`（push 通知 → 起新一轮 turn）设 `'push-notification'`
   *   → renderer D6 视觉区分；Django relay 提升到 `ChatMessage.metadata.triggered_by`
   *
   * 与 Electron `QueryRequest.triggeredBy` 字段语义完全对称。
   */
  triggeredBy?: 'user' | 'push-notification';
  /**
   * W3-轮 1（PRD 05 v0.4 §7.1 + §7.2.3）：crash resume 状态快照。
   *
   * 由 daemon.ts `routeToLocalAgentHost` 从 wire `payload.interrupt_state`
   * 解码得来；DaemonAgentHost.handleQuery 把它透传给 runtime.query
   * （pending-approvals-restorer 处理已批 inject + 未批重挂）。
   *
   * 详见 `@tabtin/agent-runtime` `SerializedPendingApproval` 文档。
   */
  pendingApprovalsSerialized?: SerializedPendingApproval[];
  /**
   * ：单 HITL 断点恢复快照（ask_* / permission_request）。
   * 由 daemon.ts `routeToLocalAgentHost` 从 wire `payload.interrupt_state.pending_single_hitl[]`
   * 解出并转成 camelCase；DaemonAgentHost.handleQuery 透给 runtime.query，
   * `pending-single-hitl-restorer` 处理（resolved 直接注入用户答复，pending
   * 走 interrupt.interrupt 重挂等待）。
   */
  pendingSingleHitlSerialized?: SerializedPendingSingleHitl[];
  /**
   * PRD §1.4 + DR-15（PR4-yolo H5 修复）：当前运行时是否群协作上下文。
   *
   * Space-first Phase 4 后 Django 不再从 ``Space.type`` 派生，当前显式写
   * payload.is_group_space=false；未来多 Agent 群聊应由 group runtime 配置写入。
   * daemon.ts ``routeToLocalAgentHost`` 从 wire payload 解析后透到本字段
   * （任务 4 wire parser）。
   *
   * createRuntimeForSession 据此写入 ``policyContext.isGroupSpace``，
   * buildPolicyFromAgentConfigV2 派生 effectiveMode 时与 yolo gate +
   * requestedAgentMode 三方 AND：group runtime 与 yolo 强制互斥（PRD §1.4 / DR-15）。
   *
   * 修 H5（DaemonAgentHost.ts:3375-3378 之前硬编码 false 的 fail-open）。
   * 缺省 undefined → policyContext.isGroupSpace 落 false（向后兼容老 wire）。
   */
  isGroupSpace?: boolean;
}

/**
 * `RuntimeSessionFactory` 的 build/soft 输入包：把 `submitHostQuery` 每轮解出的
 * 变量集中一处传给 adapter（`DaemonRuntimeAssembly.buildRuntimeFactoryAdapter`），
 * 避免在 adapter 里再吃一次超长参数列表。
 * `mode` / `cacheKey` 已由 factory 单独接管（`RuntimeBuildContext`），故不重复。
 */
export interface RuntimeBuildInput extends RuntimeBuildInputContract {
  modelId: string;
  agentId: string | undefined;
  authorizationPreset: 'cautious' | 'collaborative' | 'full_auto' | 'server_auto' | undefined;
  customRules: string | undefined;
  personalRules: string | undefined;
  owner: PersistedEntryOwner;
  spaceId: string | undefined;
  operationSwitches: Record<string, 'allow' | 'confirm' | 'block'> | undefined;
  disabledApps: string[];
  disabledToolPrefixes: string[];
  memoryCapability: boolean | undefined;
  workingDirType: WorkingDirType | undefined;
  executionLimits: { max_iterations_per_run?: number; max_credits_per_run?: number } | undefined;
  yoloMode: boolean | undefined;
  workspaceSnapshot: import('@tabtin/security-policy').WorkspaceSnapshot | undefined;
  isByokMode: boolean | undefined;
  enabledApps: ReadonlyArray<{ key: string; cliKey?: string; displayName: string; capability: string; aliases?: readonly string[] }> | undefined;
  isGroupSpace: boolean | undefined;
  spaceName: string | undefined;
  organizationName: string | undefined;
  cliReference: string | undefined;
  threadId: string | undefined;
  cloudPressureThresholds: { microCompactStart: number; llmSummaryStart: number; emergencyStart: number } | undefined;
  /** ：执行场绑定 workspaceId（必填）；不烘焙进 RuntimeCacheKey，经 extraKey 参与复用判定。 */
  workspaceId: string;
}

/**
 * ：Daemon 侧 runtime 复用 extraKey —— 在共享的
 * `RuntimeDisabledAppsExtraKey`（disabledApps / disabledToolPrefixes）基础上
 * 追加 `workspaceId`。workspaceId 是执行场绑定，故意不进 `RuntimeCacheKey`
 * （baked fields），但变化必须强制 rebuild —— 走 `RuntimeSessionFactory` 的
 * extraKey / extraKeysMatch 机制（与 disabledApps 同一决策通道）。
 * Electron 暂无 workspaceId 概念，不复用本类型。
 */
/**
 * Runtime 重建时跨旧/新 DaemonHostState 携带的活体状态。当前只有 SubagentManager
 * （后台子登记 + budgetTracker，不 dispose，与 Electron 对称，见 W4a S3③）。
 */
export interface RuntimeCarryForward extends RuntimeCarryForwardContract {
  subagentManager: SubagentManager;
}

export interface DaemonHostState extends RuntimeCacheKey, DaemonHostStateContract {
  runtime: AgentRuntime;
  sessionId: string;
  /**
   * 稳定业务对话 id（与 ElectronHostState.businessThreadId 同名，同语义）。
   *
   * forward 入口 `sessionId` = `payload.task_id`（`prompt_<uuid12>`，每轮变），
   * 而回退 / cancel / relay reconcile / conversation identity 都需要一个整对话
   * 恒定的 id — 通常是 `chat-session-<uuid>` 形态 threadId，缺省回落 sessionId。
   * `getOrCreateFileHistory` 也用此 key 建账本，reset 销毁时按它对称
   * `removeFileHistory`，避免用每轮变的 map key 误销/漏销。
   */
  businessThreadId: string;
  /**
   * @deprecated 使用 `businessThreadId`。保留别名给未清理完的 read 点；创建时
   * 与 `businessThreadId` 同值。
   */
  fileHistoryThreadId: string;
  modelId: string;
  /** FR-02: 记录本 runtime 首次创建时使用的 customRules，用于配置变更检测。 */
  customRules: string | undefined;
  /**
   * 三层规则·个人 / 团队基线层（IA Phase 3 §8.6）。与 customRules 同属创建期烘焙
   * 字段（烘焙进 EngineConfig.systemPrompt 的 <custom_rules> 三层块），变更纳入
   * bakedFieldsMatch 触发 runtime 重建。与 ElectronHostState 对称。
   */
  personalRules: string | undefined;
  /**
   * FR-13: 本 runtime 创建时快照的 workspaceRoot。对 Daemon 当前 workspace_root
   * 来自 readonly class field，运行时永不变；缓存键加上此字段是为了保持与
   * Electron 侧对称，并为未来支持 config hot-reload 做好防御（热更新一旦生效
   * 这里自动触发重建，不必再改缓存逻辑）。
   */
  workspaceRoot: string | undefined;
  /**
   * LH2-D3: 本 session 绑定的 owner（同 Electron 同构）。
   * Daemon 单 owner 模型下 owner 通常恒定来自 config.user_id；如未来支持
   * 多租户 Daemon，prompt.forward 携带的 user_id 变化也会触发 runtime 重建。
   */
  owner: PersistedEntryOwner;
  /**
   * W7a：烘焙到 runtime 的 agentMode。
   * 与 persona / customRules / workspaceRoot 同构 — 创建期烘焙字段，
   * 改变即重建 runtime（缓存里旧工具集 / 旧 prompt 不再有效）。
   * 与 ElectronHostState.agentMode 完全对称。
   */
  agentMode: AgentModeName;
  /**
   * W7a：烘焙到 runtime 的 spaceId（plan-tools / context injector 都需要）。
   * spaceId 变化 → DaemonToolProvider.spaceId 不更新 → plan-tools 仍指向旧
   * Space → 必须重建 runtime。同 agentMode 同构。
   */
  spaceId: string | undefined;
  workspaceId: string;
  /**
   *  followup：`max_credits_per_run` 烘焙进 CostCap.config（createRuntimeForSession
   * 构造期，readonly）。改「最大消费」后下一发消息即触发重建让新上限即时生效
   * （此前需重启才生效）。已上游归一为 number（daemon.ts decodeExecutionLimits →
   * normalizeExecutionLimitsForCostCap）；缺省 / 默认时 undefined。`max_iterations_per_run`
   * 走 per-query maxTurns，即时生效，不入缓存键。与 ElectronHostState 对称。
   */
  maxCreditsPerRun: number | undefined;
  /**
   * W7b M3：烘焙到 system prompt 的 memory 能力开关。
   * 改变 → systemPrompt 是否含 `<agent_memory_capability>` 段变化 → 必须重建。
   */
  memoryCapability: boolean;
  /**
   * work_mode：烘焙到 system prompt 的工作目录类型（已归一化）。
   * 改变 → `<work_mode>` 段变化 → 必须重建（与 memoryCapability 同构）。
   */
  workingDirType: WorkingDirType | undefined;
  disabledApps: string[];
  disabledToolPrefixes: string[];
  /**
   * W7b M3：烘焙到 ToolProvider PolicyEvaluator 的细粒度操作开关。
   * 改变 → policy 不变（缓存的工具引用旧 policy）→ 必须重建。
   * 用 shallow object 比较（mergeOperationSwitches 接受 Partial 形态）。
   */
  operationSwitches: Record<string, 'allow' | 'confirm' | 'block'> | undefined;
  abortController: AbortController;
  pauseController: SessionPauseController;
  sessionStorage: SessionStorage;
  /** Phase 2 · Debug Observability */
  snapshotStorage: SnapshotStorage;
  eventStorage: EventStorage;
  toolLogWriter: ToolLogWriter | null;
  toolProvider: DaemonToolProvider;
  eventInterceptor?: (event: StreamEvent) => void;
  eventEmitter: EventEmitter;
  /**
   * W7a：最新的 Tab/App 上下文，供 createContextInjector hook 在 beforeIteration
   * 时读取并注入 `<context>...</context>` 消息。
   *
   * 来源：每次 handleQuery 时由 `request.appContext` 写入；createContextInjector
   * 通过闭包 `() => session.appContext ?? null` 异步取值，类型契合
   * `ContextInjectorOptions.getAppContext`。
   *
   * 与 Electron 同构（ElectronHostState.appContext）；唯一差异是 Electron 还
   * 通过 IPC `agent-engine:update-context` 在 query 之间更新；Daemon 没有这
   * 类边带通道，每轮 query 携带最新 context 即可。
   */
  appContext: AppContext | null;
  /**
   * ：本轮当前 Agent 展示名 / 人设与规则。每轮 query 入口覆盖；
   * agent-profile hook 通过闭包读取并贴用户消息前注入。
   */
  agentProfile: {
    agentName?: string;
    customRules?: string;
  } | null;
  /**
   * W7a：对 createRuntime 传入的 EngineConfig 的引用，用于未来软切换 mode
   * （runtime 通过闭包持有同一引用，mutate systemPrompt / agentMode 即生效）。
   * 当前 Daemon 路径还未实现软切换 —— mode 改变直接走重建路径；保留此引用是
   * 为了与 Electron 接口对齐，避免后续接入软切换时再回头加字段。
   */
  engineConfig: EngineConfig;
  /**
   * W1.2：本 session 的 NativeBackendSession + 关联 ExecutionBackend。
   * feature flag 关闭或装配失败时为 null；query.ts 主路径不消费 ——
   * 仅为 W2 Capability 装配。
   */
  backendBootstrap: NativeBackendBootstrapResult | null;
  /**
   * Hilt v3 / W6 M2：本 session 的 AgentConfigV3 / WorkspaceSnapshot 可变实例。
   *
   * `buildJudgePolicy` 工厂闭包持有这两个对象的引用 —— handleQuery 入口
   * 直接 mutate `agentConfigV3.security.allow_yolo_mode` 与 `workspaceSnapshot.sources`，
   * 让 PD-13 工厂调用时即时反映用户最新选择 + 主控端最新工作区，无需重建
   * runtime。与 ElectronHostState 同构。
   */
  agentConfigV3: import('@tabtin/security-policy').AgentConfigV3 | null;
  workspaceSnapshot: import('@tabtin/security-policy').WorkspaceSnapshot | null;
  /**
   * YOLO 两步授权 PRD v3 §5.5.2：buildJudgePolicy 闭包派生 effectiveMode
   * 所需的两个入参（requestedAgentMode + isGroupSpace）。与 ElectronHostState
   * 同构。详见 ElectronAgentHost.HostState.policyContext 注释。
   *
   * `currentAgentMode` 是可变源：每次 handleQuery 入口从消息体 `agent_mode` 派生
   * 后就地 mutate。`isGroupSpace` 是初始化期字段（session 创建时一次性确定）。
   */
  policyContext: {
    currentAgentMode: AgentModeName;
    isGroupSpace: boolean;
    /**
     *  三档审批策略：对话级请求档（可变源，每次 handleQuery 入口从
     * wire `approval_mode` 派生后就地 mutate；undefined = 消息未带 → build-policy
     * legacy 归一）。与 ElectronAgentHost.HostState.policyContext 同构。
     */
    requestedApprovalMode?: import('@tabtin/security-policy').ApprovalMode;
  };
  /**
   * W4a S1（2026-05-30）：本 session 的子 Agent 运行登记中心（session 维度）。
   *
   * 与 ElectronHostState.subagentManager 完全对称。agent-tool 在 active 子 spawn
   * 时双写登记（模块级 activeChildren 保留给 W0 取消链路）；host.stop() /
   * runtime 重建覆盖旧 session 时 dispose 只取消*本 session* 的子。后续 PR
   * （S3 live 重绑 / S4 后台子 / S7 interrupt）以它为入口。
   */
  subagentManager: SubagentManager;
  /**
   * W4a S2（2026-05-30）：子 Agent 实时流的 session 级统一出口（**跨 query 存活**）。
   *
   * 与 ElectronHostState.subagentStreamSink 对称（Daemon 无 sender，省略 IPC 推送）。
   * `emitStreamEvent` 经此出口；query 内表现等同原 `eventInterceptor` 转发（前台
   * 不变），query 外（后台子）改走 `relaySubagentStreamEventDirect` 直接 gateway
   * relay，避免现状「query 外 emitStreamEvent no-op 丢弃」让后台子实时面板黑屏。
   */
  subagentStreamSink: (event: StreamEvent) => void;
}

// ─── Model Catalog Cache (W1b: catalog-driven) ─────────────────────
//
// 硬编码 MODEL_CONTEXT_WINDOWS 已移除。Daemon 在 start() 时从 Django
// /services/llm/catalog 拉取模型列表并缓存，定时刷新（5 分钟）。
// createRuntimeForSession 通过缓存构建 resolveContextWindow。
// 缓存未命中 / catalog 不可达时 fallback 到 FALLBACK_MODEL_CAPABILITIES。

export interface CatalogEntry extends CatalogEntryContract {
  contextWindowTokens: number;
  maxOutputTokens: number;
  supportsVision: boolean;
  supportsFunctionCalling: boolean;
  supportsPromptCaching: boolean;
  cacheType: 'explicit' | 'implicit' | 'none';
  reasoningHistoryPolicy?: 'drop' | 'preserve_for_tools' | 'preserve';
  // 子 Agent 模型自由度（Phase 3/4）：原 W1b 缓存只存能力字段，给子 Agent 菜单
  // 还需要这几个「展示/选型」字段——id、显示名、语义用途标签（catalog API 自动生成）、
  // provider scope（区分 BYOK）。
  // ：id 必须是 catalog → runtime → proxy 契约形态（DB UUID 或 declared:），
  // 不能是裸 model_name——否则透给 Django proxy 会"模型不存在或未激活"。model_name
  // 走 aliases 供 findCatalogEntry 按人类可读名匹配。
  id: string;
  aliases?: string[];
  displayName?: string;
  usageHint?: string;
  providerScope?: string;
}

interface CatalogModelRaw {
  id?: string;
  name?: string;
  model_name?: string;
  display_name?: string;
  context_window_tokens?: number;
  max_output_tokens?: number;
  resolved_capabilities?: { supports_vision?: boolean; supports_function_calling?: boolean };
  capabilities_config?: Record<string, unknown>;
  provider?: string;
  usage_hint?: string;
  provider_scope?: string;
}

const CATALOG_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// ─── Helpers ────────────────────────────────────────────────────────

function resolveAppsRoot(): string | undefined {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'packages', 'apps'))) {
      return join(dir, 'packages', 'apps');
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function resolveBundledRoot(): string | undefined {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'packages', 'skills', 'bundled');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function resolvePackageSkillsRoot(): string | undefined {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'packages', 'skills');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

// ─── DaemonAgentHost ────────────────────────────────────────────────

export interface DaemonAgentHostDeps {
  gateway: AgentGatewayPort;
  config: DaemonConfig;
  logger: Logger;
  /** Returns current access token from the gateway or heartbeat */
  getAccessToken: () => string;
  /** MCP server provider — returns endpoint info for TabTinMcpServer */
  getMcpServerEndpoint?: () => { url: string; token: string } | null;
  /** Workspace root path (e.g. from DaemonConfig) */
  workspaceRoot?: string;
  /** Space ID (resolved from prompt.forward or config) */
  spaceId?: string;
  /** Organization ID for billing attribution */
  organizationId?: string;
  getPtyManagerBridge: () => AgentTerminalPort | null;
  docParser: DocParserPort;
}

/** Terminal capabilities consumed by the Agent application module. */
export type { AgentTerminalPort } from './contracts.js'
export type DaemonQueryResult = DaemonQueryResultContract

/**
 * Daemon 端 SessionStorage → RelaySessionOrchestrator 契约的适配器（与 Electron
 * `relaySessionStorageViewOf` 完全对称）。
 */
function relaySessionStorageViewOf(
  mapKey: string,
  session: DaemonHostState,
): RelaySessionStorageView {
  return {
    mapKey,
    businessThreadId: session.businessThreadId,
    owner: session.owner,
    eventsFilePath: session.eventStorage.filePath,
    loadTranscript: () => session.sessionStorage.loadTranscript(),
    // ：block 文件是消息级对账权威源；加载失败允许空列表回退（保持旧行为一致）。
    loadBlockRecords: () => session.sessionStorage.blockStorage.load(),
  };
}

export class DaemonAgentHost {
  private readonly sessionState = new AgentSessionState<DaemonQueryRequest, SkillCredentialResolverHandle>();
  /** pause 下行可能早于本机会话 runtime 创建；暂存候选 ID，创建时补应用。 */
  private readonly pendingPauseCandidateIds = new Set<string>();
  private get sessions() {
    return this.requireSharedHost().sessions;
  }
  /**
   * Agent runtime 装配（build / soft-reconfigure / rebuild + createRuntimeForSession
   * + 各 catalog/portrait/cli-reference loader）。平台外壳委托到这里——本文件不再
   * 持有 createRuntime 知识。与 ElectronAgentHost.runtimeAssembly 同构（懒建 + ports
   * getter 注入 host 侧最新值）。
   */
  private _runtimeAssembly: DaemonRuntimeAssembly | null = null;
  private get runtimeAssembly(): DaemonRuntimeAssembly {
    if (!this._runtimeAssembly) {
      const host = this;
      this._runtimeAssembly = new DaemonRuntimeAssembly({
        get logger() { return host.logger; },
        get config() { return host.config; },
        getAccessToken: () => host.getAccessToken(),
        runDocParserTask: host.docParser.runTask,
        terminal: { current: () => host.getPtyManagerBridge() },
        get workspaceRoot() { return host.workspaceRoot; },
        session: {
          get sessions() { return host.sessions; },
          state: host.sessionState,
          get interactionRegistry() { return host.interactionRegistry; },
          getHost: () => host.requireSharedHost(),
        },
        skills: {
          module: () => host.skillsModule,
          ready: () => host.skillsReady,
          enablementCache: host.skillEnablementCache,
        },
        resolveModelFromCatalog: (modelId) => host.resolveModelFromCatalog(modelId),
        get syncPersistenceEnabled() { return host.syncPersistenceEnabled; },
        drainThreadNotificationsText: (threadId) => host.drainThreadNotificationsText(threadId),
        buildModelCatalogSnapshot: () => host.buildModelCatalogSnapshot(),
        relaySubagentStreamEventDirect: (sessionId, event) =>
          host.relaySubagentStreamEventDirect(sessionId, event),
        applyPendingPauseToSession: (sessionId, fileHistoryThreadId, pauseController) =>
          host.applyPendingPauseToSession(sessionId, fileHistoryThreadId, pauseController),
      });
    }
    return this._runtimeAssembly;
  }
  private sharedHost: AgentHost<DaemonQueryRequest, DaemonQueryResult, DaemonHostState> | null = null;
  private agentTransport: DaemonAgentTransport | null = null;
  /**
   * Bound by TabTinDaemon so prompt.forward keeps daemon-specific
   * DaemonQueryRequest mapping. Shared zod 校验（PromptForwardPayloadSchema）
   * 已在 AgentHost dispatch 里做完一次，handler 收到的 `request` 与 daemon-side
   * 消费的字段完全一致；`envelope` 保留用于取 thread_id / task_id 上报。
   */
  private promptForwardHandler:
    | ((
        request: ForwardConversationRequest,
        envelope: Record<string, unknown>,
      ) => Promise<boolean>)
    | null = null;
  /**
   * Bound by TabTinDaemon so schema-invalid prompt.forward envelopes get
   * relayed as `agent.stream.done(error)` via `reportPromptForwardFailure`.
   */
  private promptForwardDecodeFailedHandler:
    | ((
        envelope: Record<string, unknown>,
        failure: ForwardDecodeFailure,
      ) => Promise<void>)
    | null = null;
  /**
   * ：per-session 串行执行器 + FIFO 队列（与 ElectronAgentHost 同构）。
   * `handleQuery` 入口经它提交——session 忙时入队而非拒绝，终态自动 drain。
   * runtime 侧「session 忙 / 排队」的唯一真相源。阶段 4 起 daemon 也**不再**
   * 维护额外的 `runningSessions` Set 影子——忙闲派生读走 `AgentHost.isBusy`
   * / `AgentHost.getState` 门面，避免双写漂移。
   */
  /**
   * 路径权限治理 Wave 4 (P1-5 修复)：按 spaceId 严格匹配当前 session 的
   * WorkspaceSnapshot。
   *
   * 拆双接口：
   *   - `findWorkspaceSnapshotForSpace(spaceId)` 严格 spaceId 匹配 →
   *     未命中返回 null（fail-closed，避免跨 Space 越权）
   *   - `findAnyActiveWorkspaceSnapshot()` 任意 session（headless 单 session
   *     模式专用，譬如 MCP/CLI 入口本机 LLM client 不带 spaceId）
   *
   * 这版强制 caller 显式表达"我要严格匹配"还是"我接受任意 session"语义，
   * 避免上一版"miss 后悄悄 fallback 到任意 session"导致的 multi-Space
   * 越权（Wave 3 已在 Electron 端把 union 改成 spaceId 路由修过 L14；
   * Daemon 这次不能倒回去）。
   */
  findWorkspaceSnapshotForSpace(
    spaceId: string,
  ): import('@tabtin/security-policy').WorkspaceSnapshot | null {
    if (!spaceId) return null;
    for (const session of this.sessions.values()) {
      if (session.spaceId === spaceId && session.workspaceSnapshot) {
        return session.workspaceSnapshot;
      }
    }
    return null;
  }

  /**
   * 任意活跃 session 的 WorkspaceSnapshot —— headless dogfood 单 session
   * 模式专用（MCP server / CLI server 无 spaceId 透传时的入口）。
   *
   * 多 Space 同 daemon 场景禁用此函数；caller 必须明确表达"我没有 spaceId
   * 但接受任意 session"语义。返回 null 时 caller 应走 `config.workspace_root`
   * 单条目录兜底。
   */
  findAnyActiveWorkspaceSnapshot(): import('@tabtin/security-policy').WorkspaceSnapshot | null {
    for (const session of this.sessions.values()) {
      if (session.workspaceSnapshot) return session.workspaceSnapshot;
    }
    return null;
  }

  /**
   * W7a：HITL 超时语义统一为"删除 pending，不 resolve"（与 Electron 同构）。
   *
   * 行为对比：
   *   - 旧 Daemon：超时后 `resolve({ cancelled: true, reason: 'timeout' })`，让
   *     LLM 继续走但 Agent 看到 cancelled → 业务路径不一致（Electron 永远不
   *     resolve，让 query 自然挂起被外层 abortController / dispose 兜底）。
   *   - 新 Daemon = Electron：删除 pending（不 resolve），由调用方
   *     （tool 内部的 await 或外层 abortController.abort()）决定后续。
   *
   * 详见 `createRuntimeForSession` 内 `waitForUserInput` 实现注释。
   */
  /**
   * v0.4 W1.5（PRD §7.5.7）：HITL pending resolver map，与 Electron 同构对齐。
   *
   * key 在 v0.4 后是 batchId（LocalPermissionHandler.requestPermissionsBatch 注册）；
   * v0.3a 兼容期 fallback 单 requestId。同时给 ask_user / approval（v0.3a 的
   * review_required → v0.4 approval_requested）用。
   *
   * 旧名 pendingUserInputRequests → 新名 interactions。
   */
  // Phase 3 F1（2026-05-28）：entry 携带 sessionId 与 Electron 同构对齐，
  // 让 applyCancelledByRollbackToHitl / cancelAllPendingHitlRequests 共享类型。
  private get interactionRegistry() {
    return this.requireSharedHost().interactions.registry;
  }

  /**
   * 无人值守交互档（HITL 四态）按 sessionId 记录（与 ElectronAgentHost 同构）。
   * 仅 forward 路径在 `interaction_mode` 非 interactive 时写入，query 结束即删。
   * 消费：waitForUserInput（'scheduled' → 立即 reject，ask-tools fail-fast）+
   * LocalPermissionHandler.runtimeMode（judge-ask 0 秒 fail-fast）。均实时读 map，
   * 兼容 runtime 缓存复用。普通路径不在 map → 'interactive'，行为不变。
   */

  /**
   * 2026-05-23 push 通知重构 commit 3：NotificationQueue subscribe 取消句柄。
   * 与 ElectronAgentHost.notificationQueueUnsubscribe 同款。
   * 详见 PRD §6.3 + §6.7（双端对称契约）。
   */
  private notificationQueueUnsubscribe: NotificationQueueUnsubscribe | null = null;

  private readonly gateway: AgentGatewayPort;
  private readonly config: DaemonConfig;
  private readonly logger: Logger;
  private readonly getAccessToken: () => string;
  private readonly getMcpServerEndpoint?: () => { url: string; token: string } | null;
  private readonly getPtyManagerBridge: () => AgentTerminalPort | null;
  private readonly docParser: DocParserPort;
  /**
   * ：catalog miss 回落 FALLBACK_MODEL_CAPABILITIES (32k) 的去重告警集合。
   * `resolveModelFromCatalog` 每个 miss 的 modelId 只 warn 一次（避免 per-query
   * spam——该函数经 `resolveContextWindow` 每 query 调一次）；catalog 刷新成功
   * 时清空，让"刷新后重新 miss"能再告警。
   */
  private readonly catalogFallbackWarned = new Set<string>();
  private readonly persistenceSupervisor = new AgentPersistenceSupervisor({
    isEnabled: () => this.syncPersistenceEnabled,
    syncRoot: () => this.syncRoot,
    ownerKey: owner => this.ownerKey(owner),
    warn: message => this.logger.warn(message),
  });

  /** Shared relay outbox; Daemon recovery is deliberately scoped to its current config owner. */
  private readonly relayPersistence = new MessageDeliveryOutbox({
    isPersistenceEnabled: () => this.syncPersistenceEnabled,
    getSyncRoot: () => this.syncRoot,
    resolveOwnerBestEffort: () => this.resolveOwnerBestEffort(),
    fallbackOrganizationId: () => this.config.organization_id,
    sendOnce: (_organizationId, sessionId, events) =>
      this.gateway.relayEvents(sessionId, events),
    sendRecoveredOnce: async (owner, sessionId, events) => {
      const currentOwner = this.resolveOwnerBestEffort();
      if (!currentOwner || !ownersMatch(currentOwner, owner)) {
        throw new Error('relay recovery owner changed before send');
      }
      await this.gateway.relayEvents(sessionId, events);
    },
    logger: {
      info: (message) => this.logger.info(`[DaemonAgentHost] ${message}`),
      warn: (message) => this.logger.warn(`[DaemonAgentHost] ${message}`),
    },
  });
  /** 是否已注册 WS 重连 recover 回调（gateway.onReconnect 无解绑，用 flag 防重复注册）。 */
  private relayReconnectRegistered = false;
  private hostTrackerReconnectRegistered = false;
  private hostTrackerWork: Array<{ runId: string }> = [];
  private readonly hostTrackerRunBySession = new Map<string, string>();
  private readonly hostTrackerScheduler = new HostTrackerScheduler({
    fetchSchedule: () => this.fetchHostTrackerSchedule(),
    fire: (trackerId: string) => this.fireHostTracker(trackerId),
    fetchWork: () => this.fetchHostTrackerWork(),
    executeWork: (runId: string) => this.executeHostTrackerRun(runId),
    reconcile: () => this.reconcileHostTrackerLifecycle(),
    logger: {
      info: (message: string) => this.logger.info(message),
      warn: (message: string, error?: unknown) => this.logger.warn(message, error),
    },
  });
  /**
   * relay outbox recover + 活跃 session backfill 编排（Stage 3：下沉到 agent-host）。
   * 与 ElectronAgentHost.relayOrchestrator 同构；只在 platform 侧的 API base、
   * token 取用、logger 前缀上有差异。
   */
  private readonly relayOrchestrator = new RelaySessionOrchestrator({
    outbox: this.relayPersistence,
    logger: {
      debug: (message) => this.logger.debug(`[DaemonAgentHost] ${message}`),
      info: (message) => this.logger.info(`[DaemonAgentHost] ${message}`),
      warn: (message) => this.logger.warn(`[DaemonAgentHost] ${message}`),
    },
    listStorage: () => this.iterateRelaySessionStorageViews(),
    getApiBaseUrl: () => deriveApiBaseUrl(this.config.server_url),
    resolveOwner: async () => this.resolveOwnerBestEffort(),
    getAccessToken: async () => this.getAccessToken() || null,
  });
  /**
   * push 通知 idle drain 编排（Stage 3：下沉到 agent-host）。与 Electron 对称，
   * daemon 端 `runTurn` 走 `handleQuery` 而非 `submitQuery`（daemon 没有 sender 概念）。
   */
  private readonly notificationDrain = new NotificationIdleDrain({
    getQueue: () => this.resolveNotificationQueue(),
    isBusy: (threadId) => this.requireSharedHost().isBusy(threadId),
    hasSession: (threadId) => this.sessions.has(threadId),
    runTurn: (context) => this.runNotificationDrainTurn(context),
    logger: {
      info: (message) => this.logger.info(message),
      warn: (message) => this.logger.warn(message),
      error: (message) => this.logger.error(message),
    },
    logPrefix: 'DaemonAgentHost',
  });

  /**
   * 长上下文档位（Context Tier）—— Daemon 模式下与 Electron 同样的语义：
   * Per-Session 选档；空 = 默认档。runtime 创建时把 contextTierId 配成
   * getter，每次 LLM 请求实时读取，不需要重建 runtime。
   *
   * 当前 Daemon 写入入口预留：CLI / 上层管理 API 后续可调用
   * `setSessionContextTier(sessionId, tierId)` 同步状态。
   */

  setSessionContextTier(sessionId: string, tierId: string | null | undefined): void {
    this.sessionState.setContextTier(sessionId, tierId);
  }

  private syncPersistenceEnabled = false;
  /** LH2-D1：sync 数据根目录（`~/.tabtin-daemon/agent-sync/`），按账号在下面分桶。 */
  private syncRoot = '';
  /**
   * Resolved once at construction from `DaemonAgentHostDeps.workspaceRoot`
   * (Daemon passes `config.workspace_root`). Forwarded to `EngineConfig.workspaceRoot`
   * and the `agent` tool so run_terminal_command / action-tools operate in the user's workspace,
   * not the Daemon's process cwd.
   */
  private readonly workspaceRoot?: string;

  /**
   * Wave 3a N1/N2：本地 Skill 模块 handle（与 Electron skillsModule 完全对称）。
   *
   * 生命周期：`start()` 里 `initSkillsModule()` → `stop()` 里 `disposeSkillsModule()`。
   * 所有 session 共享同一 registry——skill 来源维度（platform/app/user）与 Space 无关。
   */
  private skillsModule: SkillsModuleHandle | null = null;
  private skillsReady: Promise<void> | null = null;
  /**
   * Agent 级 SkillEnablement 缓存（与 Electron 对称）。
   * 封闭携带集：仅 enabled===true。
   */
  private readonly skillEnablementCache = new SkillEnablementMapCache(
    async (agentId) =>
      fetchSkillEnablementMap({
        apiBaseUrl: deriveApiBaseUrl(this.config.server_url),
        agentId,
        getAccessToken: () => this.getAccessToken(),
      }),
    30_000,
    (error, agentId) => {
      this.logger.warn(
        `[SkillEnablement] refresh failed agent=${agentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
  );

  /**
   * Wave 1.5 遗留 + Wave 2a 补丁 P0-2（独立质疑 2）：**按 session 存放**所有
   * 活跃 resolver handle 的 Map（key = sessionId）。
   *
   * 历史背景：Wave 1.5 初版只保留"最近一次"构造的 resolver 到单字段；Wave 2a
   * 独立质疑指出 —— 每次 ``createRuntimeForSession`` 会覆盖该字段，**旧
   * session 的 ToolProvider 仍持着旧 resolver 的闭包**，Wave 5 "改完密钥刷新
   * 缓存" IPC 只能清到 Map 里最新那一个，其他 session 要再等到 60s TTL 兜底
   * 才会失效——用户在这 60s 窗口内继续用过期密钥执行 Skill。
   *
   * 本次修复采用**方案 B（Daemon-side Map）**而非方案 A（模块级 singleton）：
   *   - 方案 A 看似优雅，但 resolver **构造参数**因 session 而异（至少
   *     ``organizationId`` 从 ``this.config.organization_id`` 拿，且 ``apiAuthToken``
   *     getter 闭包捕获 ``getAccessToken``；未来多租户 Daemon 还会按 owner
   *     切换）——singleton 需要"按 owner 分桶"再演化为另一个 Map，与当前
   *     `accountSyncQueues` 体系重复；
   *   - 方案 A 要改 Electron 侧（ElectronAgentHost 对等实现）—— 超出 Wave 2a
   *     补丁范围；
   *   - 方案 B 改动面最小（只动 DaemonAgentHost），且语义与 Electron 保持
   *     对称（Electron 每个 ElectronAgentHost 自带一份 per-session 行为，本
   *     Map 就是 Daemon 的对等物）。
   *
   * Wave 5 IPC 接线只需调 ``invalidateSkillCredentialCaches(filter)`` 即可**
   * 广播到所有活跃 session**——彻底解决"旧 session 60s 内沿用过期密钥"的窗口。
   *
   * 生命周期：
   *   - ``createRuntimeForSession`` 构造新 resolver → set(sessionId, handle)；
   *     若 sessionId 已存在（rebuild 路径，上层已清旧 runtime），直接覆盖，旧
   *     handle 随 ToolProvider 被 GC。
   *   - session 被删除（stop / resetAccountSync / runtime rebuild）→ 对应
   *     entry 删除，cache 立即释放。
   */

  /**
   * FR-18 Phase 2 (H2-E)：本地解析的体积上限（MB）。
   *
   * 构造期通过 `resolveMaxLocalFileSizeMb(env, logger)` 从 `TABTIN_LOCAL_DOCPARSE_MAX_MB`
   * 解析；缺省 / 非法值回落 `DAEMON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB`（20MB）。
   *
   * 与 Electron 的差异：Electron 走 packages 默认 50MB；Daemon 跑在 NAS / 公司服务器
   * / 个人 PC 后台，CPU/内存可能弱于桌面，默认更保守。运维可通过 env 调整。
   */
  private readonly maxLocalFileSizeMb: number;

  /**
   * W1b：模型 catalog 缓存。key 是 model name（如 `claude-sonnet-4-20250514`），
   * value 是从 Django /services/llm/catalog 解析的能力数据。
   *
   * start() 时首次拉取；此后每 5 分钟自动刷新。fetch 失败静默保留旧缓存
   * （不清空），避免网络闪断导致所有模型 fallback 到保守默认值。
   */
  private modelCatalogCache = new Map<string, CatalogEntry>();
  private catalogRefreshTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * YOLO PRD v3 review M2（与 ElectronAgentHost.agentConfigClient 对称）：
   * 每条消息从 Django 现拉权威 `agent_config`。
   *
   * Wire `payload.yolo_mode` / `payload.approval_grant` 只作 bootstrap /
   * telemetry；handleQueryInternal 入口 await 本 client 拿真值后覆写
   * `session.agentConfigV3.security`。Daemon 之前只信 wire 值——攻击者
   * 若能伪造 forward payload（本 daemon 的信任模型基于 Django 服务端签发
   * 的 gateway envelope，理论上不易伪造，但符号化"权威源=Django DB"
   * 的语义更清晰，且与 Electron 双端行为对齐）。
   *
   * client 是宿主内单例（5s 内存 cache，per-agentId）；fetch 失败
   * deny-by-default（allow_yolo=false / grant=always_ask），永不抛错。
   */
  private readonly agentConfigClient: AgentConfigClient;

  constructor(deps: DaemonAgentHostDeps) {
    this.gateway = deps.gateway;
    this.config = deps.config;
    this.logger = deps.logger;
    this.getAccessToken = deps.getAccessToken;
    this.getMcpServerEndpoint = deps.getMcpServerEndpoint;
    this.getPtyManagerBridge = deps.getPtyManagerBridge;
    this.docParser = deps.docParser;
    this.workspaceRoot = normalizeWorkspaceRoot(deps.workspaceRoot);

    // per-file 回退引擎：注入 daemon logger 到模块级 registry（与 setCheckpointLogger
    // 同款）。host 与 action-bridge 在 daemon 里独立组装，故 registry 走模块级单例共享。
    setFileHistoryLogger(this.logger);

    // FR-18 Phase 2 (H2-E)：本地解析体积上限。在构造期一次解析，记录到日志便于
    // 运维确认配置生效（部分 Daemon 部署在 NAS / 老服务器，把 20MB 调到 50/100MB
    // 是常见运维操作；启动日志能让用户立刻知道值是否被覆盖）。
    this.maxLocalFileSizeMb = resolveMaxLocalFileSizeMb(process.env, this.logger);

    // FR-13: 未配置 `workspace_root` 时 run_terminal_command 等工具会静默 fallback 到 Daemon
    // 进程启动目录（通常是 `/`、launchd 工作目录或 init 脚本 cwd），用户会
    // 踩到"`pwd` 输出诡异目录"的坑。启动期给运维一条显式提示，避免首次
    // 使用时一头雾水。（热更新不做，留作遗留项 L-Daemon-workspace-hot-reload。）
    if (this.workspaceRoot === undefined) {
      this.logger.warn(
        '[DaemonAgentHost] workspace_root is not configured; run_terminal_command and filesystem tools will use the Daemon process cwd. Run `tabtin-daemon config --set workspace_root=<path>` to fix.',
      );
    } else {
      this.logger.info(`[DaemonAgentHost] workspace_root=${this.workspaceRoot}`);
    }
    this.logger.info(
      `[DaemonAgentHost] local docparse max file size: ${this.maxLocalFileSizeMb}MB`,
    );

    // YOLO PRD v3 review M2：与 Electron 对称——handleQueryInternal 入口现拉
    // Django 权威 `agent_config`，wire yolo_mode / approval_grant 只作 telemetry。
    // fetch 失败 deny-by-default；配置见 `@tabtin/agent-host/policy`。
    this.agentConfigClient = createAgentConfigClient({
      getAccessToken: () => this.getAccessToken(),
      getOrganizationId: () => this.config.organization_id,
      buildAgentDetailUrl: (agentId: string) =>
        joinApiPath(
          deriveApiBaseUrl(this.config.server_url),
          API_ENDPOINTS.AGENT.DETAIL(agentId),
        ),
      logger: {
        debug: (message) => this.logger.debug(message),
        info: (message) => this.logger.info(message),
        warn: (message) => this.logger.warn(message),
      },
    });
  }

  /**
   * TabTinDaemon 注入：接住共享 zod decode 后的 `ForwardConversationRequest`，
   * 由 daemon 侧组装 `DaemonQueryRequest`（含 subagent_config、跨轮 history
   * kill-switch 等 daemon-specific 字段，通过 `request.parsedPayload` 读原始
   * wire payload）。共享 decode 失败时（zod schema 失败）走另一路 hook
   * `bindPromptForwardDecodeFailedHandler`，与旧的双 safeParse 相比只保留唯一
   * 一条解码路径（AgentHost dispatch 里 `PromptForwardPayloadSchema.safeParse`）。
   */
  bindPromptForwardHandler(
    handler: (
      request: ForwardConversationRequest,
      envelope: Record<string, unknown>,
    ) => Promise<boolean>,
  ): void {
    this.promptForwardHandler = handler;
  }

  bindPromptForwardDecodeFailedHandler(
    handler: (
      envelope: Record<string, unknown>,
      failure: ForwardDecodeFailure,
    ) => Promise<void>,
  ): void {
    this.promptForwardDecodeFailedHandler = handler;
  }

  /**
   * Feed host-owned Agent envelopes from the Daemon gateway bridge.
   * Cancel / subagent 在投喂前先做 Daemon 侧 zod（比共享 decode 更严），
   * 校验失败不进入 AgentRealtime，避免丢掉 Invalid payload 语义。
   */
  feedAgentEnvelope(envelope: AgentTransportEnvelope): void {
    if (envelope.type === 'agent.prompt.cancel') {
      const parsed = PromptCancelPayloadSchema.safeParse(envelope.payload ?? {});
      if (!parsed.success) {
        this.logger.warn(`[Daemon] Invalid prompt.cancel payload: ${parsed.error.message}`);
        return;
      }
    }
    if (envelope.type === 'agent.subagent.cancel') {
      const parsed = SubagentCancelPayloadSchema.safeParse(envelope.payload ?? {});
      if (!parsed.success) {
        this.logger.warn(`[Daemon] Invalid subagent.cancel payload: ${parsed.error.message}`);
        return;
      }
    }
    this.agentTransport?.feed(envelope);
  }

  private requireSharedHost(): AgentHost<DaemonQueryRequest, DaemonQueryResult, DaemonHostState> {
    if (!this.sharedHost) {
      throw new Error('AgentHost is not started');
    }
    return this.sharedHost;
  }

  private async startSharedHost(): Promise<void> {
    if (this.sharedHost) return;
    this.agentTransport = new DaemonAgentTransport(this.gateway);
    this.sharedHost = await AgentHost.start<
      DaemonQueryRequest,
      DaemonQueryResult,
      DaemonHostState
    >({
      transport: this.agentTransport,
      deviceId: this.config.fingerprint,
      logger: {
        debug: (message) => this.logger.debug(message),
        warn: (message, context) => {
          if (context) {
            this.logger.warn(message, context);
          } else {
            this.logger.warn(message);
          }
        },
      },
      publishHumanInteraction: async (context, _request, event) => {
        const sessionId = context.threadId.startsWith('chat-session-')
          ? context.threadId.slice('chat-session-'.length)
          : context.threadId;
        if (!sessionId) return false;
        await this.gateway.relayEvents(sessionId, [event]);
        return true;
      },
      publishHumanInteractionResolution: async (context, event) => {
        const sessionId = context.threadId.startsWith('chat-session-')
          ? context.threadId.slice('chat-session-'.length)
          : context.threadId;
        if (!sessionId) return false;
        await this.gateway.relayEvents(sessionId, [event]);
        return true;
      },
      onConversationIdle: (conversationId) =>
        this.scheduleNotificationDrainOnIdle(conversationId),
      onForwardDecodeFailed: async (envelope, failure) => {
        if (!this.promptForwardDecodeFailedHandler) {
          this.logger.warn(
            `[DaemonAgentHost] prompt.forward decode failed but no decode-failure handler bound: ${failure.error}`,
          );
          return;
        }
        await this.promptForwardDecodeFailedHandler(
          envelope as Record<string, unknown>,
          failure,
        );
      },
      commands: {
        forward: async (request, envelope) => {
          if (!request) {
            // 兜底：`onForwardDecodeFailed` 已上报（含日志/relay），
            // 这里的 null 只是共享 decode 未通过又没绑失败 hook 的兼容分支。
            return;
          }
          if (!this.promptForwardHandler) {
            this.logger.warn('[DaemonAgentHost] prompt.forward received but no forward handler bound');
            return;
          }
          const admitted = await this.promptForwardHandler(
            request,
            envelope as Record<string, unknown>,
          );
          if (admitted) {
            await this.acknowledgePromptAdmission(
              request.runId,
              envelope as Record<string, unknown>,
            );
          }
        },
        cancel: ({ envelope, sessionId, taskId }) => {
          if (envelope) {
            const candidates = extractAbortIdentityCandidates(
              envelope as Record<string, unknown>,
            );
            if (candidates.length === 0) {
              this.logger.warn('[Daemon] prompt.cancel without task_id or thread_id — ignored');
              return;
            }
            for (const id of candidates) {
              const result = this.handleAbort(id);
              if (result.success) {
                this.logger.info(
                  `[Daemon] prompt.cancel routed to local runtime: id=${id.slice(0, 16)}`,
                );
                return;
              }
            }
            this.logger.warn(
              `[Daemon] prompt.cancel failed: candidates=${candidates.map((c) => c.slice(0, 16)).join(', ')}`,
            );
            return;
          }
          if (sessionId) this.handleAbort(sessionId);
          else if (taskId) this.handleAbort(taskId);
        },
        cancelSubagent: ({ childId }) => {
          const ok = this.cancelSubagentById(childId);
          if (ok) {
            this.logger.info(
              `[Daemon] subagent.cancel routed to local runtime: child=${childId.slice(0, 8)}`,
            );
          } else {
            this.logger.warn(
              `[Daemon] subagent.cancel not matched (already done / wrong process): child=${childId.slice(0, 8)}`,
            );
          }
        },
        pause: ({ envelope }) => {
          const candidates = extractAbortIdentityCandidates(envelope as Record<string, unknown>);
          if (!this.handlePause(candidates).success) {
            this.logger.warn(`[Daemon] prompt.pause not matched: ${candidates.join(', ')}`);
          }
        },
        resume: ({ envelope }) => {
          const candidates = extractAbortIdentityCandidates(envelope as Record<string, unknown>);
          if (!this.handleResume(candidates).success) {
            this.logger.warn(`[Daemon] prompt.resume not matched: ${candidates.join(', ')}`);
          }
        },
        userResponse: async ({
          requestId,
          response,
          batchId,
          decisions,
          submitId,
          envelope,
        }) => {
          await this.handleSharedHostUserResponse({
            requestId,
            response,
            batchId,
            decisions,
            submitId,
            envelope,
          });
        },
        permission: ({ type }) => {
          this.logger.debug(`[DaemonAgentHost] permission command ignored: ${type}`);
        },
        actionRequest: () => {
          // ACTION_REQUEST stays on DaemonActionBridge; never feed into AgentHost.
          this.logger.warn('[DaemonAgentHost] unexpected actionRequest on AgentHost path');
        },
      },
    });
    // agent-host-full-migration: compose the three deep modules as the query
    // engine (reusing the single runtime factory + owner teardown). Query flows
    // through submitHostQuery, not conversation.execute.
    this.installComposedQueryEngine();
    setHumanInteractionHooks({
      requestPlatformApproval: (context, request) =>
        this.sharedHost?.requestPlatformApproval(context, request)
        ?? Promise.resolve({ approved: false }),
    });
  }

  /**
   * Owner adapter for {@link AgentHost.disposeExecutionOwner}. Daemon
   * `resetAccountSync` (invoked from `tabtin-daemon init --force` / logout
   * flows) delegates the standard quiesce → interrupt → wait → teardown →
   * dispose sequence to `ExecutionOwnerLifecycle`; the daemon-specific
   * work lives here (mirrors Electron):
   *
   * - `interruptSession`: abort + cancel delivery.
   * - `teardownSession`: dispose subagent manager, plan tracker, session
   *   storage, backend session, per-session skill credential handle,
   *   approval memo registration, and per-file rewind cache.
   * - `disposeOwnerResources`: dispose relay outbox for the owner and
   *   clear the owner's on-disk sync directory; `clearedFiles` is stashed
   *   so `resetAccountSync` can surface it to the caller.
   */
  private buildOwnerAdapter(): AgentOwnerAdapter<DaemonHostState> {
    return {
      sessions: this.requireSharedHost().sessions,
      runtimeBarrier: {
        quiesceScope: (scopeId) => this.runtimeAssembly.getRuntimeFactory().quiesceScope(scopeId),
        restoreScope: (scopeId) => this.runtimeAssembly.getRuntimeFactory().restoreScope(scopeId),
        waitForScopeIdle: (scopeId) => this.runtimeAssembly.getRuntimeFactory().waitForScopeIdle(scopeId),
      },
      getOwner: (session) => session.owner,
      getConversationIdentity: (sessionId, session) => ({
        conversationId: session.businessThreadId || sessionId,
        sessionId,
      }),
      interruptSession: async (sessionId, session) => {
        try { session.abortController.abort(); } catch (err) {
          this.warnResetStep('session.abort', sessionId, session.owner, err);
        }
        try {
          await this.requireSharedHost().cancelSessionDelivery(sessionId);
        } catch (err) {
          this.warnResetStep('delivery.cancel', sessionId, session.owner, err);
        }
      },
      teardownSession: async (sessionId, session) => {
        try { session.abortController.abort(); } catch (err) {
          this.warnResetStep('session.abort', sessionId, session.owner, err);
        }
        try {
          await this.requireSharedHost().cancelSessionDelivery(sessionId);
        } catch (err) {
          this.warnResetStep('delivery.cancel', sessionId, session.owner, err);
        }
        try { session.subagentManager.dispose(); } catch (err) {
          this.warnResetStep('subagentManager.dispose', sessionId, session.owner, err);
        }
        try {
          clearAllActivePlansForSession(sessionId);
        } catch (err) {
          this.warnResetStep('clearActivePlans', sessionId, session.owner, err);
        }
        try { await session.sessionStorage.dispose(); } catch (err) {
          this.warnResetStep('sessionStorage.dispose', sessionId, session.owner, err);
        }
        try { await session.backendBootstrap?.session.shutdown(); } catch (err) {
          this.warnResetStep('backendSession.shutdown', sessionId, session.owner, err);
        }
        // Wave 2a P0-2 / W2-轮 2：账号切换时旧 owner 的 session-level skill
        // credential handle + approval memo 都跟 owner 一起走；EOL 已在
        // 上层把 sessions map 从 core 里删掉，这里只清 daemon 侧派生登记表。
        this.sessionState.deleteSession(sessionId);
        this.sharedHost?.unregisterApprovalMemo(sessionId);
        // 阶段 4 · 删影子忙闲：EOL 已经通过 supervisor.quiesce +
        // runtimeBarrier.quiesceScope + waitForScopeIdle 停掉执行；无需再抹一份
        // 影子 Set（忙闲权威源统一到 sharedHost.isBusy / coordinator）。
        const fileHistoryKey = session.businessThreadId ?? sessionId;
        try {
          await removeFileHistory(fileHistoryKey);
        } catch (err) {
          this.warnResetStep('fileHistory.remove', fileHistoryKey, session.owner, err);
        }
      },
      disposeOwnerResources: async (owner) => {
        try {
          await this.relayPersistence.disposeOwner(owner);
        } catch (err) {
          this.warnResetStep('relayPersistence.disposeOwner', undefined, owner, err);
        }
        if (this.syncPersistenceEnabled && this.syncRoot) {
          const cleared = await clearSyncAccountDir(this.syncRoot, owner);
          this.persistenceSupervisor.recordClearedFiles(owner, cleared);
        }
      },
    };
  }

  private hostTrackerAuth(): HostTrackerAuth | null {
    const token = this.getAccessToken();
    if (!token) return null;
    return {
      token,
      apiBaseUrl: deriveApiBaseUrl(this.config.server_url),
      fingerprint: this.config.fingerprint,
    };
  }

  private async fetchHostTrackerSchedule(): Promise<Array<{
    trackerId: string
    triggerType: string
    triggerConfig: Record<string, unknown>
    lastRunAt?: string | null
    createdAt?: string | null
  }>> {
    const auth = this.hostTrackerAuth();
    if (!auth) {
      this.hostTrackerWork = [];
      return [];
    }
    const snapshot = await fetchHostTrackerSnapshot(auth);
    this.hostTrackerWork = snapshot.work;
    return snapshot.items;
  }

  private async fetchHostTrackerWork(): Promise<Array<{ runId: string }>> {
    const auth = this.hostTrackerAuth();
    if (!auth) {
      this.hostTrackerWork = [];
      return [];
    }
    const snapshot = await fetchHostTrackerSnapshot(auth);
    this.hostTrackerWork = snapshot.work;
    return snapshot.work;
  }

  private async fireHostTracker(trackerId: string): Promise<void> {
    const auth = this.hostTrackerAuth();
    if (!auth) {
      throw new Error('Host tracker fire skipped: missing access token');
    }
    await fireHostTracker(auth, trackerId);
  }

  private async reconcileHostTrackerLifecycle(): Promise<void> {
    const auth = this.hostTrackerAuth();
    if (!auth) return;
    await reconcileHostTrackerLifecycle(auth);
  }

  private async executeHostTrackerRun(runId: string): Promise<void> {
    const auth = this.hostTrackerAuth();
    if (!auth) {
      throw new Error('Host tracker execute skipped: missing access token');
    }
    const prepared = await prepareHostTrackerRun(auth, runId);
    this.hostTrackerRunBySession.set(prepared.sessionId, runId);
    const result = await this.handleQuery({
      prompt: prepared.prompt,
      sessionId: prepared.sessionId,
      threadId: prepared.sessionId,
      relaySessionId: prepared.sessionId,
      taskId: prepared.taskId,
      agentId: prepared.agentId,
      workspaceId: prepared.workspaceId,
      modelId: prepared.modelId,
      appContext: prepared.appContext as DaemonQueryRequest['appContext'],
      interactionMode: 'scheduled',
      agentMode: 'yolo',
    });
    if (!result.success) {
      this.hostTrackerRunBySession.delete(prepared.sessionId);
      await finalizeHostTrackerRun(auth, runId, result.error || 'Host tracker query failed to start');
      throw new Error(result.error || 'Host tracker query failed to start');
    }
  }

  private settleHostTrackerSession(sessionId: string | undefined, error = ''): void {
    if (!sessionId) return;
    const runId = this.hostTrackerRunBySession.get(sessionId);
    if (!runId) return;
    this.hostTrackerRunBySession.delete(sessionId);
    const auth = this.hostTrackerAuth();
    if (!auth) return;
    void finalizeHostTrackerRun(auth, runId, error).catch((finalizeError) => {
      this.logger.warn('[HostTrackerScheduler] finalize failed', finalizeError);
    });
  }

  async start(): Promise<void> {
    // H1-E：安装 telemetry sink（幂等）。container.ts 已在更早阶段安装了一次，
    // 这里再调用一次确保 Host 独立启动场景（单元测试 / 嵌入式 fixture）也能落地埋点。
    installDaemonTelemetrySink(this.logger);
    await this.startSharedHost();
    this.hostTrackerScheduler.start();
    if (!this.hostTrackerReconnectRegistered) {
      this.hostTrackerReconnectRegistered = true;
      this.gateway.onReconnect(() => {
        void this.hostTrackerScheduler.sync().catch((error) => {
          this.logger.warn('[HostTrackerScheduler] reconnect sync failed', error);
        });
      });
    }

    // archive 三件套（messages/snapshots/events.jsonl）按 per-Organization/per-Space
    // conversations 树落盘 ({conversations}/{organizationId}/{spaceId}/sessions/...);
    // createRuntimeForSession 内部按 spaceId 解析后 storage 写入时 mkdir -p。
    // host 启动期不再预创建。

    // FR-14 / LH2-D1：sync 根目录在 `~/.tabtin-daemon/agent-sync/`，按 owner
    // 分桶到 `<root>/<userId>/<organizationId>/`。host 启动期不预创建任何子目录——
    // 第一次 createRuntimeForSession 看到具体 owner 时再懒加载。
    this.syncPersistenceEnabled = resolveSyncPersistence(process.env, this.logger);
    this.syncRoot = getDaemonHomePath('agent-sync');
    if (this.syncPersistenceEnabled) {
      // 终端假运行根治 Layer 1（治 F2/F3/F16/F20）：启动对账 relay-pending +
      // WS 重连时再 recover（断网期间落盘的后台命令终态在网络恢复后补发）。
      // Stage 3：recover + backfill 编排下沉到 RelaySessionOrchestrator。
      void this.relayOrchestrator.kickRecoverAndBackfill({ activateOwner: true });
      if (!this.relayReconnectRegistered) {
        this.relayReconnectRegistered = true;
        this.gateway.onReconnect(() => {
          void this.relayOrchestrator.kickRecoverAndBackfill({ activateOwner: false });
        });
      }

      // 终端假运行根治 Layer 2（治 F9 / 崩溃兜底）：注入 ManagedTaskStore 落盘端口
      // （此后 spawn 即写 running record 到盘）+ 启动对账（恢复上次 daemon 崩溃 /
      // kill -9 / 异常重启残留的 running record 终态——探活 + 读 sidecar 退出码 →
      // 走 Wave 1 outbox 回写）。守 AGENTS.md "Daemon 必须可用"：headless 用户重开不转圈。
      this.setupLayer2ManagedTaskReconcile();
    }

    // 初始化本地 Skill 模块（ 硬切：扫 `{dataRoot}/users/{userId}/…`
    // 新布局；不再回落 legacy platform-data 扫描根）。预装源在 init 时收集，
    // 实际预装在 ensureUserSkills / ensureOrganizationSkills 时按需触发。
    try {
      const _platformDataRoot = resolvePlatformDataRoot();
      const _dataRoot = resolveDataRoot();
      const _appsRoot = resolveAppsRoot();
      const _bundledRoot = resolveBundledRoot();
      const _packageSkillsRoot = resolvePackageSkillsRoot();
      const { collectPlatformSources, collectAppSources, collectPackageSkillSources } = await import('@tabtin/agent-host/skills');
      const preinstallSources = [
        ...(_bundledRoot ? await collectPlatformSources(_bundledRoot) : []),
        ...(_appsRoot ? await collectAppSources(_appsRoot) : []),
        ...(_packageSkillsRoot ? await collectPackageSkillSources(_packageSkillsRoot) : []),
      ];
      this.logger.info(`[Skills] collected ${preinstallSources.length} preinstall sources`);

      const interopRoots = resolveDefaultInteropRoots({
        workspaceRoots: this.workspaceRoot ? [this.workspaceRoot] : [],
      });
      this.logger.info(`[Skills] interopRoots=${JSON.stringify(interopRoots)}`);

      // 内置 skill 去重复用：单份共享store。（硬切）：挂在 dataRoot
      // 下（与 `users/` 同级），不再借道即将废弃的 platformDataRoot 拼路径。
      const _sharedSkillsDir = join(_dataRoot, '_shared-skills');
      this.logger.info(`[Skills] sharedSkillsDir=${_sharedSkillsDir}`);

      // ：硬切新布局——kickoff 先拿到 userId（缺失直接抛错，不再
      // 回落 platformDataRoot 扫描根）。抛错被下方 `.then(_, err => ...)` 捕获，
      // 走既有"skills 功能降级"路径，不阻断 Agent 主链路。
      this.skillsReady = (async () => {
        const userId = this.config.user_id;
        if (!userId) {
          throw new Error(
            'Cannot resolve userId: DaemonConfig.user_id is missing — please rerun ' +
              '`tabtin-daemon init --token <token> --force` with a token containing user_id (LH2-D3)',
          );
        }

        // 一次性迁移：旧 `platform-data/organizations/{org}/spaces/{sp}/skills/`
        // → 新 `{dataRoot}/users/{userId}/[organizations/{org}/]skills/`。
        // 幂等（源目录迁完打 `.migrated` 标记），失败不阻断 init。
        try {
          const report = await migrateLegacyPlatformDataToDataRoot({
            dataRoot: _dataRoot,
            legacyPlatformDataRoot: _platformDataRoot,
            userId,
            logger: {
              info: (m) => this.logger.info(m),
              warn: (m) => this.logger.warn(m),
              error: (m) => this.logger.error(m),
            },
          });
          this.logger.info(`[Skills] storage migration: movedSkills=${report.movedSkills} skipped=${report.skippedSkills} errors=${report.errors.length}`);
        } catch (err) {
          this.logger.warn(`[Skills] storage migration failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }

        const handle = await initSkillsModule({
          dataRoot: _dataRoot,
          userId,
          preinstallSources,
          interopRoots,
          sharedSkillsDir: _sharedSkillsDir,
          // ：CLI enable 后物化 marketplace app skill 需要解析 bundled 源。
          appsRoot: _appsRoot,
          packageSkillsRoot: _packageSkillsRoot,
          logger: {
            warn: (msg: string) => this.logger.warn(`[Skills] ${msg}`),
            info: (msg: string) => this.logger.info(`[Skills] ${msg}`),
          },
          //  /  Stage 6c：宿主注入 RecallIndex（含语义 scorer），
          // runtime 经 SkillRecallPort 消费，不再直接依赖 @tabtin/search。
          // 与 Electron 共享 ~/.tabtin/ 下同一份模型与向量缓存。
          skillRecall: new RecallIndex({
            scorer: getDaemonSemanticScorer((msg) => this.logger.info(msg)),
          }),
          // ：临时隐藏 skill 名单（tabvideo）由宿主注入，core 默认不隐藏。
          hiddenSkills: TEMPORARILY_HIDDEN_SKILLS,
        });
        this.skillsModule = handle;
        this.logger.info(
          `[Skills] initSkillsModule ready (${handle.registry.listAll().length} skills indexed)`,
        );
        await handle.ensureUserSkills(userId);
      })().then(
        () => {},
        (err) => {
          this.logger.warn(
            `[Skills] initSkillsModule failed, skills degraded: ${err instanceof Error ? err.message : String(err)}`,
          );
          this.skillsModule = null;
          this.skillsReady = null;
        },
      );
      this.logger.info('[Skills] initSkillsModule kickoff (ready pending)');
    } catch (err) {
      this.logger.warn(
        `[Skills] initSkillsModule threw sync error (swallowed): ${err instanceof Error ? err.message : String(err)}`,
      );
      this.skillsModule = null;
      this.skillsReady = null;
    }

    this.cleanupToolLogsOnStartup().catch(() => undefined);

    // Wave 1.5 PROD-3：Daemon 启动期 JWT 自检。
    //
    // 三视角 Review 修复（用户 1）：无 JWT 的影响远大于"Skill 不能用"——
    // `createRuntimeForSession` 看到 token 空会直接抛 `Not authenticated`，
    // **Agent 一条 query 都发不出去**。WARN 文案把主次列清楚，避免新手
    // 误以为只是 skill 受影响而绕去查 Skill 文档。`--force` 是覆盖旧
    // token 用的，首次安装不应建议用。
    //
    // 同时打一条 info 提示 resolver 的 5min TTL 兜底机制（用户 5）：
    // 运维在 Daemon 日志里就能看到"改完密钥后等 ≤5min 或重启 Daemon"的
    // 缓存行为，不必翻 PRD。
    //
    // 注意：pre-flight 只打一次。运行期 token 失效（JWT 过期 + gateway
    // 刷新失败）不会再次触发本路径；run_terminal_command 工具那侧会通过 SYSTEM_NOTICE
    // 让 LLM / 用户可观察——两条路径互补。
    try {
      const probeToken = this.getAccessToken();
      if (!probeToken) {
        this.logger.warn(
          '[DaemonAgentHost] no access token available at startup. '
            + '• agent queries will fail with "Not authenticated — cannot create agent runtime"; '
            + '• Skill credential injection is disabled. '
            + 'Fix: run `tabtin-daemon init --token <token>` '
            + '(add --force only if re-binding an existing install).',
        );
      } else {
        this.logger.info(
          '[DaemonAgentHost] [SkillCredential] runtime ready; '
            + 'resolver cache TTL = 5min. '
            + 'After updating a credential in the web/desktop UI, run `tabtin-daemon restart` '
            + 'to flush immediately, otherwise changes take effect within 5 minutes.',
        );
      }
    } catch (err) {
      this.logger.warn(
        `[DaemonAgentHost] [SkillCredential] startup probe failed (ignored): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // W1b：首次拉取模型 catalog（不阻塞 start，失败静默）+ 定时刷新。
    this.refreshModelCatalog().catch(() => undefined);
    this.catalogRefreshTimer = setInterval(
      () => this.refreshModelCatalog().catch(() => undefined),
      CATALOG_REFRESH_INTERVAL_MS,
    );

    this.logger.info('[DaemonAgentHost] Started');
  }

  /**
   * W1b：从 Django /services/llm/catalog 拉取模型列表并更新缓存。
   * 失败时保留旧缓存不清空，仅打 warn 日志。
   */
  private async refreshModelCatalog(): Promise<void> {
    const token = this.getAccessToken();
    if (!token) {
      this.logger.warn('[DaemonAgentHost] [Catalog] skip refresh: no access token');
      return;
    }
    const apiBase = deriveApiBaseUrl(this.config.server_url);
    const url = joinApiPath(apiBase, '/services/llm/catalog?use_case=chat');
    if (this.config.organization_id) {
      // organization_id 让 catalog 返回该租户可见的模型（含 BYOK）
    }
    const fullUrl = this.config.organization_id
      ? `${url}&organization_id=${encodeURIComponent(this.config.organization_id)}`
      : url;
    try {
      const resp = await fetch(fullUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        this.logger.warn(`[DaemonAgentHost] [Catalog] HTTP ${resp.status} from ${fullUrl}`);
        return;
      }
      // 修：`/catalog` 走老 helper envelope `{success, code, message, data:{models}}`，
      // models 在 `data.data.models`。旧 W1b 代码读顶层 `data.models`（恒 undefined）
      // → 缓存一直为空 → 所有模型回落 FALLBACK 窗口（静默隐患）。这里改成优先读
      // 嵌套、兼容 flat。Phase 3 子 Agent 能力解析依赖此缓存真正生效。
      const json = (await resp.json()) as {
        models?: CatalogModelRaw[];
        data?: { models?: CatalogModelRaw[] };
      };
      const models = json.data?.models ?? json.models;
      if (!Array.isArray(models)) return;
      const newCache = this.buildCatalogCache(models);
      this.modelCatalogCache = newCache;
      // ：catalog 刷新成功，清空 miss 去重集合，让"刷新后重新 miss"能再告警。
      this.catalogFallbackWarned.clear();
      this.logger.info(`[DaemonAgentHost] [Catalog] refreshed: ${newCache.size} model(s)`);
    } catch (err) {
      this.logger.warn(
        `[DaemonAgentHost] [Catalog] refresh failed (keeping stale cache): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private buildCatalogCache(models: CatalogModelRaw[]): Map<string, CatalogEntry> {
    const cache = new Map<string, CatalogEntry>();
    for (const model of models) {
      const name = model.name ?? model.model_name;
      if (!name) continue;
      cache.set(name, this.buildCatalogEntry(model, name));
    }
    return cache;
  }

  private buildCatalogEntry(model: CatalogModelRaw, name: string): CatalogEntry {
    const refId = isValidModelRef(model.id) ? model.id! : name;
    const aliases = [name, model.model_name].filter(
      (alias): alias is string => typeof alias === 'string' && alias.trim().length > 0 && alias !== refId,
    );
    if (!(model.context_window_tokens && model.context_window_tokens > 0)) {
      this.logger.warn(
        `[DaemonAgentHost] [Catalog] model "${name}" (id=${refId}) missing context_window_tokens in catalog — ` +
        `falling back to ${FALLBACK_MODEL_CAPABILITIES.contextWindowTokens}. pressure/blocking will be computed ` +
        `against this fallback; if the real model has a larger window, expect premature compaction / blocking .`,
      );
    }
    return {
      contextWindowTokens: model.context_window_tokens && model.context_window_tokens > 0 ? model.context_window_tokens : FALLBACK_MODEL_CAPABILITIES.contextWindowTokens,
      maxOutputTokens: model.max_output_tokens && model.max_output_tokens > 0 ? model.max_output_tokens : FALLBACK_MODEL_CAPABILITIES.maxOutputTokens,
      supportsVision: model.resolved_capabilities?.supports_vision === true,
      supportsFunctionCalling: model.resolved_capabilities?.supports_function_calling !== false,
      supportsPromptCaching: model.capabilities_config?.supports_prompt_caching === true,
      cacheType: deriveCacheType(model.provider, model.capabilities_config),
      reasoningHistoryPolicy: deriveReasoningHistoryPolicy(model.provider, model.capabilities_config),
      id: refId,
      aliases: aliases.length > 0 ? Array.from(new Set(aliases)) : undefined,
      displayName: typeof model.display_name === 'string' ? model.display_name : undefined,
      usageHint: typeof model.usage_hint === 'string' ? model.usage_hint : undefined,
      providerScope: typeof model.provider_scope === 'string' ? model.provider_scope : undefined,
    };
  }

  /**
   * W1b：从 catalog 缓存查询模型能力。支持 exact match + prefix fallback。
   * 未命中返回 FALLBACK_MODEL_CAPABILITIES 的对应字段。
   */
  private resolveModelFromCatalog(modelId: string): CatalogEntry {
    const exact = this.modelCatalogCache.get(modelId);
    if (exact) return exact;
    // /#503：选中模型常是 DB UUID（cache 按 name 索引），先按 entry.id（UUID）
    // 与 alias 精确匹配，命中才用真实能力，避免回落 FALLBACK（contextWindow 误判）。
    for (const value of this.modelCatalogCache.values()) {
      if (value.id === modelId || value.aliases?.includes(modelId)) return value;
    }
    for (const [key, value] of this.modelCatalogCache) {
      if (modelId.startsWith(key) || key.startsWith(modelId)) return value;
    }
    // ：catalog miss（exact / id / alias / prefix 全不中）→ 回落 32k。此处是
    // "按 32k 算 pressure / blockingLimit"的真根因——大窗口模型（128k/256k）会因此
    // 过早 warning / emergency_blocking / CONTEXT_OVERFLOW。去重 warn（每 modelId
    // 一次，catalog 刷新时清空）让回落可观测可诊断，而非静默误触发 blocking。
    if (!this.catalogFallbackWarned.has(modelId)) {
      this.catalogFallbackWarned.add(modelId);
      this.logger.warn(
        `[DaemonAgentHost] [Catalog] model "${modelId}" not found in catalog cache ` +
        `(size=${this.modelCatalogCache.size}) — falling back to contextWindowTokens=` +
        `${FALLBACK_MODEL_CAPABILITIES.contextWindowTokens}. pressure/blocking will be ` +
        `computed against this fallback; if the real model has a larger window, expect ` +
        `premature compaction / blocking .`,
      );
    }
    return {
      id: modelId,
      contextWindowTokens: FALLBACK_MODEL_CAPABILITIES.contextWindowTokens,
      maxOutputTokens: FALLBACK_MODEL_CAPABILITIES.maxOutputTokens,
      supportsVision: FALLBACK_MODEL_CAPABILITIES.supportsVision,
      supportsFunctionCalling: FALLBACK_MODEL_CAPABILITIES.supportsFunctionCalling,
      supportsPromptCaching: FALLBACK_MODEL_CAPABILITIES.supportsPromptCaching,
      cacheType: FALLBACK_MODEL_CAPABILITIES.cacheType,
    };
  }

  /**
   * 子 Agent 模型自由度（Phase 3/4）：把 W1b catalog 缓存映射成 runtime 注入用的
   * `ModelCatalogEntry[]` 快照。复用既有缓存（拉 `/catalog?use_case=chat`、5min
   * 刷、stale-while-revalidate）——目录已按派单成员 tier 过滤（Django 端 JWT 解析
   * user_id → `_filter_models_by_member_policy`），故子 Agent 自选天然不绕过
   * max_model_tier（PRD §4.5.4）。缓存为空（冷启动 / 离线无缓存）时返回 []，
   * agent 工具回落「不校验、缺省跟父」兼容行为。
   */
  private buildModelCatalogSnapshot(): ModelCatalogEntry[] {
    const out: ModelCatalogEntry[] = [];
    for (const [name, entry] of this.modelCatalogCache) {
      out.push({
        id: entry.id || name,
        aliases: entry.aliases,
        displayName: entry.displayName,
        usageHint: entry.usageHint,
        providerScope: entry.providerScope,
        capabilities: {
          contextWindowTokens: entry.contextWindowTokens,
          maxOutputTokens: entry.maxOutputTokens,
          maxInputTokens: entry.contextWindowTokens,
          supportsVision: entry.supportsVision,
          supportsFunctionCalling: entry.supportsFunctionCalling,
          supportsPromptCaching: entry.supportsPromptCaching,
          cacheType: entry.cacheType,
          reasoningHistoryPolicy: entry.reasoningHistoryPolicy,
        },
      });
    }
    return out;
  }

  private async cleanupToolLogsOnStartup(): Promise<void> {
    try {
      // ：只扫新树
      //   {dataRoot}/users/{userId}/organizations/{org}/workspaces/{ws}/conversations/tool-logs/
      // legacy 残留由一次性 migration 搬迁，runtime cleanup 不再双扫。
      const { existsSync } = await import('node:fs');
      const { readdir } = await import('node:fs/promises');
      let totalRemoved = 0;

      const dataRoot = resolveDataRoot();
      const usersRoot = join(dataRoot, 'users');
      if (!existsSync(usersRoot)) return;
      const userEntries = await readdir(usersRoot, { withFileTypes: true });
      for (const user of userEntries) {
        if (!user.isDirectory()) continue;
        totalRemoved += await this.cleanupUserToolLogs(join(usersRoot, user.name, 'organizations'));
      }
      if (totalRemoved > 0) {
        this.logger.info(`[DaemonAgentHost] [ToolLogs] startup cleanup: removed ${totalRemoved} old session dir(s)`);
      }
    } catch (err) {
      this.logger.warn(`[DaemonAgentHost] [ToolLogs] startup cleanup failed (non-blocking): ${err}`);
    }

    // 2026-05-23 push 通知重构 commit 3：subscribe NotificationQueue。
    // 与 ElectronAgentHost.start() 同款；bridge 已通过 setPtyManagerBridge
    // 在 daemon.ts:179 处注入，本 start() 时序上 bridge 总是先 ready。
    // 详见 PRD §6.3 + §6.7。
    if (!this.notificationQueueUnsubscribe) {
      try {
        const queue = this.resolveNotificationQueue();
        if (queue) {
          this.notificationQueueUnsubscribe = queue.subscribe((env) => {
            // §17.6 D4.a：target.sessionId → target.threadId（业务对话 thread）
            this.notificationDrain.schedule(env.target.threadId);
            // t1（终端"假运行"根治）：后台命令终结 → emit 终态 tool_result 覆盖
            // running 快照，重载时终端卡片显示真实终态。与 Electron host 对称、前端零改。
            this.relayBackgroundTaskTerminalResult(env);
          });
        } else {
          this.logger.warn(
            `[DaemonAgentHost] [NotificationQueue] subscribe skipped at start(): bridge/queue unavailable`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `[DaemonAgentHost] [NotificationQueue] subscribe failed at start(): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async cleanupUserToolLogs(orgsRoot: string): Promise<number> {
    const { readdir } = await import('node:fs/promises');
    let orgEntries;
    try { orgEntries = await readdir(orgsRoot, { withFileTypes: true }); } catch { return 0; }
    let removed = 0;
    for (const org of orgEntries) {
      if (org.isDirectory()) removed += await this.cleanupOrganizationToolLogs(join(orgsRoot, org.name, 'workspaces'));
    }
    return removed;
  }

  private async cleanupOrganizationToolLogs(workspacesParent: string): Promise<number> {
    const { existsSync } = await import('node:fs');
    const { readdir } = await import('node:fs/promises');
    let workspaceEntries;
    try { workspaceEntries = await readdir(workspacesParent, { withFileTypes: true }); } catch { return 0; }
    let removed = 0;
    for (const workspace of workspaceEntries) {
      if (!workspace.isDirectory()) continue;
      const toolLogsDir = join(workspacesParent, workspace.name, 'conversations', 'tool-logs');
      if (!existsSync(toolLogsDir)) continue;
      removed += (await cleanupOldToolLogs(toolLogsDir)).removed;
    }
    return removed;
  }

  async stop(): Promise<void> {
    this.hostTrackerScheduler.stop();
    setHumanInteractionHooks(undefined);
    const sharedHost = this.sharedHost;

    // 2026-05-23 push 通知重构 commit 3：摘 NotificationQueue subscribe。
    // 与 ElectronAgentHost.stop() 同款。
    this.stopSubscriptionsAndTimers();

    const sessionIds = [...this.sessions.keys()];
    for (const sid of sessionIds) {
      this.handleAbort(sid);
      await sharedHost?.cancelSessionDelivery(sid);
    }

    await this.disposeSessions([...this.sessions.values()]);

    // ：清本机 waiter 前先取消服务端 pending，避免重启后幽灵审批卡。
    await this.cancelHeldPendingInteractionsForRuntimeGone();

    this.sharedHost = null;
    this.agentTransport = null;
    await sharedHost?.stop();

    // W1.2：dispose 共享 ExecutionBackendRegistry（与 Electron 对称）——
    // registry 生命周期已随装配迁入 DaemonRuntimeAssembly。
    await this.runtimeAssembly.disposeBackendRegistry();

    // 终端假运行根治 Layer 1：dispose 共享 relay outbox。
    await this.relayPersistence.dispose();

    // 终端假运行根治 Layer 2：dispose 所有 owner 桶的 ManagedTask 落盘队列（与上面两套
    // 对称）。dispose await 在飞的写（含退出 flush 的 fire-and-forget remove），保证退出前
    // tombstone 落盘，避免下次启动重复对账。退出 flush 已在 stop() 之前由 daemon.ts 调用。
    await this.persistenceSupervisor.dispose();

    // FR-18 Phase 2 (H2-E)：进程退出前清理 doc-parser worker pool。
    // 与 Electron `before-quit` 同构 —— Electron 在 `doc-parser-runner.ts` 内部
    // 注册过 `app.once('before-quit', ...)` 钩子；Daemon 是长进程，没有 Electron
    // app 概念，必须由 host 在 stop() 显式 dispose，否则关停期 worker 仍占内存
    // ~30MB（pdfjs/mammoth/xlsx 全 loaded）+ 阻塞 systemd shutdown。
    await this.docParser.dispose().catch((err) => {
      this.logger.warn(
        `[DaemonAgentHost] doc parser dispose failed (non-critical): ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    // Wave 3a N1/N2：释放 skill 模块（watcher close + disposable 清理）。
    try {
      await disposeSkillsModule();
    } catch (err) {
      this.logger.warn(
        `[DaemonAgentHost] disposeSkillsModule failed (non-critical): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.skillsModule = null;
    this.skillsReady = null;

    // W7a：与 Electron `host.stop()` 同构 —— 直接 clear()，不 resolve。
    //
    // 历史背景：旧 Daemon 对每个 pending 调 `resolver({cancelled: true})` 让
    // awaiter 立刻返回；Electron 是直接 clear()（让 Promise 永挂直到进程消亡）。
    //
    // 选 Electron 行为的理由（与 waitForUserInput 超时语义统一）：
    //   - cancelled 信号专属"用户主动取消 / abort"，stop 是宿主关停事件，
    //     语义不同；让 awaiter 收 cancelled 容易让 tool 误以为是用户操作；
    //   - Daemon 是 systemd long-running service，进程退出时整个 V8 消亡，
    //     awaiter 永挂等于自动消亡，不会持有任何句柄；
    //   - 行为对齐 Electron，避免 host 之间出现"stop 后行为不同"的隐式漂移。
    // Wave 2a 补丁 P0-2：Daemon 关停时一并清空 per-session resolver handle Map，
    // 避免"Daemon 已 stop 但 Map 里还挂着闭包引用"导致 V8 多回收一轮。
    // handle 内部的 cache 是进程级 Map，V8 GC 即可回收，不需显式释放。
    this.sessionState.clear();

    // per-file 回退引擎：stop 时 flush 各 thread manifest 后清空缓存（保留磁盘备份）。
    await clearAllFileHistory().catch(() => {});
    // M1.4 / v0.2 per-Organization · Wave 2：清空 USER 画像缓存。
    // Daemon stop() 通常意味着进程即将退出（systemd shutdown / init --force 换 owner），
    // 缓存里的画像数据按 owner 维度敏感，必须主动清——避免极端"同进程内 stop+start
    // 复用同一 host 实例 + 换 owner"的路径下旧 owner 画像被新 owner 命中。
    this.runtimeAssembly.invalidateUserPortraitCache();
    this.logger.info('[DaemonAgentHost] Stopped');
  }

  private stopSubscriptionsAndTimers(): void {
    if (this.notificationQueueUnsubscribe) {
      try { this.notificationQueueUnsubscribe(); } catch { /* best effort */ }
      this.notificationQueueUnsubscribe = null;
    }
    if (this.catalogRefreshTimer) {
      clearInterval(this.catalogRefreshTimer);
      this.catalogRefreshTimer = null;
    }
  }

  private async disposeSessions(sessions: DaemonHostState[]): Promise<void> {
    for (const session of sessions) {
      try { clearAllActivePlansForSession(session.sessionId); } catch { /* best effort */ }
      try { session.subagentManager.dispose(); } catch { /* best effort */ }
      await session.sessionStorage.dispose();
      try { await session.backendBootstrap?.session.shutdown(); } catch { /* best effort */ }
    }
  }

  /**
   * ：host stop 时取消本机仍持有 waiter 的会话上的 PendingInteraction。
   *
   * REST path 只认 ChatSession raw UUID；`businessThreadId` 多为
   * `chat-session-<uuid>`，必须经 resolveRelaySessionIdForReconcile 剥前缀。
   */
  private async cancelHeldPendingInteractionsForRuntimeGone(): Promise<void> {
    if (this.interactionRegistry.size === 0) return;

    const apiSessionById = new Map<string, { organizationId?: string }>();
    for (const entry of this.interactionRegistry.values()) {
      const session = this.sessions.get(entry.sessionId);
      const apiSessionId = resolveRelaySessionIdForReconcile({
        mapKey: entry.sessionId,
        businessThreadId: session?.businessThreadId,
      });
      if (!apiSessionId) continue;
      if (apiSessionById.has(apiSessionId)) continue;
      apiSessionById.set(apiSessionId, {
        organizationId: session?.owner?.organizationId ?? this.config.organization_id,
      });
    }
    if (apiSessionById.size === 0) return;

    const token = this.getAccessToken();
    if (!token) {
      this.logger.warn('[HITL] skip cancel-runtime on stop: not authenticated');
      return;
    }

    const apiBase = deriveApiBaseUrl(this.config.server_url);
    await Promise.all(
      [...apiSessionById.entries()].map(async ([apiSessionId, meta]) => {
        try {
          const response = await fetch(
            joinApiPath(
              apiBase,
              `/chat/sessions/${encodeURIComponent(apiSessionId)}/pending-interactions/cancel-runtime`,
            ),
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                ...(meta.organizationId ? { 'X-Organization-Id': meta.organizationId } : {}),
              },
              body: '{}',
              signal: AbortSignal.timeout(5_000),
            },
          );
          if (!response.ok) {
            this.logger.warn(
              `[HITL] cancel-runtime failed: session=${apiSessionId.slice(0, 8)}… status=${response.status}`,
            );
            return;
          }
          this.logger.info(`[HITL] cancel-runtime ok: session=${apiSessionId.slice(0, 8)}…`);
        } catch (err) {
          this.logger.warn(
            `[HITL] cancel-runtime threw: session=${apiSessionId.slice(0, 8)}… error=${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );
  }

  // ─── Wave 2a 补丁 P0-2：Skill 凭据 cache 多 session 统一失效入口 ──────
  //
  // Wave 5 UI "改完密钥刷新缓存" 的 IPC handler 不必再遍历 session 自己构造
  // 循环——直接调本方法即可一次性清完所有活跃 session 的 resolver cache。
  //
  // 与 createSkillCredentialResolver 返回 handle 的 ``invalidate`` 语义相同：
  //   - 不传 filter 或 filter 两字段都空 → 每个 handle 清空全部 entry；
  //   - 带 spaceId / skillKey → 按 filter 精准清。
  //
  // 与单 handle invalidate 的唯一差异：本方法**自动广播**到所有活跃 session。

  invalidateSkillCredentialCaches(
    filter?: { spaceId?: string; skillKey?: string },
  ): void {
    this.sessionState.forEachCredentialResolver((handle) => {
      try {
        handle.invalidate(filter);
      } catch (err) {
        this.logger.warn(
          `[DaemonAgentHost] [SkillCredential] invalidate failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  // ─── push 通知 idle drain（commit 3 / Stage 3 下沉）─────────────────
  //
  // 与 ElectronAgentHost 同款契约。三道 race 防御与「session missing → 丢消息 /
  // 瞬态 busy → 退回」两类不同规则由 `NotificationIdleDrain` 保证；平台差异只在
  // runTurn：Daemon 直接 handleQuery（无 sender 概念）、Electron 走 submitQuery
  // + NOOP sink。

  /** 定位 push notification queue；bridge 未就绪 / 未注入 → undefined，helper 打日志短路。 */
  private resolveNotificationQueue():
    | import('@tabtin/terminal-core').NotificationQueue
    | undefined {
    return this.getPtyManagerBridge()?.getNotificationQueue();
  }

  /**
   * push-drain 起新一轮 turn 的平台实现（Stage 3：NotificationIdleDrain 回调）。
   * 从 session 回填 `bakedFieldsMatch` 缓存键字段，让 RuntimeSessionFactory.resolve
   * cache hit、零开销复用上轮 runtime（与 Electron 同源同期修复）。
   */
  private async runNotificationDrainTurn(
    context: NotificationDrainContext,
  ): Promise<{ success: boolean; error?: string }> {
    const session = this.sessions.get(context.threadId);
    if (!session) {
      return { success: false, error: 'session missing after drain' };
    }
    const firstTarget = context.items[0].target;
    const request: DaemonQueryRequest = {
      prompt: context.promptText,
      sessionId: context.threadId,
      spaceId: firstTarget.spaceId,
      threadId: firstTarget.threadId,
      modelId: session.modelId,
      agentId: session.owner.agentId ?? undefined,
      workspaceId: session.workspaceId,
      customRules: session.customRules,
      personalRules: session.personalRules,
      agentMode: session.agentMode,
      triggeredBy: 'push-notification',
    };
    return this.handleQuery(request);
  }

  /**
   * run queue 转 idle 后的补 drain schedule（与 ElectronAgentHost 对称）。
   *
   * turn 收尾（onTurnFinally）时排的 drain 用 queueMicrotask，必赶在 runQueue
   * `drainNext` 释放 slot 之前执行，被 `isBusy` 闸静默吞掉且无人重排——后台
   * 任务在此窗口完成时，通知会滞留到下一条用户消息。queue 真正 idle 后由
   * `AgentPlatformAdapter.onConversationIdle` 调到这里补一次。
   *
   * 入参是 runQueue 提交键（`businessThreadId ?? threadId`）：直接 schedule
   * 覆盖「conversationId === threadId」的主路径；business thread 场景再按
   * sessions 反查补 schedule 各 threadId（通知按 threadId 入队）。
   */
  private scheduleNotificationDrainOnIdle(conversationId: string): void {
    this.notificationDrain.schedule(conversationId);
    for (const [threadId, session] of this.sessions) {
      if (session.businessThreadId === conversationId && threadId !== conversationId) {
        this.notificationDrain.schedule(threadId);
      }
    }
  }

  /**
   * ：后台任务完成「turn 内注入」的 drain（薄委托到 NotificationIdleDrain）。
   * 作为 `EngineConfig.drainThreadNotifications` 的宿主实现——每轮 ReAct 迭代边界
   * 由 agent-runtime 调用，把该 thread 已完成的通知 drain 拼成注入文本返回。
   * 与 idle drain 消费同一队列（drain 同步出队 + 释放 dedup，互斥零重复）。
   */
  private drainThreadNotificationsText(threadId: string): string | null {
    return this.notificationDrain.drainText(threadId);
  }

  // ──  对话回退：远端宿主 transcript 截断（Django session_transcript_truncate
  //    设备动作的执行端）。与 Electron 本地宿主对称：写 rewind 软标记（可 unrevert），
  //    重建上下文时立即生效；物理截断推迟到发下一条消息（commitRewind）。优先用 live
  //    session 的 sessionStorage，无 live session 时构造瞬态 storage 操作归档文件。

  private async withTranscriptStorage<T>(
    threadId: string,
    spaceId: string | undefined,
    fn: (storage: SessionStorage) => Promise<T>,
  ): Promise<T> {
    const live = this.sessions.get(threadId);
    if (live) return fn(live.sessionStorage);

    // （硬切）：无 live session 时构造瞬态 storage 走
    // dataRoot + owner.userId；owner 缺失（config.user_id 未配置）直接抛错，
    // 不再回落 legacy platform-data 目录。organizationId/spaceId 亦必填。
    const owner = this.resolveOwner();
    const organizationId = owner.organizationId ?? this.config.organization_id;
    if (!organizationId || !spaceId) {
      throw new Error(
        'withTranscriptStorage requires organizationId+spaceId ( hard-cut — no _unscoped)',
      );
    }
    const dataRoot = resolveDataRoot();
    const sessionDir = resolveWorkspaceSessionArchiveDir(
      dataRoot,
      owner.userId,
      organizationId,
      spaceId,
    );
    const storage = new SessionStorage({ sessionDir, threadId });
    try {
      return await fn(storage);
    } finally {
      await storage.dispose();
    }
  }

  async rollbackTranscript(input: {
    threadId: string;
    targetMessageId?: string;
    targetRole?: 'user' | 'assistant';
    targetContent?: string;
    targetOccurrenceIndex?: number;
    mode?: 'rollback' | 'editAndResend';
    keepMessageCount?: number;
    spaceId?: string;
  }): Promise<{ success: boolean; applied?: boolean; keepMessageCount?: number | null; error?: string }> {
    if (!input?.threadId) {
      return { success: false, error: 'threadId is required' };
    }
    try {
      const result = await this.withTranscriptStorage(input.threadId, input.spaceId, async (storage) => storage.applyTimelineRewind({
        target: {
          messageId: input.targetMessageId,
          role: input.targetRole,
          content: input.targetContent,
          occurrenceIndex: input.targetOccurrenceIndex,
        },
        mode: input.mode ?? (input.targetRole === 'assistant' ? 'rollback' : 'editAndResend'),
        fallbackKeepMessageCount: input.keepMessageCount,
      }));
      this.logger.info(
        `[DaemonAgentHost] [rollback-transcript] thread=${input.threadId.slice(0, 8)}… keep=${result.keepMessageCount ?? 'skip'}`,
      );
      // applied=false：锚不中且无 fallback → 未截断，由 Django 据此发 system notice。
      return { success: true, applied: result.applied, keepMessageCount: result.keepMessageCount };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[DaemonAgentHost] [rollback-transcript] failed: ${error}`);
      return { success: false, error };
    }
  }

  async unrevertTranscript(input: {
    threadId: string;
    spaceId?: string;
  }): Promise<{ success: boolean; error?: string }> {
    if (!input?.threadId) return { success: false, error: 'threadId is required' };
    try {
      await this.withTranscriptStorage(input.threadId, input.spaceId, (storage) => storage.clearRewind());
      this.logger.info(`[DaemonAgentHost] [unrevert-transcript] thread=${input.threadId.slice(0, 8)}…`);
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[DaemonAgentHost] [unrevert-transcript] failed: ${error}`);
      return { success: false, error };
    }
  }

  // W4a S0（2026-05-30）：原 `composeNotificationPrompt` 私有方法 +
  // `escapeXmlForNotification` helper 已上提到 `@tabtin/terminal-core` 的
  // `composeNotificationPrompt` 纯函数（两端 host 共用单一来源、按 env.kind
  // 分派，shell 段输出逐字节不变）。见文件顶部 import 与 `_tryDrain`。

  /**
   * W4a S2（2026-05-30）：子 Agent 实时流的 **query 外** session 级直接 gateway
   * relay（与 Electron `relaySubagentStreamEventDirect` 对称）。
   *
   * `subagentStreamSink` 在没有活跃 query（`eventInterceptor` 为 undefined）时走
   * 这里——现状此场景是 no-op 丢弃（`emitStreamEvent` 出 query 即失效，plan
   * §5.3 Daemon「缺 in-query 实时流」），S2 改为始终推到 gateway 让后台子事件
   * 不黑屏。
   *
   * **PR1 现状**：尚无后台 producer 在 query 外 emit 子事件（S5 接入），故 PR1
   * 内实际不会触发——为 S5 预留的挂点。best-effort fire-and-forget。query 内
   * 的事件仍走 per-query deliveryBuffer（有 ordering / trace 关联），不经此处。
   */
  private relaySubagentStreamEventDirect(sessionId: string, event: StreamEvent): void {
    void this.gateway.relayEvents(sessionId, [event]).catch((err) => {
      this.logger.warn(
        `[DaemonAgentHost] [subagent-sink] out-of-query relay failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * t1（终端"假运行"根治）：后台命令终结时把 `background-task-completed` 通知翻译成
   * 一条**终态** tool_result mini-message，经 out-of-query gateway relay 发往 Django，
   * 覆盖之前合并的 `status: "running"` 快照。与 Electron host
   * `relayBackgroundTaskTerminalResult` 对称、前端零改、best-effort fire-and-forget。
   */
  private relayBackgroundTaskTerminalResult(env: NotificationEnvelope): void {
    if (env.kind !== SHELL_NOTIFICATION_KIND) return;
    const payload = env.payload as BackgroundTaskCompletedPayload;
    const relayThreadId = resolveBackgroundTaskRelayThreadId({
      target: env.target,
      payload,
    });
    const events = buildBackgroundTaskTerminalResult({
      threadId: relayThreadId,
      input: {
        agent_session_id: payload.agent_session_id,
        tool_use_id: payload.tool_use_id,
        command: payload.command,
        exit_code: payload.exit_code,
        exited_by: payload.exited_by,
        killed_reason: payload.killed_reason,
        duration_ms: payload.duration_ms,
        output_file_path: payload.output_file_path,
        cwd: payload.cwd,
      },
    });
    if (!events) return;
    // 终端假运行根治 Layer 1：owner 固化（治 F1）取 payload.owner（spawn 焊死）；
    // ack 消费 + 失败落盘 recover（治 F2/F3/F16）走 relayEventsWithRetry。
    const owner = (payload.owner as PersistedEntryOwner | undefined) ?? this.resolveOwnerBestEffort();
    // A5：通知消费在 NotificationQueue 同步 listener 栈里跑——.catch 兜底防 unhandled rejection。
    void this.relayPersistence.send(owner, relayThreadId, events).catch((err) => {
      this.logger.warn(
        `[DaemonAgentHost] [relay] background-task terminal-state relay rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  // ─── Query ──────────────────────────────────────────────────────

  /**
   * ：把一轮 query 提交给 per-session 串行队列。空闲即刻执行，忙则入队，
   * 轮到时出队执行；await 本轮 done 后返回真实结果——保持「返回 = 执行完成」的
   * 调用契约，消除旧的「忙则拒绝」（daemon 侧无本地 renderer sink，暂不发
   * MESSAGE_QUEUED 控制信号；correctness = 不丢、按序执行）。
   */
  // ─── agent-host-full-migration: composed query engine (headless) ─────
  //
  // Query flows: handleQuery → mapToHostQuery → AgentHost.submitHostQuery →
  // QueryTurnPipeline → RuntimeSessionLifecycle (reusing the single factory) +
  // DeliveryCoordinator. Headless: no local stream, no sender, sync owner.


  private buildDaemonResourceFactory(): RuntimeResourceFactory<
    RuntimeBuildInput, DaemonHostState, AgentModeName, RuntimeCarryForward, DaemonRuntimeExtraKey
  > {
    const ownerAdapter = this.buildOwnerAdapter();
    return {
      ...this.runtimeAssembly.buildRuntimeFactoryAdapter(),
      getOwner: ownerAdapter.getOwner,
      getConversationIdentity: ownerAdapter.getConversationIdentity,
      interruptSession: ownerAdapter.interruptSession,
      teardownSession: ownerAdapter.teardownSession,
      disposeOwnerResources: ownerAdapter.disposeOwnerResources,
    };
  }

  private buildDaemonDeliveryTransport(): DeliveryTransportPort {
    return {
      openLocalStream: () => undefined,
      sendRelayBatch: async (ctx, events) => {
        await this.gateway.relayEvents(ctx.sessionId, events);
        return {};
      },
      createOutboxStore: () => ({
        persist: () => undefined,

        drain: async function* () { return; },
        remove: () => undefined,
      }),
      subscribeReconnect: () => () => undefined,
    };
  }

  private buildDaemonDurableLayer(): DeliveryDurableLayer {
    return {
      send: async (ctx, event) => {
        await this.relayPersistence.send(
          ctx.owner as PersistedEntryOwner | undefined,
          ctx.sessionId,
          [{ type: event.type, payload: event.payload }],
        );
      },
      persist: (ctx, events) => {
        this.relayPersistence.onExhausted(
          ctx.owner as PersistedEntryOwner | undefined,
          ctx.sessionId,
          events,
        );
      },
      kickRecoverAndBackfill: async (opts) => {
        await this.relayOrchestrator.kickRecoverAndBackfill(opts);
      },
      stop: async () => {
        await this.relayPersistence.dispose();
      },
    };
  }

  private buildDaemonQueryDataPort(deps: {
    lifecycle: QueryTurnDataPort<DaemonHostState, RuntimeBuildInput, AgentModeName, DaemonRuntimeExtraKey>['lifecycle']
    delivery: QueryTurnDataPort<DaemonHostState, RuntimeBuildInput, AgentModeName, DaemonRuntimeExtraKey>['delivery']
  }): QueryTurnDataPort<DaemonHostState, RuntimeBuildInput, AgentModeName, DaemonRuntimeExtraKey> {
    const ctxOf = (runId: string) => this.sessionState.getPendingTurn(runId);
    return {
      lifecycle: deps.lifecycle,
      delivery: deps.delivery,
      log: {
        info: (m) => this.logger.info(m),
        warn: (m, d) => (d !== undefined ? this.logger.warn(m, { detail: d }) : this.logger.warn(m)),
      },
      sessionView: (s) => s as unknown as QueryTurnSessionView,
      runtimeOf: (s) => s.runtime,
      organizationIdOf: () => this.config.organization_id,
      fetchAuthoritative: (args) => this.agentConfigClient.fetchAuthoritativeAgentConfig(args.agentId),
      afterSessionReady: ({ query }) => {
        const ctx = ctxOf(query.identity.runId);
        const interactionMode = ctx?.request.interactionMode;
        if (interactionMode && interactionMode !== 'interactive') {
          this.sessionState.setInteractionMode(query.identity.sessionId, interactionMode);
        }
      },
      buildEffectivePrompt: async ({ session, query }) => {
        const ctx = ctxOf(query.identity.runId);
        const request = ctx?.request;
        if (!request) return query.turn.prompt;

        // ：与 Electron 共用 Host prompt 拼装（quoted / preset / @引用）
        // forward：contextBlocks 从 userMessageBlocks 去掉 type===text 气泡正文派生
        const assembled = await assembleHostPromptContext({
          message: query.turn.prompt,
          replyTo: request.replyTo,
          contextBlocks: filterHostPromptContextBlocks(request.userMessageBlocks),
          staleAfterTurn: request.clientMessageId ?? query.identity.runId,
          log: {
            info: (...args: unknown[]) => this.logger.info(String(args[0] ?? ''), ...args.slice(1)),
            warn: (...args: unknown[]) => this.logger.warn(String(args[0] ?? ''), ...args.slice(1)),
          },
          resolveContextBlocks: (blocks) => resolveHostContextBlocks(blocks, {
            apiBaseUrl: deriveApiBaseUrl(this.config.server_url),
            getAccessToken: async () => this.getAccessToken() || null,
            organizationId: this.config.organization_id,
          }),
        });

        //  / ：与 Electron 共用 planChatAttachmentsForPromptInjection
        const attachmentPlan = planChatAttachmentsForPromptInjection(request.attachments, {
          supportsDocumentInput: request.modelSupportsDocumentInput,
          supportsVideoInput: request.modelSupportsVideoInput,
        });
        if (attachmentPlan.status === 'blocked') {
          throw new AgentError(
            formatBlockedChatDocumentError(attachmentPlan.labels),
            'INTERNAL',
            { statusCode: 400, retryable: false },
          );
        }
        if (attachmentPlan.toResolve.length === 0) return assembled;
        const strategy: AttachmentStrategy = request.attachmentStrategy ?? resolveAttachmentStrategy(process.env, this.logger);
        const attachmentLines = await this.resolveFileAttachments(
          attachmentPlan.toResolve,
          strategy,
          { sessionId: query.identity.sessionId, agentId: request.agentId },
          session.abortController.signal,
          request.clientMessageId,
          this.config.organization_id,
        );
        if (attachmentLines.length === 0) return assembled;
        return `${assembled}\n\n${attachmentLines}`;
      },
      prepareRuntimeAttachments: async ({ attachments, query }) => {
        const request = ctxOf(query.identity.runId)?.request;
        const list = (attachments as DaemonQueryRequest['attachments']) ?? [];
        // 无视频能力或缺少 URL 时把 type=video 降为 file，避免误装 VideoBlock
        return list.map((a) => ({
          type: runtimeTypeForChatVideoAttachment(
            request?.modelSupportsVideoInput,
            a.type,
            a.url,
          ) as 'image' | 'file' | 'video',
          // ：与 Electron 对齐，transcript 落盘必须带 file_id 才能换链
          file_id: a.file_id,
          filename: a.filename,
          mime_type: a.mime_type,
          size: a.size,
          url: a.url,
        }));
      },
      buildQueryParams: (base, query) => {
        const ctx = ctxOf(query.identity.runId);
        const request = ctx?.request;
        if (!request) return base;
        const effectiveMaxTurns = request.maxTurns ?? request.executionLimits?.max_iterations_per_run ?? undefined;
        // ：与 Electron 同源——request.userMessageBlocks（context）+ attachments 派生块。
        const attachmentMessageBlocks = buildAttachmentMessageBlocks(request.attachments);
        const userMessageBlocks = [
          ...(request.userMessageBlocks ?? []),
          ...(attachmentMessageBlocks ?? []),
        ];
        // ：显式 skillSlashInvoke 优先；否则从 composer_preset.skill_key 派生
        const skillSlashInvoke = request.skillSlashInvoke?.skillKey
          ? request.skillSlashInvoke
          : resolveComposerPresetSkillInvoke(
              filterHostPromptContextBlocks(request.userMessageBlocks) ?? [],
            ) ?? undefined;
        return {
          ...base,
          systemPrompt: request.systemPrompt,
          maxTurns: effectiveMaxTurns,
          billingIdempotencyScope: request.billingIdempotencyScope,
          displayMessage: request.displayMessage,
          ...(query.turn.skillSlashInvoke?.skillKey
            ? { skillSlashInvoke: query.turn.skillSlashInvoke }
            : {}),
          ...(request.replyTo?.messageId ? { replyTo: request.replyTo } : {}),
          ...(request.pendingApprovalsSerialized && request.pendingApprovalsSerialized.length > 0
            ? { pendingApprovalsSerialized: request.pendingApprovalsSerialized }
            : {}),
          // ：单 HITL 断点恢复对称透传。仅在 forward.resume
          // 路径上非空（daemon.ts 从 wire interrupt_state 解出）。
          ...(request.pendingSingleHitlSerialized && request.pendingSingleHitlSerialized.length > 0
            ? { pendingSingleHitlSerialized: request.pendingSingleHitlSerialized }
            : {}),
          ...(userMessageBlocks.length > 0 ? { userMessageBlocks } : {}),
          ...(skillSlashInvoke?.skillKey ? { skillSlashInvoke } : {}),
        };
      },
      appendStreamEventToSessionStorage: async (session, event) => {
        // ：归属只在 host——persist 时按 message_id 记账，不进 blocks / history。
        const sessionDir = dirname(session.sessionStorage.blockStorage.filePath);
        rememberAttributionFromPersistEvent(
          event,
          session.owner.agentId,
          sessionDir,
        );
        await this.appendStreamEventToSessionStorage(session.sessionStorage, event, session.toolLogWriter);
      },
      flushTurnStorage: async (session) => {
        session.eventInterceptor = undefined;
        session.toolProvider.setSubagentTraceWiring(undefined, undefined);
        await session.sessionStorage.dispose();
        await session.snapshotStorage.dispose().catch(() => undefined);
        await session.eventStorage.dispose().catch(() => undefined);
      },
      reconcileSessionRelayBackfill: (session, conversationId) => {
        void this.reconcileSessionRelayBackfill(session, conversationId).catch((err) => {
          this.logger.warn(`[RelayReconcile] pre-query backfill failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      },
      buildLifecycleErrorEvent: (session, error) => {
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: string }).code;
        const emitter = session.eventEmitter ?? new EventEmitter(undefined, {
          threadId: session.sessionId, traceId: session.sessionId, runId: session.sessionId,
        });
        return correlateSourceClientEvent(
          emitter.build(new RuntimeLifecycleEvent({
            phase: 'error', status: 'error', error_message: message, detail: code ?? 'INTERNAL',
          })),
          undefined,
        );
      },
      onTurnError: (error, query, aborted) => {
        this.settleHostTrackerSession(
          query.identity.sessionId,
          aborted ? 'cancelled' : (error instanceof Error ? error.message : String(error)),
        );
        if (aborted) return;
        const classified = classifyError(error);
        if (!isReportableRunError(classified.category)) return;
        const request = ctxOf(query.identity.runId)?.request;
        captureRunError(error, {
          handled_by: 'daemon_agent_host',
          error_category: classified.category === 'doom_loop'
            ? 'AGENT_DOOM_LOOP'
            : 'AGENT_RUN_FATAL',
          error_code: classified.code,
          run_id: query.identity.runId,
          session_id: query.identity.sessionId,
          agent_id: query.policy?.agentId,
          organization_id: query.identity.owner.organizationId,
          workspace_id: request?.workspaceId,
          space_id: request?.spaceId,
          task_id: query.turn.taskId,
        });
      },
      onTurnFinally: (sessionId) => {
        this.settleHostTrackerSession(sessionId);
        this.sessionState.deleteInteractionMode(sessionId);
        this.notificationDrain.schedule(sessionId);
      },
    };
  }

  private installComposedQueryEngine(): void {
    const sharedHost = this.sharedHost;
    if (!sharedHost) return;
    sharedHost.composeQueryEngine<
      RuntimeBuildInput, AgentModeName, RuntimeCarryForward, DaemonRuntimeExtraKey
    >({
      resources: this.buildDaemonResourceFactory(),
      factory: this.runtimeAssembly.getRuntimeFactory(),
      deliveryTransport: this.buildDaemonDeliveryTransport(),
      durable: this.buildDaemonDurableLayer(),
      buildDataPort: (deps) => this.buildDaemonQueryDataPort(deps),
      applyLivePolicy: (session, update) => {
        applyAuthoritativeSecurityMutate(session as unknown as QueryPipelineSession, {
          allowYolo: update.allowYolo === true,
          approvalGrant: update.approvalGrant,
          agentMode: update.agentMode ?? session.policyContext.currentAgentMode,
          requestedApprovalMode: update.requestedApprovalMode,
          isGroupSpace: update.isGroupSpace ?? session.policyContext.isGroupSpace,
        });
      },
    });
  }

  private mapToHostQuery(
    request: DaemonQueryRequest,
    owner: PersistedEntryOwner,
    runId: string,
  ): HostQuery<RuntimeBuildInput, AgentModeName, DaemonRuntimeExtraKey> {
    const conversationId = request.threadId ?? request.sessionId;
    return {
      identity: { conversationId, sessionId: request.sessionId, runId, owner },
      runtime: this.buildDaemonRequestFromQuery(request, owner),
      turn: {
        prompt: request.prompt,
        attachments: request.attachments,
        history: request.history,
        clientMessageId: request.clientMessageId,
        skillSlashInvoke: request.skillSlashInvoke,
        triggeredBy: request.triggeredBy,
        displayMessage: request.displayMessage,
        // ：context 引用块须进本机 transcript（与 Electron mapToHostQuery 对齐）。
        userMessageBlocks: request.userMessageBlocks,
        taskId: request.taskId,
        relaySessionId: request.relaySessionId,
      },
      policy: {
        agentId: request.agentId,
        agentMode: request.agentMode,
        approvalMode: request.approvalMode,
        isGroupSpace: request.isGroupSpace,
        yoloModeFromWire: request.yoloMode,
        workspaceSnapshot: request.workspaceSnapshot,
        appContext: request.appContext,
        agentProfile: {
          agentName: request.agentName,
          customRules: request.customRules,
        },
      },
    };
  }

  private buildDaemonRequestFromQuery(
    request: DaemonQueryRequest,
    owner: PersistedEntryOwner,
  ): RuntimeSessionRequest<RuntimeBuildInput, AgentModeName, DaemonRuntimeExtraKey> {
    const agentMode: AgentModeName = request.agentMode ?? 'agent';
    const normalizedDisabledApps = request.disabledApps ?? [];
    const normalizedDisabledToolPrefixes = request.disabledToolPrefixes ?? [];
    const modelId = request.modelId ?? 'default';
    const workspaceId = request.workspaceId ?? '';
    const cacheKeyInput = {
      modelId,
      customRules: request.customRules,
      personalRules: request.personalRules,
      workspaceRoot: this.workspaceRoot,
      owner,
      spaceId: request.spaceId,
      operationSwitches: request.operationSwitches,
      maxCreditsPerRun: request.executionLimits?.max_credits_per_run,
      memoryCapability: request.memoryCapability,
      workingDirType: request.workingDirType,
      enabledApps: request.enabledApps,
    };
    const buildInput: RuntimeBuildInput = {
      modelId,
      agentId: request.agentId,
      authorizationPreset: request.authorizationPreset,
      customRules: request.customRules,
      personalRules: request.personalRules,
      owner,
      spaceId: request.spaceId,
      operationSwitches: request.operationSwitches,
      disabledApps: normalizedDisabledApps,
      disabledToolPrefixes: normalizedDisabledToolPrefixes,
      memoryCapability: request.memoryCapability,
      workingDirType: request.workingDirType,
      executionLimits: request.executionLimits,
      yoloMode: request.yoloMode,
      workspaceSnapshot: request.workspaceSnapshot,
      isByokMode: request.isByokMode,
      enabledApps: request.enabledApps,
      isGroupSpace: request.isGroupSpace,
      spaceName: request.spaceName,
      organizationName: request.organizationName,
      cliReference: request.cliReference,
      threadId: request.threadId,
      cloudPressureThresholds: request.cloudPressureThresholds,
      workspaceId,
    };
    return {
      sessionId: request.sessionId,
      mode: agentMode,
      cacheKey: cacheKeyInput,
      extraKey: normalizeDaemonRuntimeExtraKey(
        normalizedDisabledApps,
        normalizedDisabledToolPrefixes,
        workspaceId,
      ),
      input: buildInput,
    };
  }

  async handleQuery(
    request: DaemonQueryRequest,
  ): Promise<{ success: boolean; error?: string }> {
    const sessionId = request.threadId ?? request.sessionId;
    if (!sessionId) {
      return { success: false, error: 'sessionId is required' };
    }
    if (!request.workspaceId) {
      return { success: false, error: 'workspaceId is required for execution' };
    }
    const runId = request.runId ?? request.clientMessageId ?? randomUUID();
    if (request.runId && this.sharedHost?.hasAdmittedHostQuery(runId)) {
      this.logger.info(`[DaemonAgentHost] replayed admitted forward ignored: run=${runId}`);
      return { success: true };
    }
    let owner: PersistedEntryOwner;
    try {
      owner = this.resolveOwner(request.agentId, request.userId);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const sharedHost = this.sharedHost;
    if (!sharedHost) {
      return { success: false, error: 'AgentHost is not started' };
    }
    if (this.relayPersistence.activateOwner(owner)) {
      void this.relayOrchestrator.kickRecoverAndBackfill({ activateOwner: false });
    }
    const hostQuery = this.mapToHostQuery(request, owner, runId);
    this.sessionState.setPendingTurn(runId, request);
    let admitted = false;
    try {
      const begun = sharedHost.beginSubmitHostQuery(
        hostQuery as unknown as HostQuery<unknown, string, never>,
      );
      if (!begun.ok) return begun.result;
      admitted = true;
      void begun.completion
        .then((result) => {
          if (!result.success) {
            this.logger.warn(
              `[DaemonAgentHost] admitted run settled with error: run=${runId} error=${result.error ?? ''}`,
            );
          }
        })
        .catch((error: unknown) => {
          if (!(error instanceof ConversationRunCancelledError)) {
            this.logger.warn(
              `[DaemonAgentHost] admitted run settle failed: run=${runId} error=${error instanceof Error ? error.message : String(error)}`,
            );
          }
        })
        .finally(() => this.sessionState.deletePendingTurn(runId));
      return { success: true };
    } catch (error) {
      if (error instanceof ConversationRunCancelledError) {
        return { success: false, error: error.message };
      }
      throw error;
    } finally {
      if (!admitted) this.sessionState.deletePendingTurn(runId);
    }
  }

  private async acknowledgePromptAdmission(
    runId: string | undefined,
    envelope: Record<string, unknown>,
  ): Promise<void> {
    const eventId = envelope.event_id;
    const threadId = envelope.thread_id;
    const topic = envelope._topic;
    if (
      !runId
      || typeof eventId !== 'string'
      || !/^[0-9]+-[0-9]+$/.test(eventId)
      || typeof threadId !== 'string'
      || !threadId
      || typeof topic !== 'string'
      || !topic.startsWith('agent.action.device.')
    ) {
      return;
    }
    try {
      await this.gateway.sendAgentEvent(threadId, PromptEvents.ADMITTED, {
        buffered_event_id: eventId,
        run_id: runId,
      });
      this.gateway.acknowledgeApplicationEvent?.(eventId, topic);
    } catch (error) {
      this.logger.warn(
        `[DaemonAgentHost] prompt admission ACK failed; EventBuffer retained: run=${runId} event=${eventId} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ─── Abort ──────────────────────────────────────────────────────

  handleAbort(sessionId?: string): { success: boolean } {
    if (sessionId) {
      //  停止链路收口（与 ElectronAgentHost.handleAbort 对称）：入参可能
      // 是 forward 的 task_id（sessions key 直达）、业务 sessionId、或
      // `chat-session-<uuid>` 形态 thread_id。businessThreadId 即本 session
      // 的稳定业务 thread（缺省时创建期已回落 sessionId），充当业务索引让
      // 「按业务会话中止」也能命中 key=task_id 的 forward run。
      const keys = resolveConversationAbortKeys(
        sessionId,
        [...this.sessions.values()].map((s) => ({
          key: s.sessionId,
          businessThreadId: s.businessThreadId,
        })),
      );
      if (keys.length === 0) {
        // miss 不再假成功——让 daemon.ts 如实记 `prompt.cancel failed`，
        // 后端可据此判定取消未触达（与 Electron  行为对齐）。
        this.logger.warn(`[DaemonAgentHost] abort miss: session not found [session=${sessionId.slice(0, 8)}…]`);
        return { success: false };
      }

      for (const key of keys) {
        this.abortSessionByKey(key);
      }
      return { success: true };
    }

    for (const sid of this.sessions.keys()) {
      this.abortSessionByKey(sid);
    }
    this.logger.info('[DaemonAgentHost] All queries aborted');
    return { success: true };
  }

  handlePause(candidateIds: string[]): { success: boolean } {
    return this.handlePauseControl(candidateIds, true);
  }

  handleResume(candidateIds: string[]): { success: boolean } {
    return this.handlePauseControl(candidateIds, false);
  }

  private handlePauseControl(candidateIds: string[], shouldPause: boolean): { success: boolean } {
    for (const id of candidateIds) {
      if (shouldPause) this.rememberPendingPauseCandidate(id);
      else this.pendingPauseCandidateIds.delete(id);
    }
    let matched = false;
    for (const candidateId of candidateIds) {
      const keys = resolveConversationAbortKeys(
        candidateId,
        [...this.sessions.values()].map((session) => ({
          key: session.sessionId,
          businessThreadId: session.businessThreadId,
        })),
      );
      for (const key of keys) {
        const session = this.sessions.get(key);
        if (!session) continue;
        matched = true;
        if (shouldPause) session.pauseController.pause();
        else session.pauseController.resume();
      }
    }
    if (matched) {
      for (const id of candidateIds) this.pendingPauseCandidateIds.delete(id);
    }
    return { success: matched || candidateIds.length > 0 };
  }

  private rememberPendingPauseCandidate(candidateId: string): void {
    this.pendingPauseCandidateIds.add(candidateId);
    while (this.pendingPauseCandidateIds.size > 256) {
      const oldest = this.pendingPauseCandidateIds.values().next().value;
      if (typeof oldest !== 'string') break;
      this.pendingPauseCandidateIds.delete(oldest);
    }
  }

  private applyPendingPauseToSession(
    sessionId: string,
    businessThreadId: string,
    pauseController: SessionPauseController,
  ): void {
    const matched = [...this.pendingPauseCandidateIds].filter((candidate) => (
      resolveConversationAbortKeys(candidate, [{ key: sessionId, businessThreadId }]).length > 0
    ));
    if (matched.length === 0) return;
    pauseController.pause();
    for (const candidate of matched) this.pendingPauseCandidateIds.delete(candidate);
  }

  /** 按 sessions Map 真实 key 中止单条会话（handleAbort 单/全停共用）。 */
  private abortSessionByKey(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    const identity = {
      conversationId: session.businessThreadId || key,
      sessionId: key,
    };
    // ：host 停路径组合——
    // 1) abort：掐 supervisor activeRun（abortActiveRun）
    // 2) abortConversationRuns：强制 clearQueued(conversationId)
    //    abort() alone 受 canCancelWholeQueue 约束；同 business conversation
    //    下混 task_id/sessionId 排队时可能不清队。旧停路径始终清整队，这里保留。
    this.requireSharedHost().abort(identity);
    this.requireSharedHost().abortConversationRuns(identity);
    // session 层 signal 双保险：runtime.query 绑的是 view.abortController，
    // 与 supervisor activeRun signal 是两路；两路都掐，避免只命中一侧。
    session.abortController.abort();
    session.pauseController.resume();
    session.abortController = new AbortController();
    // W7a：abort 路径也必须清理 plan 审批协调器与 active-plan-tracker（与
    // Electron 同构）。否则 plan_exit 的 pending Promise 永远不解，下次发
    // 消息撞 "Session already has a running query"；W2-B Guard 拿到旧
    // active plan id 也会乱判。
    try {
      clearAllActivePlansForSession(key);
    } catch {
      // best effort —— tracker 自身的异常不应影响 abort 主流程
    }
    // 忙闲权威源在 sharedHost：排队已强制清掉；running 等 query settle 后 idle。
    this.logger.info(`[DaemonAgentHost] Aborted [session=${key.slice(0, 8)}…]`);
  }

  // ─── Approval Memo cross-device sync (W2-轮 2 / PRD 05 §7.3 + §8.1.2) ───

  /**
   * Handle ``agent.action.approval_memo_updated`` envelope dispatched from
   * ``DaemonGatewayClient.handleEvent`` → ``daemon.ts`` agent envelope router.
   *
   * Server publishes this event to ``organization.{organization_id}`` +
   * ``agent.action.{agent_id}`` topic right after writing
   * ``Agent.agent_config.approval_memo``. Daemon receives it through the
   * shared envelope channel; organization-level broadcast may carry updates for
   * other agents in the same organization, so we filter by ``payload.agent_id``
   * before triggering ``maybeRefetch`` on each matching session's store.
   *
   * Multiple sessions may share the same agentId (譬如 daemon 同时跑两个对话
   * window 共享一个 Agent)——所有匹配的 store 都触发 maybeRefetch。
   *
   * Failures are fail-soft：``maybeRefetch`` 内部已经 try/catch；这里只是
   * 把 envelope 解析 + 路由分发，自身不做 fetch I/O。
   */
  handleApprovalMemoUpdated(envelope: Record<string, unknown>): void {
    // 生产路径经 AgentHost realtime；本方法保留给单测 / 直调兼容。
    this.feedAgentEnvelope(envelope as AgentTransportEnvelope);
  }

  private async handleSharedHostUserResponse(input: {
    requestId?: string
    response: unknown
    batchId?: string
    decisions?: unknown[]
    submitId?: string
    envelope?: AgentTransportEnvelope
  }): Promise<void> {
    const batchId = typeof input.batchId === 'string' ? input.batchId : '';
    const topRequestId = typeof input.requestId === 'string' ? input.requestId : '';
    const env = (input.envelope ?? {}) as Record<string, unknown>;

    const sendDeliveryAck = async (
      status: 'delivered' | 'pending_not_found' | 'runtime_unavailable' | 'invalid_response',
      extra: Record<string, unknown> = {},
    ) => {
      const submitId = typeof input.submitId === 'string' ? input.submitId : '';
      if (!submitId) return;
      const threadId = typeof env.thread_id === 'string' ? env.thread_id : '';
      try {
        await this.gateway.sendAgentEvent(threadId, LocalRuntimeEvents.USER_RESPONSE_DELIVERY, {
          submit_id: submitId,
          status,
          request_id: topRequestId || undefined,
          batch_id: batchId || undefined,
          ...extra,
        });
      } catch (err) {
        this.logger.warn(
          `[LocalRT] delivery ack failed: submit=${submitId} status=${status} error=${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    if (batchId) {
      const decisions = Array.isArray(input.decisions) ? input.decisions : [];
      if (decisions.length === 0) {
        await sendDeliveryAck('invalid_response', {
          error_code: 'invalid_response',
          error_message: 'approval batch decisions[] is empty',
          retryable: false,
        });
        return;
      }
      const result = this.handleSubmitHitlBatch({
        batchId,
        decisions: decisions as Array<{
          request_id?: string
          tool_call_id: string
          outcome: 'allow' | 'deny' | 'cancelled' | 'expired'
          scope?: 'once' | 'thread' | 'always'
          rejection_message?: string
        }>,
      });
      if (result.success) {
        await sendDeliveryAck('delivered');
      } else {
        await sendDeliveryAck('pending_not_found', {
          error_code: 'pending_not_found',
          error_message: 'No pending approval batch on this runtime',
          retryable: false,
        });
      }
      return;
    }

    if (topRequestId) {
      const result = this.handleSubmitAskUserResponse(topRequestId, input.response);
      if (result.success) {
        await sendDeliveryAck('delivered');
      } else {
        await sendDeliveryAck('pending_not_found', {
          error_code: 'pending_not_found',
          error_message: 'No pending ask_user request on this runtime',
          retryable: false,
        });
      }
      return;
    }

    this.logger.warn('[LocalRT] user_response missing both batch_id and request_id');
    await sendDeliveryAck('invalid_response', {
      error_code: 'invalid_response',
      error_message: 'missing both batch_id and request_id',
      retryable: false,
    });
  }

  // ─── State ──────────────────────────────────────────────────────

  /**
   * ：busy 以 `runQueue.isBusy` 为准（running 或有排队；HITL 挂起期天然
   * busy）——权威对账口径，与 ElectronAgentHost.handleGetState 同构。
   *
   * 键解析与 handleAbort 同策略（resolveConversationAbortKeys + businessThreadId
   * 业务索引）：forward 路径 sessions key = task_id，用业务 UUID 查须二次命中。
   */
  getState(sessionId?: string): {
    sessionId: string | null;
    busy: boolean;
    running: boolean;
    queuedRunIds: string[];
    activeSessions?: number;
  } {
    if (sessionId) {
      const entries = [...this.sessions.values()].map((s) => ({
        key: s.sessionId,
        businessThreadId: s.businessThreadId,
      }));
      const keys = resolveConversationAbortKeys(
        sessionId,
        entries,
      );
      const candidates = resolveConversationStateKeys(sessionId, entries);
      const queueStates = candidates.map(key => this.requireSharedHost().getRunState(key))
      const busy = queueStates.some(state => state.busy)
      return {
        sessionId: keys.length > 0 ? sessionId : null,
        busy,
        // 阶段 4：busy=true 恒有 active run（ConversationRunQueue slot.running）；
        // 沿用旧字段名向 CLI/renderer 兼容。
        running: busy,
        queuedRunIds: queueStates.flatMap(state => state.queuedRunIds),
      };
    }
    const busyIds = this.requireSharedHost().getBusyConversationIds()
    return {
      sessionId: null,
      busy: busyIds.length > 0,
      running: busyIds.length > 0,
      queuedRunIds: [],
      activeSessions: this.sessions.size,
    };
  }

  async compactSession(input: AgentEngineCompactSessionInput): Promise<AgentEngineCompactSessionOutput> {
    const threadId = input?.threadId?.trim();
    if (!threadId) {
      return { success: false, error: 'threadId is required' };
    }
    const workspaceId = input?.workspaceId?.trim();
    if (!workspaceId) {
      return { success: false, error: 'workspaceId is required' };
    }
    // 阶段 4：忙闲权威源 = sharedHost.isBusy（coordinator 的 ConversationRunQueue）。
    if (this.requireSharedHost().isBusy(threadId)) {
      return { success: false, error: 'session is currently running' };
    }

    const session = this.sessions.get(threadId);
    if (!session) {
      return { success: false, error: 'session runtime is not ready' };
    }
    if (session.workspaceId !== workspaceId) {
      return { success: false, error: 'session belongs to another workspace' };
    }

    const messages: Message[] = (input.history ?? [])
      .filter(item => item.role === 'user' || item.role === 'assistant')
      .map(item => ({
        role: item.role,
        content: item.content as Message['content'],
      }));

    if (messages.length === 0) {
      return { success: false, error: 'no history to compact' };
    }

    // 阶段 4 · 门面 + 旁路收口：compact 走 `sharedHost.submitRun` 让本轮进入
    // coordinator FIFO——与业务 query 用同一条串行链，避免"compact 与用户消息
    // 同时抢 runtime 状态"。sharedHost 未起时直接 fail-fast 返回
    // `AgentHost is not ready`（见下方 submitRun 前的 guard），不做任何旁路兜底。
    const execute = async (): Promise<AgentEngineCompactSessionOutput> => {
      const result = await session.runtime.compactCheckpoint({
        messages,
        summaryFocus: input.summaryFocus,
        keepLastN: input.keepLastN,
      });
      if (!result.summary) {
        return { success: false, error: 'not enough history to compact' };
      }
      return {
        success: true,
        summary: result.summary,
        stats: result.stats,
      };
    };
    const submission = {
      conversationId: threadId,
      lifecycleScopeId: this.ownerKey(session.owner),
      runId: `compact:${randomUUID()}`,
      execute,
    };
    try {
      if (!this.sharedHost) {
        return { success: false, error: 'AgentHost is not ready' };
      }
      return await this.requireSharedHost().submitRun(submission);
    } catch (error) {
      if (error instanceof ConversationRunCancelledError) {
        return { success: false, error: error.message };
      }
      throw error;
    }
  }

  // ─── HITL: user input response ─────────────────────────────────
  //
  // v0.4 W1.5（PRD §6.7 / §7.4）：HITL 提交通道按"协议形态"分流：
  //   - approval batch：response = { batch_id, decisions[] } → handleSubmitHitlBatch
  //   - ask_user 单 request：response = { answers / field_values / text / skipped }
  //                          → handleSubmitAskUserResponse
  //
  // Daemon 上层（daemon.ts handleLocalRuntimeUserResponse）按 response.batch_id
  // 是否存在分流；这里两个 handler 都暴露公开方法（与 Electron 同构）。

  /**
   * 处理批量审批提交（v0.4 W1.5）。runtime 端 LocalPermissionHandler.requestPermissionsBatch
   * 用 batchId 注册一个 promise；这里单次 resolver 调用把整批 decisions 透传过去
   * （runtime 内部按 tool_call_id 分发回各工具）。
   */
  handleSubmitHitlBatch(payload: {
    batchId: string;
    decisions: Array<{
      request_id?: string;
      tool_call_id: string;
      // outcome 四档：'cancelled'（renderer dismiss / mode 切换 / rollback）+
      // 'expired'（服务端过期回灌预留）；engine 内部仍归 allow/deny。
      outcome: "allow" | "deny" | "cancelled" | "expired";
      scope?: "once" | "thread" | "always";
      rejection_message?: string;
    }>;
  }): { success: boolean } {
    if (!payload?.batchId || !Array.isArray(payload.decisions) || payload.decisions.length === 0) {
      this.logger.warn(`[DaemonAgentHost] handleSubmitHitlBatch invalid payload`);
      return { success: false };
    }
    const resolved = this.requireSharedHost().resolveApprovalBatch(
      payload.batchId,
      payload.decisions,
    );
    if (!resolved) {
      this.logger.warn(`[DaemonAgentHost] No pending approval batch for batchId=${payload.batchId} (likely already consumed)`);
      return { success: false };
    }
    return { success: true };
  }

  /** ask_user 单 request 通道。 */
  handleSubmitAskUserResponse(requestId: string, response: unknown): { success: boolean } {
    if (!this.requireSharedHost().resolveHumanAnswer(requestId, response)) {
      this.logger.warn(`[DaemonAgentHost] No pending ask_user request for requestId=${requestId}`);
      return { success: false };
    }
    return { success: true };
  }

  /**
   * W3-轮 1（PRD 05 v0.4 §7.6.2 接口 B）：处理 server 端权威清理广播。
   *
   * 上游路径：07 PRD rollback pipeline 调 Django ``cancel_pending_approvals_by_thread``
   * → Django 写 ``interrupt_state`` + audit + publish ``approval_resolved(outcome=
   * 'cancelled_by_rollback')`` 给 ``agent.stream.{thread_id}`` topic → Daemon
   * envelope handler 收到广播 → 调本方法路由到对应 ``interactions`` resolver。
   *
   * 与 ``handleSubmitHitlBatch`` 区别（用户主动提交 vs 系统取消）：见 Electron host
   * 同名方法注释。本期仅实装接口 + 单测，不接通广播订阅；07 PRD 启动后再接通。
   */
  handleApprovalResolvedCancelByRollback(payload: {
    batchId: string;
    decisions: Array<{
      request_id: string;
      tool_call_id: string;
      outcome: "allow" | "deny" | "cancelled" | "expired" | "cancelled_by_rollback";
      rejection_message?: string;
    }>;
  }): { resolvedBatchIds: string[]; orphanedRequestIds: string[] } {
    if (!payload?.batchId || !Array.isArray(payload.decisions) || payload.decisions.length === 0) {
      this.logger.warn(`[DaemonAgentHost] handleApprovalResolvedCancelByRollback invalid payload`);
      return { resolvedBatchIds: [], orphanedRequestIds: [] };
    }
    return applyCancelledByRollbackToHitl({
      batchId: payload.batchId,
      decisions: payload.decisions,
      hitlMap: this.interactionRegistry,
    });
  }

  // ─── Sub-agent cancel ──────────────────────────────────────────

  cancelSubagentById(childId: string): boolean {
    const ok = cancelSubagent(childId);
    this.logger.info(`[DaemonAgentHost] cancel-subagent ${childId.slice(0, 8)}: ${ok ? 'aborted' : 'not found'}`);
    return ok;
  }

  /**
   * ：CLI enable 后物化 marketplace app skill。
   * skillsModule 未就绪时抛错，由 CLI 路由回滚后端 enable。
   */
  async materializeAppSkill(params: {
    organizationId: string;
    spaceId: string;
    /** （硬切）：本地物化必须携带真实 userId，禁止 `_unscoped`。 */
    userId: string;
    appId: string;
    slug: string;
  }): Promise<{ installed: number; skipped: number; errors: string[] }> {
    if (!this.skillsModule) {
      throw new Error('Skill registry 未初始化');
    }
    const r = await this.skillsModule.materializeAppSkill(params);
    return { installed: r.installed, skipped: r.skipped, errors: r.errors };
  }

  /**
   *  / ：把互操作根（如 ~/.agents/skills）挂进 LocalSkillRegistry 并重扫。
   */
  async addInteropRoot(rootPath: string): Promise<void> {
    if (this.skillsReady) await this.skillsReady;
    if (!this.skillsModule) {
      throw new Error('Skill registry 未初始化');
    }
    await this.skillsModule.addInteropRoot(rootPath);
  }

  // ─── Internal: session storage append ──────────────────────────

  private async appendStreamEventToSessionStorage(
    storage: SessionStorage,
    streamEvent: StreamEvent,
    toolLogWriter?: ToolLogWriter | null,
  ): Promise<void> {
    // ：主循环 yield 的 persist_message（消息完整边界 blocks_json 整包）与
    // compaction 边界路由给 SessionStorage——前者写 message-blocks.jsonl（block
    // 权威，与 Django ChatMessage 同 payload），后者写 messages.jsonl 边界标记 +
    // block 压缩边界记录。这两类事件此前只走 relay，不落本地。详见
    // ElectronAgentHost 同位置注释。
    if (
      streamEvent.type === 'agent.stream.persist_message'
      || streamEvent.type === 'agent.stream.compaction'
    ) {
      await storage.appendStreamEvent(streamEvent);
      return;
    }
    // W6/ ：environment / agent-profile 注入（agent.stream.user）
    // 记进 transcript，让 transcript 重放带回历史上下文。详见 ElectronAgentHost
    // 同位置注释。仅记录、不二次 relay。
    if (streamEvent.type === 'agent.stream.user') {
      await this.appendUserStreamEvent(storage, streamEvent.payload as {
        message_kind?: string;
        content?: string;
        message_id?: string;
        client_event_id?: string;
        triggered_by?: string;
      });
      return;
    }
    if (streamEvent.type !== 'agent.stream.system_notice') return;
    await this.appendToolLifecycleNotice(storage, streamEvent.payload, toolLogWriter);
  }

  private async appendUserStreamEvent(
    storage: SessionStorage,
    userPayload: {
      message_kind?: string;
      content?: string;
      message_id?: string;
      client_event_id?: string;
      triggered_by?: string;
    },
  ): Promise<void> {
      const injectKind = userPayload.message_kind;
      const isContextInject =
        injectKind === 'environment_context' || injectKind === 'agent_profile_context';
      //  残留：in-turn push 必须落本地 blocks；idle drain 勿重复写入。
      // 判定见 isInTurnPushNotificationUser（有单测锁契约）。
      const isInTurnPush = isInTurnPushNotificationUser(userPayload);
      if (
        (isContextInject || isInTurnPush)
        && typeof userPayload.content === 'string'
        && userPayload.content.length > 0
      ) {
        // ：六件套 + block 记录双写；透传 runtime 生成的 message_id /
        // message_kind，让 block 记录与 Django ChatMessage 同 id、同 kind。
        const injectMessage = { role: 'user', content: userPayload.content } as const;
        const injectMessageId = userPayload.message_id ?? userPayload.client_event_id;
        const recordOpts = {
          ...(injectMessageId ? { messageId: injectMessageId } : {}),
          ...(isInTurnPush ? { triggeredBy: 'push-notification' as const } : {}),
        };
        await storage.recordUserMessage(injectMessage, recordOpts);
        await storage.appendUserBlockRecord(injectMessage, {
          ...recordOpts,
          ...(isContextInject && injectKind ? { messageKind: injectKind } : {}),
        });
      }
  }

  private async appendToolLifecycleNotice(
    storage: SessionStorage,
    rawPayload: unknown,
    toolLogWriter?: ToolLogWriter | null,
  ): Promise<void> {
    const payload = rawPayload as {
      notice_type?: string;
      phase?: string;
      tool_call_id?: string;
      tool_name?: string;
      input?: unknown;
      output?: unknown;
      is_error?: boolean;
      duration_ms?: number;
    };

    if (!isToolLifecycleNotice(payload.notice_type)) return;

    const toolCallId = payload.tool_call_id;
    if (!toolCallId) return;

    if (payload.phase === 'start') {
      storage.rememberToolInputForProjection(toolCallId, payload.input);
      toolLogWriter?.onToolStart(toolCallId, payload.input);
      return;
    }

    if (payload.phase !== 'end' && payload.phase !== 'error') return;

    const content = toolOutputToString(payload.output);
    await storage.recordToolResult(toolCallId, content, Boolean(payload.is_error));
    if (payload.tool_name === 'run_terminal_command') {
      await storage.recordTerminalToolProjection(
        toolCallId,
        payload.input,
        payload.output,
        Boolean(payload.is_error),
      );
    }

    if (toolLogWriter) {
      toolLogWriter.writeToolLog({
        tool_name: payload.tool_name ?? 'unknown',
        tool_call_id: toolCallId,
        output: payload.output,
        is_error: Boolean(payload.is_error),
        duration_ms: payload.duration_ms,
      });
    }
  }

  // ─── File attachment resolution (FR-18 Phase 2 H2-E) ───────────
  //
  // 与 ElectronAgentHost 的 `resolveFileAttachments` / `resolveOneAttachment`
  // / `fetchCloudSummary` / `formatUserFacingLocalError` 完全同构，仅在以下点
  // 与 Electron 有差异：
  //   1. logger 用 Daemon 的 `this.logger`（structured Logger，与 createLogger 不同）
  //   2. token 走 `this.getAccessToken()` 而非 `TokenManager.getAccessToken()`
  //   3. apiBaseUrl 走 `deriveApiBaseUrl(this.config.server_url)` 而非 Electron 全局
  //   4. 默认体积上限通过 `this.maxLocalFileSizeMb`（Daemon 默认 20MB）
  //
  // 所有埋点契约（`docparse.local_success` / `docparse.local_failed` /
  // `docparse.cloud_fallback` / `docparse.forbidden_local` / `metric.docparse.local_duration_ms`）
  // 与 Electron 完全一致 — sink 在 record 上自动加 `host: 'daemon'`，下游 jq 消费按
  // `host` 字段过滤即可区分。

  /**
   * FR-18：附件解析主流程（薄委托到共享 `resolveFileAttachmentsShell`）。
   * 单件解析（本地 DocParse / 云端 summary / 音频 ASR）仍由本类的 `resolveOneAttachment`
   * 保留 —— 平台差异（token / apiBase / logger / 20MB 默认上限）不适合抽到共享层。
   * 阶段 6 议题 2 的 `<context type="attached">` 外壳与 `\n\n` 拼接由 helper
   * 统一负责，双端逐字节对齐。
   */
  private async resolveFileAttachments(
    attachments: Array<{ type: string; file_id?: string; filename?: string; mime_type?: string; size?: number; url?: string }>,
    strategy: AttachmentStrategy,
    telemetryCtx: { sessionId: string; agentId?: string },
    abortSignal?: AbortSignal,
    turnId?: string,
    organizationId?: string,
  ): Promise<string> {
    return resolveFileAttachmentsShell(
      attachments,
      (a) => this.resolveOneAttachment(a, strategy, telemetryCtx, abortSignal, organizationId),
      (a) => this.fallbackAttachmentText(a),
      {
        logger: {
          debug: (message) => this.logger.debug(`[DaemonAgentHost] ${message}`),
        },
        turnId,
      },
    );
  }

  /**
   * FR-18 Phase 2 主路径：本地优先解析附件（与 Electron 完全对称）。
   *
   * **W4 (2026-05-13)** 改造为 FileResolver 抽象层 — 与 Electron 完全对称。
   * 流程见 ElectronAgentHost.resolveOneAttachment jsdoc。
   */
  private async resolveOneAttachment(
    a: { file_id?: string; filename?: string; mime_type?: string; size?: number; url?: string },
    strategy: AttachmentStrategy,
    telemetryCtx: { sessionId: string; agentId?: string },
    abortSignal?: AbortSignal,
    organizationId?: string,
  ): Promise<string | null> {
    if (!a.file_id) return null;

    const filename = a.filename ?? '文档';
    const mime = a.mime_type ?? '';

    // ：音频不走 DocParse / FileResolver，上传后自动 ASR，把转写注入上下文。
    if (isChatAudioAttachment(mime, filename)) {
      return this.resolveChatAudioAttachment(a, filename, organizationId, abortSignal);
    }

    //  / ：视频不走 DocParse；无原生 video 能力时仅确认上传成功。
    if (isChatVideoAttachment(mime, filename)) {
      return formatChatVideoUploadedBody(filename, a.size);
    }

    if (strategy === 'cloud_only') {
      return this.fetchCloudSummary(a.file_id, filename, abortSignal);
    }

    // strategy === 'local_first'
    const maxBytes = this.maxLocalFileSizeMb * 1024 * 1024;
    if (a.size != null && a.size > maxBytes) {
      this.logDocParseEvent(
        TelemetryEvents.DOCPARSE_FORBIDDEN_LOCAL,
        {
          reason: FilePipelineErrorCode.FILE_TOO_LARGE,
          mime,
          file_size_mb: Math.round((a.size / 1024 / 1024) * 10) / 10,
          file_id: a.file_id,
        },
        telemetryCtx,
      );
      return this.formatUserFacingLocalError(
        filename,
        FilePipelineErrorCode.FILE_TOO_LARGE,
        a.file_id,
      );
    }

    const localUrl = a.url;
    if (!localUrl) {
      this.logDocParseEvent(
        TelemetryEvents.DOCPARSE_CLOUD_FALLBACK,
        { reason: 'no_local_source', mime, file_id: a.file_id },
        telemetryCtx,
      );
      return this.fetchCloudSummary(a.file_id, filename, abortSignal);
    }

    // W4：调 FileResolver（PdfParser/DocxParser/XlsxParser 内部委托
    // local-docparse `parseLocalAttachment` + Daemon worker pool deps）
    const fileResolver = getDaemonFileResolver();
    const resolveResult = await fileResolver.resolve(
      {
        kind: 'oss-url',
        url: localUrl,
        filename,
        declaredMimeType: mime,
        sizeBytes: a.size,
      },
      {
        signal: abortSignal,
        channelLimitBytes: maxBytes,
        documentSubject: 'document',
        logger: {
          debug: (...args: unknown[]) => {
            const [msg, ...rest] = args
            this.logger.debug(String(msg ?? ''), ...rest)
          },
        },
      },
      {
        runDocParserTask: this.docParser.runTask,
      },
    );

    this.logFileResolverResult(resolveResult, { mime, fileId: a.file_id, filename }, telemetryCtx);

    return this.formatResolvedAttachment(resolveResult, a, filename, abortSignal);
  }

  private async formatResolvedAttachment(
    resolveResult: import('@tabtin/file-pipeline').ResolveResult,
    attachment: { file_id?: string; filename?: string; mime_type?: string; size?: number; url?: string },
    filename: string,
    abortSignal?: AbortSignal,
  ): Promise<string | null> {
    if (resolveResult.kind === 'text') {
      const header = `[文档: ${filename}]`;
      if (resolveResult.text.trim().length === 0) {
        return `${header}\n（本地解析成功但文档内容为空）`;
      }
      return `${header}\n${resolveResult.text}`;
    }

    if (resolveResult.kind === 'image') {
      return `${`[图片: ${filename}]`}\n（已注入到对话上下文）`;
    }

    const errClass = resolveResult.code;
    if (errClass === FilePipelineErrorCode.USER_ABORTED) return null;
    const fallbackToCloud = errorClassToFallback(errClass);
    if (!fallbackToCloud) {
      return this.formatUserFacingLocalError(filename, errClass, attachment.file_id!);
    }
    if (abortSignal?.aborted) return null;
    const cloudText = await this.fetchCloudSummary(attachment.file_id!, filename, abortSignal);
    return cloudText ?? this.fallbackAttachmentText(attachment);
  }

  /**
   * ：聊天拖入的音频附件 → Django speech ASR → 转写注入 Agent 上下文。
   * 与 ElectronAgentHost.resolveChatAudioAttachment 同构。
   */
  private async resolveChatAudioAttachment(
    a: { filename?: string; mime_type?: string; size?: number; url?: string; file_id?: string },
    filename: string,
    organizationId: string | undefined,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const result = await transcribeChatAudioAttachment(
      {
        url: a.url,
        filename,
        mime_type: a.mime_type,
        size: a.size,
        file_id: a.file_id,
      },
      {
        apiBaseUrl: deriveApiBaseUrl(this.config.server_url),
        organizationId: organizationId ?? this.config.organization_id ?? '',
        getAccessToken: () => this.getAccessToken(),
        signal: abortSignal,
      },
    );
    if (result.ok) {
      this.logger.debug(
        `[DaemonAgentHost] chat audio ASR ok (${result.mode}${result.fromCache ? ',cache' : ''}): ${result.text.length} chars from ${filename}`,
      );
      return formatChatAudioTranscriptBody(filename, result.text);
    }
    this.logger.warn(
      `[DaemonAgentHost] chat audio ASR failed (${result.kind}) for ${filename}: ${result.userMessage.slice(0, 200)}`,
    );
    return result.userMessage;
  }

  private logFileResolverResult(
    result: import('@tabtin/file-pipeline').ResolveResult,
    ctx: { mime: string; fileId: string; filename: string },
    telemetryCtx: { sessionId: string; agentId?: string },
  ): void {
    if (result.kind === 'text') {
      this.logDocParseEvent(
        TelemetryEvents.DOCPARSE_LOCAL_SUCCESS,
        {
          mime: ctx.mime,
          pages: result.pages,
          char_count: result.text.length,
          duration_ms: result.durationMs,
          file_size_mb: Math.round((result.fileSizeBytes / 1024 / 1024) * 10) / 10,
          quality_score: result.qualityScore,
          file_id: ctx.fileId,
        },
        telemetryCtx,
      );
      this.logDocParseEvent(
        TelemetryEvents.DOCPARSE_LOCAL_DURATION,
        {
          mime: ctx.mime,
          pages: result.pages,
          duration_ms: result.durationMs,
          bucket: this.bucketForPages(result.pages),
        },
        telemetryCtx,
      );
      return;
    }
    if (result.kind === 'error') {
      const fallback = errorClassToFallback(result.code);
      this.logDocParseEvent(
        TelemetryEvents.DOCPARSE_LOCAL_FAILED,
        {
          mime: ctx.mime,
          error_class: result.code,
          fallback_to_cloud: fallback,
          file_id: ctx.fileId,
        },
        telemetryCtx,
      );
      if (fallback) {
        this.logDocParseEvent(
          TelemetryEvents.DOCPARSE_CLOUD_FALLBACK,
          { reason: result.code, mime: ctx.mime, file_id: ctx.fileId },
          telemetryCtx,
        );
      }
    }
  }

  // W4 (2026-05-13)：旧 `logLocalParseResult(LocalDocParseResult)` 已删除 —
  // resolveOneAttachment 改走 FileResolver 后由上方 `logFileResolverResult` 接
  // ResolveResult。D2 不留 MVP / 不留 deprecated 标记，整段物理删除。

  private bucketForPages(pages: number | undefined): string {
    if (pages == null) return 'unknown';
    if (pages <= 10) return '1-10';
    if (pages <= 50) return '11-50';
    if (pages <= 100) return '51-100';
    if (pages <= 500) return '101-500';
    return '500+';
  }

  private logDocParseEvent(
    event: TelemetryEventName,
    payload: Record<string, unknown>,
    ctx: { sessionId: string; agentId?: string },
  ): void {
    // 与 Electron 双通道一致：Daemon Logger（人类可读 / 运维 grep）+ 统一 telemetry sink。
    // sink 在 record 上自动 enrich `host: 'daemon'` —— 跨宿主分析时 jq 按 host 字段
    // 过滤即可区分两端来源。事件名由 TypeScript 约束到 TelemetryEvents 常量，避免漂移。
    this.logger.info(`[telemetry-call] ${event} ${JSON.stringify(payload)}`);
    emitTelemetryEvent(event, payload, {
      session_id: ctx.sessionId,
      agent_id: ctx.agentId ?? undefined,
    });
  }

  /**
   * 把本地错误翻译成"给用户看的明确提示"（与 Electron 完全一致）。
   *
   * ⚠️ 设计约束：此文本会被注入 `effectivePrompt` 交给 LLM，LLM 会以自己的语气
   * 转述给用户。因此：
   *   1. 不能含 agent 内部工具名（如 `parse_document`），否则用户读到会困惑
   *   2. 不能含 file_id / UUID 这类技术标识符（FILE_TOO_LARGE 例外，给 Agent
   *      用 parse_document 走分页用，明示 [INTERNAL]）
   *   3. 用自然语言描述"是什么问题 + 用户可以做什么"，让 LLM 能自由转述
   *
   * **W1.3 第 3 轮 Review 2 S1 修复（2026-05-13）**：薄包装调 SSoT
   * `formatFilePipelineErrorChinesePrompt`（与 Electron 同款），13 类全覆盖；
   * 替代原"3 case + 裸 enum 字面值兜底"实现。
   */
  private formatUserFacingLocalError(
    filename: string,
    errorClass: FilePipelineErrorCode,
    fileId: string,
  ): string {
    return formatFilePipelineErrorChinesePrompt(errorClass, {
      filename,
      localLimitMb: this.maxLocalFileSizeMb,
      fileIdForParseDocument: fileId,
    });
  }

  /**
   * 云端 DocParse summary 兜底路径（与 Electron 行为一致）。
   *
   * Daemon 与 Electron 的差异：
   *   - token 走 `this.getAccessToken()`（每次调用都拿最新 token，避免 token 刷新后用旧值）
   *   - apiBaseUrl 走 `deriveApiBaseUrl(this.config.server_url)`
   *   - logger 走 `this.logger.debug`（structured Logger）
   *
   * **Verifier-B 必修项**：接受 `sessionAbortSignal` 与会话级 abort 联动，
   * 让用户点"停止生成"时云端 fetch 也立刻中断，不再傻等 15s timeout（手机端
   * 流量敏感场景尤其重要）。
   */
  private async fetchCloudSummary(
    fileId: string,
    filename: string,
    sessionAbortSignal?: AbortSignal,
  ): Promise<string | null> {
    try {
      const token = this.getAccessToken();
      if (!token) return null;

      const apiBase = deriveApiBaseUrl(this.config.server_url);
      const url = joinApiPath(apiBase, `/services/docparse/summary/${fileId}?max_tokens=2000`);

      // 组合两个 signal：内部 15s 硬超时 + 会话级 abort（用户"停止"）。
      // 任一触发即取消 fetch。AbortSignal.any 是 Node 20.3+ 标准 API；如未来
      // 兼容旧 Node 需要 polyfill。
      const internalTimeoutSignal = AbortSignal.timeout(15_000);
      const composed = sessionAbortSignal
        ? AbortSignal.any([internalTimeoutSignal, sessionAbortSignal])
        : internalTimeoutSignal;

      const resp = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: composed,
      });

      if (!resp.ok) return null;

      const data = (await resp.json()) as {
        status?: string;
        summary?: string;
        title?: string;
        total_pages?: number;
        message?: string;
        // **W1.3 第 3 轮 Review 2 S1（2026-05-13）**：后端 `/summary` endpoint 在
        // `status='failed'` 时返回 `failure_code` 字段（与 SSoT 13 类对齐，见
        // `apps/tabtin_django/apps/services/docparse/api.py:122-131`）。
        failure_code?: string;
      };

      if (data.status === 'ready') {
        //  / ：ready 但空摘要 / 表格 stub / 乱码 —— 注入前做质量门。
        const summaryText = data.summary ?? '';
        const quality = assessCloudSummaryQuality(summaryText);
        if (!quality.ok) {
          this.logger.info('docparse.cloud_summary_rejected', {
            file_id: fileId,
            filename,
            reason: quality.reason,
            summary_len: summaryText.length,
          });
          return formatFilePipelineErrorChinesePrompt(
            quality.reason === 'garbled_text_layer'
              ? FilePipelineErrorCode.GARBLED_TEXT_LAYER
              : FilePipelineErrorCode.SCANNED_PDF,
            {
              filename,
              fileIdForParseDocument: fileId,
              rawMessage: `cloud summary rejected: ${quality.reason}`,
            },
          );
        }
        const header = data.title
          ? `[文档: ${filename} — ${data.title}]`
          : `[文档: ${filename}]`;
        return `${header}\n${summaryText}`;
      }

      if (data.status === 'parsing') {
        return (
          `[文档: ${filename} — 正在解析中，内容将在解析完成后可用。`
          + `你可以使用 parse_document 工具稍后重新读取此文档（file_id: ${fileId}）]`
        );
      }

      if (data.status === 'pending') {
        return (
          `[文档: ${filename} — 已触发解析，内容将在解析完成后可用。`
          + `你可以使用 parse_document 工具稍后重新读取此文档（file_id: ${fileId}）]`
        );
      }

      // **W1.3 第 3 轮 Review 2 S1 修复（2026-05-13）**：与 Electron 同步。
      // 原实现 status='failed' 走 `return null` → fallbackAttachmentText 兜底 →
      // 用户看到 "[附件: foo.pdf (application/pdf)]" 这种**完全没有错误原因**的
      // 占位。改为消费 backend `failure_code`，调 SSoT 派发 13 类对应的中文转述
      // 文本，与持久通道临时通道两端错误 UX 拉齐。
      if (data.status === 'failed') {
        const failureCode = isFilePipelineErrorCode(data.failure_code)
          ? data.failure_code
          : FilePipelineErrorCode.UNKNOWN_ERROR;
        return formatFilePipelineErrorChinesePrompt(failureCode, {
          filename,
          rawMessage: data.message,
        });
      }

      return null;
    } catch (err) {
      this.logger.debug(
        `[DaemonAgentHost] DocParse summary request failed for ${fileId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * 终极兜底文本：所有解析路径都失败时（含云端 summary 也不可用）的简洁元数据。
   *
   * **Verifier-B Review 必修项**：v1.0 暴露了 `file_id` / `URL: presigned-url` 到
   * 用户消息气泡里——手机端用户看到长 URL 与内部 UUID 既不友好又有隐私风险（OSS
   * 预签名 URL 在过期前可被任何人下载）。v1.1 只保留文件名 + mime，让 Agent 自
   * 然转述"我看到你上传了一个 X 文件，但目前无法读取内容"即可；如确需 file_id
   * 给 Agent 调 parse_document 重读，应在专门的失败 errorClass 文案里显式标记
   * （见 `formatUserFacingLocalError`），不在通用兜底路径泄漏。
   */
  private fallbackAttachmentText(
    a: { filename?: string; mime_type?: string; size?: number; url?: string; file_id?: string },
  ): string {
    return formatFallbackAttachmentText(a);
  }

  // ─── LH2-D 系列：账号 / 租户分桶的 sync 资源管理 ────────────────────

  /**
   * 解析当前请求的 owner（与 ElectronAgentHost.resolveOwner 同构）。
   *
   * Daemon 的 owner 来源（按优先级）：
   *   1. request.userId（多租户 Daemon 预留；当前 Django 端不传）
   *   2. config.user_id（install token 一次性写入，Daemon 单 owner 主线）
   *   3. 抛错（强制运维走 `init --token --force` 写入新 token）
   *
   * organizationId 恒来自 config.organization_id（init 时写入；运行期不变）。
   * agentId 来自当次 query 的 agentId 参数。
   */
  private resolveOwner(agentId?: string, userIdOverride?: string): PersistedEntryOwner {
    const userId = userIdOverride ?? this.config.user_id;
    if (!userId) {
      throw new Error(
        'Cannot resolve owner.userId: DaemonConfig.user_id is missing — please rerun ' +
          '`tabtin-daemon init --token <token> --force` with a token containing user_id (LH2-D3)',
      );
    }
    const organizationId = this.config.organization_id;
    if (!organizationId) {
      throw new Error(
        'Cannot resolve owner.organizationId: DaemonConfig.organization_id is missing (LH2-D3)',
      );
    }
    return {
      userId,
      organizationId,
      ...(agentId ? { agentId } : {}),
    };
  }

  /**
   * 把 owner 转成 Map key（与路径无关——路径走 buildSyncAccountDir SSoT）。
   *
   * 与 `executionOwnerScopeId` **完全同源**——query lifecycleScopeId /
   * runtimeFactory / EOL / coordinator quiesceScope 全都消费同一格式，
   * 避免在多处重复字面量拼接导致格式漂移。
   */
  private ownerKey(owner: { userId: string; organizationId: string; agentId?: string }): string {
    return executionOwnerScopeId(owner);
  }

  // ─── 终端假运行根治 Layer 1：relay 持久化重试（owner 分桶 + 独立命名空间） ──

  /**
   * Daemon 的 owner（best-effort）：config.{user_id, organization_id}。缺失返回
   * undefined（不抛——relay 失败兜底路径不应因 owner 缺失而崩）。
   */
  private resolveOwnerBestEffort(): PersistedEntryOwner | undefined {
    const userId = this.config.user_id;
    const organizationId = this.config.organization_id;
    if (!userId || !organizationId) return undefined;
    return { userId, organizationId };
  }

  /**
   * 迭代当前活跃 session 的 relay 存储视图。RelaySessionOrchestrator 用它做批量
   * backfill；与 Electron 端 `iterateRelaySessionStorageViews` 完全对称。
   */
  private *iterateRelaySessionStorageViews(): Iterable<RelaySessionStorageView> {
    for (const [sessionId, session] of this.sessions) {
      yield relaySessionStorageViewOf(sessionId, session);
    }
  }

  /**
   * 方案 A：本地 session → MySQL relay 回补（薄委托到 RelaySessionOrchestrator）。
   * WS 重连 / 启动后对内存中活跃 session 批量执行；单 session 失败不阻断其它；
   * SingleFlight 防重入均由 orchestrator 保证。
   */
  private reconcileAllSessionsRelayBackfill(): Promise<void> {
    return this.relayOrchestrator.reconcileAllSessions();
  }

  /**
   * 对比本地 events.jsonl / messages.jsonl 与服务端 ChatMessage，重放缺失的
   * user / persist_message relay 事件（幂等 upsert）。薄委托到 RelaySessionOrchestrator。
   */
  private async reconcileSessionRelayBackfill(
    session: DaemonHostState,
    relaySessionId: string,
  ): Promise<void> {
    await this.relayOrchestrator.reconcileOne(
      relaySessionStorageViewOf(session.sessionId, session),
      relaySessionId,
    );
  }

  // ─── 终端假运行根治 Layer 2：真相源落盘 + 启动对账（治 F9 / 崩溃兜底） ──

  /**
   * 取（或懒创建）owner 桶的 ManagedTask 落盘队列。独立文件 `managed-tasks.jsonl`
   * （绝不复用 relay-pending / sync pending）。关闭持久化 → undefined（退化纯内存）。
   */
  private getManagedTaskQueue(owner: PersistedEntryOwner) {
    return this.persistenceSupervisor.getManagedTaskQueue(owner);
  }

  /**
   * Layer 2 落盘端口（治 F9）：注入 `ManagedTaskStore`，spawn 即落盘 running record、
   * updateOnExit terminal 后删盘。all best-effort fire-and-forget。无 owner → 跳过落盘。
   */
  private buildManagedTaskPersistence() {
    return this.persistenceSupervisor.buildManagedTaskPersistence();
  }

  /**
   * Layer 2 接线（治 F9）：daemon start() 时①注入落盘端口到 bridge 的 ManagedTaskStore，
   * ②跑一次启动对账。bridge 时序先于 host.start()（daemon.ts setPtyManagerBridge）。
   * best-effort（拿不到 bridge / store 不阻断 start）。
   */
  private setupLayer2ManagedTaskReconcile(): void {
    if (!this.syncPersistenceEnabled || !this.syncRoot) return;
    let store: ManagedTaskStore | undefined;
    try {
      const bridge = this.getPtyManagerBridge();
      if (!bridge) throw new Error('terminal runtime unavailable');
      store = bridge.getManagedTaskStore();
    } catch {
      store = undefined;
    }
    if (store) {
      store.setManagedTaskPersistence(this.buildManagedTaskPersistence());
    } else {
      this.logger.warn(
        '[DaemonAgentHost] [Layer2] ManagedTaskStore unavailable at start; persistence not injected (crash recovery degraded)',
      );
    }
    void this.reconcileManagedTasksOnStartup();
  }

  /**
   * 启动对账（治 F9）：**仅当前 config owner 桶**——与 `recoverAllRelayRetryQueues`
   * 同款跨账号约束（daemon `gateway.relayEvents` 恒用 `config.organization_id` 发送，对账
   * 历史账号桶会把旧账号终态以新账号身份发出 → 跨账号泄漏）。历史桶留盘等 TTL。
   */
  private async reconcileManagedTasksOnStartup(): Promise<void> {
    if (!this.persistenceSupervisor.claimStartupReconcile()) return;
    if (!this.syncPersistenceEnabled || !this.syncRoot) return;

    const owner = this.resolveOwnerBestEffort();
    if (!owner) return;
    const q = this.getManagedTaskQueue(owner);
    if (!q) return;

    const records: ManagedTaskReconcileRecord[] = [];
    try {
      const entries = await q.loadAll();
      for (const entry of entries) {
        const r = entry.payload;
        if (!r || r.status !== 'running') continue;
        records.push(r);
      }
    } catch (err) {
      this.logger.warn(
        `[DaemonAgentHost] [Layer2] load managed-tasks failed owner=${owner.userId}/${owner.organizationId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (records.length === 0) return;
    this.logger.info(
      `[DaemonAgentHost] [Layer2] startup reconcile: ${records.length} running record(s) left by previous (crashed) session`,
    );
    // fire-and-forget：仍在跑的命令会一直轮询到结束才回写，不能 await 阻塞。
    void reconcileManagedTasks(records, this.buildManagedTaskReconcileDeps());
  }

  /**
   * 构造 Layer 2 对账纯核心的依赖：探活 / 读 sidecar / output_file 探测走 terminal-core
   * 共享默认实现（两端不再各自重复），host 只注入 Wave 1 relay 回写 + 收尾 + log。
   */
  private buildManagedTaskReconcileDeps(): ManagedTaskReconcileDeps {
    return {
      relayTerminalState: (record, terminal) => this.relayReconciledTerminalState(record, terminal),
      finalizeCleanup: (record) => this.cleanupReconciledManagedTask(record),
      log: {
        info: (m) => this.logger.info(`[DaemonAgentHost] ${m}`),
        warn: (m) => this.logger.warn(`[DaemonAgentHost] ${m}`),
      },
    };
  }

  /** Layer 2：对账判定的终态走 Wave 1 outbox 回写（复用 relayEventsWithRetry，治 F9）。 */
  private async relayReconciledTerminalState(
    record: ManagedTaskReconcileRecord,
    terminal: ReconcileTerminalState,
  ): Promise<void> {
    if (!record.threadId) {
      this.logger.warn(
        `[DaemonAgentHost] [Layer2] record ${record.session_id.slice(0, 8)}… has no threadId; terminal state not relayed`,
      );
      return;
    }
    const events = buildBackgroundTaskTerminalResult({
      threadId: record.threadId,
      input: {
        agent_session_id: record.session_id,
        tool_use_id: record.toolUseId,
        command: record.command,
        exit_code: terminal.exit_code,
        exited_by: terminal.exited_by,
        killed_reason: terminal.killed_reason,
        status: terminal.status,
        duration_ms: terminal.duration_ms,
        output_file_path: record.output_file_path,
        cwd: record.cwd,
      },
    });
    if (!events) return;
    await this.relayPersistence.send(record.owner, record.threadId, events);
  }

  /** Layer 2 对账收尾：从盘上删 record（防重复对账）+ 清 sidecar。best-effort。 */
  private async cleanupReconciledManagedTask(record: ManagedTaskReconcileRecord): Promise<void> {
    if (record.owner) {
      const q = this.getManagedTaskQueue(record.owner);
      if (q) {
        try {
          await q.remove(record.session_id);
        } catch {
          /* best effort：下次启动幂等重投（client_event_id 去重）无副作用 */
        }
      }
    }
    if (record.statusfile_path) {
      try {
        await fsPromises.unlink(record.statusfile_path);
      } catch {
        /* best effort：sidecar 可能已被 GC / 不存在 */
      }
    }
  }

  /**
   * 退出 flush（终端假运行根治 v3 路线 A / F-EXIT；A2 Daemon 对称实现）。
   *
   * **守 AGENTS.md "Daemon 必须可用"铁律**：systemd SIGTERM 优雅重启时，若不在退出前
   * flush，被杀命令的终态既不投递也不落盘 → 远程 / headless 用户重开永久转圈（Layer 2
   * 又没做接不住）。本方法枚举 running record → 封 app_exit + markNotified → 杀整组
   * SIGTERM → 同步 relay 带超时 → 失败落盘，与 Electron 复用同一份共享纯核心。
   *
   * **关键顺序（daemon.ts shutdown 调用方负责）**：必须在 `localAgentHost.stop()`
   * （解绑 NotificationQueue 订阅 + dispose relayRetryQueues）**之前**调用——否则等
   * bridge.dispose 杀进程触发终态时，订阅已解绑、队列已 disposed → 终态直接丢。
   *
   * Daemon 子进程 `detached:false`，杀整组 `kill(-pid)` 会 ESRCH 退化为单进程
   * （killProcessGroupSafe 内 catch 回退），OS / systemd control-group 兜底子孙——
   * 重点是**终态必须投出去或落盘**。best-effort：失败不抛（不阻断 systemd shutdown）。
   */
  async flushRunningBackgroundTasksOnExit(): Promise<void> {
    let store: ExitFlushStore | undefined;
    try {
      const bridge = this.getPtyManagerBridge();
      if (!bridge) return;
      store = bridge.getManagedTaskStore();
    } catch {
      return;
    }
    if (!store) return;

    await runBackgroundTaskExitFlush({
      store,
      killProcessGroup: (pid, signal) => this.killProcessGroupSafe(pid, signal),
      relayWithRetry: (owner, threadId, events, opts) =>
        this.relayPersistence.send(owner, threadId, events, opts),
      log: {
        info: (m) => this.logger.info(`[DaemonAgentHost] ${m}`),
        warn: (m) => this.logger.warn(`[DaemonAgentHost] ${m}`),
      },
      hostLabel: 'daemon',
    });
  }

  /**
   * 杀整组：POSIX 委托共享纯核心（`kill(-pid)`，detached:false → ESRCH 回退单进程）；
   *  Windows 走 `taskkill /T` 树杀（POSIX 进程组语义在 Win 无效）。
   */
  private killProcessGroupSafe(pid: number | undefined, signal: NodeJS.Signals): void {
    if (process.platform === 'win32') {
      killProcessTreeByPid(pid, signal);
      return;
    }
    killProcessGroupSafeCore((p, s) => process.kill(p, s), pid, signal);
  }

  /**
   * LH2-D2：Daemon 切账号（`tabtin-daemon init --force`）时清对应 owner sync 目录。
   *
   * Daemon 没有 IPC 概念；本方法暴露为 public，由 daemon.ts / CLI 在 `init`
   * 流程中显式调用（旧 owner 提取自 config.user_id + organization_id）。流程与
   * Electron `resetAccountSync` 一致：
   *   1. abort + dispose 该 owner 的所有 session relay/outbox 资源；
   *   2. dispose owner 桶 PersistentQueue；
   *   3. fs 删除 `<syncRoot>/<userId>/<organizationId>/`。
   *
   * 严格按 owner 匹配——多租户 Daemon 场景下不影响其他 owner 的目录。
   *
   * **并发互斥**：与 Electron 同构，reset 期间锁住 owner，防止
   * `getOrCreatePersistentQueueForOwner` 并发创建新桶。
   *
   * **错误可见性**：所有 best-effort 步骤失败统一打 logger.warn 不再静默。
   */
  async resetAccountSync(
    owner: { userId: string; organizationId: string },
  ): Promise<{ clearedFiles: boolean }> {
    return this.persistenceSupervisor.runOwnerReset(owner, async () => {
      this.logger.info(
        `[DaemonAgentHost] reset-account-sync owner=${owner.userId}/${owner.organizationId}`,
      );
      if (!this.sharedHost) {
        throw new Error('[DaemonAgentHost] AgentHost is not started; reset-account-sync unavailable');
      }
      // EOL 统一编排（与 Electron 同构）：quiesce (supervisor + runtimeFactory)
      // → interrupt → waitForScopeIdle → teardown 每个 session →
      // disposeOwnerResources。手写编排（quiesceScope / abort / cancelDelivery /
      // sessionStorage.dispose / removeFileHistory / relayPersistence.disposeOwner
      // / clearSyncAccountDir）已全部迁到 buildOwnerAdapter。
      await this.sharedHost.disposeExecutionOwner(owner);
      return { clearedFiles: this.persistenceSupervisor.consumeClearedFiles(owner) };
    });
  }

  /** reset 流程内 best-effort 步骤失败时统一日志。 */
  private warnResetStep(
    step: string,
    sessionId: string | undefined,
    owner: { userId: string; organizationId: string },
    err: unknown,
  ): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger.warn(
      `[DaemonAgentHost] reset-account-sync step=${step} sid=${sessionId ?? '-'} owner=${owner.userId}/${owner.organizationId}: ${msg}`,
    );
  }

  // ─── Runtime lifecycle → DaemonRuntimeAssembly（装配知识已迁出本外壳文件） ───

  /** W7c · Stage 4 Daemon 路径对齐：手动失效 CLI 参考缓存（测试 / CLI 升级后用）。 */
  invalidateCLIReferenceCache(): void {
    this.runtimeAssembly.invalidateCLIReferenceCache();
  }

  /**
   * M1.4 / v0.2 per-Organization · Wave 2：手动失效 USER 画像缓存（与 Electron 同构 API）。
   * 缓存实体已迁入 DaemonRuntimeAssembly，这里保留公共入口做委托。
   */
  invalidateUserPortraitCache(organizationId?: string): void {
    this.runtimeAssembly.invalidateUserPortraitCache(organizationId);
  }

  /** L16 W5.5 / L31：测试用——清空 commands 缓存让下一次调用强制重新拉取。 */
  invalidateCliRiskMapCache(): void {
    this.runtimeAssembly.invalidateCliRiskMapCache();
  }

}
