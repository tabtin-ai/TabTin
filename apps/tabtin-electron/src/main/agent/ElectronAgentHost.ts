import {
  ipcMain,
  app,
  BrowserWindow,
  type IpcMainInvokeEvent,
} from 'electron'
import {
  buildAttachmentMessageBlocks,
  extractAbortIdentityCandidates,
  decodeForwardRequestDetailed,
  normalizeConversationId,
  resolveConversationAbortKeys,
  resolveConversationStateKeys,
  rememberAttributionFromPersistEvent,
  hydrateMessageSenderAttributions,
  resolveMessageSenderAttribution,
} from '@tabtin/agent-host/conversation'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerAgentStorageBuckets } from './platform/agent-storage-buckets.js'
import { buildRunErrorLogContext } from './run-error-log-context.js'
import {
  safeReadFile,
  isOSAccessError,
  toToolError,
  type OSToolError,
} from '@tabtin/safe-fs'
import {
  AgentHost,
  ApprovalGate,
  ConversationRunCancelledError,
  HostTrackerScheduler,
  MessageDeliveryOutbox,
  createApprovalGate,
} from '@tabtin/agent-host'
import type {
  AgentOwnerAdapter,
  HostQuery,
  HostTriggerSource,
} from '@tabtin/agent-host'
import type {
  RuntimeResourceFactory,
  RuntimeDisabledAppsExtraKey,
} from '@tabtin/agent-host/runtime'
import {
  buildRelayRequestPayload,
  FileLlmSnapshotLedgerDirectory,
  postLlmSnapshotHttp,
  resolveLlmSnapshotLedgerDir,
  type DeliveryTransportPort,
  type DeliveryDurableLayer,
  type LocalStreamPort,
  type RelayDeliveryMetadata,
} from '@tabtin/agent-host/delivery'
import type {
  ForwardConversationRequest,
  QueryTurnDataPort,
  QueryTurnSessionView,
} from '@tabtin/agent-host/conversation'

import type {
  Message,
  ModelCatalogEntry,
  StreamEvent,
} from '@tabtin/agent-runtime/engine'
//  批次 13：engine barrel 收敛为 engine-only。非 engine 目录的符号
// （runtime 组装根 / session / subagent / providers / telemetry / agent-modes /
// permissions / host / terminal / capability injectors）改从包入口
// `@tabtin/agent-runtime` import。
import {
  SessionStorage,
  reconstructMessagesFromTranscriptEntries,
  //  message block 权威：block 记录 → UI 冷启动读取形态。
  blockRecordsToTranscriptMessages,
  FilePersistentQueue,
  // 终端"假运行"根治 Layer 1：两端 host 共享的可靠投递 + 退出 flush 纯核心。
  killProcessGroupSafe as killProcessGroupSafeCore,
  runBackgroundTaskExitFlush,
  cancelSubagent,
  EventEmitter,
  RuntimeLifecycleEvent,
  MessagePersistedEvent,
  AgentError,
  TelemetryEvents,
  emitTelemetryEvent,
  buildSyncAccountDir,
  clearSyncAccountDir,
  listSyncAccountOwners,
  ownersMatch,
  ToolLogWriter,
  cleanupOldToolLogs,
  toolOutputToString,
  resolveWorkspaceSessionArchiveDir,
  resolveWorkspaceToolLogsDir,
  forkLocalSessionArchive,
  // ：新布局 skills / 会话归档落盘 helper（{dataRoot}/users/{userId}/…）；
  // 旧 resolveSpaceSkillDir 在本文件内 skills 场景已全部替换，移除避免死引用。
  resolveOrganizationSkillDir,
  resolveUserSkillDir,
  resolveUserRoot,
  setHumanInteractionHooks,
  reapOrphanedSubagentRuns,
} from '@tabtin/agent-runtime'
import {
  correlateSourceClientEvent,
  formatProactiveReportMessage,
  assertRelayAck,
  resolveRelaySessionIdForReconcile,
  NotificationIdleDrain,
  RelaySessionOrchestrator,
  SessionPauseController,
  findAttachmentsMissingResourceIdentity,
  formatAttachmentResourceMetadata,
  formatFallbackAttachmentText,
  resolveFileAttachmentsShell,
  buildMediaImageArtifactEvents,
  type NotificationDrainContext,
  type PendingSubtaskInfo,
  type RelaySessionStorageView,
} from '@tabtin/agent-host/delivery'
import {
  executionOwnerScopeId,
  resolveRuntimeModeAgainstSticky,
} from '@tabtin/agent-host/runtime'
import {
  applyAuthoritativeSecurityMutate,
  type QueryPipelineSession,
} from '@tabtin/agent-host/conversation'
import type { AgentStreamEnvelope } from '@tabtin/agent-host/realtime'
import type { HostTurnStateSnapshot } from '@tabtin/agent-host/policy'
import type { AgentModeName } from '@tabtin/agent-modes'
import type { ReconstructedTranscriptMessage } from '@tabtin/agent-runtime'
import {
  executeTool,
  classifyError,
  isReportableRunError,
  isToolLifecycleNotice,
} from '@tabtin/agent-runtime/engine'
import type { PersistedEntryOwner } from '@tabtin/agent-runtime'
import { electronHostRuntimeOptions } from '@tabtin/agent-host/configuration'
const { resolveSyncPersistence } = electronHostRuntimeOptions
import type { TelemetryEventName } from '@tabtin/agent-runtime'
import type { AppContext } from '@tabtin/agent-host/hooks'
import type {
  CodeWorktreeAgentContext,
  CodeWorktreeController,
} from '@tabtin/cli-routes'
import { TokenManager } from '../auth.js'
import { API_BASE_URL } from '../config/api.js'
import { joinApiPath } from '@tabtin/config'
import { deriveApprovalMode } from '@tabtin/security-policy'
import {
  getCLIOrganizationRoot,
  getCLISpaceId,
  getCLIOrganizationId,
  syncCLISpaceContextFromQueryRequest,
  setCLIOrganizationRootIfMissing,
  setCLIWorkspaceScopeKey,
  getCLIWorkspaceScopeKey,
  onCLISpaceContextChanged,
  CLIWorkspaceScopeTurnLeaseManager,
} from '../cli/cli-server.js'
import { createLogger } from '../logger.js'
import { captureRunError } from '../sentry.js'
import {
  clearAllBrowserTabControl,
  clearUserControlBySession,
  unlockBySession,
} from '../browser-tab-lock/browserTabInputLock'
import {
  DEFAULT_MAX_LOCAL_FILE_SIZE_MB,
  FilePipelineErrorCode,
  formatFilePipelineErrorChinesePrompt,
  isFilePipelineErrorCode,
} from '../services/localDocParse.js'
import { getResourceDownloadService } from '../services/ResourceDownloadService.js'
import {
  LLM_IMAGE_DATA_URL_MAX_BYTES,
  nodeBufferToAgentDataUrl,
} from '../../shared/llm-image-url.js'
import { rewriteUnreachableImageUrlsInMessages } from './conversation/llm-image-message-rewriter.js'
import {
  SESSION_CODE_ROOT_CHANGED_CHANNEL,
  type SessionCodeRootChangedEvent,
} from '../../shared/session-code-root-events.js'
import { projectHistoricalFileBlocksAsResources } from './conversation/llm-file-message-projector.js'
import { enrichHandoffTranscript } from './conversation/handoff-transcript-enricher.js'
import {
  assembleHostPromptContext,
  resolveHostContextBlocks,
  filterHostPromptContextBlocks,
} from './assemble-host-prompt.js'
import { resolveComposerPresetSkillInvoke } from './composer-preset-prompt.js'
import {
  bindHostStateReconciler,
  bindHostTurnStore,
  loadHostTurnBundle,
  clearHostTurnBundleCache,
  assertHostTurnAgentResolved,
} from './host-turn-bundle.js'
import {
  createStateRoot,
  SkillsStore,
  type ApprovalGrantName,
  type StateRoot,
} from '@tabtin/agent-host'
import { bindAttributionStore, modelCatalogScopeKey } from '@tabtin/agent-host/state'
import {
  bindCatalogStore,
  warmCliCommandsMaterialized,
} from './capabilities/cli-commands-materializer.js'
// W4 (2026-05-13)：持久通道改造——不再直接 import parseLocalAttachment，改走
// `@tabtin/file-pipeline` 的 `FileResolver`。channel 只决定策略 + 装配 prompt。
import {
  createDefaultFileResolver,
  type FileResolver,
} from '@tabtin/file-pipeline'
import { runDocParserTask } from '../workers/doc-parser-runner.js'
// errorClassToFallback 是 local-docparse 内部 helper —— W4 沿用（PDF/DOCX/XLSX
// 各 errorClass 的"是否值得切云端" 业务规则在 worker 层定义，channel 复用即可）。
import {
  errorClassToFallback,
  assessCloudSummaryQuality,
} from '@tabtin/local-docparse'

// W4 lazy singleton：Electron 主进程共享一个 FileResolver 实例（无状态）。
let _electronFileResolver: FileResolver | null = null
function getElectronFileResolver(): FileResolver {
  if (!_electronFileResolver) _electronFileResolver = createDefaultFileResolver()
  return _electronFileResolver
}
import { findArchiveByOpenedSessionId } from '../agent-import/archive-store.js'
import { guardedHandle } from '../utils/guarded-handle.js'
import { registerSurfaceAsIpc } from '../wire/register-surface-as-ipc.js'
import { getDefaultPathAccessChecker, setRendererWorkspaceProviders } from '../security/path-access-checker.js'
import { createWorkspaceBoundary } from './policy/workspace-boundary.js'
import {
  createSessionCodeRootBindingStore,
  type BindSessionCodeRootResult,
  type BindingScope,
} from './session-code-root-binding.js'
import { AgentWorktreeTransitionQueue } from './agent-worktree-transition.js'
import { buildAgentWorktreeLifecycleHook } from './agent-worktree-lifecycle-hook.js'
import {
  AgentCodeWorktreeController,
  type TrustedAgentWorktreeRun,
} from './agent-code-worktree-controller.js'
import {
  buildAgentWorktreeContinuation,
  type AgentWorktreeContinuationResult,
  type AgentWorktreeContinuationTransition,
} from './agent-worktree-continuation.js'
import {
  registerWorktreeRemoveRuntimeProbe,
  unregisterWorktreeRemoveRuntimeProbe,
} from '../git/worktree-remove-runtime-probe.js'
import { createAgentSecuritySurfaces } from '@tabtin/cli-server-core/surfaces/agent-security'
import { createSkillListSurface } from '@tabtin/cli-server-core/surfaces/skill-list'
import { createSkillMaterializeAppSurface } from '@tabtin/cli-server-core/surfaces/skill-materialize-app'
import { createSkillReadContentSurface } from '@tabtin/cli-server-core/surfaces/skill-read-content'
import { createSkillWriteContentSurface } from '@tabtin/cli-server-core/surfaces/skill-write-content'
import { createSkillResolvePathSurface } from '@tabtin/cli-server-core/surfaces/skill-resolve-path'
import { isValidSkillKey } from '@tabtin/agent-host/skills'
import { installNpmSkill } from '../cli/routes/skill-import-npm.js'
import { getCLISkillsInteropAdder } from '../cli/cli-context.js'
import {
  createAgentEngineSurfaces,
  type AgentEngineCompactSessionInput,
  type AgentEngineCompactSessionOutput,
  type AgentEngineGetStateOutput,
} from '@tabtin/cli-server-core/surfaces/agent-engine'
import { electronWsGateway } from '../ws/ElectronWsGateway.js'
import { electronAgentTransport } from './platform/electron-agent-transport.js'
import { HostStateSync } from './host-state-sync.js'
import { currentDeviceIdentity } from './device-identity/currentDeviceIdentity.js'
import { handleDeviceFileAction } from './platform/device-file-action-bridge.js'
import { dispatchDeviceActionRequest } from '../login-relay/action-request-dispatch.js'
import { handleLoginRelayImportAction } from '../login-relay/import-handler.js'
import { handleDeviceMcpAction } from './platform/device-mcp-action-bridge.js'
import {
  clearPlatformThreadApprovals,
  isPlatformActionApproved,
  recordPlatformApproval,
  registerPlatformMemoStoreResolver,
} from '../services/platform-approval-bridge.js'
import {
  IpcStreamHost,
  type IpcStreamSender,
} from '@shared/ipc-stream'
import { resolveLocalStreamSessionId } from './resolve-local-stream-session-id.js'
// YOLO PRD v3 review M2：main 进程现拉 Django 权威 agent_config。
// 详见 ElectronAgentHost.agentConfigClient 字段注释 + agent-config-client.ts。
import { createAgentConfigClient } from './policy/agent-config-client.js'
import { clearAllActivePlansForSession } from '@tabtin/agent-runtime'
import type { SubagentModelPolicy } from '@tabtin/agent-runtime'

import {
  getOrResumeFileHistory,
  removeFileHistory,
  clearAllFileHistory,
} from '../file-history/file-history-registry.js'
import {
  previewControlDeviceFiles,
  rewindControlDeviceFiles,
} from '../file-history/control-device-file-rewind.js'
import { buildLocalFilePreviewRevision } from '@shared/file-preview-revision'
import { getDeviceFingerprint } from '../utils/deviceFingerprint.js'
import { executeDeviceSessionRewind } from './device-session-rewind.js'
import {
  finalizeLocalFileRestore,
  mergeFinalizedFileRestoreBackend,
  resolvePendingFileRestoreApply,
  type LocalFileRestoreFinalResult,
} from './rollback-file-restore-finalize.js'
import { readSubagentSessionFile } from './subagents/subagent-session-reader.js'
import {
  listSubagentRunsForSession,
  type SubagentRunSnapshot,
} from './subagents/subagent-index-reader.js'
import {
  wrapLegacyError,
  liftLegacyResult,
  type LegacyEnvelopeResult,
} from './conversation/envelope-error.js'
import { AgentActionEvents, LocalRuntimeEvents } from '@tabtin/ws-gateway-client'
import type { GatewayEnvelope } from '@tabtin/ws-gateway-client'
import {
  clearRuntimeInteractionMode,
  getRuntimeInteractionMode,
  setRuntimeInteractionMode,
} from './policy/interaction-mode-context.js'
import {
  setThreadEffectiveApprovalMode,
  clearThreadEffectiveApprovalMode,
} from './policy/approval-mode-context.js'
import {
  deriveCacheType,
  deriveReasoningHistoryPolicy,
  FALLBACK_MODEL_CAPABILITIES,
} from '@tabtin/agent-runtime/engine'
import {
  resolveSpaceWorkspaceRoot,
  isValidModelRef,
  isInTurnPushNotificationUser,
} from '@tabtin/agent-runtime'
// ShellCap 接 PtyManagerBridge — 装配点拿 bridge。
// bootstrap 顺序（agent-bridge.ts L544-548）：
//   PtyManager 就绪 → bridge-core.ts setupCoreAPIs 调 setPtyManagerBridge
//   → 此处 resolvePtyManagerBridge 拿到真实 bridge → 装配 ShellCap
import { resolvePtyManagerBridge } from '@tabtin/action-tools/runtime'
import {
  isChatAudioAttachment,
  formatChatAudioTranscriptBody,
  transcribeChatAudioAttachment,
} from '@tabtin/media-capabilities/audio'
import {
  isChatVideoAttachment,
  formatChatVideoUploadedBody,
} from '@tabtin/media-capabilities/video'
import {
  resolvePlatformDataRoot,
  resolveDataRoot,
  resolveSpacesRoot,
  SHELL_NOTIFICATION_KIND,
  resolveBackgroundTaskRelayThreadId,
  isProcessAlive,
  reconcileManagedTasks,
  killProcessTreeByPid,
  type NotificationEnvelope,
  type NotificationQueueUnsubscribe,
  type BackgroundTaskCompletedPayload,
  type ManagedTaskStore,
  type ManagedTaskOwner,
  type ManagedTaskPersistence,
  type PersistedManagedTask,
  type ManagedTaskReconcileRecord,
  type ManagedTaskReconcileDeps,
  type ReconcileTerminalState,
} from '@tabtin/terminal-core'
// W3：HITL UserInteractiveChannel 桥接 + ApprovalMemoStore（W6 v3 judge 接管后）。
// 生产链路 100% 走 `@tabtin/security-policy` `judge()` 主路径——历史 6 层
// PermissionPipeline（driver / layers / 配套接口）已整体清退。
import {
  applyCancelledByRollbackToHitl,
  buildBackgroundTaskTerminalResult,
  type InMemoryApprovalMemoStore,
} from '@tabtin/agent-runtime'
import { ModeSwitchHandler } from './policy/mode-switch-handler.js'
import { installElectronTelemetrySink } from './platform/telemetry-sink.js'
import { registerTelemetryIpcHandlers } from './platform/telemetry-ipc.js'
import { getLocalMcpService } from '../services/LocalMcpService.js'
// ：宿主启动期一次性把旧 platform-data 布局迁到新 dataRoot 布局。
import { migrateLegacyPlatformDataToDataRoot } from '@tabtin/shared'
// ：临时隐藏 skill 名单（tabvideo）由宿主注入。
import { TEMPORARILY_HIDDEN_SKILLS } from '@tabtin/agent-host/capabilities'
import {
  disposeSkillsModule,
  initSkillsModule,
  resolveDefaultInteropRoots,
  type SkillPreinstallSource,
  type SkillsModuleHandle,
} from '@tabtin/agent-host/skills'
import {
  loadEnabledPersonalPluginSkillSnapshot,
} from '@tabtin/agent-runtime/skills'
import { SkillsModuleLifecycle } from './skills-module-lifecycle.js'
import { fetchSkillEnablementMap } from './capabilities/fetch-skill-enablement-map.js'
import { RecallIndex } from '@tabtin/search'
import { getSemanticScorer } from './capabilities/semantic-scorer.js'
import {
  initProactivePoller,
  destroyProactivePoller,
  checkPendingReports,
  scanCrashedRuns,
  fetchPendingSubtaskDetails,
  markSubtaskRunsNotified,
} from './subagents/proactive-poller.js'
// ：per-session 串行执行器 + FIFO 队列（host 侧 busy/queue 唯一真相源）。
import { PromptEvents, StreamEvents, okResponse } from '@tabtin/agent-wire'
import {
  clearUserDeviceModelPreferences,
  readOrganizationDeviceModelPreferences,
  writeOrganizationDeviceModelPreferences,
  type OrganizationDeviceModelPreferences,
} from '../organization-handler.js'
import { onOpenAICodexStatusChanged } from '../llm/openai-codex-status-events.js'

const log = createLogger('AgentHost')

interface RollbackSessionTimelinePayload {
  sessionId: string
  targetMessageId: string
  targetRole?: 'user' | 'assistant'
  targetContent?: string
  targetOccurrenceIndex?: number
  mode?: 'rollback' | 'editAndResend'
  keepMessageCount?: number
  rollbackReason?: string
  previewRevision?: string
  filePreviewRevision?: string
  fileRewindAnchorId?: string
  rollbackContractVersion?: number
  acknowledgedFilePreviewReason?: string
  safetySnapshotHash?: string
  spaceId?: string
  organizationId?: string
}

interface RollbackTranscriptPayload {
  sessionId: string
  targetMessageId?: string
  targetRole?: 'user' | 'assistant'
  targetContent?: string
  targetOccurrenceIndex?: number
  mode?: 'rollback' | 'editAndResend'
  keepMessageCount?: number
  spaceId?: string
  organizationId?: string
}

type RollbackSessionTimelineResult = {
  success: boolean
  applied?: boolean
  keepMessageCount?: number | null
  backend?: unknown
  error?: string
}

function resolveDevWorkspacePath(...segments: string[]): string | undefined {
  const workspaceRoot = process.env.TABTIN_WORKSPACE_ROOT
  if (workspaceRoot) {
    const candidate = path.join(workspaceRoot, ...segments)
    return fs.existsSync(candidate) ? candidate : undefined
  }

  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, ...segments)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function resolveAppsRoot(): string | undefined {
  const logger = createLogger('resolveAppsRoot')
  if (app.isPackaged) {
    const p = path.join(process.resourcesPath, 'app.asar.unpacked', 'packages', 'apps')
    const exists = fs.existsSync(p)
    logger.info(`packaged mode: ${p} exists=${exists}`)
    return exists ? p : undefined
  }
  const found = resolveDevWorkspacePath('packages', 'apps')
  if (found) logger.info(`found at: ${found}`)
  else logger.warn('NOT FOUND after traversing dev workspace roots')
  return found
}

function resolveBundledRoot(): string | undefined {
  const logger = createLogger('resolveBundledRoot')
  if (app.isPackaged) {
    const p = path.join(process.resourcesPath, 'app.asar.unpacked', 'bundled-skills')
    const exists = fs.existsSync(p)
    logger.info(`packaged mode: ${p} exists=${exists}`)
    return exists ? p : undefined
  }
  const found = resolveDevWorkspacePath('packages', 'skills', 'bundled')
  if (found) logger.info(`found at: ${found}`)
  else logger.warn('NOT FOUND after traversing dev workspace roots')
  return found
}

function resolvePackageSkillsRoot(): string | undefined {
  const logger = createLogger('resolvePackageSkillsRoot')
  if (app.isPackaged) {
    const p = path.join(process.resourcesPath, 'app.asar.unpacked', 'package-skills')
    const exists = fs.existsSync(p)
    logger.info(`packaged mode: ${p} exists=${exists}`)
    return exists ? p : undefined
  }
  const found = resolveDevWorkspacePath('packages', 'skills')
  if (found) logger.info(`found at: ${found}`)
  else logger.warn('NOT FOUND after traversing dev workspace roots')
  return found
}

import {
  type HostState,
  type QueryRequest,
  type QueryResult,
  type ElectronSharedQuery,
  type StreamEventSink,
  type AttachmentStrategy,
  type RuntimeBuildInput,
  type RuntimeCarryForward,
  type PrewarmRuntimeInput,
  NOOP_STREAM_SINK,
  AGENT_STREAM_EVENT_CHANNEL,
  relaySessionStorageViewOf,
} from './electron-agent-types.js'
import { validateLocalExecutionTarget } from './device-identity/validateLocalExecutionTarget.js'
import { ElectronRuntimeAssembly } from './runtime/electron-runtime-assembly.js'
import { createMcpListingFetcher } from './capabilities/mcp-listing-fetcher.js'
import {
  createGatedCliListingFetcher,
  invalidateCliListingGateCache,
} from './capabilities/cli-listing-gate.js'
import {
  initHostCapabilityIdentity,
  shouldRewarmAfterCapabilityIdentityInit,
  type CapabilityIdentityInitReason,
} from './capabilities/host-capability-identity-init.js'
import {
  setSpacePrewarmHandler,
  setAgentEnablementPrewarmHandler,
  requestAgentEnablementPrewarm,
  bindPrewarmScheduler,
} from './space-prewarm.js'
import {
  createRunHostLeaseHttpApi,
  RunHostLeaseCoordinator,
} from './run-host-lease-coordinator.js'
import {
  createSessionRunRegistrationHttpApi,
  SessionRunRegistrationHttpError,
} from './session-run-registration.js'

const CLOUD_SUMMARY_WAIT_MS = 15_000
const CLOUD_SUMMARY_POLL_MS = 500

function waitForCloudSummaryPoll(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve()
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function formatDocumentNotReadyContext(
  filename: string,
  fileId: string,
  status: 'pending' | 'parsing',
): string {
  const state = status === 'parsing' ? '仍在解析' : '尚未开始解析'
  return (
    `[文档: ${filename} — ${state}，在本轮等待时间内尚未解析完成。` +
    `当前没有可供回答的文档正文，不要假装已经读过或根据文件名猜测内容。` +
    `请稍后使用 parse_document 重新读取（file_id: ${fileId}）]`
  )
}

export class ElectronAgentHost {
  private readonly workspaceBoundary = createWorkspaceBoundary()
  /**  / ：会话代码根绑定（sessionId → 已校验的 Git worktree 根目录）。 */
  private readonly sessionCodeRootBindings = createSessionCodeRootBindingStore()
  /** Agent CLI 声明切换后，等待工具结果持久化边界再提交。 */
  private readonly agentWorktreeTransitions = new AgentWorktreeTransitionQueue()
  private readonly agentWorktreeLifecycleHook = buildAgentWorktreeLifecycleHook({
    transitions: this.agentWorktreeTransitions,
  })
  private readonly agentCodeWorktreeController: CodeWorktreeController =
    new AgentCodeWorktreeController({
      resolveTrustedRun: (context) => this.resolveTrustedAgentWorktreeRun(context),
      authorizePath: (run, targetPath) => this.authorizeAgentWorktreePath(run, targetPath),
      transitions: this.agentWorktreeTransitions,
    })
  /** pause 事件可能先于本机会话 runtime 创建到达；暂存候选 ID，创建时补应用。 */
  private readonly pendingPauseCandidateIds = new Set<string>()
  /**
   * 用户点停止时 sessions Map / activeRuns 可能尚未登记（pre-stream）。
   * 记下归一化 conversationId，等 afterSessionReady / consumeRuntime 开跑前兑现。
   */
  private readonly abortRequestedSessionIds = new Set<string>()
  /**
   * Browser takeover 独占的 HITL park ownership。
   * 保存 controller 与 aliases，确保 session 从共享 Map 删除后仍可精确释放本引用。
   */
  private readonly browserControlOwnershipBySessionKey = new Map<string, {
    sessionKey: string
    controller: SessionPauseController
    aliases: Set<string>
  }>()
  /**
   * Host promote 后发出的 chat.cancel 会 WS 回环到本机 handleAbort。
   * 窗口内跳过 clearQueued / 再 abort，避免掐掉刚 promote 的排队或新 run。
   */
  private readonly promoteCancelEchoGuardUntil = new Map<string, number>()
  private static readonly PROMOTE_CANCEL_ECHO_GUARD_MS = 5_000
  private get sessions() {
    return this.requireSharedHost().sessions
  }

  private markAbortRequested(sessionId: string): void {
    if (!sessionId) return
    this.abortRequestedSessionIds.add(normalizeConversationId(sessionId))
  }

  /** 若该会话仍有未兑现的停止意图则消费并返回 true。 */
  private consumeAbortRequest(...candidateIds: Array<string | undefined | null>): boolean {
    let hit = false
    for (const raw of candidateIds) {
      if (!raw) continue
      const key = normalizeConversationId(raw)
      if (!this.abortRequestedSessionIds.has(key)) continue
      this.abortRequestedSessionIds.delete(key)
      hit = true
    }
    return hit
  }

  private getBrowserControlMatchingKeys(sessionId: string): {
    requestedSessionId: string
    matchingKeys: Set<string>
  } {
    const requestedSessionId = normalizeConversationId(sessionId)
    const matchingKeys = new Set(resolveConversationAbortKeys(
      requestedSessionId,
      [...this.sessions.values()].map((session) => ({
        key: session.sessionId,
        businessThreadId: session.businessThreadId,
      })),
    ))
    for (const ownership of this.browserControlOwnershipBySessionKey.values()) {
      if (ownership.aliases.has(requestedSessionId)) matchingKeys.add(ownership.sessionKey)
    }
    return { requestedSessionId, matchingKeys }
  }

  private resolveBrowserControlTarget(sessionId: string): {
    requestedSessionId: string
    sessionKey: string
    session: HostState | undefined
    ownership: {
      sessionKey: string
      controller: SessionPauseController
      aliases: Set<string>
    } | undefined
  } | undefined {
    const { requestedSessionId, matchingKeys } =
      this.getBrowserControlMatchingKeys(sessionId)

    if (matchingKeys.size !== 1) {
      if (matchingKeys.size > 1) {
        log.warn('[BrowserControl] alias matched multiple sessions; operation rejected', {
          matchingKeyCount: matchingKeys.size,
        })
      }
      return undefined
    }

    const sessionKey = matchingKeys.values().next().value
    if (typeof sessionKey !== 'string') return undefined
    return {
      requestedSessionId,
      sessionKey,
      session: this.sessions.get(sessionKey),
      ownership: this.browserControlOwnershipBySessionKey.get(sessionKey),
    }
  }

  private buildBrowserControlAliases(
    requestedSessionId: string,
    sessionKey: string,
    businessThreadId?: string,
  ): Set<string> {
    const aliases = new Set([
      normalizeConversationId(requestedSessionId),
      normalizeConversationId(sessionKey),
    ])
    if (businessThreadId) aliases.add(normalizeConversationId(businessThreadId))
    return aliases
  }

  private ensureBrowserControlParkForKey(sessionKey: string): void {
    const ownership = this.browserControlOwnershipBySessionKey.get(sessionKey)
    if (!ownership) return
    const currentSession = this.sessions.get(sessionKey)
    if (
      currentSession
      && ownership.controller !== currentSession.pauseController
    ) {
      this.browserControlOwnershipBySessionKey.delete(sessionKey)
      try {
        ownership.controller.releaseHitlPark()
      } catch {
        this.browserControlOwnershipBySessionKey.set(sessionKey, ownership)
        log.error('[BrowserControl] failed to release stale session controller')
        return
      }
      try {
        currentSession.pauseController.acquireHitlPark()
        this.browserControlOwnershipBySessionKey.set(sessionKey, {
          sessionKey,
          controller: currentSession.pauseController,
          aliases: new Set([
            ...ownership.aliases,
            ...this.buildBrowserControlAliases(
              sessionKey,
              sessionKey,
              currentSession.businessThreadId,
            ),
          ]),
        })
        log.warn('[BrowserControl] migrated ownership to rebuilt session controller')
      } catch {
        log.error('[BrowserControl] failed to park rebuilt session controller')
      }
      return
    }
    if (ownership.controller.isHitlParked) return
    try {
      ownership.controller.acquireHitlPark()
      log.warn('[BrowserControl] restored missing park after generic resume')
    } catch {
      log.error('[BrowserControl] failed to restore park after generic resume')
    }
  }

  parkBrowserControl(sessionIds: readonly string[]): string[] {
    const parked: string[] = []
    const visitedSessionKeys = new Set<string>()
    for (const requestedSessionId of new Set(sessionIds.map(normalizeConversationId))) {
      const target = this.resolveBrowserControlTarget(requestedSessionId)
      if (!target || visitedSessionKeys.has(target.sessionKey)) continue
      visitedSessionKeys.add(target.sessionKey)

      let ownership = target.ownership
      if (
        ownership
        && target.session
        && ownership.controller !== target.session.pauseController
      ) {
        const staleOwnership = ownership
        this.browserControlOwnershipBySessionKey.delete(target.sessionKey)
        try {
          staleOwnership.controller.releaseHitlPark()
          ownership = undefined
          log.warn('[BrowserControl] migrated ownership to rebuilt session controller')
        } catch {
          this.browserControlOwnershipBySessionKey.set(target.sessionKey, staleOwnership)
          log.error('[BrowserControl] failed to release stale session controller')
          continue
        }
      }

      if (ownership) {
        this.ensureBrowserControlParkForKey(target.sessionKey)
        continue
      }
      if (!target.session) continue

      try {
        target.session.pauseController.acquireHitlPark()
        this.browserControlOwnershipBySessionKey.set(target.sessionKey, {
          sessionKey: target.sessionKey,
          controller: target.session.pauseController,
          aliases: this.buildBrowserControlAliases(
            target.requestedSessionId,
            target.sessionKey,
            target.session.businessThreadId,
          ),
        })
        parked.push(target.requestedSessionId)
      } catch {
        log.error('[BrowserControl] failed to acquire park')
      }
    }
    return parked
  }

  releaseBrowserControl(sessionIds: readonly string[]): string[] {
    const released: string[] = []
    const visitedSessionKeys = new Set<string>()
    for (const requestedSessionId of new Set(sessionIds.map(normalizeConversationId))) {
      const target = this.resolveBrowserControlTarget(requestedSessionId)
      if (!target || visitedSessionKeys.has(target.sessionKey) || !target.ownership) continue
      visitedSessionKeys.add(target.sessionKey)

      this.browserControlOwnershipBySessionKey.delete(target.sessionKey)
      try {
        target.ownership.controller.releaseHitlPark()
        released.push(target.requestedSessionId)
      } catch (error) {
        this.browserControlOwnershipBySessionKey.set(target.sessionKey, target.ownership)
        log.error('[BrowserControl] failed to release park')
        throw error
      }
    }
    return released
  }

  getBrowserControlOwnedSessionIds(sessionIds: readonly string[]): string[] {
    const owned: string[] = []
    for (const requestedSessionId of new Set(sessionIds.map(normalizeConversationId))) {
      const target = this.resolveBrowserControlTarget(requestedSessionId)
      if (target?.ownership) owned.push(target.requestedSessionId)
    }
    return owned
  }

  getBrowserControlStatus(sessionIds: readonly string[]): {
    ownedSessionIds: string[]
    parkedSessionIds: string[]
    unresolvedSessionIds: string[]
  } {
    const ownedSessionIds: string[] = []
    const parkedSessionIds: string[] = []
    const unresolvedSessionIds: string[] = []
    for (const sessionId of new Set(sessionIds.map(normalizeConversationId))) {
      const { requestedSessionId, matchingKeys } =
        this.getBrowserControlMatchingKeys(sessionId)
      if (matchingKeys.size === 0) continue
      if (matchingKeys.size > 1) {
        unresolvedSessionIds.push(requestedSessionId)
        log.warn('[BrowserControl] status query matched multiple sessions', {
          matchingKeyCount: matchingKeys.size,
        })
        continue
      }
      const sessionKey = matchingKeys.values().next().value
      if (typeof sessionKey !== 'string') continue
      const ownership = this.browserControlOwnershipBySessionKey.get(sessionKey)
      if (!ownership) continue
      const currentSession = this.sessions.get(sessionKey)
      if (
        currentSession
        && ownership.controller !== currentSession.pauseController
      ) {
        ownedSessionIds.push(requestedSessionId)
        log.warn('[BrowserControl] ownership points to stale session controller')
        continue
      }
      ownedSessionIds.push(requestedSessionId)
      if (ownership.controller.isHitlParked) parkedSessionIds.push(requestedSessionId)
    }
    return { ownedSessionIds, parkedSessionIds, unresolvedSessionIds }
  }

  areBrowserControlSessionsParked(sessionIds: readonly string[]): boolean {
    const requestedSessionIds = Array.from(new Set(sessionIds.map(normalizeConversationId)))
    if (requestedSessionIds.length === 0) return false
    const status = this.getBrowserControlStatus(requestedSessionIds)
    return status.unresolvedSessionIds.length === 0
      && status.parkedSessionIds.length === requestedSessionIds.length
  }

  clearBrowserControlForStoppedSession(sessionId: string): void {
    const normalizedSessionId = normalizeConversationId(sessionId)
    const aliases = new Set([normalizedSessionId])
    const session = this.sessions.get(sessionId)
    if (session?.businessThreadId) {
      aliases.add(normalizeConversationId(session.businessThreadId))
    }

    const matchingOwnerships = Array.from(
      this.browserControlOwnershipBySessionKey.values(),
    ).filter((ownership) => (
      ownership.sessionKey === sessionId
      || ownership.aliases.has(normalizedSessionId)
    ))
    for (const ownership of matchingOwnerships) {
      this.browserControlOwnershipBySessionKey.delete(ownership.sessionKey)
      for (const alias of ownership.aliases) aliases.add(alias)
      try {
        ownership.controller.releaseHitlPark()
      } catch {
        log.error('[BrowserControl] terminal park release failed')
      }
    }

    for (const alias of aliases) {
      clearUserControlBySession(alias)
      unlockBySession(alias)
    }
  }

  private clearAllBrowserControlForHostStop(): void {
    const ownerships = Array.from(this.browserControlOwnershipBySessionKey.values())
    for (const ownership of ownerships) {
      this.browserControlOwnershipBySessionKey.delete(ownership.sessionKey)
      try {
        ownership.controller.releaseHitlPark()
      } catch {
        log.error('[BrowserControl] shutdown park release failed')
      }
      for (const alias of ownership.aliases) {
        clearUserControlBySession(alias)
        unlockBySession(alias)
      }
    }
    clearAllBrowserTabControl()
  }

  private armPromoteCancelEchoGuard(...candidateIds: Array<string | undefined | null>): void {
    const until = Date.now() + ElectronAgentHost.PROMOTE_CANCEL_ECHO_GUARD_MS
    for (const raw of candidateIds) {
      if (!raw) continue
      this.promoteCancelEchoGuardUntil.set(normalizeConversationId(raw), until)
    }
  }

  /** promote 触发的 cancel 回环：命中则消费 guard 并返回 true。 */
  private consumePromoteCancelEchoGuard(
    ...candidateIds: Array<string | undefined | null>
  ): boolean {
    const now = Date.now()
    let hit = false
    for (const raw of candidateIds) {
      if (!raw) continue
      const key = normalizeConversationId(raw)
      const until = this.promoteCancelEchoGuardUntil.get(key)
      if (until == null) continue
      this.promoteCancelEchoGuardUntil.delete(key)
      if (until >= now) hit = true
    }
    return hit
  }
  /**
   * Agent runtime lifecycle (create/soft/rebuild/loaders). Platform shell
   * delegates here — no createRuntime knowledge in this file.
   */
  private _runtimeAssembly: ElectronRuntimeAssembly | null = null
  private get runtimeAssembly(): ElectronRuntimeAssembly {
    if (!this._runtimeAssembly) {
      const host = this
      this._runtimeAssembly = new ElectronRuntimeAssembly({
        get sessions() { return host.sessions },
        get workspaceBoundary() { return host.workspaceBoundary },
        get sharedHost() { return host.sharedHost },
        set sharedHost(v) { host.sharedHost = v },
        get interactionRegistry() { return host.interactionRegistry },
        get skillsModule() { return host.skillsModule },
        get skillsReady() { return host.skillsReady },
        get syncPersistenceEnabled() { return host.syncPersistenceEnabled },
        set syncPersistenceEnabled(v) { host.syncPersistenceEnabled = v },
        getModelCatalogSnapshot: owner => host.getModelCatalogSnapshot(owner),
        getSubagentModelPolicy: owner => host.resolveSubagentModelPolicy(owner),
        get catalogFallbackWarned() { return host.catalogFallbackWarned },
        refreshModelCatalogAfterRuntimeFailure: (owner, failure) =>
          host.refreshModelCatalogAfterRuntimeFailure(owner, failure),
        get sessionContextTiers() { return host.sessionContextTiers },
        get sessionModelParamOverrides() { return host.sessionModelParamOverrides },
        get agentConfigClient() { return host.agentConfigClient },
        get modeSwitchHandler() { return host.modeSwitchHandler },
        broadcastApprovalMemoChangedToRenderer: (agentId) =>
          host.broadcastApprovalMemoChangedToRenderer(agentId),
        drainThreadNotificationsText: (...args: any[]) =>
          (host as any).drainThreadNotificationsText(...args),
        resolveOwner: (...args: any[]) => (host as any).resolveOwner(...args),
        get skillEnablementCache() { return host.skillEnablementCache },
        get skillsStore() { return host.stateRoot.skills },
        relaySubagentStreamEventDirect: (...args: any[]) =>
          (host as any).relaySubagentStreamEventDirect(...args),
        applyPendingPauseToSession: (sessionId, businessThreadId, pauseController) =>
          (host as any).applyPendingPauseToSession(sessionId, businessThreadId, pauseController),
        getSessionBoundCodeRoot: (sessionId) =>
          host.sessionCodeRootBindings.getRootPath(sessionId),
        agentWorktreeLifecycleHook: host.agentWorktreeLifecycleHook,
      })
    }
    return this._runtimeAssembly
  }

  /**
   * ：agent 对话流事件的**主进程唯一分发出口**。本机 runtime 各发射点（IpcStreamHost /
   * 队列信号 / 子 Agent 流 / 本地审批卡）与 WS 观察源都经它 `publish` / `broadcast` 广播给
   * session 的全部 watcher；WS 观察由它订阅后端 topic + 按 event_id 跨源去重 + seq 检测。
   * 渲染进程只订一条 channel、收到去重后的单一流，不区分来源（无来源仲裁）。
   */
  private sharedHost: AgentHost<ElectronSharedQuery, QueryResult, HostState> | null = null
  /**
   * ：在 sharedHost 就绪前即可写 turn；与 AgentHost.start({ state }) 共用同一根。
   */
  private readonly stateRoot: StateRoot = createStateRoot({
    deviceIdentity: currentDeviceIdentity.state,
    skills: new SkillsStore(
      (agentId) =>
        fetchSkillEnablementMap({
          apiBaseUrl: API_BASE_URL,
          agentId,
          getAccessToken: () => TokenManager.getAccessToken(),
        }),
      Number.POSITIVE_INFINITY,
      (error, agentId) => {
        log.warn(
          '[SkillEnablement] refresh failed agent=%s: %s',
          agentId,
          error instanceof Error ? error.message : String(error),
        )
      },
    ),
  })
  /**
   * ：平台审批唯一编排（memo + ask）。browser / terminal 等入口经
   * `requestPlatformApproval` hook 进入本 gate；前端只响应事件。
   */
  private approvalGate: ApprovalGate | null = null
  /** 已挂 'destroyed' 清理监听的 webContents id（避免重复注册）。 */
  private readonly watchedWebContentsIds = new Set<number>()
  /**
   *  发送队列下沉：per-session 串行执行器 + FIFO 队列。所有 handleQueryInternal
   * 入口（IPC handleQuery / 云端 forward / 通知 drain）统一经它提交——session 忙时
   * **入队而非拒绝**，终态自动 drain 下一条。这是 runtime 侧「session 忙 / 排队」的
   * 唯一真相源，前端不再用 isStreaming 影子判定。
   *
   * 阶段 4 起，宿主**不再**维护额外的 `runningSessions` Set 影子——忙闲派生读
   * 走 `AgentHost.isBusy` / `AgentHost.getState` 门面，避免双写漂移。
   */
  private ipcRegistered = false
  /**
   * YOLO PRD v3 review M2：每条消息从 Django 现拉权威 `agent_config`。
   *
   * 解决 reviewer-C HIGH-1 / reviewer-A A1 / reviewer-C MEDIUM-2：旧路径
   * 把 IPC payload 里 renderer 透传的 `yoloMode` 字段直接 mutate 回
   * `session.agentConfigV3.security.allow_yolo_mode`，让 renderer cache
   * 变成 gate 权威源——攻击者伪造 IPC payload 即可绕开 Settings 里的
   * Agent 级 gate 提权。
   *
   * 改造后：query 入口 await `fetchAuthoritativeAgentConfigForWorkspace`
   * 拿 Django + Workspace grant 真值；IPC payload 的 `yoloMode` 字段降级为
   * "客户端声称值"，仅用于 telemetry 对比，不再作 gate 决策依据。
   *
   * 详见 `agent-config-client.ts` 头注释。client 是 process-wide singleton
   * （内置 5s 内存 cache，按 agentId 摊销 HTTP 成本）。
   */
  private agentConfigClient = createAgentConfigClient({
    getOrganizationId: () => getCLIOrganizationId(),
  })
  /**
   * C14 (2026-05-13)：lsp-runtime singleton 初始化状态。
   *
   * 第一次创建 session（拿到 workspace root）时 init lsp-runtime + register
   * passive feedback handler。后续 session 共享同一个 singleton。
   *
   * 单例语义：lsp-runtime 是 process-wide singleton，TabTin 一个 Electron
   * 实例只会跑一份 LSP server pool。多 session 用同一个 server pool 路由。
   * 当 workspace root 切换时（如用户切到不同代码项目），通过
   * `reinitializeLspServerManager` 重建——但当前 v0.1 简化处理：第一次 init
   * 后不再切，让"已编辑过的项目"先打通端到端。后续 PR 可以加 workspace root
   * 切换时 reinit 逻辑。
   *
   * 关闭：`TABTIN_DISABLE_LSP=1` 环境变量。
   */
  /**
   * v0.4 W1.5（PRD §7.5.7）：HITL pending resolver map，名义统一。
   *
   * 同时给 ask_user / approval（v0.3a 的 review_required → v0.4 approval_requested）
   * 用，map key 是 batchId（v0.4 批量协议）或单 requestId（v0.3a 兼容）。
   *
   * 旧名 pendingAskUserRequests → 新名 interactions（与 Daemon 同构对齐）。
   *
   * Phase 3 F1 修复（2026-05-28）：升级 entry 携带 sessionId，
   * `cancelAllPendingHitlRequests({ sessionId })` 仅取消该 session 的 batch，
   * 避免跨 session 误杀其它 session 正在等审批的 HITL。
   */
  private get interactionRegistry() {
    return this.requireSharedHost().interactions.registry
  }

  /**
   * 无人值守交互档（HITL 四态）由 `interaction-mode-context` 按 host session key
   * 与业务 ChatSession thread 双写。仅 forward 路径（`handleQueryFromForward`）在
   * `interaction_mode` 非 interactive 时写入，query 结束即删。两处消费（均**实时读**
   * context，不捕获快照值，以兼容 runtime 缓存复用）：
   *   1. `waitForUserInput`：该 session 为 'scheduled' 时立即 reject → ask_user /
   *      ask_form / request_approval（ask-tools）走 catch 返回 timeout error、Agent
   *      继续，而非干等 30 分钟。
   *   2. `ElectronPermissionHandler.runtimeMode`：用本 session 的档（默认 interactive）
   *      → judge 判 ask 的工具走 0 秒 fail-fast deny（兜住 yolo 闸门没开的情况）。
   * 缺省（普通 IPC chat / 未传）→ 不在 map 中 → 一律 'interactive'，行为零变化。
   */

  /**
   * Phase 3 F5/F7/F12（2026-05-28）：mode-switch 状态机集中地。
   *
   * 承担：
   *   - 给 createSwitchModeTool 提供 proposalRegistry（dedup + 防伪）
   *   - handleModeSwitchExecute / notifyManualSwitch 的业务逻辑（cancel HITL +
   *     记录 mode transition reminder）
   *
   * 通过 lazy getter 构造，避免 `interactions` field 初始化顺序问题。
   */
  private _modeSwitchHandler: ModeSwitchHandler | null = null
  private get modeSwitchHandler(): ModeSwitchHandler {
    if (!this._modeSwitchHandler) {
      this._modeSwitchHandler = new ModeSwitchHandler({
        hitlMap: this.interactionRegistry,
        setPendingModeTransition: (sessionId, transition) => {
          const s = this.sessions.get(sessionId)
          if (s) s.pendingModeTransition = transition
        },
        // ：UI 主动切 mode 时同步 sticky（含切回 plan）。
        setModeAuthoritySticky: (sessionId, mode) => {
          const s = this.sessions.get(sessionId)
          if (s) s.modeAuthoritySticky = mode
        },
      })
    }
    return this._modeSwitchHandler
  }

  /**
   * Serializes complete reset operations for one owner.
   */
  private accountResetLocks = new Map<string, Promise<void>>()
  /**
   * 时间线重写与新 query 提交的 host 级互斥门。runQueue 只串行 query，
   * SessionStorage.applyTimelineRewind 原本不在其中；这里覆盖“query 进入队列前”
   * 到“重写整段完成”的窗口，忙中直接拒绝回退，不静默 abort 用户运行。
   */
  private readonly timelineRewriteOperationKeys = new Set<string>()
  private readonly pendingQueryOperationKeys = new Map<string, number>()
  /**
   * `clearedFiles` slot handed off from the owner adapter's
   * `disposeOwnerResources` to `resetAccountSync`. `ExecutionOwnerLifecycle`
   * itself doesn't surface adapter return values, so we stash the boolean
   * per owner and drain it in the wrapper method that IPC consumers rely
   * on (`{ clearedFiles }` in the reset-account-sync response).
   */
  private pendingClearedFilesByOwner = new Map<string, boolean>()
  private syncPersistenceEnabled = false

  /** Shared owner-bucket relay outbox; recovery is restricted to the current authenticated owner. */
  private readonly relayPersistence = new MessageDeliveryOutbox({
    isPersistenceEnabled: () => this.syncPersistenceEnabled,
    getSyncRoot: () => this.syncRoot,
    resolveOwnerBestEffort: () => this.resolveOwnerBestEffort(),
    fallbackOrganizationId: () => getCLIOrganizationId(),
    sendOnce: (organizationId, sessionId, events, metadata) =>
      this.sendRelayEventsOnce(organizationId, sessionId, events, metadata),
    sendRecoveredOnce: (owner, sessionId, events, metadata) =>
      this.sendRecoveredRelayEventsOnce(owner, sessionId, events, metadata),
    logger: {
      info: (message) => log.info(message),
      warn: (message) => log.warn(message),
    },
  })
  /**
   * 终端假运行根治 Layer 2（治 F9）：按 owner 分桶的 ManagedTask 落盘队列池。
   *
   * key = `<userId>|<organizationId>`，底层 `FilePersistentQueue` 落在 `buildSyncAccountDir`
   * 同账号目录、用**独立文件** `managed-tasks.jsonl`（绝不复用 relay-pending / sync
   * pending）。spawn 时 `ManagedTaskStore` 经注入端口写盘 running record；host 崩溃 /
   * kill -9 后启动对账（`reconcileManagedTasksOnStartup`）从这里加载残留 record。
   * 仅 `syncPersistenceEnabled` 时落盘。
   */
  private managedTaskQueues = new Map<string, FilePersistentQueue<PersistedManagedTask>>()
  /** Layer 2 启动对账只跑一次的闸门。 */
  private managedTaskReconcileStarted = false
  /** WS 重连时 recover relay 队列的解绑句柄（dispose 时调）。 */
  private relayReconnectUnsubscribe: (() => void) | null = null
  /** ：WS 重连时用 active run + lease token 向 Django 做权威对账。 */
  private runHostLeaseReconnectUnsubscribe: (() => void) | null = null
  private readonly hostTrackerScheduler = new HostTrackerScheduler({
    fetchSchedule: () => this.fetchHostTrackerSchedule(),
    fire: (trackerId) => this.fireHostTracker(trackerId),
    fetchWork: () => this.fetchHostTrackerWork(),
    executeWork: (runId) => this.executeHostTrackerRun(runId),
    reconcile: () => this.reconcileHostTrackerLifecycle(),
    logger: {
      info: (message) => log.info(message),
      warn: (message, error) => log.warn(message, error),
    },
  })
  private hostTrackerReconnectUnsubscribe: (() => void) | null = null
  /**
   * ：能力目录身份绑定。auth-changed 时与当前 userId 比对，
   * 同用户 token 刷新跳过清缓存；换用户 / 登出才 init。
   */
  private capabilityIdentityBoundUserId: string | null = null
  private capabilityIdentityAuthUnsubscribe: (() => void) | null = null
  private openAICodexStatusUnsubscribe: (() => void) | null = null
  private spaceContextCodeRootUnsubscribe: (() => void) | null = null
  /** ：串行 init，避免切组织→登出竞态把过期 warm 写回 */
  private capabilityIdentityInitChain: Promise<void> = Promise.resolve()
  private capabilityIdentityInitGeneration = 0
  /** run_id → runtime 可识别的 conversation key；仅 forward 执行期存活。 */
  private readonly forwardLeaseAbortKeys = new Map<string, string>()
  private readonly runHostId = `electron:${electronWsGateway.getDeviceId()}`.slice(0, 128)
  /**
   * ：Host lease 只覆盖携带 Django run_id 的新 forward。
   * gateway device id 由 ConfigService 持久化，是本机稳定 host instance id。
   */
  private readonly runHostLeaseCoordinator = new RunHostLeaseCoordinator(
    createRunHostLeaseHttpApi({
      apiBaseUrl: API_BASE_URL,
      getAccessToken: () => TokenManager.getAccessToken(),
    }),
    this.runHostId,
    runId => {
      const abortKey = this.forwardLeaseAbortKeys.get(runId)
      if (abortKey) this.handleAbort(abortKey)
    },
    {
      info: (message, details) => log.info(message, details),
      warn: (message, details) => log.warn(message, details),
    },
    {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: timer => clearTimeout(timer),
    },
    Math.random,
    this.stateRoot.lease,
  )
  /** Electron 本机 IPC 在执行前登记服务端权威 run；旧后端不可用时保持本地执行能力。 */
  private readonly sessionRunRegistration = createSessionRunRegistrationHttpApi({
    apiBaseUrl: API_BASE_URL,
    getAccessToken: () => TokenManager.getAccessToken(),
  })
  /**
   * relay outbox recover + 活跃 session backfill 编排（Stage 3：下沉到 agent-host）。
   * 双端 host 原先各自实现的启动 recover / 重连 recover / 单 session backfill 三段
   * 流程收拢到 `RelaySessionOrchestrator` —— SingleFlight 去重、SessionMessagesNotFoundError
   * 静默、resolveRelaySessionIdForReconcile 归一都由 helper 保证。
   */
  private readonly relayOrchestrator = new RelaySessionOrchestrator({
    outbox: this.relayPersistence,
    logger: {
      debug: (message) => log.debug(message),
      info: (message) => log.info(message),
      warn: (message) => log.warn(message),
    },
    listStorage: () => this.iterateRelaySessionStorageViews(),
    getApiBaseUrl: () => API_BASE_URL,
    resolveOwner: () => this.resolveOwnerBestEffort(),
    getAccessToken: () => TokenManager.getAccessToken(),
  })
  /** LH2-D1：sync 数据根目录（`userData/agent-sync/`），按账号在下面分桶。 */
  private syncRoot = ''

  /**
   * 长上下文档位（Context Tier）— Per Session 选择，由 renderer 通过
   * IPC `agent-engine:set-session-context-tier` 同步过来。
   *
   * 写入：renderer `useChatModelStore.switchTier(tierId)` → preload IPC →
   *      此 Map 更新；空字符串 / 缺省 = 走模型默认档。
   * 读取：`createRuntimeForSession` 把 contextTierId 配成 getter 注入
   *      `TabTinProxyProvider`，每次 LLM 请求时刻取最新值，
   *      切档无需重建 runtime。
   *
   */
  private get sessionContextTiers() {
    return this.stateRoot.model.sessionContextTiers
  }

  /** 模型运行时参数覆盖 — Per Session 本地选择；空对象表示走模型默认。 */
  private get sessionModelParamOverrides() {
    return this.stateRoot.model.sessionModelParamOverrides
  }

  /**
   * 子 Agent 模型自由度（Phase 3/4）：当前 organization 的「可用模型菜单」快照。
   *
   * 兑现 `createRuntimeForSession` 早先 `agent-engine:list-available-models` TODO
   * ——主进程不再没有目录缓存。**实现选型**：与其走 renderer→main IPC（要改
   * preload surface / 生成类型 / renderer 调用，链路脆且依赖 renderer 时序），
   * 改为主进程直接 HTTP 拉 `/services/llm/catalog?use_case=chat`（与 Daemon W1b
   * 同源、对称），复用 main 已有的 TokenManager / API_BASE_URL / organizationId。
   * 目录由 Django 按 JWT 解析的派单成员 tier 过滤（`_filter_models_by_member_policy`），
   * 故子 Agent 自选天然不绕过 max_model_tier（PRD §4.5.4）。
   *
   * start() 拉一次（不阻塞）+ 5min 定时刷；刷新失败时只保留本进程内已成功
   * 拉到的快照。不要再落盘 catalog：模型 UUID 会迁移 / 停用，文件缓存会把
   * 过期 id 固化进子 Agent 工具说明，导致后台孙代理按旧 id 启动后失败。
   */
  private getModelCatalogSnapshot(owner: Pick<PersistedEntryOwner, 'userId' | 'organizationId'>): ModelCatalogEntry[] {
    return this.stateRoot.model.getCatalogSnapshot(modelCatalogScopeKey(owner))
  }

  /** 按组织隔离的稳定引用；runtime 闭包持有它，配置变更时原位更新即可即时生效。 */
  private readonly subagentModelPolicies = new Map<string, SubagentModelPolicy>()
  /** 服务端组织策略与本机覆盖分开保存，避免 catalog 刷新抹掉本机 ChatGPT。 */
  private readonly backendSubagentModelPolicies = new Map<string, SubagentModelPolicy>()
  private readonly deviceModelPreferences = new Map<string, OrganizationDeviceModelPreferences>()
  private readonly loadedDeviceModelPreferenceOrganizations = new Set<string>()

  private getSubagentModelPolicy(scopeKey: string): SubagentModelPolicy {
    let policy = this.subagentModelPolicies.get(scopeKey)
    if (!policy) {
      policy = { mode: 'inherit' }
      this.subagentModelPolicies.set(scopeKey, policy)
    }
    return policy
  }

  private recomputeSubagentModelPolicy(scopeKey: string): SubagentModelPolicy {
    const effective = this.getSubagentModelPolicy(scopeKey)
    const deviceModelId = this.deviceModelPreferences.get(scopeKey)?.subagentModelId
    const backend = this.backendSubagentModelPolicies.get(scopeKey) ?? { mode: 'inherit' }
    effective.mode = deviceModelId ? 'fixed' : backend.mode
    effective.modelId = deviceModelId || (backend.mode === 'fixed' ? backend.modelId : undefined)
    return effective
  }

  private async loadDeviceModelPreferences(
    owner: Pick<PersistedEntryOwner, 'userId' | 'organizationId'>,
    options: { force?: boolean } = {},
  ): Promise<OrganizationDeviceModelPreferences> {
    const scopeKey = modelCatalogScopeKey(owner)
    if (!options.force && this.loadedDeviceModelPreferenceOrganizations.has(scopeKey)) {
      return this.deviceModelPreferences.get(scopeKey) ?? {}
    }
    const preferences = await readOrganizationDeviceModelPreferences(owner.userId, owner.organizationId)
    this.deviceModelPreferences.set(scopeKey, preferences)
    this.loadedDeviceModelPreferenceOrganizations.add(scopeKey)
    this.recomputeSubagentModelPolicy(scopeKey)
    return preferences
  }

  private async resolveSubagentModelPolicy(
    owner: Pick<PersistedEntryOwner, 'userId' | 'organizationId'>,
  ): Promise<SubagentModelPolicy> {
    await this.loadDeviceModelPreferences(owner)
    return this.recomputeSubagentModelPolicy(modelCatalogScopeKey(owner))
  }

  private catalogRefreshTimer: ReturnType<typeof setInterval> | null = null
  private readonly hostStateSync = new HostStateSync({
    turnStore: () => this.getStateRoot().turn,
    fetchSnapshots: () => this.fetchHostStateContexts(),
    subscribeInvalidation: (listener) => {
      const unsubscribers = [
        TokenManager.onAuthChanged(() => listener(true)),
        electronWsGateway.on('host.state.invalidated', data => {
          const reason = typeof data?.reason === 'string' ? data.reason : ''
          listener(reason === 'workspace_binding_changed' || reason === 'device_revoked')
        }),
        electronWsGateway.on('organization.updated', () => listener(false)),
        electronWsGateway.on('space_list_changed', () => listener(false)),
        electronWsGateway.on('approval_preferences_changed', () => listener(false)),
        electronWsGateway.on('agent.updated', () => listener(false)),
      ]
      return () => unsubscribers.forEach(unsubscribe => unsubscribe())
    },
    subscribeReconnect: listener => electronWsGateway.onReconnect(listener),
    subscribeRegistration: listener => currentDeviceIdentity.subscribe(async () => {
      if (!await listener()) {
        throw new Error('host state reconciliation failed after device registration')
      }
    }),
    afterReconcile: () => {
      this.getStateRoot().catalog.invalidateMcpCache({
        mode: 'drop',
        reason: 'host-state-reconcile',
      })
      this.skillEnablementCache.invalidateAgent()
      void this.refreshModelCatalog()
    },
    logger: { warn: (message, error) => log.warn(message, error) },
  })
  private static readonly CATALOG_REFRESH_INTERVAL_MS = 5 * 60 * 1000
  /**
   * ：catalog miss 回落 FALLBACK_MODEL_CAPABILITIES (32k) 的去重告警集合。
   * `dynamicResolveContextWindow` 经 `resolveContextWindow` 每 query 调一次，
   * 同一 miss modelId 只 warn 一次避免 spam；catalog 刷新 / 磁盘缓存载入时清空，
   * 让"刷新后重新 miss"能再告警。
   */
  private get catalogFallbackWarned(): Set<string> {
    return this.stateRoot.model.catalogFallbackWarned
  }

  private refreshModelCatalogAfterRuntimeFailure(
    owner: Pick<PersistedEntryOwner, 'userId' | 'organizationId'>,
    failure: {
    modelId: string
    errorType: string
    statusCode?: number
    message?: string
    },
  ): void {
    const modelId = failure.modelId.trim()
    if (!modelId) return
    log.warn(
      `[Catalog] model "${modelId}" failed after catalog hit; refreshing catalog: ` +
      `${failure.errorType}${failure.statusCode ? ` status=${failure.statusCode}` : ''}`,
    )
    void this.refreshModelCatalog(owner)
  }

  /**
   * 本地 Skill 模块：由 {@link SkillsModuleLifecycle} 拥有。
   * 登录后 init、失败退避重试、WS 断线重连后重试；登出 / stop 时 dispose。
   *
   * `skillsModule` / `skillsReady` 仍以字段形态暴露给 runtimeAssembly 的
   * getter/setter 端口——读写转发到 lifecycle，避免装配层感知生命周期细节。
   */
  private skillsLifecycle: SkillsModuleLifecycle<SkillsModuleHandle> | null = null
  /**
   * start() 时预收集的 init 上下文（不依赖登录）；真正 init 在登录后由 lifecycle 触发。
   */
  private skillsInitContext: {
    dataRoot: string
    platformDataRoot: string
    appsRoot: string | undefined
    packageSkillsRoot: string | undefined
    sharedSkillsDir: string
    preinstallSources: SkillPreinstallSource[]
    interopRoots: string[]
  } | null = null
  private get skillsModule(): SkillsModuleHandle | null {
    return this.skillsLifecycle?.getModule() ?? null
  }
  /**
   * Agent 级 SkillEnablement 缓存。fetchSkills 前 refresh；tools 同步读。
   * 封闭携带集：仅 `enabledMap[key] === true` 才注入（含 workspace；缺键/无快照=关）。
   * 见 `@tabtin/agent-runtime/skills` skill-enablement。
   */
  private get skillEnablementCache() {
    const skills = this.stateRoot.skills
    if (!skills) throw new Error('SkillsStore not configured on StateRoot')
    return skills.enablement
  }
  /**
   * ready 门闩（PRD §5.2 M1 要点 ④）：转发 lifecycle。
   * 未登录 / 尚未 kickoff 时为 null；登录后 init 进行中为 Promise。
   */
  private get skillsReady(): Promise<void> | null {
    return this.skillsLifecycle?.getReady() ?? null
  }
  /**
   * 2026-05-23 push 通知重构 commit 3：NotificationQueue subscribe 取消句柄。
   *
   * **生命周期**：start() 时 subscribe → listener 在 enqueue 同步路径上被调，
   * listener 调 scheduleDrain(target.threadId) 排 microtask 异步 drain。
   * stop() 时调本句柄 unsubscribe，避免 host shutdown 后还在跑。
   *
   */
  private notificationQueueUnsubscribe: NotificationQueueUnsubscribe | null = null

  /**
   *  WP3：MCP 附着变更时失效 ElectronToolProvider 工具缓存，
   * 让下一轮 getTools 按最新附着结果决定是否暴露 mcp_call_tool。
   */
  private mcpToolCacheUnsubscribe: (() => void) | null = null

  /**
   * push 通知 idle drain 编排（Stage 3：下沉到 agent-host）。
   * 双端旧 `scheduleDrain` / `_tryDrain` / `drainThreadNotificationsText` 收拢到此处，
   * 平台只提供 queue/isBusy/hasSession/runTurn 四个钩子；三道 race 防御与
   * 「session missing → 丢消息、瞬态 busy → 退回」规则由 helper 保证。
   */
  private readonly notificationDrain = new NotificationIdleDrain({
    getQueue: () => this.resolveNotificationQueue(),
    isBusy: (threadId) => this.requireSharedHost().isBusy(threadId),
    hasSession: (threadId) => this.sessions.has(threadId),
    runTurn: (context) => this.runNotificationDrainTurn(context),
    logger: {
      info: (message) => log.info(message),
      warn: (message) => log.warn(message),
      error: (message) => log.error(message),
    },
  })

  private requireSharedHost(): AgentHost<ElectronSharedQuery, QueryResult, HostState> {
    if (!this.sharedHost) {
      throw new Error('AgentHost is not started')
    }
    return this.sharedHost
  }

  /** ：宿主 StateRoot（turn 等）；sharedHost 未起时也可写 */
  getStateRoot(): StateRoot {
    return this.sharedHost?.state ?? this.stateRoot
  }

  private async startSharedHost(): Promise<void> {
    if (this.sharedHost) return
    this.sharedHost = await AgentHost.start<ElectronSharedQuery, QueryResult, HostState>({
      transport: electronAgentTransport,
      deviceId: electronWsGateway.getDeviceId(),
      logger: log,
      onApprovalMemoChanged: workspaceId =>
        this.broadcastApprovalMemoChangedToRenderer(workspaceId),
      onConversationIdle: conversationId =>
        this.scheduleNotificationDrainOnIdle(conversationId),
      // ：执行态权威 sync → renderer 只镜像，不从 lifecycle/terminal 推断 busy
      onRunSync: payload => this.emitRunSyncEvent(payload),
      publishHumanInteraction: async (context, _request, event) => {
        const sessionId = context.threadId.startsWith('chat-session-')
          ? context.threadId.slice('chat-session-'.length)
          : context.threadId
        if (!sessionId) return false
        const response = await electronWsGateway.requestWithLastAuth('relay_events', {
          session_id: sessionId,
          events: [event],
        })
        return response.ok
      },
      publishHumanInteractionResolution: async (context, event) => {
        const sessionId = context.threadId.startsWith('chat-session-')
          ? context.threadId.slice('chat-session-'.length)
          : context.threadId
        if (!sessionId) return false
        const response = await electronWsGateway.requestWithLastAuth('relay_events', {
          session_id: sessionId,
          events: [event],
        })
        return response.ok
      },
      onForwardDecodeFailed: (envelope, failure) => {
        // Stage 1b-B/C-Electron：共享 zod decode 失败时禁止静默 return。
        // 打 error 日志便于诊断包定位；未来接生命周期 error 上报入口可在此扩展。
        log.error('[agent-host] prompt.forward decode failed', {
          reason: failure.reason,
          error: failure.error,
          threadId: typeof envelope.thread_id === 'string' ? envelope.thread_id : undefined,
        })
      },
      commands: {
        forward: async (request, envelope) => {
          if (!request) {
            // 共享 decode 失败已在 onForwardDecodeFailed 上报；这里 no-op。
            return
          }
          const result = await this.handleForwardRequest(this.mapForwardRequestToQuery(request))
          if (result.success) {
            await this.acknowledgePromptAdmission(request.runId, envelope)
          }
        },
        cancel: async ({ sessionId, taskId, envelope }) => {
          const payload = envelope?.payload && typeof envelope.payload === 'object'
            ? envelope.payload as Record<string, unknown>
            : {}
          if (
            payload.withdraw_unanswered === true
            && typeof payload.session_id === 'string'
            && typeof payload.client_message_id === 'string'
          ) {
            await this.handleWithdrawUnansweredTurn({
              sessionId: payload.session_id,
              clientMessageId: payload.client_message_id,
              targetContent: typeof payload.target_content === 'string'
                ? payload.target_content
                : undefined,
              spaceId: typeof payload.space_id === 'string' ? payload.space_id : undefined,
              organizationId: typeof payload.organization_id === 'string'
                ? payload.organization_id
                : undefined,
              skipRemoteCancelSync: true,
            })
            return
          }
          if (envelope) {
            this.handleAbortFromEnvelope(envelope as Record<string, unknown>)
            return
          }
          const first = sessionId ? this.handleAbort(sessionId) : { success: false }
          if (!first.success && taskId) this.handleAbort(taskId)
        },
        cancelSubagent: ({ childId }) => {
          cancelSubagent(childId)
        },
        pause: ({ envelope }) => {
          this.handlePauseFromEnvelope(envelope as Record<string, unknown>)
        },
        resume: ({ envelope }) => {
          this.handleResumeFromEnvelope(envelope as Record<string, unknown>)
        },
        userResponse: async ({
          threadId,
          requestId,
          response,
          batchId,
          decisions,
          submitId,
          envelope,
        }) => {
          await this.handleSharedHostUserResponse({
            threadId,
            requestId,
            response,
            batchId,
            decisions,
            submitId,
            envelope,
          })
        },
        permission: ({ type }) => {
          log.warn(`Unsupported Electron Agent permission command: ${type}`)
        },
        actionRequest: (payload, envelope) => dispatchDeviceActionRequest(
          payload,
          envelope,
          {
            handleRollback: (candidate, candidateEnvelope) =>
              this.handleDeviceTranscriptRollbackAction(candidate, candidateEnvelope),
            handleLoginRelayImport: handleLoginRelayImportAction,
            handleMcp: handleDeviceMcpAction,
            handleFile: handleDeviceFileAction,
          },
        ),
      },
      rollback: request => this.handleRollbackSessionTimeline(request as Parameters<
        ElectronAgentHost['handleRollbackSessionTimeline']
      >[0]),
    }, { state: this.stateRoot })
    // agent-host-full-migration: compose the three deep modules as this host's
    // query engine (reusing the assembly's single runtime factory + owner
    // teardown). Query now flows through submitHostQuery, not conversation.execute.
    this.installComposedQueryEngine()
    // ：审批行为（memo + ask）收敛到 ApprovalGate；hook 只转发描述符。
    this.approvalGate = createApprovalGate({
      ask: (context, request) => (
        this.sharedHost?.requestPlatformApproval(context, request)
        ?? Promise.resolve({ approved: false, scope: undefined })
      ),
      memo: {
        isApproved: (sessionId, actionType, detail, isStrict) => (
          isPlatformActionApproved(actionType, isStrict, detail, sessionId)
        ),
        record: (sessionId, actionType, scope, approved, detail) => {
          recordPlatformApproval(actionType, scope, approved, detail, sessionId)
        },
      },
    })
    setHumanInteractionHooks({
      requestPlatformApproval: async (context, request) => {
        const gate = this.approvalGate
        if (!gate) return { approved: false }
        const result = await gate.request(context, {
          actionType: request.actionType,
          detail: request.detail,
          reason: request.reason,
          timeoutMs: request.timeoutMs,
          isStrict: request.isStrict,
        })
        return { approved: result.approved, scope: result.scope }
      },
      // Access Barrier HITL：进程级实装——委托 `AgentHost.presentAccessBarrier`
      // 把 threadId 落到 session 并组出 InterruptPort（emit + wait）。CLI 出口
      // 经 `resolveAccessBarrierHostHook()` 注入 BrowserOrchestrator。
      resolveAccessBarrier: async (context, barrier) => {
        const host = this.sharedHost
        if (!host) return { action: 'host_unavailable' }
        return host.presentAccessBarrier(context, barrier)
      },
    })
  }

  /**
   * Owner adapter for {@link AgentHost.disposeExecutionOwner}. `resetAccountSync`
   * delegates the standard quiesce → interrupt → wait → teardown → dispose
   * flow to `ExecutionOwnerLifecycle`; the Electron-specific work lives here:
   *
   * - `interruptSession`: abort the in-flight run + cancel its delivery outbox.
   * - `teardownSession`: dispose all session-level Electron resources
   *   (subagent manager, active plans, session storage, backend session,
   *   file history, per-thread approval memory, mode-switch handler).
   * - `disposeOwnerResources`: dispose the shared relay outbox for the
   *   owner and clear the owner-scoped sync directory on disk. `clearedFiles`
   *   is stashed so `resetAccountSync` can surface it to the IPC caller.
   *
   * `runtimeBarrier` bridges into `RuntimeSessionFactory` so pending
   * `resolve()` calls raced against reset get `RuntimeOwnerQuiescedError`
   * and the wait for scope idle covers factory in-flight builds.
   */
  private buildOwnerAdapter(): AgentOwnerAdapter<HostState> {
    return {
      sessions: this.requireSharedHost().sessions,
      runtimeBarrier: {
        quiesceScope: (scopeId) => this.runtimeAssembly.getRuntimeFactory().quiesceScope(scopeId),
        restoreScope: (scopeId) => this.runtimeAssembly.getRuntimeFactory().restoreScope(scopeId),
        waitForScopeIdle: (scopeId) => this.runtimeAssembly.getRuntimeFactory().waitForScopeIdle(scopeId),
      },
      getOwner: (session) => session.owner,
      getConversationIdentity: (sessionId, session) => ({
        conversationId: session.businessThreadId ?? sessionId,
        sessionId,
      }),
      interruptSession: async (sessionId, session) => {
        try { session.abortController.abort() } catch (err) {
          this.warnResetStep('session.abort', sessionId, session.owner, err)
        }
        try {
          await this.requireSharedHost().cancelSessionDelivery(sessionId)
        } catch (err) {
          this.warnResetStep('delivery.cancel', sessionId, session.owner, err)
        }
      },
      teardownSession: async (sessionId, session) => {
        try { session.abortController.abort() } catch (err) {
          this.warnResetStep('session.abort', sessionId, session.owner, err)
        }
        try {
          await this.requireSharedHost().cancelSessionDelivery(sessionId)
        } catch (err) {
          this.warnResetStep('delivery.cancel', sessionId, session.owner, err)
        }
        try { session.subagentManager.dispose() } catch (err) {
          this.warnResetStep('subagentManager.dispose', sessionId, session.owner, err)
        }
        try { clearAllActivePlansForSession(sessionId) } catch (err) {
          this.warnResetStep('clearActivePlans', sessionId, session.owner, err)
        }
        try {
          await session.sessionStorage.dispose()
        } catch (err) {
          this.warnResetStep('sessionStorage.dispose', sessionId, session.owner, err)
        }
        try {
          await session.backendBootstrap?.session.shutdown()
        } catch (err) {
          this.warnResetStep('backendSession.shutdown', sessionId, session.owner, err)
        }
        // Busy 状态由 `ConversationSupervisor` 的 FIFO 运行队列权威承载：
        // 此处 owner-lifecycle teardown 已经通过 `supervisor.quiesce` +
        // `runtimeBarrier.quiesceScope` + `waitForScopeIdle` 停掉执行；无需再
        // 抹一份影子 Set（阶段 4 删影子忙闲）。
        clearThreadEffectiveApprovalMode(sessionId)
        try {
          clearPlatformThreadApprovals(sessionId)
        } catch (err) {
          this.warnResetStep('platformApproval.clearThread', sessionId, session.owner, err)
        }
        try {
          await removeFileHistory(sessionId)
        } catch (err) {
          this.warnResetStep('fileHistory.remove', sessionId, session.owner, err)
        }
        this.sharedHost?.unregisterApprovalMemo(sessionId)
        this._modeSwitchHandler?.clearSession(sessionId)
      },
      disposeOwnerResources: async (owner) => {
        try {
          await this.relayPersistence.disposeOwner(owner)
        } catch (err) {
          this.warnResetStep('relayPersistence.disposeOwner', undefined, owner, err)
        }
        if (this.syncPersistenceEnabled && this.syncRoot) {
          const cleared = await clearSyncAccountDir(this.syncRoot, owner)
          this.pendingClearedFilesByOwner.set(this.ownerKey(owner), cleared)
        }
      },
    }
  }

  private async fetchHostStateContexts(): Promise<{ contexts: HostTurnStateSnapshot[] }> {
    const token = await TokenManager.getAccessToken()
    if (!token) return { contexts: [] }
    const response = await fetch(joinApiPath(API_BASE_URL, '/context/devices/host-state'), {
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Device-Fingerprint': electronWsGateway.getDeviceId(),
      },
    })
    if (!response.ok) {
      throw new Error(`Host state pull failed: HTTP ${response.status}`)
    }
    const body = await response.json() as {
      success?: boolean
      data?: { contexts?: HostTurnStateSnapshot[] }
    }
    if (body.success !== true || !Array.isArray(body.data?.contexts)) {
      throw new Error('Host state pull returned invalid response')
    }
    return { contexts: body.data.contexts }
  }

  private hostTrackerWork: Array<{ runId: string }> = []
  private readonly hostTrackerRunBySession = new Map<string, string>()

  private async fetchHostTrackerSchedule(): Promise<Array<{
    trackerId: string
    triggerType: string
    triggerConfig: Record<string, unknown>
    lastRunAt?: string | null
    createdAt?: string | null
  }>> {
    const snapshot = await this.fetchHostTrackerSnapshot()
    this.hostTrackerWork = snapshot.work
    return snapshot.items
  }

  private async fetchHostTrackerWork(): Promise<Array<{ runId: string }>> {
    const snapshot = await this.fetchHostTrackerSnapshot()
    this.hostTrackerWork = snapshot.work
    return snapshot.work
  }

  private async fetchHostTrackerSnapshot(): Promise<{
    items: Array<{
      trackerId: string
      triggerType: string
      triggerConfig: Record<string, unknown>
      lastRunAt?: string | null
      createdAt?: string | null
    }>
    work: Array<{ runId: string }>
  }> {
    const token = await TokenManager.getAccessToken()
    if (!token) return { items: [], work: [] }
    const response = await fetch(joinApiPath(API_BASE_URL, '/tracker/host-schedule'), {
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Device-Fingerprint': electronWsGateway.getDeviceId(),
      },
    })
    if (!response.ok) {
      throw new Error(`Host tracker schedule failed: HTTP ${response.status}`)
    }
    const body = await response.json() as {
      success?: boolean
      data?: {
        items?: Array<{
          id?: string
          trigger_type?: string
          trigger_config?: Record<string, unknown>
          last_run_at?: string | null
          created_at?: string | null
        }>
        work?: Array<{ run_id?: string }>
      }
    }
    if (body.success !== true || !Array.isArray(body.data?.items)) {
      throw new Error('Host tracker schedule returned invalid response')
    }
    const items = body.data.items.flatMap((item) => {
      const trackerId = typeof item.id === 'string' ? item.id : ''
      const triggerType = typeof item.trigger_type === 'string' ? item.trigger_type : ''
      if (!trackerId || !triggerType) return []
      return [{
        trackerId,
        triggerType,
        triggerConfig: item.trigger_config && typeof item.trigger_config === 'object'
          ? item.trigger_config
          : {},
        lastRunAt: item.last_run_at,
        createdAt: item.created_at,
      }]
    })
    const work = Array.isArray(body.data.work)
      ? body.data.work.flatMap((item) => {
          const runId = typeof item.run_id === 'string' ? item.run_id : ''
          return runId ? [{ runId }] : []
        })
      : []
    return { items, work }
  }

  private async executeHostTrackerRun(runId: string): Promise<void> {
    const token = await TokenManager.getAccessToken()
    if (!token) {
      throw new Error('Host tracker execute skipped: missing access token')
    }
    const response = await fetch(
      joinApiPath(API_BASE_URL, `/tracker/host-schedule/runs/${encodeURIComponent(runId)}/prepare`),
      {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Device-Fingerprint': electronWsGateway.getDeviceId(),
        },
      },
    )
    if (!response.ok) {
      throw new Error(`Host tracker prepare failed: HTTP ${response.status}`)
    }
    const body = await response.json() as {
      success?: boolean
      data?: {
        session_id?: string
        agent_id?: string
        workspace_id?: string
        prompt?: string
        model_id?: string
        task_id?: string
        app_context?: Record<string, unknown>
      }
    }
    if (body.success !== true || !body.data?.session_id || !body.data.prompt) {
      throw new Error('Host tracker prepare returned invalid response')
    }
    const sessionId = body.data.session_id
    this.hostTrackerRunBySession.set(sessionId, runId)
    const result = await this.handleForwardRequest({
      prompt: body.data.prompt,
      threadId: sessionId,
      relaySessionId: sessionId,
      businessThreadId: sessionId,
      taskId: body.data.task_id,
      agentId: body.data.agent_id,
      workspaceId: body.data.workspace_id,
      modelId: body.data.model_id,
      appContext: body.data.app_context as QueryRequest['appContext'],
      interactionMode: 'scheduled',
      agentMode: 'yolo',
    })
    if (!result.success) {
      this.hostTrackerRunBySession.delete(sessionId)
      await this.finalizeHostTrackerRun(runId, result.error || 'Host tracker query failed to start')
      throw new Error(result.error || 'Host tracker query failed to start')
    }
  }

  private async finalizeHostTrackerRun(runId: string, error = ''): Promise<void> {
    const token = await TokenManager.getAccessToken()
    if (!token) return
    const response = await fetch(
      joinApiPath(API_BASE_URL, `/tracker/host-schedule/runs/${encodeURIComponent(runId)}/finalize`),
      {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Device-Fingerprint': electronWsGateway.getDeviceId(),
        },
        body: JSON.stringify({ error }),
      },
    )
    if (!response.ok) {
      throw new Error(`Host tracker finalize failed: HTTP ${response.status}`)
    }
  }

  private settleHostTrackerSession(sessionId: string | undefined, error = ''): void {
    if (!sessionId) return
    const runId = this.hostTrackerRunBySession.get(sessionId)
    if (!runId) return
    this.hostTrackerRunBySession.delete(sessionId)
    void this.finalizeHostTrackerRun(runId, error).catch((finalizeError) => {
      log.warn('[HostTrackerScheduler] finalize failed', finalizeError)
    })
  }

  private async fireHostTracker(trackerId: string): Promise<void> {
    const token = await TokenManager.getAccessToken()
    if (!token) {
      throw new Error('Host tracker fire skipped: missing access token')
    }
    const response = await fetch(
      joinApiPath(API_BASE_URL, `/tracker/host-schedule/${encodeURIComponent(trackerId)}/fire`),
      {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Device-Fingerprint': electronWsGateway.getDeviceId(),
        },
      },
    )
    if (!response.ok) {
      throw new Error(`Host tracker fire failed: HTTP ${response.status}`)
    }
    const body = await response.json() as { success?: boolean }
    if (body.success !== true) {
      throw new Error('Host tracker fire returned invalid response')
    }
  }

  private async reconcileHostTrackerLifecycle(): Promise<void> {
    const token = await TokenManager.getAccessToken()
    if (!token) return
    const response = await fetch(joinApiPath(API_BASE_URL, '/tracker/host-schedule/reconcile'), {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Device-Fingerprint': electronWsGateway.getDeviceId(),
      },
    })
    if (!response.ok) {
      throw new Error(`Host tracker reconcile failed: HTTP ${response.status}`)
    }
    const body = await response.json() as { success?: boolean }
    if (body.success !== true) {
      throw new Error('Host tracker reconcile returned invalid response')
    }
  }

  async start(): Promise<void> {
    if (this.ipcRegistered) return
    this.ipcRegistered = true

    // get-state 是组织/账号切换的安全门。它必须早于网络、Skill 等易失败初始化
    // 注册；Host 尚未就绪时返回空闲态，因为此进程此时不可能存在本地运行任务。
    const agentEngineSurfaces = createAgentEngineSurfaces({
      abort: (sessionId?: string) => this.handleAbort(sessionId),
      getState: (sessionId?: string) => this.handleGetState(sessionId),
      compactSession: (input: AgentEngineCompactSessionInput) => this.handleCompactSession(input),
    })
    registerSurfaceAsIpc(agentEngineSurfaces.agentEngineGetState)

    // H1-E：安装 telemetry sink（幂等），让后续 persona.applied / api.error.400
    // / doom_loop.* / compact.end 等埋点通过 electron-log 落盘。
    installElectronTelemetrySink()
    registerTelemetryIpcHandlers()
    await this.startSharedHost()
    this.hostStateSync.start()
    await this.runHostLeaseCoordinator.start()
    this.mcpToolCacheUnsubscribe = getLocalMcpService().onToolCacheInvalidated((event) => {
      const agentFilter = event.agentIds
      for (const session of this.sessions.values()) {
        if (!session.agentId) continue
        if (agentFilter && agentFilter.length > 0 && !agentFilter.includes(session.agentId)) {
          continue
        }
        void session.toolProvider.refreshTools()
      }
    })
    this.runHostLeaseReconnectUnsubscribe = electronWsGateway.onReconnect(() => {
      void this.runHostLeaseCoordinator.reconcile().catch(error => {
        log.warn('[RunHostLease] reconnect reconcile failed', error)
      })
    })
    this.hostTrackerScheduler.start()
    this.hostTrackerReconnectUnsubscribe = electronWsGateway.onReconnect(() => {
      void this.hostTrackerScheduler.sync().catch((error) => {
        log.warn('[HostTrackerScheduler] reconnect sync failed', error)
      })
    })

    // ：Skill registry 改为登录后初始化（+ 失败重试 + WS 重连重试）。
    // 启动期只预收集不依赖 auth 的源目录；真正 init 交给 SkillsModuleLifecycle。
    await this.setupSkillsLifecycle()

    //  /  / ：注册 Space / Agent 预热。host 延迟导入时
    // space-prewarm 会补发启动早期缓存的最后一次 Space 激活请求。
    setSpacePrewarmHandler((organizationId, spaceId) =>
      this.prewarmSpaceContext(organizationId, spaceId),
    )
    setAgentEnablementPrewarmHandler((agentId) =>
      this.prewarmAgentEnablement(agentId),
    )
    // ：宿主生命周期一开始暖 CLI 目录（不依赖对话）；Space/Agent 级
    // 再由上方 handler 填满常驻缓存。
    void this.warmHostCapabilityCatalogs('host-start')

    // FR-14 / LH2-D1：sync 根目录在 `userData/agent-sync/`，按 owner 分桶
    // 到 `<root>/<userId>/<organizationId>/`。host 启动期不预创建任何子目录——
    // 第一次 createRuntimeForSession 看到具体 owner 时再懒加载。
    this.syncPersistenceEnabled = resolveSyncPersistence(process.env, log)
    this.syncRoot = path.join(app.getPath('userData'), 'agent-sync')

    // 会话代码根本机 sidecar：在注册 IPC 前 configure；scope 就绪后再 restore。
    this.sessionCodeRootBindings.configure({
      getPersistPath: () => path.join(app.getPath('userData'), 'agent', 'session-code-root-bindings.json'),
      getScope: () => this.resolveBindingScope(),
    })
    registerWorktreeRemoveRuntimeProbe({
      listBindingsForRoot: async (rootPath) => {
        const matches = await this.sessionCodeRootBindings.findSessionsByRootPath(rootPath)
        return matches.map(({ sessionId, binding }) => ({
          sessionId,
          branch: binding.branch,
          title: binding.title,
          busy: this.isSessionBusyForCodeRootBind(sessionId),
          revision: binding.revision,
        }))
      },
      clearBindingsForRoot: (rootPath) =>
        this.sessionCodeRootBindings.clearSessionsByRootPath(rootPath),
      reserveRootForRemoval: (rootPath) =>
        this.sessionCodeRootBindings.reserveRootForRemoval(rootPath),
    })
    await this.restoreSessionCodeRootBindings('host-start')

    // ：登录 / 登出 / 换用户时统一失效常驻能力目录（同用户 refresh 跳过）。
    // 会话代码根：同用户 refresh 也再 restore 一次——启动早期 org 可能尚未就绪。
    void this.resolveSkillUserId().then(async (userId) => {
      if (userId && userId !== '_unscoped') {
        this.capabilityIdentityBoundUserId = userId
        await this.restoreSessionCodeRootBindings('host-start-identity')
      }
    })
    this.capabilityIdentityAuthUnsubscribe = TokenManager.onAuthChanged(() => {
      void this.handleCapabilityIdentityAuthChanged()
    })
    this.openAICodexStatusUnsubscribe = onOpenAICodexStatusChanged((status) => {
      if (status !== 'disconnected') return
      return this.handleLocalCodexDisconnected()
    })
    // space:set-active 写入组织后补 restore（Host 启动时 CLI org 通常仍为空）。
    // 走 ensureRestored：同 scope 短路，避免反复 clear；与写链串行。
    this.spaceContextCodeRootUnsubscribe = onCLISpaceContextChanged(({ organizationId }) => {
      if (!organizationId) return
      void this.sessionCodeRootBindings.ensureRestored().then(() => {
        log.info('[SessionCodeRoot] ensureRestored after space-context')
      }).catch((err) => {
        log.warn(
          '[SessionCodeRoot] ensureRestored after space-context failed',
          err instanceof Error ? err.message : err,
        )
      })
    })

    // W2.2-G2：把对话历史 / agent-sync 各类资产注册到 storage-manager
    // 中心。register 函数内部 idempotent（getBucket 检查），多次调用安全。
    // 必须在 syncRoot 设置后调用（agent:sync-* bucket 的 sizeFn 用到）。
    // 实现挪到 ./agent-storage-buckets.ts —— 让该模块可独立测试，不强依赖
    // ElectronAgentHost 完整启动副作用（ws gateway / Notification 等）。
    registerAgentStorageBuckets({
      dataRoot: resolveDataRoot(),
      syncRoot: this.syncRoot,
      getCurrentOwner: async () => (await this.resolveOwnerBestEffort()) ?? null,
    })
    guardedHandle('agent-engine:query', (event: IpcMainInvokeEvent, request: QueryRequest) =>
      this.handleQuery(event, request),
    )

    // ：会话 IPC 投递握手——渲染进程只声明「这个 webContents 要接收该
    // session 的 agent-engine:stream-event」。后端 WS 观察由主进程执行路径
    // 自己决定；renderer 挂流不得隐式触发 `agent.stream.{thread}` 订阅。
    guardedHandle(
      'agent-engine:watch-session',
      (
        event: IpcMainInvokeEvent,
        payload: { sessionId?: string; shareId?: string },
      ): { success: boolean } => {
        const sessionId = payload?.sessionId
        if (!sessionId) return { success: false }
        const shareId = typeof payload?.shareId === 'string' && payload.shareId.trim()
          ? payload.shareId.trim()
          : undefined
        const wc = event.sender
        if (!this.watchedWebContentsIds.has(wc.id)) {
          this.watchedWebContentsIds.add(wc.id)
          wc.once('destroyed', () => {
            this.watchedWebContentsIds.delete(wc.id)
            this.sharedHost?.removeWatchTarget(wc.id)
          })
        }
        this.sharedHost?.watch(sessionId, {
          id: wc.id,
          send: envelope => wc.send(AGENT_STREAM_EVENT_CHANNEL, envelope),
          isDestroyed: () => wc.isDestroyed(),
        }, {
          ...(shareId ? { shareId } : {}),
          observeTransport: false,
        })
        // watch 可能在 run_sync 已发出后才建立（窗口重载 / 订阅恢复）。Host 只会
        // 对本进程见过的 conversation 重放当前快照，远程会话不会被误发 idle。
        this.sharedHost?.syncCurrentRunState(sessionId)
        return { success: true }
      },
    )
    guardedHandle(
      'agent-engine:unwatch-session',
      (event: IpcMainInvokeEvent, payload: { sessionId?: string }): { success: boolean } => {
        const sessionId = payload?.sessionId
        if (!sessionId) return { success: false }
        this.sharedHost?.unwatch(sessionId, event.sender.id)
        return { success: true }
      },
    )

    guardedHandle(
      'agent-engine:register-provisional-session',
      (_event: IpcMainInvokeEvent, payload: { sessionId?: string }) => {
        const sessionId = payload?.sessionId
        const registered = Boolean(sessionId && this.sharedHost?.registerProvisionalSession(sessionId))
        log.info('[ProvisionalSession] register', { sessionId, registered })
        return { registered }
      },
    )
    guardedHandle(
      'agent-engine:begin-provisional-session-claim',
      (_event: IpcMainInvokeEvent, payload: { sessionId?: string }) => {
        const sessionId = payload?.sessionId
        if (!sessionId || !this.sharedHost) return { accepted: false, tracked: false }
        const decision = this.sharedHost.beginProvisionalSessionClaim(sessionId)
        log.info('[ProvisionalSession] begin claim', { sessionId, ...decision })
        return decision
      },
    )
    guardedHandle(
      'agent-engine:complete-provisional-session-claim',
      (_event: IpcMainInvokeEvent, payload: { sessionId?: string; accepted?: boolean }) => {
        const sessionId = payload?.sessionId
        if (!sessionId || !this.sharedHost) return { completed: false }
        this.sharedHost.completeProvisionalSessionClaim(sessionId, payload.accepted === true)
        log.info('[ProvisionalSession] complete claim', {
          sessionId,
          accepted: payload.accepted === true,
        })
        return { completed: true }
      },
    )
    guardedHandle(
      'agent-engine:begin-provisional-session-discard',
      (_event: IpcMainInvokeEvent, payload: { sessionId?: string }) => {
        const sessionId = payload?.sessionId
        if (!sessionId || !this.sharedHost) return { accepted: false, reason: 'host_unavailable' }
        const decision = this.sharedHost.beginProvisionalSessionDiscard(sessionId)
        log.info('[ProvisionalSession] begin discard', { sessionId, ...decision })
        return decision
      },
    )
    guardedHandle(
      'agent-engine:complete-provisional-session-discard',
      (_event: IpcMainInvokeEvent, payload: { sessionId?: string; deleted?: boolean }) => {
        const sessionId = payload?.sessionId
        if (!sessionId || !this.sharedHost) return { completed: false }
        this.sharedHost.completeProvisionalSessionDiscard(sessionId, payload.deleted === true)
        log.info('[ProvisionalSession] complete discard', {
          sessionId,
          deleted: payload.deleted === true,
        })
        return { completed: true }
      },
    )

    //  出站下沉：遥控发送（chat.send_message 等）经主进程 electronWsGateway 执行，
    // renderer 只走 IPC；主进程在发送前订阅对应会话流，代发也代收。
    // requestOptions.organizationId 覆盖 auth org，遥控跨 org 语义正确（见 core buildEnvelope）。
    guardedHandle(
      'agent-engine:gateway-send',
      async (
        _event: IpcMainInvokeEvent,
        payload: {
          messageType?: string
          payload?: Record<string, unknown>
          requestOptions?: Record<string, unknown>
        },
      ) => {
        const messageType = payload?.messageType
        if (!messageType) {
          return { ok: false, type: 'error', requestId: '', error: { code: 'BAD_REQUEST', message: 'messageType is required' } }
        }
        const requestPayload = payload?.payload ?? {}
        const sessionId = typeof requestPayload.session_id === 'string'
          ? requestPayload.session_id
          : undefined
        if (sessionId) {
          this.sharedHost?.observe(sessionId)
        }
        return electronWsGateway.requestWithLastAuth(
          messageType,
          requestPayload,
          payload?.requestOptions as never,
        )
      },
    )

    //  出站 abort 收口：渲染进程只发一次 IPC；本机 miss 由主进程自发 chat.cancel 兜底。
    guardedHandle(
      'agent-engine:abort-run',
      (_event: IpcMainInvokeEvent, payload: { sessionId?: string }) =>
        this.handleAbortRun(payload?.sessionId),
    )

    // Host 级插队：promote 指定排队 run + abort active（不清其它排队）。
    guardedHandle(
      'agent-engine:promote-run',
      (
        _event: IpcMainInvokeEvent,
        payload: { sessionId?: string; runId?: string },
      ) => this.handlePromoteRun(payload),
    )

    // 取消单条 Host 排队（抽屉移除 / 撤回编辑）；不 abort active。
    guardedHandle(
      'agent-engine:cancel-queued-run',
      (
        _event: IpcMainInvokeEvent,
        payload: { sessionId?: string; runId?: string },
      ) => this.handleCancelQueuedRun(payload),
    )

    //  Composer Stop「撤回未答轮次」：abort + runtime rewind 立即 commit +
    // 主进程投影 Django soft revert（非 renderer 直打）。无 checkpoint 前提。
    guardedHandle(
      'agent-engine:withdraw-unanswered-turn',
      (
        _event: IpcMainInvokeEvent,
        payload: {
          sessionId: string
          clientMessageId: string
          localMessageId?: string
          targetContent?: string
          spaceId?: string
          organizationId?: string
        },
      ) => this.handleWithdrawUnansweredTurn(payload),
    )

    //  对话回退统一链路（本地宿主）：renderer 算出保留边界后经 IPC 让本机 host
    // 截断 transcript 软标记 / 撤销。远端 daemon 宿主走 Django session_transcript_truncate
    // 设备动作（见 daemon action-bridge），本通道仅供本地宿主使用。
    guardedHandle(
      'agent-engine:rollback-transcript',
      (
        _event: IpcMainInvokeEvent,
        payload: {
          sessionId: string;
          targetMessageId?: string;
          targetRole?: 'user' | 'assistant';
          targetContent?: string;
          targetOccurrenceIndex?: number;
          mode?: 'rollback' | 'editAndResend';
          keepMessageCount?: number;
          spaceId?: string;
          organizationId?: string;
        },
      ) => this.handleRollbackTranscriptWithGate(payload),
    )
    guardedHandle(
      'agent-engine:rollback-session-timeline',
      (
        _event: IpcMainInvokeEvent,
        payload: {
          sessionId: string;
          targetMessageId: string;
          targetRole?: 'user' | 'assistant';
          targetContent?: string;
          targetOccurrenceIndex?: number;
          mode?: 'rollback' | 'editAndResend';
          keepMessageCount?: number;
          rollbackReason?: string;
          previewRevision?: string;
          filePreviewRevision?: string;
          fileRewindAnchorId?: string;
          rollbackContractVersion?: number;
          acknowledgedFilePreviewReason?: string;
          safetySnapshotHash?: string;
          spaceId?: string;
          organizationId?: string;
        },
      ) => this.handleRollbackSessionTimeline(payload),
    )
    guardedHandle(
      'agent-engine:unrevert-transcript',
      (
        _event: IpcMainInvokeEvent,
        payload: { sessionId: string; spaceId?: string; organizationId?: string },
      ) => this.handleUnrevertTranscriptWithGate(payload),
    )

    // W6 批次 1：agent-engine:abort + agent-engine:get-state 迁到 PlatformSurface。
    // handler 通过闭包捕获 this（ElectronAgentHost 实例）的方法引用。
    registerSurfaceAsIpc(agentEngineSurfaces.agentEngineAbort)
    registerSurfaceAsIpc(agentEngineSurfaces.agentEngineCompactSession)

    // v0.4 W1.5 / PRD §6.7 / §7.4：批量审批提交通道（D6 一刀切，不保留旧
    // submit-ask-user 路径处理 batch 形态）。前端 approvalSlice 走 submitHitlBatch
    // 提交 N 条 decisions；runtime 端 LocalPermissionHandler 按 tool_call_id 分发。
    guardedHandle(
      'agent-engine:submit-hitl-batch',
      async (
        _event: IpcMainInvokeEvent,
        payload: {
          batchId: string
          threadId?: string
          decisions: Array<{
            request_id?: string
            tool_call_id: string
            outcome: 'allow' | 'deny'
            scope?: 'once' | 'thread' | 'always'
            rejection_message?: string
          }>
        },
      ): Promise<{ success: boolean; error?: string; code?: string }> => this.handleSubmitHitlBatch(payload),
    )

    // ask_user 独立通道（PRD §7.5.2 开放式问答路径）。
    guardedHandle(
      'agent-engine:submit-ask-user-response',
      (
        _event: IpcMainInvokeEvent,
        payload: { requestId: string; response: unknown; threadId?: string },
      ): Promise<{ success: boolean; error?: string; code?: string }> =>
        this.handleSubmitAskUserResponse(payload),
    )

    // cancel-hitl IPC 入口——语义与主实现见 `handleCancelHitlInteraction`。
    guardedHandle(
      'agent-engine:cancel-hitl-interaction',
      (
        _event: IpcMainInvokeEvent,
        payload: {
          kind: 'approval' | 'ask'
          requestKey: string
          reason?: string
        },
      ): Promise<{ success: boolean; error?: string; code?: string }> =>
        this.handleCancelHitlInteraction(payload),
    )

    guardedHandle(
      'agent-engine:cancel-subagent',
      async (_event: IpcMainInvokeEvent, input: string | { childId?: string; sessionId?: string }) => {
        const childId = typeof input === 'string' ? input : input?.childId
        if (!childId) return false
        const ok = cancelSubagent(childId)
        log.info(`cancel-subagent ${childId.slice(0, 8)}: ${ok ? 'aborted' : 'not found'}`)
        if (ok) return true
        const sessionId = typeof input === 'object' && typeof input.sessionId === 'string'
          ? input.sessionId
          : undefined
        if (!sessionId) return false
        try {
          const response = await electronWsGateway.requestWithLastAuth('subagent.cancel', {
            session_id: sessionId,
            child_id: childId,
          })
          return !!response?.ok && response.type === 'subagent.cancel.ok'
        } catch (err) {
          log.warn('[ElectronAgentHost] remote subagent.cancel failed', {
            sessionId: sessionId.slice(0, 8),
            childId: childId.slice(0, 8),
            err,
          })
          return false
        }
      },
    )

    // 「异步任务感知」B：列出当前会话仍在跑的本地后台 shell 命令。renderer 在
    // turn 结束（runState.phase === 'done'）时 pull 一次，渲染 pending 预告条。
    // 入参用 renderer 语义的 { sessionId, spaceId }，内部映射 threadId = sessionId。
    // 必须返 envelope：裸数组会被 ipc-shim LEGACY_SHAPE 拒掉，预告条永远空白。
    guardedHandle(
      'agent-engine:list-running-background-tasks',
      (_event: IpcMainInvokeEvent, payload: { sessionId?: string; spaceId?: string }) =>
        okResponse(
          this.listRunningBackgroundTasksForSession({
            threadId: payload?.sessionId,
            spaceId: payload?.spaceId,
          }),
        ),
    )

    guardedHandle(
      'agent-engine:update-context',
      (_event: IpcMainInvokeEvent, payload: { sessionId: string; appContext: AppContext }) => {
        const session = this.sessions.get(payload.sessionId)
        if (session) {
          session.appContext = payload.appContext ?? null
        }
        return { success: Boolean(session) }
      },
    )

    // ：PlanProposalCard「执行」已改为纯 renderer 行为（切 agent 模式 + 发继续
    // 消息，带 plan_ref + 快照）；不再走主进程 IPC + Django /plan/exit。旧 plan-execute
    // 通道连同 handler 一并删除。

    guardedHandle(
      'agent-engine:mode-switch-execute',
      (
        _event: IpcMainInvokeEvent,
        payload: {
          sessionId: string
          proposalId: string
          outcome: 'approved' | 'cancelled'
        },
      ) => this.handleModeSwitchExecute(payload),
    )

    // Phase 3 F8+F9：renderer `setAgentMode` 时同步 IPC 通知主进程，
    // 让主进程立即（不等下条 query）cancel 该 session 的 pending HITL，
    // 并记录一次 mode transition reminder（与 switch_mode 批准路径对称）。
    guardedHandle(
      'agent-engine:notify-mode-switched',
      (
        _event: IpcMainInvokeEvent,
        payload: { sessionId: string; fromMode?: string; toMode: string },
      ) => {
        if (!payload?.sessionId || !payload.toMode) {
          return { success: false, error: 'sessionId and toMode are required' }
        }
        const result = this.modeSwitchHandler.notifyManualSwitch(
          payload.sessionId,
          payload.fromMode,
          payload.toMode,
        )
        return {
          success: true,
          cancelledHitlBatchCount: result.cancelledHitlBatchIds.length,
          modeTransitionReminderSet: result.modeTransitionReminderSet,
        }
      },
    )

    // ：renderer 修改 Workspace 授权档后用此兼容 IPC 通知主进程重拉唯一数据源。
    // payload.approvalMode 不再参与判决，避免恢复会话级第二真源。
    guardedHandle(
      'agent-engine:notify-approval-mode-changed',
      async (
        _event: IpcMainInvokeEvent,
        payload: { sessionId: string; approvalMode: string },
      ): Promise<{ success: boolean; applied?: boolean; error?: string }> => {
        if (!payload?.sessionId || !payload.approvalMode) {
          return { success: false, error: 'sessionId and approvalMode are required' }
        }
        const session = this.sessions.get(payload.sessionId)
        // 无运行中 session：下一条消息发送时 handleQueryInternal 自然快照新档，无需处理。
        if (!session) {
          log.info(
            `[#5520 approval-live] no live session for ${payload.sessionId.slice(0, 8)}… mode=${payload.approvalMode}`,
          )
          return { success: true, applied: false }
        }

        // 重拉权威 grant（ ForWorkspace 合成入口，与 query fetchAuthoritative 同源）。
        const agentId = session.agentId
        if (agentId && session.agentConfigV3) {
          this.agentConfigClient.clearCache()
          const authoritative =
            await this.agentConfigClient.fetchAuthoritativeAgentConfigForWorkspace(
              agentId,
              session.workspaceId,
            )
          session.agentConfigV3.security.allow_yolo_mode =
            authoritative.security.allow_yolo_mode === true
          session.agentConfigV3.security.approval_grant =
            authoritative.security.approval_grant ?? 'always_ask'
        }

        session.policyContext.requestedApprovalMode = undefined
        // 直接由权威 Workspace grant 派生生效档并发布给浏览器 / FAB 审批子系统。
        let effectiveApprovalMode: string | undefined
        if (session.agentConfigV3) {
          const derived = deriveApprovalMode(session.agentConfigV3, {
            requestedAgentMode: session.policyContext.currentAgentMode,
            isGroupSpace: session.policyContext.isGroupSpace,
            unattended: getRuntimeInteractionMode(payload.sessionId) === 'scheduled',
          })
          setThreadEffectiveApprovalMode(payload.sessionId, derived)
          effectiveApprovalMode = derived
        } else {
          clearThreadEffectiveApprovalMode(payload.sessionId)
        }
        const pendingForSession = [...this.interactionRegistry.values()]
          .filter((e) => e.sessionId === payload.sessionId).length
        log.info(
          `[#5520 approval-live] applied session=${payload.sessionId.slice(0, 8)}… ` +
            `workspaceGrantOnly=true ` +
            `effective=${effectiveApprovalMode ?? 'cleared'} ` +
            `grant=${session.agentConfigV3?.security.approval_grant ?? 'undef'} ` +
            `pendingHitlForSession=${pendingForSession}`,
        )
        return { success: true, applied: true }
      },
    )

    guardedHandle(
      'agent-engine:invalidate-agent-config-cache',
      (
        _event: IpcMainInvokeEvent,
        payload?: { agentId?: string; workspaceId?: string },
      ): { success: true } => {
        this.agentConfigClient.clearCache(payload?.agentId)
        clearHostTurnBundleCache({
          agentId: payload?.agentId,
          workspaceId: payload?.workspaceId,
        })
        return { success: true }
      },
    )

    // 前端有更新时推送 Agent / Workspace turn 状态；发送路径优先读此状态。
    guardedHandle(
      'agent-engine:upsert-host-turn-state',
      (
        _event: IpcMainInvokeEvent,
        payload?: {
          agent?: {
            id?: string
            detail?: Record<string, unknown>
            display_name?: string | null
            name?: string | null
            custom_rules?: string | null
            personal_rules?: string | null
            agent_config?: unknown
            organization_allow_member_yolo?: boolean | null
          }
          workspace?: {
            id?: string
            custom_rules?: string | null
            execution_limits?: {
              max_iterations_per_run?: number | null
              max_credits_per_run?: number | string | null
              enabled?: boolean | null
            } | null
            approval_grant?: ApprovalGrantName | null
          }
        },
      ): { success: boolean; error?: string } => {
        try {
          const turn = this.getStateRoot().turn
          const agent = payload?.agent
          if (agent?.id) {
            if (agent.detail) {
              turn.ingestDetails({ agentId: agent.id, agentData: agent.detail })
            }
            // 局部推送：缺省字段不覆盖仓库里已有值（避免只改 grant 时清掉规则）。
            turn.upsertAgent({
              agentId: agent.id,
              ...(agent.display_name !== undefined || agent.name !== undefined
                ? { displayName: agent.display_name ?? agent.name ?? null }
                : {}),
              ...(agent.custom_rules !== undefined
                ? { customRules: agent.custom_rules }
                : {}),
              ...(agent.personal_rules !== undefined
                ? { personalRules: agent.personal_rules }
                : {}),
              ...(agent.agent_config !== undefined
                ? { agentConfigRaw: agent.agent_config }
                : {}),
              ...(agent.organization_allow_member_yolo !== undefined
                ? { organizationAllowMemberYolo: agent.organization_allow_member_yolo }
                : {}),
            })
            // ：选中 / 推送 Agent 时预填 enablement TTL，避免首轮 beforeRun 打 HTTP。
            requestAgentEnablementPrewarm(agent.id)
          }
          const workspace = payload?.workspace
          if (workspace?.id) {
            turn.upsertWorkspace({
              workspaceId: workspace.id,
              ...(workspace.custom_rules !== undefined
                ? { customRules: workspace.custom_rules }
                : {}),
              ...(workspace.execution_limits !== undefined
                ? { executionLimits: workspace.execution_limits }
                : {}),
              ...(workspace.approval_grant !== undefined
                ? { approvalGrant: workspace.approval_grant }
                : {}),
            })
          }
          return { success: true }
        } catch (err) {
          log.warn('[upsert-host-turn-state] failed', err)
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      },
    )

    guardedHandle(
      'agent-engine:refresh-approval-memo',
      async (
        _event: IpcMainInvokeEvent,
        payload?: { workspaceId?: string },
      ): Promise<{ success: true }> => {
        // 设置页撤销 approval_memo 后调用：本机 REST 删除 Django 记忆后，主进程
        // 的 runtime memoStore 缓存仍持有旧 entry（Django 广播不回发发起端），导致
        // 对话里 getAlways 仍命中、撤销不生效。这里对该 agent 的所有 session
        // memoStore 全量重拉，把已删 entry 从缓存移除。
        //
        await this.refreshApprovalMemoStoresForWorkspace(payload?.workspaceId)
        return { success: true }
      },
    )

    guardedHandle(
      'agent-engine:reset-account-sync',
      async (
        _event: IpcMainInvokeEvent,
        payload: { userId: string; organizationId: string },
      ): Promise<{ success: boolean; clearedFiles: boolean; error?: string }> => {
        try {
          // LH2-D2：登出 / 切账号时调用——清对应账号的 sync 目录 + 关掉所有
          // 该 owner 下尚活跃的 SyncQueue。**严格按 owner 匹配**，绝不动其他账号。
          const owner = { userId: payload.userId, organizationId: payload.organizationId }
          // ：与 auth-changed 对称；幂等清常驻能力目录（登出不再暖）。
          await this.initCapabilityIdentity('logout')
          const result = await this.resetAccountSync(owner)
          return { success: true, clearedFiles: result.clearedFiles }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn('reset-account-sync failed: %s', message)
          return { success: false, clearedFiles: false, error: message }
        }
      },
    )

    // ：渲染层切组织 / 手动触发时统一失效主进程常驻能力目录。
    // 新 channel 直接走 envelope（ipc-shim Tier 2），勿进 LEGACY_HANDLERS。
    guardedHandle(
      'agent-engine:init-capability-identity',
      async (
        _event: IpcMainInvokeEvent,
        payload?: {
          reason?: CapabilityIdentityInitReason
          organizationId?: string | null
        },
      ): Promise<
        | { ok: true; data: { success: true; rewarmed: boolean } }
        | { ok: false; error: { code: string; message: string } }
      > => {
        try {
          const reason = payload?.reason ?? 'manual'
          const rewarmed = await this.initCapabilityIdentity(reason, {
            organizationId: payload?.organizationId,
          })
          return { ok: true, data: { success: true, rewarmed } }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn('init-capability-identity failed: %s', message)
          return {
            ok: false,
            error: { code: 'CAPABILITY_IDENTITY_INIT_FAILED', message },
          }
        }
      },
    )

    guardedHandle(
      'agent-engine:check-pending',
      async (
        _event: IpcMainInvokeEvent,
        payload: { threadId: string },
      ): Promise<{ pending_count: number; thread_ids: string[] }> => {
        return checkPendingReports(payload.threadId)
      },
    )

    // HITL / prompt / memo 入站已由 AgentHost + electronAgentTransport 统一承接；
    // 此处只补 delivery / managed-task / notification 等非命令侧钩子。
    this.ensureSharedDeliveryHooks()

    this.cleanupToolLogsOnStartup().catch(() => undefined)

    // M1.4 / : 失效 USER 画像缓存。前端在用户提交 hint / 主动触发蒸馏后调用。
    // 传 organizationId 失效该 Organization 下全部 agent 槽；不传清空全部。
    guardedHandle(
      'agent-engine:invalidate-user-portrait-cache',
      (_event: IpcMainInvokeEvent, organizationId?: string, agentId?: string): { success: true } => {
        this.invalidateUserPortraitCache(organizationId, agentId)
        return { success: true }
      },
    )

    //  阶段 C：草稿 session 预 acquire Runtime（不跑对话轮）。
    guardedHandle(
      'agent-engine:prewarm-runtime',
      async (
        _event: IpcMainInvokeEvent,
        input: PrewarmRuntimeInput,
      ): Promise<{ success: boolean; error?: string }> => {
        return this.prewarmSessionRuntime(input)
      },
    )

    // Wave 5b S2 review#1：Skill 凭据缓存主动失效入口。
    //
    // 渲染层在用户保存 SkillConfig（修改 / 新建 credential_id）成功后调用本 IPC，
    // 主进程遍历所有 active session 调 `skillCredentialResolverHandle.invalidate(filter)`
    // 让共享 resolver 的 60s TTL LRU 立刻丢弃匹配条目，避免"用户改完 → 60s 内
    // Agent 仍按旧密钥跑命令"的漂移窗口（PD-4 自动允许语义下放大风险）。
    //
    // filter 语义与 SkillCredentialResolverHandle.invalidate 一致：
    //   - 都不传：清空所有 session 缓存（渲染层删凭据时用，覆盖面最广）
    //   - 仅 spaceId：清该 space 内所有 skill 缓存
    //   - 仅 skillKey：清所有 space 内该 skill 缓存
    //   - 同时传：精确清单条
    guardedHandle(
      'agent-engine:skill-credential-invalidate',
      (
        _event: IpcMainInvokeEvent,
        payload?: { spaceId?: string; skillKey?: string },
      ): { success: true; sessions: number } => {
        const filter = payload && (payload.spaceId || payload.skillKey)
          ? { spaceId: payload.spaceId, skillKey: payload.skillKey }
          : undefined
        let count = 0
        for (const state of this.sessions.values()) {
          try {
            state.skillCredentialResolverHandle.invalidate(filter)
            count += 1
          } catch (err) {
            log.warn(
              'skill-credential-invalidate: per-session invalidate failed: %s',
              err instanceof Error ? err.message : String(err),
            )
          }
        }
        log.info(
          `skill-credential cache invalidated across ${count} active runtime(s) (filter=${
            filter ? JSON.stringify(filter) : 'all'
          })`,
        )
        return { success: true, sessions: count }
      },
    )

    //  / ：面板变更标记 enablement stale，并异步原子刷新；
    // 刷新完成前继续使用 last-good，避免 Prompt 可见后 tools 读到空携带集。
    guardedHandle(
      'agent-engine:skill-enablement-invalidate',
      (
        _event: IpcMainInvokeEvent,
        payload?: { agentId?: string },
      ): { success: true } => {
        const agentId = payload?.agentId?.trim() || undefined
        let rewarmAgentIds: string[]
        if (agentId) {
          this.skillEnablementCache.invalidateAgent(agentId)
          rewarmAgentIds = [agentId]
        } else {
          rewarmAgentIds = this.skillEnablementCache.invalidateAll()
        }
        for (const rewarmAgentId of rewarmAgentIds) {
          void this.skillEnablementCache.forAgent(rewarmAgentId).refresh({ force: true })
            .catch((error) => {
              log.warn(
                '[SkillEnablement] rewarm after invalidate failed agent=%s: %s',
                rewarmAgentId,
                error instanceof Error ? error.message : String(error),
              )
            })
        }
        log.info(
          '[SkillEnablement] cache invalidated (%s)',
          agentId ? `agent=${agentId}` : 'all',
        )
        return { success: true }
      },
    )

    // 长上下文档位（Context Tier）同步：renderer 切档后调用此 IPC，
    // main 立即更新 sessionContextTiers Map，下次 LLM 请求 buildHeaders
    // 时透传 X-TabTin-Context-Tier 给 Django proxy。
    guardedHandle(
      'agent-engine:set-session-context-tier',
      (
        _event: IpcMainInvokeEvent,
        payload: { sessionId: string; tierId: string | null },
      ) => {
        const sid = (payload?.sessionId || '').trim()
        if (!sid) return okResponse({ success: true as const })
        const tid = (payload?.tierId || '').trim()
        if (tid) {
          this.sessionContextTiers.set(sid, tid)
        } else {
          this.sessionContextTiers.delete(sid)
        }
        return okResponse({ success: true as const })
      },
    )

    // 本机 ChatGPT/Codex 不属于 Django 的 Organization 模型 UUID 空间。
    // 这两个 IPC 只持久化当前设备偏好；主进程同时更新稳定策略引用，使已创建
    // runtime 的下一次子 Agent 派发立即使用新设置。
    guardedHandle(
      'agent-engine:get-device-model-preferences',
      async (
        _event: IpcMainInvokeEvent,
        payload: { organizationId?: string },
      ) => {
        const organizationId = (payload?.organizationId || '').trim()
        if (!organizationId) throw new Error('organizationId is required')
        const userId = await this.requireSkillUserId()
        const preferences = await this.loadDeviceModelPreferences(
          { userId, organizationId },
          { force: true },
        )
        return okResponse({ preferences })
      },
    )
    guardedHandle(
      'agent-engine:set-device-model-preferences',
      async (
        _event: IpcMainInvokeEvent,
        payload: {
          organizationId?: string
          preferences?: OrganizationDeviceModelPreferences
        },
      ) => {
        const organizationId = (payload?.organizationId || '').trim()
        if (!organizationId) throw new Error('organizationId is required')
        const userId = await this.requireSkillUserId()
        const preferences = await writeOrganizationDeviceModelPreferences(
          userId,
          organizationId,
          payload?.preferences ?? {},
        )
        const scopeKey = modelCatalogScopeKey({ userId, organizationId })
        this.deviceModelPreferences.set(scopeKey, preferences)
        this.loadedDeviceModelPreferenceOrganizations.add(scopeKey)
        this.recomputeSubagentModelPolicy(scopeKey)
        return okResponse({ preferences })
      },
    )

    // 模型运行参数（如 reasoning_effort）由 renderer 的会话状态持久化；
    // main 只维护一份按 sessionId 索引的内存快照，供已创建的 runtime 在
    // 下一次 LLM 请求前读取。这样用户切换「思考强度」后无需重建 runtime，
    // 请求组装阶段会把 canonical 参数交给 Django wire adapter 做 provider 映射。
    guardedHandle(
      'agent-engine:set-session-model-param-overrides',
      (
        _event: IpcMainInvokeEvent,
        payload: { sessionId: string; overrides: Record<string, unknown> | null },
      ) => {
        const sid = (payload?.sessionId || '').trim()
        if (!sid) return okResponse({ success: true as const })
        const rawOverrides = payload?.overrides
        if (!rawOverrides || typeof rawOverrides !== 'object') {
          this.sessionModelParamOverrides.delete(sid)
          return okResponse({ success: true as const })
        }
        const normalized: Record<string, string | number | boolean | null> = {}
        for (const [rawKey, rawValue] of Object.entries(rawOverrides)) {
          const key = rawKey.trim()
          if (!key) continue
          if (
            rawValue === null
            || typeof rawValue === 'string'
            || typeof rawValue === 'number'
            || typeof rawValue === 'boolean'
          ) {
            normalized[key] = rawValue
          }
        }
        if (Object.keys(normalized).length > 0) this.sessionModelParamOverrides.set(sid, normalized)
        else this.sessionModelParamOverrides.delete(sid)
        return okResponse({ success: true as const })
      },
    )

    // Phase 5: 读取 snapshots.jsonl —— renderer 刷新后恢复 LLM call 检视面板数据。
    //
    // archive lives at:
    //   {conversationsRoot}/{organizationId}/{spaceId}/sessions/{sessionId}/snapshots.jsonl
    //
    // The renderer always knows the active spaceId/organizationId (it just rendered
    // the chat tab), so it MUST send them in the IPC payload. Resolution order:
    //   1. payload.spaceId / payload.organizationId — authoritative.
    //   2. in-memory session state (still alive) — used only when the renderer
    //      can't supply IDs (legacy callers; will warn-log on production builds).
    //
    // The legacy "scan all space buckets" fallback was removed: it was
    // *always* invoked when payload.spaceId was missing (the old preload
    // didn't forward spaceId), making an expensive O(N spaces) directory
    // walk the common path rather than an exceptional one.
    guardedHandle(
      'agent-engine:read-snapshots',
      async (
        _event: IpcMainInvokeEvent,
        payload: { sessionId: string; spaceId?: string; organizationId?: string },
      ): Promise<{ success: boolean; snapshots?: unknown[]; error?: string; os_error?: OSToolError }> => {
        try {
          let spaceId = payload.spaceId
          let organizationId = payload.organizationId
          if (!spaceId || !organizationId) {
            const live = this.sessions.get(payload.sessionId)
            spaceId = spaceId ?? live?.spaceId
            organizationId = organizationId ?? live?.owner?.organizationId
          }
          if (!spaceId || !organizationId) {
            return {
              success: false,
              error:
                'spaceId and organizationId are required ( hard-cut — no _unscoped)',
            }
          }

          const { sessionDir } = await this.resolveSessionArchiveDirs({
            sessionId: payload.sessionId,
            spaceId,
            organizationId,
          })
          const filePath = path.join(sessionDir, payload.sessionId, 'snapshots.jsonl')
          if (!fs.existsSync(filePath)) return { success: true, snapshots: [] }
          const raw = await safeReadFile(filePath, { encoding: 'utf-8' })
          const parsed = raw.trim().split('\n').filter(Boolean).map(line => {
            try { return JSON.parse(line) } catch { return null }
          }).filter(Boolean) as Array<Record<string, unknown>>
          // 同一次 LLM 调用会落两行：调用前（无 response）与调用后（带模型输出 response）。
          // 按 (runId, iteration) 去重、后到覆盖，使刷新恢复与 live upsert 行为一致——
          // 面板拿到的每轮快照都带本轮模型输出。保持首次出现顺序。
          const byKey = new Map<string, Record<string, unknown>>()
          const order: string[] = []
          for (const s of parsed) {
            const key = `${String(s.runId)}#${String(s.iteration)}`
            if (!byKey.has(key)) order.push(key)
            byKey.set(key, s)
          }
          const snapshots = order.map(k => byKey.get(k)!)
          return { success: true, snapshots }
        } catch (err) {
          // OS 访问异常（macOS TCC / Windows AV / 云盘占位）→ 透出结构化字段，
          // 让 renderer / Agent 拿到 user_guidance 而不是裸 errno。
          if (isOSAccessError(err)) {
            const osError: OSToolError = toToolError(err.osError)
            return { success: false, error: osError.llm_message, os_error: osError }
          }
          const message = err instanceof Error ? err.message : String(err)
          return { success: false, error: message }
        }
      },
    )

    // ── ：本地 transcript 权威读取 ─────────────────────────────────
    //
    // 冷启动后 client 判定「这条会话是不是本机会话」的**唯一**可靠依据是
    // 主进程探盘 messages.jsonl —— 冷启动区分本机会话与观察端的唯一可靠依据；
    // 热路径 sync 按内容态保留未落库，不再依赖内存态来源标志。
    //
    // has-local-transcript：判据探盘（不构造 SessionStorage，避免给不存在的会话
    //   误建空目录）。size>0 即视为「本机会话」；极短窗口崩溃（messages.jsonl 尚未
    //   落盘）会判为 false → renderer 回落 DB 只读（已知边界）。
    guardedHandle(
      'agent-engine:has-local-transcript',
      async (
        _event: IpcMainInvokeEvent,
        payload: { sessionId: string; spaceId?: string; organizationId?: string },
      ): Promise<{ success: boolean; hasLocal?: boolean; error?: string }> => {
        try {
          if (!payload?.sessionId) return { success: false, error: 'sessionId is required' }
          // live session 在内存中 → 必是本机驱动（buffer 可能尚未 flush，磁盘探盘
          // 会漏，故优先短路）。
          if (this.sessions.has(payload.sessionId)) return { success: true, hasLocal: true }
          const { sessionDir } = await this.resolveSessionArchiveDirs({
            sessionId: payload.sessionId,
            spaceId: payload.spaceId,
            organizationId: payload.organizationId,
          })
          // ：message-blocks.jsonl（block 权威）与 messages.jsonl（六件套）
          // 任一非空即视为本机会话（含  迁移后新树 / leftover 旧树）。
          const hasLocal = this.sessionTranscriptExists(sessionDir, payload.sessionId)
          return { success: true, hasLocal }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn(`[has-local-transcript] probe failed session=${payload?.sessionId}: ${message}`)
          return { success: false, error: message }
        }
      },
    )

    // ：云端 fork 成功后，把本机 SessionStorage 归档复制到新 session 并 remap
    // tool_use id / sessionId。源无本机正文时 skipped（非错误）。
    guardedHandle(
      'agent-engine:fork-local-session',
      async (
        _event: IpcMainInvokeEvent,
        payload: {
          sourceSessionId: string
          newSessionId: string
          spaceId?: string
          organizationId?: string
          forkAnchorMessageId?: string
          toolIdRemap?: Record<string, string>
        },
      ): Promise<{
        success: boolean
        copied?: boolean
        skipped?: boolean
        reason?: string
        remappedToolIds?: number
        truncatedAtForkPoint?: boolean
        error?: string
      }> => {
        try {
          if (!payload?.sourceSessionId || !payload?.newSessionId) {
            return { success: false, error: 'sourceSessionId and newSessionId are required' }
          }
          // fork 写目标固定走  新布局；源若仍在旧树，先把该 session 目录并入新树再 fork。
          const userId = await this.resolveSkillUserId()
          if (!userId) {
            return { success: false, error: 'userId is required to fork local session archive' }
          }
          const spaceId = payload.spaceId ?? getCLISpaceId() ?? undefined
          const organizationId = payload.organizationId ?? getCLIOrganizationId() ?? undefined
          if (!spaceId || !organizationId) {
            return {
              success: false,
              error:
                'spaceId and organizationId are required to fork local session archive ()',
            }
          }
          const dataRoot = resolveDataRoot()
          const sessionArchiveDir = resolveWorkspaceSessionArchiveDir(
            dataRoot,
            userId,
            organizationId,
            spaceId,
          )
          const toolLogsDir = resolveWorkspaceToolLogsDir(
            dataRoot,
            userId,
            organizationId,
            spaceId,
          )
          const sourcePaths = await this.resolveSessionArchiveDirs({
            sessionId: payload.sourceSessionId,
            spaceId,
            organizationId,
          })
          if (sourcePaths.sessionDir !== sessionArchiveDir) {
            const from = path.join(sourcePaths.sessionDir, payload.sourceSessionId)
            const to = path.join(sessionArchiveDir, payload.sourceSessionId)
            if (fs.existsSync(from) && !fs.existsSync(to)) {
              await this.moveDirPreferRename(from, to)
            }
          }
          const result = forkLocalSessionArchive({
            sessionArchiveDir,
            toolLogsDir,
            sourceSessionId: payload.sourceSessionId,
            newSessionId: payload.newSessionId,
            forkAnchorMessageId: payload.forkAnchorMessageId,
            toolIdRemap: payload.toolIdRemap,
          })
          return {
            success: true,
            copied: result.copied,
            skipped: result.skipped,
            reason: result.reason,
            remappedToolIds: result.remappedToolIds,
            truncatedAtForkPoint: result.truncatedAtForkPoint,
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn(
            `[fork-local-session] failed source=${payload?.sourceSessionId} new=${payload?.newSessionId}: ${message}`,
          )
          return { success: false, error: message }
        }
      },
    )

    // read-session-transcript：把 messages.jsonl 重建成结构化消息（本机会话的正文
    //   唯一权威）。live 会话走 sessionStorage（loadTranscript 内部先 flush，保证
    //   read-after-write 一致）；无 live 时构造瞬态 storage 读归档。返回
    //   ReconstructedTranscriptMessage[]，由 renderer 薄适配成 ChatMessage。
    guardedHandle(
      'agent-engine:read-session-transcript',
      async (
        _event: IpcMainInvokeEvent,
        payload: { sessionId: string; spaceId?: string; organizationId?: string },
      ): Promise<{ success: boolean; messages?: ReconstructedTranscriptMessage[]; error?: string; os_error?: OSToolError }> => {
        try {
          if (!payload?.sessionId) return { success: false, error: 'sessionId is required' }
          //  message block 权威：优先读 message-blocks.jsonl（消息级记录，
          // 与 Django content_blocks_json 同 payload、tool_result 已 co-locate）；
          // 存量会话无 block 文件时回落六件套重放（零回归）。
          const messages = await this.withTranscriptStorage(payload, async (storage) => {
            const sessionDir = path.dirname(storage.blockStorage.filePath)
            hydrateMessageSenderAttributions(sessionDir)
            if (storage.blockStorage.hasRecords()) {
              const records = await storage.blockStorage.load()
              if (records.length > 0) {
                return blockRecordsToTranscriptMessages(records).map((message) => ({
                  ...message,
                  ...(message.messageId
                    ? { senderUserId: resolveMessageSenderAttribution(message.messageId) }
                    : {}),
                })) as ReconstructedTranscriptMessage[]
              }
            }
            const entries = await storage.loadTranscript()
            return reconstructMessagesFromTranscriptEntries(entries).map((message) => ({
              ...message,
              ...(message.messageId
                ? { senderUserId: resolveMessageSenderAttribution(message.messageId) }
                : {}),
            }))
          })
          return { success: true, messages }
        } catch (err) {
          if (isOSAccessError(err)) {
            const osError: OSToolError = toToolError(err.osError)
            return { success: false, error: osError.llm_message, os_error: osError }
          }
          const message = err instanceof Error ? err.message : String(err)
          log.error(`[read-session-transcript] failed session=${payload?.sessionId}: ${message}`)
          return { success: false, error: message }
        }
      },
    )

    /**
     * W2（2026-05-26）：子 session 三件套读取统一 IPC（D8 决策：单接口设计）。
     *
     * 路径解析**强制走父 session 的 `subagents.jsonl` 索引**——这是「子 Agent
     * 落盘契约」的 SSoT；不解析索引、用 `subagents/agent-{id}/...` 硬拼路径会
     * 在未来落盘 schema 演进时直接断（譬如把 sidechain 目录改名 / 加分层）。
     *
     * 安全防御三件套：
     * 1) renderer 传的 `subagentRunId` 必须是 UUID 36 字符 hex 格式
     *    （childId 就是 UUID；写入时 `crypto.randomUUID()`，详见
     *    `fork-query.ts:570`），否则 path traversal 风险（譬如 `../../etc/passwd`）
     * 2) 解析出的绝对路径必须 `startsWith(safeRoot)` —— 兜底防御，
     *    避免索引被篡改 / 软链接攻击（ 后 safeRoot 仅为 dataRoot）
     * 3) 当 renderer 传了 organizationId / spaceId 时优先走归档路径（`read-snapshots`
     *    同款做法），允许读「session 已不 alive 但归档仍在磁盘」的历史子 Agent。
     *    若 renderer 没传 context 才回退看 host.sessions Map（live 校验）。
     *
     * 容量上限：单次读取上限 5000 行（snapshots.jsonl 可达 MB 级），返回
     * `truncated: true` 让 renderer 知道还有更多——v2 加分页参数（offset/limit）
     * 时按 cursor 续读。
     */
    guardedHandle(
      'agent-engine:read-subagent-session',
      async (
        _event: IpcMainInvokeEvent,
        payload: {
          parentSessionId: string
          subagentRunId: string
          kind: 'messages' | 'snapshots' | 'events'
          /** P0-D 放宽：renderer 传时优先走归档（不要求 live session）。 */
          organizationId?: string
          spaceId?: string
        },
      ): Promise<LegacyEnvelopeResult<{ lines: unknown[]; truncated?: boolean }>> => {
        // 错误形态统一走 envelope-error helper：所有失败路径都返回
        // `{ ok: false, error: { code, message } }`——ipc-shim envelope 契约要求
        // error 是对象（含 code/message），否则会被识别为 broken envelope，吐
        // 通用兜底文案 "returned ok:false without a message" 把原始错误码吞掉。
        // 详见 `envelope-error.ts` 文件头注释。
        let organizationId = payload.organizationId
        let spaceId = payload.spaceId
        if (!organizationId || !spaceId) {
          // 没 context 时回退看 live session——保留与旧版相同的兼容路径，
          // 避免移除门禁后老调用方（没传 wt/sp）默默撞 `parent_session_missing_organization_or_space`。
          const live = this.sessions.get(payload.parentSessionId)
          if (!live) {
            return wrapLegacyError('parent_session_not_alive')
          }
          organizationId = organizationId ?? live.owner?.organizationId
          spaceId = spaceId ?? live.spaceId
          if (!organizationId || !spaceId) {
            return wrapLegacyError('parent_session_missing_organization_or_space')
          }
        }
        const archive = await this.resolveSessionArchiveDirs({
          sessionId: payload.parentSessionId,
          organizationId,
          spaceId,
        })
        const result = await readSubagentSessionFile({
          parentSessionDir: archive.sessionDir,
          parentSessionId: payload.parentSessionId,
          subagentRunId: payload.subagentRunId,
          kind: payload.kind,
          safeRoot: archive.safeRoot,
        })
        return liftLegacyResult(result)
      },
    )

    /**
     * 列出父 session 派出过的所有子 Agent run。
     *
     * **解决的体验问题**：SUBAGENT_STARTED / PROGRESS / COMPLETED 这些事件
     * 通过 `context.emitStreamEvent` 同步发出、走 IPC stream-event 到达
     * renderer 内存 store。它们既不进父 events.jsonl（不经主 generator
     * yield），也不进父 messages.jsonl（`_isPersistableEnvelope` 白名单
     * 只放 6 件套 + lifecycle + compaction）。用户刷新 / 切走再回 /
     * 重启 Electron 后，runtime store 丢失 → `useSubagentRun` 反查 miss
     * → `SubagentProgressCard.status` 兜底成 `'unknown'` → 卡片显示
     * "状态同步中" + drill-in 被隐藏。
     *
     * **数据 SSoT**：`subagents.jsonl`（SubagentIndexWriter）落 started
     * + ended 两行——renderer 加载历史消息后调本 IPC 把 status / task /
     * parentToolCallId / startedAt / endedAt / durationMs reconcile 进
     * `subagentRunsBySessionId`，让 unknown 态回归到真实终态。
     *
     * **不恢复**实时态字段（toolHistory / stepCount / latestTool）—— 这些
     * 只在 SUBAGENT_PROGRESS 事件流里有，索引文件不持久化。展开卡片看不到
     * "每一步工具调用"是当前架构的妥协（恢复需要扫子 events.jsonl，成本
     * 不匹配收益）；status / task / duration 这"三件最关键"先恢复就能让
     * 用户感知到正确状态。
     *
     * 安全防御与 `read-subagent-session` 一致：renderer 传 wt/sp 走归档路径，
     * 没传 fallback 看 live session；`safeRoot` 防 path traversal。
     */
    guardedHandle(
      'agent-engine:list-subagent-runs',
      async (
        _event: IpcMainInvokeEvent,
        payload: {
          parentSessionId: string
          organizationId?: string
          spaceId?: string
        },
      ): Promise<LegacyEnvelopeResult<{ runs: SubagentRunSnapshot[] }>> => {
        // 同 read-subagent-session，错误形态统一走 envelope-error helper。
        let organizationId = payload.organizationId
        let spaceId = payload.spaceId
        if (!organizationId || !spaceId) {
          const live = this.sessions.get(payload.parentSessionId)
          if (!live) {
            return wrapLegacyError('parent_session_not_alive')
          }
          organizationId = organizationId ?? live.owner?.organizationId
          spaceId = spaceId ?? live.spaceId
          if (!organizationId || !spaceId) {
            return wrapLegacyError('parent_session_missing_organization_or_space')
          }
        }
        const archive = await this.resolveSessionArchiveDirs({
          sessionId: payload.parentSessionId,
          organizationId,
          spaceId,
        })
        const live = this.sessions.get(payload.parentSessionId)
        await reapOrphanedSubagentRuns(
          archive.sessionDir,
          payload.parentSessionId,
          (childId) => live?.subagentManager?.has(childId) === true,
        )
        const result = await listSubagentRunsForSession({
          parentSessionDir: archive.sessionDir,
          parentSessionId: payload.parentSessionId,
          safeRoot: archive.safeRoot,
        })
        return liftLegacyResult(result)
      },
    )

    guardedHandle(
      'agent-engine:retry-tool',
      async (
        _event: IpcMainInvokeEvent,
        payload: { sessionId: string; toolName: string; args: Record<string, unknown> },
      ): Promise<{ success: boolean; result?: unknown; error?: string }> => {
        const state = this.sessions.get(payload.sessionId)
        if (!state) return { success: false, error: 'Session not found' }

        const tool = state.toolProvider.getTools().find(t => t.name === payload.toolName)
        if (!tool) return { success: false, error: `Tool "${payload.toolName}" not found` }
        if (!tool.isReadOnly) return { success: false, error: `Tool "${payload.toolName}" is not safe to retry` }

        // FR-13: retry-tool 也是一个 ToolContext 构造点，必须带上当前 runtime
        // 快照的 workspaceRoot，否则 readOnly 工具未来若依赖 workspaceRoot（如
        // `read_file`、`glob_search` 等工具）会悄悄回落 undefined。
        //
        // §17.6 D4.c：ToolContext.runtimeId 用 runtime 实例 UUID（来自
        // `runtime.getRuntimeId()`），跟 query 主路径同源——retry-tool 在用户
        // 重试同一 turn 工具时不应另起一个 UUID（telemetry 维度需要可对账）。
        const context = {
          threadId: state.sessionId,
          runtimeId: state.runtime.getRuntimeId(),
          workspaceRoot: state.workspaceRoot,
          abortSignal: new AbortController().signal,
          messages: [],
        }

        try {
          const result = await executeTool(tool, payload.args, context, 60_000)
          return { success: true, result: result.content }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log.warn('retry-tool failed: %s %s', payload.toolName, msg)
          return { success: false, error: msg }
        }
      },
    )

    // ：ensureSpaceSkills 的 surface 依赖签名保留 (organizationId, spaceId)
    // 兼容旧 caller，但内部改走新布局——先确保用户级 skills 根，再确保组织级
    // skills 根（NOT ensureSpaceSkills，老布局 API 已停用）。
    const ensureUserAndOrganizationSkills = async (organizationId: string): Promise<void> => {
      if (!this.skillsModule) {
        throw new Error('Skill registry 未初始化')
      }
      const userId = await this.requireSkillUserId()
      await this.skillsModule.ensureUserSkills(userId)
      await this.skillsModule.ensureOrganizationSkills(userId, organizationId)
    }

    // ：resolveSkillDir 统一按 (userId, organizationId) 解析组织 skills 目录；
    // spaceId 参数仅为兼容 surface 依赖签名保留，不参与路径计算。
    const resolveUserOrganizationSkillDir = async (
      organizationId: string,
      slug: string,
    ): Promise<string> => {
      const userId = await this.requireSkillUserId()
      return resolveOrganizationSkillDir(resolveDataRoot(), userId, organizationId, slug)
    }

    // PR1：renderer 的 built-in Skills catalog 走本地 runtime registry，
    // 不再为了 platform/app 列表请求 Django /skills/visible。
    const skillList = createSkillListSurface({
      getSkillsReady: () => this.skillsReady,
      getSkillsRegistry: () => this.skillsModule?.registry ?? null,
      ensureSpaceSkills: async (organizationId, _spaceId) => {
        await ensureUserAndOrganizationSkills(organizationId)
      },
      listPersonalPluginSkills: async ({ organizationId, spaceId }) => {
        const userId = await this.requireSkillUserId()
        const snapshot = await loadEnabledPersonalPluginSkillSnapshot({
          userId,
          dataRoot: resolveDataRoot(),
          organizationId,
          spaceId,
          onWarn: (message) => log.warn(message),
        })
        return snapshot.skills
      },
    })
    registerSurfaceAsIpc(skillList)

    // W6 批次 2：skill:read-content 迁到 PlatformSurface。
    // 依赖通过 getter 闭包捕获 this.skillsReady / this.skillsModule，
    // handler 执行时（非注册时）才读取当前状态。
    const skillReadContent = createSkillReadContentSurface({
      getSkillsReady: () => this.skillsReady,
      getSkillsRegistry: () => this.skillsModule?.registry ?? null,
      resolveSkillDir: (_spaceId, organizationId, slug) =>
        resolveUserOrganizationSkillDir(organizationId, slug),
      readSkillFile: async (dirPath, fileName) => {
        try {
          return await fs.promises.readFile(path.join(dirPath, fileName), 'utf-8')
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw err
        }
      },
      readSourceSkillFile: async (docPath) => {
        if (!path.isAbsolute(docPath) || path.basename(docPath) !== 'SKILL.md') {
          return null
        }

        const workspaceRoot = process.env.TABTIN_WORKSPACE_ROOT
        const allowedRoots = [
          workspaceRoot ? path.join(workspaceRoot, 'packages', 'skills', 'bundled') : undefined,
          workspaceRoot ? path.join(workspaceRoot, 'packages', 'apps') : undefined,
          workspaceRoot ? path.join(workspaceRoot, 'packages', 'runtimes') : undefined,
          workspaceRoot ? path.join(workspaceRoot, 'packages', 'infrastructure') : undefined,
        ].filter(Boolean) as string[]
        const [realDocPath, ...realRoots] = await Promise.all([
          fs.promises.realpath(docPath).catch(() => null),
          ...allowedRoots.map(root => fs.promises.realpath(root).catch(() => null)),
        ])
        if (!realDocPath) return null

        const isAllowed = realRoots.some((root) => {
          if (!root) return false
          return realDocPath === root || realDocPath.startsWith(`${root}${path.sep}`)
        })
        if (!isAllowed) return null

        try {
          return await fs.promises.readFile(realDocPath, 'utf-8')
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw err
        }
      },
    })
    registerSurfaceAsIpc(skillReadContent)

    // 草稿编辑器（renderer）写本地 SKILL.md / 查询路径——#7118 改写到新布局
    // `{dataRoot}/users/{userId}/organizations/{orgId}/skills/`，不再依赖
    // platform-data + spaceId 拼路径（历史上漏传 organizationId 会落到
    // `_unscoped` 而被 LocalSkillRegistry watcher 忽略）。
    const skillWriteContent = createSkillWriteContentSurface({
      isValidSkillKey,
      resolveSkillDir: (_spaceId, organizationId, slug) =>
        resolveUserOrganizationSkillDir(organizationId, slug),
      writeSkillFile: async (dirPath, fileName, content) => {
        await fs.promises.mkdir(dirPath, { recursive: true })
        await fs.promises.writeFile(path.join(dirPath, fileName), content, 'utf-8')
      },
      ensureSpaceSkills: async (organizationId, _spaceId) => {
        await ensureUserAndOrganizationSkills(organizationId)
      },
    })
    registerSurfaceAsIpc(skillWriteContent)

    const skillResolvePath = createSkillResolvePathSurface({
      isValidSkillKey,
      resolveSkillDir: (_spaceId, organizationId, slug) =>
        resolveUserOrganizationSkillDir(organizationId, slug),
      pathExists: async (absPath) => {
        try {
          await fs.promises.stat(absPath)
          return true
        } catch {
          return false
        }
      },
      // 跨 space 回退（/#655 →  改跨组织回退）：先找当前用户的个人
      // skills，再枚举该用户名下所有 organization 的 skills，返回第一个含
      // SKILL.md 的真实目录。用于把在 A 组织创建的个人 skill 分享到团队时
      // 定位源文件。
      findSkillDirAcrossSpaces: async (slug) => {
        const userId = await this.resolveSkillUserId()
        if (!userId) return null
        const dataRoot = resolveDataRoot()

        const userSkillDir = resolveUserSkillDir(dataRoot, userId, slug)
        try {
          await fs.promises.stat(path.join(userSkillDir, 'SKILL.md'))
          return userSkillDir
        } catch {
          // 用户级没有该 skill，继续找组织级
        }

        try {
          const organizationsRoot = path.join(resolveUserRoot(dataRoot, userId), 'organizations')
          const orgEntries = await fs.promises.readdir(organizationsRoot, { withFileTypes: true })
          for (const org of orgEntries) {
            if (!org.isDirectory()) continue
            const candidate = resolveOrganizationSkillDir(dataRoot, userId, org.name, slug)
            try {
              await fs.promises.stat(path.join(candidate, 'SKILL.md'))
              return candidate
            } catch {
              // 该组织下没有该 skill，继续找
            }
          }
        } catch {
          // organizations 根不可读：无回退
        }
        return null
      },
    })
    registerSurfaceAsIpc(skillResolvePath)

    // 商店安装闭环（ app 子案）：marketplace 分发的 app skill 点安装时，
    // 把它的 bundled 源按需物化进当前用户/组织的本地 skills 目录，让 registry
    // 扫得到、Agent 的 `<skills>` 段可见。organizationId 由 renderer 显式传入；
    // userId 缺失时由宿主解析当前登录用户（ 新布局强制要求真实 userId）。
    const skillMaterializeApp = createSkillMaterializeAppSurface({
      materializeAppSkill: async (params) => {
        const userId = params.userId ?? (await this.resolveSkillUserId())
        return this.materializeAppSkill({ ...params, userId })
      },
    })
    registerSurfaceAsIpc(skillMaterializeApp)

    // ：面板「从 npm」页签 → 本机 npx skills add（与 CLI /skills/install-npm 同核）
    guardedHandle(
      'skill:install-npm',
      async (
        _event: IpcMainInvokeEvent,
        params: {
          package?: string
          spaceId?: string
          organizationId?: string | null
          importToSpace?: boolean
          enableSpaceIds?: string[]
        },
      ) => {
        try {
          const addInterop =
            getCLISkillsInteropAdder()
            ?? (async (rootPath: string) => {
              await this.addInteropRoot(rootPath)
            })
          const data = await installNpmSkill({
            packageName: params?.package ?? '',
            spaceId: params?.spaceId,
            organizationId: params?.organizationId,
            importToSpace: Boolean(params?.importToSpace),
            enableSpaceIds: params?.enableSpaceIds,
            addInteropRoot: addInterop,
          })
          return { success: true as const, data }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn('[Skills] skill:install-npm failed: %s', message)
          return { success: false as const, error: message }
        }
      },
    )

    // ── L-10: agent-security IPC handlers ──────────────────────────────
    //
    // 历史背景：曾经有 ``agent-security:set-yolo-mode`` / ``agent-security:revoke-memo``
    // 两个 handler 直接发 HTTP 到 Django，但 URL 写错了（``/space/agents/...`` +
    // PATCH 而非正典 ``/agents/...``），后端一律 404；又因 handler 把
    // 404 包装成 ``{ success: false }`` 默默 resolve（不 reject），renderer 又没人
    // 检查 ``success`` 字段——结果是"点了完全没反应、控制台 / 终端无输出"。
    //
    // 根因修复：状态变更类调用统一走 renderer 的 ``useSpaceStore`` action（内部用
    // ``packages/tabtin-config/endpoints.ts`` 常量 + ``space-api.ts`` 封装），
    // store 同时管 ``agentCache`` / ``selectedAgent`` 同步——既保证 URL 正确，又
    // 避免"写后端成功但 UI 不刷新"的二次 bug。本侧不再开放 IPC 旁路。
    //
    // 保留的 ``get-workspace-snapshot`` / ``build-approval-key`` / ``build-scope-description``
    // 都是只读查询：snapshot 是 main 进程持有的内存状态，build-* 是纯函数（共享
    // ``@tabtin/security-policy``），不发 HTTP，无 URL bug 隐患。
    // W6 批次 1：agent-security 3 个 handler 迁到 PlatformSurface。
    // findWorkspaceSnapshot 闭包捕获 this.sessions（AgentHost 内存状态遍历）；
    // buildApprovalKey / buildScopeDescription 通过 dynamic import 延迟加载
    // @tabtin/security-policy（避免 cli-server-core 对 security-policy 的直接依赖）。
    const agentSecuritySurfaces = createAgentSecuritySurfaces({
      findWorkspaceSnapshot: (spaceId: string) =>
        this.workspaceBoundary.getSnapshot(this.sessions.values(), spaceId),
      buildApprovalKey: async (toolName, subcmd, input, inWorkspace, opts) => {
        const mod = await import('@tabtin/security-policy')
        return mod.buildApprovalKey(toolName, subcmd, input, inWorkspace, {
          scope: opts.scope,
          kind: opts.kind as import('@tabtin/security-policy').PolicyActionKind | undefined,
        })
      },
      buildScopeDescription: async (toolName, subcmd, scope) => {
        const mod = await import('@tabtin/security-policy')
        return mod.buildScopeDescription(toolName, subcmd, scope)
      },
    })
    registerSurfaceAsIpc(agentSecuritySurfaces.getWorkspaceSnapshot)
    registerSurfaceAsIpc(agentSecuritySurfaces.buildApprovalKey)
    registerSurfaceAsIpc(agentSecuritySurfaces.buildScopeDescription)

    // ── 路径权限治理 Wave 2/3：装配渲染层 IPC 共享的 path-access-checker ──
    //
    // fs:* / git / checkpoint IPC handler 都从 `getDefaultPathAccessChecker()`
    // 取同一个 checker 实例消费当前 session 的 v3
    // `WorkspaceSnapshot.allowedPaths`，与 LLM 工具链路（tabcode-adapter →
    // action-tools）走同一份权限单源——让"用户在 TabFolder 浏览
    // `/Volumes/外接盘/项目/`，UI 文件树预览/重命名/git 面板/checkpoint init"
    // 这种老模型撞墙场景跑通。
    //
    // **Wave 3 修 L14（多 Space 互相污染）根因**：
    //   - 不再 union 所有 session 的 allowedPaths
    //   - 闭包改为按 **当前活跃 spaceId** 取单 session（dogfood 单 Space active
    //     模式 = 用户当前正在用的 Space）
    //   - 当前活跃 spaceId 来自 `getCLISpaceId()`，由 `space:set-active` IPC
    //     在 Space 切换时已经更新（renderer adapter `setActiveSpace` 派发）
    //
    // **fail-closed 兜底**：
    //   - getCLISpaceId() 为 null（启动早期 / setActive 未跑）→ 返回 [] →
    //     path-access-checker 退化到只允许 platformAllowedDirs（home /
    //     spacesRoot / platformDataRoot / downloads）。这跟 LLM 工具链路
    //     headless 直调时的语义一致：snapshot 缺失 ≠ deny 所有，仍允许平台基础区
    //   - findSessionForSpaceId 找不到 session → 同上
    //
    // 多窗口 split view（多 Space 同时活跃）超出 dogfood 范围，进遗留池由后续
    // wave 用"renderer fs/git/checkpoint IPC payload 加 spaceId"严格方案修。
    const findWorkspaceSnapshotByActiveSpaceId = (): import('@tabtin/security-policy').WorkspaceSnapshot | null => {
      const activeSpaceId = getCLISpaceId()
      if (!activeSpaceId) return null
      return this.workspaceBoundary.getSnapshot(this.sessions.values(), activeSpaceId)
    }
    setRendererWorkspaceProviders({
      getAllowedPaths: () => {
        const snapshot = findWorkspaceSnapshotByActiveSpaceId()
        if (!snapshot) return []
        //  / ：会话代码根绑定优先并入。`snapshot.spaceSessionId`
        // 是该 snapshot 归属的具体 chat session——merge 只读这一个 session 在
        // `sessionCodeRootBindings` 里的绑定，不会泄漏到同 Space 下其它会话。
        // 覆盖「刚 bind、还没发下一条消息」窗口，避免 TabFolder 立刻打开绑定
        // 目录时先撞 outside_workspace。
        const boundRoot = snapshot.spaceSessionId
          ? this.sessionCodeRootBindings.getRootPath(snapshot.spaceSessionId)
          : undefined
        if (boundRoot && !snapshot.allowedPaths.includes(boundRoot)) {
          return [...snapshot.allowedPaths, boundRoot]
        }
        return [...snapshot.allowedPaths]
      },
      getAllowedFiles: () => {
        // session miss 时 buffer 不存 attachedFiles（chat 拖拽附件链路独立），
        // 直接返 []；这条比 allowedPaths 弱化是因为附件级精确匹配语义本来
        // 就少在冷启动期发生（用户拖附件前都已发过消息触发 session 创建）。
        const snap = findWorkspaceSnapshotByActiveSpaceId()
        return snap ? [...snap.allowedFiles] : []
      },
    })

    // ── L-7: TabCode/TabFolder workspace tracking ────────────────────
    //
    // **路径权限治理 Wave 3 重写**（修 L13 / L14 / 02 §6 断点 5）：
    //   1. **完整列表替换语义**：renderer 推 `tabcodeProjects` / `tabfolderDirs`
    //      数组就是 spaceId 下当前 store 的全部条目。main 端**直接替换**
    //      `snap.sources.tabcodeProjects` / `tabfolderDirs`（而不是 union 累加），
    //      然后 `allowedPaths` 重新 derive。修了 02 §6 断点 5 "增量推送 +
    //      sources 覆盖 + allowedPaths 累加" 三层语义错位。
    //   2. **按 spaceId 路由**：payload 必带 `spaceId`，main 端只 mutate
    //      匹配的 session（不再遍历所有）。修 L14 多 Space 污染。
    //   3. **fail-closed**：找不到匹配 session → log warn + 不动（不再 union
    //      fallback）；renderer 先 hydrate 后 spaceId 才有 session 是常态，
    //      上层调用方应在 createRuntimeForSession 之后才推。
    //
    // **M3.1 硬化补丁（深度防御）**：本 IPC 是 renderer 主动推送的"工作区
    // 当前打开列表"，理论上 renderer 可信；但 path-normalize 层只在
    // `isInWorkspace` 读路径上做兜底过滤，写路径如果直接落入畸形数据
    // （譬如 renderer 代码 bug、单测 fixture 泄漏、未来跨包契约调整），会让
    // session.workspaceSnapshot 内部携带 dirty 数据。这里在写入前用同一中央
    // helper `isDangerouslyBroadPath` 过滤，**与 decode 层语义对齐**——
    // 把过宽路径（`/`、`/Users`、家目录本身、相对路径等）剔除后再写入
    // sources / allowedPaths。
    // 单根契约（见 docs/single-root-space-prd.md §2.2）：renderer 推 workspace
    // 路径变更时，main 端按 spaceId 路由 mutate session.workspaceSnapshot.sources，
    // 重新 derive allowedPaths。payload 只读 `workingDir` 单字段。
    ipcMain.on(
      'workspace:paths-changed',
      (_event, payload: { spaceId: string; workingDir: string }) => {
        const result = this.workspaceBoundary.apply(this.sessions.values(), {
          type: 'paths-changed',
          payload,
        })
        if (result.warning) log.warn(result.warning)
      },
    )

    ipcMain.handle(
      'workspace:paths-changed:invoke',
      async (_event, payload: { spaceId: string; workingDir: string }) => {
        const result = this.workspaceBoundary.apply(this.sessions.values(), {
          type: 'paths-changed',
          payload,
        })
        if (result.warning) log.warn(result.warning)
        return { ok: true, data: { mutated: result.mutated } }
      },
    )

    // 单根契约 §2.4：ApprovalPanel 审批通过的路径通过本 IPC 推到对应 session 的
    // `sources.sessionApprovedPaths`。session 内 Agent 后续访问该路径全部放行；
    // session 重启 / 切 Space / 切 Agent 后失效，需要重新审批。
    //
    // **已知限制**：`WorkspaceBoundary.applyApprovedPath` 按
    // `spaceId` 匹配 session，会同时命中同一 Space 下所有持有 snapshot 的
    // session。与本 IPC 相邻的 `agent:bind-session-code-root` 不受影响：会话
    // 代码根绑定走独立的 `sessionCodeRootBindings`（严格按 sessionId 隔离）。
    ipcMain.handle(
      'workspace:append-session-allowed-path:invoke',
      async (_event, payload: { spaceId: string; sessionId?: string; path: string }) => {
        const result = this.workspaceBoundary.apply(this.sessions.values(), {
          type: 'session-path-approved',
          payload,
        })
        if (result.warning) log.warn(result.warning)
        return { ok: true, data: { mutated: result.mutated } }
      },
    )

    //  / ：会话代码根绑定（TabCode worktree session root）。
    // renderer 在某条 chat 会话里选定 linked worktree 后调本 IPC——main 端校验
    // 路径存在 / 是 Git 工作树 / 会话未 busy，成功后写入
    // `sessionCodeRootBindings`，`buildRequestFromQuery` 下一轮 query 起优先
    // 消费它作为执行根（见 `resolveExecutionWorkspaceRoot`）。
    guardedHandle(
      'agent:bind-session-code-root',
      async (
        _event: IpcMainInvokeEvent,
        payload: {
          sessionId?: string
          rootPath?: string
          revision?: number
          tabKey?: string
          branch?: string
          title?: string
        },
      ): Promise<BindSessionCodeRootResult> => this.handleBindSessionCodeRoot(payload),
    )
    guardedHandle(
      'agent:get-session-code-root',
      async (_event: IpcMainInvokeEvent, payload: { sessionId?: string }) => {
        const sessionId = payload?.sessionId
        if (typeof sessionId !== 'string' || !sessionId) {
          return { success: false as const, error: 'sessionId is required' }
        }
        await this.sessionCodeRootBindings.ensureRestored()
        const binding = this.sessionCodeRootBindings.get(sessionId)
        return { success: true as const, binding: binding ?? null }
      },
    )
    guardedHandle(
      'agent:clear-session-code-root',
      async (_event: IpcMainInvokeEvent, payload: { sessionId?: string }) => {
        const sessionId = payload?.sessionId
        if (typeof sessionId !== 'string' || !sessionId) {
          return { success: false as const, error: 'sessionId is required' }
        }
        const cleared = await this.sessionCodeRootBindings.clearAndPersist(sessionId)
        return { success: true as const, cleared }
      },
    )
    guardedHandle(
      'agent:list-session-code-roots',
      async (_event: IpcMainInvokeEvent, payload: { sessionIds?: string[] }) => {
        const sessionIds = Array.isArray(payload?.sessionIds)
          ? payload.sessionIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
          : []
        await this.sessionCodeRootBindings.ensureRestored()
        const bindings = this.sessionCodeRootBindings.getMany(sessionIds)
        return { success: true as const, bindings }
      },
    )
    guardedHandle(
      'agent:rehome-session-code-root',
      async (
        _event: IpcMainInvokeEvent,
        payload: { fromSessionId?: string; toSessionId?: string },
      ) => {
        const fromSessionId = payload?.fromSessionId
        const toSessionId = payload?.toSessionId
        if (typeof fromSessionId !== 'string' || !fromSessionId.trim()) {
          return { success: false as const, error: 'fromSessionId is required' }
        }
        if (typeof toSessionId !== 'string' || !toSessionId.trim()) {
          return { success: false as const, error: 'toSessionId is required' }
        }
        const binding = await this.sessionCodeRootBindings.rehome(fromSessionId, toSessionId)
        return { success: true as const, binding: binding ?? null }
      },
    )

    initProactivePoller({
      triggerColdStartReport: async (threadId: string) => {
        const { getMainWindow } = await import('../window-manager.js')
        const win = getMainWindow()
        if (!win || win.isDestroyed()) return

        const details = await fetchPendingSubtaskDetails(threadId)
        if (details.length === 0) {
          log.info(`[proactive-poller] no pending details for thread=${threadId.slice(0, 8)}…, skipping cold start`)
          return
        }

        const pendingInfos: PendingSubtaskInfo[] = details.map(d => ({
          runId: d.run_id,
          displayName: d.display_name,
          shortId: d.short_id,
          status: d.status,
          task: d.task,
          summary: d.summary || undefined,
          errorMessage: d.error_message || undefined,
          initiatorSpeakerId: d.initiator_speaker_id || undefined,
          completedAt: d.completed_at ? new Date(d.completed_at).getTime() : undefined,
        }))
        const reportContent = formatProactiveReportMessage(pendingInfos)
        const runIds = details.map(d => d.run_id)

        // 先推送再标记——推送幂等（Renderer 去重），标记原子（`WHERE notified_at IS NULL`）。
        // 即使推送后标记失败，下次冷启动会重新推送（用户看到重复通知好过看不到通知）。
        if (!win.isDestroyed()) {
          win.webContents.send('agent-engine:proactive-report-ready', {
            threadId,
            content: reportContent,
            runIds,
          })
        }

        const affected = await markSubtaskRunsNotified(runIds)
        log.info(
          `[proactive-poller] cold start report sent for thread=${threadId.slice(0, 8)}… ` +
          `(${details.length} runs, ${affected} newly marked)`,
        )
      },
    })

    // 状态 C：Main 重启后异步扫描 crashed + 未 push 的 SubtaskRun。
    // 不阻塞 start() 返回——启动链路上的其他初始化不应等待网络 I/O。
    scanCrashedRuns().catch((err) => {
      log.warn(`[proactive-poller] scanCrashedRuns failed on startup: ${err}`)
    })

    log.info('IPC handlers registered')
  }

  /**
   * AgentHost 入站 `localrt.user_response` / `agent.action.approval_response`
   * 的平台实现：承接 AgentHost 入站 HITL，含 delivery ACK。
   *
   * sharedHost 未就绪（尚未 start / 已 stop）时显式 ack `runtime_unavailable`
   * ——与 Daemon `handleLocalRuntimeUserResponse` 同码，避免让 gateway 侧误
   * 判成"送达了但没消费"。
   */
  private async handleSharedHostUserResponse(input: {
    threadId?: string
    requestId?: string
    response: unknown
    batchId?: string
    decisions?: unknown[]
    submitId?: string
    envelope?: { thread_id?: string; payload?: unknown; [key: string]: unknown }
  }): Promise<void> {
    const batchId = typeof input.batchId === 'string' ? input.batchId : ''
    const topRequestId = typeof input.requestId === 'string' ? input.requestId : ''
    const submitId = typeof input.submitId === 'string' ? input.submitId : ''
    const threadId = input.threadId
      ?? (typeof input.envelope?.thread_id === 'string' ? input.envelope.thread_id : undefined)
    const sendDeliveryAck = (
      status: 'delivered' | 'pending_not_found' | 'runtime_unavailable' | 'invalid_response',
      extra: Record<string, unknown> = {},
    ) => {
      if (!submitId) return
      void electronWsGateway.requestWithLastAuth(
        LocalRuntimeEvents.USER_RESPONSE_DELIVERY,
        {
          submit_id: submitId,
          status,
          request_id: topRequestId || undefined,
          batch_id: batchId || undefined,
          ...extra,
        },
        { threadId },
      ).then((res) => {
        if (!res.ok) {
          log.warn(`[W7c P0-1] localrt.user_response delivery ack failed: submit=${submitId} status=${status} error=${res.error?.message ?? res.type}`)
        }
      }).catch((err) => {
        log.warn(`[W7c P0-1] localrt.user_response delivery ack threw: submit=${submitId} status=${status} error=${err instanceof Error ? err.message : String(err)}`)
      })
    }

    if (!this.sharedHost) {
      log.warn(
        `[W7c P0-1] localrt.user_response received while sharedHost not ready ` +
          `(batchId=${batchId || 'n/a'} requestId=${topRequestId || 'n/a'}) — ack runtime_unavailable`,
      )
      sendDeliveryAck('runtime_unavailable', {
        error_code: 'runtime_unavailable',
        error_message: 'ElectronAgentHost sharedHost is not ready',
        retryable: true,
      })
      return
    }

    if (batchId) {
      const decisions = Array.isArray(input.decisions) ? input.decisions : []
      if (decisions.length === 0) {
        log.warn(`[W7c P0-1] localrt.user_response batch=${batchId} has empty decisions[]`)
        sendDeliveryAck('invalid_response', {
          error_code: 'invalid_response',
          error_message: 'approval batch decisions[] is empty',
          retryable: false,
        })
        return
      }
      if (!this.interactionRegistry.has(batchId)) {
        log.debug(`[W7c P0-1] localrt.user_response approval batch=${batchId} not pending here (likely handled by another device)`)
        sendDeliveryAck('pending_not_found', {
          error_code: 'pending_not_found',
          error_message: 'No pending approval batch on this runtime',
          retryable: false,
        })
        return
      }
      const result = this.handleSubmitHitlBatchLocal({
        batchId,
        decisions: decisions as Array<{
          request_id?: string
          tool_call_id: string
          outcome: 'allow' | 'deny'
          scope?: 'once' | 'thread' | 'always'
          rejection_message?: string
        }>,
      })
      if (result.success) {
        log.info(`[W7c P0-1] localrt.user_response approval batch delivered: batchId=${batchId} (decisions=${decisions.length})`)
        sendDeliveryAck('delivered')
      } else {
        sendDeliveryAck('pending_not_found', {
          error_code: 'pending_not_found',
          error_message: 'Approval batch was not accepted by runtime',
          retryable: false,
        })
      }
      return
    }

    if (topRequestId) {
      if (!this.interactionRegistry.has(topRequestId)) {
        log.debug(`[W7c P0-1] localrt.user_response ask_user request=${topRequestId} not pending here`)
        sendDeliveryAck('pending_not_found', {
          error_code: 'pending_not_found',
          error_message: 'No pending ask_user request on this runtime',
          retryable: false,
        })
        return
      }
      const result = this.handleSubmitAskUserResponseLocal({
        requestId: topRequestId,
        response: input.response,
      })
      if (result.success) {
        log.info(`[W7c P0-1] localrt.user_response ask_user delivered: requestId=${topRequestId}`)
        sendDeliveryAck('delivered')
      } else {
        sendDeliveryAck('pending_not_found', {
          error_code: 'pending_not_found',
          error_message: 'ask_user response was not accepted by runtime',
          retryable: false,
        })
      }
      return
    }

    log.warn('[W7c P0-1] localrt.user_response missing both batch_id and request_id')
    sendDeliveryAck('invalid_response', {
      error_code: 'invalid_response',
      error_message: 'missing both batch_id and request_id',
      retryable: false,
    })
  }

  /**
   * 全量重拉指定 Workspace 的所有 session runtime memoStore。
   * 不传 workspaceId 则刷新全部。
   */
  async refreshApprovalMemoStoresForWorkspace(workspaceId?: string): Promise<void> {
    await this.sharedHost?.refreshApprovalMemos(workspaceId)
  }

  broadcastApprovalMemoChangedToRenderer(workspaceId: string): void {
    if (!workspaceId) return
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.webContents.send('agent-engine:approval-memo-changed', { workspaceId })
      } catch {
        /* window torn down mid-send — ignore */
      }
    }
  }

  /**
   * Delivery / managed-task / notification 钩子（幂等）。
   * approval_memo 入站与 reconnect refresh 由 AgentHost 统一拥有。
   */
  private ensureSharedDeliveryHooks(): void {
    // 终端假运行根治 Layer 1（治 F2/F3/F16/F20）：WS 重连 / 启动对账 relay-pending。
    // 断网期间落盘的后台命令终态 / query 内 relay 在网络恢复后补发。fire-and-forget。
    // Stage 3：所有 recover + backfill 编排下沉到 RelaySessionOrchestrator。
    if (!this.relayReconnectUnsubscribe) {
      this.relayReconnectUnsubscribe = electronWsGateway.onReconnect(() => {
        void this.sharedHost?.kickRecoverAndBackfill({ activateOwner: false })
      })
    }
    void this.sharedHost?.kickRecoverAndBackfill({ activateOwner: true })

    // 终端假运行根治 Layer 2（治 F9 / 崩溃兜底）：注入 ManagedTaskStore 落盘端口
    // （此后 spawn 即写 running record 到盘）+ 启动对账（恢复上次进程崩溃 / kill -9
    // 残留的 running record 终态——探活 + 读 sidecar 退出码 → 走 Wave 1 outbox 回写）。
    this.setupLayer2ManagedTaskReconcile()

    // 2026-05-23 push 通知重构 commit 3：subscribe NotificationQueue。
    // bridge 在 detached 命令退出时往 queue enqueue 一条 background-task-completed
    // 通知（已在 commit 2 实施 producer），这里 subscribe 让 host 知道有新通知，
    // 触发 scheduleDrain → idle drain → 起新 turn。
    //
    // **bridge 必须先就绪**——bridge-core.ts setupCoreAPIs 在 PtyManager ready 后
    // 即 setPtyManagerBridge，本 start() 在 host 实例化后由 main-app.ts 调用，
    // 时序上 bridge 总是先于 host.start()。
    //
    // 详见 PRD §6.3 + commit 1 的 NotificationQueue.subscribe 接口契约。
    if (!this.notificationQueueUnsubscribe) {
      try {
        const queue = this.resolveNotificationQueue()
        if (queue) {
          this.notificationQueueUnsubscribe = queue.subscribe((env) => {
            // §17.6 D4.a：target.sessionId → target.threadId（业务对话 thread）
            if (this.sessions.has(env.target.threadId)) {
              this.notificationDrain.schedule(env.target.threadId)
            }
            // t1（终端"假运行"根治）：后台命令终结 → emit 终态 tool_result 覆盖
            // running 快照，重载对话时终端卡片显示真实终态（完成 退出码 / 已终止），
            // 而非永远"运行中"转圈。前端零改——拿到 status='completed' 的 content
            // 照常渲染。fire-and-forget，与 scheduleDrain 正交。
            this.relayBackgroundTaskTerminalResult(env)
          })
        } else {
          // bridge 未注入或 queue 不可用（极罕见，bootstrap 错误）——log 不阻塞 start
          log.warn(
            `[NotificationQueue] subscribe skipped at start(): bridge/queue unavailable`,
          )
        }
      } catch (err) {
        // bridge 可能未注入（极罕见，bootstrap 错误）——log 不阻塞 start
        log.warn(
          `[NotificationQueue] subscribe failed at start(): ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // 子 Agent 模型自由度（Phase 3/4）：异步拉一次最新目录 + 定时刷新（不阻塞
    // start）。不使用磁盘缓存，避免旧模型 UUID 被长期展示给子 Agent。
    void this.refreshModelCatalog()
    this.catalogRefreshTimer = setInterval(
      () => void this.refreshModelCatalog(),
      ElectronAgentHost.CATALOG_REFRESH_INTERVAL_MS,
    )
  }

  /**
   * 子 Agent 模型自由度（Phase 3/4）：从 Django `/services/llm/catalog` 拉「可用
   * 模型菜单」并更新内存快照。失败时保留本进程内已成功拉到的快照；冷启动失败
   * 则保持目录为空，让子 Agent 缺省继承父模型。
   * 目录已按派单成员 tier 过滤（Django 端按 JWT 解析 user_id）。
   */
  private async refreshModelCatalog(
    explicitOwner?: Pick<PersistedEntryOwner, 'userId' | 'organizationId'>,
  ): Promise<void> {
    let token: string | null = null
    try {
      token = await TokenManager.getAccessToken()
    } catch {
      token = null
    }
    if (!token) return

    const userId = explicitOwner?.userId ?? await this.resolveSkillUserId()
    const organizationId = explicitOwner?.organizationId ?? getCLIOrganizationId() ?? undefined
    if (!userId || !organizationId) return
    const scopeKey = modelCatalogScopeKey({ userId, organizationId })
    const base = joinApiPath(API_BASE_URL, '/services/llm/catalog?use_case=chat')
    const url = organizationId ? `${base}&organization_id=${encodeURIComponent(organizationId)}` : base
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (!resp.ok) {
        log.warn(`[Catalog] HTTP ${resp.status} from ${url}`)
        return
      }
      type CatalogModelRaw = {
        id?: string
        name?: string
        model_name?: string
        display_name?: string
        context_window_tokens?: number
        max_output_tokens?: number
        // v0.1：supports_vision / supports_function_calling 已并入
        // resolved_capabilities（顶层不再下发），读法对齐 Django _derive_usage_hint。
        resolved_capabilities?: {
          supports_vision?: boolean
          supports_function_calling?: boolean
        }
        capabilities_config?: Record<string, unknown>
        provider?: string
        usage_hint?: string
        provider_scope?: string
      }
      // `/catalog` 走老 helper envelope `{success, code, message, data:{models}}`；
      // 兼容潜在的 flat 形态（`{models}`）。
      const json = (await resp.json()) as {
        models?: CatalogModelRaw[]
        subagent_model_policy?: unknown
        subagent_model_id?: unknown
        data?: {
          models?: CatalogModelRaw[]
          subagent_model_policy?: unknown
          subagent_model_id?: unknown
        }
      }
      const models = json.data?.models ?? json.models
      if (!Array.isArray(models)) return
      const policyMode = json.data?.subagent_model_policy ?? json.subagent_model_policy
      const policyModelId = json.data?.subagent_model_id ?? json.subagent_model_id
      const stablePolicy = this.getSubagentModelPolicy(scopeKey)
      const previousPolicy = `${stablePolicy.mode}:${stablePolicy.modelId ?? ''}`
      const backendPolicy: SubagentModelPolicy = policyMode === 'fixed' && typeof policyModelId === 'string'
        ? { mode: 'fixed', modelId: policyModelId }
        : { mode: 'inherit' }
      this.backendSubagentModelPolicies.set(scopeKey, backendPolicy)
      const policy = this.recomputeSubagentModelPolicy(scopeKey)
      const nextPolicy = `${policy.mode}:${policy.modelId ?? ''}`
      if (previousPolicy !== nextPolicy) {
        log.info(`[Catalog] subagent model policy refreshed: ${nextPolicy}`)
      }
      const snapshot: ModelCatalogEntry[] = []
      for (const m of models) {
        // ：catalog → runtime → Django proxy 的模型引用契约 = DB UUID（routed）
        // 或 `declared:<provider>:<model>`（静态声明）。历史代码 `m.model_name ?? m.name
        // ?? m.id` 优先用裸 model_name（如 "kimi-k2.6"），会把非 UUID 标识透给 proxy
        // 的 `_get_provider_config(model_id=...)`（只认 UUID）→ "模型不存在或未激活" /
        // 误触 capability gate。改为优先 DB UUID，model_name/name 退化为 alias 供
        // findCatalogEntry 按人类可读名匹配；非 UUID/declared 的引用直接挡在 runtime 外。
        const id = m.id ?? m.model_name ?? m.name
        if (!isValidModelRef(id)) {
          log.warn(
            `[Catalog] skip model with non-UUID/declared id="${id ?? ''}" (model_name=${m.model_name ?? m.name ?? '?'})`,
          )
          continue
        }
        const aliases = [m.model_name, m.name].filter(
          (a): a is string => typeof a === 'string' && a.trim().length > 0 && a !== id,
        )
        const ctx = m.context_window_tokens && m.context_window_tokens > 0
          ? m.context_window_tokens
          : FALLBACK_MODEL_CAPABILITIES.contextWindowTokens
        const out = m.max_output_tokens && m.max_output_tokens > 0
          ? m.max_output_tokens
          : FALLBACK_MODEL_CAPABILITIES.maxOutputTokens
        // ：catalog 有该模型但缺 context_window_tokens → 回落 32k 进快照。
        // 之后 dynamicResolveContextWindow 走 findCatalogEntry 命中这份 32k（不再
        // 告警），所以"在目录里但缺字段"这条 32k 路径必须在这里曝光，否则静默
        // 误触发 blocking。
        if (!(m.context_window_tokens && m.context_window_tokens > 0)) {
          log.warn(
            `[Catalog] model "${id}" (name=${m.name ?? m.model_name ?? '?'}) missing ` +
            `context_window_tokens in catalog — falling back to ` +
            `${FALLBACK_MODEL_CAPABILITIES.contextWindowTokens}. pressure/blocking will be ` +
            `computed against this fallback; if the real model has a larger window, expect ` +
            `premature compaction / blocking .`,
          )
        }
        snapshot.push({
          id,
          aliases: aliases.length > 0 ? aliases : undefined,
          displayName: typeof m.display_name === 'string' ? m.display_name : undefined,
          usageHint: typeof m.usage_hint === 'string' ? m.usage_hint : undefined,
          providerScope: typeof m.provider_scope === 'string' ? m.provider_scope : undefined,
          capabilities: {
            contextWindowTokens: ctx,
            maxOutputTokens: out,
            maxInputTokens: ctx,
            supportsVision: m.resolved_capabilities?.supports_vision === true,
            supportsFunctionCalling: m.resolved_capabilities?.supports_function_calling !== false,
            supportsPromptCaching: m.capabilities_config?.supports_prompt_caching === true,
            cacheType: deriveCacheType(m.provider, m.capabilities_config),
            reasoningHistoryPolicy: deriveReasoningHistoryPolicy(m.provider, m.capabilities_config),
          },
        })
      }
      this.stateRoot.model.replaceCatalogSnapshot(scopeKey, snapshot)
      log.info(`[Catalog] refreshed: ${snapshot.length} model(s)`)
    } catch (err) {
      log.warn(`[Catalog] refresh failed (keeping stale snapshot): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * ：CLI enable 后物化 marketplace app skill。
   * skillsModule 未就绪时抛错，由 CLI 路由回滚后端 enable。
   *
   * ：spaceId 降为可选（老布局兼容）；userId 缺失时宿主自己解析当前
   * 登录用户，优先走新布局 `{dataRoot}/users/{userId}/organizations/{orgId}/skills/`。
   */
  async materializeAppSkill(params: {
    organizationId: string
    spaceId?: string
    userId?: string
    appId: string
    slug: string
  }): Promise<{ installed: number; skipped: number; errors: string[] }> {
    if (!this.skillsModule) {
      throw new Error('Skill registry 未初始化')
    }
    const userId = params.userId ?? (await this.resolveSkillUserId())
    const r = await this.skillsModule.materializeAppSkill({ ...params, userId })
    return { installed: r.installed, skipped: r.skipped, errors: r.errors }
  }

  /**
   *  / ：把互操作根（如 ~/.agents/skills）挂进 LocalSkillRegistry 并重扫。
   */
  async addInteropRoot(rootPath: string): Promise<void> {
    if (this.skillsReady) await this.skillsReady
    if (!this.skillsModule) {
      throw new Error('Skill registry 未初始化')
    }
    await this.skillsModule.addInteropRoot(rootPath)
  }

  async stop(): Promise<void> {
    unregisterWorktreeRemoveRuntimeProbe()
    this.agentWorktreeTransitions.clear()
    this.hostStateSync.stop()
    this.hostTrackerScheduler.stop()
    if (this.hostTrackerReconnectUnsubscribe) {
      try { this.hostTrackerReconnectUnsubscribe() } catch { /* best effort */ }
      this.hostTrackerReconnectUnsubscribe = null
    }
    setSpacePrewarmHandler(null)
    setAgentEnablementPrewarmHandler(null)
    setHumanInteractionHooks(undefined)
    this.approvalGate = null
    const sharedHost = this.sharedHost
    this.runHostLeaseCoordinator.stop()
    this.forwardLeaseAbortKeys.clear()
    if (this.runHostLeaseReconnectUnsubscribe) {
      try { this.runHostLeaseReconnectUnsubscribe() } catch { /* best effort */ }
      this.runHostLeaseReconnectUnsubscribe = null
    }

    // 子 Agent 模型自由度（Phase 3/4）：停掉目录定时刷新。
    if (this.catalogRefreshTimer) {
      clearInterval(this.catalogRefreshTimer)
      this.catalogRefreshTimer = null
    }

    // 2026-05-23 push 通知重构 commit 3：摘 NotificationQueue subscribe。
    // unsubscribe 后 bridge 后续 enqueue 不再触发本 host 的 listener，避免 stop 期间
    // 还有 push 触发新 query 跟 sessions.clear() / runtime.dispose() 时序撞车。
    if (this.notificationQueueUnsubscribe) {
      try { this.notificationQueueUnsubscribe() } catch { /* best effort */ }
      this.notificationQueueUnsubscribe = null
    }
    if (this.mcpToolCacheUnsubscribe) {
      try { this.mcpToolCacheUnsubscribe() } catch { /* best effort */ }
      this.mcpToolCacheUnsubscribe = null
    }

    const sessionIds = [...this.sessions.keys()]
    try {
      for (const sid of sessionIds) {
        this.abortSessionForHostStop(sid)
        await sharedHost?.cancelSessionDelivery(sid)
      }
    } finally {
      this.clearAllBrowserControlForHostStop()
    }

    const sessionsSnapshot = [...this.sessions.values()]
    for (const s of sessionsSnapshot) {
      // 清掉 active-plan-tracker，避免 host 重启后 plan-mode-guard 拿到陈旧状态。
      clearAllActivePlansForSession(s.sessionId)
      // W4a S1：dispose 本 session 的 SubagentManager —— 上面 handleAbort 已
      // abort session 级 abortController（级联取消 active 子），这里再清登记表
      // + 兜底 abort，保证 host 关闭时不留悬挂的后台子（PR1 无后台子，防御兜底）。
      s.subagentManager.dispose()
      await s.sessionStorage.dispose()
      // W1.2：触发 NativeBackendSession 的 onShutdown 钩子（best-effort；
      // shutdown 内部 try/catch 不传染）。registry 的 dispose 留给下方
      // 集中处理（多 session 共享同一份 registry）。
      try {
        await s.backendBootstrap?.session.shutdown()
      } catch { /* shutdown 已内吞错误；这里是双层保险 */ }
    }

    // ：清本机 waiter 前，先把仍挂在本机的 PendingInteraction 打成 cancelled，
    // 避免重启后 HitlMessageReconcile 从 hitl_interaction 消息恢复幽灵审批卡。
    await this.cancelHeldPendingInteractionsForRuntimeGone()
    this._modeSwitchHandler?.clearAll()

    this.sharedHost = null
    await sharedHost?.stop()

    // AgentHost.stop 已摘 realtime / approval memo；此处只清平台侧钩子。

    // W1.2：dispose 共享 ExecutionBackendRegistry（由 runtime assembly 持有）
    await this.runtimeAssembly.disposeBackendRegistry()

    // 终端假运行根治 Layer 1：dispose 共享 relay outbox + 解绑重连。
    if (this.relayReconnectUnsubscribe) {
      try { this.relayReconnectUnsubscribe() } catch { /* best effort */ }
      this.relayReconnectUnsubscribe = null
    }
    await this.relayPersistence.dispose()

    // 终端假运行根治 Layer 2：dispose 所有 owner 桶的 ManagedTask 落盘队列（与上面两套
    // 对称）。dispose 会 await 在飞的写（含退出 flush 的 fire-and-forget remove），保证
    // 退出前 tombstone 落盘，避免下次启动重复对账。退出 flush 已在本 stop() 之前跑完。
    for (const q of this.managedTaskQueues.values()) {
      try { await Promise.resolve(q.dispose?.()) } catch { /* best effort */ }
    }
    this.managedTaskQueues.clear()

    if (this.ipcRegistered) {
      for (const ch of [
        'agent-engine:query',
        'agent-engine:abort',
        'agent-engine:get-state',
        'agent-engine:submit-hitl-batch',
        'agent-engine:submit-ask-user-response',
        'agent-engine:cancel-hitl-interaction',
        'agent-engine:mode-switch-execute',
        'agent-engine:cancel-subagent',
        'agent-engine:update-context',
        'agent-engine:reset-account-sync',
        'agent-engine:init-capability-identity',
        'agent-engine:retry-tool',
        'agent-engine:invalidate-user-portrait-cache',
        'agent-engine:prewarm-runtime',
        'agent-engine:skill-credential-invalidate',
        'agent-engine:skill-enablement-invalidate',
        'agent-engine:set-session-context-tier',
        'agent-engine:read-snapshots',
        'agent-engine:check-pending',
        'skill:read-content',
        'agent-security:set-yolo-mode',
        'agent-security:get-workspace-snapshot',
        'agent-security:revoke-memo',
        'agent-security:build-approval-key',
        'agent-security:build-scope-description',
      ]) {
        ipcMain.removeHandler(ch)
      }
      ipcMain.removeHandler('workspace:paths-changed:invoke')
      ipcMain.removeAllListeners('workspace:paths-changed')
      this.ipcRegistered = false
    }

    destroyProactivePoller()

    // per-file 回退引擎：stop 时 flush 各 thread manifest 后清空缓存（保留磁盘备份）。
    await clearAllFileHistory().catch(() => {})

    // ：lifecycle.stop 会解绑 auth/reconnect、清重试定时器并 dispose registry。
    if (this.skillsLifecycle) {
      try {
        await this.skillsLifecycle.stop()
      } catch (err) {
        log.warn('[Skills] skillsLifecycle.stop 抛错（已吞错）:', err)
      }
      this.skillsLifecycle = null
    }
    this.skillsInitContext = null

    if (this.capabilityIdentityAuthUnsubscribe) {
      try {
        this.capabilityIdentityAuthUnsubscribe()
      } catch { /* best effort */ }
      this.capabilityIdentityAuthUnsubscribe = null
    }
    if (this.openAICodexStatusUnsubscribe) {
      try { this.openAICodexStatusUnsubscribe() } catch { /* best effort */ }
      this.openAICodexStatusUnsubscribe = null
    }
    if (this.spaceContextCodeRootUnsubscribe) {
      try {
        this.spaceContextCodeRootUnsubscribe()
      } catch { /* best effort */ }
      this.spaceContextCodeRootUnsubscribe = null
    }
    this.capabilityIdentityBoundUserId = null

    log.info('Stopped')
  }

  reconcileHostState(): Promise<boolean> {
    return this.hostStateSync.reconcile()
  }

  /**
   * ：组装 Skill registry 生命周期。
   * - 启动期预收集 bundled / package / interop 源（不依赖登录）
   * - 登录后 init；失败退避重试；WS 断线重连后重试；登出 teardown
   */
  private async setupSkillsLifecycle(): Promise<void> {
    try {
      const platformDataRoot = resolvePlatformDataRoot()
      const dataRoot = resolveDataRoot()
      const appsRoot = resolveAppsRoot()
      const bundledRoot = resolveBundledRoot()
      const packageSkillsRoot = resolvePackageSkillsRoot()
      log.info(
        `[Skills] initSkillsModule params: dataRoot=${dataRoot}, platformDataRoot=${platformDataRoot}, appsRoot=${appsRoot}, bundledRoot=${bundledRoot}, packageSkillsRoot=${packageSkillsRoot}`,
      )

      const {
        collectPlatformSources,
        collectAppSources,
        collectPackageSkillSources,
      } = await import('@tabtin/agent-host/skills')
      const preinstallSources = [
        ...(bundledRoot ? await collectPlatformSources(bundledRoot) : []),
        ...(appsRoot ? await collectAppSources(appsRoot) : []),
        ...(packageSkillsRoot ? await collectPackageSkillSources(packageSkillsRoot) : []),
      ]
      log.info(`[Skills] collected ${preinstallSources.length} preinstall sources`)

      const interopRoots = resolveDefaultInteropRoots()
      log.info(`[Skills] interopRoots=${JSON.stringify(interopRoots)}`)

      const sharedSkillsDir = path.join(dataRoot, '_shared-skills')
      log.info(`[Skills] sharedSkillsDir=${sharedSkillsDir}`)

      this.skillsInitContext = {
        dataRoot,
        platformDataRoot,
        appsRoot,
        packageSkillsRoot,
        sharedSkillsDir,
        preinstallSources,
        interopRoots,
      }

      this.skillsLifecycle = new SkillsModuleLifecycle<SkillsModuleHandle>({
        resolveUserId: () => this.resolveSkillUserId(),
        initModule: (userId) => this.runSkillsModuleInit(userId),
        disposeModule: async () => {
          try {
            await disposeSkillsModule()
          } catch (err) {
            log.warn('[Skills] disposeSkillsModule 抛错（已吞错）:', err)
          }
        },
        // 过期 init 只关自己的 watcher，避免 disposeSkillsModule 误伤并发新 init
        disposeOrphan: async (handle) => {
          try {
            await handle.watcher.close()
          } catch (err) {
            log.warn('[Skills] disposeOrphan watcher.close 抛错（已吞错）:', err)
          }
        },
        onAuthChanged: (cb) => TokenManager.onAuthChanged(cb),
        // 断线重连 = WS gateway reconnect（非 navigator.onLine）
        onReconnect: (cb) => electronWsGateway.onReconnect(cb),
        logger: {
          info: (message, ...args) => log.info(message, ...args),
          warn: (message, ...args) => log.warn(message, ...args),
        },
      })
      this.skillsLifecycle.start()
      log.info('[Skills] lifecycle started (init deferred until authenticated)')
    } catch (err) {
      log.warn('[Skills] setupSkillsLifecycle 抛同步错误（已吞错，skills 功能将关闭）:', err)
      this.skillsLifecycle = null
      this.skillsInitContext = null
    }
  }

  /** 登录后真正执行的 initSkillsModule + migrate + ensureUserSkills + watcher 广播。 */
  private async runSkillsModuleInit(userId: string): Promise<SkillsModuleHandle> {
    const ctx = this.skillsInitContext
    if (!ctx) {
      throw new Error('Skills init context missing — setupSkillsLifecycle did not complete')
    }

    try {
      const report = await migrateLegacyPlatformDataToDataRoot({
        dataRoot: ctx.dataRoot,
        legacyPlatformDataRoot: ctx.platformDataRoot,
        userId,
        logger: {
          info: (m) => log.info(m),
          warn: (m) => log.warn(m),
          error: (m) => log.error(m),
        },
      })
      log.info(
        `[Skills] storage migration: movedSkills=${report.movedSkills} skipped=${report.skippedSkills} errors=${report.errors.length}`,
      )
    } catch (err) {
      log.warn('[Skills] storage migration failed (non-fatal):', err)
    }

    const handle = await initSkillsModule({
      dataRoot: ctx.dataRoot,
      userId,
      preinstallSources: ctx.preinstallSources,
      interopRoots: ctx.interopRoots,
      sharedSkillsDir: ctx.sharedSkillsDir,
      appsRoot: ctx.appsRoot,
      packageSkillsRoot: ctx.packageSkillsRoot,
      skillRecall: new RecallIndex({ scorer: getSemanticScorer() }),
      hiddenSkills: TEMPORARILY_HIDDEN_SKILLS,
    })
    log.info(
      `[Skills] initSkillsModule ready (${handle.registry.listAll().length} skills indexed)`,
    )

    await handle.ensureUserSkills(userId)

    const broadcastSkillsChanged = () => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('skills:dir-changed')
        }
      }
    }
    handle.watcher.onChange(broadcastSkillsChanged)
    // 登录后首次 ready：主动通知渲染层失效列表，避免干等 React Query 重试间隔
    broadcastSkillsChanged()
    // ：登录后技能索引就绪，再暖一轮宿主目录（CLI 可能依赖 auth 环境）。
    void this.warmHostCapabilityCatalogs('skills-ready')

    return handle
  }

  // ─── agent-host-full-migration: composed query engine ────────────────
  //
  // Query now flows: submitQuery → mapToHostQuery → AgentHost.submitHostQuery →
  // QueryTurnPipeline → RuntimeSessionLifecycle (reusing the assembly's single
  // factory) + DeliveryCoordinator. This host only supplies data/IO ports and
  // the request mapper — no execute closure, no main loop, no terminal race.

  /** Per-turn platform context (raw request + sender), keyed by runId. */
  private readonly pendingTurnCtx = new Map<string, { request: QueryRequest; sender: StreamEventSink }>()
  private readonly archiveSeedInFlight = new Map<string, Promise<{ seeded: boolean; reason: string }>>()
  /** ：仅实际执行中的轮次持有 CLI scope lease；排队项不提前占位。 */
  private readonly cliWorkspaceScopeTurns = new CLIWorkspaceScopeTurnLeaseManager()

  /**
   * RuntimeResourceFactory = shared factory adapter (reuse/soft/rebuild) merged
   * with owner-teardown methods. The lifecycle reuses the assembly's factory
   * instance so there is exactly one per-session serialization lock.
   */
  private buildElectronResourceFactory(): RuntimeResourceFactory<
    RuntimeBuildInput, HostState, AgentModeName, RuntimeCarryForward, RuntimeDisabledAppsExtraKey
  > {
    const ownerAdapter = this.buildOwnerAdapter()
    return {
      ...this.runtimeAssembly.getRuntimeFactoryAdapter(),
      getOwner: ownerAdapter.getOwner,
      getConversationIdentity: ownerAdapter.getConversationIdentity,
      interruptSession: ownerAdapter.interruptSession,
      teardownSession: ownerAdapter.teardownSession,
      disposeOwnerResources: ownerAdapter.disposeOwnerResources,
    }
  }

  /** DeliveryTransportPort: IpcStreamHost local fan-out (via AgentRealtime) + WS relay. */
  private buildElectronDeliveryTransport(): DeliveryTransportPort {
    return {
      openLocalStream: ({ sessionId, conversationId }) => {
        const routerSink: IpcStreamSender = {
          send: (_channel, envelope) => this.sharedHost?.broadcast(envelope as AgentStreamEnvelope) ?? 0,
          isDestroyed: () => false,
        }
        // ：envelope.sessionId 必须是原始 ChatSession UUID，不能是 prompt_*。
        const streamSessionId = resolveLocalStreamSessionId({
          conversationId,
          sessionId,
          resolveBusinessId: (candidate) => {
            const direct = this.sessions.get(candidate)
            if (direct?.businessThreadId) return direct.businessThreadId
            for (const session of this.sessions.values()) {
              if (
                session.sessionId === candidate
                || session.businessThreadId === candidate
                || session.businessThreadId === `chat-session-${candidate}`
              ) {
                return session.businessThreadId || session.sessionId
              }
            }
            return null
          },
        })
        const streamHost = new IpcStreamHost<StreamEvent>(
          routerSink,
          AGENT_STREAM_EVENT_CHANNEL,
          streamSessionId,
          { heartbeatIntervalMs: 15_000 },
        )
        const port: LocalStreamPort = {
          emit: (event) => streamHost.emit(event),
          fail: (error) => streamHost.fail(error),
          close: (reason) => streamHost.close(reason === 'completed' ? 'completed' : 'aborted'),
          shouldAbortIteration: () => false,
        }
        return port
      },
      sendRelayBatch: async (ctx, events) => {
        const token = await TokenManager.getAccessToken()
        if (!token) throw new Error('relay_events missing access token')
        const response = await electronWsGateway.request(
          { token, organizationId: ctx.organizationId },
          'relay_events',
          { session_id: ctx.sessionId, events },
        )
        // ：与 recover 路径同一套解析——timeout / schema 在
        // response.error.code，不是 payload.error_code；手写只读 payload
        // 会把 WS_REQUEST_TIMEOUT 洗成 unknown/false，放大重试雪崩。
        assertRelayAck(response)
        const messageIds = response?.payload?.message_ids
        return { messageIds: Array.isArray(messageIds) ? messageIds : undefined }
      },
      uploadLlmSnapshot: async (ctx, payload) => {
        const token = await TokenManager.getAccessToken()
        if (!token) throw new Error('llm snapshot HTTP missing access token')
        await postLlmSnapshotHttp({
          apiBaseUrl: API_BASE_URL,
          sessionId: ctx.sessionId,
          organizationId: ctx.organizationId,
          accessToken: token,
          payload,
          joinApiPath,
        })
      },
      createOutboxStore: () => ({
        persist: () => undefined,

        drain: async function* () { return },
        remove: () => undefined,
      }),
      subscribeReconnect: (listener) => electronWsGateway.onReconnect(listener),
    }
  }

  /** Durable outbox + reconnect recovery, backed by the existing outbox/orchestrator. */
  private buildElectronDurableLayer(): DeliveryDurableLayer {
    return {
      send: async (ctx, event) => {
        await this.relayPersistence.send(
          ctx.owner as PersistedEntryOwner | undefined,
          ctx.sessionId,
          [{ type: event.type, payload: event.payload }],
        )
      },
      persist: (ctx, events) => {
        this.relayPersistence.onExhausted(
          ctx.owner as PersistedEntryOwner | undefined,
          ctx.sessionId,
          events,
        )
      },
      kickRecoverAndBackfill: async (opts) => {
        await this.relayOrchestrator.kickRecoverAndBackfill(opts)
      },
      stop: async () => {
        await this.relayPersistence.dispose()
      },
    }
  }

  /** QueryTurnDataPort: every method is data/IO — no flow control. */
  private buildElectronQueryDataPort(deps: {
    lifecycle: QueryTurnDataPort<HostState, RuntimeBuildInput, AgentModeName, RuntimeDisabledAppsExtraKey>['lifecycle']
    delivery: QueryTurnDataPort<HostState, RuntimeBuildInput, AgentModeName, RuntimeDisabledAppsExtraKey>['delivery']
  }): QueryTurnDataPort<HostState, RuntimeBuildInput, AgentModeName, RuntimeDisabledAppsExtraKey> {
    const ctxOf = (runId: string) => this.pendingTurnCtx.get(runId)
    return {
      lifecycle: deps.lifecycle,
      delivery: deps.delivery,
      log: { info: (m) => log.info(m), warn: (m, d) => log.warn(m, d) },
      sessionView: (s) => s as unknown as QueryTurnSessionView,
      runtimeOf: (s) => s.runtime,
      organizationIdOf: (_s, q) => {
        const ctx = ctxOf(q.identity.runId)
        return ctx?.request.organizationId ?? getCLIOrganizationId() ?? q.identity.owner.organizationId
      },
      //  / ：本轮档案只走 loadHostTurnBundle（与 prepareTurnInputs 共用缓存）。
      fetchAuthoritative: async (args) => {
        const workspaceId =
          args.workspaceId ?? this.sessions.get(args.sessionId)?.workspaceId
        try {
          const { agentConfig } = await loadHostTurnBundle({
            agentId: args.agentId,
            workspaceId,
            getOrganizationId: () => getCLIOrganizationId() ?? null,
          })
          return agentConfig
        } catch (err) {
          // bundle 设计上不抛；若未来回归，必须带明文进 setup catch。
          log.error(
            `[host-turn-bundle] fetchAuthoritative threw `
              + `agent=${args.agentId.slice(0, 8)}… `
              + `workspace=${workspaceId ? `${String(workspaceId).slice(0, 8)}…` : 'none'} `
              + `error_message=${err instanceof Error ? err.message : String(err)}`,
          )
          throw err
        }
      },
      reconcileAllowedPaths: (dst) => {
        this.workspaceBoundary.reconcileSnapshot(
          dst as unknown as import('@tabtin/security-policy').WorkspaceSnapshot,
          { type: 'refresh' },
        )
      },
      // ACK 之后补齐规则 / limits / snapshot；DETAIL 命中 fetchAuthoritative 同一 bundle。
      prepareTurnInputs: async ({ query }) => {
        const ctx = ctxOf(query.identity.runId)
        if (!ctx) {
          log.warn(
            `[host-turn-bundle] prepareTurnInputs missing pending ctx `
              + `run=${query.identity.runId.slice(0, 8)}…`,
          )
          return
        }

        // 在局部副本上完成全部 hydrate；成功前不暴露半完成状态给本轮其它端口。
        const request = { ...ctx.request }
        const workspaceId = request.workspaceId ?? query.policy?.workspaceId
        const agentId = request.agentId ?? query.policy?.agentId
        let bundle: Awaited<ReturnType<typeof loadHostTurnBundle>>
        try {
          bundle = await loadHostTurnBundle({
            agentId,
            workspaceId,
            getOrganizationId: () =>
              request.organizationId ?? getCLIOrganizationId() ?? null,
          })
          assertHostTurnAgentResolved(bundle, agentId)
        } catch (err) {
          log.error(
            `[host-turn-bundle] prepareTurnInputs threw `
              + `run=${query.identity.runId.slice(0, 8)}… `
              + `error_message=${err instanceof Error ? err.message : String(err)}`,
          )
          throw err
        }

        const profile = bundle.profile

        if (profile.customRules) request.customRules = profile.customRules
        if (profile.personalRules) request.personalRules = profile.personalRules
        if (profile.agentName) request.agentName = profile.agentName
        if (profile.workspaceRules) request.workspaceRules = profile.workspaceRules
        if (profile.executionLimits) {
          request.executionLimits = profile.executionLimits
          if (
            request.maxTurns == null
            && typeof profile.executionLimits.max_iterations_per_run === 'number'
            && profile.executionLimits.max_iterations_per_run >= 1
          ) {
            request.maxTurns = profile.executionLimits.max_iterations_per_run
          }
        }
        const workspaceDetail = bundle.workspaceDetail
        if (workspaceDetail) {
          request.workingDir = workspaceDetail.working_dir || undefined
          const workingDirType = workspaceDetail.working_dir_type
          request.workingDirType =
            workingDirType === 'code' || workingDirType === 'doc' || workingDirType === 'mixed'
              ? workingDirType
              : undefined
          request.spaceName = typeof workspaceDetail.name === 'string'
            ? workspaceDetail.name
            : request.spaceName
          this.workspaceBoundary.apply(this.sessions.values(), {
            type: 'paths-changed',
            payload: {
              spaceId: workspaceId,
              workingDir: workspaceDetail.working_dir,
            },
          })
        }
        if (bundle.organizationDetail?.name) {
          request.organizationName = bundle.organizationDetail.name
        }
        if (bundle.runtimeConfig) {
          request.operationSwitches = bundle.runtimeConfig.operationSwitches
          request.memoryCapability = bundle.runtimeConfig.memoryCapability
          request.enabledApps = bundle.runtimeConfig.enabledApps
        }

        // skillSlashInvoke：显式斜杠优先；否则从 contextBlocks / filtered userMessageBlocks 的 composer_preset 派生
        const skillSourceBlocks = request.contextBlocks
          ?? filterHostPromptContextBlocks(request.userMessageBlocks)
        if (!request.skillSlashInvoke?.skillKey && skillSourceBlocks?.length) {
          const derived = resolveComposerPresetSkillInvoke(skillSourceBlocks)
          if (derived?.skillKey) request.skillSlashInvoke = derived
        }

        const spaceId = request.spaceId
          ?? (typeof request.appContext?.spaceId === 'string' ? request.appContext.spaceId : undefined)
        if (spaceId && !request.workspaceSnapshot) {
          const snapshot = this.workspaceBoundary.getSnapshot(this.sessions.values(), spaceId)
          if (snapshot) request.workspaceSnapshot = snapshot
        }

        const policy = {
          ...query.policy,
          agentId: request.agentId ?? query.policy?.agentId,
          workspaceId: workspaceId ?? query.policy?.workspaceId,
          workspaceSnapshot: request.workspaceSnapshot ?? query.policy?.workspaceSnapshot,
          agentProfile: {
            agentName: request.agentName,
            customRules: request.customRules,
            workspaceRules: request.workspaceRules,
          },
        }

        // 用补齐后的 request 重建 runtime 输入，使 CostCap / personalRules 进 acquire。
        if (ctx.sender) {
          try {
            const runtime = this.runtimeAssembly.buildRequestFromQuery(
              request,
              ctx.sender,
              query.identity.owner,
            )
            ctx.request = request
            return { policy, runtime }
          } catch (err) {
            log.error(
              `[host-turn-bundle] buildRequestFromQuery threw `
                + `run=${query.identity.runId.slice(0, 8)}… `
                + `has_workspace=${Boolean(request.workspaceId)} `
                + `has_org=${Boolean(request.organizationId)} `
                + `has_space=${Boolean(request.spaceId)} `
                + `error_message=${err instanceof Error ? err.message : String(err)}`,
            )
            throw err
          }
        }
        ctx.request = request
        return { policy, runtime: query.runtime }
      },
      afterSessionReady: ({ session, query }) => {
        const request = ctxOf(query.identity.runId)?.request
        if (request) {
          this.cliWorkspaceScopeTurns.start({
            runId: query.identity.runId,
            sessionId: query.identity.sessionId,
            threadIds: [request.businessThreadId, request.threadId],
            scopeKey: request.appContext?.workspaceScopeKey ?? request.appContext?.tabScopeKey ?? null,
          })
        }
        // pre-stream 停止：用户 abort 时 Map/activeRuns 可能还没有本轮，在此兑现。
        const abortThisTurn = this.consumeAbortRequest(
          query.identity.sessionId,
          query.identity.conversationId,
          request?.threadId,
          request?.businessThreadId,
        )
        if (abortThisTurn) {
          try { session.abortController.abort() } catch { /* best effort */ }
          try {
            this.requireSharedHost().abort({
              conversationId: query.identity.conversationId,
              sessionId: query.identity.sessionId,
            })
          } catch { /* best effort */ }
        } else if (session.abortController.signal.aborted) {
          // 上一轮 abort 留下的 controller：本轮未取消则换新，供 runtime.query 绑定。
          session.abortController = new AbortController()
        }
        query.clientDisconnect?.addEventListener('abort', () => {
          try { session.abortController.abort() } catch { /* best effort */ }
        })
      },
      buildEffectivePrompt: async ({ query }) => {
        const ctx = ctxOf(query.identity.runId)
        const request = ctx?.request
        if (!request) return query.turn.prompt

        // ：用户原文 → quoted → preset/@引用（ACK 之后拼装，不挡 IPC）
        // forward：contextBlocks 缺省时从 userMessageBlocks 去掉 type===text 气泡正文派生
        const assembled = await assembleHostPromptContext({
          message: query.turn.prompt,
          replyTo: request.replyTo,
          contextBlocks: request.contextBlocks
            ?? filterHostPromptContextBlocks(request.userMessageBlocks),
          staleAfterTurn: request.clientMessageId ?? query.identity.runId,
          log: {
            info: (...args) => log.info(...args),
            warn: (...args) => log.warn(...args),
          },
          resolveContextBlocks: (blocks) => resolveHostContextBlocks(blocks, {
            organizationId: request.organizationId ?? getCLIOrganizationId() ?? null,
          }),
        })

        // 交接场景：消息含截断的 conversation_reference 时拉完整快照替换
        const prompt = await enrichHandoffTranscript(assembled)
        const attachmentsMissingIdentity = findAttachmentsMissingResourceIdentity(request.attachments ?? [])
        if (attachmentsMissingIdentity.length > 0) {
          throw new AgentError(
            `附件缺少资源引用，请重新添加：${attachmentsMissingIdentity.join('、')}`,
            'INTERNAL',
            { statusCode: 400, retryable: false },
          )
        }
        const attachmentMetadata = formatAttachmentResourceMetadata(request.attachments ?? [], {
          turnId: request.clientMessageId,
        })
        return [prompt, attachmentMetadata].filter(Boolean).join('\n\n')
      },
      prepareRuntimeAttachments: async () => [],
      prepareInitialMessages: async (messages) =>
        rewriteUnreachableImageUrlsInMessages(
          projectHistoricalFileBlocksAsResources(messages),
          async (url) => {
            const fetched = await getResourceDownloadService().fetchToBuffer({ url, maxBytes: LLM_IMAGE_DATA_URL_MAX_BYTES })
            return nodeBufferToAgentDataUrl(fetched.buffer, fetched.mimeType)
          },
          (url, err) => {
            let host = 'invalid-url'
            try { host = new URL(url).host } catch { /* diagnostic only */ }
            log.warn(`[llm-image] historical image omitted url_host=${host} error=${err instanceof Error ? err.message : String(err)}`)
          },
        ),
      buildQueryParams: (base, query) => {
        const ctx = ctxOf(query.identity.runId)
        const request = ctx?.request
        if (!request) return base
        // `agent.prompt.forward`（移动端、跨端会话）不会携带 IPC 专用的
        // maxTurns；此时必须从 Django 已下发的 Workspace execution_limits
        // 取迭代上限。否则 Electron 会把 undefined 传给 runtime，静默回退
        // DEFAULT_MAX_TURNS（500），使用户配置的上限失效。
        // 与 DaemonAgentHost 的 forward 路径保持相同优先级：显式 maxTurns
        // 优先，缺省才使用 Workspace / Agent 解析后的 executionLimits。
        const effectiveMaxTurns = request.maxTurns
          ?? request.executionLimits?.max_iterations_per_run
          ?? undefined
        const attachmentMessageBlocks = buildAttachmentMessageBlocks(request.attachments)
        const userMessageBlocks = [
          ...(request.userMessageBlocks ?? []),
          ...(attachmentMessageBlocks ?? []),
        ]
        return {
          ...base,
          systemPrompt: request.systemPrompt,
          maxTurns: effectiveMaxTurns,
          displayMessage: request.displayMessage,
          ...(request.skillSlashInvoke?.skillKey ? { skillSlashInvoke: request.skillSlashInvoke } : {}),
          ...(request.replyTo?.messageId ? { replyTo: request.replyTo } : {}),
          ...(userMessageBlocks.length > 0 ? { userMessageBlocks } : {}),
          ...(request.pendingApprovalsSerialized && request.pendingApprovalsSerialized.length > 0
            ? { pendingApprovalsSerialized: request.pendingApprovalsSerialized }
            : {}),
          // ：单 HITL 断点恢复。与 pendingApprovalsSerialized 对称，
          // 仅在 forward.resume 路径上非空；常规 IPC query 缺省。
          ...(request.pendingSingleHitlSerialized && request.pendingSingleHitlSerialized.length > 0
            ? { pendingSingleHitlSerialized: request.pendingSingleHitlSerialized }
            : {}),
        }
      },
      appendStreamEventToSessionStorage: async (session, event) => {
        // ：归属只在 host——persist 时按 message_id 记账，不进 blocks / history。
        const sessionDir = path.dirname(session.sessionStorage.blockStorage.filePath)
        rememberAttributionFromPersistEvent(
          event,
          session.owner.agentId,
          sessionDir,
        )
        await this.appendStreamEventToSessionStorage(session.sessionStorage, event, session.toolLogWriter)
      },
      onTurnTerminalPersisted: (_sessionId, query, event) => {
        const metadata = (event.payload as { metadata?: { run_state?: unknown } } | undefined)
          ?.metadata
        if (metadata?.run_state === 'host_handoff') {
          this.agentWorktreeTransitions.markHandoffPersisted(query.identity.runId)
        }
      },
      flushTurnStorage: async (session) => {
        await session.sessionStorage.dispose()
        await session.snapshotStorage.dispose().catch(() => undefined)
        await session.eventStorage.dispose().catch(() => undefined)
      },
      reconcileSessionRelayBackfill: (session, conversationId) => {
        void this.reconcileSessionRelayBackfill(session, conversationId).catch((err) => {
          log.warn(`[RelayReconcile] pre-query backfill failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      },
      buildLifecycleErrorEvent: (session, error) => {
        const message = error instanceof Error ? error.message : String(error)
        const code = (error as { code?: string }).code
        const emitter = session.eventEmitter ?? new EventEmitter(undefined, {
          threadId: session.sessionId,
          traceId: session.sessionId,
          runId: session.sessionId,
        })
        return correlateSourceClientEvent(
          emitter.build(new RuntimeLifecycleEvent({
            phase: 'error',
            status: 'error',
            error_message: message,
            detail: code ?? 'INTERNAL',
          })),
          undefined,
        )
      },
      projectPersistedEvent: (session, messageIds) => {
        const emitter = session.eventEmitter
        if (!emitter) return undefined
        return emitter.build(new MessagePersistedEvent(
          messageIds,
          `persisted:${session.sessionId}:${JSON.stringify(messageIds)}`,
        ))
      },
      // ：排队态由 agent.stream.run_sync.queued_run_ids 承载，停发
      // MESSAGE_QUEUED / DEQUEUED，避免前端再接回 markRunQueued。
      onQueued: (query, position) => {
        log.info(
          `[HostQueue] enqueued `
            + `run=${query.identity.runId.slice(0, 8)}… `
            + `session=${query.identity.sessionId.slice(0, 8)}… `
            + `position=${position}`,
        )
      },
      onDequeued: (query) => {
        log.info(
          `[HostQueue] drain from queue `
            + `run=${query.identity.runId.slice(0, 8)}… `
            + `session=${query.identity.sessionId.slice(0, 8)}…`,
        )
      },
      // ：streaming 终态即释放 CLI scope，避免 drain 下一轮 afterSessionReady 撞 overlap。
      onTurnStreamingDone: async (sessionId, query, result) => {
        if (result.success) {
          await this.commitPendingAgentWorktreeTransition(sessionId, query.identity.runId)
        } else {
          // runtime/delivery 任一环节失败都不能提交：此时不能证明切换命令的
          // tool_result 与 host_handoff done 已完整持久化。
          this.agentWorktreeTransitions.discardRun(query.identity.runId)
        }
        this.cliWorkspaceScopeTurns.settle(sessionId, query.identity.runId)
        log.info(
          `[HostQueue] CLI scope settled at streaming done `
            + `run=${query.identity.runId.slice(0, 8)}… `
            + `session=${sessionId.slice(0, 8)}…`,
        )
      },
      onTurnError: (error, query, aborted) => {
        this.settleHostTrackerSession(
          query.identity.sessionId,
          aborted ? 'cancelled' : (error instanceof Error ? error.message : String(error)),
        )
        if (aborted) return
        const classified = classifyError(error)
        if (!isReportableRunError(classified.category)) return
        log.error('[AgentRun] turn failed', {
          ...buildRunErrorLogContext(error, classified),
          runId: query.identity.runId.slice(0, 8),
          sessionId: query.identity.sessionId.slice(0, 8),
        })
        const request = this.pendingTurnCtx.get(query.identity.runId)?.request
        captureRunError(error, {
          handled_by: 'electron_agent_host',
          error_category: classified.category === 'doom_loop'
            ? 'AGENT_DOOM_LOOP'
            : 'AGENT_RUN_FATAL',
          error_code: classified.code,
          run_id: query.identity.runId,
          session_id: query.identity.sessionId,
          organization_id: query.identity.owner.organizationId,
          workspace_id: query.policy?.workspaceId,
          space_id: request?.spaceId,
          agent_id: query.policy?.agentId,
          task_id: query.turn.taskId,
        })
      },
      onTurnFinally: (sessionId, query) => {
        this.settleHostTrackerSession(sessionId)
        this.agentWorktreeTransitions.discardRun(query.identity.runId)
        // 幂等兜底：setup 失败未走 streaming done、或旧路径仍依赖 finally。
        this.cliWorkspaceScopeTurns.settle(sessionId, query.identity.runId)
        this.notificationDrain.schedule(sessionId)
        // ：与 submitQuery 的 settle.finally 幂等；turn 结束即清登记。
        this.finishAcceptedQueryRegistration(query.identity.runId)
      },
    }
  }

  /** Install the composed deep-module query engine, reusing the assembly factory. */
  private installComposedQueryEngine(): void {
    const sharedHost = this.sharedHost
    if (!sharedHost) return
    sharedHost.composeQueryEngine<
      RuntimeBuildInput, AgentModeName, RuntimeCarryForward, RuntimeDisabledAppsExtraKey
    >({
      resources: this.buildElectronResourceFactory(),
      factory: this.runtimeAssembly.getRuntimeFactory(),
      deliveryTransport: this.buildElectronDeliveryTransport(),
      durable: this.buildElectronDurableLayer(),
      llmSnapshotLedgerDirectory: new FileLlmSnapshotLedgerDirectory(
        resolveLlmSnapshotLedgerDir(resolveDataRoot()),
      ),
      buildDataPort: (deps) => this.buildElectronQueryDataPort(deps),
      applyLivePolicy: (session, update) => {
        applyAuthoritativeSecurityMutate(session as unknown as QueryPipelineSession, {
          allowYolo: update.allowYolo === true,
          approvalGrant: update.approvalGrant,
          agentMode: update.agentMode ?? session.policyContext.currentAgentMode,
          requestedApprovalMode: update.requestedApprovalMode,
          isGroupSpace: update.isGroupSpace ?? session.policyContext.isGroupSpace,
        })
      },
    })
  }

  /** Map a platform QueryRequest into the normalized HostQuery. */
  private mapToHostQuery(
    request: QueryRequest,
    sender: StreamEventSink,
    owner: PersistedEntryOwner,
    runId: string,
  ): HostQuery<RuntimeBuildInput, AgentModeName, RuntimeDisabledAppsExtraKey> {
    const conversationId = request.businessThreadId ?? request.threadId
    let clientDisconnect: AbortSignal | undefined
    if (sender.onceDestroyed) {
      const controller = new AbortController()
      sender.onceDestroyed(() => {
        try { controller.abort() } catch { /* best effort */ }
      })
      clientDisconnect = controller.signal
    }
    return {
      identity: { conversationId, sessionId: request.threadId, runId, owner },
      runtime: this.runtimeAssembly.buildRequestFromQuery(request, sender, owner),
      turn: {
        prompt: request.prompt,
        interruptActive: request.interruptActive,
        attachments: request.attachments,
        // ：IPC 路径不传 history；runLoopAndDeliver 只读本机 transcript
        clientMessageId: request.clientMessageId,
        senderUserId: request.senderUserId,
        skillSlashInvoke: request.skillSlashInvoke,
        triggeredBy: request.triggeredBy as HostTriggerSource | undefined,
        displayMessage: request.displayMessage,
        taskId: request.taskId,
        relaySessionId: request.relaySessionId,
        // 空正文 + 仅 @/preset 时 beginSubmit 靠此字段认有效输入；落盘也走此字段。
        userMessageBlocks: request.userMessageBlocks
          ?? (request.contextBlocks && request.contextBlocks.length > 0
            ? request.contextBlocks
            : undefined),
      },
      policy: {
        agentId: request.agentId,
        // ：与 buildRequestFromQuery 同一 sticky 校正，避免 policyContext 被陈旧 plan 打回。
        agentMode: resolveRuntimeModeAgainstSticky(
          request.agentMode ?? 'agent',
          this.sessions.get(request.threadId)?.modeAuthoritySticky,
        ),
        approvalMode: request.approvalMode,
        isGroupSpace: request.isGroupSpace,
        yoloModeFromWire: request.yoloMode,
        workspaceId: request.workspaceId,
        workspaceSnapshot: request.workspaceSnapshot,
        appContext: request.appContext,
        agentProfile: {
          agentName: request.agentName,
          customRules: request.customRules,
          workspaceRules: request.workspaceRules,
        },
      },
      clientDisconnect,
    }
  }

  // ─── IPC: query ─────────────────────────────────────────────────

  private async publishPreSubmitFailureTerminal(
    request: QueryRequest,
    runId: string,
    errorClass: string,
    errorMessage: string,
    owner?: PersistedEntryOwner,
  ): Promise<void> {
    const relaySessionId =
      request.relaySessionId ?? request.businessThreadId ?? request.threadId
    if (!relaySessionId) return
    try {
      if (owner) this.relayPersistence.activateOwner(owner)
      await this.relayPersistence.send(
        owner,
        relaySessionId,
        [{
          type: 'agent.stream.done',
          payload: {
            run_id: runId,
            stop_reason: 'host_setup_failed',
            error: true,
            error_class: errorClass,
            error_message: errorMessage,
            host_confirmed: true,
          },
        }],
      )
    } catch (error) {
      log.warn('[submitQuery] pre-submit terminal delivery failed', {
        runId,
        relaySessionId,
        error: String(error),
      })
    }
  }

  /**
   *  / ：把一轮 query 提交给 per-session 串行队列。
   * 忙则入队（run_sync status=queued）。IPC 在队列接受后即 ACK；
   * settle 后台继续，流终态由 lifecycle / run_sync 驱动。
   */
  private async submitQuery(
    request: QueryRequest,
    sender: StreamEventSink,
    options: { registerAuthoritativeRun?: boolean } = {},
  ): Promise<QueryResult> {
    const operationKeys = this.queryOperationKeys(request)
    if (operationKeys.some(key => this.timelineRewriteOperationKeys.has(key))) {
      return {
        success: false,
        error: 'Conversation timeline rewrite is in progress; retry after it finishes',
      }
    }
    for (const key of operationKeys) {
      this.pendingQueryOperationKeys.set(key, (this.pendingQueryOperationKeys.get(key) ?? 0) + 1)
    }
    try {
      return await this.submitQueryAfterOperationGate(request, sender, options)
    } finally {
      for (const key of operationKeys) {
        const remaining = (this.pendingQueryOperationKeys.get(key) ?? 1) - 1
        if (remaining > 0) this.pendingQueryOperationKeys.set(key, remaining)
        else this.pendingQueryOperationKeys.delete(key)
      }
    }
  }

  private queryOperationKeys(request: QueryRequest): string[] {
    return [...new Set([
      request.threadId,
      request.businessThreadId,
      request.relaySessionId,
      request.threadId.startsWith('chat-session-')
        ? request.threadId.slice('chat-session-'.length)
        : undefined,
    ].filter((value): value is string => Boolean(value)))]
  }

  private timelineRewriteKeys(sessionId: string): string[] {
    const keys = new Set([sessionId, `chat-session-${sessionId}`])
    for (const session of this.sessions.values()) {
      if (
        session.sessionId === sessionId
        || session.businessThreadId === sessionId
        || session.businessThreadId === `chat-session-${sessionId}`
      ) {
        keys.add(session.sessionId)
        if (session.businessThreadId) keys.add(session.businessThreadId)
      }
    }
    return [...keys]
  }

  /** 同步占位；返回 null 表示已有/正在提交 run，调用方必须零副作用拒绝。 */
  private tryAcquireTimelineRewrite(sessionId: string): (() => void) | null {
    const keys = this.timelineRewriteKeys(sessionId)
    if (
      keys.some(key => this.timelineRewriteOperationKeys.has(key))
      || keys.some(key => (this.pendingQueryOperationKeys.get(key) ?? 0) > 0)
      || this.isSessionBusyForCodeRootBind(sessionId)
    ) {
      return null
    }
    for (const key of keys) this.timelineRewriteOperationKeys.add(key)
    return () => {
      for (const key of keys) this.timelineRewriteOperationKeys.delete(key)
    }
  }

  private async submitQueryAfterOperationGate(
    request: QueryRequest,
    sender: StreamEventSink,
    options: { registerAuthoritativeRun?: boolean } = {},
  ): Promise<QueryResult> {
    const runId = request.runId ?? request.clientMessageId ?? crypto.randomUUID()
    // terminal outbox 的 fallback organizationId 读取 CLI context；必须先于
    // resolveOwner/sharedHost 两条 early-return 同步，避免失败终态被静默跳过。
    syncCLISpaceContextFromQueryRequest(request.spaceId, request.organizationId)
    setCLIWorkspaceScopeKey(
      request.appContext?.workspaceScopeKey ?? request.appContext?.tabScopeKey ?? null,
    )
    // org 上下文此刻才稳定：补 restore，供本轮 boundCodeRoot / allowedPaths 使用。
    await this.sessionCodeRootBindings.ensureRestored()
    let owner: PersistedEntryOwner
    try {
      owner = await this.resolveOwner(request.agentId, request.organizationId)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      await this.publishPreSubmitFailureTerminal(
        request,
        runId,
        'OWNER_RESOLUTION_FAILED',
        errorMessage,
      )
      return {
        success: false,
        error: errorMessage,
      }
    }

    const sharedHost = this.sharedHost
    if (!sharedHost) {
      const errorMessage = 'AgentHost is not started'
      await this.publishPreSubmitFailureTerminal(
        request,
        runId,
        'HOST_NOT_STARTED',
        errorMessage,
        owner,
      )
      return { success: false, error: errorMessage }
    }

    // CLI Space/Organization globals were synced before the early-return paths above.
    // Fill the organizationRoot fallback before building the runtime request.
    let localRegistrationClosed = false
    let localLeaseTracked = false
    // /#9734：IPC 早 ACK 后 turn 仍在跑；登记生命周期跟随后台 completion，
    // 不能在 submitQuery 返回 ACK 时关闭，否则异步 accept 的 lease 会无人续租。
    let deferRegistrationCleanup = false
    try {
      // CLI-only: fill empty organizationRoot for non-runtime CLI readers. Do not
      // reuse this for Agent execution root (see resolveExecutionWorkspaceRoot).
      if (request.spaceId && request.organizationId && !getCLIOrganizationRoot()) {
        try {
          setCLIOrganizationRootIfMissing(
            resolveSpaceWorkspaceRoot(resolveSpacesRoot(), request.organizationId, request.spaceId),
          )
        } catch (err) {
          log.warn('[submitQuery] failed to compute organizationRoot fallback', {
            spaceId: request.spaceId, organizationId: request.organizationId, err: String(err),
          })
        }
      }
      if (this.relayPersistence.activateOwner(owner)) {
        void this.sharedHost?.kickRecoverAndBackfill({ activateOwner: false })
      }

      await this.ensureImportedArchiveSeeded(request)

      const hostQuery = this.mapToHostQuery(request, sender, owner, runId)
      this.pendingTurnCtx.set(runId, { request, sender })
      const begun = sharedHost.beginSubmitHostQuery(
        hostQuery as unknown as HostQuery<unknown, string, never>,
      )
      if (!begun.ok) {
        return {
          success: begun.result.success,
          error: begun.result.error,
          aborted: begun.result.aborted,
        }
      }
      if (options.registerAuthoritativeRun) {
        this.forwardLeaseAbortKeys.set(runId, request.threadId)
        void (async () => {
          try {
            const lease = await this.sessionRunRegistration.accept({
              threadId: request.businessThreadId ?? request.threadId,
              runId,
              taskId: request.taskId ?? request.clientMessageId ?? runId,
              organizationId: request.organizationId,
              hostId: this.runHostId,
            })
            if (localRegistrationClosed) return
            if (!this.runHostLeaseCoordinator.adoptClaim(runId, lease)) {
              log.warn('[SessionRun] atomic local claim rejected', {
                runId,
                threadId: request.businessThreadId ?? request.threadId,
              })
              this.handleAbort(request.threadId)
              return
            }
            localLeaseTracked = true
          } catch (error) {
            if (localRegistrationClosed) return
            if (
              error instanceof SessionRunRegistrationHttpError
              && error.status >= 400
              && error.status < 500
              && error.status !== 404
            ) {
              log.warn('[SessionRun] authoritative local dispatch rejected', {
                runId,
                threadId: request.businessThreadId ?? request.threadId,
                status: error.status,
              })
              this.handleAbort(request.threadId)
              return
            }
            log.warn('[SessionRun] local dispatch registration failed', {
              runId,
              threadId: request.businessThreadId ?? request.threadId,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        })()
      }
      deferRegistrationCleanup = true
      const runDisposition = begun.acceptance.runDisposition
      const queuePosition = begun.acceptance.queuePosition
      void begun.completion
        .then(
          (result) => {
            if (!result.success && !result.aborted) {
              log.warn(
                `[submitQuery] background settle failed after IPC ACK `
                  + `run=${runId.slice(0, 8)}… `
                  + `disposition=${runDisposition} `
                  + `queue_position=${queuePosition ?? 0} `
                  + `error_message=${result.error ?? ''}`,
              )
            } else if (result.aborted) {
              log.info(
                `[submitQuery] background settle aborted after IPC ACK `
                  + `run=${runId.slice(0, 8)}… disposition=${runDisposition}`,
              )
            }
          },
          (error: unknown) => {
            if (error instanceof ConversationRunCancelledError) {
              log.info(
                `[submitQuery] queued run cancelled before start `
                  + `run=${runId.slice(0, 8)}… disposition=${runDisposition}`,
              )
              return
            }
            log.warn(
              `[submitQuery] background settle threw after IPC ACK `
                + `run=${runId.slice(0, 8)}… `
                + `disposition=${runDisposition} `
                + `error_message=${error instanceof Error ? error.message : String(error)}`,
            )
          },
        )
        .finally(() => {
          localRegistrationClosed = true
          this.finishAcceptedQueryRegistration(runId)
        })
      return {
        success: true,
        runId,
        runDisposition,
        ...(queuePosition != null
          ? { queuePosition }
          : {}),
      }
    } catch (error) {
      if (error instanceof ConversationRunCancelledError) {
        // 排队轮被取消：与 pipeline kind:aborted 同语义，避免标「发送失败」。
        return { success: false, aborted: true }
      }
      throw error
    } finally {
      // /#9734：早 ACK 成功时 turn 仍在跑，pendingTurnCtx / lease 延到 settle finally。
      if (!deferRegistrationCleanup) {
        localRegistrationClosed = true
        this.pendingTurnCtx.delete(runId)
        if (localLeaseTracked) {
          this.runHostLeaseCoordinator.stopTracking(runId)
        }
        if (options.registerAuthoritativeRun) {
          this.forwardLeaseAbortKeys.delete(runId)
        }
      }
    }
  }

  /**
   * ：IPC 早 ACK 后清 pendingTurnCtx / lease / forward abort key（幂等）。
   */
  private finishAcceptedQueryRegistration(runId: string): void {
    this.pendingTurnCtx.delete(runId)
    this.runHostLeaseCoordinator.stopTracking(runId)
    this.forwardLeaseAbortKeys.delete(runId)
  }

  /** ：向 renderer 发 agent.stream.run_sync（busy = status !== idle）。 */
  private emitRunSyncEvent(payload: {
    session_id: string
    run_id: string | null
    status: 'idle' | 'running' | 'queued'
    seq: number
    queued_run_ids: string[]
  }): void {
    if (payload.status === 'idle' && payload.session_id) {
      this.clearBrowserControlForStoppedSession(payload.session_id)
    }

    try {
      const delivered = this.sharedHost?.publish(payload.session_id, {
        event: { type: StreamEvents.RUN_SYNC, payload },
      }) ?? 0
      if (delivered === 0) {
        log.debug('[RunSync] no renderer watcher; current state will replay on next watch', {
          sessionId: payload.session_id,
          status: payload.status,
          seq: payload.seq,
        })
      }
    } catch (error) {
      // 投递失败不阻断执行；Host 已保留权威队列状态，新 watch 会主动重放。
      log.warn('[RunSync] renderer delivery failed; current state will replay on next watch', {
        sessionId: payload.session_id,
        status: payload.status,
        seq: payload.seq,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async handleQuery(
    event: IpcMainInvokeEvent,
    request: QueryRequest,
  ): Promise<QueryResult> {
    if (request.executionTarget) {
      const workspaceId = request.workspaceId?.trim()
      if (!workspaceId) {
        throw new Error('workspaceId is required to validate local execution target')
      }
      validateLocalExecutionTarget({
        sessionId: request.threadId,
        workspaceId,
        target: request.executionTarget,
        turnStore: this.getStateRoot().turn,
        deviceIdentityStore: this.getStateRoot().deviceIdentity,
      })
    }
    // review M4：把 webContents.once('destroyed', ...) 装进 StreamEventSink，
    // 让 handleQueryInternal 内的 try/finally 能注册 + 卸载。完整 webContents
    // 不直接传，避免 sink 对象 leak Electron 对象到下游 NOOP path。
    const eventSender = event.sender
    const sender: StreamEventSink = {
      send: eventSender.send.bind(eventSender),
      isDestroyed: eventSender.isDestroyed.bind(eventSender),
      onceDestroyed: (cb) => {
        eventSender.once('destroyed', cb)
        return () => {
          try { eventSender.removeListener('destroyed', cb) } catch { /* best effort */ }
        }
      },
    }
    // ：流事件投递已收口 AgentRealtime（按 watch-session 登记的 watcher
    // 广播，天然覆盖后台 push / 多窗口）——不再需要把窗口 sink 按 thread 存活。`sender`
    // 仅用于本轮生命周期信号（loop 内 isDestroyed 早停 + onceDestroyed 关窗即 abort）。
    // ：经 per-session 队列提交（忙则入队而非拒绝）。
    return this.submitQuery(request, sender, { registerAuthoritativeRun: true })
  }

  /**
   * W7c P0-3：让 ElectronAgentHost 也能消费 `agent.prompt.forward`（runtime_mode='local' /
   * `agent_backend.type === 'local'`）—— ElectronAgentService 的双路径分流器
   * 在解析到 local 后，把 envelope 转成 `QueryRequest` 调用本方法。
   *
   * 与 IPC 路径的差异：
   *   - 没有 sender；流事件只通过 relay → `agent.stream.{thread_id}` 广播
   *     （本机 Renderer 通过 P0-2 观察端订阅器接收）。
   *   - persona/customRules/agentMode/agentId/yoloMode 由 envelope
   *     payload 提供，与 IPC 字段语义对齐（snake_case → camelCase 转换）。
   *
   * 失败容忍：参数缺失返回 `{ success: false, error }`，由调用方决定是否
   * 上报 lifecycle.error（与 Daemon `routeToLocalAgentHost` 同行为）。
   */
  async handleQueryFromForward(envelope: GatewayEnvelope): Promise<{ success: boolean; error?: string }> {
    // 与 AgentHost dispatch 内 `decodeForwardRequestDetailed` 一致：schema
    // 失败与 missing-content 用不同 reason 上报，避免默默吞掉 wire 层脏 payload。
    const detailed = decodeForwardRequestDetailed(envelope, log)
    if (!detailed.ok) {
      log.error('[handleQueryFromForward] decode failed', {
        reason: detailed.reason,
        error: detailed.error,
      })
      return { success: false, error: detailed.error }
    }
    return this.handleForwardRequest(this.mapForwardRequestToQuery(detailed.request))
  }

  /**
   * ：ForwardConversationRequest → QueryRequest。
   * Decoder 用 replyToMessageId/Preview；IPC QueryRequest 用 replyTo——与 Daemon 对齐显式映射。
   */
  private mapForwardRequestToQuery(
    forward: ForwardConversationRequest,
  ): QueryRequest {
    const {
      replyToMessageId,
      replyToPreview,
      skillSlashInvoke,
      ...rest
    } = forward
    return {
      ...(rest as QueryRequest),
      ...(skillSlashInvoke?.skillKey ? { skillSlashInvoke } : {}),
      ...(replyToMessageId
        ? {
            replyTo: {
              messageId: replyToMessageId,
              preview: replyToPreview as NonNullable<QueryRequest['replyTo']>['preview'],
            },
          }
        : {}),
    }
  }

  private async handleForwardRequest(request: QueryRequest): Promise<QueryResult> {
    log.info(
      `[W7c P0-3] handleQueryFromForward: thread=${request.threadId.slice(0, 8)}… agent=${(request.agentId ?? '-').slice(0, 8)}…`,
    )
    // 无人值守 fail-fast：interaction_mode 非 interactive（Tracker 传 'scheduled'）时
    // 按 sessionId + 业务 ChatSession thread 登记，让本 session 的 waitForUserInput
    // + 权限 handler + browser policy 进入 fail-fast/免审批档。query 结束即清，避免泄漏。
    const interactionMode = request.interactionMode
    const trackUnattended = !!interactionMode && interactionMode !== 'interactive'
    if (trackUnattended) {
      setRuntimeInteractionMode(request.threadId, interactionMode)
      setRuntimeInteractionMode(request.businessThreadId, interactionMode)
    }
    const leasedRunId = request.runId
    let admittedToHost = false
    // Rollout 边界：本 Host 只有拿到 run_id 才具备 claim 条件；缺失则按旧
    // 客户端兼容路径继续。dispatch 尚未下发 lease_required /
    // claim_deadline，故这里不伪造 30s deadline，也不让后端误 sweep 旧客户端。
    if (leasedRunId) {
      if (this.sharedHost?.hasAdmittedHostQuery(leasedRunId)) {
        log.info('[AgentHost] replayed admitted forward ignored', { runId: leasedRunId })
        admittedToHost = true
        return { success: true }
      }
      try {
        const claimDecision = await this.runHostLeaseCoordinator.claim(leasedRunId)
        if (claimDecision === 'duplicate') {
          log.info('[RunHostLease] duplicate forward ignored', { runId: leasedRunId })
          admittedToHost = true
          return { success: true }
        }
        if (claimDecision === 'rejected') {
          return {
            success: false,
            error: 'Run ownership was rejected by the server',
          }
        }
        this.forwardLeaseAbortKeys.set(leasedRunId, request.threadId)
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
    try {
      // ：forward 路径同样经队列提交，保证 runQueue 为唯一串行器。
      const result = await this.submitQuery(request, NOOP_STREAM_SINK)
      admittedToHost = result.success
      return result
    } finally {
      if (leasedRunId && !admittedToHost) {
        this.runHostLeaseCoordinator.stopTracking(leasedRunId)
        this.forwardLeaseAbortKeys.delete(leasedRunId)
      }
      if (trackUnattended) {
        clearRuntimeInteractionMode(request.threadId)
        clearRuntimeInteractionMode(request.businessThreadId)
      }
    }
  }

  private async acknowledgePromptAdmission(
    runId: string | undefined,
    envelope: {
      event_id?: unknown
      thread_id?: unknown
      _topic?: unknown
    },
  ): Promise<void> {
    const eventId = envelope.event_id
    const threadId = envelope.thread_id
    const topic = envelope._topic
    if (
      !runId
      || typeof eventId !== 'string'
      || !/^[0-9]+-[0-9]+$/.test(eventId)
      || typeof threadId !== 'string'
      || !threadId
      || typeof topic !== 'string'
      || !topic.startsWith('agent.action.device.')
    ) {
      return
    }
    const response = await electronWsGateway.requestWithLastAuth(
      PromptEvents.ADMITTED,
      { buffered_event_id: eventId, run_id: runId },
      { threadId },
    )
    if (!response.ok) {
      log.warn('[agent-host] prompt admission ACK failed; EventBuffer retained', {
        runId,
        eventId,
        error: response.error?.message,
      })
      return
    }
    electronWsGateway.acknowledgeApplicationEvent(eventId, topic)
  }

  // ─── push 通知 idle drain（commit 3 / Stage 3 下沉）─────────────────
  //
  // push notification 链路完整流程：
  //   1. 用户 / 系统起后台命令（wait_ms=0 / poll deadline 到 / pattern 命中）
  //   2. ShellCap 返 status='running' envelope，LLM 看到任务在跑就继续做别的事
  //   3. 进程退出 → bridge.handle.result.then → managedTaskStore.updateOnExit
  //      → bridge.emitPushNotificationOnExit（commit 2）
  //   4. notificationQueue.enqueue → subscribers 同步被调
  //   5. host.start 注册的 listener → notificationDrain.schedule(target.threadId)
  //   6. queueMicrotask → NotificationIdleDrain.tryDrain → composeNotificationPrompt
  //      → runNotificationDrainTurn → submitQuery
  //   7. LLM 在新 turn 收到 user message "A background command completed..."
  //
  // 兜底：turn 收尾（onTurnFinally）或运行期 enqueue 时排的 drain 可能撞上
  // isBusy 闸被静默吞掉；run queue 真正转 idle 后由 AgentPlatformAdapter
  // .onConversationIdle → scheduleNotificationDrainOnIdle 补排一次（见下）。
  //
  // 三道 race 防御（busy 短路 / peek 短路 / 失败退回）+「session missing → log.error
  // 丢消息 vs 瞬态 busy → 退回」两类不同规则均由 `NotificationIdleDrain` 保证，
  // 与 Daemon 对称同源。详见 PRD §6.3 + §6.4 与 `NotificationIdleDrain` 单测。

  /**
   * 定位 push notification queue。null-safe：bridge 未就绪 / 未注入时返 undefined，
   * 由 `NotificationIdleDrain` 打结构化日志后短路。
   */
  private resolveNotificationQueue():
    | import('@tabtin/terminal-core').NotificationQueue
    | undefined {
    const bridge = resolvePtyManagerBridge() as
      | { getNotificationQueue?: () => import('@tabtin/terminal-core').NotificationQueue }
      | null
    return bridge?.getNotificationQueue?.()
  }

  /**
   * push-drain 起新一轮 turn 的平台实现（Stage 3：NotificationIdleDrain 回调）。
   *
   * 从 `session`（HostState）回填 modelId/agentId/customRules/personalRules/
   * agentMode —— 这些都是 `bakedFieldsMatch` 缓存键里的字段，让 getOrCreateRuntime
   * cache 尽量 hit，零开销复用上轮 runtime。漏填会误判 cache miss 多一次重建，
   * 甚至因 fallback 'default' 让 LLM proxy 报"模型不存在"（与 Daemon 同期同源修复）。
   *
   * 还必须回填 `modelContextWindow` / `modelMaxOutput`（来自已烘焙的
   * `engineConfig`）以及 `memoryCapability` / `workingDirType` /
   * `disabledApps*`。否则 cache miss 后 `createRuntimeForSession` 会落到
   * `FALLBACK_MODEL_CAPABILITIES`（32k / 8192），把大窗口模型的有效上下文
   * 压成极小窗口，误触发 `compaction_mode=auto`（ live 复现）。
   *
   * commit 4：`triggeredBy='push-notification'` 透传到 runtime → USER event
   * payload.triggered_by，让 renderer 识别为系统注入消息（D6 视觉区分）+
   * Django relay 持久化到 ChatMessage.metadata.triggered_by。
   *
   * ：必须带 `clientMessageId`。有跨轮 `initialMessages` 时，prelude 的
   * `emitMainUserEventPhase` 靠它决定是否补发 USER；漏填会让 idle drain 在
   * 实时路径静默不发「后台命令完成」条（本地仍落 `local-*`，刷新才看得见）。
   */
  private async runNotificationDrainTurn(
    context: NotificationDrainContext,
  ): Promise<{ success: boolean; error?: string }> {
    const session = this.sessions.get(context.threadId)
    if (!session) {
      // NotificationIdleDrain 已在 hasSession 处 log.error + 丢消息；这里 defensive
      // 兜底若竞态导致 session 在 hasSession 后被清掉，同样按稳态丢失处理。
      return { success: false, error: 'session missing after drain' }
    }
    const firstTarget = context.items[0].target
    const request: QueryRequest = {
      prompt: context.promptText,
      threadId: context.threadId,
      spaceId: firstTarget.spaceId,
      modelId: session.modelId,
      agentId: session.owner.agentId ?? undefined,
      workspaceId: session.workspaceId,
      customRules: session.customRules,
      personalRules: session.personalRules,
      agentMode: session.agentMode,
      triggeredBy: 'push-notification',
      // 与普通用户发送对齐：让 prelude 在已有 history 时仍补发 USER 事件
      clientMessageId: crypto.randomUUID(),
      // 已烘焙能力：避免 drain rebuild 吃 FALLBACK 8192/32k
      modelContextWindow: session.engineConfig.contextWindowTokens,
      modelMaxOutput: session.engineConfig.maxOutputTokens,
      memoryCapability: session.memoryCapability,
      workingDirType: session.workingDirType,
      workingDir: session.workspaceRoot,
      disabledApps: session.disabledApps,
      disabledToolPrefixes: session.disabledToolPrefixes,
      executionLimits: session.maxCreditsPerRun != null
        ? { max_credits_per_run: session.maxCreditsPerRun }
        : undefined,
    }
    // ：push drain 的流事件收口 AgentRealtime；本轮 sink 用 NOOP，让后台轮
    // 跑到终态；窗口在看则经 router 收到流，窗口全关则只落库 / relay。
    return this.submitQuery(request, NOOP_STREAM_SINK)
  }

  /**
   * run queue 转 idle 后的补 drain schedule。
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
    this.notificationDrain.schedule(conversationId)
    for (const [threadId, session] of this.sessions) {
      if (session.businessThreadId === conversationId && threadId !== conversationId) {
        this.notificationDrain.schedule(threadId)
      }
    }
  }

  /**
   * ：后台任务完成「turn 内注入」的 drain（薄委托到 NotificationIdleDrain）。
   *
   * 作为 `EngineConfig.drainThreadNotifications` 的宿主实现：当前 turn 还在循环
   * 时，每轮 ReAct 迭代边界由 agent-runtime 调用一次，把该 thread 已完成的后台
   * 子 Agent / shell 命令通知 drain 出来拼成注入文本返回。与 `notificationDrain`
   * 的 idle turn **消费同一队列**：drain 同步出队 + 释放 dedup，两条路互斥、零重复。
   * 无待 drain / queue 不可用 / session 已不在 map → 返回 null。
   *
   * shell 终态 tool_result 的 relay 在 enqueue subscribe listener 里已独立触发
   * （与 drain 正交），此处无需重复处理。
   */
  private drainThreadNotificationsText(
    threadId: string,
    options?: { allowMissingSession?: boolean },
  ): string | null {
    return this.notificationDrain.drainText(threadId, options)
  }

  /**
   * W4a S2（2026-05-30）：子 Agent 实时流的 **query 外** session 级直接 relay。
   *
   * `subagentStreamSink` 在没有活跃 query 时走这里，只负责观测层 relay。
   * 父会话 message-blocks 由 router 的 persistParentSession 落盘，不挂在本方法上。
   */
  private relaySubagentStreamEventDirect(sessionId: string, event: StreamEvent): void {
    void (async () => {
      try {
        const organizationId = getCLIOrganizationId()
        if (!organizationId) return
        const token = await TokenManager.getAccessToken()
        if (!token) return
        await electronWsGateway.request(
          { token, organizationId },
          'relay_events',
          { session_id: sessionId, events: [event] },
        )
      } catch (err) {
        log.warn(
          `[subagent-sink] out-of-query relay failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    })()
  }

  /**
   * t1（终端"假运行"根治）：后台命令终结时，把 NotificationQueue 的
   * `background-task-completed` 通知翻译成一条**终态** tool_result mini-message，
   * 经 out-of-query relay 发往 Django，覆盖之前合并进 assistant ChatMessage 的
   * `status: "running"` 快照。重载对话时终端卡片自然显示真实终态——前端零改。
   *
   * 与 `scheduleDrain`（激活新 turn 让 LLM 看通知）正交：drain 给 LLM 看，本方法
   * 修历史持久态。
   *
   * **终端假运行根治 Layer 1（已从 fire-and-forget 升级）**：走 `relayEventsWithRetry`
   * ——消费 Django ok/nak（ack），失败（离线 / token 失效 / NAK）落盘 owner 桶的
   * `RelayRetryQueue` 等启动 / 重连 recover 重投（治 F2/F3/F16）；owner 取 payload.owner
   * （spawn 时焊死，治 F1），缺失则从当前登录态兜底。不抛、不阻塞 listener 同步栈。
   */
  private buildBackgroundMediaArtifactEvents(args: {
    threadId: string
    command: string
    sourceToolUseId: string
    exitCode: number | null
    terminalEvents: StreamEvent[]
  }): StreamEvent[] {
    if (args.exitCode !== 0) return []
    const toolResultStart = args.terminalEvents.find(
      (event) => event.type === 'agent.stream.content_block_start',
    )
    const block = (toolResultStart?.payload as {
      block?: { type?: unknown; content?: unknown }
    } | undefined)?.block
    if (block?.type !== 'tool_result' || typeof block.content !== 'string') return []

    const initialSeq = args.terminalEvents.reduce((maxSeq, event) => {
      const seq = (event.payload as { _seq?: unknown })._seq
      return typeof seq === 'number' ? Math.max(maxSeq, seq) : maxSeq
    }, 0)
    return buildMediaImageArtifactEvents({
      threadId: args.threadId,
      command: args.command,
      output: block.content,
      sourceToolUseId: args.sourceToolUseId,
      initialSeq,
    })
  }

  private relayBackgroundTaskTerminalResult(env: NotificationEnvelope): void {
    if (env.kind !== SHELL_NOTIFICATION_KIND) return
    const payload = env.payload as BackgroundTaskCompletedPayload
    const relayThreadId = resolveBackgroundTaskRelayThreadId({
      target: env.target,
      payload,
    })
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
    })
    if (!events) return
    const relayEvents = [
      ...events,
      ...this.buildBackgroundMediaArtifactEvents({
        threadId: relayThreadId,
        command: payload.command,
        sourceToolUseId: payload.tool_use_id,
        exitCode: payload.exit_code,
        terminalEvents: events,
      }),
    ]
    // ：本机 live 投递——Django relay 广播按  以发送方 channel 做
    // exclude_channel（其前提是"发送方 UI 已由 localStream 渲染"），而本路径是
    // query 外合成的终态 mini-message，本机并未渲染过；不补本地投递，发起端
    // renderer 永远收不到终态（仅同账号其它端收到），live 终端卡片继续转圈。
    // 这里把 4 件套经 AgentRealtime broadcast 投给本机 watcher（与 query 路径
    // localStream 同一条 agent-engine:stream-event IPC 通道）；payload 自带
    // event_id，AgentRealtime 跨源去重兜底 WS resume/replay 的二次到达。
    for (const ev of relayEvents) {
      this.sharedHost?.publish(relayThreadId, {
        event: { type: ev.type, payload: ev.payload },
      })
    }
    // 终端假运行根治 Layer 1：
    //   - owner 固化（治 F1）：优先用 payload.owner（spawn 时焊死的 {userId,
    //     organizationId}），丢 token / 切 organization 后仍能落到正确 outbox 桶；缺失时
    //     relayEventsWithRetry 回落 getCLIOrganizationId。
    //   - ack 消费 + 失败落盘 recover（治 F2/F3/F16）：relayEventsWithRetry 内部
    //     消费 Django ok/nak，失败 → RelayRetryQueue.persist 等下次 recover 重投。
    const owner = payload.owner as PersistedEntryOwner | undefined
    // A5：通知消费在 NotificationQueue 同步 listener 栈里跑——必须 .catch 兜底，否则
    // relayEventsWithRetry 链路里任何 reject（病态 owner 触发 assertValidOwner 同步
    // throw、持久化异常等）会变成 unhandled rejection 打到全局。
    void this.relayPersistence.send(owner, relayThreadId, relayEvents).catch((err) => {
      log.warn(
        `[relay] background-task terminal-state relay rejected: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }

  private async appendStreamEventToSessionStorage(
    storage: SessionStorage,
    streamEvent: StreamEvent,
    toolLogWriter?: ToolLogWriter | null,
  ): Promise<void> {
    // ：主循环 yield 的 persist_message（消息完整边界 blocks_json 整包）与
    // compaction 边界路由给 SessionStorage——前者写 message-blocks.jsonl（block
    // 权威，与 Django ChatMessage 同 payload），后者写 messages.jsonl 边界标记 +
    // block 压缩边界记录。这两类事件此前只走 relay，不落本地。
    if (
      streamEvent.type === 'agent.stream.persist_message'
      || streamEvent.type === 'agent.stream.compaction'
    ) {
      await storage.appendStreamEvent(streamEvent)
      return
    }
    // W6/ ：引擎 yield 的 environment / agent-profile / system-prompt 注入走
    // `agent.stream.user`（message_kind=context kind），
    // 只经 relay 落 MySQL，不在 appendStreamEvent 的 6 件套白名单里 → 不进
    // messages.jsonl。这里显式记进 transcript（与真 user 走 recordUserMessage 对称），
    // 让 restoreMessages 自然带回、引擎 markHistorical* 标成稳定历史。仅记录、不二次 relay。
    if (streamEvent.type === 'agent.stream.user') {
      const userPayload = streamEvent.payload as {
        message_kind?: string
        content?: string
        message_id?: string
        client_event_id?: string
        triggered_by?: string
        source?: string
      }
      const injectKind = userPayload.message_kind
      const isContextInject =
        injectKind === 'environment_context'
        || injectKind === 'agent_profile_context'
        || injectKind === 'system_prompt_context'
        || injectKind === 'external_archive_context'
      //  残留：in-turn push 必须落本地 blocks；idle drain 勿重复写入。
      // 判定见 isInTurnPushNotificationUser（有单测锁契约）。
      const isInTurnPush = isInTurnPushNotificationUser(userPayload)
      const isSkillInject = userPayload.source === 'skill_invoke'
      if (
        (isContextInject || isInTurnPush || isSkillInject)
        && typeof userPayload.content === 'string'
        && userPayload.content.length > 0
      ) {
        // ：六件套 + block 记录双写；两份本地事实都保留真实 system 作者，
        // 只在 SessionStorage.restoreMessages 的 LLM 边界投影为 user。
        const injectMessage = { role: 'user', content: userPayload.content } as const
        const injectMessageId = userPayload.message_id ?? userPayload.client_event_id
        const recordOpts = {
          ...(injectMessageId ? { messageId: injectMessageId } : {}),
          ...(isInTurnPush ? { triggeredBy: 'push-notification' as const } : {}),
          ...(isSkillInject ? { source: 'skill_invoke' as const } : {}),
        }
        await storage.recordSystemMessage(injectMessage, {
          ...recordOpts,
          ...(isContextInject && injectKind ? { messageKind: injectKind } : {}),
        })
        await storage.appendUserBlockRecord(injectMessage, {
          ...recordOpts,
          role: 'system',
          ...(isContextInject && injectKind ? { messageKind: injectKind } : {}),
        })
      }
      return
    }
    if (streamEvent.type !== 'agent.stream.system_notice') return

    const payload = streamEvent.payload as {
      notice_type?: string
      phase?: string
      tool_call_id?: string
      tool_name?: string
      input?: unknown
      output?: unknown
      is_error?: boolean
      duration_ms?: number
    }

    if (!isToolLifecycleNotice(payload.notice_type)) return

    const toolCallId = payload.tool_call_id
    if (!toolCallId) return

    if (payload.phase === 'start') {
      toolLogWriter?.onToolStart(toolCallId, payload.input)
      return
    }

    if (payload.phase !== 'end' && payload.phase !== 'error') return

    const content = toolOutputToString(payload.output)
    await storage.recordToolResult(toolCallId, content, Boolean(payload.is_error))
    //  canonical result 契约：不再写 model projection（读取侧已删，
    // transcript 落盘即无损 raw；旧会话的 model-projections.jsonl 仅作归档，
    // fork 复制保留兼容）。daemon 侧写入按交付边界另行处理。

    if (toolLogWriter) {
      toolLogWriter.writeToolLog({
        tool_name: payload.tool_name ?? 'unknown',
        tool_call_id: toolCallId,
        output: payload.output,
        is_error: Boolean(payload.is_error),
        duration_ms: payload.duration_ms,
      })
    }
  }

  // ─── File attachment resolution (FR-18 本地优先) ────────────────

  /**
   * FR-18：附件解析主流程（薄委托到共享 `resolveFileAttachmentsShell`）。
   * 单件解析（本地 DocParse / 云端 summary / 音频 ASR / 视频短路）仍由本类的
   * `resolveOneAttachment` 保留 —— 平台差异（Electron 全局 API_BASE_URL /
   * TokenManager / FileResolver / 音频视频路径）不适合抽到共享层。
   * 阶段 6 议题 2 的 `<context type="attached" stale_after_turn=...>` 外壳
   * 与 `\n\n` 拼接由 helper 统一负责，双端逐字节对齐。
   */
  private async resolveFileAttachments(
    attachments: Array<{ type: string; file_id?: string; filename?: string; mime_type?: string; size?: number; url?: string }>,
    strategy: AttachmentStrategy,
    abortSignal?: AbortSignal,
    turnId?: string,
    organizationId?: string,
  ): Promise<string> {
    return resolveFileAttachmentsShell(
      attachments,
      (a) => this.resolveOneAttachment(
        a,
        strategy,
        abortSignal,
        organizationId,
      ),
      (a) => this.fallbackAttachmentText(a),
      { logger: log, turnId },
    )
  }

  /**
   * FR-18 主路径：本地优先解析附件（W4 经 FileResolver 抽象层）。
   *
   * **W4 (2026-05-13) 改造**：
   *   - 旧实现：直接 import + 调 `parseLocalAttachment(@tabtin/local-docparse)`
   *   - 新实现：通过 `@tabtin/file-pipeline` 的 `FileResolver` 调 `PdfParser /
   *     DocxParser / XlsxParser`；channel 只决定策略（local_first / cloud_only）+
   *     转 `ResolveResult` 为 prompt 注入文本。
   *
   * 流程：
   *   1. `cloud_only` → 直接云端 DocParse summary（W4 移除 cloud_first 死配置）
   *   2. `local_first`（默认）：
   *      a. 无本地可用源（无 url 且无 file_id）→ 云端兜底
   *      b. 预知体积 > 50MB → 用户明确提示
   *      c. 走 FileResolver 解析（PDF/docx/xlsx）
   *         - text result → 注入 prompt
   *         - error result：fallbackToCloud（扫描件/乱码/超时/不支持/未知）→ 云端
   *         - error result：硬失败（加密/损坏/oversize/abort）→ 明确错误提示
   */
  private async resolveOneAttachment(
    a: { file_id?: string; filename?: string; mime_type?: string; size?: number; url?: string },
    strategy: AttachmentStrategy,
    abortSignal?: AbortSignal,
    organizationId?: string,
  ): Promise<string | null> {
    if (!a.file_id) return null

    const filename = a.filename ?? '文档'
    const mime = a.mime_type ?? ''

    // ：音频不走 DocParse / FileResolver，上传后自动 ASR，把转写注入上下文。
    if (isChatAudioAttachment(mime, filename)) {
      return this.resolveChatAudioAttachment(a, filename, organizationId, abortSignal)
    }

    // ：视频不走 DocParse；确认上传成功即可（不依赖 FFmpeg / ASR）。
    if (isChatVideoAttachment(mime, filename)) {
      return formatChatVideoUploadedBody(filename, a.size)
    }

    if (strategy === 'cloud_only') {
      // H2-E Review fix：所有云端调用统一传 abortSignal，让用户点"停止生成"
      // 也能立刻中断，不再傻等 15s 内部 timeout（手机端流量敏感场景尤重要）。
      return this.fetchCloudSummary(a.file_id, filename, abortSignal)
    }

    // strategy === 'local_first'
    const maxBytes = DEFAULT_MAX_LOCAL_FILE_SIZE_MB * 1024 * 1024
    if (a.size != null && a.size > maxBytes) {
      this.logDocParseEvent(TelemetryEvents.DOCPARSE_FORBIDDEN_LOCAL, {
        reason: FilePipelineErrorCode.FILE_TOO_LARGE,
        mime,
        file_size_mb: Math.round((a.size / 1024 / 1024) * 10) / 10,
        file_id: a.file_id,
      })
      return this.formatUserFacingLocalError(
        filename,
        FilePipelineErrorCode.FILE_TOO_LARGE,
        a.file_id,
      )
    }

    const localUrl = a.url
    if (!localUrl) {
      this.logDocParseEvent(TelemetryEvents.DOCPARSE_CLOUD_FALLBACK, {
        reason: 'no_local_source',
        mime,
        file_id: a.file_id,
      })
      return this.fetchCloudSummary(a.file_id, filename, abortSignal)
    }

    // W4：调 FileResolver 走 PdfParser/DocxParser/XlsxParser（oss-url source）
    const fileResolver = getElectronFileResolver()
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
        // 透传阶段耗时日志（download_ms / worker_ms），进诊断包排 parse_timeout
        logger: { debug: (...args: unknown[]) => log.debug(...args) },
      },
      {
        // host 注入 worker pool；persistent channel 不用 PPTX temp parse
        runDocParserTask,
      },
    )

    this.logFileResolverResult(resolveResult, { mime, fileId: a.file_id, filename })

    if (resolveResult.kind === 'text') {
      const header = `[文档: ${filename}]`
      if (resolveResult.text.trim().length === 0) {
        return `${header}\n（本地解析成功但文档内容为空）`
      }
      return `${header}\n${resolveResult.text}`
    }

    if (resolveResult.kind === 'image') {
      // 持久通道极少触发（chat 拖图走 ImageBlock url 注入，不进 resolveOneAttachment）
      // 防御性 fallback
      return `${`[图片: ${filename}]`}\n（已注入到对话上下文）`
    }

    // ── error result ──
    const errClass = resolveResult.code
    if (errClass === FilePipelineErrorCode.USER_ABORTED) {
      return null
    }

    const fallbackToCloud = errorClassToFallback(errClass)
    if (!fallbackToCloud) {
      // 硬失败（加密 / 损坏 / 超大 / 文件不存在）→ 明确错误提示
      return this.formatUserFacingLocalError(filename, errClass, a.file_id)
    }

    if (abortSignal?.aborted) return null

    // 本地失败 + 可切云端 → fetchCloudSummary 兜底
    const cloudText = await this.fetchCloudSummary(a.file_id, filename, abortSignal)
    return cloudText ?? this.fallbackAttachmentText(a)
  }

  /**
   * ：聊天拖入的音频附件 → Django speech ASR → 转写注入 Agent 上下文。
   * 失败时返回明确失败说明（不要假装听过内容），不回落到 DocParse。
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
        apiBaseUrl: API_BASE_URL,
        organizationId: organizationId ?? '',
        getAccessToken: () => TokenManager.getAccessToken(),
        signal: abortSignal,
      },
    )
    if (result.ok) {
      log.debug(
        'chat audio ASR ok (%s%s): %s chars from %s',
        result.mode,
        result.fromCache ? ',cache' : '',
        result.text.length,
        filename,
      )
      return formatChatAudioTranscriptBody(filename, result.text)
    }
    log.warn(
      'chat audio ASR failed (%s) for %s: %s',
      result.kind,
      filename,
      result.userMessage.slice(0, 200),
    )
    return result.userMessage
  }

  // W4 (2026-05-13)：FileResolver 输出的 telemetry 埋点（替代旧
  // `logLocalParseResult(LocalDocParseResult)`）。事件名 / 字段 / 桶分布
  // 与 W3 完全对齐——dashboard / jq 消费方不变。
  private logFileResolverResult(
    result: import('@tabtin/file-pipeline').ResolveResult,
    ctx: { mime: string; fileId: string; filename: string },
  ): void {
    if (result.kind === 'text') {
      this.logDocParseEvent(TelemetryEvents.DOCPARSE_LOCAL_SUCCESS, {
        mime: ctx.mime,
        pages: result.pages,
        char_count: result.text.length,
        duration_ms: result.durationMs,
        file_size_mb: Math.round((result.fileSizeBytes / 1024 / 1024) * 10) / 10,
        quality_score: result.qualityScore,
        file_id: ctx.fileId,
      })
      this.logDocParseEvent(TelemetryEvents.DOCPARSE_LOCAL_DURATION, {
        mime: ctx.mime,
        pages: result.pages,
        duration_ms: result.durationMs,
        bucket: this.bucketForPages(result.pages),
      })
      return
    }
    if (result.kind === 'error') {
      const fallback = errorClassToFallback(result.code)
      this.logDocParseEvent(TelemetryEvents.DOCPARSE_LOCAL_FAILED, {
        mime: ctx.mime,
        error_class: result.code,
        fallback_to_cloud: fallback,
        file_id: ctx.fileId,
      })
      if (fallback) {
        this.logDocParseEvent(TelemetryEvents.DOCPARSE_CLOUD_FALLBACK, {
          reason: result.code,
          mime: ctx.mime,
          file_id: ctx.fileId,
        })
      }
    }
  }

  // W4 (2026-05-13)：旧 `logLocalParseResult(LocalDocParseResult)` 已删除——
  // resolveOneAttachment 改走 FileResolver 后由 `logFileResolverResult` 接 ResolveResult。
  // D1 不留兼容 / D2 不留 MVP，删除老 helper + LocalDocParseResult 局部 import。

  private bucketForPages(pages: number | undefined): string {
    if (pages == null) return 'unknown'
    if (pages <= 10) return '1-10'
    if (pages <= 50) return '11-50'
    if (pages <= 100) return '51-100'
    if (pages <= 500) return '101-500'
    return '500+'
  }

  private logDocParseEvent(event: TelemetryEventName, payload: Record<string, unknown>): void {
    // 双通道：electron-log 的人类可读日志（保留既有排障习惯）+ 统一 telemetry sink（H1-E）。
    // 事件名由 TypeScript 约束到 TelemetryEvents 常量，彻底避免字符串字面量漂移
    // （H1-D-MAIN 曾短暂使用 `event.docparse.*` 前缀，H1-E 收敛后不再存在）。
    log.info(event, payload)
    emitTelemetryEvent(event, payload)
  }

  /**
   * 把本地错误翻译成"给用户看的明确提示"。
   *
   * ⚠️ 设计约束：此文本会被注入 `effectivePrompt` 交给 LLM，LLM 会以自己的语气
   * 转述给用户。因此：
   *   1. 不能含 agent 内部工具名（如 `parse_document`），否则用户读到会困惑"这是啥"
   *   2. 不能含 file_id / UUID 这类技术标识符（FILE_TOO_LARGE 例外，给 Agent
   *      用 parse_document 走分页用，明示 [INTERNAL]）
   *   3. 用自然语言描述"是什么问题 + 用户可以做什么"，让 LLM 能自由转述
   *
   * **W1.3 第 3 轮 Review 2 S1 修复（2026-05-13）**：原实现只覆盖 3 类
   * （ENCRYPTED / CORRUPTED / FILE_TOO_LARGE），其余 10 类走 `[文档: foo —
   * 本地解析失败（errorClass）]` 这种裸 enum 字面值兜底；当持久通道云端 failed
   * 状态拿到任何一类时（如扫描件 / 乱码 / unsupported_format / network_failed），
   * Agent 上下文里就是这种用户看不懂的字面值。改为薄包装调 SSoT
   * `formatFilePipelineErrorChinesePrompt`——13 类全覆盖，与 chat.json i18n
   * 文案物理同源，main agent / Daemon / UI 卡片三处不再各维护一份中文。
   */
  private formatUserFacingLocalError(
    filename: string,
    errorClass: FilePipelineErrorCode,
    fileId: string,
  ): string {
    return formatFilePipelineErrorChinesePrompt(errorClass, {
      filename,
      localLimitMb: DEFAULT_MAX_LOCAL_FILE_SIZE_MB,
      // 只在 FILE_TOO_LARGE 下使用 file_id 给 Agent 走 parse_document 分页；
      // 其他类的中文文案不消费 file_id（SSoT 内部 switch 控制）。
      fileIdForParseDocument: fileId,
    })
  }

  /**
   * 云端 DocParse summary 兜底路径（FR-18 Phase 1 保留旧行为）。
   *
   * **H2-E Review 必修项**：接受 `sessionAbortSignal` 与会话级 abort 联动，
   * 让用户点"停止生成"时云端 fetch 也立刻中断，不再傻等 15s timeout。
   */
  private async fetchCloudSummary(
    fileId: string,
    filename: string,
    sessionAbortSignal?: AbortSignal,
  ): Promise<string | null> {
    let observedNotReadyStatus = false
    try {
      const token = await TokenManager.getAccessToken()
      if (!token) return null

      const url = joinApiPath(API_BASE_URL, `/services/docparse/summary/${fileId}?max_tokens=2000`)
      const deadline = Date.now() + CLOUD_SUMMARY_WAIT_MS

      // 组合两个 signal：内部 15s 硬超时 + 会话级 abort（用户"停止"）。
      const internalTimeoutSignal = AbortSignal.timeout(CLOUD_SUMMARY_WAIT_MS)
      const composed = sessionAbortSignal
        ? AbortSignal.any([internalTimeoutSignal, sessionAbortSignal])
        : internalTimeoutSignal

      while (true) {
        const resp = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          signal: composed,
        })

        if (!resp.ok) return null

        const data = await resp.json() as {
          status?: string
          summary?: string
          title?: string
          total_pages?: number
          message?: string
          retry_after_ms?: number
          // **W1.3 第 3 轮 Review 2 S1（2026-05-13）**：后端 `/summary` endpoint 在
          // `status='failed'` 时返回 `failure_code` 字段（与 SSoT 13 类对齐，见
          // `apps/tabtin_django/apps/services/docparse/api.py:122-131`）。
          failure_code?: string
        }

        if (data.status === 'ready') {
          //  / ：ready 但空摘要 / 表格 stub / 乱码 —— 注入前做质量门，
          // 避免 Agent 把「正在解析中」或空正文当成已读到内容。
          const summaryText = data.summary ?? ''
          const quality = assessCloudSummaryQuality(summaryText)
          if (!quality.ok) {
            this.logDocParseEvent(TelemetryEvents.DOCPARSE_CLOUD_FALLBACK, {
              reason: `summary_quality_${quality.reason}`,
              mime: 'application/pdf',
              file_id: fileId,
            })
            log.info('docparse.cloud_summary_rejected', {
              file_id: fileId,
              filename,
              reason: quality.reason,
              summary_len: summaryText.length,
            })
            return formatFilePipelineErrorChinesePrompt(
              quality.reason === 'garbled_text_layer'
                ? FilePipelineErrorCode.GARBLED_TEXT_LAYER
                : FilePipelineErrorCode.SCANNED_PDF,
              {
                filename,
                fileIdForParseDocument: fileId,
                rawMessage: `cloud summary rejected: ${quality.reason}`,
              },
            )
          }
          const header = data.title
            ? `[文档: ${filename} — ${data.title}]`
            : `[文档: ${filename}]`
          return `${header}\n${summaryText}`
        }

        if (data.status === 'parsing' || data.status === 'pending') {
          observedNotReadyStatus = true
          const retryAfterMs = Math.max(0, data.retry_after_ms ?? CLOUD_SUMMARY_POLL_MS)
          if (Date.now() + retryAfterMs >= deadline) {
            return formatDocumentNotReadyContext(filename, fileId, data.status)
          }
          await waitForCloudSummaryPoll(retryAfterMs, composed)
          continue
        }

        // **W1.3 第 3 轮 Review 2 S1 修复（2026-05-13）**：原实现 status='failed'
        // 走 `return null` → 上游 `fallbackAttachmentText` 兜底 → 用户看到
        // "[附件: foo.pdf (application/pdf)]" 这种**完全没有错误原因**的占位，
        // 持久通道（拖文件到 chat）的错误 UX 远差于临时通道（read_file）。
        // 改为消费 backend `failure_code`，调 SSoT 派发 13 类对应的中文转述文本，
        // 让 LLM 用自己的语气把"为什么失败 / 用户可以做什么"告诉用户。
        if (data.status === 'failed') {
          const failureCode = isFilePipelineErrorCode(data.failure_code)
            ? data.failure_code
            // 旧记录或后端未填 failure_code 时兜底 UNKNOWN_ERROR
            : FilePipelineErrorCode.UNKNOWN_ERROR
          return formatFilePipelineErrorChinesePrompt(failureCode, {
            filename,
            rawMessage: data.message,
          })
        }

        return null
      }
    } catch (err) {
      log.debug('DocParse summary request failed for %s: %s', fileId, err)
      if (observedNotReadyStatus && !sessionAbortSignal?.aborted) {
        return formatDocumentNotReadyContext(filename, fileId, 'parsing')
      }
      return null
    }
  }

  /**
   * 终极兜底文本：所有解析路径都失败时（含云端 summary 也不可用）的简洁元数据。
   * 薄委托到共享 `formatFallbackAttachmentText`，双端字节级对齐；不再暴露 file_id /
   * presigned URL（H2-E Review 必修项，v1.1 已收敛）。
   */
  private fallbackAttachmentText(
    a: { filename?: string; mime_type?: string; size?: number; url?: string; file_id?: string },
  ): string {
    return formatFallbackAttachmentText(a)
  }

  // ─── IPC: abort ─────────────────────────────────────────────────

  /**
   * 跨设备 cancel：Backend 通过 `agent.prompt.cancel` WS envelope 通知本机
   * runtime 取消正在执行的 query（如手机/web 端用户在另一个客户端点 stop）。
   * 本地 IPC 路径的 `handleAbort` 是同一份逻辑的 IPC 入口；此方法是 WS 入口。
   */
  handleAbortFromEnvelope(envelope: Record<string, unknown>): { success: boolean } {
    // ：候选顺序 payload.task_id → envelope.thread_id → payload.thread_id
    // → payload.session_id（与 Daemon AgentHost.cancel 对齐）。老实现只读
    // payload——Django `forward_cancel` 的 payload 只带 task_id、thread_id 在
    // envelope 顶层，导致要么 miss、要么落到「无 id → 全停」的危险分支。
    const candidates = extractAbortIdentityCandidates(envelope)
    for (const id of candidates) {
      const res = this.handleAbort(id)
      if (res.success) return res
    }
    if (candidates.length === 0) {
      // 与 Daemon 对齐：跨设备 cancel 没有任何可校验身份时 fail-closed，不能
      // 退回「全停」。正常 forward_cancel 恒带 envelope.thread_id。
      log.warn('[ElectronAgentHost] agent.prompt.cancel without any id — ignored')
      return { success: false }
    }
    log.warn(
      `[ElectronAgentHost] agent.prompt.cancel miss for all candidates: ${candidates.map((c) => c.slice(0, 12)).join(', ')}`,
    )
    return { success: false }
  }

  handlePauseFromEnvelope(envelope: Record<string, unknown>): { success: boolean } {
    return this.handlePauseControl(envelope, true)
  }

  handleResumeFromEnvelope(envelope: Record<string, unknown>): { success: boolean } {
    return this.handlePauseControl(envelope, false)
  }

  private handlePauseControl(
    envelope: Record<string, unknown>,
    shouldPause: boolean,
  ): { success: boolean } {
    const candidates = extractAbortIdentityCandidates(envelope)
    for (const id of candidates) {
      if (shouldPause) this.rememberPendingPauseCandidate(id)
      else this.pendingPauseCandidateIds.delete(id)
    }
    for (const id of candidates) {
      const keys = resolveConversationAbortKeys(
        id,
        [...this.sessions.values()].map((session) => ({
          key: session.sessionId,
          businessThreadId: session.businessThreadId,
        })),
      )
      if (keys.length === 0) continue
      for (const key of keys) {
        const session = this.sessions.get(key)
        if (!session) continue
        if (shouldPause) session.pauseController.pause()
        else {
          session.pauseController.resume()
          this.ensureBrowserControlParkForKey(key)
        }
      }
      for (const candidate of candidates) this.pendingPauseCandidateIds.delete(candidate)
      return { success: true }
    }
    // pause 未命中并不等于丢失：runtime 创建后会补应用；resume 未命中则已清掉 pending。
    return { success: candidates.length > 0 }
  }

  private rememberPendingPauseCandidate(candidateId: string): void {
    this.pendingPauseCandidateIds.add(candidateId)
    while (this.pendingPauseCandidateIds.size > 256) {
      const oldest = this.pendingPauseCandidateIds.values().next().value
      if (typeof oldest !== 'string') break
      this.pendingPauseCandidateIds.delete(oldest)
    }
  }

  private applyPendingPauseToSession(
    sessionId: string,
    businessThreadId: string,
    pauseController: SessionPauseController,
  ): void {
    const matched = [...this.pendingPauseCandidateIds].filter((candidate) => (
      resolveConversationAbortKeys(candidate, [{ key: sessionId, businessThreadId }]).length > 0
    ))
    if (matched.length === 0) return
    pauseController.pause()
    for (const candidate of matched) this.pendingPauseCandidateIds.delete(candidate)
  }

  /**
   * 跨设备子 Agent cancel：会话由本机 Electron 托管时，用户在另一台 Electron
   * （observer）点「取消子任务」→ Django subagent_cancel handler →
   * forward_subagent_cancel → `_route_to_device` electron-fallback 把
   * `agent.subagent.cancel {child_id}` 转发到此。与 daemon AgentHost.cancelSubagent
   * （daemon.ts）对称；本地 UI 的取消走 IPC `agent-engine:cancel-subagent`，是
   * 同一份逻辑（模块级 `cancelSubagent`）的 IPC 入口。payload 与
   * `handleAbortFromEnvelope` 同款直读（不引 wire schema 依赖）。
   */
  handleSubagentCancelFromEnvelope(envelope: Record<string, unknown>): { success: boolean } {
    const payload = (envelope.payload && typeof envelope.payload === 'object')
      ? envelope.payload as Record<string, unknown>
      : {}
    const childId = typeof payload.child_id === 'string' ? payload.child_id : ''
    if (!childId) {
      log.warn('[ElectronAgentHost] agent.subagent.cancel (WS): missing child_id in payload')
      return { success: false }
    }
    const ok = cancelSubagent(childId)
    log.info(`[ElectronAgentHost] agent.subagent.cancel (WS) ${childId.slice(0, 8)}…: ${ok ? 'aborted' : 'not found'}`)
    return { success: ok }
  }

  /** Host shutdown 专用：即使 promote echo guard 短路 abort，也必须无条件终态双清。 */
  private abortSessionForHostStop(sessionId: string): void {
    try {
      this.handleAbort(sessionId)
    } finally {
      this.clearBrowserControlForStoppedSession(sessionId)
    }
  }

  private handleAbort(sessionId?: string): { success: boolean } {
    if (sessionId) {
      //  停止链路收口：入参可能是业务 sessionId、`chat-session-<uuid>`
      // 形态 thread_id、或 forward 的 task_id。经 resolveConversationAbortKeys 统一
      // 解析——sessions key 直达 + businessThreadId 二次命中，让「按业务
      // sessionId 中止」对 forward 启动的 run（key=task_id）也能生效。
      const keys = resolveConversationAbortKeys(
        sessionId,
        [...this.sessions.values()].map((s) => ({
          key: s.sessionId,
          businessThreadId: s.businessThreadId,
        })),
      )
      // promote 的 chat.cancel 回环：本机已 abort active 且保留排队，禁止再走
      // abortSessionByKey（会 clearQueued / 可能误掐新 run）。
      if (
        this.consumePromoteCancelEchoGuard(
          sessionId,
          ...keys,
          ...keys.map((key) => this.sessions.get(key)?.businessThreadId),
        )
      ) {
        log.info(
          `[abort] promote cancel echo skipped [session=${sessionId.slice(0, 8)}…]`,
        )
        return { success: true }
      }
      // sessions Map 尚未登记（pre-stream：supervisor 已 submit/execute，acquire
      // 未完成）时 resolve 会 miss——仍按业务 sessionId 直打 supervisor，避免
      // 本地 run 继续跑、5s 后 renderer 自愈又开始打字。本机确无负载时返回
      // false，让 handleAbortRun 走 chat.cancel。
      //
      // 停止意图 mark **仅**在 pre-stream miss 时写入；mid-stream 已有
      // abortSessionByKey 掐 signal，若仍 mark 会残留到下一轮 afterSessionReady
      // 误杀（会话毒化）。命中 keys 时主动 consume 清掉陈旧 mark。
      if (keys.length === 0) {
        this.markAbortRequested(sessionId)
        const host = this.requireSharedHost()
        const identity = { conversationId: sessionId, sessionId }
        const stateBefore = host.getState(sessionId)
        const busyBefore = host.getBusyConversationIds()
        const knownLocal = stateBefore.busy || stateBefore.running || busyBefore.includes(sessionId)
        // Map-miss：只打本业务 sessionId；supervisor.abortActiveRun 已含
        // sessionId===conversationId 兜底，不再扫 busyBefore 其它 conversation。
        host.abort(identity)
        host.abortConversationRuns(identity)
        this._modeSwitchHandler?.clearSession(sessionId)
        if (knownLocal) {
          log.info(`abort via supervisor fallback [session=${sessionId.slice(0, 8)}…]`)
          return { success: true }
        }
        log.warn(`abort miss: session not found [session=${sessionId.slice(0, 8)}…]`)
        return { success: false }
      }

      this.consumeAbortRequest(
        sessionId,
        ...keys,
        ...keys.map((key) => this.sessions.get(key)?.businessThreadId),
      )
      for (const key of keys) {
        this.abortSessionByKey(key)
      }
      return { success: true }
    }

    for (const sid of this.sessions.keys()) {
      this.abortSessionByKey(sid)
    }
    log.info('All queries aborted')
    return { success: true }
  }

  /** 按 sessions Map 真实 key 中止单条会话（handleAbort 单/全停共用）。 */
  private abortSessionByKey(key: string): void {
    const session = this.sessions.get(key)
    if (!session) return
    const identity = {
      conversationId: session.businessThreadId ?? key,
      sessionId: key,
    }
    // #6582：host 停路径组合——
    // 1) abort：掐 supervisor activeRun（abortActiveRun）
    // 2) abortConversationRuns：强制 clearQueued(conversationId)
    //    abort()  alone 受 canCancelWholeQueue 约束；同 business conversation
    //    下混 task_id/sessionId 排队时可能不清队。旧停路径始终清整队，这里保留。
    this.requireSharedHost().abort(identity)
    this.requireSharedHost().abortConversationRuns(identity)
    // Stop / 插队只 cancel HITL waiter，不会走 mode-switch-execute。这里按
    // session key 与业务 thread 双清 F7 pending，避免后续 switch_mode 被挡。
    this._modeSwitchHandler?.clearSession(key)
    if (session.businessThreadId && session.businessThreadId !== key) {
      this._modeSwitchHandler?.clearSession(session.businessThreadId)
    }
    // session 层 signal 双保险：runtime.query 绑的是 view.abortController，
    // 与 supervisor activeRun signal 是两路；两路都掐，避免只命中一侧。
    //
    // 禁止在此处 `new AbortController()`：本轮 consumeRuntime 可能尚未执行
    // `signal: view.abortController.signal`，若立刻换新，后续会绑到从未 abort
    // 的 controller，发出后立即停止会整轮跑完。换新改到 afterSessionReady
    //（仅当本轮未取消且旧 signal 已 aborted）。
    session.abortController.abort()
    this.clearBrowserControlForStoppedSession(key)
    session.pauseController.resume()
    // 清掉 active-plan-tracker，避免下一轮 plan-mode-guard 拿到旧 active plan id。
    try {
      clearAllActivePlansForSession(key)
    } catch {
      // best effort —— tracker 自身的异常不应影响 abort 主流程
    }
    // 忙闲权威源在 sharedHost：排队已强制清掉；running 等 query settle 后 idle。
    log.info(`Query aborted [session=${key.slice(0, 8)}…]`)
  }

  /**
   *  出站 abort 收口：本机 IPC 快路径 + 后端 `chat.cancel` 同步，一次调用返回完整结果。
   *
   * 即使本机命中也必须上报 `chat.cancel`：服务端会向同一 session topic 广播
   * ABORT 控制终态，确保手机 / 其它桌面观察端同步结束「思考中」。设备端收到
   * 自己回环的 cancel 只会做一次幂等 abort，不会再次上报。
   */
  /**
   * 取消单条 Host 排队（方案 A 抽屉「移除 / 撤回编辑」）。
   * 不 abort active、不清其它排队。
   */
  async handleCancelQueuedRun(payload?: {
    sessionId?: string
    runId?: string
  }): Promise<{
    success: boolean
    cancelled: boolean
    queuedRunIds: string[]
    error?: string
  }> {
    const sessionId = payload?.sessionId
    const runId = payload?.runId
    if (!sessionId || !runId) {
      return {
        success: false,
        cancelled: false,
        queuedRunIds: [],
        error: 'missing_session_or_run',
      }
    }

    const keys = resolveConversationAbortKeys(
      sessionId,
      [...this.sessions.values()].map((s) => ({
        key: s.sessionId,
        businessThreadId: s.businessThreadId,
      })),
    )

    const host = this.requireSharedHost()
    const identity = keys.length === 0
      ? { conversationId: sessionId, sessionId }
      : (() => {
          const key = keys[0]
          const session = this.sessions.get(key)
          return {
            conversationId: session?.businessThreadId ?? key,
            sessionId: key,
          }
        })()

    const result = host.cancelQueuedRun(identity, runId)
    log.info('[cancelQueuedRun]', {
      sessionId: sessionId.slice(0, 8),
      runId: runId.slice(0, 8),
      cancelled: result.cancelled,
      queued: result.queuedRunIds.length,
    })
    return {
      success: result.cancelled,
      cancelled: result.cancelled,
      queuedRunIds: result.queuedRunIds,
      ...(result.cancelled ? {} : { error: 'not_queued' }),
    }
  }

  /**
   * Host 级插队（方案 A）：把指定排队 run 提到队首并 abort 当前 active。
   * 禁止走 abortSessionByKey（会 clearQueued）。active 被掐时再 chat.cancel 广播。
   */
  async handlePromoteRun(payload?: {
    sessionId?: string
    runId?: string
  }): Promise<{
    success: boolean
    promoted: boolean
    abortedActive: boolean
    /** ：被掐断的 active runId */
    abortedRunId: string | null
    queuedRunIds: string[]
    error?: string
  }> {
    const sessionId = payload?.sessionId
    const runId = payload?.runId
    if (!sessionId || !runId) {
      return {
        success: false,
        promoted: false,
        abortedActive: false,
        abortedRunId: null,
        queuedRunIds: [],
        error: 'missing_session_or_run',
      }
    }

    const keys = resolveConversationAbortKeys(
      sessionId,
      [...this.sessions.values()].map((s) => ({
        key: s.sessionId,
        businessThreadId: s.businessThreadId,
      })),
    )

    const host = this.requireSharedHost()
    let promoted = false
    let abortedActive = false
    let abortedRunId: string | null = null
    let queuedRunIds: string[] = []

    if (keys.length === 0) {
      const result = host.interruptAndPromote(
        { conversationId: sessionId, sessionId },
        runId,
      )
      promoted = result.promoted
      abortedActive = result.abortedActive
      abortedRunId = result.abortedRunId
      queuedRunIds = result.queuedRunIds
    } else {
      const key = keys[0]
      const session = this.sessions.get(key)
      const identity = {
        conversationId: session?.businessThreadId ?? key,
        sessionId: key,
      }
      const result = host.interruptAndPromote(identity, runId)
      promoted = result.promoted
      abortedActive = result.abortedActive
      abortedRunId = result.abortedRunId
      queuedRunIds = result.queuedRunIds
      if (abortedActive && session) {
        session.abortController.abort()
        session.pauseController.resume()
        this.ensureBrowserControlParkForKey(key)
      }
    }

    if (abortedActive) {
      // 武装回环 guard 后再发 cancel；cancel 不挡 IPC 返回（跨端广播 fire-and-forget）
      this.armPromoteCancelEchoGuard(
        sessionId,
        keys[0],
        keys[0] ? this.sessions.get(keys[0])?.businessThreadId : undefined,
      )
      void electronWsGateway
        .requestWithLastAuth('chat.cancel', { session_id: sessionId })
        .catch((err) => {
          log.warn('[promoteRun] chat.cancel failed', {
            sessionId: sessionId.slice(0, 8),
            err,
          })
        })
    }

    log.info('[promoteRun]', {
      sessionId: sessionId.slice(0, 8),
      runId: runId.slice(0, 8),
      promoted,
      abortedActive,
      abortedRunId: abortedRunId?.slice(0, 8),
      queued: queuedRunIds.length,
    })

    return {
      success: promoted,
      promoted,
      abortedActive,
      abortedRunId,
      queuedRunIds,
      ...(promoted ? {} : { error: 'not_queued' }),
    }
  }

  async handleAbortRun(sessionId?: string): Promise<{
    localHit: boolean
    remoteRequested: boolean
    remoteAccepted: boolean
    remotePublished: number | null
  }> {
    const result = {
      localHit: false,
      remoteRequested: false,
      remoteAccepted: false,
      remotePublished: null as number | null,
    }
    if (!sessionId) return result

    // 1. 本机 IPC 快路径。
    if (this.handleAbort(sessionId).success) {
      result.localHit = true
      log.info('[abortRun] local runtime hit', { sessionId: sessionId.slice(0, 8) })
    }

    // 2. 后端同步：本机命中时用于跨端 ABORT 广播；未命中时兼作远端取消兜底。
    result.remoteRequested = true
    try {
      const resp = await electronWsGateway.requestWithLastAuth('chat.cancel', { session_id: sessionId })
      if (resp.ok && resp.type === 'chat.cancel.ok') {
        result.remoteAccepted = true
        const published = (resp.payload as { published?: unknown } | undefined)?.published
        result.remotePublished = typeof published === 'number' ? published : 0
        log.info('[abortRun] chat.cancel accepted', {
          sessionId: sessionId.slice(0, 8),
          published: result.remotePublished,
        })
      } else {
        log.warn('[abortRun] chat.cancel rejected', { sessionId: sessionId.slice(0, 8), type: resp.type })
      }
    } catch (err) {
      log.warn('[abortRun] chat.cancel request failed', err)
    }
    return result
  }

  // ─── IPC: 对话回退 transcript 截断（，本地宿主）───────────────
  //
  // 与 Django 软回退两段式对称：写 rewind 软标记（不删行，可 unrevert），
  // 重建上下文时立即生效；物理截断推迟到发下一条消息（见 handleQueryInternal
  // recordUserMessage 前的 commitRewind）。优先用 live session 的 sessionStorage
  // 避免双实例竞争同一文件；无 live session 时构造瞬态 storage 操作归档文件。

  /** rename 优先；跨设备（EXDEV）时 copy + 删源。 */
  private async moveDirPreferRename(from: string, to: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(to), { recursive: true })
    try {
      await fs.promises.rename(from, to)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== 'EXDEV') throw err
      await fs.promises.cp(from, to, { recursive: true })
      await fs.promises.rm(from, { recursive: true, force: true })
    }
  }

  /**
   * ：本机 transcript 是否已落盘（message-blocks 或 messages 任一非空）。
   */
  private sessionTranscriptExists(sessionDir: string, sessionId: string): boolean {
    return ['message-blocks.jsonl', 'messages.jsonl'].some((name) => {
      const filePath = path.join(sessionDir, sessionId, name)
      return fs.existsSync(filePath) && fs.statSync(filePath).size > 0
    })
  }

  /**
   * ：解析会话归档目录——硬切新布局，不再 dual-read legacy platform-data。
   * 写路径 / 读路径统一：`users/{userId}/.../workspaces/{space}/conversations/sessions`。
   * 缺失 userId（未认证）直接抛错，调用方（IPC handler）已用 try/catch 兜底成
   * `{ success: false, error }`，不会崩宿主进程。
   */
  private async resolveSessionArchiveDirs(payload: {
    sessionId?: string
    spaceId?: string
    organizationId?: string
  }): Promise<{
    organizationId: string
    spaceId: string
    sessionDir: string
    toolLogsDir: string
    safeRoot: string
  }> {
    const spaceId = payload.spaceId ?? getCLISpaceId() ?? undefined
    const organizationId = payload.organizationId ?? getCLIOrganizationId() ?? undefined
    if (!organizationId || !spaceId) {
      throw new Error(
        'resolveSessionArchiveDirs requires organizationId+spaceId ( hard-cut — no _unscoped)',
      )
    }
    const userId = await this.requireSkillUserId()
    const dataRoot = resolveDataRoot()

    return {
      organizationId,
      spaceId,
      sessionDir: resolveWorkspaceSessionArchiveDir(dataRoot, userId, organizationId, spaceId),
      toolLogsDir: resolveWorkspaceToolLogsDir(dataRoot, userId, organizationId, spaceId),
      safeRoot: dataRoot,
    }
  }

  private async withTranscriptStorage<T>(
    payload: { sessionId: string; spaceId?: string; organizationId?: string },
    fn: (storage: SessionStorage) => Promise<T>,
  ): Promise<T> {
    const live = this.sessions.get(payload.sessionId)
    if (live) return fn(live.sessionStorage)

    const { sessionDir } = await this.resolveSessionArchiveDirs(payload)
    const storage = new SessionStorage({ sessionDir, threadId: payload.sessionId })
    try {
      return await fn(storage)
    } finally {
      await storage.dispose()
    }
  }

  /**
   * 首条 send 前再 seed 一次：重启回灌是 fire-and-forget，
   * 不能让「立刻发送」抢在档案写入之前把 live user 落盘。
   */
  private async ensureImportedArchiveSeeded(request: QueryRequest): Promise<void> {
    const organizationId = request.organizationId?.trim()
    const spaceId = request.spaceId?.trim() || request.workspaceId?.trim()
    const sessionId = request.threadId?.trim()
    if (!organizationId || !spaceId || !sessionId) return
    try {
      const archive = findArchiveByOpenedSessionId(organizationId, sessionId)
      if (!archive) return
      const result = await this.seedExternalArchiveTranscript({
        sessionId: archive.meta.openedSessionId?.trim() || sessionId,
        spaceId,
        organizationId,
        messages: archive.messages,
        meta: {
          source: archive.meta.source,
          sourceSessionId: archive.meta.sourceSessionId,
          title: archive.meta.title,
          cwd: archive.meta.cwd,
        },
      })
      if (
        !result.seeded
        && result.reason !== 'already_present'
        && result.reason !== 'empty_archive'
      ) {
        log.warn('导入档案写入 transcript 失败，本轮可能看不到导入上文', {
          sessionId,
          reason: result.reason,
        })
      }
    } catch (error) {
      log.warn('导入档案写入 transcript 失败，本轮可能看不到导入上文', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * 导入档案写入本机 transcript。始终用无 onWrite 的独立 SessionStorage，
   * 避免导入正文进入 Django sync。
   */
  async seedExternalArchiveTranscript(payload: {
    sessionId: string
    spaceId: string
    organizationId: string
    messages: Array<{
      id: string
      role: 'user' | 'assistant'
      content_blocks: unknown[]
    }>
    meta: {
      source: string
      sourceSessionId: string
      title: string
      cwd: string | null
    }
  }): Promise<{ seeded: boolean; reason: string }> {
    const pending = this.archiveSeedInFlight.get(payload.sessionId)
    if (pending) return pending
    const task = this.writeExternalArchiveTranscript(payload)
    this.archiveSeedInFlight.set(payload.sessionId, task)
    try {
      return await task
    } finally {
      if (this.archiveSeedInFlight.get(payload.sessionId) === task) {
        this.archiveSeedInFlight.delete(payload.sessionId)
      }
    }
  }

  private async writeExternalArchiveTranscript(payload: {
    sessionId: string
    spaceId: string
    organizationId: string
    messages: Array<{
      id: string
      role: 'user' | 'assistant'
      content_blocks: unknown[]
    }>
    meta: {
      source: string
      sourceSessionId: string
      title: string
      cwd: string | null
    }
  }): Promise<{ seeded: boolean; reason: string }> {
    const { seedExternalArchiveIntoSessionStorage } = await import(
      '../agent-import/seed-external-archive-transcript.js'
    )
    const { sessionDir } = await this.resolveSessionArchiveDirs({
      sessionId: payload.sessionId,
      spaceId: payload.spaceId,
      organizationId: payload.organizationId,
    })
    const storage = new SessionStorage({
      sessionDir,
      threadId: payload.sessionId,
    })
    try {
      const reason = await seedExternalArchiveIntoSessionStorage(
        storage,
        payload.meta,
        payload.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content_blocks: Array.isArray(message.content_blocks)
            ? message.content_blocks
            : [],
        })),
      )
      return { seeded: reason === 'seeded', reason }
    } finally {
      await storage.dispose()
    }
  }

  /**
   * 移动端发起时间线重写时，Django 会先下发 ``file_history_preview`` 读取本机
   * 文件影响，再在用户确认后下发 ``session_transcript_truncate`` 执行回退。
   * 这里不直接调用后端 rollback API；收到执行结果后由 Django 更新会话投影，
   * 保证 preview-before-confirm 与 runtime-first 顺序。
   */
  private async handleDeviceTranscriptRollbackAction(
    payload: Record<string, unknown>,
    envelope?: Record<string, unknown>,
  ): Promise<boolean> {
    const action = payload.action
    if (action !== 'session_transcript_truncate' && action !== 'file_history_preview') return false

    const taskId = typeof payload.task_id === 'string' ? payload.task_id : ''
    const threadId = typeof envelope?.thread_id === 'string' && envelope.thread_id
      ? envelope.thread_id
      : typeof payload.thread_id === 'string' ? payload.thread_id : ''
    if (!taskId || !threadId) {
      log.warn('[device-transcript-rewind] missing task_id or thread_id')
      return true
    }

    const rawParams = payload.params
    const params = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
      ? rawParams as Record<string, unknown>
      : {}
    const sessionId = typeof params.session_id === 'string' ? params.session_id : ''
    const expectedSessionId = threadId.startsWith('chat-session-')
      ? threadId.slice('chat-session-'.length)
      : threadId

    let actionResult: {
      success: boolean
      error?: string
      error_code?: string
      data?: Record<string, unknown>
    }
    if (!sessionId || sessionId !== expectedSessionId) {
      actionResult = {
        success: false,
        error: 'session_id does not match the authenticated thread',
        error_code: 'INVALID_ROLLBACK_TARGET',
      }
    } else if (action === 'file_history_preview') {
      const anchorId = typeof params.anchor_id === 'string' ? params.anchor_id : ''
      if (!anchorId) {
        actionResult = {
          success: true,
          data: {
            file_preview_status: 'not_applicable',
            file_preview_reason: 'no_file_anchor',
            affected_paths: [],
            unrestorable_files: [],
            file_preview_revision: await buildLocalFilePreviewRevision({
              sessionId,
              deviceFingerprint: getDeviceFingerprint(),
              rewindAnchorId: null,
              status: 'not_applicable',
              reason: 'no_file_anchor',
              affectedPaths: [],
              fingerprints: [],
            }),
          },
        }
      } else {
        const checker = getDefaultPathAccessChecker()
        const preview = await previewControlDeviceFiles(sessionId, anchorId, {
          getFileHistory: getOrResumeFileHistory,
          pathGuard: (absPath) => {
            const access = checker.check(absPath, 'write')
            return { allowed: access.allowed, reason: access.reason?.message }
          },
        })
        actionResult = {
          // “不可确认”也是一次成功送达的预览结果；具体状态放在 data，后端才能把
          // 原因呈现给用户，而不是把它压成笼统的网络/设备失败。
          success: true,
          data: {
            file_preview_status: preview.status,
            file_preview_reason: preview.reason,
            affected_paths: preview.paths,
            unrestorable_files: preview.unrestorable,
            file_preview_revision: preview.revision,
            ...(preview.success ? {} : { file_preview_error: preview.error }),
          },
        }
      }
    } else {
      const targetRole = params.target_role === 'user' || params.target_role === 'assistant'
        ? params.target_role
        : undefined
      const mode = params.mode === 'rollback' || params.mode === 'editAndResend'
        ? params.mode
        : undefined
      const targetOccurrenceIndex = typeof params.target_occurrence_index === 'number'
        && Number.isFinite(params.target_occurrence_index)
        ? params.target_occurrence_index
        : undefined
      const keepMessageCount = typeof params.keep_message_count === 'number'
        && Number.isFinite(params.keep_message_count)
        ? params.keep_message_count
        : undefined
      const fileRewindAnchorId = typeof params.file_rewind_anchor_id === 'string'
        && params.file_rewind_anchor_id.length > 0
        ? params.file_rewind_anchor_id
        : undefined
      const releaseTimelineRewrite = this.tryAcquireTimelineRewrite(sessionId)
      if (!releaseTimelineRewrite) {
        actionResult = {
          success: false,
          error: 'Conversation has an active or pending run; retry timeline rewrite when it is idle',
          error_code: 'RUNTIME_SESSION_BUSY',
        }
      } else try {
      const expectedFilePreviewRevision = typeof params.expected_file_preview_revision === 'string'
        && params.expected_file_preview_revision.length > 0
        ? params.expected_file_preview_revision
        : undefined
      let preflightError: string | null = null
      let confirmedUnrestorableFiles: Array<{ path: string; reason: string }> = []
      if (fileRewindAnchorId && expectedFilePreviewRevision) {
        const checker = getDefaultPathAccessChecker()
        const currentPreview = await previewControlDeviceFiles(sessionId, fileRewindAnchorId, {
          getFileHistory: getOrResumeFileHistory,
          pathGuard: (absPath) => {
            const access = checker.check(absPath, 'write')
            return { allowed: access.allowed, reason: access.reason?.message }
          },
        })
        if (currentPreview.revision !== expectedFilePreviewRevision) {
          preflightError = 'workspace file preview is stale; recheck before editing and resending'
        } else {
          confirmedUnrestorableFiles = currentPreview.unrestorable
            .map(({ path, reason }) => ({ path, reason }))
        }
      }
      if (preflightError) {
        // 文件预览已过期时，在 transcript boundary 之前拒绝，不产生任何副作用。
        actionResult = {
          success: false,
          error: preflightError,
          error_code: 'ROLLBACK_PREVIEW_STALE',
        }
      } else {
        const result = await executeDeviceSessionRewind({
          fileRewindAnchorId,
          confirmedUnrestorableFiles,
          rewindTranscript: () => this.handleRollbackTranscript({
            sessionId,
            targetMessageId: typeof params.target_message_id === 'string' ? params.target_message_id : undefined,
            targetRole,
            targetContent: typeof params.target_content === 'string' ? params.target_content : undefined,
            targetOccurrenceIndex,
            mode,
            keepMessageCount,
            spaceId: typeof params.space_id === 'string' ? params.space_id : undefined,
            organizationId: typeof params.organization_id === 'string' ? params.organization_id : undefined,
          }),
          // Electron 的 per-file history 以 sessionId 建账；wire threadId 只用于上面的
          // 认证匹配，不能直接当文件账本 key。
          rewindFiles: async (anchorId) => {
            let guardBlocked = 0
            const checker = getDefaultPathAccessChecker()
            const outcome = await rewindControlDeviceFiles(sessionId, anchorId, {
              getFileHistory: getOrResumeFileHistory,
              pathGuard: (absPath) => {
                const access = checker.check(absPath, 'write')
                if (!access.allowed) guardBlocked++
                return { allowed: access.allowed, reason: access.reason?.message }
              },
              expectedPreviewRevision: expectedFilePreviewRevision,
            })
            if (outcome.success) {
              log.info('[device-file-rewind] completed before rollback projection', {
                sessionId: sessionId.slice(0, 8),
                anchorId,
                restored: outcome.result.filesRestored.length,
                deleted: outcome.result.filesDeleted.length,
                failed: outcome.result.failedFiles.length,
                guardBlocked,
              })
            } else {
              log.warn('[device-file-rewind] failed before rollback projection', {
                sessionId: sessionId.slice(0, 8),
                anchorId,
                guardBlocked,
                error: outcome.error,
              })
            }
            return outcome
          },
        })
        actionResult = result.success
          ? { success: true, data: result.data }
          : {
              success: false,
              error: result.error,
              error_code: result.errorCode,
            }
        }
      } finally {
        releaseTimelineRewrite()
      }
    }

    try {
      const response = await electronWsGateway.requestWithLastAuth(
        AgentActionEvents.RESULT,
        { task_id: taskId, ...actionResult },
        { threadId },
      )
      if (!response.ok) {
        log.warn('[device-transcript-rewind] failed to return result', {
          taskId,
          error: response.error?.message,
        })
      }
    } catch (error) {
      log.warn('[device-transcript-rewind] result delivery threw', { taskId, error })
    }
    return true
  }

  private async handleRollbackTranscriptWithGate(
    payload: RollbackTranscriptPayload,
  ): Promise<{ success: boolean; applied?: boolean; keepMessageCount?: number | null; error?: string }> {
    if (!payload?.sessionId) return { success: false, error: 'sessionId is required' }
    const release = this.tryAcquireTimelineRewrite(payload.sessionId)
    if (!release) {
      return { success: false, applied: false, error: 'Conversation has an active or pending run' }
    }
    try {
      return await this.handleRollbackTranscript(payload)
    } finally {
      release()
    }
  }

  private async handleRollbackTranscript(
    payload: RollbackTranscriptPayload,
  ): Promise<{ success: boolean; applied?: boolean; keepMessageCount?: number | null; error?: string }> {
    if (!payload?.sessionId) {
      return { success: false, error: 'sessionId is required' }
    }
    try {
      const result = await this.withTranscriptStorage(payload, async (storage) => storage.applyTimelineRewind({
        target: {
          messageId: payload.targetMessageId,
          role: payload.targetRole,
          content: payload.targetContent,
          occurrenceIndex: payload.targetOccurrenceIndex,
        },
        mode: payload.mode ?? (payload.targetRole === 'assistant' ? 'rollback' : 'editAndResend'),
        fallbackKeepMessageCount: payload.keepMessageCount,
      }))
      // applied=false：找不到锚点且无 fallback → transcript 未截断（fail-visible，
      // 让调用方告知用户「上下文可能未完全回退」，避免静默泄漏）。
      // ：回退后 plan 文件可能已被 checkpoint 还原/删除，清 active-plan-tracker，
      // 避免 guard / reminder 引用已消失的 plan（幽灵引用）。
      if (result.applied) {
        try { clearAllActivePlansForSession(payload.sessionId) } catch { /* best effort */ }
      }
      log.info(
        `[rollback-transcript] session=${payload.sessionId.slice(0, 8)}… keep=${result.keepMessageCount ?? 'skip(no-boundary)'}`,
      )
      return { success: true, applied: result.applied, keepMessageCount: result.keepMessageCount }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log.warn(`[rollback-transcript] failed session=${payload.sessionId.slice(0, 8)}…: ${error}`)
      return { success: false, error }
    }
  }

  private async handleRollbackSessionTimeline(
    payload: RollbackSessionTimelinePayload,
  ): Promise<RollbackSessionTimelineResult> {
    if (!payload?.sessionId) return { success: false, error: 'sessionId is required' }
    const release = this.tryAcquireTimelineRewrite(payload.sessionId)
    if (!release) {
      return {
        success: false,
        applied: false,
        error: 'Conversation has an active or pending run; retry timeline rewrite when it is idle',
      }
    }
    try {
      return await this.handleRollbackSessionTimelineLocked(payload)
    } finally {
      release()
    }
  }

  private async handleRollbackSessionTimelineLocked(
    payload: RollbackSessionTimelinePayload,
  ): Promise<RollbackSessionTimelineResult> {
    if (!payload?.sessionId) return { success: false, error: 'sessionId is required' }
    if (!payload.targetMessageId) return { success: false, error: 'targetMessageId is required' }

    const mode = payload.mode ?? (payload.targetRole === 'assistant' ? 'rollback' : 'editAndResend')
    const rollbackContractVersion = payload.rollbackContractVersion ?? (mode === 'editAndResend' ? 2 : 1)
    let confirmedUnrestorableFiles: Array<{ path: string; reason: string }> = []
    if (mode === 'editAndResend' && rollbackContractVersion >= 2) {
      if (!payload.previewRevision || !payload.filePreviewRevision) {
        return {
          success: false,
          applied: false,
          error: 'rollback preview revisions are required',
        }
      }
      const currentFilePreview = payload.fileRewindAnchorId
        ? await previewControlDeviceFiles(payload.sessionId, payload.fileRewindAnchorId, {
            getFileHistory: getOrResumeFileHistory,
            pathGuard: (absPath) => {
              const access = getDefaultPathAccessChecker().check(absPath, 'write')
              return { allowed: access.allowed, reason: access.reason?.message }
            },
          })
        : {
            success: true as const,
            status: 'not_applicable' as const,
            reason: 'no_file_anchor' as const,
            unrestorable: [] as Array<{ path: string; reason: string; detail?: string }>,
            revision: await buildLocalFilePreviewRevision({
              sessionId: payload.sessionId,
              deviceFingerprint: getDeviceFingerprint(),
              rewindAnchorId: null,
              status: 'not_applicable',
              reason: 'no_file_anchor',
              affectedPaths: [],
              fingerprints: [],
            }),
          }
      if (currentFilePreview.revision !== payload.filePreviewRevision) {
        return {
          success: false,
          applied: false,
          error: 'workspace file preview is stale; recheck before editing and resending',
        }
      }
      confirmedUnrestorableFiles = (currentFilePreview.unrestorable ?? [])
        .map(({ path, reason }) => ({ path, reason }))
      if (currentFilePreview.status === 'unavailable') {
        const stableConversationOnlyReasons = new Set([
          'no_file_history',
          'file_snapshot_missing',
          'path_guard_denied',
          'unrestorable_files',
        ])
        if (
          !currentFilePreview.reason
          || !stableConversationOnlyReasons.has(currentFilePreview.reason)
          || payload.acknowledgedFilePreviewReason !== currentFilePreview.reason
        ) {
          return {
            success: false,
            applied: false,
            error: 'workspace files cannot be verified; explicitly confirm conversation-only rewrite',
          }
        }
      }
    }

    let runtimeRewindApplied = false
    let backendRollbackApplied = false
    let backendAfterRollback: Record<string, unknown> = {}
    let appliedKeepMessageCount: number | null | undefined
    try {
      const timeline = await this.withTranscriptStorage(payload, async (storage) => storage.applyTimelineRewind({
        target: {
          messageId: payload.targetMessageId,
          role: payload.targetRole,
          content: payload.targetContent,
          occurrenceIndex: payload.targetOccurrenceIndex,
        },
        mode,
        fallbackKeepMessageCount: payload.keepMessageCount,
      }))
      if (!timeline.applied) {
        log.warn(`[rollback-session-timeline] runtime boundary not applied session=${payload.sessionId.slice(0, 8)}…`)
        return { success: false, applied: false, keepMessageCount: timeline.keepMessageCount, error: 'runtime rollback boundary not applied' }
      }
      runtimeRewindApplied = true
      appliedKeepMessageCount = timeline.keepMessageCount
      // ：回退边界已应用 → plan 文件可能被 checkpoint 还原/删除，清 active-plan-tracker
      // 避免 guard / reminder 引用幽灵 plan。
      try { clearAllActivePlansForSession(payload.sessionId) } catch { /* best effort */ }

      const token = await TokenManager.getAccessToken()
      if (!token) {
        await this.withTranscriptStorage(payload, (storage) => storage.clearRewind()).catch(() => undefined)
        runtimeRewindApplied = false
        return { success: false, applied: false, keepMessageCount: timeline.keepMessageCount, error: 'Not authenticated' }
      }
      const response = await fetch(joinApiPath(API_BASE_URL, `/chat/sessions/${encodeURIComponent(payload.sessionId)}/rollback`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Client-Type': 'electron',
          ...(payload.organizationId ? { 'X-Organization-Id': payload.organizationId } : {}),
        },
        body: JSON.stringify({
          target_message_id: payload.targetMessageId,
          runtime_rewind_applied: true,
          runtime_keep_message_count: timeline.keepMessageCount,
          mode,
          ...(payload.previewRevision ? { preview_revision: payload.previewRevision } : {}),
          ...(payload.filePreviewRevision ? { file_preview_revision: payload.filePreviewRevision } : {}),
          ...(payload.acknowledgedFilePreviewReason
            ? { acknowledged_file_preview_reason: payload.acknowledgedFilePreviewReason }
            : {}),
          rollback_contract_version: rollbackContractVersion,
          ...(mode === 'editAndResend' && rollbackContractVersion >= 2 && payload.fileRewindAnchorId
            ? { defer_local_file_restore_finalize: true }
            : {}),
          ...(payload.safetySnapshotHash ? { safety_snapshot_hash: payload.safetySnapshotHash } : {}),
          ...(payload.rollbackReason ? { rollback_reason: payload.rollbackReason } : {}),
        }),
      })
      const body = await response.json().catch(() => null) as unknown
      if (!response.ok) {
        await this.withTranscriptStorage(payload, (storage) => storage.clearRewind()).catch(() => undefined)
        runtimeRewindApplied = false
        const message = body && typeof body === 'object' && 'message' in body
          ? String((body as { message?: unknown }).message)
          : `HTTP ${response.status}`
        return { success: false, applied: false, keepMessageCount: timeline.keepMessageCount, backend: body, error: message }
      }
      let backend = body && typeof body === 'object' && 'data' in body
        ? (body as { data?: unknown }).data
        : body
      backendRollbackApplied = true
      backendAfterRollback = backend && typeof backend === 'object'
        ? backend as Record<string, unknown>
        : {}
      if (
        mode === 'editAndResend'
        && rollbackContractVersion >= 2
        && payload.fileRewindAnchorId
        && payload.filePreviewRevision
      ) {
        const baseBackend = backend && typeof backend === 'object'
          ? backend as Record<string, unknown>
          : {}
        const pendingApply = resolvePendingFileRestoreApply(baseBackend)
        if (
          !pendingApply.required
          || !pendingApply.applyId
          || !pendingApply.expiresAt
          || !payload.previewRevision
        ) {
          // DB/transcript 已回退，但服务端没有把文件层置 pending。禁止继续写盘，
          // 并让 renderer 以“已回退、停发保稿”收口，避免审计再次误报 success。
          backend = {
            ...baseBackend,
            file_restore_coordinated_by_host: true,
            file_restore_host: 'local',
            file_restore_success: false,
            file_restore_status: 'failed',
            file_restore_reason: 'file_restore_finalize_contract_missing',
            failed_files: [],
          }
          return { success: true, applied: true, keepMessageCount: timeline.keepMessageCount, backend }
        }
        const leaseExpiryMs = Date.parse(pendingApply.expiresAt)
        if (!Number.isFinite(leaseExpiryMs) || leaseExpiryMs <= Date.now() + 1_000) {
          // 租约已经过期或即将过期时绝不能再写盘。服务端会把这次 pending
          // 结算成 result_unknown，renderer 保稿并要求用户重新预览。
          backend = {
            ...baseBackend,
            file_restore_coordinated_by_host: true,
            file_restore_host: 'local',
            file_restore_success: false,
            file_restore_status: 'failed',
            file_restore_reason: 'file_restore_finalize_expired',
            failed_files: [],
          }
          return { success: true, applied: true, keepMessageCount: timeline.keepMessageCount, backend }
        }
        // 桌面端编辑重发的文件 compare-and-rewind 必须与 Host 时间线重写
        // 共用同一 operation gate；不再释放锁后交给 renderer 另起一次 IPC 写盘。
        const checker = getDefaultPathAccessChecker()
        const fileOutcome = await rewindControlDeviceFiles(
          payload.sessionId,
          payload.fileRewindAnchorId,
          {
            getFileHistory: getOrResumeFileHistory,
            pathGuard: (absPath) => {
              const access = checker.check(absPath, 'write')
              return { allowed: access.allowed, reason: access.reason?.message }
            },
            expectedPreviewRevision: payload.filePreviewRevision,
          },
        )
        let finalResult: LocalFileRestoreFinalResult
        if (fileOutcome.success) {
          const failedCount = fileOutcome.result.failedFiles.length
          const restoredCount = fileOutcome.result.filesRestored.length + fileOutcome.result.filesDeleted.length
          const knownIssuePaths = new Set(confirmedUnrestorableFiles.map(item => item.path))
          finalResult = {
            status: failedCount > 0
              ? restoredCount > 0 ? 'partial' : 'failed'
              : restoredCount > 0 ? 'success' : 'not_applicable',
            reason: failedCount > 0
              ? 'unrestorable_files'
              : restoredCount > 0 ? null : 'no_file_changes',
            failedFiles: fileOutcome.result.failedFiles,
            unrestorableFiles: [
              ...confirmedUnrestorableFiles,
              ...fileOutcome.result.failedFiles
                .filter(path => !knownIssuePaths.has(path))
                .map(path => ({ path, reason: 'rewind_failed' })),
            ],
          }
        } else {
          const confirmedFailedFiles = (
            fileOutcome.reason === 'unrestorable_files'
            || fileOutcome.reason === 'path_guard_denied'
          )
            ? confirmedUnrestorableFiles.map(item => item.path)
            : []
          finalResult = {
            status: fileOutcome.reason === 'no_file_history'
              || fileOutcome.reason === 'file_snapshot_missing'
              || fileOutcome.reason === 'path_guard_denied'
              || fileOutcome.reason === 'unrestorable_files'
              ? 'unavailable'
              : 'failed',
            reason: fileOutcome.reason,
            failedFiles: confirmedFailedFiles,
            unrestorableFiles: confirmedUnrestorableFiles,
          }
        }
        const finalized = await finalizeLocalFileRestore({
          apiBaseUrl: API_BASE_URL,
          sessionId: payload.sessionId,
          accessToken: token,
          organizationId: payload.organizationId,
          applyId: pendingApply.applyId,
          rollbackContractVersion,
          previewRevision: payload.previewRevision,
          filePreviewRevision: payload.filePreviewRevision,
          result: finalResult,
        })
        if (!finalized.ok) {
          log.warn('[rollback-session-timeline] local file result finalize failed', {
            sessionId: payload.sessionId,
            applyId: pendingApply.applyId,
            error: finalized.error,
          })
          backend = {
            ...baseBackend,
            file_restore_coordinated_by_host: true,
            file_restore_host: 'local',
            file_restore_success: false,
            file_restore_status: 'failed',
            file_restore_reason: 'file_restore_finalize_failed',
            failed_files: finalResult.failedFiles,
          }
        } else {
          backend = mergeFinalizedFileRestoreBackend(baseBackend, finalized.data)
        }
      }
      log.info(
        `[rollback-session-timeline] session=${payload.sessionId.slice(0, 8)}… keep=${timeline.keepMessageCount}`,
      )
      return { success: true, applied: true, keepMessageCount: timeline.keepMessageCount, backend }
    } catch (err) {
      if (runtimeRewindApplied && !backendRollbackApplied) {
        await this.withTranscriptStorage(payload, (storage) => storage.clearRewind()).catch(() => undefined)
      }
      const error = err instanceof Error ? err.message : String(err)
      log.warn(`[rollback-session-timeline] failed session=${payload.sessionId.slice(0, 8)}…: ${error}`)
      if (backendRollbackApplied) {
        // Django 已接受回退后，本地 rewind 不能再清，否则服务端/运行时会分叉。
        // 把后续异常投影成文件层失败，让 renderer 进入“已回退、停发保稿”。
        return {
          success: true,
          applied: true,
          keepMessageCount: appliedKeepMessageCount,
          backend: {
            ...backendAfterRollback,
            file_restore_coordinated_by_host: true,
            file_restore_host: 'local',
            file_restore_success: false,
            file_restore_status: 'failed',
            file_restore_reason: 'file_restore_finalize_failed',
            failed_files: [],
          },
          error,
        }
      }
      return { success: false, error }
    }
  }

  private async handleUnrevertTranscript(payload: {
    sessionId: string
    spaceId?: string
    organizationId?: string
  }): Promise<{ success: boolean; error?: string }> {
    if (!payload?.sessionId) return { success: false, error: 'sessionId is required' }
    try {
      await this.withTranscriptStorage(payload, (storage) => storage.clearRewind())
      log.info(`[unrevert-transcript] session=${payload.sessionId.slice(0, 8)}…`)
      return { success: true }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log.warn(`[unrevert-transcript] failed session=${payload.sessionId.slice(0, 8)}…: ${error}`)
      return { success: false, error }
    }
  }

  private async handleUnrevertTranscriptWithGate(payload: {
    sessionId: string
    spaceId?: string
    organizationId?: string
  }): Promise<{ success: boolean; error?: string }> {
    if (!payload?.sessionId) return { success: false, error: 'sessionId is required' }
    const release = this.tryAcquireTimelineRewrite(payload.sessionId)
    if (!release) return { success: false, error: 'Conversation has an active or pending run' }
    try {
      return await this.handleUnrevertTranscript(payload)
    } finally {
      release()
    }
  }

  /**
   *  Composer Stop「撤回未答轮次」（Unsend via runtime）。
   *
   * 产品语义：助手尚无实质输出时 Stop = 发错了；撤回本轮 user（无 checkpoint 前提）。
   * 编排：abort → runtime `editAndResend` rewind → **立即** `commitRewind`（及 events
   * 对称截断）→ 主进程投影 `withdraw-unanswered` 物理删除（并取消空会话标题生成）。
   * 渲染进程不得直打 Django；未落库时 Django 404 视为投影跳过，不回滚已 commit 的 transcript。
   */
  private async handleWithdrawUnansweredTurn(payload: {
    sessionId: string
    clientMessageId: string
    localMessageId?: string
    targetContent?: string
    spaceId?: string
    organizationId?: string
    /** agent.prompt.cancel 入站回环已由 Django 广播终态，禁止再次请求 chat.cancel。 */
    skipRemoteCancelSync?: boolean
  }): Promise<{
    success: boolean
    aborted: {
      localHit: boolean
      remoteRequested: boolean
      remoteAccepted: boolean
      remotePublished: number | null
    }
    runtimeApplied: boolean
    keepMessageCount: number | null
    backendProjected: boolean
    titleReset?: boolean
    title?: string | null
    titleGenerationStatus?: string | null
    error?: string
  }> {
    const emptyAbort = {
      localHit: false,
      remoteRequested: false,
      remoteAccepted: false,
      remotePublished: null as number | null,
    }
    if (!payload?.sessionId) {
      return {
        success: false,
        aborted: emptyAbort,
        runtimeApplied: false,
        keepMessageCount: null,
        backendProjected: false,
        error: 'sessionId is required',
      }
    }
    if (!payload.clientMessageId) {
      return {
        success: false,
        aborted: emptyAbort,
        runtimeApplied: false,
        keepMessageCount: null,
        backendProjected: false,
        error: 'clientMessageId is required',
      }
    }

    const aborted = payload.skipRemoteCancelSync
      ? {
          localHit: this.handleAbort(payload.sessionId).success,
          remoteRequested: false,
          remoteAccepted: false,
          remotePublished: null,
        }
      : await this.handleAbortRun(payload.sessionId)
    try {
      await this.requireSharedHost().cancelSessionDelivery(payload.sessionId)
    } catch (err) {
      log.warn('[withdraw-unanswered] cancelSessionDelivery failed', err)
    }

    let runtimeApplied = false
    let keepMessageCount: number | null = null
    try {
      const timeline = await this.withTranscriptStorage(payload, async (storage) => {
        const applied = await storage.applyTimelineRewind({
          target: {
            messageId: payload.clientMessageId,
            role: 'user',
            content: payload.targetContent,
          },
          mode: 'editAndResend',
        })
        if (!applied.applied) return applied
        const cutTs = await storage.commitRewind()
        const live = this.sessions.get(payload.sessionId)
        if (cutTs !== null && live) {
          await live.eventStorage.truncateFrom(cutTs).catch((err) => {
            log.warn('[withdraw-unanswered] eventStorage.truncateFrom failed', err)
          })
        }
        return applied
      })
      runtimeApplied = timeline.applied
      keepMessageCount = timeline.keepMessageCount
      if (timeline.applied) {
        try { clearAllActivePlansForSession(payload.sessionId) } catch { /* best effort */ }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log.warn(`[withdraw-unanswered] runtime rewind failed session=${payload.sessionId.slice(0, 8)}…: ${error}`)
      return {
        success: false,
        aborted,
        runtimeApplied: false,
        keepMessageCount: null,
        backendProjected: false,
        error,
      }
    }

    // 主进程投影 Django 物理删除（与 rollback 同通道，非 renderer fetch）。
    // 未落库 404 → 投影跳过仍算成功；其它失败只留痕，不撤销已 commit 的本地 transcript。
    let backendProjected = false
    let titleReset = false
    let restoredTitle: string | null = null
    let titleGenerationStatus: string | null = null
    if (runtimeApplied) {
      const projected = await this.projectWithdrawToBackend({
        sessionId: payload.sessionId,
        targetMessageId: payload.clientMessageId,
        keepMessageCount,
        organizationId: payload.organizationId,
      })
      backendProjected = projected.ok
      titleReset = projected.titleReset ?? false
      restoredTitle = projected.title ?? null
      titleGenerationStatus = projected.titleGenerationStatus ?? null
      if (!projected.ok && projected.error) {
        log.warn(
          `[withdraw-unanswered] backend projection skipped session=${payload.sessionId.slice(0, 8)}…: ${projected.error}`,
        )
      }
    }

    log.info(
      `[withdraw-unanswered] session=${payload.sessionId.slice(0, 8)}… ` +
      `runtime=${runtimeApplied} keep=${keepMessageCount ?? 'n/a'} backend=${backendProjected} ` +
      `titleReset=${titleReset} localHit=${aborted.localHit}`,
    )
    return {
      success: true,
      aborted,
      runtimeApplied,
      keepMessageCount,
      backendProjected,
      titleReset,
      title: restoredTitle,
      titleGenerationStatus,
    }
  }

  /**
   *  主进程投影：调用 withdraw-unanswered 物理删除未答 user。
   * **禁止**走 `/rollback`——那会写 soft revert、插「回退完成」系统气泡、弹出「恢复原状」横幅。
   */
  private async projectWithdrawToBackend(input: {
    sessionId: string
    targetMessageId: string
    keepMessageCount: number | null
    organizationId?: string
  }): Promise<{
    ok: boolean
    error?: string
    titleReset?: boolean
    title?: string | null
    titleGenerationStatus?: string | null
  }> {
    try {
      const token = await TokenManager.getAccessToken()
      if (!token) return { ok: false, error: 'Not authenticated' }
      const response = await fetch(
        joinApiPath(
          API_BASE_URL,
          `/chat/sessions/${encodeURIComponent(input.sessionId)}/withdraw-unanswered`,
        ),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            ...(input.organizationId ? { 'X-Organization-Id': input.organizationId } : {}),
          },
          body: JSON.stringify({
            client_message_id: input.targetMessageId,
            runtime_withdraw_applied: true,
          }),
        },
      )
      if (response.status === 404) {
        // 会话不存在等：本地已 commit，留痕即可。
        return { ok: false, error: 'session_or_target_not_found' }
      }
      if (!response.ok) {
        const body = await response.json().catch(() => null) as unknown
        const message = body && typeof body === 'object' && 'message' in body
          ? String((body as { message?: unknown }).message)
          : `HTTP ${response.status}`
        return { ok: false, error: message }
      }
      const body = await response.json().catch(() => null) as {
        data?: {
          title_reset?: boolean
          title?: string | null
          title_generation_status?: string | null
        }
      } | null
      const data = body?.data
      return {
        ok: true,
        titleReset: Boolean(data?.title_reset),
        title: data?.title ?? null,
        titleGenerationStatus: data?.title_generation_status ?? null,
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ─── IPC: get-state ─────────────────────────────────────────────

  /**
   * ：busy 以 `runQueue.isBusy` 为准（running 或有排队；HITL 挂起期天然
   * busy）——这是 renderer 对账「会话还在不在跑」的权威口径。`running` 保留为
   * 「正在执行中」的细分——阶段 4 起统一从 `sharedHost.isBusy(id)` 派生
   * （coordinator 的 ConversationRunQueue 已保证 `busy = running || queued`，
   * 且 busy=true 一定意味着有 active run 在跑；不再维护影子 runningSessions Set）。
   *
   * 键解析与 `handleAbort` 同策略（resolveConversationAbortKeys）：入参可能是业务
   * sessionId / `chat-session-<uuid>` / forward 的 task_id。forward 路径的
   * sessions key（与 runQueue 提交键同源）= task_id，须经 businessThreadId
   * 二次命中——否则 forward 托管的本机 run 用业务 UUID 查恒 miss
   * （sessionId=null / busy=false），renderer 对账自愈对这条路径失效。
   */
  private handleGetState(sessionId?: string): AgentEngineGetStateOutput {
    if (!this.sharedHost) {
      return {
        sessionId: null,
        busy: false,
        running: false,
        queuedRunIds: [],
        activeSessions: this.sessions.size,
        busySessions: [],
      }
    }
    const sharedHost = this.sharedHost

    if (sessionId) {
      const entries = [...this.sessions.values()].map((s) => ({
        key: s.sessionId,
        businessThreadId: s.businessThreadId,
      }))
      const keys = resolveConversationAbortKeys(
        sessionId,
        entries,
      )
      const candidates = resolveConversationStateKeys(sessionId, entries)
      const queueStates = candidates.map(key => sharedHost.getRunState(key))
      const busy = queueStates.some(state => state.busy)
      return {
        sessionId: keys.length > 0 ? sessionId : null,
        busy,
        // busy=true 恒有 active run（ConversationRunQueue 的 slot.running）；
        // running 沿用旧字段名向 renderer 兼容。
        running: busy,
        queuedRunIds: queueStates.flatMap(state => state.queuedRunIds),
      }
    }
    const sessionsByRuntimeKey = new Map(
      [...this.sessions.values()].map((session) => [session.sessionId, session] as const),
    )
    const busySessions = sharedHost.getBusyConversationIds().map((runtimeSessionId) => {
      const session = sessionsByRuntimeKey.get(runtimeSessionId)
      const state = sharedHost.getRunState(runtimeSessionId)
      return {
        // pre-stream 期间可能已有 queue run、但 HostState 尚未登记。此时保留 runtime
        // key，让 abortRun 走原有 task/session key 兼容路径，绝不漏报 busy run。
        sessionId: session?.businessThreadId ?? runtimeSessionId,
        organizationId: session?.owner.organizationId,
        workspaceId: session?.workspaceId || undefined,
        queuedRunIds: state.queuedRunIds,
      }
    })
    return {
      sessionId: null,
      busy: busySessions.length > 0,
      running: busySessions.length > 0,
      queuedRunIds: [],
      activeSessions: this.sessions.size,
      busySessions,
    }
  }

  // ─── IPC: bind-session-code-root ────────────

  /**
   * busy 判定与 `handleGetState` / `compactSessionInternal` 同策略——
   * `resolveConversationStateKeys` 把入参 sessionId 归一到本 host 实际登记的
   * key，再逐个查 `sharedHost.isBusy`。会话尚未创建 runtime 时 entries 为空，
   * 退化为原样返回入参 key，`isBusy` 对未知 key 恒 false——首次绑定不会被误拒。
   */
  private isSessionBusyForCodeRootBind(sessionId: string): boolean {
    const entries = [...this.sessions.values()].map((s) => ({
      key: s.sessionId,
      businessThreadId: s.businessThreadId,
    }))
    const stateKeys = resolveConversationStateKeys(sessionId, entries)
    return stateKeys.some((key) => this.requireSharedHost().isBusy(key))
  }

  /** CLI 路由只拿这个窄接口，不暴露 Host 其它编排能力。 */
  getCodeWorktreeController(): CodeWorktreeController {
    return this.agentCodeWorktreeController
  }

  private resolveTrustedAgentWorktreeRun(
    context: CodeWorktreeAgentContext,
  ): TrustedAgentWorktreeRun | null {
    const turn = this.pendingTurnCtx.get(context.runId)
    if (!turn) return null

    const request = turn.request
    const contextSessionId = normalizeConversationId(context.sessionId)
    const requestSessionIds = [request.threadId, request.businessThreadId]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
    if (!requestSessionIds.some((value) => normalizeConversationId(value) === contextSessionId)) {
      return null
    }

    const session = this.sessions.get(request.threadId)
      ?? [...this.sessions.values()].find(
        (candidate) => candidate.businessThreadId === request.businessThreadId,
      )
    if (!session?.workspaceRoot) return null

    const binding = this.sessionCodeRootBindings.get(session.sessionId)
    return {
      sessionId: session.sessionId,
      runId: context.runId,
      toolUseId: context.toolUseId,
      rootPath: session.workspaceRoot,
      spaceId: session.spaceId ?? request.spaceId,
      tabScopeKey:
        binding?.tabKey
        ?? getCLIWorkspaceScopeKey(session.sessionId)
        ?? request.appContext?.tabScopeKey
        ?? request.appContext?.workspaceScopeKey
        ?? undefined,
      bindingRevision: binding?.revision,
    }
  }

  private authorizeAgentWorktreePath(
    run: TrustedAgentWorktreeRun,
    targetPath: string,
  ): void {
    if (!run.spaceId) {
      throw new Error('当前 Agent run 缺少 Space 上下文，无法授权新代码根')
    }
    const result = this.workspaceBoundary.apply(this.sessions.values(), {
      type: 'session-path-approved',
      payload: {
        spaceId: run.spaceId,
        sessionId: run.sessionId,
        path: targetPath,
      },
    })
    if (result.warning) throw new Error(result.warning)
  }

  private async commitPendingAgentWorktreeTransition(
    sessionId: string,
    runId: string,
  ): Promise<void> {
    if (!await this.agentWorktreeTransitions.waitForOperationCompletion(runId)) return
    const transition = this.agentWorktreeTransitions.takeForCommit(runId)
    if (!transition) return

    const sourceRequest = this.pendingTurnCtx.get(runId)?.request
    if (!sourceRequest) {
      log.warn('[AgentWorktree] source request missing at safe boundary', { runId, sessionId })
      return
    }

    try {
      const result = await this.sessionCodeRootBindings.bind(
        {
          sessionId: transition.sessionId,
          rootPath: transition.targetRootPath,
          tabKey: transition.tabScopeKey,
          branch: transition.branch,
          title: transition.branch,
        },
        // 当前 turn 尚未完全离开 Host 队列；安全边界已由 engine 证明，不能再用
        // 通用 busy 闸，否则 Agent 发起的切换永远会被自身当前 turn 拒绝。
        { isBusy: () => false },
      )
      if (!result.success || !result.rootPath || result.revision == null) {
        log.warn('[AgentWorktree] bind rejected at safe boundary', {
          runId,
          sessionId,
          reason: result.reason,
          error: result.error,
        })
        this.scheduleAgentWorktreeContinuation(sourceRequest, transition, {
          success: false,
          error: result.error ?? result.reason ?? '绑定失败',
        })
        return
      }

      const event = {
        sessionId: transition.sessionId,
        spaceId: transition.spaceId ?? this.sessions.get(transition.sessionId)?.spaceId ?? '',
        tabScopeKey: transition.tabScopeKey ?? '',
        previousRootPath: transition.previousRootPath,
        rootPath: result.rootPath,
        branch: transition.branch ?? null,
        revision: result.revision,
        created: transition.created,
        source: 'agent_cli' as const,
      }
      this.broadcastSessionCodeRootChanged(event)
      log.info('[AgentWorktree] committed at safe boundary', event)
      this.scheduleAgentWorktreeContinuation(sourceRequest, transition, {
        success: true,
        rootPath: result.rootPath,
        revision: result.revision,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('[AgentWorktree] safe-boundary commit failed', { runId, sessionId, error: message })
      this.scheduleAgentWorktreeContinuation(sourceRequest, transition, {
        success: false,
        error: message,
      })
    }
  }

  private broadcastSessionCodeRootChanged(payload: SessionCodeRootChangedEvent): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue
      window.webContents.send(SESSION_CODE_ROOT_CHANGED_CHANNEL, payload)
    }
  }

  private scheduleAgentWorktreeContinuation(
    sourceRequest: QueryRequest,
    transition: AgentWorktreeContinuationTransition,
    result: AgentWorktreeContinuationResult,
  ): void {
    const continuation = buildAgentWorktreeContinuation(
      sourceRequest,
      transition,
      result,
      crypto.randomUUID(),
    )

    setTimeout(() => {
      void this.submitQuery(continuation, NOOP_STREAM_SINK).then((submitted) => {
        if (!submitted.success) {
          log.warn('[AgentWorktree] automatic continuation was rejected', {
            sessionId: continuation.threadId,
            error: submitted.error,
          })
        }
      }).catch((error) => {
        log.error('[AgentWorktree] automatic continuation failed', {
          sessionId: continuation.threadId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, 0)
  }

  private async handleBindSessionCodeRoot(payload: {
    sessionId?: string
    rootPath?: string
    revision?: number
    tabKey?: string
    branch?: string
    title?: string
  }): Promise<BindSessionCodeRootResult> {
    const sessionId = payload?.sessionId
    if (typeof sessionId !== 'string' || !sessionId) {
      return { success: false, error: 'sessionId is required', reason: 'invalid_session_id' }
    }
    return this.sessionCodeRootBindings.bind(
      {
        sessionId,
        rootPath: payload.rootPath ?? '',
        revision: payload.revision,
        tabKey: payload.tabKey,
        branch: payload.branch,
        title: payload.title,
      },
      { isBusy: () => this.isSessionBusyForCodeRootBind(sessionId) },
    )
  }

  private async resolveBindingScope(): Promise<BindingScope | null> {
    const owner = await this.resolveOwnerBestEffort()
    if (!owner) return null
    return { userId: owner.userId, organizationId: owner.organizationId }
  }

  private async restoreSessionCodeRootBindings(reason: string): Promise<void> {
    try {
      const result = await this.sessionCodeRootBindings.restore()
      if (result.deferred) {
        log.info(`[SessionCodeRoot] restore deferred (${reason}): scope not ready`)
        return
      }
      log.info(
        `[SessionCodeRoot] restore (${reason}): restored=${result.restored} skipped=${result.skipped}`,
      )
    } catch (err) {
      log.warn(
        `[SessionCodeRoot] restore failed (${reason})`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  /** 退出前 flush 会话代码根 sidecar（best-effort）。 */
  async flushSessionCodeRootBindingsOnExit(): Promise<void> {
    await this.sessionCodeRootBindings.flush()
  }

  private async handleCompactSession(input: AgentEngineCompactSessionInput): Promise<AgentEngineCompactSessionOutput> {
    const threadId = input?.threadId?.trim()
    if (!threadId) {
      return { success: false, error: 'threadId is required' }
    }
    const workspaceId = input?.workspaceId?.trim()
    if (!workspaceId) {
      return { success: false, error: 'workspaceId is required' }
    }
    const entries = [...this.sessions.values()].map((session) => ({
      key: session.sessionId,
      businessThreadId: session.businessThreadId,
    }))
    const stateKeys = resolveConversationStateKeys(threadId, entries)
    if (stateKeys.some(key => this.requireSharedHost().isBusy(key))) {
      return { success: false, error: 'session is currently running' }
    }

    const existingSession = this.sessions.get(threadId)
    if (existingSession && existingSession.workspaceId !== workspaceId) {
      return { success: false, error: 'session belongs to another workspace' }
    }
    // 已有 runtime 的 compact 不得改写进程级 CLI 上下文；仅冷启动装配需要同步。
    if (!existingSession) {
      syncCLISpaceContextFromQueryRequest(input.spaceId, input.organizationId)
    }
    let owner: PersistedEntryOwner
    try {
      owner = await this.resolveOwner(input.agentId, input.organizationId)
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    if (existingSession && !ownersMatch(existingSession.owner, owner)) {
      return { success: false, error: 'session belongs to another account' }
    }

    try {
      // 阶段 4 · 门面：compact 旁路统一走 sharedHost.submitRun——同一 coordinator
      // FIFO + owner scope quiesce（登录切换/账号 reset 期间自动排队 / 拒绝）。
      const submission = {
        conversationId: threadId,
        lifecycleScopeId: this.ownerKey(owner),
        runId: `compact:${crypto.randomUUID()}`,
        execute: () => this.compactSessionInternal(input, threadId),
      }
      return await this.requireSharedHost().submitRun(submission)
    } catch (error) {
      if (error instanceof ConversationRunCancelledError) {
        return { success: false, error: error.message }
      }
      throw error
    }
  }

  private async compactSessionInternal(
    input: AgentEngineCompactSessionInput,
    threadId: string,
  ): Promise<AgentEngineCompactSessionOutput> {
    const workspaceId = input.workspaceId
    let session = this.sessions.get(threadId)
    if (!session) {
      const modelId = input.modelId?.trim()
      if (!modelId) {
        return { success: false, error: 'modelId is required to initialize session runtime' }
      }
      // ：workspaceId 是冷启动 runtime 初始化的硬前提（同
      // executeQueryInternal 入口），不能让 compactSessionInternal 的
      // 冷启动路径静默用全局单例兜底。
      await this.runtimeAssembly.getOrCreateRuntime(
        threadId,
        threadId,
        modelId,
        NOOP_STREAM_SINK,
        input.agentId,
        workspaceId,
        undefined,
        (input.agentMode as AgentModeName | undefined) ?? 'agent',
        undefined,
        undefined,
        undefined,
        input.modelContextWindow,
        input.modelMaxOutput,
        input.modelSupportsVision,
        input.modelSupportsFunctionCalling,
        input.modelCapabilitiesConfig,
        input.modelProvider,
        undefined,
        undefined,
        input.isByokMode,
      )
      session = this.sessions.get(threadId)
    }
    if (!session) {
      return { success: false, error: 'session runtime is not ready' }
    }

    const messages: Message[] = (input.history ?? [])
      .filter(item => item.role === 'user' || item.role === 'assistant')
      .map(item => ({
        role: item.role,
        content: item.content as Message['content'],
      }))

    if (messages.length === 0) {
      return { success: false, error: 'no history to compact' }
    }

    const result = await session.runtime.compactCheckpoint({
      messages,
      summaryFocus: input.summaryFocus,
      keepLastN: input.keepLastN,
    })
    if (!result.summary) {
      return { success: false, error: 'not enough history to compact' }
    }

    return {
      success: true,
      summary: result.summary,
      stats: result.stats,
    }
  }

  // ─── IPC: submit-hitl-batch / submit-ask-user-response ─────────
  //
  // v0.4 W1.5（PRD §6.7 / §7.4）：HITL 提交通道按"协议形态"分流（D6 一刀切，
  // 不留旧 submitAskUserResponse 兼容批量审批的路径）：
  //
  //   1. submitHitlBatch(batchId, decisions[])
  //      → approval_requested batch 路径，pending map key = batchId
  //      → runtime 内 LocalPermissionHandler.requestPermissionsBatch 注册一个
  //        promise 等整批 decisions 返回；这里单次 resolver 调用把 decisions[]
  //        透传过去即可（runtime 内部按 tool_call_id 分发到各工具）。
  //
  //   2. submitAskUserResponse(requestId, response)
  //      → ask 三件套独立路径，pending map key = requestId
  //      → 单 request promise；与 batch 通道分离。

  /**
   * 处理批量审批提交（v0.4 W1.5）。
   *
   * 入参经 wire schema 校验后：
   *   - batchId 来自 ApprovalRequestedEvent.payload.batch_id（runtime 注册 promise 用的 key）
   *   - decisions[] 是单条 LocalRtUserResponseDecision 数组（按 tool_call_id 分发回 runtime）
   *
   * runtime 端 LocalPermissionHandler 接收到 response 后会按 `decisions[].tool_call_id`
   * 分发；这里只做 promise resolve + 跨端 race 仲裁兜底（resolver 已被 first-resolve
   * 吃掉时返回 success=false，前端展示 "已由其它设备处理"）。
   */
  private handleSubmitHitlBatchLocal(payload: {
    batchId: string
    mirrorPlatformResolution?: boolean
    decisions: Array<{
      request_id?: string
      tool_call_id: string
      // outcome 扩到四档：'cancelled' 走 renderer dismiss（cancel-hitl IPC）；
      // 'expired' 预留给服务端过期扫描回灌。runtime `deriveTerminalStatus` 据此归档。
      outcome: 'allow' | 'deny' | 'cancelled' | 'expired'
      scope?: 'once' | 'thread' | 'always'
      rejection_message?: string
    }>
  }): { success: boolean } {
    if (!payload?.batchId || !Array.isArray(payload.decisions) || payload.decisions.length === 0) {
      log.warn(`[HITL batch] invalid payload (batchId or decisions[] missing)`)
      return { success: false }
    }
    const resolved = this.requireSharedHost().resolveApprovalBatch(
      payload.batchId,
      payload.decisions,
      { mirrorPlatformResolution: payload.mirrorPlatformResolution === true },
    )
    if (!resolved) {
      log.warn(`[HITL batch] No pending request for batchId=${payload.batchId} (likely already consumed by another device)`)
      return { success: false }
    }
    return { success: true }
  }

  /**
   * ：renderer 显式 dismiss HITL 面板时收敛 pending 为「用户取消」终态。
   *
   * 与既有 mode 切换 / rollback / soft-reconfigure 路径同步——那些路径已经在
   * 主进程内部触发 `cancelAllPendingHitlRequests`——本方法补的是**纯 renderer
   * 侧 dismiss**（用户手动关卡 / 弃权 / IPC skip 失败降级）缺口。这条以前只
   * 清 renderer 状态，runtime waiter 干等 30 分钟才 timeout，hitl_interaction
   * 消息也停在 pending → 换端 / 重载后被 HitlMessageReconcile 派生恢复成「可
   * 操作面板」→ 用户体感「关不掉的幽灵卡」。
   *
   * 走 `interactions.resolve` 而非 `cancelAllPendingHitlRequests({sessionId})`：
   * 后者按 sessionId 全清（跨 batch），而 renderer dismiss 是**单 batch / 单
   * request** 精确取消——沿用同一入口但只精准命中一条 pending。
   */
  private async handleCancelHitlInteraction(payload: {
    kind: 'approval' | 'ask'
    requestKey: string
    reason?: string
  }): Promise<{ success: boolean; error?: string; code?: string }> {
    if (!payload?.requestKey) {
      return { success: false, code: 'INVALID_REQUEST_KEY', error: 'requestKey is required' }
    }
    const reason = payload.reason?.trim() || 'User dismissed the interaction from the client UI.'
    if (payload.kind === 'approval') {
      // approval batch: 与 `hitl-cancel.ts::cancelAllPendingHitlRequests` 同款 payload
      // 形态（synthetic tool_call_id）——runtime `applyWireDecisions` 记录 wire
      // outcome, `deriveTerminalStatus` 归档 hitl_interaction 消息 'cancelled'；
      // 未被消费的真实 actionRequests 由 `fillMissingActionDecisions` 兜底 deny，
      // engine 侧只关心工具能不能跑（deny），不影响消息终态语义。
      const resolved = this.requireSharedHost().interactions.resolve(payload.requestKey, {
        batch_id: payload.requestKey,
        decisions: [
          {
            request_id: '__renderer_dismiss__',
            tool_call_id: '__renderer_dismiss__',
            outcome: 'cancelled',
            rejection_message: reason,
          },
        ],
      })
      if (!resolved) {
        return {
          success: false,
          code: 'PENDING_NOT_FOUND',
          error: '没找到待取消的审批（可能已被其它设备处理）',
        }
      }
      return { success: true }
    }
    // ask kind: 用与 ask-tools.emitAndWait 里 cancelled 分支约定的响应体
    // `{ cancelled: true, reason }`——emitResolved('cancelled') + emitHitlPersist
    // ('cancelled') + 返回 jsonError 让 LLM 继续。
    const resolved = this.requireSharedHost().interactions.resolve(payload.requestKey, {
      cancelled: true,
      reason,
    })
    if (!resolved) {
      return {
        success: false,
        code: 'PENDING_NOT_FOUND',
        error: '没找到待取消的追问（可能已超时或已被其它设备处理）',
      }
    }
    return { success: true }
  }

  private async handleSubmitHitlBatch(payload: {
    batchId: string
    threadId?: string
    decisions: Array<{
      request_id?: string
      tool_call_id: string
      outcome: 'allow' | 'deny' | 'cancelled' | 'expired'
      scope?: 'once' | 'thread' | 'always'
      rejection_message?: string
    }>
  }): Promise<{ success: boolean; error?: string; code?: string }> {
    const local = this.handleSubmitHitlBatchLocal({
      ...payload,
      mirrorPlatformResolution: true,
    })
    if (local.success) return local
    if (!payload.threadId) return local

    const forwarded = await this.forwardUserResponseToBackend(payload.threadId, {
      response: {
        batch_id: payload.batchId,
        decisions: payload.decisions,
        schema_version: 1,
      },
    })
    if (forwarded.ok) return { success: true }
    return {
      success: false,
      code: forwarded.code || 'HITL_FORWARD_FAILED',
      error: forwarded.message || '提交未送达 Agent，请确认执行设备在线后重试',
    }
  }

  /**
   * W3-轮 1（PRD 05 v0.4 §7.6.2 接口 B）：处理 server 端权威清理广播。
   *
   * 上游路径：07 PRD rollback pipeline 调 Django ``cancel_pending_approvals_by_thread``
   * → Django 写 ``interrupt_state`` + audit + publish ``approval_resolved(outcome=
   * 'cancelled_by_rollback')`` 给 ``agent.stream.{thread_id}`` topic → Electron
   * envelope handler 收到广播 → 调本方法路由到对应 ``interactions`` resolver。
   *
   * 与 ``handleSubmitHitlBatch``（主路径用户提交）的区别：
   * - 用户主动提交：``outcome ∈ {'allow', 'deny'}``，runtime 内部走 LocalPermissionHandler
   *   主路径推进；
   * - 本路径（rollback 取消）：``outcome === 'cancelled_by_rollback'``，runtime 看到
   *   tool_result 含 "因用户回滚而取消" 文案（与 pending-approvals-restorer 一致）。
   *
   * 本期（W3-轮 1）实装接口 + 单测，不做实际 rollback 联调；07 PRD 启动后再接通
   * envelope handler dispatch（broadcast 路由当前已通过 publishApprovalResolvedTo
   * Mirror 走 stream topic，但 Electron 主进程未订阅 stream topic，需待 07 PRD
   * 装订阅时调本方法）。
   */
  handleApprovalResolvedCancelByRollback(payload: {
    batchId: string
    decisions: Array<{
      request_id: string
      tool_call_id: string
      outcome: 'allow' | 'deny' | 'cancelled' | 'expired' | 'cancelled_by_rollback'
      rejection_message?: string
    }>
  }): { resolvedBatchIds: string[]; orphanedRequestIds: string[] } {
    if (!payload?.batchId || !Array.isArray(payload.decisions) || payload.decisions.length === 0) {
      log.warn('[HITL cancel] invalid cancel-by-rollback payload')
      return { resolvedBatchIds: [], orphanedRequestIds: [] }
    }
    return applyCancelledByRollbackToHitl({
      batchId: payload.batchId,
      decisions: payload.decisions,
      hitlMap: this.interactionRegistry,
    })
  }

  /**
   * 处理 ask_user 单 request 提交（独立语义保留）。
   *
   * 与 batch 通道分离：ask_user 是开放式问答（fields / questions / text_fallback），
   * 没有 scope / 没有 batch 语义；payload schema 由 askUserSlice 决定。
   */
  private handleSubmitAskUserResponseLocal(payload: { requestId: string; response: unknown }): { success: boolean } {
    if (!payload?.requestId) {
      log.warn(`[ask_user] invalid payload (requestId missing)`)
      return { success: false }
    }
    if (!this.requireSharedHost().resolveHumanAnswer(payload.requestId, payload.response)) {
      log.warn(`[ask_user] No pending request for requestId=${payload.requestId}`)
      return { success: false }
    }
    return { success: true }
  }

  private async handleSubmitAskUserResponse(payload: {
    requestId: string
    response: unknown
    threadId?: string
  }): Promise<{ success: boolean; error?: string; code?: string }> {
    const local = this.handleSubmitAskUserResponseLocal(payload)
    if (local.success) return local
    if (!payload.threadId) return local

    const forwarded = await this.forwardUserResponseToBackend(payload.threadId, {
      request_id: payload.requestId,
      response: payload.response,
    })
    if (forwarded.ok) return { success: true }
    return {
      success: false,
      code: forwarded.code || 'HITL_FORWARD_FAILED',
      error: forwarded.message || '提交回答未送达 Agent，请确认执行设备在线后重试',
    }
  }

  private async forwardUserResponseToBackend(
    threadId: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; code?: string; message?: string }> {
    const trimmedThreadId = threadId.trim()
    if (!trimmedThreadId) return { ok: false, code: 'MISSING_THREAD_ID', message: '缺少会话 ID，无法提交' }
    try {
      const res = await electronWsGateway.requestWithLastAuth(
        LocalRuntimeEvents.USER_RESPONSE,
        payload,
        { threadId: trimmedThreadId },
      )
      if (res.ok) {
        log.info(`[HITL] forwarded user response to backend: threadId=${trimmedThreadId}`)
        return { ok: true }
      }
      const message = res.error?.message || res.error?.code || res.type || 'unknown'
      log.warn(`[HITL] failed to forward user response to backend: threadId=${trimmedThreadId} error=${message}`)
      return {
        ok: false,
        code: res.error?.code || res.type,
        message,
      }
    } catch (err) {
      log.warn(
        `[HITL] failed to forward user response to backend: threadId=${trimmedThreadId} error=${err instanceof Error ? err.message : String(err)}`,
      )
      return {
        ok: false,
        code: 'HITL_FORWARD_FAILED',
        message: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * ：host stop 时，对本机仍持有 waiter 的会话调用 cancel-runtime，
   * 把服务端 PendingInteraction / hitl_interaction 打成 cancelled。
   *
   * REST path 只认 ChatSession raw UUID；统一走 resolveRelaySessionIdForReconcile
   *（剥 `chat-session-`、跳过 `prompt_*`），与 Daemon 对齐。
   */
  private async cancelHeldPendingInteractionsForRuntimeGone(): Promise<void> {
    if (this.interactionRegistry.size === 0) return

    const apiSessionById = new Map<string, { organizationId?: string }>()
    for (const entry of this.interactionRegistry.values()) {
      const session = this.sessions.get(entry.sessionId)
      const apiSessionId = resolveRelaySessionIdForReconcile({
        mapKey: entry.sessionId,
        businessThreadId: session?.businessThreadId,
      })
      if (!apiSessionId) continue
      if (apiSessionById.has(apiSessionId)) continue
      apiSessionById.set(apiSessionId, {
        organizationId: session?.owner?.organizationId,
      })
    }
    if (apiSessionById.size === 0) return

    let token: string | null = null
    try {
      token = await TokenManager.getAccessToken()
    } catch {
      token = null
    }
    if (!token) {
      log.warn('[HITL] skip cancel-runtime on stop: not authenticated')
      return
    }

    await Promise.all(
      [...apiSessionById.entries()].map(async ([apiSessionId, meta]) => {
        try {
          const response = await fetch(
            joinApiPath(
              API_BASE_URL,
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
          )
          if (!response.ok) {
            log.warn(
              `[HITL] cancel-runtime failed: session=${apiSessionId.slice(0, 8)}… status=${response.status}`,
            )
            return
          }
          log.info(`[HITL] cancel-runtime ok: session=${apiSessionId.slice(0, 8)}…`)
        } catch (err) {
          log.warn(
            `[HITL] cancel-runtime threw: session=${apiSessionId.slice(0, 8)}… error=${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }),
    )
  }

  /**
   * Phase 3 F12 重构：thin wrapper —— 业务逻辑全部下沉到 `ModeSwitchHandler`。
   *
   * Phase 3 F5：proposalId 必须在 `modeSwitchHandler.pending` 中（来自 switch_mode
   *   工具 emit 时的注册），伪造 / 过期 / 已 resolve 的 IPC 调用一律拒绝。
   * Phase 3 F13：移除 `modeTransitionReminder` 返回字段（renderer 不消费）；
   *   side-effect 通过 handler 内部 callback 直接落到 HostState。
   */
  private async handleModeSwitchExecute(payload: {
    sessionId: string
    proposalId: string
    outcome: 'approved' | 'cancelled'
  }): Promise<{
    success: boolean
    outcome?: 'approved' | 'cancelled'
    error?: string
  }> {
    try {
      // ：switch_mode 现为阻塞式 HITL 工具，其 execute 正 await
      // `waitForUserInput(proposalId)`，对应 interactions 里的 entry。
      const entry = this.interactionRegistry.get(payload.proposalId)

      // 校验 + 取方向（从注册表移除防 double-approve）。session 已销毁时也要
      // 先清 pending，否则后续同 sessionId 的 switch_mode 会被 already_pending 误挡。
      const result = this.modeSwitchHandler.handleExecute(payload)
      if (!result.success) {
        return { success: false, outcome: result.outcome, error: result.error }
      }

      const session = this.sessions.get(payload.sessionId)

      if (entry) {
        // approve：**先**就地热切换 runtime 到新模式（同步：工具集 / systemPrompt /
        // ShellCap 档位 / policyContext 全部就位），**再** resolve waiter —— 保证工具
        // execute 恢复、query 回读 config 时拿到的已是新模式（无 await 窗口）。
        if (payload.outcome === 'approved' && result.transition && session) {
          this.runtimeAssembly.reconfigureSessionModeInPlace(session, result.transition.toMode)
        }

        this.interactionRegistry.delete(payload.proposalId)
        entry.resolver({
          outcome: payload.outcome,
          to_mode: result.transition?.toMode,
        } satisfies { outcome: 'approved' | 'cancelled'; to_mode?: AgentModeName })
      } else {
        log.warn(
          `[mode-switch-execute] proposal validated but no pending HITL waiter (already timed out / resolved) session=${payload.sessionId.slice(0, 8)}…`,
        )
      }

      if (!session) {
        return {
          success: payload.outcome === 'cancelled',
          outcome: payload.outcome,
          error: payload.outcome === 'cancelled' ? undefined : 'Session not found',
        }
      }

      if (!entry) {
        return { success: false, error: 'Mode switch proposal is no longer awaiting approval' }
      }

      return { success: true, outcome: payload.outcome }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`[mode-switch-execute] threw: ${message}`)
      return { success: false, error: message }
    }
  }

  // ─── LH2-D 系列：账号 / 租户分桶的 sync 资源管理 ────────────────────

  /**
   *  / ：解析当前登录用户的 userId，供新布局
   * （`{dataRoot}/users/{userId}/…`）落盘/查询使用。缺失返回 undefined；
   * 生产读写路径应走 `requireSkillUserId()`（禁止 `_unscoped` / legacy 回落）。
   */
  private async resolveSkillUserId(): Promise<string | undefined> {
    const userInfo = await TokenManager.getUserInfo()
    const raw =
      (userInfo?.id as unknown) ??
      (userInfo?.user_id as unknown) ??
      (userInfo?.userId as unknown)
    if (raw === undefined || raw === null || raw === '') return undefined
    return String(raw)
  }

  /**
   * 同上，但未认证/`_unscoped` 时直接抛错——供 skills 读写路径使用（新布局强制
   * 要求真实 userId，不允许静默落到 `_unscoped` 分裂目录）。
   */
  private async requireSkillUserId(): Promise<string> {
    const userId = await this.resolveSkillUserId()
    if (!userId || userId === '_unscoped') {
      throw new Error('Cannot resolve skill userId: not authenticated')
    }
    return userId
  }

  /**
   * 解析当前请求的 owner（userId / organizationId / agentId）。
   *
   * 来源：
   *   - userId：`TokenManager.getUserInfo()` 返回的 userInfo（兼容 id / user_id / userId 三种字段名）
   *   - organizationId：当前 query 显式传入的会话组织；缺省时才读 CLI 当前组织。
   *   - agentId：本次 query 的 agentId 参数（由 createRuntimeForSession 透传）
   *
   * 缺失任意一项时**抛错**——LH2-D3 strictly required，不允许 fallback 到
   * "unknown" 串桶（那等于持久化通路完全失效）。调用方（getOrCreateRuntime）
   * 把抛错冒泡到 IPC handler，前端拿到 INTERNAL 错误后引导用户重新登录 / 切到正确账号。
   */
  private async resolveOwner(
    agentId?: string,
    requestedOrganizationId?: string,
  ): Promise<PersistedEntryOwner> {
    const userInfo = await TokenManager.getUserInfo()
    const rawUserId =
      (userInfo?.id as unknown) ??
      (userInfo?.user_id as unknown) ??
      (userInfo?.userId as unknown)
    if (rawUserId === undefined || rawUserId === null || rawUserId === '') {
      throw new Error(
        'Cannot resolve owner.userId: not authenticated or userInfo missing id field — ' +
          'sync queue cannot be created without owner (LH2-D3)',
      )
    }
    const organizationId = requestedOrganizationId ?? getCLIOrganizationId()
    if (!organizationId) {
      throw new Error(
        'Cannot resolve owner.organizationId: no current Organization selected — ' +
          'sync queue cannot be created without owner (LH2-D3)',
      )
    }
    return {
      userId: String(rawUserId),
      organizationId,
      ...(agentId ? { agentId } : {}),
    }
  }

  /**
   * 把 owner 转成 Map key（与路径无关——路径走 buildSyncAccountDir SSoT）。
   *
   * 与 `executionOwnerScopeId` **完全同源**——query lifecycleScopeId /
   * runtimeFactory / EOL / coordinator quiesceScope 全都消费同一格式，
   * 避免在多处重复字面量拼接导致格式漂移。
   */
  private ownerKey(owner: { userId: string; organizationId: string; agentId?: string }): string {
    return executionOwnerScopeId(owner)
  }

  // ─── 终端假运行根治 Layer 1：relay 持久化重试（owner 分桶 + 独立命名空间） ──

  /**
   * 一次 relay_events 发送 + **ack 消费**（治 F3/F16）。
   *
   * 成功（response.ok）静默返回；NAK（!ok，带 retryable）/ 网络异常 / 缺 token
   * → 抛错，让上层 `relayEventsWithRetry` / `RelayRetryQueue.recover` 据此落盘 /
   * 保留待重投。**幂等前提**：relay_events 按 client_event_id 去重，重投零副作用。
   */
  private async sendRelayEventsOnce(
    organizationId: string,
    sessionId: string,
    events: Array<{ type: string; payload: Record<string, unknown> }>,
    metadata?: RelayDeliveryMetadata,
  ): Promise<void> {
    const token = await TokenManager.getAccessToken()
    if (!token) {
      throw new Error('relay_events: no access token (offline / not authenticated)')
    }
    const response = await electronWsGateway.request(
      { token, organizationId },
      'relay_events',
      buildRelayRequestPayload(sessionId, events, metadata),
    )
    // ack 消费（治 F3/F16）：ok 静默；NAK → 抛错（含 retryable 解析）让上层落盘重投。
    // 复用共享 assertRelayAck（两端 host 同一份解析逻辑）。
    assertRelayAck(response)
  }

  private async sendRecoveredRelayEventsOnce(
    owner: PersistedEntryOwner,
    sessionId: string,
    events: Array<{ type: string; payload: Record<string, unknown> }>,
    metadata: RelayDeliveryMetadata,
  ): Promise<void> {
    const token = await TokenManager.getAccessToken()
    const currentOwner = await this.resolveOwnerBestEffort()
    if (!token || !currentOwner || !ownersMatch(currentOwner, owner)) {
      throw new Error('relay recovery owner changed before send')
    }
    const response = await electronWsGateway.request(
      { token, organizationId: owner.organizationId },
      'relay_events',
      buildRelayRequestPayload(sessionId, events, metadata),
    )
    assertRelayAck(response)
  }

  /**
   * 终态 relay with retry（终端假运行根治 Layer 1 主入口；治 F1/F2/F3/F16）。
   *
   * 先发一次（消费 ok/nak）；失败（抛错 / NAK）→ 落盘到 owner 桶的
   * `RelayRetryQueue`（failure-triggered），host 启动 / WS 重连时 recover 重投。
   *
   * **owner 固化降级链**：
   *   - owner 完整（spawn 时焊死）→ 用 owner.organizationId 发送 + 失败落盘到该桶；
   *   - owner 缺失（老 record / 解析失败）→ 回落 `getCLIOrganizationId()` 发一次
   *     （best-effort，无完整 owner 无法落盘——退化到固化前行为，但不更差）。
   */
  /**
   * 解析当前登录 owner（best-effort，不抛错）——owner 固化的兜底（治 F1 §8.5）。
   *
   * spawn 时 record.owner 解析失败（getUserInfo 缓存未命中等极少数情况）→ record
   * 不带 owner。终态投递时用本方法从当前登录态补全 `{userId, organizationId}`，让"无
   * record owner"的命令仍能落盘 recover（只要此刻仍登录）。与 `resolveOwner` 同源
   * （TokenManager.getUserInfo + getCLIOrganizationId）但缺失返回 undefined 而非抛错。
   */
  private async resolveOwnerBestEffort(): Promise<PersistedEntryOwner | undefined> {
    try {
      const userInfo = await TokenManager.getUserInfo()
      const rawUserId =
        (userInfo?.id as unknown) ?? (userInfo?.user_id as unknown) ?? (userInfo?.userId as unknown)
      const organizationId = getCLIOrganizationId()
      if (rawUserId === undefined || rawUserId === null || rawUserId === '' || !organizationId) return undefined
      return { userId: String(rawUserId), organizationId }
    } catch {
      return undefined
    }
  }

  /**
   * 迭代当前活跃 session 的 relay 存储视图。RelaySessionOrchestrator 用它做批量
   * backfill；Electron 端与 Daemon 端字段完全对齐，platform 只把 SessionStorage
   * 转成 helper 需要的最小契约。
   */
  private *iterateRelaySessionStorageViews(): Iterable<RelaySessionStorageView> {
    for (const [sessionId, session] of this.sessions) {
      yield relaySessionStorageViewOf(sessionId, session)
    }
  }

  /**
   * 对比本地 events.jsonl / messages.jsonl 与服务端 ChatMessage，重放缺失的
   * user / persist_message relay 事件（幂等 upsert）。薄委托到 RelaySessionOrchestrator。
   */
  private async reconcileSessionRelayBackfill(
    session: HostState,
    relaySessionId: string,
  ): Promise<void> {
    await this.relayOrchestrator.reconcileOne(
      relaySessionStorageViewOf(session.sessionId, session),
      relaySessionId,
    )
  }

  // ─── 终端假运行根治 Layer 2：真相源落盘 + 启动对账（治 F9 / 崩溃兜底） ──

  /**
   * 取（或懒创建）owner 桶的 ManagedTask 落盘队列。底层 `FilePersistentQueue` 与
   * SyncQueue / RelayRetryQueue 同账号目录，但用**独立文件** `managed-tasks.jsonl`
   * （绝不复用 relay-pending / sync pending）。关闭持久化 → undefined（无盘可落，
   * 退化纯内存，行为不劣化——只是崩溃后无法对账）。
   */
  private getManagedTaskQueue(owner: PersistedEntryOwner): FilePersistentQueue<PersistedManagedTask> | undefined {
    if (!this.syncPersistenceEnabled || !this.syncRoot) return undefined
    const key = this.ownerKey(owner)
    let q = this.managedTaskQueues.get(key)
    if (!q) {
      q = new FilePersistentQueue<PersistedManagedTask>({
        dir: buildSyncAccountDir(this.syncRoot, owner),
        pendingFile: 'managed-tasks.jsonl',
        archiveFile: 'managed-tasks-archive.jsonl',
        onError: (err, ctx) =>
          log.warn(
            `[ManagedTaskStore.file] owner=${owner.userId}/${owner.organizationId} phase=${ctx.phase} ${err.message}`,
          ),
      })
      this.managedTaskQueues.set(key, q)
    }
    return q
  }

  /**
   * Layer 2 落盘端口（治 F9）：注入 `ManagedTaskStore`，让 createRecord / setPid 把
   * running record 落到 owner 桶、updateOnExit terminal 后删盘。all best-effort
   * fire-and-forget——绝不因落盘失败打断 spawn / exit 主路径。无 owner（spawn 时归属
   * 解析失败）→ 无法分桶，跳过落盘（运行期仍由 Layer 1 内存 store + 退出 flush 兜底）。
   */
  private buildManagedTaskPersistence(): ManagedTaskPersistence {
    return {
      upsert: (record: PersistedManagedTask) => {
        if (!record.owner) return
        const q = this.getManagedTaskQueue(record.owner)
        if (!q) return
        void q
          .append({
            id: record.session_id,
            payload: record,
            createdAt: record.started_at,
            attempts: 0,
            lastAttemptAt: null,
            owner: { userId: record.owner.userId, organizationId: record.owner.organizationId },
          })
          .catch((err) =>
            log.warn(
              `[ManagedTaskStore] persist upsert failed session=${record.session_id.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`,
            ),
          )
      },
      delete: (sessionId: string, owner: ManagedTaskOwner | undefined) => {
        if (!owner) return
        const q = this.getManagedTaskQueue(owner)
        if (!q) return
        void q
          .remove(sessionId)
          .catch((err) =>
            log.warn(
              `[ManagedTaskStore] persist delete failed session=${sessionId.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`,
            ),
          )
      },
    }
  }

  /**
   * Layer 2 接线（治 F9）：host start() 时①注入落盘端口到 bridge 的 ManagedTaskStore
   * （此后 spawn 即写盘），②跑一次启动对账（恢复上次进程崩溃 / kill -9 残留的 running
   * record 终态）。bridge 时序上先于 host.start()（setupCoreAPIs setPtyManagerBridge）。
   * 仅持久化开启时有效；best-effort（拿不到 bridge / store 不阻断 start）。
   */
  private setupLayer2ManagedTaskReconcile(): void {
    if (!this.syncPersistenceEnabled || !this.syncRoot) return
    let store: ManagedTaskStore | undefined
    try {
      const bridge = resolvePtyManagerBridge() as { getManagedTaskStore?: () => ManagedTaskStore }
      store = bridge.getManagedTaskStore?.()
    } catch {
      store = undefined
    }
    if (store) {
      store.setManagedTaskPersistence(this.buildManagedTaskPersistence())
    } else {
      log.warn('[Layer2] ManagedTaskStore unavailable at start; persistence not injected (crash recovery degraded)')
    }
    // 启动对账：fire-and-forget（"命令仍在跑"分支会长时间轮询，不能阻塞 start）。
    void this.reconcileManagedTasksOnStartup()
  }

  /**
   * 启动对账（治 F9）：扫所有 owner 桶的 `managed-tasks.jsonl`，把上次进程崩溃 /
   * kill -9 残留的 running record 逐个对账（探活 → 读 sidecar → 回写真实退出码 /
   * unknown），走共享纯核心 `reconcileManagedTasks`。best-effort，不阻断 start。
   */
  private async reconcileManagedTasksOnStartup(): Promise<void> {
    if (this.managedTaskReconcileStarted) return
    this.managedTaskReconcileStarted = true
    if (!this.syncPersistenceEnabled || !this.syncRoot) return

    let owners: PersistedEntryOwner[]
    try {
      owners = await listSyncAccountOwners(this.syncRoot)
    } catch (err) {
      log.warn(`[Layer2] listSyncAccountOwners failed (ignored): ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    const records: ManagedTaskReconcileRecord[] = []
    for (const owner of owners) {
      const q = this.getManagedTaskQueue(owner)
      if (!q) continue
      try {
        const entries = await q.loadAll()
        for (const entry of entries) {
          const r = entry.payload
          if (!r || r.status !== 'running') continue
          records.push(r)
        }
      } catch (err) {
        log.warn(
          `[Layer2] load managed-tasks failed owner=${owner.userId}/${owner.organizationId}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    if (records.length === 0) return
    log.info(`[Layer2] startup reconcile: ${records.length} running record(s) left by previous (crashed) session`)
    // fire-and-forget：仍在跑的命令会一直轮询到结束才回写，不能 await 阻塞。
    void reconcileManagedTasks(records, this.buildManagedTaskReconcileDeps())
  }

  /**
   * 构造 Layer 2 对账纯核心的依赖：探活 / 读 sidecar / output_file 探测走 terminal-core
   * 共享默认实现（`isProcessAlive` / `readSidecarExitCode` / `outputFileExistsDefault`，
   * 两端不再各自重复），host 只注入 Wave 1 relay 回写 + 收尾 + log。
   */
  private buildManagedTaskReconcileDeps(): ManagedTaskReconcileDeps {
    return {
      relayTerminalState: (record, terminal) => this.relayReconciledTerminalState(record, terminal),
      finalizeCleanup: (record) => this.cleanupReconciledManagedTask(record),
      log,
    }
  }

  /** Layer 2：对账判定的终态走 Wave 1 outbox 回写（复用 relayEventsWithRetry，治 F9）。 */
  private async relayReconciledTerminalState(
    record: ManagedTaskReconcileRecord,
    terminal: ReconcileTerminalState,
  ): Promise<void> {
    if (!record.threadId) {
      // F7 拦住了新 spawn；这里只可能是历史脏 record——无 threadId 无法路由 Django，跳过。
      log.warn(`[Layer2] record ${record.session_id.slice(0, 8)}… has no threadId; terminal state not relayed`)
      return
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
    })
    if (!events) return
    const relayEvents = [
      ...events,
      ...this.buildBackgroundMediaArtifactEvents({
        threadId: record.threadId,
        command: record.command,
        sourceToolUseId: record.toolUseId,
        exitCode: terminal.exit_code,
        terminalEvents: events,
      }),
    ]
    await this.relayPersistence.send(record.owner, record.threadId, relayEvents)
  }

  /** Layer 2 对账收尾：从盘上删 record（防重复对账）+ 清 sidecar。best-effort。 */
  private async cleanupReconciledManagedTask(record: ManagedTaskReconcileRecord): Promise<void> {
    if (record.owner) {
      const q = this.getManagedTaskQueue(record.owner)
      if (q) {
        try {
          await q.remove(record.session_id)
        } catch {
          /* best effort：下次启动幂等重投（client_event_id 去重）无副作用 */
        }
      }
    }
    if (record.statusfile_path) {
      try {
        await fs.promises.unlink(record.statusfile_path)
      } catch {
        /* best effort：sidecar 可能已被 GC / 不存在 */
      }
    }
  }

  /**
   * 退出路径（终端假运行根治 v3 路线 A / F-EXIT）：客户端整体退出时，对所有
   * **本地后台 shell 命令** = 全部取消（对齐"退出客户端时 pnpm dev / pnpm build
   * 都被取消"的直觉），并**同步 flush**"已终止"终态到 Django，从源头消灭优雅
   * 退出场景的假运行——不依赖 Layer 2 启动对账。
   *
   * 流程（每个 running record）：seal(app_exit + markNotified) → SIGTERM 整组 →
   * **await** 构造 + flush 终态（每条 2.5s 上限，超时落盘）→ **fire-and-forget**
   * 宽限 2s → SIGKILL 整组兜底。seal-then-kill 不变量 + A4 预算解耦的实现细节见
   * 共享纯核心 `runBackgroundTaskExitFlush`（terminal-state-relay.ts，含防回归单测）。
   *
   * 由 onBeforeQuit 链路（main-app-handlers）在 destroyPtyManager 之前 await 调用。
   * best-effort：任一步失败不阻断退出（退出守卫有 CLEANUP_TIMEOUT 兜底）。
   *
   * **A4（预算解耦）**：只 await 到 relay 部分即返回；2s 宽限 + SIGKILL 整组兜底走
   * fire-and-forget（不阻塞退出链），让下游 flushSiteAccessMemory / destroyPtyManager /
   * 窗口 beforeunload 的 PTY 快照保存能在 CLEANUP_TIMEOUT 内跑完，不被硬截断。
   */
  async flushRunningBackgroundTasksOnExit(): Promise<void> {
    let store: ManagedTaskStore | undefined
    try {
      const bridge = resolvePtyManagerBridge() as { getManagedTaskStore?: () => ManagedTaskStore }
      store = bridge.getManagedTaskStore?.()
    } catch {
      return
    }
    if (!store) return

    // 委托共享纯核心（seal-then-kill 不变量 + A4 fire-and-forget SIGKILL + 终态构造）。
    await runBackgroundTaskExitFlush({
      store,
      killProcessGroup: (pid, signal) => this.killProcessGroupSafe(pid, signal),
      relayWithRetry: (owner, threadId, events, opts) =>
        this.relayPersistence.send(owner, threadId, events, opts),
      log,
      hostLabel: 'electron',
    })
  }

  /**
   * 当前正在跑的**本地后台 shell 命令**数量（退出弹窗文案用）。
   *
   * 与 `getActiveSubtaskCount`（云端子 Agent，退出后云端续跑）正交——本地命令是
   * 路线 A "退出即取消"的对象，文案需与云端子任务区分（治"继续在云端执行"误导）。
   */
  getRunningBackgroundTaskCount(): number {
    try {
      const bridge = resolvePtyManagerBridge() as { getManagedTaskStore?: () => ManagedTaskStore }
      const store = bridge.getManagedTaskStore?.()
      if (!store) return 0
      return store.list().filter((r) => r.status === 'running').length
    } catch {
      return 0
    }
  }

  /**
   * 「异步任务感知」B：列出**当前会话**仍在跑的本地后台 shell 命令（供 turn 结束后
   * 的 pending 预告条 pull）。
   *
   * 归属过滤（session ↔ record 映射）：**仅按 `record.threadId === sessionId` 精确匹配**。
   *   - renderer 发 query 时 `localAgentClient` 把 chat `sessionId` 直接作为 IPC `threadId`
   *     传入，host 透传到 ToolContext.threadId，ShellCap spawn 时落进 `ManagedTaskRecord.threadId`
   *     （shell.ts 工具层硬契约保证非空）+ ManagedTaskStore 持久化保留——故本地路径下
   *     `record.threadId` 恒等于 renderer 的 chat sessionId。
   *   - record 缺 `threadId`（理论不发生）时**直接不显**，绝不按 `spaceId` 回落（P2-2）：
   *     spaceId 回落会让同一 Space 下多个 chat session 的后台任务**互相匹配串味**——把
   *     "安全失败（漏显）"变成"串味失败（错配 session）"，后者更糟。宁可极边角下漏显一条，
   *     也不把别的 session 的任务错挂到当前会话。
   *
   * 入参保留 `spaceId`（IPC 契约对称 / 诊断上下文），但**不参与过滤**（见上）。
   *
   * 只读快照、不订阅——预告条只在 turn 间显示，任务完成会唤起新 turn 让它自然消失，
   * turn 结束拉一次即够（无需实时 push）。
   */
  listRunningBackgroundTasksForSession(input: {
    threadId?: string
    spaceId?: string
  }): Array<{ sessionId: string; command: string; startedAt: number }> {
    try {
      const bridge = resolvePtyManagerBridge() as { getManagedTaskStore?: () => ManagedTaskStore }
      const store = bridge.getManagedTaskStore?.()
      if (!store) return []
      const { threadId } = input
      // 无 threadId 入参 → 无从精确归属 → 返回空（不串味）。
      if (!threadId) return []
      // ToolContext.threadId 可能是裸 sessionId 或 `chat-session-<uuid>`；
      // renderer 传入的是裸 id——两侧归一化后再比，避免漏列。
      const wantThread = normalizeConversationId(threadId)
      return store
        .list()
        .filter((r) => {
          if (r.status !== 'running' || !r.threadId) return false
          if (r.pid && !isProcessAlive(r.pid)) return false
          return normalizeConversationId(r.threadId) === wantThread
        })
        .map((r) => ({ sessionId: r.session_id, command: r.command, startedAt: r.started_at }))
    } catch {
      return []
    }
  }

  /**
   * 杀整组：POSIX 委托共享纯核心（`process.kill(-pid)` + 单进程兜底）；
   *  Windows 走 `taskkill /T` 树杀（POSIX 进程组语义在 Win 无效，
   * 否则后台子孙进程会变孤儿）。
   */
  private killProcessGroupSafe(pid: number | undefined, signal: NodeJS.Signals): void {
    if (process.platform === 'win32') {
      killProcessTreeByPid(pid, signal)
      return
    }
    killProcessGroupSafeCore((p, s) => process.kill(p, s), pid, signal)
  }

  private async cleanupToolLogsOnStartup(): Promise<void> {
    try {
      // ：只扫新树
      //   {dataRoot}/users/{userId}/organizations/{org}/workspaces/{ws}/conversations/tool-logs/
      // legacy platform-data 残留由一次性 migration 搬迁，不再在 runtime cleanup 双扫。
      let totalRemoved = 0
      const dataRoot = resolveDataRoot()
      const usersRoot = path.join(dataRoot, 'users')
      if (!fs.existsSync(usersRoot)) return
      const userEntries = await fs.promises.readdir(usersRoot, { withFileTypes: true })
      for (const user of userEntries) {
        if (!user.isDirectory()) continue
        const orgsRoot = path.join(usersRoot, user.name, 'organizations')
        let orgEntries: fs.Dirent[]
        try {
          orgEntries = await fs.promises.readdir(orgsRoot, { withFileTypes: true })
        } catch {
          continue
        }
        for (const org of orgEntries) {
          if (!org.isDirectory()) continue
          const workspacesParent = path.join(orgsRoot, org.name, 'workspaces')
          let workspaceEntries: fs.Dirent[]
          try {
            workspaceEntries = await fs.promises.readdir(workspacesParent, { withFileTypes: true })
          } catch {
            continue
          }
          for (const ws of workspaceEntries) {
            if (!ws.isDirectory()) continue
            const toolLogsDir = path.join(
              workspacesParent,
              ws.name,
              'conversations',
              'tool-logs',
            )
            if (!fs.existsSync(toolLogsDir)) continue
            const { removed } = await cleanupOldToolLogs(toolLogsDir)
            totalRemoved += removed
          }
        }
      }
      if (totalRemoved > 0) {
        log.info(`[ToolLogs] startup cleanup: removed ${totalRemoved} old session dir(s)`)
      }
    } catch (err) {
      log.warn('[ToolLogs] startup cleanup failed (non-blocking):', err)
    }
  }

  /**
   * LH2-D2：登出指定账号时调用。
   *
   * 流程（**必须**按此顺序保证不丢数据 / 不引用已 disposed 句柄；详见
   * SYNC_QUEUE.md §7 D9）：
   *   1. 找到所有 (userId, organizationId) 匹配的 session：abort + flush + dispose
   *      它们的 SyncQueue（让 in-flight batch 走完最后一次落盘）；
   *   2. dispose 该 owner 桶的 PersistentQueue（关文件句柄）；
   *   3. fs 层删除 `<syncRoot>/<userId>/<organizationId>/`；
   *   4. 从 Map / sessions 里清理引用。
   *
   * **严格按 owner 匹配**——不动其他 owner 的 session、不删其他 owner 目录。
   * 如果切到同一账号下的另一 organization，这里不会清那一桶。
   *
   * **并发互斥**（技术 Review 修复）：reset 期间加 owner 锁，
   * `getOrCreatePersistentQueueForOwner` 检测到锁会 await 完成再 create——
   * 否则会出现 "reset 删完目录的同时新 syncQueue 又把它建回来"。
   *
   * **错误可见性**（技术/产品 Review 修复）：所有 best-effort dispose 失败
   * 不再静默吞掉，统一打 warn + telemetry 让运维能看到"登出 OK 但 sync 残留"。
   */
  private async resetAccountSync(
    owner: { userId: string; organizationId: string },
  ): Promise<{ clearedFiles: boolean }> {
    const key = this.ownerKey(owner)
    // 互斥保留：EOL 内部 `transitionTail` 已按 owner 串行；本锁额外挡住
    // 「同 owner 连续点登出 / 多窗口 logout」的重入，避免同一 disposeOwner 展开
    // 阶段还没完，外层 IPC 已并发发第二次进入 EOL 队列。
    const prior = this.accountResetLocks.get(key)
    if (prior) {
      try { await prior } catch { /* prior reset 失败不影响本次 */ }
    }

    let resolveLock!: () => void
    const lockPromise = new Promise<void>((resolve) => { resolveLock = resolve })
    this.accountResetLocks.set(key, lockPromise)

    try {
      log.info(`[OwnerSync] reset-account-sync owner=${owner.userId}/${owner.organizationId}`)
      if (!this.sharedHost) {
        throw new Error('[OwnerSync] AgentHost is not started; reset-account-sync unavailable')
      }
      // EOL 统一编排：quiesce (supervisor + runtimeFactory) → interrupt →
      // waitForScopeIdle → teardown 每个 session → disposeOwnerResources。
      // 手写的 quiesceScope / runtimeFactory.quiesceScope / abort / cancelDelivery /
      // sessionStorage.dispose / removeFileHistory / relayPersistence.disposeOwner /
      // clearSyncAccountDir 已经全部迁到 buildOwnerAdapter。
      await this.sharedHost.disposeExecutionOwner(owner)
      const clearedFiles = this.pendingClearedFilesByOwner.get(key) ?? false
      this.pendingClearedFilesByOwner.delete(key)
      return { clearedFiles }
    } finally {
      this.accountResetLocks.delete(key)
      resolveLock()
    }
  }

  /** reset 流程内 best-effort 步骤失败时统一日志（避免散落 catch 吞错）。 */
  private warnResetStep(
    step: string,
    sessionId: string | undefined,
    owner: { userId: string; organizationId: string },
    err: unknown,
  ): void {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn(
      `[OwnerSync] reset-account-sync step=${step} sid=${sessionId ?? '-'} owner=${owner.userId}/${owner.organizationId}: ${msg}`,
    )
  }

  // Runtime lifecycle → ElectronRuntimeAssembly (agent knowledge out of this shell file)

  /**
   * ：auth 变更 → 仅在用户身份变化时 init 能力目录。
   * 同用户 token refresh 不打缓存（与 SkillsModuleLifecycle 同口径）。
   */
  private async handleCapabilityIdentityAuthChanged(): Promise<void> {
    const userId = await this.resolveSkillUserId()
    const authenticated = !!userId && userId !== '_unscoped'
    if (!authenticated) {
      if (this.capabilityIdentityBoundUserId !== null) {
        this.capabilityIdentityBoundUserId = null
        await this.initCapabilityIdentity('logout')
      }
      // 登出：清掉内存绑定，避免跨账号串目录；磁盘分桶保留给下次同账号恢复。
      this.sessionCodeRootBindings.clearAllMemory()
      return
    }
    if (this.capabilityIdentityBoundUserId === userId) {
      // 同用户 refresh：能力目录可跳过；代码根走 ensureRestored（同 scope 短路）。
      try {
        await this.sessionCodeRootBindings.ensureRestored()
      } catch (err) {
        log.warn(
          '[SessionCodeRoot] ensureRestored after auth-same-user failed',
          err instanceof Error ? err.message : err,
        )
      }
      return
    }
    this.capabilityIdentityBoundUserId = userId
    await this.initCapabilityIdentity('login')
    this.sessionCodeRootBindings.clearAllMemory()
    await this.restoreSessionCodeRootBindings('auth-login')
  }

  private async handleLocalCodexDisconnected(): Promise<void> {
    const userId = await this.resolveSkillUserId()
    if (!userId) return
    await clearUserDeviceModelPreferences(userId)
    const prefix = `${userId}:`
    for (const scopeKey of this.loadedDeviceModelPreferenceOrganizations) {
      if (!scopeKey.startsWith(prefix)) continue
      this.deviceModelPreferences.set(scopeKey, {})
      this.recomputeSubagentModelPolicy(scopeKey)
    }
    log.info('[OpenAICodex] cleared current-user device model defaults after disconnect')
  }

  /**
   * ：统一失效常驻能力目录（CLI / MCP / enablement / gate / turn / prewarm / portrait）。
   * 经 generation + 串行链：后发起的 init 作废在途 warm。
   * 返回是否随后触发了 warm。
   */
  private async initCapabilityIdentity(
    reason: CapabilityIdentityInitReason,
    options?: { organizationId?: string | null },
  ): Promise<boolean> {
    const generation = ++this.capabilityIdentityInitGeneration
    const run = this.capabilityIdentityInitChain.then(async () => {
      if (generation !== this.capabilityIdentityInitGeneration) {
        return false
      }
      if (reason === 'logout') {
        this.capabilityIdentityBoundUserId = null
        this.stateRoot.model.resetCatalog()
        this.subagentModelPolicies.clear()
        this.backendSubagentModelPolicies.clear()
        this.deviceModelPreferences.clear()
        this.loadedDeviceModelPreferenceOrganizations.clear()
      }
      initHostCapabilityIdentity(reason, {
        resetCatalog: () => this.getStateRoot().catalog.reset(),
        invalidateAllSkillEnablement: () => this.skillEnablementCache.invalidateAgent(),
        invalidateCliListingGate: () => invalidateCliListingGateCache(),
        clearHostTurn: () => this.getStateRoot().turn.clear(),
        clearPrewarmPending: () => this.getStateRoot().prewarm.clearPending(),
        invalidateUserPortrait: () => this.invalidateUserPortraitCache(),
        logInfo: (message, meta) => log.info(message, meta),
      })
      if (generation !== this.capabilityIdentityInitGeneration) {
        return false
      }
      const rewarm = shouldRewarmAfterCapabilityIdentityInit(reason)
      if (rewarm) {
        await this.warmHostCapabilityCatalogs(`identity:${reason}`, {
          organizationId: options?.organizationId,
        })
        void this.refreshModelCatalog(
          options?.organizationId
            ? {
                userId: (await this.resolveSkillUserId()) ?? '',
                organizationId: options.organizationId,
              }
            : undefined,
        )
      }
      if (generation !== this.capabilityIdentityInitGeneration) {
        return false
      }
      return rewarm
    })
    this.capabilityIdentityInitChain = run.then(
      () => {},
      () => {},
    )
    return run
  }

  /**
   * ：宿主生命周期暖 CLI 命令树（+ 若已有活跃 org，暖 media 门控 listing）。
   * 不依赖对话 / Space；失败只记日志，不阻断 start。
   * ：可传入目标 organizationId，避免切组织瞬间 CLI context 仍是旧 org。
   */
  private async warmHostCapabilityCatalogs(
    reason: string,
    options?: { organizationId?: string | null },
  ): Promise<void> {
    const tasks: Array<Promise<unknown>> = [
      warmCliCommandsMaterialized(reason),
    ]
    const organizationId =
      (typeof options?.organizationId === 'string' && options.organizationId.trim()
        ? options.organizationId.trim()
        : null)
      ?? getCLIOrganizationId()
    if (organizationId) {
      tasks.push(createGatedCliListingFetcher(organizationId)({}))
    }
    const results = await Promise.allSettled(tasks)
    for (const r of results) {
      if (r.status === 'rejected') {
        log.warn(`[HostCatalogWarm] task failed (ignored) reason=${reason}:`, r.reason)
      }
    }
  }

  /**
   *  /  / ：Space 激活时写入常驻目录（CLI listing /
   * skills 物化 / catalog）。不预建完整 runtime；画像需 agentId，改挂 Agent 预热。
   */
  async prewarmSpaceContext(organizationId: string, spaceId: string): Promise<void> {
    const tasks: Array<Promise<unknown>> = [
      this.runtimeAssembly.loadSubagentCatalogAsync(spaceId),
      // C1：CLI warm 与 gated listing 共用一次 spawn 物化。
      warmCliCommandsMaterialized('space-prewarm'),
      createGatedCliListingFetcher(organizationId)({}),
    ]
    if (this.skillsModule) {
      tasks.push(
        this.requireSkillUserId().then(async (userId) => {
          await this.skillsModule!.ensureUserSkills(userId)
          await this.skillsModule!.ensureOrganizationSkills(userId, organizationId)
        }),
      )
    }
    const results = await Promise.allSettled(tasks)
    for (const r of results) {
      if (r.status === 'rejected') {
        log.warn(
          `[SpacePrewarm] task failed (ignored) org=${organizationId} space=${spaceId}:`,
          r.reason,
        )
      }
    }
  }

  /**
   *  / ：预拉 Agent Skill enablement（常驻，非 force 命中即返）、
   * MCP listing，以及带 agentId 的 USER 画像（ 契约，无 agent 不请求）。
   */
  async prewarmAgentEnablement(agentId: string): Promise<void> {
    const organizationId = getCLIOrganizationId()
    const spaceId = getCLISpaceId()
    const tasks: Array<Promise<unknown>> = [
      this.skillEnablementCache.forAgent(agentId).refresh(),
      createMcpListingFetcher(agentId)({}),
    ]
    if (organizationId) {
      tasks.push(this.runtimeAssembly.loadUserPortraitAsync(organizationId, agentId))
    }
    // Agent 携带集可能由后端默认挂载或其它客户端写入，未必经过本机「添加 Skill」
    // 动作。选中 Agent 时就把已启用但本地缺失的 App Skill 物化，确保斜杠选择、
    // prompt 注入和 skills_read 共用的本地注册表在首轮对话前已经可读。
    // 缺 Space 的启动早期由 createRuntimeForSession 的既有协调路径继续兜底。
    if (organizationId && spaceId) {
      tasks.push(
        this.runtimeAssembly.reconcileSpaceAppSkills(organizationId, spaceId, agentId),
      )
    }
    const results = await Promise.allSettled(tasks)
    for (const r of results) {
      if (r.status === 'rejected') {
        log.warn(`[AgentPrewarm] task failed (ignored) agent=${agentId}:`, r.reason)
      }
    }
  }

  /**
   *  阶段 C：草稿 session 已落定后预 acquire Runtime（不跑对话）。
   * cache key 与首发同路径：loadHostTurnBundle + buildRequestFromQuery + factory.resolve。
   * 失败只记日志语义由调用方吞掉；busy / 缺字段时返回 success:false。
   */
  async prewarmSessionRuntime(
    input: PrewarmRuntimeInput,
  ): Promise<{ success: boolean; error?: string }> {
    const threadId = input?.threadId?.trim()
    const workspaceId = input?.workspaceId?.trim()
    const spaceId = input?.spaceId?.trim()
    const organizationId = input?.organizationId?.trim()
    const agentId = input?.agentId?.trim()
    const modelId = input?.modelId?.trim()
    if (!threadId || !workspaceId || !spaceId || !organizationId || !agentId || !modelId) {
      return { success: false, error: 'threadId/workspaceId/spaceId/organizationId/agentId/modelId required' }
    }
    try {
      if (this.requireSharedHost().isBusy(threadId)) {
        return { success: false, error: 'session is currently running' }
      }
      syncCLISpaceContextFromQueryRequest(spaceId, organizationId)
      const owner = await this.resolveOwner(agentId, organizationId)
      const { profile } = await loadHostTurnBundle({
        agentId,
        workspaceId,
        getOrganizationId: () => organizationId,
      })
      const request: QueryRequest = {
        prompt: '',
        threadId,
        workspaceId,
        spaceId,
        organizationId,
        agentId,
        modelId,
        agentMode: input.agentMode,
        approvalMode: input.approvalMode,
        workingDir: input.workingDir,
        workingDirType: input.workingDirType,
        enabledApps: input.enabledApps,
        operationSwitches: input.operationSwitches,
        memoryCapability: input.memoryCapability,
        modelContextWindow: input.modelContextWindow,
        modelMaxOutput: input.modelMaxOutput,
        modelSupportsVision: input.modelSupportsVision,
        modelSupportsFunctionCalling: input.modelSupportsFunctionCalling,
        modelCapabilitiesConfig: input.modelCapabilitiesConfig,
        modelProvider: input.modelProvider,
        isByokMode: input.isByokMode,
        spaceName: input.spaceName,
        organizationName: input.organizationName,
        isGroupSpace: input.isGroupSpace,
        customRules: profile.customRules,
        personalRules: profile.personalRules,
        workspaceRules: profile.workspaceRules,
        agentName: profile.agentName,
        executionLimits: profile.executionLimits,
      }
      const runtimeRequest = this.runtimeAssembly.buildRequestFromQuery(
        request,
        NOOP_STREAM_SINK,
        owner,
      )
      await this.runtimeAssembly.getRuntimeFactory().resolve(runtimeRequest)
      log.info(
        `[RuntimePrewarm] acquired session=${threadId.slice(0, 8)}… `
          + `agent=${agentId.slice(0, 8)}… model=${modelId}`,
      )
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn(
        `[RuntimePrewarm] failed (ignored) session=${threadId.slice(0, 8)}…: ${message}`,
      )
      return { success: false, error: message }
    }
  }

  /**
   * M1.4 / : 手动失效 USER 画像缓存。
   *
   * 由前端在 hint 提交 / distill 触发后通过 IPC 调用。
   *
   * @param organizationId 传 organizationId 失效该 Organization 下全部 agent 槽；
   *                   传 undefined / 空字符串清空所有槽位
   */
  invalidateUserPortraitCache(organizationId?: string, agentId?: string): void {
    this.runtimeAssembly.invalidateUserPortraitCache(organizationId, agentId)
  }

  /**
   * Platform approval bridge：按 chat sessionId 取该会话的 ApprovalMemoStore。
   * 平台审批（browser.open / 终端等）的 always 决策经此写入 Agent approval_memo，
   * 让「已记住的授权」列表可见、可撤销、跨设备同步（与 Agent 工具 always 同源）。
   */
  getApprovalMemoStoreForSession(sessionId: string): InMemoryApprovalMemoStore | null {
    return (this.sharedHost?.getApprovalMemoStore(sessionId) as InMemoryApprovalMemoStore | undefined) ?? null
  }
}

export const electronAgentHost = new ElectronAgentHost()

// ：turn 权威 store 在 sharedHost 前即可写（upsert IPC / hydrate）
bindHostTurnStore(() => electronAgentHost.getStateRoot().turn)
bindHostStateReconciler(() => electronAgentHost.reconcileHostState())
bindAttributionStore(() => electronAgentHost.getStateRoot().attribution)
bindCatalogStore(() => electronAgentHost.getStateRoot().catalog)
bindPrewarmScheduler(() => electronAgentHost.getStateRoot().prewarm)

// 平台审批 always → 会话 ApprovalMemoStore 的解析器注入（依赖注入避免 host ↔ bridge 循环）。
registerPlatformMemoStoreResolver((sessionId) => electronAgentHost.getApprovalMemoStoreForSession(sessionId))
