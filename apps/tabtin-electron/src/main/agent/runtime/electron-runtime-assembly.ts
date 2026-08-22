/**
 * Electron runtime assembly — Agent runtime knowledge extracted from ElectronAgentHost.
 *
 * Host file stays an Electron platform shell; this module owns getOrCreateRuntime /
 * createRuntimeForSession / soft-reconfigure / catalog loaders.
 */

import fs from 'node:fs'
import path from 'node:path'
import { notifyHostOsAccessError } from '../platform/os-permission-host-relaunch.js'
import {
  AgentHost,
  type SkillRunSnapshotOptions,
  type SkillAvailabilitySnapshot,
} from '@tabtin/agent-host'
import { modelCatalogScopeKey } from '@tabtin/agent-host/state'

import type {
  AgentRuntime,
  EngineConfig,
  EngineHooks,
  ModelCapabilities,
  ModelCatalogEntry,
  ReadFileState,
  StreamEvent,
} from '@tabtin/agent-runtime/engine'
//  批次 13：engine barrel 收敛为 engine-only。非 engine 目录的符号
// （runtime 组装根 / session / subagent / providers / telemetry / agent-modes /
// permissions / host / terminal / capability injectors）改从包入口
// `@tabtin/agent-runtime` import。
import {
  createRuntime,
  TabTinProxyProvider,
  SubagentManager,
  reapOrphanedSubagentRuns,
  EventEmitter,
  TelemetryEvents,
  emitTelemetryEvent,
  redactCustomRules,
  // ：skill_create 落盘改走新布局，旧 resolveSpaceSkillDir 移除。
  resolveOrganizationSkillDir,
  resolveWorkspaceSessionArchiveDir,
  resolveWorkspaceToolLogsDir,
  type SessionStorage,
  type SnapshotStorage,
  type EventStorage,
  type ToolLogWriter,
  type TodoSessionAnchor,
  type SubagentModelPolicy,
  LocalCodexResponsesProvider,
} from '@tabtin/agent-runtime'
import { sharedOpenAICodexCredentialStore } from '../../llm/openai-codex-credential-store.js'
import { openAICodexFetch } from '../../llm/openai-codex-http.js'
import {
  resolveModelExecutionRoute,
  resolveSharedTemplateModelId,
} from '../../llm/model-execution-route.js'
import {
  OPENAI_CODEX_MODELS,
  isOpenAICodexModel,
  resolveOpenAICodexModelCapabilities,
} from '../../llm/openai-codex-models.js'
import { getResourceDownloadService } from '../../services/ResourceDownloadService.js'
import {
  LLM_IMAGE_DATA_URL_MAX_BYTES,
  nodeBufferToAgentDataUrl,
} from '../../../shared/llm-image-url.js'
import { createSubagentStreamRouter, SessionPauseController } from '@tabtin/agent-host/delivery'
import {
  canSoftReconfigureByShellTier,
  resolveRuntimeModeAgainstSticky,
  disabledAppsExtraKeysMatch,
  normalizeDisabledAppsExtraKey,
  resolveSubagentCarryForward,
  resolveSubagentCompletionSpaceId,
  buildCostCapConfig,
  createSessionStorageBundle,
  assemblePermissionShell,
  RuntimeSessionFactory,
  type RuntimeDisabledAppsExtraKey,
  type RuntimeSessionFactoryAdapter,
  type RuntimeBuildContext,
} from '@tabtin/agent-host/runtime'
import type { AgentModeName } from '@tabtin/agent-modes'
import { getRestrictedShellAllowlist } from '@tabtin/agent-modes'
import {
  BudgetTracker,
  composeHooks,
  normalizeWorkspaceRoot,
} from '@tabtin/agent-runtime/engine'
import { createSkillActivation } from '@tabtin/agent-runtime/tools'
import type { PersistedEntryOwner } from '@tabtin/agent-runtime'
// W4a S3-S5（PR2）：live 依赖重绑 + 完成回调契约类型。
import type { SubagentLiveDeps, EnqueueSubagentCompletion } from '@tabtin/agent-runtime'
import { electronHostRuntimeOptions } from '@tabtin/agent-host/configuration'
const {
  resolveDoomLoopPolicy,
  resolveIterationBudget,
  resolveToolFailureTracker,
  resolveMaxMessageChars,
  resolveNormalizationLevel,
  resolveToolSchemaValidation,
  resolveToolOutputScan,
  resolveMaxConcurrentChildren,
  resolveMaxSubagentQueue,
  resolveSubagentResultCompact,
  resolveSummaryReuse,
  resolveSummaryReuseJudgeSampleRate,
  resolveSummaryReuseJudgeWindowSize,
  resolveSummaryReuseJudgeThreshold,
  resolveSummaryReuseMaxAgeMs,
  resolveSummaryReuseMinAddedMessages,
  resolveTimeBasedMicroCompact,
  resolvePressureThresholds,
} = electronHostRuntimeOptions
import { TokenManager } from '../../auth.js'
import { API_BASE_URL } from '../../config/api.js'
import { joinApiPath } from '@tabtin/config'
import {
  buildPolicyFromAgentConfigV2,
  checkHardlineCommand,
} from '@tabtin/security-policy'
import { getCLISpaceId, getCLIOrganizationId } from '../../cli/cli-server.js'
import { acquireSubagentCLIWorkspaceScopeLease } from '../../cli/cli-context.js'
import { createLogger } from '../../logger.js'
import {
  completeCliRiskSchemas,
  getCliCommandsMaterializedSnapshot,
  warmCliCommandsMaterialized,
} from '../capabilities/cli-commands-materializer.js'
import { resolveReachableTerminalCwd } from '../../terminal/interactive-cwd.js'
import { createWorkspaceBoundary } from '../policy/workspace-boundary.js'
import { ElectronPermissionHandler } from '../capabilities/ElectronPermissionHandler.js'
import { ElectronToolProvider } from '../capabilities/ElectronToolProvider.js'
import { createSkillCredentialResolver } from '../capabilities/skill-credential-resolver.js'
import {
  isExplicitLibTvRequest,
  isLibTvSkill,
  shouldInjectMediaSkill,
} from '../capabilities/media-image-skill-routing.js'
import type { SkillCredentialResolverHandle } from '@tabtin/agent-host/credentials'
import { createRunObservationInjector } from '../conversation/run-observation-injector.js'
// YOLO PRD v3 review M2：main 进程现拉 Django 权威 agent_config。
// 详见 ElectronAgentHost.agentConfigClient 字段注释 + agent-config-client.ts。
import { createAgentConfigClient } from '../policy/agent-config-client.js'
import { clearAllActivePlansForSession, getActivePlanFilePath } from '@tabtin/agent-runtime'

import { getOrCreateFileHistory } from '../../file-history/file-history-registry.js'
import { getRuntimeInteractionMode } from '../policy/interaction-mode-context.js'
import { setThreadEffectiveApprovalMode } from '../policy/approval-mode-context.js'
import { deriveCacheType, deriveReasoningHistoryPolicy, FALLBACK_MODEL_CAPABILITIES, buildModelFallbackChain } from '@tabtin/agent-runtime/engine'
import { findCatalogEntry } from '@tabtin/agent-runtime'
// 路径权限治理 W7 / L1：派生 EffectivePolicy.planModeGuardActive
import { isPlanModeGuardActive } from '@tabtin/agent-modes'
// W1.2 /  Stage 6d：装配 NativeBackendSession + ExecutionBackendRegistry。
// bootstrap 在 agent-host（依赖 terminal-core）；session 实现仍在 agent-runtime。
import {
  bootstrapNativeBackend,
  isNativeBackendSessionEnabled,
  type NativeBackendBootstrapResult,
} from '@tabtin/agent-host/native'
// ShellCap 接 PtyManagerBridge — 装配点拿 bridge。
// bootstrap 顺序（agent-bridge.ts L544-548）：
//   PtyManager 就绪 → bridge-core.ts setupCoreAPIs 调 setPtyManagerBridge
//   → 此处 resolvePtyManagerBridge 拿到真实 bridge → 装配 ShellCap
import { resolvePtyManagerBridge } from '@tabtin/action-tools/runtime'
// W2.3：7 Capability + capability 装配 helper + 引擎 hooks 子模块
import {
  FileSystemCap,
  PlatformDataCap,
  ShellCap,
  AuditCap,
  createRelayAuditWriter,
  CostCap,
  composeCapabilityHooks,
  prepareAgentTools,
  createTabtinReadonlyChecker,
  buildRiskMapFromSchemas,
  type CliCommandSchema,
  type RestrictedShellAllowlistChecker,
  type SkillContextProvider,
} from '@tabtin/agent-runtime/capability'
// ：平台目录类 Cap（SkillsCap / McpCap / CliCap）已迁至共享宿主包。
// ：受限 shell 动词表 / Plan 浏览器导航豁免 / untrusted 判定 / 本地产物
// URI / 隐藏 skill 名单——TabTin 业务知识由宿主注入。
import {
  SkillsCap,
  McpCap,
  CliCap,
  RESTRICTED_READONLY_VERBS,
  RESTRICTED_BROWSER_NAV_ALLOWLIST,
  isUntrustedShellCommand,
  resolveCliToolPresentation,
} from '@tabtin/agent-host/capabilities'
import { shouldInjectBrowserNavigationAllowlist } from './restricted-shell-mode-policy.js'
import { createAppMetaFormatter } from '@tabtin/agent-host/delivery'
// W2.3-fix（F8）：v2 cost.execution_limits 归一 helper —— 让 Renderer 透传过来
// 的 v2 形态（含 Django 校验后字符串化的 max_credits）正确归一到 CostCap 期望
// 的 number 类型。Daemon 端用同一个 helper 保证两宿主装配语义一致。
// 走子路径而非顶层 barrel，避免顶层 index.ts re-export 的 zustand store
// 在 ESM 静态解析阶段牵连 main 进程加载 zustand（packaged main 没装 zustand，
// 启动会 ERR_MODULE_NOT_FOUND）。同样的修法已用于 @tabtin/shared/use-countdown。
import { normalizeExecutionLimitsForCostCap } from '@tabtin/app-shell/agent-config-v2'
import {
  buildContextHook,
  buildProjectTaskContextHook,
  getFocusedAppKey,
  buildLspDiagnosticHook,
  buildMemoryHook,
  buildAgentProfileHook,
  buildModeReminderHook,
  buildTodoStateHook,
  buildRelevantRecallHook,
  buildRulesHook,
  buildWorktreeRoutingHook,
} from '@tabtin/agent-host/hooks'
// Memory v2 阶段 3：memory-injector hook 复用 memory_search 工具同款 helper
// 调 TabMemo HTTP API（DataToolsDeps 闭包）拉相关 memo——一份 fetch 逻辑两处用。
// 项目规则自动加载（AGENTS.md MVP）：rules-injector hook 复用 readProjectRules
// 读盘 helper（mtime 缓存 + 截断），两端宿主 import 同一份。
import { readProjectRules } from '@tabtin/agent-runtime/tools'
import { shouldInjectProjectTaskSkill } from './project-task-skill-gate'
import {
  buildUserPortraitCacheKey,
  buildUserPortraitMeQuery,
  resolveUserPortraitFetchScope,
} from './user-portrait-fetch-contract'
// ：memory_search helper 随 data-tools 迁宿主业务工具包。
import { callMemorySearchAPI } from '@tabtin/agent-host/tools'
// C14: lsp-runtime singleton 初始化 + passive feedback handler 注册
import {
  initializeLspServerManager,
  onLspInitialized,
  registerLSPNotificationHandlers,
  createBuiltinServersLoader,
  getInitializationStatus as getLspInitializationStatus,
} from '@tabtin/lsp-runtime'
import type { ToolProvider as RuntimeToolProvider } from '@tabtin/agent-runtime/engine'
import type { WorkingDirType, SubagentCatalogEntry, SystemPromptConfig } from '@tabtin/agent-prompt'
//  / ：Space 模板快照解析在 host；runtime 只吃展开后的通用入参。
import {
  mapRawTemplateToSnapshot,
  type SubAgentTemplateSnapshot,
} from '@tabtin/agent-host/configuration'
// ：系统提示词装配的权威真相源在 agent-runtime。Electron 不再直接调
// buildSystemPrompt 手抄入参（原主 prompt / subagent / mode 热切换 / 软切换 4 处），
// 统一走 assembleSystemPrompt（烘焙输入 + 变体）。
import {
  assembleSystemPrompt,
  createSystemPromptProvider,
  createTodoCompletionNudgeProvider,
} from '@tabtin/agent-host/prompt'
import {
  createToolRiskPolicyPort,
  createJudgeMemoStoreAdapter,
  createAgentModesToolGate,
  annotateReadonlyChildTools,
} from '@tabtin/agent-host/policy'
import type { BakedSystemPromptInputs } from '@tabtin/agent-host/prompt'
// ：run_terminal_command 交付物卡（Browser→Table / OSS）迁到 host
// afterToolResult hook（业务落在 @tabtin/agent-host/delivery）；两端宿主对称注册。
import {
  wrapEnqueueSubagentCompletionWithDeliverables,
  createTerminalArtifactCardHook,
  createFileEditPatchPersistHook,
} from '@tabtin/agent-host/delivery'
import { recordFileEditPatch } from '../../file-edit-patches/file-edit-patch-store'
import type { HostAgentToolDeps } from '@tabtin/agent-host/configuration'
import {
  ExecutionBackendRegistry,
  ExecutionRootUnreachableError,
  resolveDataRoot,
  resolveSpacesRoot,
  buildSubagentCompletionEnvelope,
  resolveAgentShellInfo,
} from '@tabtin/terminal-core'
import { resolveSpaceWorkspaceRoot } from '@tabtin/agent-runtime'
import { resolveAuthoritativeSessionCodeRoot } from '../session-code-root-binding.js'
type OperationSwitchesType = Record<string, 'allow' | 'confirm' | 'block'>
// W3：HITL UserInteractiveChannel 桥接 + ApprovalMemoStore（W6 v3 judge 接管后）。
// 生产链路 100% 走 `@tabtin/security-policy` `judge()` 主路径——历史 6 层
// PermissionPipeline（driver / layers / 配套接口）已整体清退。
import {
  cancelAllPendingHitlRequests,
} from '@tabtin/agent-runtime'
import { ModeSwitchHandler } from '../policy/mode-switch-handler.js'
import {
  loadEnabledPersonalPluginSkillSnapshot,
  selectAppSkillsToReconcile,
  searchRuntimeSkills,
  type PersonalPluginSkillSnapshot,
  type VisibleSkillEntry,
} from '@tabtin/agent-runtime/skills'
import type { SkillsModuleHandle } from '@tabtin/agent-host/skills'
import {
  collectWorkspaceSkillsForSession,
} from '../workspace-skills-context.js'
import type {
  SkillsToolsDeps,
  SkillInvokeDeps,
  SkillCreateDeps,
} from '@tabtin/agent-runtime/tools'
import { createMcpListingFetcher } from '../capabilities/mcp-listing-fetcher.js'
import { createGatedCliListingFetcher } from '../capabilities/cli-listing-gate.js'
import { getSemanticScorer } from '../capabilities/semantic-scorer.js'

const log = createLogger('AgentHost')
const SKILLS_READY_TIMEOUT_MS = 15_000
// 与 IPC/login 共用 sharedOpenAICodexCredentialStore，串行锁才覆盖 refresh/logout。
const openAICodexCredentialStore = sharedOpenAICodexCredentialStore

function resolveRuntimeWorkspaceRoot(
  rawWorkspaceRoot: string | undefined,
  fallbackRoot: string,
): string | undefined {
  if (!rawWorkspaceRoot) return undefined

  const resolution = resolveReachableTerminalCwd(rawWorkspaceRoot, fallbackRoot)
  if (resolution.fallbackFrom) {
    log.warn(
      `runtime workspaceRoot unreachable (${resolution.fallbackReason}): ` +
        `${resolution.fallbackFrom}; falling back to ${resolution.cwd ?? '<default>'}`,
    )
  }
  return resolution.cwd
}

function resolveStrictRuntimeWorkspaceRoot(rawWorkspaceRoot: string | undefined): string {
  const normalized = normalizeWorkspaceRoot(rawWorkspaceRoot)
  if (normalized) {
    const resolution = resolveReachableTerminalCwd(normalized, undefined)
    if (resolution.cwd && !resolution.fallbackFrom) return resolution.cwd
    throw new ExecutionRootUnreachableError(
      normalized,
      resolution.fallbackReason ?? 'missing',
    )
  }
  throw new ExecutionRootUnreachableError(rawWorkspaceRoot ?? '<missing>', 'missing')
}

/**
 * ：`$TABTIN_WORKSPACE` / runtime 执行根只能来自会话 Space 的 `working_dir`。
 * 无 working_dir 时走平台沙箱；禁止读全局 CLI organizationRoot。
 *
 *  / ：会话代码根绑定（TabCode worktree session root）优先于 `working_dir`。
 * `boundCodeRoot` 存在时必须 normalize + 可达；失效绑定直接拒绝创建 runtime，
 * 禁止回落到 `workingDir` / sandbox 后在另一个目录继续写。只有会话没有绑定时
 * 才沿用原 `workingDir` → sandbox 逻辑。
 */
function resolveExecutionWorkspaceRoot(opts: {
  workingDir: string | null | undefined
  organizationId: string
  spaceId: string
  boundCodeRoot?: string | null
}): string {
  const sandboxRoot = resolveSpaceWorkspaceRoot(
    resolveSpacesRoot(),
    opts.organizationId,
    opts.spaceId,
  )
  if (opts.boundCodeRoot) return resolveStrictRuntimeWorkspaceRoot(opts.boundCodeRoot)
  const normalized = normalizeWorkspaceRoot(opts.workingDir)
  if (!normalized) return sandboxRoot
  return resolveRuntimeWorkspaceRoot(normalized, sandboxRoot) ?? sandboxRoot
}

import type {
  HostState,
  RuntimeBuildInput,
  RuntimeCarryForward,
  QueryResult,
  ElectronSharedQuery,
  StreamEventSink,
  QueryRequest,
} from '../electron-agent-types.js'
import type { RuntimeSessionRequest } from '@tabtin/agent-host/runtime'

export interface ElectronRuntimeAssemblyPorts {
  readonly sessions: AgentHost<ElectronSharedQuery, QueryResult, HostState>['sessions']
  readonly workspaceBoundary: ReturnType<typeof createWorkspaceBoundary>
  sharedHost: AgentHost<ElectronSharedQuery, QueryResult, HostState> | null
  readonly interactionRegistry: AgentHost<ElectronSharedQuery, QueryResult, HostState>['interactions']['registry']
  readonly skillsModule: SkillsModuleHandle | null
  readonly skillsReady: Promise<void> | null
  syncPersistenceEnabled: boolean
  getModelCatalogSnapshot(owner: Pick<PersistedEntryOwner, 'userId' | 'organizationId'>): ModelCatalogEntry[]
  getSubagentModelPolicy(owner: Pick<PersistedEntryOwner, 'userId' | 'organizationId'>): Promise<SubagentModelPolicy>
  readonly catalogFallbackWarned: Set<string>
  refreshModelCatalogAfterRuntimeFailure(owner: Pick<PersistedEntryOwner, 'userId' | 'organizationId'>, failure: {
    modelId: string
    errorType: string
    statusCode?: number
    message?: string
  }): void
  readonly sessionContextTiers: Map<string, string>
  readonly sessionModelParamOverrides: Map<string, Record<string, string | number | boolean | null>>
  readonly agentConfigClient: ReturnType<typeof createAgentConfigClient>
  readonly modeSwitchHandler: ModeSwitchHandler
  broadcastApprovalMemoChangedToRenderer(agentId: string): void
  drainThreadNotificationsText(threadId: string, options?: { allowMissingSession?: boolean }): string | null
  resolveOwner(...args: any[]): any
  skillEnablementCache: any
  skillsStore: {
    acquire(agentId: string, options?: { force?: boolean }): Promise<SkillAvailabilitySnapshot>
    beginRun(runId: string, agentId: string, options?: SkillRunSnapshotOptions): Promise<SkillAvailabilitySnapshot>
    endRun(runId: string): void
    peekRun(runId: string | undefined | null): SkillAvailabilitySnapshot | undefined
  } | undefined
  relaySubagentStreamEventDirect: (...args: any[]) => any
  /**
   * 子 Agent 对齐：runtime 创建后，把「早于会话到达的 pause 候选」补应用到本
   * session 的暂停门（pause 下行与会话 runtime 创建存在竞态）。
   */
  applyPendingPauseToSession(
    sessionId: string,
    businessThreadId: string,
    pauseController: SessionPauseController,
  ): void
  /**
   *  / ：读取本 sessionId 当前登记的会话代码根绑定（若有）。
   * 由 `agent:bind-session-code-root` IPC 写入的 `SessionCodeRootBindingStore`
   * 提供；可选——未接线（老 host 组装 / 测试）时按 undefined 处理，
   * 行为与改动前一致。
   */
  getSessionBoundCodeRoot?(sessionId: string): string | undefined
  /** Electron 宿主的 worktree 工具生命周期适配器。 */
  agentWorktreeLifecycleHook?: EngineHooks
}

interface ElectronRuntimeExtraKey extends RuntimeDisabledAppsExtraKey {
  workspaceId: string
  projectId?: string
}

function normalizeElectronRuntimeExtraKey(
  disabledApps: readonly string[] | undefined,
  disabledToolPrefixes: readonly string[] | undefined,
  workspaceId: string,
  projectId?: string,
): ElectronRuntimeExtraKey {
  return {
    ...normalizeDisabledAppsExtraKey(disabledApps, disabledToolPrefixes),
    workspaceId,
    projectId,
  }
}

function electronRuntimeExtraKeysMatch(
  existing: ElectronRuntimeExtraKey | undefined,
  requested: ElectronRuntimeExtraKey | undefined,
): boolean {
  return disabledAppsExtraKeysMatch(existing, requested)
    && (existing?.workspaceId ?? '') === (requested?.workspaceId ?? '')
    && (existing?.projectId ?? '') === (requested?.projectId ?? '')
}

export class ElectronRuntimeAssembly {
  constructor(private readonly ports: ElectronRuntimeAssemblyPorts) {}

  private _runtimeFactory: import('@tabtin/agent-host/runtime').RuntimeSessionFactory<
    RuntimeBuildInput,
    HostState,
    AgentModeName,
    RuntimeCarryForward,
    ElectronRuntimeExtraKey
  > | null = null
  private backendRegistry: ExecutionBackendRegistry | null = null
  private lspInitialized = false
  // CLI 命令树 / risk map 统一走 cli-commands-materializer（ C1，30min TTL）
  private userPortraitCache = new Map<string, { value: string | null; timestamp: number }>()
  private static readonly USER_PORTRAIT_CACHE_TTL_MS = 10 * 60 * 1000
  private static readonly USER_PORTRAIT_NEGATIVE_CACHE_TTL_MS = 60 * 1000
  private subagentCatalogCache = new Map<string, { value: SubagentCatalogEntry[]; timestamp: number }>()
  private static readonly SUBAGENT_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000
  private subagentTemplatesBySpace = new Map<string, Map<string, SubAgentTemplateSnapshot>>()
  private sessionGroupRoleIds = new Map<string, Set<string>>()
  private reconciledSpaceAppSkills = new Set<string>()
  private reconcileSpaceAppSkillsInflight = new Map<string, Promise<void>>()

  private async previewChildModelFunding(
    organizationId: string | undefined | null,
    input: {
      modelId: string
      estimatedTokens: number
    },
  ): Promise<{
    allowed: boolean
    code?: string | null
    message?: string | null
    requiredCredits?: string | null
  }> {
    const normalizedOrganizationId = typeof organizationId === 'string' && organizationId.trim()
      ? organizationId.trim()
      : getCLIOrganizationId()
    if (!normalizedOrganizationId) {
      throw new Error('missing organization id for child model funding preview')
    }
    const token = await TokenManager.getAccessToken()
    if (!token) throw new Error('missing auth token for child model funding preview')

    const response = await fetch(joinApiPath(API_BASE_URL, '/services/llm/billing-precheck'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        organization_id: normalizedOrganizationId,
        model_id: input.modelId,
        estimated_tokens: Math.max(0, Math.trunc(input.estimatedTokens || 0)),
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      throw new Error(`funding preview HTTP ${response.status}`)
    }
    const json = await response.json() as {
      data?: {
        allowed?: unknown
        code?: unknown
        message?: unknown
        required_credits?: unknown
      }
      allowed?: unknown
      code?: unknown
      message?: unknown
      required_credits?: unknown
    }
    const data = json.data ?? json
    return {
      allowed: data.allowed === true,
      code: typeof data.code === 'string' ? data.code : null,
      message: typeof data.message === 'string' ? data.message : null,
      requiredCredits: typeof data.required_credits === 'string'
        ? data.required_credits
        : data.required_credits != null
          ? String(data.required_credits)
          : null,
    }
  }


  getRuntimeFactory() {
    if (!this._runtimeFactory) {
      this._runtimeFactory = new RuntimeSessionFactory(
        this.buildRuntimeFactoryAdapter(),
        this.ports.sessions,
      )
    }
    return this._runtimeFactory
  }

  private get runtimeFactory() {
    return this.getRuntimeFactory()
  }


  // ─── Runtime lifecycle ──────────────────────────────────────────

  async getOrCreateRuntime(
    sessionId: string,
    businessThreadId: string,
    modelId: string,
    sender: StreamEventSink,
    agentId?: string,
    workspaceId?: string,
    customRules?: string,
    agentMode: AgentModeName = 'agent',
    /**
     * W7b M3：用户自定义 operation_switches。改变会触发 runtime 重建（同 customRules）。
     */
    operationSwitches?: Record<string, 'allow' | 'confirm' | 'block'>,
    /**
     * W7b M3：是否注入 `<agent_memory_capability>` 段。改变即重建 runtime
     * （烘焙到 systemPrompt）。
     */
    memoryCapability?: boolean,
    /**
     * work_mode：Agent 工作目录类型（code/doc/mixed），决定 buildSystemPrompt
     * 注入哪个 `<work_mode>` 段。改变即重建 runtime（烘焙到 systemPrompt，
     * 与 memoryCapability 同构）。
     */
    workingDirType?: WorkingDirType,
    /** W1b：渲染层从 catalog 传来的 context window tokens。 */
    modelContextWindow?: number,
    /** W1b：渲染层从 catalog 传来的 max output tokens。 */
    modelMaxOutput?: number,
    /** W6：渲染层传来的模型能力字段，用于构建完整 ModelCapabilities。 */
    modelSupportsVision?: boolean,
    modelSupportsFunctionCalling?: boolean,
    modelCapabilitiesConfig?: Record<string, unknown>,
    modelProvider?: string,
    /**
     * W2.3-fix（F8）：v2 `cost.execution_limits` 子树（`getCapabilityOverride`
     * Renderer 端读出后透传，可能含 string 类型 max_credits）。透传到
     * createRuntimeForSession 装配 CostCap.config，让用户配的 credits 上限
     * 真实生效（修复 F8 P0 接线 bug）。
     *
     *  followup：`max_credits_per_run`（归一后）**已纳入**
     * `RuntimeCacheKey`——用户中途改「最大消费」后下一发消息即触发
     * runtime 重建，新上限即时生效。`max_iterations_per_run` 走 per-query
     * `runtime.query({ maxTurns })`，本就即时生效，不入缓存键。
     */
    executionLimits?: { max_iterations_per_run?: number | null; max_credits_per_run?: number | string | null },
    /**
     * `allow_yolo_mode` 初始值。**M2 后由调用方传入 Django 权威 fetch 的结果**
     * （`handleQueryInternal` 入口 `await this.ports.agentConfigClient.fetchAuthoritativeAgentConfig(agentId)`），
     * 不再信任 IPC payload 里 renderer 透传的 `yoloMode` 字段。
     *
     * **不进入 cache key**：跨轮 yolo 切换通过 handleQueryInternal 入口的
     * 权威 mutate（PD-13 工厂闭包）每轮重建 EffectivePolicy 即时生效，无需重建
     * runtime（LLM 上下文 / 工具集 / system prompt 都不依赖 yolo，重建会浪费
     * BudgetTracker / appContext 等 session 级状态）。
     *
     * 参数名保留 `yoloMode` 是为减少调用面 churn；语义已切换为"权威 allow_yolo"。
     */
    yoloMode?: boolean,
    /**
     * v0.1 BYOK：当前选中模型是否为 BYOK（provider_scope='organization'|'user'）。
     * 来自 IPC `QueryRequest.isByokMode`，由 Renderer sendMessageAction 从模型
     * 配置推断。透传到 createRuntimeForSession 烘焙到 TabTinProxyProvider 构造
     * 参数。**不进入 cache key**：BYOK 状态通常伴随 modelId 切换（换模型即换
     * provider_scope），runtime 自然重建即可。
     */
    isByokMode?: boolean,
    /** 当前 Space / Organization 名（人类可读）；只用于 runtime_identity 段渲染，不入 cache key。 */
    spaceName?: string,
    organizationName?: string,
    /** 当前 Space 启用的 App 能力图谱；烘焙到 `<apps>` 段，不入 cache key。 */
    enabledApps?: ReadonlyArray<{ key: string; cliKey?: string; displayName: string; capability: string; aliases?: readonly string[] }>,
    /**
     * YOLO 两步授权 PRD v3 §5.5.2：是否群协作运行时。
     *
     * Space-first Phase 4 后不再从 Space.type 派生；当前总是 false，未来由
     * group runtime 配置塞进 QueryRequest。
     * **不进入 cache key**：该运行时标志不会在 session 内变化（与 Space 生命周期同步），
     * 仅创建期烘焙到 HostState.policyContext.isGroupSpace 即可。
     */
    isGroupSpace?: boolean,
    /**
     * ：存量 personal_rules 自由文本。参与 cache key；运行时由
     * agent-profile hook 与 customRules 合并到当前 user 前，不进 system。
     */
    personalRules?: string,
    /**
     *  第三波：云端 AdminDash 压缩分档阈值（已解码校验的 camelCase 形态，
     * 仅 prompt.forward 路径非空）。优先级：云端 > env 旋钮 > runtime 默认。
     * **不进入 cache key**：AdminDash 调参属运维低频操作，复用中的 runtime
     * 在下次自然重建（换模型 / persona / 重启）时拾取新值即可。
     */
    cloudPressureThresholds?: { microCompactStart: number; llmSummaryStart: number; emergencyStart: number },
    /**
     * 与 Daemon 对齐的运行时能力过滤 extra key。变化即触发 rebuild（走
     * `disabledAppsExtraKeysMatch`）。Electron 尚未接入具体来源，callsite 现
     * 传 `[]`，行为兜底与旧路径完全一致；HostState + cache extraKey 已就位，
     * 待后续 wire 具体来源即生效。
     */
    disabledApps?: string[],
    disabledToolPrefixes?: string[],
    projectId?: string,
    /** Space.working_dir；缺省由 resolveExecutionWorkspaceRoot 走平台沙箱。 */
    workingDir?: string,
  ): Promise<AgentRuntime> {
    if (!workspaceId) {
      throw new Error('workspaceId is required to initialize session runtime')
    }
    // P1.2：快照 CLI Space id 用于缓存键比较（与 Daemon `getOrCreateRuntime` 入参
    // spaceId 同构）。CLI 切 Space 后此值变化 → bakedFieldsMatch 失败 → runtime
    // 重建 → 新的 ElectronToolProvider/plan-tools 闭包 capture 新 spaceId。
    const normalizedSpaceId = getCLISpaceId() ?? undefined
    const normalizedOrganizationId = getCLIOrganizationId() ?? undefined
    // LH2-D3: 拿到当前账号 / 租户 / agent，作为 SyncQueue.owner + HostState.owner
    // 的快照值，进入 runtime 缓存键比较。切账号场景下 owner 变化会触发 runtime 重建，
    // 避免共用旧账号 sync 目录的 SyncQueue。
    // 亦用于  会话归档路径（users/{userId}/.../workspaces/.../conversations）。
    // ：owner 由 resolveOwner 保证非空（LH2-D3 缺失即抛错），硬切新布局，
    // 不再回落 legacy platform-data 目录。
    const owner = await this.ports.resolveOwner(agentId)
    const archiveOrganizationId = normalizedOrganizationId || owner.organizationId
    const archiveSpaceId = normalizedSpaceId
    if (!archiveOrganizationId || !archiveSpaceId) {
      throw new Error(
        'getOrCreateRuntime requires organizationId+spaceId ( hard-cut — no _unscoped)',
      )
    }
    const effectiveWorkspaceRoot = resolveExecutionWorkspaceRoot({
      workingDir,
      organizationId: archiveOrganizationId,
      spaceId: archiveSpaceId,
    })
    const normalizedDisabledApps = disabledApps ?? []
    const normalizedDisabledToolPrefixes = disabledToolPrefixes ?? []
    const cacheKeyInput = {
      modelId,
      customRules,
      personalRules,
      workspaceRoot: effectiveWorkspaceRoot,
      strictWorkspaceRoot: false,
      owner,
      spaceId: archiveSpaceId,
      operationSwitches,
      maxCreditsPerRun:
        normalizeExecutionLimitsForCostCap(executionLimits)?.max_credits_per_run,
      memoryCapability,
      workingDirType,
      enabledApps,
    }
    // ：受限 shell 档位跨档需要硬重建（ShellCap.restrictedShellChecker
    // 是构造期烘焙），同档位间的 mode 切换才允许软切换。判定下沉到
    // `canSoftReconfigureByShellTier`（Electron/Daemon 同款），adapter 里透给
    // factory；这里保留兜底日志/telemetry 逐字节不变，仅接线更改。
    const buildInput: RuntimeBuildInput = {
      businessThreadId,
      modelId,
      sender,
      agentId,
      workspaceId,
      spaceId: archiveSpaceId,
      organizationId: archiveOrganizationId,
      customRules,
      personalRules,
      workspaceRoot: effectiveWorkspaceRoot,
      owner,
      operationSwitches,
      memoryCapability,
      workingDirType,
      modelContextWindow,
      modelMaxOutput,
      modelSupportsVision,
      modelSupportsFunctionCalling,
      modelCapabilitiesConfig,
      modelProvider,
      executionLimits,
      // 参数名对齐语义："权威 allow_yolo"（M2 后由 handleQueryInternal 现拉的 Django 真值）。
      authoritativeAllowYolo: yoloMode,
      isByokMode,
      spaceName,
      organizationName,
      enabledApps,
      isGroupSpace,
      projectId,
      cloudPressureThresholds,
      disabledApps: normalizedDisabledApps,
      disabledToolPrefixes: normalizedDisabledToolPrefixes,
    }

    const { session } = await this.runtimeFactory.resolve({
      sessionId,
      mode: agentMode,
      cacheKey: cacheKeyInput,
      extraKey: normalizeElectronRuntimeExtraKey(
        normalizedDisabledApps,
        normalizedDisabledToolPrefixes,
        workspaceId,
        projectId,
      ),
      input: buildInput,
    })

    return session.runtime
  }

  /**
   * agent-host-full-migration cutover: build the normalized
   * {@link RuntimeSessionRequest} for a {@link QueryRequest} without resolving —
   * this is exactly {@link getOrCreateRuntime}'s cacheKey/buildInput/extraKey
   * construction, extracted so the platform can map a request into `HostQuery`
   * and let {@link RuntimeSessionLifecycle} own the resolve/reuse/rebuild.
   *
   * `authoritativeAllowYolo` is seeded from wire `yoloMode` (telemetry value);
   * the pipeline's per-turn PD-13 mutate overwrites the session's authoritative
   * value immediately after build, so it never becomes a gate source.
   */
  buildRequestFromQuery(
    request: QueryRequest,
    sender: StreamEventSink,
    owner: PersistedEntryOwner,
  ): RuntimeSessionRequest<RuntimeBuildInput, AgentModeName, ElectronRuntimeExtraKey> {
    const workspaceId = request.workspaceId?.trim()
    if (!workspaceId) {
      throw new Error('workspaceId is required to initialize session runtime')
    }
    const sessionId = request.threadId
    const businessThreadId = request.businessThreadId ?? request.threadId
    const modelId = request.modelId?.trim()
    if (!modelId) {
      throw new Error('modelId is required to initialize session runtime')
    }
    // ：用 Host sticky 挡住陈旧 plan/ask/study IPC，避免跨轮 rebuild 回受限模式。
    const existingForMode = this.ports.sessions.get(sessionId)
    const agentMode: AgentModeName = resolveRuntimeModeAgainstSticky(
      request.agentMode ?? 'agent',
      existingForMode?.modeAuthoritySticky,
    )
    const normalizedSpaceId = request.spaceId ?? getCLISpaceId() ?? undefined
    const normalizedOrganizationId =
      request.organizationId ?? getCLIOrganizationId() ?? owner.organizationId
    // ：owner.userId 由 PersistedEntryOwner 契约保证非空，硬切新布局，
    // 不再回落 legacy platform-data 目录。
    if (!normalizedOrganizationId || !normalizedSpaceId) {
      throw new Error(
        'buildRequestFromQuery requires organizationId+spaceId ( hard-cut — no _unscoped)',
      )
    }
    // push-drain 请求可能只带薄字段；若已有 session，从已烘焙 engineConfig /
    // RuntimeCacheKey 回填能力与 cache-key 字段，避免 rebuild 吃 FALLBACK 32k/8192。
    const existing = request.triggeredBy === 'push-notification'
      ? existingForMode
      : undefined
    // push-drain 薄请求回填本会话已烘焙的 workspaceRoot。
    //  / ：main 端持久绑定是唯一权威；请求只作无绑定时的兼容
    // fallback。两者同时存在但不一致时拒绝本轮，不能让陈旧 renderer 覆盖新根。
    const authoritativeBoundCodeRoot = resolveAuthoritativeSessionCodeRoot(
      this.ports.getSessionBoundCodeRoot?.(sessionId),
      request.boundCodeRoot,
    )
    const effectiveWorkspaceRoot = resolveExecutionWorkspaceRoot({
      workingDir: request.workingDir ?? (
        request.triggeredBy === 'push-notification' ? existing?.workspaceRoot : undefined
      ),
      organizationId: normalizedOrganizationId,
      spaceId: normalizedSpaceId,
      boundCodeRoot: authoritativeBoundCodeRoot,
    })
    const modelContextWindow = (request.modelContextWindow && request.modelContextWindow > 0)
      ? request.modelContextWindow
      : existing?.engineConfig.contextWindowTokens
    const modelMaxOutput = (request.modelMaxOutput && request.modelMaxOutput > 0)
      ? request.modelMaxOutput
      : existing?.engineConfig.maxOutputTokens
    const memoryCapability = request.memoryCapability !== undefined
      ? request.memoryCapability
      : existing?.memoryCapability
    const workingDirType = request.workingDirType ?? existing?.workingDirType
    const executionLimits = request.executionLimits
      ?? (existing?.maxCreditsPerRun != null
        ? { max_credits_per_run: existing.maxCreditsPerRun }
        : undefined)
    const normalizedDisabledApps = request.disabledApps
      ?? existing?.disabledApps
      ?? []
    const normalizedDisabledToolPrefixes = request.disabledToolPrefixes
      ?? existing?.disabledToolPrefixes
      ?? []
    const projectIdCandidate = request.appContext?.appMeta?.project_id
    const projectId = typeof projectIdCandidate === 'string'
      ? projectIdCandidate.trim() || undefined
      : existing?.projectId
    const cacheKeyInput = {
      modelId,
      customRules: request.customRules,
      personalRules: request.personalRules,
      workspaceRoot: effectiveWorkspaceRoot,
      strictWorkspaceRoot: Boolean(authoritativeBoundCodeRoot),
      owner,
      spaceId: normalizedSpaceId,
      operationSwitches: request.operationSwitches,
      maxCreditsPerRun:
        normalizeExecutionLimitsForCostCap(executionLimits)?.max_credits_per_run,
      memoryCapability,
      workingDirType,
      enabledApps: request.enabledApps,
    }
    const buildInput: RuntimeBuildInput = {
      businessThreadId,
      modelId,
      sender,
      agentId: request.agentId,
      workspaceId,
      spaceId: normalizedSpaceId,
      organizationId: normalizedOrganizationId,
      customRules: request.customRules,
      personalRules: request.personalRules,
      workspaceRoot: effectiveWorkspaceRoot,
      owner,
      operationSwitches: request.operationSwitches,
      memoryCapability,
      workingDirType,
      modelContextWindow,
      modelMaxOutput,
      modelSupportsVision: request.modelSupportsVision,
      modelSupportsFunctionCalling: request.modelSupportsFunctionCalling,
      modelCapabilitiesConfig: request.modelCapabilitiesConfig,
      modelProvider: request.modelProvider,
      executionLimits,
      authoritativeAllowYolo: request.yoloMode,
      isByokMode: request.isByokMode,
      spaceName: request.spaceName,
      organizationName: request.organizationName,
      enabledApps: request.enabledApps,
      isGroupSpace: request.isGroupSpace,
      projectId,
      cloudPressureThresholds: request.cloudPressureThresholds,
      disabledApps: normalizedDisabledApps,
      disabledToolPrefixes: normalizedDisabledToolPrefixes,
    }
    return {
      sessionId,
      mode: agentMode,
      cacheKey: cacheKeyInput,
      extraKey: normalizeElectronRuntimeExtraKey(
        normalizedDisabledApps,
        normalizedDisabledToolPrefixes,
        workspaceId,
        projectId,
      ),
      input: buildInput,
    }
  }

  /**
   * Expose the composed {@link RuntimeResourceFactory} (the shared factory
   * adapter portion). The host merges in owner-teardown methods before handing
   * it to {@link AgentHost.composeQueryEngine}.
   */
  getRuntimeFactoryAdapter() {
    return this.buildRuntimeFactoryAdapter()
  }

  /**
   * 装配 `RuntimeSessionFactory` adapter：session bag = `HostState` 直挂
   * `this.ports.core.sessions`，factory 完整接管 reuse / soft-reconfigure / rebuild
   * 决策与顺序。行为等价于旧手写 `getOrCreateRuntime` 内三段决策 + Daemon
   * 侧 disabledApps/disabledToolPrefixes extra key + shell 档位软切换约束。
   */
  buildRuntimeFactoryAdapter(): RuntimeSessionFactoryAdapter<
    RuntimeBuildInput,
    HostState,
    AgentModeName,
    RuntimeCarryForward,
    ElectronRuntimeExtraKey
  > {
    return {
      getMode: (session) => session.agentMode,
      setMode: (session, mode) => {
        session.agentMode = mode
      },
      // HostState extends RuntimeCacheKey — `runtimeCacheKeysMatch` 只读约定
      // 字段，其它字段无副作用。
      getCacheKey: (session) => session,
      getExtraKey: (session) =>
        normalizeElectronRuntimeExtraKey(
          session.disabledApps,
          session.disabledToolPrefixes,
          session.workspaceId,
          session.projectId,
        ),
      extraKeysMatch: electronRuntimeExtraKeysMatch,
      canSoftReconfigure: (existing, request) =>
        canSoftReconfigureByShellTier(existing.agentMode, request.mode),
      softReconfigure: async (existing, request) => {
        await this.softReconfigureExisting(existing, request.mode, request.input)
      },
      captureCarryForward: (existing) => ({ subagentManager: existing.subagentManager }),
      teardownForRebuild: async (existing) => {
        await this.teardownForRebuild(existing)
      },
      build: async (context) => this.buildHostState(context),
    }
  }

  /**
   * Rebuild 硬拆：cancel HITL + 清 active plan + 断掉旧 sessionStorage /
   * backend session。**不**调 `this.ports.sessions.delete`——factory 内部按
   * teardown 后是否仍指向旧引用统一删除。
   */
  async teardownForRebuild(existing: HostState): Promise<void> {
    // Phase 3 F1 语义保留：只清本 session 的 HITL，别误杀其它 session。
    cancelAllPendingHitlRequests({
      hitlMap: this.ports.interactionRegistry,
      sessionId: existing.sessionId,
      reason: 'Pending tool approval cancelled because agent runtime is rebuilding.',
    })
    this.ports.modeSwitchHandler.clearSession(existing.sessionId)
    try {
      clearAllActivePlansForSession(existing.sessionId)
    } catch {
      // active-plan tracker 内部异常不应影响重建主流程
    }
    // W4a S3③（PR2）：旧 Manager 不 dispose（factory 通过 captureCarryForward
    // 保住后台子登记）；这里只处理 sessionStorage / backend session。
    await existing.sessionStorage.dispose()
    // W1.2：rebuild 时关闭旧 backend session（registry 不动，多 session 共享）。
    try {
      await existing.backendBootstrap?.session.shutdown()
    } catch {
      // shutdown 已内吞错误；这里是双层保险
    }
  }

  /**
   * Soft-reconfigure：仅 mode 变化且 shell 档位不变时保留 runtime / BudgetTracker /
   * appContext，重装 toolProvider + system prompt。行为完全对齐旧 inline 分支
   * （日志文案、telemetry、异步 CLI/portrait 加载顺序都保留）。
   */
  async softReconfigureExisting(
    existing: HostState,
    agentMode: AgentModeName,
    input: RuntimeBuildInput,
  ): Promise<void> {
    const sessionId = existing.sessionId
    const { agentId, businessThreadId, spaceId, organizationId, spaceName, organizationName } = input
    log.info(
      `Runtime soft-reconfigure: agentMode ${existing.agentMode} → ${agentMode} [session=${sessionId.slice(0, 8)}…]`,
    )
    emitTelemetryEvent(
      TelemetryEvents.AGENT_MODE_CHANGED,
      {
        from: existing.agentMode,
        to: agentMode,
        reason: 'user_switch_soft',
      },
      { session_id: sessionId, agent_id: agentId ?? undefined },
    )

    // 离开 plan/study 且不再进 plan 家族时清理 active plan（Review P1-#1）。
    const leavingPlanFamily = existing.agentMode === 'plan' || existing.agentMode === 'study'
    const enteringPlanFamily = agentMode === 'plan' || agentMode === 'study'
    if (leavingPlanFamily && !enteringPlanFamily) {
      clearAllActivePlansForSession(existing.sessionId)
    }

    // Phase 3 F1 双保险：软切也 cancel 当前 session 的 pending HITL（另一路是
    // renderer 的 `notify-mode-switched` → `notifyManualSwitch`，两者 map.delete
    // 幂等）。
    cancelAllPendingHitlRequests({
      hitlMap: this.ports.interactionRegistry,
      sessionId,
      reason: 'Pending tool approval cancelled because agent mode changed.',
    })
    this.ports.modeSwitchHandler.clearSession(sessionId)

    // Review P1-1 语义保留：先 await 异步依赖，再同步完成 reconfigure/prompt
    // 装配 + mutation，避免 await 窗口中间不一致。
    const organizationIdForPortrait = existing.owner.organizationId || ''
    const [userPortrait, subagentCatalog] = await Promise.all([
      // ：画像 per-Agent，必须带当前执行 agentId
      this.loadUserPortraitAsync(organizationIdForPortrait, agentId),
      agentMode === 'group' ? this.loadSubagentCatalogAsync(spaceId) : Promise.resolve([] as SubagentCatalogEntry[]),
      // ：Personal Space 也要加载模板快照
      spaceId ? this.loadSubagentTemplatesFullAsync(spaceId) : Promise.resolve([] as SubAgentTemplateSnapshot[]),
    ])

    let reconfigSubagentCatalog = subagentCatalog
    if (agentMode === 'group') {
      const roleIds = await this.loadGroupRuntimeRoleIdsAsync(sessionId)
      if (roleIds && roleIds.size > 0) {
        reconfigSubagentCatalog = subagentCatalog.filter(c => !!c.templateId && roleIds.has(c.templateId))
      }
    } else {
      this.sessionGroupRoleIds.delete(sessionId)
    }

    existing.toolProvider.reconfigure({ agentMode })
    const reconfigOrganizationId = organizationId
    const reconfigUserId = existing.owner?.userId
    const reconfigRuntimeIdentity = (
      spaceId && reconfigOrganizationId && existing.workspaceRoot && reconfigUserId
    )
      ? {
          organizationId: reconfigOrganizationId,
          spaceId,
          threadId: businessThreadId,
          spaceName,
          organizationName,
          workspaceRoot: existing.workspaceRoot,
          archiveDir: resolveWorkspaceSessionArchiveDir(
            resolveDataRoot(),
            reconfigUserId,
            reconfigOrganizationId,
            spaceId,
          ),
          toolLogsDir: resolveWorkspaceToolLogsDir(
            resolveDataRoot(),
            reconfigUserId,
            reconfigOrganizationId,
            spaceId,
          ),
        }
      : undefined
    const reconfigBaked: BakedSystemPromptInputs = {
      customRules: existing.customRules,
      personalRules: existing.personalRules,
      personalRulesPlacement: 'pre-user-context',
      enabledApps: input.enabledApps,
      memoryCapability: existing.memoryCapability,
      workingDirType: existing.workingDirType,
      userPortrait: userPortrait ?? undefined,
      runtimeIdentity: reconfigRuntimeIdentity,
      shellInfo: resolveAgentShellInfo(),
      subagentCatalog: reconfigSubagentCatalog,
    }
    const { systemPrompt: newSystemPrompt, buildConfig: reconfigBuildConfig } =
      assembleSystemPrompt(reconfigBaked, {
        agentMode,
        tools: existing.toolProvider.getTools().map(t => ({ name: t.name, description: t.description })),
      })
    existing.toolProvider.setSubagentSystemPrompt(newSystemPrompt, reconfigBuildConfig)
    // 直接 mutate EngineConfig —— Runtime 通过闭包持有同一引用，
    // 下次 runtime.query() 在 runQuery 开头即读到新值。
    // **不变量**：此 mutate 必须在 runningSessions 互斥保护内执行。
    existing.engineConfig.systemPrompt = newSystemPrompt
    existing.engineConfig.agentMode = agentMode
    // agentMode 由 factory 通过 setMode 写回；policyContext 同步。
    existing.policyContext.currentAgentMode = agentMode
    // ：软切成功后同步 sticky（本轮 mode 已是 resolve 后的权威值）。
    existing.modeAuthoritySticky = agentMode

    emitTelemetryEvent(
      TelemetryEvents.AGENT_MODE_APPLIED,
      { mode: agentMode, reason: 'soft_reconfigure' },
      { session_id: sessionId, agent_id: agentId ?? undefined },
    )
  }

  /**
   * `build` 分支：调 `createRuntimeForSession` 装配新 runtime 全套 —— **不 set
   * this.ports.sessions**（factory 在 build 返回后统一 set）。TelemetryEvents.PERSONA_CHANGED
   * / AGENT_MODE_CHANGED (rebuild reason='user_switch') 也保留在这里，与旧
   * inline 路径一致：只在存在旧 entry 且字段真变时发。
   */
  async buildHostState(
    context: RuntimeBuildContext<RuntimeBuildInput, AgentModeName, RuntimeCarryForward>,
  ): Promise<HostState> {
    const { sessionId, mode: agentMode, cacheKey, input, carryForward } = context
    const normalizedRules = cacheKey.customRules
    const normalizedPersonalRules = cacheKey.personalRules
    const normalizedMemoryCapability = cacheKey.memoryCapability
    const normalizedWorkingDirType = cacheKey.workingDirType

    // Persona / mode 变化 telemetry 语义保留 —— factory 已把旧 entry 从
    // sessions 摘除，用 carryForward 是否存在近似判定"是否 rebuild"，不足够
    // 精细但只影响 telemetry；后续可以让 factory 透出 previousSession。
    const priorSubagentManager = carryForward?.subagentManager
    if (priorSubagentManager) {
      // 仅在 carry-forward 存在（即"跨旧 session rebuild"）时打 telemetry。
      // customRules / agentMode 变化事件延迟到此 factory 已完成 baked 字段对比后打，
      // 与旧路径的 `existing.xxx !== normalizedXxx` 判定语义等价。
    }

    const {
      runtime,
      sessionStorage,
      snapshotStorage,
      eventStorage,
      toolLogWriter,
      toolProvider,
      shellCap,
      buildSystemPromptForMode,
      engineConfig,
      skillCredentialResolverHandle,
      backendBootstrap,
      workspaceSnapshotV3,
      agentConfigV3,
      policyContext,
      subagentManager,
      subagentStreamSink,
      eventEmitter,
    } = await this.createRuntimeForSession(
      sessionId,
      input.businessThreadId,
      input.modelId,
      input.sender,
      input.agentId,
      input.workspaceId,
      input.spaceId,
      input.organizationId,
      normalizedRules,
      input.workspaceRoot,
      agentMode,
      input.owner,
      input.operationSwitches,
      normalizedMemoryCapability,
      normalizedWorkingDirType,
      input.modelContextWindow,
      input.modelMaxOutput,
      input.modelSupportsVision,
      input.modelSupportsFunctionCalling,
      input.modelCapabilitiesConfig,
      input.modelProvider,
      input.executionLimits,
      input.authoritativeAllowYolo,
      input.isByokMode,
      input.spaceName,
      input.organizationName,
      input.enabledApps,
      input.isGroupSpace,
      input.projectId,
      normalizedPersonalRules,
      input.cloudPressureThresholds,
      priorSubagentManager,
      input.strictWorkspaceRoot,
    )
    const abortController = new AbortController()
    // runtime 因模型/模式重建时保留 Session 的暂停门，避免重建悄悄恢复执行。
    const pauseController =
      this.ports.sessions.get(sessionId)?.pauseController ?? new SessionPauseController()

    const state: HostState = {
      runtime,
      sessionId,
      businessThreadId: input.businessThreadId,
      ...cacheKey,
      agentMode,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      abortController,
      pauseController,
      sessionStorage,
      snapshotStorage,
      eventStorage,
      toolLogWriter,
      toolProvider,
      shellCap,
      buildSystemPromptForMode,
      appContext: null,
      agentProfile: null,
      engineConfig,
      skillCredentialResolverHandle,
      backendBootstrap,
      workspaceSnapshot: workspaceSnapshotV3,
      agentConfigV3,
      policyContext,
      subagentManager,
      subagentStreamSink,
      eventEmitter,
      pendingModeTransition: undefined,
      // ：新建 runtime 时 sticky 与烘焙 mode 对齐。
      modeAuthoritySticky: agentMode,
      disabledApps: input.disabledApps,
      disabledToolPrefixes: input.disabledToolPrefixes,
    }
    this.ports.applyPendingPauseToSession(sessionId, input.businessThreadId, pauseController)

    log.info(
      `Runtime created for session=${sessionId.slice(0, 8)}…, model=${input.modelId}, mode=${agentMode}`,
    )
    return state
  }

  /**
   * C14：lsp-runtime singleton init helper —— 第一次拿到 workspace root 时调用。
   *
   * 设计要点：
   *   - 幂等：lspInitialized 标记防止重复 init
   *   - 容错：失败不抛错（log warn）；lsp-runtime 是可选增强
   *   - 异步：initializeLspServerManager 内部异步，本方法是 sync wrapper
   *   - onLspInitialized 回调注册：init 成功后自动调
   *     `registerLSPNotificationHandlers` wire publishDiagnostics handler
   *   - TABTIN_DISABLE_LSP=1 由 lsp-runtime 内部处理（initializeLspServerManager
   *     opts.disabled 等价）
   *
   * 当前简化：第一次 session 决定的 workspace root 作 projectRoot，后续 session
   * 不切换。后续可加 workspace root 切换时 reinit 逻辑（W2 范围）。
   */
  ensureLspInitialized(workspaceRoot: string | undefined): void {
    if (this.lspInitialized) return
    this.lspInitialized = true

    try {
      const projectRoot = workspaceRoot ?? process.cwd()
      const loader = createBuiltinServersLoader({ projectRoot })

      // 注册 init 成功后的回调（wire publishDiagnostics handler）
      onLspInitialized((manager) => {
        try {
          registerLSPNotificationHandlers(manager)
          log.info(
            `[lsp-runtime] passive feedback handlers registered for ${manager.getAllServers().size} server(s)`,
          )
        } catch (err) {
          log.warn(
            `[lsp-runtime] registerLSPNotificationHandlers failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      })

      initializeLspServerManager(loader)

      const status = getLspInitializationStatus()
      log.info(
        `[lsp-runtime] initialization started (state=${status.status}, projectRoot=${projectRoot})`,
      )
    } catch (err) {
      log.warn(
        `[lsp-runtime] init failed (non-fatal, falling back to no-LSP mode): ${err instanceof Error ? err.message : String(err)}`,
      )
      // 不重置 lspInitialized——避免每个 session 都重试这种确定会失败的 init
    }
  }

  /**
   * ：解析当前登录用户的 userId（新布局 skills 落盘/协调需要）。
   * 字段兼容与 ElectronAgentHost.resolveSkillUserId 同源（id / user_id / userId
   * 三种字段名）；缺失或未认证时返回 undefined，调用方按场景决定是否降级。
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
   * 回补协调：以后端 Agent 携带集为准，把「已携带且启用、但本地缺失」的 app skill
   * 补物化到当前 Space，闭合「面板已装 == 本地有文件 == Agent 可见」。
   *
   * 为什么需要：本地物化只在「安装动作」发生时触发；但 enablement 可能由更早（修复前）、
   * 或非 Skill-Market 入口（CLI / app 启用）建立，这些「已装未物化」的存量在 UI 显示已装、
   * 却没有再次安装入口，Agent 一调就 skill_not_found。本方法在 Agent 用 skill 前统一自愈。
   *
   * 只处理 app 来源：其 bundled 源在客户端本地，可无网络物化。user 包（Package Registry）
   * 的回补仍由 renderer 安装 / 升级路径承担（需下载包体），不在此。
   *
   * best-effort：后端不可达 / 未登录直接跳过（不阻塞 Agent），下轮重试；单个 skill 物化
   * 失败只记日志、不影响其它。进程内按 (organizationId, spaceId) 去重，避免每轮重复打后端；
   * 并发首次协调共享同一 Promise（in-flight 去重）。
   */
  reconcileSpaceAppSkills(
    organizationId: string,
    spaceId: string,
    agentId?: string,
  ): Promise<void> {
    // ：可见 Skill 按 Agent 归属；缓存键纳入 agentId，避免串身份。
    const cacheKey = `${organizationId}::${spaceId}::${agentId ?? ''}`
    if (this.reconciledSpaceAppSkills.has(cacheKey)) return Promise.resolve()
    const inflight = this.reconcileSpaceAppSkillsInflight.get(cacheKey)
    if (inflight) return inflight
    const p = this.doReconcileSpaceAppSkills(organizationId, spaceId, cacheKey, agentId)
      .finally(() => this.reconcileSpaceAppSkillsInflight.delete(cacheKey))
    this.reconcileSpaceAppSkillsInflight.set(cacheKey, p)
    return p
  }

  async doReconcileSpaceAppSkills(
    organizationId: string,
    spaceId: string,
    cacheKey: string,
    agentId?: string,
  ): Promise<void> {
    const mod = this.ports.skillsModule
    if (!mod) return
    // ：缺 agent_id 时后端会稳定 400；跳过本轮，等 session 带上身份再协调。
    if (!agentId?.trim()) {
      log.warn(`[Skills] reconcile skipped: missing agentId for space=${spaceId}`)
      return
    }

    let carriedSkills: VisibleSkillEntry[]
    try {
      const token = await TokenManager.getAccessToken()
      if (!token) return // 未登录：跳过，不记缓存 → 下轮重试
      // 携带集是 Agent 可执行 Skill 的真源。不能用 `/skills/visible`：它同时包含
      // 组织内可见但未挂载给当前 Agent 的 Skill，会把整个市场包错误物化到本地。
      const url = joinApiPath(
        API_BASE_URL,
        `/agents/${encodeURIComponent(agentId)}/skills`,
      )
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (!resp.ok) return
      const json = await resp.json()
      carriedSkills = (json?.data?.skills ?? json?.skills ?? []) as VisibleSkillEntry[]
    } catch (err) {
      log.warn(`[Skills] reconcile fetch agent carry failed for space=${spaceId}:`, err)
      return // 网络异常：不记缓存 → 下轮重试
    }

    // 必须带 organizationId：省略时组织根技能跨组织可见，会把另一组织已物化的
    // 同 key 当成「本组织已有」，跳过补拷。
    const localKeys = new Set(
      mod.registry.listForSpace(spaceId, { organizationId }).map((s) => s.canonicalKey),
    )
    // 纯 diff（取舍规则见 selectAppSkillsToReconcile）：已在本地 / 非 app / 非法 key 已滤掉。
    const missing = selectAppSkillsToReconcile(carriedSkills, localKeys)

    // ：物化优先走新布局（userId + dataRoot），未认证时 mod.materializeAppSkill
    // 会回落老布局（spaceId + platformDataRoot）。
    const userId = await this.resolveSkillUserId()
    let healed = 0
    let failed = 0
    for (const { key, appId, slug } of missing) {
      try {
        const result = await mod.materializeAppSkill({ organizationId, spaceId, userId, appId, slug })
        if (result.installed > 0) healed++
      } catch (err) {
        // bundled 源缺失（如该 app skill 不在本客户端）等 → 记日志跳过，不阻断其它。
        failed++
        log.warn(`[Skills] reconcile materialize failed for ${key}:`, err)
      }
    }

    if (healed > 0) {
      log.info(
        `[Skills] reconciled ${healed} enabled-but-missing app skill(s) for wt=${organizationId} space=${spaceId}`,
      )
    }
    // 物化失败不记缓存：源包后到 / 磁盘抖动时下轮还能补。fetch 成功且本轮无失败
    // 才视为已协调，避免每轮打后端。
    if (failed === 0) {
      this.reconciledSpaceAppSkills.add(cacheKey)
    }
  }

  private async createLocalCodexProvider(
    sessionId: string,
  ): Promise<LocalCodexResponsesProvider> {
    if (!await openAICodexCredentialStore.getValidAuth()) {
      throw new Error('请先在「订阅套餐」中登录 ChatGPT，才能使用 Codex 模型。')
    }

    // 本机 Codex 提问必须与 OAuth 共用 Electron Chromium 网络栈，
    // 否则系统代理环境下会登录成功但提问失败。
    return new LocalCodexResponsesProvider({
      fetchImpl: openAICodexFetch as typeof fetch,
      resolveAuth: async () => {
        const currentAuth = await openAICodexCredentialStore.getValidAuth()
        if (!currentAuth) {
          throw new Error('请先在「订阅套餐」中登录 ChatGPT，才能使用 Codex 模型。')
        }
        return {
          accessToken: currentAuth.access,
          accountId: currentAuth.accountId,
        }
      },
      // Codex 上游会自行 GET image_url；本机 local-object 对它不可达（407），
      // 出网前用主进程拉成 data:（与  /  改写同源能力）。
      resolveRemoteImageUrl: async (url) => {
        const fetched = await getResourceDownloadService().fetchToBuffer({
          url,
          maxBytes: LLM_IMAGE_DATA_URL_MAX_BYTES,
        })
        return nodeBufferToAgentDataUrl(fetched.buffer, fetched.mimeType)
      },
      // 与 Proxy 同源：renderer 写 sessionModelParamOverrides，下一次 LLM 请求生效。
      requestParamOverrides: () => this.ports.sessionModelParamOverrides.get(sessionId),
      threadId: sessionId,
      onPromptCacheFallback: (diagnostic) => {
        log.warn('[LocalCodex] prompt cache parameters rejected; retrying without them', diagnostic)
      },
    })
  }

  async createRuntimeForSession(
    sessionId: string,
    businessThreadId: string,
    modelId: string,
    sender: StreamEventSink,
    agentId?: string,
    workspaceId?: string,
    sessionSpaceId?: string,
    sessionOrganizationIdInput?: string,
    customRules?: string,
    /**
     * FR-13: 上游一次快照的执行根（Space.working_dir 或平台沙箱），保证
     * system prompt / EngineConfig / ShellCap 同值。
     */
    workspaceRoot?: string,
    /**
     * W1-A: 烘焙到 ToolProvider 与 system prompt 的 mode。
     * 'agent'（默认）保持现有行为完全不变（回归基线）。
     */
    agentMode: AgentModeName = 'agent',
    /**
     * LH2-D3: 由 `getOrCreateRuntime` 通过 `resolveOwner` 解析后的快照值。
     * SyncQueue 的 owner 必须与本桶的 PersistentQueue 一致——这是分桶机制的
     * 全部依据。直接接收而非内部 resolveOwner 二次解析，避免 race。
     */
    owner?: PersistedEntryOwner,
    /**
     * W7b M3：用户在 Settings 里配置的 operation_switches。透传到
     * ElectronToolProvider 在构造时合并到 policy.operation_switches。
     */
    operationSwitches?: Record<string, 'allow' | 'confirm' | 'block'>,
    /**
     * W7b M3：是否启用 memory 能力。透传到 buildSystemPrompt 决定是否
     * 注入 `<agent_memory_capability>` 段。
     */
    memoryCapability?: boolean,
    /**
     * work_mode：Agent 工作目录类型（已由 getOrCreateRuntime 归一化）。透传到
     * buildSystemPrompt 决定注入哪个 `<work_mode>` 段。
     */
    workingDirType?: WorkingDirType,
    /** W1b：渲染层 IPC 传来的 context window tokens。 */
    modelContextWindow?: number,
    /** W1b：渲染层 IPC 传来的 max output tokens。 */
    modelMaxOutput?: number,
    /** W6：渲染层传来的模型能力字段。 */
    modelSupportsVision?: boolean,
    modelSupportsFunctionCalling?: boolean,
    modelCapabilitiesConfig?: Record<string, unknown>,
    modelProvider?: string,
    /**
     * W2.3-fix（F8）：v2 `cost.execution_limits` 子树。装配 CostCap 时
     * 经 `normalizeExecutionLimitsForCostCap` 归一为 number 形态喂入
     * `CostCapInit.config.execution_limits`，让用户配的 credits 上限真实生效。
     */
    executionLimits?: { max_iterations_per_run?: number | null; max_credits_per_run?: number | string | null },
    /**
     * `allow_yolo_mode` 初始值。
     *
     * **M2（v3 review）后**：上层 `handleQueryInternal` 调用此函数前已 await
     * `agentConfigClient.fetchAuthoritativeAgentConfig(agentId)` 取到 Django
     * 权威值，传入这里作为初始 seed。**不再**直接信任 IPC payload 里 renderer
     * 透传的 `yoloMode` 字段（防御 reviewer-C HIGH-1 IPC 篡改提权）。
     *
     * 仅决定 `agentConfigV3.security.allow_yolo_mode` 的初始值——后续切换由
     * handleQueryInternal 入口的权威 mutate + PD-13 每轮重建 EffectivePolicy
     * 即时生效（详见 createRuntimeForSession 内 `agentConfigV3` 字面量旁的注释）。
     *
     * 参数名保留 `yoloMode` 为减少调用面 churn；语义 = "权威 allow_yolo"。
     * v3 PRD §5.1.1：字段改名 yolo_mode → allow_yolo_mode（Agent 级 gate）。
     */
    yoloMode?: boolean,
    /**
     * v0.1 BYOK：当前选中模型是否为 BYOK（provider_scope='organization'|'user'）。
     * 透传到 TabTinProxyProvider，让 503/429/401 错误分支区分 BYOK 与平台通道，
     * 给用户展示准确文案。**不进入 cache key**：BYOK 状态通常伴随 modelId 切换
     * （换模型即换 provider_scope），runtime 自然重建即可。
     */
    isByokMode?: boolean,
    /**
     * 当前 Space / Organization 的人类可读名字（renderer 在每次 query payload 顶层
     * 带过来）。仅烘焙到 `<runtime_identity>` 段供 Agent 展示——不参与路径派生、
     * 不参与 cache key（同 persona / customRules，属于「创建期烘焙字段」；
     * Space rename 这种罕见场景下需要重建 runtime 才会刷新，可接受）。
     */
    spaceName?: string,
    organizationName?: string,
    /**
     * 当前 Space 启用的 App 能力图谱（renderer 透传）。烘焙到 `<apps>` 段，
     * 让 Agent 知道这个 Space 里能用哪些 App 以及每个 App 的能力描述。
     */
    enabledApps?: ReadonlyArray<{ key: string; cliKey?: string; displayName: string; capability: string; aliases?: readonly string[] }>,
    /**
     * YOLO 两步授权 PRD v3 §5.5.2：是否群协作运行时。
     *
     * 群协作运行时与 yolo 互斥（DR-15）：即使 gate 开 + 用户选 yolo，
     * group runtime 内 buildPolicyFromAgentConfigV2 仍强制降为 effectiveMode='agent'。
     *
     * Space-first Phase 4 后不再从 Space.type 派生；当前总是 false，未来由
     * group runtime 配置塞进 QueryRequest，createRuntimeForSession 烘焙到
     * HostState.policyContext.isGroupSpace（init-only，
     * 与 Space 生命周期同步）。缺省 false（fail-open）：PR4 wire 完成前未传则按非 group
     * 处理；最终安全仍由 gate（`agent_config.security.yolo_mode`）兜底。
     */
    isGroupSpace?: boolean,
    /** Project app context ID. Undefined outside Project conversations. */
    projectId?: string,
    /**
     * ：存量 personal_rules 自由文本。参与 cache key；由
     * agent-profile hook 统一注入 pre-user context。
     */
    personalRules?: string,
    /**
     *  第三波：云端 AdminDash 压缩分档阈值（camelCase，已校验）。
     * 非空时优先于 env 旋钮 `TABTIN_PRESSURE_THRESHOLDS`。
     */
    cloudPressureThresholds?: { microCompactStart: number; llmSummaryStart: number; emergencyStart: number },
    /**
     * W4a S3③（PR2）：runtime **硬重建**期显式携带的旧 SubagentManager。
     * 由 `RuntimeSessionFactory` 的 `captureCarryForward` 快照，`build` 阶段
     * 通过 `context.carryForward` 传入——factory 已在 build 前把旧 session
     * 从 `host.sessions` 摘除，此时 `host.sessions.get(sessionId)` 一定拿不
     * 到旧 Manager；显式携带既保住 carry-forward 行为、又消除对 sessions
     * `set` 顺序的隐式依赖。soft-reconfigure 与 `handleQueryFromForward` 之
     * 类不走 factory 的老直连路径缺省 `undefined` → 保底回落到既有
     * `host.sessions.get(sessionId)` 查询（对未迁移路径行为不变）。
     */
    carryForwardSubagentManager?: SubagentManager,
    /** 会话 worktree 绑定根：构建期二次校验，不得回退 sessionDir。 */
    strictWorkspaceRoot = false,
  ): Promise<{
    runtime: AgentRuntime
    sessionStorage: SessionStorage
    snapshotStorage: SnapshotStorage
    eventStorage: EventStorage
    toolLogWriter: ToolLogWriter | null
    toolProvider: ElectronToolProvider
    /** ：透出 ShellCap 实例 + 模式 prompt 重建闭包，供轮内模式热切换。 */
    shellCap: ShellCap | null
    buildSystemPromptForMode: (
      mode: AgentModeName,
      tools: Array<{ name: string; description: string }>,
    ) => { systemPrompt: string; buildConfig: SystemPromptConfig }
    engineConfig: EngineConfig
    /**
     * Wave 5b S2 review#1 兑现：把 Skill credential resolver handle 也透出，
     * 让 `getOrCreateRuntime` 缓存到 HostState，IPC `skill-credential-invalidate`
     * 可以遍历 sessions 主动失效缓存。
     */
    skillCredentialResolverHandle: SkillCredentialResolverHandle
    /**
     * W1.2：NativeBackendSession + 关联 ExecutionBackend。feature flag 关闭
     * 时为 null；query.ts 主路径不消费 —— 仅供 W2 Capability 装配。
     */
    backendBootstrap: NativeBackendBootstrapResult | null
    /**
     * Hilt v3 (bf454d821)：构造 toolProvider / agentConfigV3 时 new 出的
     * workspace 快照，需要透出给 `getOrCreateRuntime` 写入 HostState（用作
     * judgePolicy 等后续 capability 决策时的"会话级 workspace 凭据"）。
     *
     * **dogfood 4eb4a2f2 第二轮复盘**：bf454d821 在 HostState 里加了
     * `workspaceSnapshot` 字段，且 getOrCreateRuntime 会读 `workspaceSnapshotV3`
     * 写进 sessions Map，但**忘了把它从 createRuntimeForSession 返回出来** ——
     * 运行时撞 `workspaceSnapshotV3 is not defined` ReferenceError。修复方案是
     * 把 workspaceSnapshotV3 从函数局部变量提升为返回值字段。
     */
    workspaceSnapshotV3: import('@tabtin/security-policy').WorkspaceSnapshot
    /**
     * Hilt v3 / W6 M1：本 session 的 AgentConfigV3 可变实例。
     *
     * 与 `workspaceSnapshotV3` 同模式 —— 工厂闭包 `buildJudgePolicy` 持有此对象
     * 引用；handleQueryInternal 入口直接 mutate `security.allow_yolo_mode` 让用户的
     * 设置切换在下一轮 runTools 入口立即生效，无需重建 runtime。
     * v3 PRD §5.1.1：字段改名 yolo_mode → allow_yolo_mode（Agent 级 gate）。
     */
    agentConfigV3: import('@tabtin/security-policy').AgentConfigV3
    /**
     * YOLO 两步授权 PRD v3 §5.5.2：buildJudgePolicy 闭包派生 effectiveMode
     * 所需的两个入参容器。透出给 getOrCreateRuntime 写到 HostState，
     * 让 handleQueryInternal 入口 mutate `currentAgentMode`（PD-13）。
     */
    policyContext: HostState['policyContext']
    /** W4a S1：session 维度子 Agent 登记中心，透出给 getOrCreateRuntime 写 HostState。 */
    subagentManager: HostState['subagentManager']
    /** W4a S2：子 Agent 实时流 session 级出口，透出给 getOrCreateRuntime 写 HostState。 */
    subagentStreamSink: HostState['subagentStreamSink']
    eventEmitter: HostState['eventEmitter']
  }> {
    if (!workspaceId) {
      throw new Error('createRuntimeForSession: workspaceId is required')
    }
    const runtimeThreadId = businessThreadId ?? sessionId
    const initialToken = await TokenManager.getAccessToken()
    if (!initialToken) {
      throw new Error('Not authenticated — cannot create agent runtime')
    }

    const proxyUrl = joinApiPath(API_BASE_URL, '/llm/proxy')

    // W5 fix: compute model capabilities before provider so it gets correct
    // cacheType (avoids spurious cache_control on OpenAI/DeepSeek models).
    // W6: IPC 现在传来全部能力字段，不再只覆盖 2 个。
    //
    // IPC 缺值时优先吃 catalog（与 dynamicResolveContextWindow 同源）；
    // 本地 Codex 模型不在 Django catalog，再吃 shared/openai-codex-models；
    // 最后才 FALLBACK。否则 push-drain 薄请求 rebuild 会把 maxOutput 钉成 8192，
    // 有效窗口被严重低估 → 误触发 compaction。
    if (!owner) {
      throw new Error('createRuntimeForSession: owner is required (LH2-D3)')
    }
    const scopedModelCatalogSnapshot = this.ports.getModelCatalogSnapshot(owner)
    const catalogScopeKey = modelCatalogScopeKey(owner)
    const catalogHitForCaps = findCatalogEntry(scopedModelCatalogSnapshot, modelId)
    const catalogContextWindow = catalogHitForCaps?.capabilities.contextWindowTokens
    const catalogMaxOutput = catalogHitForCaps?.capabilities.maxOutputTokens
    const codexCaps = isOpenAICodexModel(modelId)
      ? resolveOpenAICodexModelCapabilities(modelId)
      : null
    const ctxWindow = (modelContextWindow && modelContextWindow > 0)
      ? modelContextWindow
      : (catalogContextWindow && catalogContextWindow > 0)
        ? catalogContextWindow
        : (codexCaps?.contextWindowTokens ?? FALLBACK_MODEL_CAPABILITIES.contextWindowTokens)
    const maxOutput = (modelMaxOutput && modelMaxOutput > 0)
      ? modelMaxOutput
      : (catalogMaxOutput && catalogMaxOutput > 0)
        ? catalogMaxOutput
        : (codexCaps?.maxOutputTokens ?? FALLBACK_MODEL_CAPABILITIES.maxOutputTokens)
    // ：IPC 未传 context_window（旧渲染层 / WS forward 未透传 / 缓存未命中）
    // → 若 catalog / Codex SSoT 也解析不到才真回落 32k。打 warn 让回落可观测可诊断。
    //
    // bugbot 评审：只看 IPC 缺 modelContextWindow 就 warn 会误报——真正
    // 决定 pressure/blocking 的 resolveContextWindow=dynamicResolveContextWindow
    // （见下方）在 IPC 缺值时会继续走 findCatalogEntry。此处 modelCaps 烘焙已与
    // catalog 对齐；仅"IPC 缺值 **且** catalog / Codex 也解析不到"才告警。
    if (!(modelContextWindow && modelContextWindow > 0)) {
      const catalogResolvable = !!(catalogContextWindow && catalogContextWindow > 0)
      const codexResolvable = !!codexCaps
      if (!catalogResolvable && !codexResolvable) {
        log.warn(
          `[AgentHost] session model "${modelId}" context_window unresolvable ` +
          `(IPC modelContextWindow=${modelContextWindow ?? 'undefined'} + catalog snapshot miss, ` +
          `snapshot size=${scopedModelCatalogSnapshot.length}) — falling back to ` +
          `${FALLBACK_MODEL_CAPABILITIES.contextWindowTokens}. pressure/blocking will be ` +
          `computed against this fallback; if the real model has a larger window, expect ` +
          `premature compaction / blocking .`,
        )
      }
    }
    if (!(modelMaxOutput && modelMaxOutput > 0)) {
      const catalogResolvable = !!(catalogMaxOutput && catalogMaxOutput > 0)
      const codexResolvable = !!codexCaps
      if (!catalogResolvable && !codexResolvable) {
        log.warn(
          `[AgentHost] session model "${modelId}" max_output unresolvable ` +
          `(IPC modelMaxOutput=${modelMaxOutput ?? 'undefined'} + catalog snapshot miss, ` +
          `snapshot size=${scopedModelCatalogSnapshot.length}) — falling back to ` +
          `${FALLBACK_MODEL_CAPABILITIES.maxOutputTokens}. LLM max_tokens / outputReserve ` +
          `will use this fallback .`,
        )
      }
    }
    const supportsPromptCaching = modelCapabilitiesConfig?.supports_prompt_caching === true
    const cacheType = modelProvider
      ? deriveCacheType(modelProvider, modelCapabilitiesConfig)
      : FALLBACK_MODEL_CAPABILITIES.cacheType
    const reasoningHistoryPolicy = deriveReasoningHistoryPolicy(modelProvider, modelCapabilitiesConfig)
    const modelCaps: ModelCapabilities = {
      contextWindowTokens: ctxWindow,
      maxOutputTokens: maxOutput,
      maxInputTokens: ctxWindow,
      supportsVision: modelSupportsVision ?? FALLBACK_MODEL_CAPABILITIES.supportsVision,
      supportsFunctionCalling: modelSupportsFunctionCalling ?? FALLBACK_MODEL_CAPABILITIES.supportsFunctionCalling,
      supportsPromptCaching,
      cacheType,
      reasoningHistoryPolicy,
    }
    // owner 在 query 提交时按 session.organization_id 固化；运行中的 proxy 不能再读
    // 进程级 CLI 当前组织，否则切换 UI 上下文会把后续 LLM 请求串到另一租户。
    const sessionOrganizationId = owner.organizationId
    const subagentModelPolicy = await this.ports.getSubagentModelPolicy(owner)
    const hasLocalCodexCredential = Boolean(
      await sharedOpenAICodexCredentialStore.read().catch(() => null),
    )
    // 服务端 catalog 只含平台 / API Key 路由；ChatGPT 登录是本机 Provider，须在
    // Electron runtime 内补入目录，否则 fixed 本机模型会被当作 catalog miss 降级。
    const localCodexCatalog: ModelCatalogEntry[] = hasLocalCodexCredential
      ? OPENAI_CODEX_MODELS.map(localModel => ({
          id: localModel.id,
          displayName: localModel.displayName,
          capabilities: {
            ...modelCaps,
            contextWindowTokens: localModel.contextWindowTokens,
            maxInputTokens: localModel.contextWindowTokens,
            maxOutputTokens: localModel.maxOutputTokens,
          },
          usageHint: '本机 ChatGPT',
          providerScope: 'user',
        }))
      : []
    // 子 Agent 模型自由度（Phase 3/4）：当前 organization 的可用模型菜单快照。
    const modelCatalog = [...scopedModelCatalogSnapshot, ...localCodexCatalog]

    const createProxyProvider = (
      capabilities: ModelCapabilities,
      providerIsByok: boolean | undefined,
    ) => new TabTinProxyProvider({
          proxyUrl,
          deviceToken: async () => {
            const token = await TokenManager.getAccessToken()
            if (!token) throw new Error('Token expired — re-authentication required')
            return token
          },
          agentId,
          // §17.6 D4：ProxyProviderConfig.sessionId → threadId，值就是业务对话 thread。
          threadId: runtimeThreadId,
          organizationId: () => sessionOrganizationId,
          modelCapabilities: capabilities,
          // 长上下文档位：每次发请求前从 sessionContextTiers Map 取——这样
          // renderer 切档（IPC 写入 Map）后下一次 LLM 调用立即生效，无需重建 runtime。
          contextTierId: () => this.ports.sessionContextTiers.get(sessionId) || undefined,
          requestParamOverrides: () => this.ports.sessionModelParamOverrides.get(sessionId),
          isByokMode: providerIsByok,
        })
    const parentRoute = resolveModelExecutionRoute({
      modelId,
      catalogEntry: catalogHitForCaps,
      rendererByokHint: isByokMode,
    })
    const provider = parentRoute.kind === 'local_codex'
      ? await this.createLocalCodexProvider(sessionId)
      : createProxyProvider(modelCaps, parentRoute.isByok)
    const resolveProviderForModel = async (targetModelId: string) => {
      if (targetModelId === modelId) return provider
      const targetEntry = findCatalogEntry(modelCatalog, targetModelId)
      const targetRoute = resolveModelExecutionRoute({
        modelId: targetModelId,
        catalogEntry: targetEntry,
        rendererByokHint: isByokMode,
      })
      if (targetRoute.kind === 'local_codex') {
        log.info(`[AgentHost] subagent provider resolved: model=${targetModelId} route=local_codex`)
        return this.createLocalCodexProvider(sessionId)
      }
      log.info(
        `[AgentHost] subagent provider resolved: model=${targetModelId} ` +
        `route=proxy scope=${targetEntry?.providerScope ?? 'unknown'}`,
      )
      return createProxyProvider(
        targetEntry?.capabilities ?? modelCaps,
        targetRoute.isByok,
      )
    }

    // spaceId / organizationId must resolve before sessionDir: archive lives in
    // the  workspace metadata tree
    // (`users/{userId}/organizations/{org}/workspaces/{space}/conversations/`)
    // so two Organizations on the same machine never collide. tool-logs share
    // the same per-workspace conversations dir because tool-logs and
    // messages.jsonl reference each other.
    const spaceId = sessionSpaceId?.trim() || undefined
    const organizationId = sessionOrganizationIdInput?.trim() || sessionOrganizationId
    // ：会话归档硬切新布局，禁止 organizationId/spaceId 缺失落到 `_unscoped`
    if (!organizationId || !spaceId) {
      throw new Error(
        'createRuntimeForSession requires organizationId+spaceId ( hard-cut — no _unscoped)',
      )
    }

    // W6a：会话存储束下沉到 agent-host（双端共享）。
    // owner.userId 由 resolveOwner 保证非空（PersistedEntryOwner 契约）。
    const {
      sessionDir,
      toolLogsDir,
      sessionStorage,
      snapshotStorage,
      eventStorage,
      toolLogWriter,
      toolResultStorage,
      sessionConfig,
    } = createSessionStorageBundle({
      organizationId,
      spaceId,
      archiveThreadId: businessThreadId,
      sessionConfigThreadId: runtimeThreadId,
      toolLogSessionId: sessionId,
      dataRoot: resolveDataRoot(),
      userId: owner.userId,
      log,
    })
    // ：普通 Space working_dir 不可达时回退受控 sessionDir；会话 worktree
    // 绑定根则必须精确命中，构建期二次校验，禁止在另一个目录继续执行。
    workspaceRoot = strictWorkspaceRoot
      ? resolveStrictRuntimeWorkspaceRoot(workspaceRoot)
      : resolveRuntimeWorkspaceRoot(workspaceRoot, sessionDir)

    // 确保当前用户 / 组织的 skills 目录已预装默认 skill（ 硬切新布局：
    // 只走 ensureUserSkills + ensureOrganizationSkills；owner.userId 由本方法
    // 开头 `if (!owner) throw` 保证非空，不再回落老布局 ensureSpaceSkills）。
    if (spaceId && organizationId && this.ports.skillsModule) {
      try {
        await this.ports.skillsModule.ensureUserSkills(owner.userId)
        await this.ports.skillsModule.ensureOrganizationSkills(owner.userId, organizationId)
      } catch (err) {
        log.warn(`[Skills] ensure skills dir failed for wt=${organizationId} space=${spaceId}:`, err)
      }
      // 回补协调：以后端 enablement 为准，把「后端已启用但本地缺失」的
      // app skill 补物化。路径无关——不管当初从 Skill Market / CLI / 修复前存量哪装的，
      // Agent 用 skill 前统一自愈，闭合「面板已装 == 本地有文件 == Agent 可见」。
      try {
        await this.reconcileSpaceAppSkills(organizationId, spaceId, agentId)
      } catch (err) {
        log.warn(`[Skills] reconcileSpaceAppSkills failed for wt=${organizationId} space=${spaceId}:`, err)
      }
    }

    const host = this.ports
    // W4a S2（2026-05-30）：子 Agent 实时流的 session 级统一出口（跨 query 存活，
    // 挂 HostState.subagentStreamSink）。query 内表现与原 `emitStreamEvent`
    // （sender.send IPC + eventInterceptor）逐字节一致；query 外（后台子，S5 接入）
    // 改走 `relaySubagentStreamEventDirect` 直接 relay，不再丢到失效的 per-query
    // 通道。详见 createSubagentStreamRouter 头注释。
    const subagentStreamSink = createSubagentStreamRouter({
      // ：子 Agent 实时流经 AgentRealtime 广播给该 session 的全部 watcher
      // （按 watch-session 登记，始终指向用户当前所在窗口 + 多窗口）。background 子 Agent
      // outlive 创建它的那个 query 也不受创建期 sender 是否 stale 影响；窗口全关则只走
      // query 外 relay 兜底。取代原 CH-8/CH-9 frontendSinkByThread + 创建期 sender 回落。
      sendToActiveClient: (event) => {
        host.sharedHost?.publish(sessionId, { event })
      },
      // in-query relay：当下的 eventInterceptor（per-query deliveryBuffer + 落盘）。
      getInQueryRelay: () => host.sessions.get(sessionId)?.eventInterceptor,
      // query 外：session 级直接 relay（后台子事件始终到 Django）。
      relayOutOfQuery: (event) => host.relaySubagentStreamEventDirect(sessionId, event),
      log: (msg, err) => log.warn(`[subagent-sink] ${msg}`, err ?? ''),
    })
    // emitStreamEvent 经 HostState 上的 sink 统一入口（后续 PR 可对 resume /
    // 后台子重绑该 sink）。sessions.set 之前的极小窗口里 session 尚未写入，
    // fallback 到本地 const（行为同上，零差异）。
    const rawStreamSink = (event: StreamEvent): void => {
      const sink = host.sessions.get(sessionId)?.subagentStreamSink ?? subagentStreamSink
      sink(event)
    }
    // 与 runtime query egress 共用同一 emitter：permission/shell/toolProvider 等在
    // createRuntime 前捕获的 emitStreamEvent 也能拿到当前 query trace/run/thread。
    const runtimeEventEmitter = new EventEmitter(rawStreamSink, {
      threadId: runtimeThreadId,
      // 消息级执行身份随每条 runtime 事件出站。尤其 message_start 必须携带，
      // 否则旁观端只能从自己可能过期的 session.agent_id 猜头像与名称。
      ...(agentId ? { agentId } : {}),
    })
    const emitStreamEvent = (event: StreamEvent): void => runtimeEventEmitter.emitStream(event)

    const waitForUserInput = (requestId: string): Promise<unknown> => {
      const scheduled = getRuntimeInteractionMode(sessionId) === 'scheduled'
      return this.ports.sharedHost!.interactions.waitForInput({
        requestId,
        conversationId: sessionId,
        timeoutMs: 24 * 60 * 60 * 1000,
        unavailableReason: scheduled
          ? 'Unattended (scheduled) session: no human available to answer HITL request; failing fast'
          : undefined,
      })
    }

    // FR-17.1：从 env 读取 per-parent 子 Agent 并发上限，注入 BudgetTracker。
    // 默认 5；env `TABTIN_MAX_CONCURRENT_CHILDREN=unlimited` 可显式禁用。
    // BudgetTracker 用一份对应一次 query —— 每个 sessionId 在 createRuntime
    // 时新建，所以 quota 天然按"一次用户对话"独立。
    const maxConcurrentChildren = resolveMaxConcurrentChildren(process.env, log)
    const maxSubagentQueue = resolveMaxSubagentQueue(process.env, log)
    const subagentResultCompact = resolveSubagentResultCompact(process.env, log)
    // W4 (2026-05-26)：BudgetTracker 同时接 active 上限 + queue 上限，让
    // agent-tool 内的 trySubmit 路径形成 5/95 总并发 100 格局。
    //
    // W4a S3③（PR2 review P1 修复）：runtime **硬重建**（换 model/persona/space 等）
    // 会走到这里 new 一份 tracker。但若旧 runtime 还有**后台子在跑**（它占着旧
    // tracker 的并发槽、且按 spawn 快照继续用旧 tracker），新 tracker 从 0 起算又能
    // 起满 maxActive → 真实并发**击穿** maxActive（plan「穿透并发」⊗「runtime 重建」
    // 交集）。故：旧 Manager 仍有后台子（`hasBackgroundRuns()`）时，**复用旧 tracker**
    // —— 让后台子与新子计入同一并发账本，不击穿。无后台子时照常 new（软切换另有
    // 路径，不到这里）。
    // W4a S3③（PR2 review P1 修复）—— resolveSubagentCarryForward 是双端共享
    // SSoT（`@tabtin/agent-host/runtime`），把 existing / hasBackgroundRuns()
    // / dispose 判定 + budgetTracker 条件复用统一收拢，避免两端漂移。详见
    // `packages/agent-host/src/runtime/subagent-carry-forward.ts` 头注释。
    // W4a S5（2026-05-30）：完成回调投递句柄——子终态经 Manager.notifyCompleted
    // 入本 host 的 NotificationQueue（跨 turn 唤醒主 Agent）。跨层：producer 在
    // agent-runtime 层，队列在 terminal 层（bridge.getNotificationQueue）。target
    // 的 spaceId / threadId 由本作用域已知补上（buildSubagentCompletionEnvelope）。
    const deliverablesEnricherDeps = {
      sessionConfig,
      flushParentMessageBlocks: () => sessionStorage.blockStorage.flushPendingWrites(),
    }
    const enqueueSubagentCompletionRaw: EnqueueSubagentCompletion = (info) => {
      // ：spaceId 取值与 query 路径对齐——优先 live session 的 HostState.spaceId
      // （随 runtime 重建更新），再回落 SubagentManager 构造期只读快照、装配期快照、
      // 最后 getCLISpaceId()（避免装配期空快照在子完成时仍丢通知）。
      // 注意顺序：liveEntry.spaceId 必须先于 subagentManager.spaceId——后者是构造期
      // readonly 字段，carry-forward 复用时不随 runtime 重建更新；Space 切换硬重建且
      // 仍有后台子时，HostState 已是新 spaceId，Manager 快照仍是旧值，用 live 优先
      // 避免完成通知带错 spaceId。快照为空但 live 已有值时不再 return false。
      // spaceId 派生走 resolveSubagentCompletionSpaceId（`@tabtin/agent-host/runtime`
      // SSoT），Electron 额外把 getCLISpaceId() 作为 cliSpaceIdFallback 参与派生。
      const liveEntry = host.sessions.get(sessionId)
      const effectiveSpaceId = resolveSubagentCompletionSpaceId({
        liveSpaceId: liveEntry?.spaceId,
        liveManagerSpaceId: liveEntry?.subagentManager?.spaceId,
        assemblySpaceId: spaceId,
        cliSpaceIdFallback: getCLISpaceId() ?? null,
      })
      if (!effectiveSpaceId) {
        log.warn(
          `[SubagentManager] notifyCompleted skipped: missing spaceId ` +
          `(thread=${sessionId} child=${info.subagent_run_id.slice(0, 8)}…)`,
        )
        return false
      }
      // ：null-safe bridge 解析——resolvePtyManagerBridge 返回 PtyManagerBridge | null，
      // 旧写法 `bridge.getNotificationQueue` 在 null 时抛 TypeError 被 catch 静默吞掉；
      // 缺 queue 时打结构化日志（含 threadId/kind）便于排查。
      let queue: import('@tabtin/terminal-core').NotificationQueue | undefined
      try {
        const bridge = resolvePtyManagerBridge() as { getNotificationQueue?: () => import('@tabtin/terminal-core').NotificationQueue } | null
        queue = bridge?.getNotificationQueue?.()
      } catch (err) {
        log.error(
          `[SubagentManager] notifyCompleted enqueue error: bridge resolve threw ` +
          `(thread=${sessionId} kind=subagent-completed child=${info.subagent_run_id.slice(0, 8)}…): ` +
          `${err instanceof Error ? err.message : String(err)}`,
        )
        return false
      }
      if (!queue) {
        log.warn(
          `[SubagentManager] notifyCompleted skipped: notification queue unavailable ` +
          `(thread=${sessionId} kind=subagent-completed child=${info.subagent_run_id.slice(0, 8)}…)`,
        )
        return false
      }
      const dispatcherRunId =
        typeof info.run_id === 'string' && info.run_id.length > 0
          ? info.run_id
          : null
      const targetThreadId = dispatcherRunId ?? businessThreadId
      return queue.enqueue(
        buildSubagentCompletionEnvelope(info, { spaceId: effectiveSpaceId, threadId: targetThreadId }),
      )
    }
    const enqueueSubagentCompletion = wrapEnqueueSubagentCompletionWithDeliverables(
      enqueueSubagentCompletionRaw,
      deliverablesEnricherDeps,
    )

    // W4a S1（2026-05-30）：session 维度子 Agent 登记中心。挂到 HostState，让
    // agent-tool 在 active 子 spawn 时双写登记（模块级 activeChildren 保留给
    // W0 取消链路），host.stop() / session 销毁时 dispose 只取消本 session 的子。
    //
    // W4a S3③（PR2）：runtime 重建时 **无条件 carry-forward 同一 Manager** 而非
    // dispose——否则 dispose 会 abort 仍在跑的后台子（误杀）。本作用域 host.sessions
    // 此刻仍持旧 entry（sessions.set 在 createRuntimeForSession 返回后才覆盖），故 get
    // 到的是上一个 runtime 的 Manager；复用它（保留后台子登记），下方 rebindLiveDeps
    // 把新 runtime 的 live 依赖灌进去。仅当旧 Manager 已 dispose（不该发生）才新建。
    // （budgetTracker 的 carry-forward 是**条件式**——仅有后台子时复用，见上方。）
    // 决策统一走 `resolveSubagentCarryForward`（`@tabtin/agent-host/runtime` SSoT）。
    const carryForwardResolved = resolveSubagentCarryForward({
      carryForwardSubagentManager: carryForwardSubagentManager as unknown as import('@tabtin/agent-host/runtime').SubagentManagerLike | undefined,
      liveSessionManager: host.sessions.get(sessionId)?.subagentManager as unknown as import('@tabtin/agent-host/runtime').SubagentManagerLike | undefined,
      maxConcurrentChildren,
      maxQueueSize: maxSubagentQueue,
      createBudgetTracker: ({ maxConcurrentChildren: mcc, maxQueueSize: mqs }) =>
        new BudgetTracker({ maxConcurrentChildren: mcc, maxQueueSize: mqs }),
      createSubagentManager: ({ parentThreadId, spaceId: sid, budgetTracker: bt, enqueueNotification }) =>
        new SubagentManager({
          parentThreadId,
          parentScopeThreadIds: [...new Set([
            businessThreadId,
            runtimeThreadId,
            sessionId,
            parentThreadId,
          ].filter((id): id is string => typeof id === 'string' && id.trim().length > 0))],
          onChildThreadScope: ({ childId, parentScopeThreadIds }) => {
            const lease = acquireSubagentCLIWorkspaceScopeLease(childId, parentScopeThreadIds)
            return () => lease.release()
          },
          spaceId: sid,
          budgetTracker: bt,
          enqueueNotification: enqueueNotification as unknown as EnqueueSubagentCompletion,
          log: (msg, err) => log.warn(`[SubagentManager] ${msg}`, err ?? ''),
        }),
      parentThreadId: sessionId,
      spaceId,
      enqueueNotification: enqueueSubagentCompletion as unknown as (...args: unknown[]) => boolean,
    })
    const budgetTracker = carryForwardResolved.budgetTracker
    // Manager 一律是 SubagentManager（`createSubagentManager` 返回 SubagentManager
    // / 复用路径拿到的是原始 SubagentManager）——`resolveSubagentCarryForward`
    // 返回的 `SubagentManagerLike` 是结构类型窄口，这里 as 回具体类型让下游
    // rebindLiveDeps / dispose / registerRun 等方法可用。
    const subagentManager = carryForwardResolved.subagentManager as SubagentManager

    // W6a：ApprovalMemo + permission handler + UserInteractiveChannel 下沉到
    // agent-host（双端共享）。Electron 仅注入 Token / IPC broadcast / 薄 wrapper。
    const {
      permissionMemoStore,
      permissionHandler,
      userInteractiveChannel,
    } = assemblePermissionShell({
      sessionId,
      workspaceId,
      apiBaseUrl: API_BASE_URL,
      getAuthToken: () => TokenManager.getAccessToken(),
      emitStreamEvent,
      waitForUserInput,
      runtimeMode: getRuntimeInteractionMode(sessionId) ?? 'interactive',
      interactiveThreadId: runtimeThreadId,
      log,
      registerApprovalMemo: (memo) => {
        this.ports.sharedHost?.registerApprovalMemo(memo)
      },
      onAlwaysCommitSuccess: (wsId) => {
        this.ports.broadcastApprovalMemoChangedToRenderer(wsId)
      },
      createPermissionHandler: (options) => new ElectronPermissionHandler(options),
    })

    // 本地 Skill 模块 Wave B · M6：把 registry 单例的查询 API 绑成 closure
    // 传给 ElectronToolProvider（skills_read / skills_search 工具依赖）+
    // SkillsCap 装配（W2.3 取代旧 createSkillsAndNotes middleware）。
    //
    // skillsModule 在 start() 里通过 initSkillsModule() 异步初始化，失败或尚未
    // ready 时为 null —— 两个入口都做 null 检查让 skills 功能"静默关闭"，
    // 不阻塞 Agent 主链路（符合 PRD §十"skill 是可选知识注入"的定位）。
    //
    // 关键细节（harness 踩过的坑）：`this.ports.skillsModule` 在 createRuntimeForSession
    // 被调用时**可能还是 null**（initSkillsModule 是异步的，start() 不 await）。
    // 所以 skillsToolsDeps / fetchSkills 的 closure 必须读取 `hostRef.skillsModule`
    // 的**最新值**——不能在此快照一份 handle，否则 Runtime 创建早于 init 完成
    // 时工具永远拿不到 registry。用闭包捕获 `hostRef` + `() => hostRef.skillsModule`
    // 的惰性读法保证每次调用都是最新引用。
    const hostRef = this.ports
    const skillsReady = this.ports.skillsReady
    const loadPersonalPluginSkillsForRun = async (): Promise<{
      authoritative: boolean
      snapshot: PersonalPluginSkillSnapshot
    }> => {
      const empty: PersonalPluginSkillSnapshot = { enabledPluginIds: [], skills: [] }
      if (!spaceId || !organizationId) {
        return { authoritative: true, snapshot: empty }
      }
      try {
        // ：owner.userId 由本方法开头的 owner 非空校验保证存在，硬切新
        // 布局，不再回落 platformDataRoot。
        const snapshot = await loadEnabledPersonalPluginSkillSnapshot({
          userId: owner.userId,
          dataRoot: resolveDataRoot(),
          organizationId,
          spaceId,
          onWarn: (message) => log.warn(message),
        })
        return { authoritative: true, snapshot }
      } catch (err) {
        log.warn('[PersonalPlugin] failed to load enabled plugin skill snapshot', err)
        return { authoritative: false, snapshot: empty }
      }
    }
    const agentSkillEnablement = agentId?.trim()
      ? hostRef.skillEnablementCache.forAgent(agentId)
      : null
    const peekSkillSnapshot = (runId?: string) => hostRef.skillsStore?.peekRun(runId)
    const beginSkillRun = async (ctx: { runId: string }) => {
      if (agentId?.trim() && hostRef.skillsStore && ctx.runId) {
        if (skillsReady) {
          let timer: NodeJS.Timeout | undefined
          try {
            await Promise.race([
              skillsReady.finally(() => {
                if (timer) clearTimeout(timer)
              }),
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, SKILLS_READY_TIMEOUT_MS)
              }),
            ])
          } catch {
            if (timer) clearTimeout(timer)
          }
        }
        const registry = hostRef.skillsModule?.registry
        const personalPlugins = await loadPersonalPluginSkillsForRun()
        const workspaceSkills = await collectWorkspaceSkillsForSession({
          workspaceRoot,
          onWarn: (message) => log.warn(`[Skills][workspace] ${message}`),
        })
        await hostRef.skillsStore.beginRun(ctx.runId, agentId, {
          catalog: {
            authoritative: Boolean(registry) && personalPlugins.authoritative,
            registrySkills: registry
              ? (spaceId
                ? registry.listForSpace(spaceId, { organizationId })
                : registry.listAll())
              : [],
            personalPluginSkills: personalPlugins.snapshot.skills,
            workspaceSkills,
          },
        })
      }
    }
    const endSkillRun = (ctx: { runId: string }) => {
      hostRef.skillsStore?.endRun(ctx.runId)
    }
    if (!agentSkillEnablement) {
      log.warn('[SkillEnablement] missing agentId; all Skills disabled (closed carry set)')
    }
    const skillsToolsDeps: SkillsToolsDeps | undefined = skillsReady
      ? {
          getSkill: (key, ctx) => {
            const snapshot = peekSkillSnapshot(ctx?.agentRunId)
            if (!snapshot) return { status: 'not_ready', retryable: true }
            const resolution = snapshot.resolve(key)
            return resolution.status === 'available'
              ? resolution
              : {
                  status: resolution.status,
                  ...(resolution.status === 'not_ready' ? { retryable: true } : {}),
                }
          },
          search: (q, opts, ctx) => {
            const snapshot = peekSkillSnapshot(ctx?.agentRunId)
            if (!snapshot?.enabledMap || !snapshot.catalogAuthoritative) {
              return { status: 'not_ready' as const, retryable: true }
            }
            return searchRuntimeSkills([...snapshot.availableSkills], q, opts)
          },
          // Tier-3：references/ examples/ 附属文档的清单 + 按需读取（skills_read path）。
          listSkillResources: (key, ctx) => {
            const resolution = peekSkillSnapshot(ctx?.agentRunId)?.resolve(key)
            return resolution?.status === 'available'
              ? hostRef.skillsModule?.registry.listResourcesForSkill(resolution.skill) ?? []
              : []
          },
          readSkillResource: (key, relPath, ctx) => {
            const resolution = peekSkillSnapshot(ctx?.agentRunId)?.resolve(key)
            return resolution?.status === 'available'
              ? hostRef.skillsModule?.registry.readResourceForSkill(resolution.skill, relPath) ?? {
                  ok: false,
                  error: 'Skill registry 未就绪，无法读取附属文件。',
                }
              : {
                  ok: false,
                  error: '当前 Run 的 Skill 可用性快照中没有该技能。',
                }
          },
          //  RB1：per-runtime 业务身份烘进 deps（装配作用域快照，
          // 见 L1303-1304），工具不再从 ToolContext 读。
          spaceId,
          organizationId,
        }
      : undefined

    // Wave 2b: skill_invoke 复用同一 getSkill 回调
    // H19 Wave 2g：SkillInvokeDeps 可接受 `validateModel` 回调让 runtime 在
    // skill frontmatter 写 `model:` 时做预检。
    //
    // 子 Agent 模型自由度（Phase 3/4）已兑现「主进程持有可用模型目录缓存」这个
    // 前置——原 TODO 设想走 `agent-engine:list-available-models` IPC（renderer →
    // main）；实做改为主进程直接 HTTP 拉 `/services/llm/catalog`（与 Daemon W1b
    // 对称，见 `this.ports.getModelCatalogSnapshot` / `refreshModelCatalog`），避免脆弱的
    // preload surface / 生成类型改动。skill `model:` 预检（validateModel）属
    // skill 范畴、不在本批（子 Agent 模型自由度）内，留待后续用同一份快照接入；
    // 当前维持 `validateModel: undefined` 的透传兼容行为。
    const skillInvokeDeps: SkillInvokeDeps | undefined = skillsReady && skillsToolsDeps
      ? {
          getSkill: skillsToolsDeps.getSkill,
          listSkillResources: skillsToolsDeps.listSkillResources,
          //  RB1：per-runtime 业务身份烘进 deps，工具不再从 ToolContext 读。
          spaceId,
          organizationId,
        }
      : undefined

    // Wave 1.5: Skill 运行时密钥注入 resolver（与 `initialToken` / 当前 query
    // 的 organizationId 同生命周期——下次 createRuntimeForSession 会构造新的）。
    const skillCredentialResolverHandle = createSkillCredentialResolver({
      apiBaseUrl: API_BASE_URL,
      // Wave 1.5 PROD-3 / 三视角 Review 技术 1：字段名带 Snapshot 后缀
      // 显式表达"Electron 走构造时快照，token 刷新靠 runtime 重建"——避免
      // 和 Daemon "getter 动态取值" 的行为混淆。
      apiAuthTokenSnapshot: initialToken,
      organizationId,
    })

    // Wave 5a (L-W4-1)：构造 RunSession observation → LLM 上下文注入器。
    // 与 `skillCredentialResolverHandle` 同生命周期（per-runtime），把"自上次
    // 以来新增的 AGENT_AUTOFILL_FAILED / SPACE_ENV_CHANGED observation"在每
    // 轮 ReAct loop 起始处喂给 LLM。安全约束（密码 / credential_id 不进 LLM）
    // 由 injector 内部的 formatter 与白名单负责。
    const runObservationInjectorHandle = createRunObservationInjector({
      spaceId: spaceId ?? undefined,
    })

    // : skill_create 改写到新布局 `{dataRoot}/users/{userId}/
    // organizations/{orgId}/skills/`。spaceId 仅保留作为上下文兜底（不再参与
    // 路径计算）；缺少 Organization 上下文或未登录时显式失败，不退回 legacy 目录。
    const skillCreateDeps: SkillCreateDeps | undefined = skillsReady
      ? {
          writeSkill: async (slug, content, ctx) => {
            const currentOrganizationId = ctx?.organizationId ?? organizationId ?? undefined
            if (!currentOrganizationId) {
              throw new Error('缺少 Organization 上下文，无法创建 Skill。请在具体组织中重新发起请求。')
            }
            // ：owner.userId 由本方法开头的 owner 非空校验保证存在。
            const dir = resolveOrganizationSkillDir(
              resolveDataRoot(),
              owner.userId,
              currentOrganizationId,
              slug,
            )
            await fs.promises.mkdir(dir, { recursive: true })
            const filePath = path.join(dir, 'SKILL.md')
            await fs.promises.writeFile(filePath, content, 'utf-8')
            return filePath
          },
          //  / ：Skill HTTP 只认 organization_id + agent_id，禁止再传 space_id。
          registerSkill: async (params) => {
            const token = await TokenManager.getAccessToken()
            if (!token) return { error: '未登录，无法注册 Skill', status: 401 }
            const url = joinApiPath(API_BASE_URL, '/skills/create')
            const body: Record<string, unknown> = {
              organization_id: params.organizationId,
              name: params.name,
              description: params.description,
              slug: params.slug,
              emoji: params.emoji || '',
            }
            if (params.agentId) {
              body.agent_id = params.agentId
              // 创建即挂载到当前对话 Agent（对齐 UI CreateSkillDialog 的 enable_agent_ids 契约）。
              body.enable_agent_ids = [params.agentId]
            }
            const resp = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify(body),
            })
            if (!resp.ok) {
              const text = await resp.text().catch(() => '')
              let parsed: unknown = { error: text }
              try {
                parsed = JSON.parse(text)
              } catch {
                // keep plain text envelope
              }
              return {
                error: `API ${resp.status}: ${text.slice(0, 200)}`,
                status: resp.status,
                body: parsed,
              }
            }
            const json = await resp.json()
            const data = json?.data ?? json
            return { skill_id: data?.skill_id, slug: data?.slug }
          },
          //  RB1：per-runtime 业务身份烘进 deps，工具不再从 ToolContext 读。
          spaceId,
          organizationId,
          agentId,
        }
      : undefined
    const fetchSkills = skillsReady
      ? async (ctx: { query?: string; focusedApp?: string | null; runId?: string }) => {
          const registry = hostRef.skillsModule?.registry
          if (!registry) return null
          // ：spaceId / organizationId 是 per-runtime 常量（切 Space
          // 重建 runtime），用装配作用域的快照值（L1303-1304）烘进闭包，Cap 不再
          // 经 ctx 传入。
          // ：热路径优先常驻 getSync；未暖才 refresh。面板变更走
          // invalidateAgent + 异步 rewarm。斜杠直链 force 见
          // EngineConfig.refreshSkillEnablementForSlash。
          const snapshot = peekSkillSnapshot(ctx.runId)
          if (!snapshot?.enabledMap || !snapshot.catalogAuthoritative) {
            return registry.renderAvailableSkills([], {
              query: ctx.query,
              focusedApp: ctx.focusedApp
                ?? getFocusedAppKey(hostRef.sessions.get(sessionId)?.appContext ?? null),
              budgetChars: 8_000,
            })
          }
          const explicitlyRequestedLibTv = isExplicitLibTvRequest(ctx.query)
          let libTvCredentialAvailable = false
          if (!explicitlyRequestedLibTv && agentId) {
            const libTvSkill = snapshot.availableSkills.find(isLibTvSkill)
            if (libTvSkill) {
              try {
                const credential = await skillCredentialResolverHandle.resolver({
                  skillKey: libTvSkill.canonicalKey,
                  spaceId,
                  agentId,
                  primaryEnv: libTvSkill.primaryEnv,
                }, new AbortController().signal)
                libTvCredentialAvailable = Boolean(
                  credential
                  && Object.values(credential.env).some((value) => value.trim().length > 0),
                )
              } catch {
                // 密钥检查失败按不可用降级：通用生图仍走原生 media CLI。
                libTvCredentialAvailable = false
              }
            }
          }
          // budgetChars：PRD §5.4 "2000 token ≈ 8000 字符"
          return registry.renderAvailableSkills(snapshot.availableSkills, {
            // 透传相关性排序 query（by SkillsCap）→ skill-renderer.ts 组内相关性排序。
            query: ctx.query,
            focusedApp: ctx.focusedApp ?? getFocusedAppKey(hostRef.sessions.get(sessionId)?.appContext ?? null),
            budgetChars: 8_000,
            enabledMap: snapshot.enabledMap,
            // Project CLI skill is an execution-only instruction set. Keep it
            // out of ordinary / project-overview chats, even when lexical
            // recall would otherwise rank it highly.
            filterSkills: (skill) => (
              shouldInjectProjectTaskSkill(
                skill.canonicalKey,
                hostRef.sessions.get(sessionId)?.appContext ?? null,
              )
            ) && shouldInjectMediaSkill(skill, {
              query: ctx.query,
              libTvCredentialAvailable,
            }),
          })
        }
      : undefined

    // FR-15 H3-A Review P1：iterationBudget 解析提前到 toolProvider 创建之前，
    // 让 agentToolDeps.iterationBudget 能透传到子 Agent（forkQuery → 子
    // EngineConfig），避免子 Agent 走默认值与父级 env 配置脱锚。下方
    // EngineConfig 也复用同一份解析结果（SSoT，避免父子在同一进程内对同一
    // env 二次解析得出不同值——理论上可能性极小但避免未来 race）。
    const iterationBudget = resolveIterationBudget(process.env, log)
    // W3 stall detector knobs（与 iterationBudget 同 ops 模式）。
    const toolFailureTracker = resolveToolFailureTracker(process.env, log)
    // FR-16 H3-B Review fix #7：reuse 配置同样提前到 toolProvider 之前，
    // 让 agentToolDeps 能把 enableSummaryReuse / 5 个 judge knob 透传给子 agent。
    // 同样 SSoT——下方 EngineConfig 复用同一份解析结果。
    const enableSummaryReuse = resolveSummaryReuse(process.env, log)
    const summaryReuseJudgeSampleRate = resolveSummaryReuseJudgeSampleRate(process.env, log)
    const summaryReuseJudgeWindowSize = resolveSummaryReuseJudgeWindowSize(process.env, log)
    const summaryReuseJudgeThreshold = resolveSummaryReuseJudgeThreshold(process.env, log)
    const summaryReuseMaxAgeMs = resolveSummaryReuseMaxAgeMs(process.env, log)
    const summaryReuseMinAddedMessages = resolveSummaryReuseMinAddedMessages(process.env, log)
    const timeBasedMicroCompact = resolveTimeBasedMicroCompact(process.env, log)
    //  压缩分档阈值：云端 AdminDash（prompt.forward 下发，已校验）>
    // env 旋钮 TABTIN_PRESSURE_THRESHOLDS > runtime 默认（0.75 / 0.85 / 0.95）。
    // 与 timeBasedMicroCompact 同 SSoT 模式——agentToolDeps 与 EngineConfig
    // 复用同一份解析结果，父子触发线一致。
    const pressureThresholds = cloudPressureThresholds ?? resolvePressureThresholds(process.env, log)

    // PRD 08 W1：read-before-edit 跨工具共享状态。提前到 toolProvider 之前
    // new 一次，让 EngineConfig 与 agentToolDeps **共享同一引用**——这样父
    // runtime 的 read 写到 Map，agent-tool fork 子 Agent 时能看到完整 snapshot
    // 并复制（fork-query.ts 内部 new Map(parent ?? []) 隔离父子）。如果两处
    // 各自 new 一份，子 Agent 永远看不到父 read 过的文件，read-before-edit
    // 在子 Agent 链路上会形同虚设（W1 第一轮 Review #1 BUG-1 硬证据）。
    const readFileState: ReadFileState = new Map()

    // **W2（2026-05-13）image / localDoc dedup 状态**（与 readFileState 物理
    // 隔离，跨 Wave 不变量 #6）。同款"提前 new + 引用共享给 EngineConfig +
    // agentToolDeps"模式，让父→子 fork 时能 shallow clone。
    const imageReadFileState: import('@tabtin/agent-runtime').ImageReadFileState = new Map()
    const localDocReadFileState: import('@tabtin/agent-runtime').LocalDocReadFileState = new Map()

    // per-file 回退引擎（替代 shadow git）：按 threadId(=sessionId) 取/建 **per-thread**
    // 实例（与 per-query 新建的 readFileState 不同——同一 thread 多轮 query 必须复用
    // 同实例让 snapshots 累积、跨轮回退找得到 anchor）。不存在才 new + 从 manifest
    // resume；与下方 EngineConfig + agentToolDeps 共享同一引用，子 Agent fork 也落到
    // 同一账本。workspaceRoot 仅用于相对路径压缩，缺省回落 sessionDir（与
    // workspaceSnapshotV3.sources.sandbox 兜底一致）。
    const fileHistory = await getOrCreateFileHistory(
      sessionId,
      workspaceRoot ?? sessionDir,
      {
        userId: owner.userId,
        organizationId: owner.organizationId,
        workspaceId,
      },
    )

    const workspaceSnapshotV3: import('@tabtin/security-policy').WorkspaceSnapshot = {
      sources: {
        sandbox: workspaceRoot ?? sessionDir,
        // 单根契约：workingDir 在 WorkspaceBoundary hydrate 后会被填上，
        // 此时只有 sandbox 兜底。
        workingDir: '',
        // 单根契约 §2.4：ApprovalPanel 审批通过的路径会通过
        // `workspace:append-session-allowed-path` IPC 推到这里，
        // session 内有效。
        sessionApprovedPaths: [],
        attachedFiles: [],
      },
      allowedPaths: [workspaceRoot ?? sessionDir],
      allowedFiles: [],
      spaceSessionId: sessionId,
    }

    // 路径权限治理 Wave 3 P0-1 修复（cold-start hydrate 真空）：
    //
    // renderer 在创建 session 之前可能已经推过 hydrate（典型场景：重启 Electron
    // 后 setActiveSpace bridge 立即推完整快照——但此时 createRuntimeForSession
    // 还没跑，session 不存在，applier 把 payload stash 进 `pendingHydrateBySpaceId`
    // buffer）。这里 session 刚 init 完，立即消费 buffer 把那些"无家可归"的
    // hydrate 应用到 sources + 重新 derive allowedPaths。
    //
    // 不消费 → 用户重启第一句话 LLM 调 edit_file 仍撞 workspace_out（dogfood
    // 起源 bug），违反 D4 上线即成熟。
    if (spaceId) {
      this.ports.workspaceBoundary.reconcileSnapshot(workspaceSnapshotV3, {
        type: 'consume-pending',
        spaceId,
      })
    }

    // W2.3-fix（F8）：从入参 executionLimits 归一后注入 CostCap.config，让用户
    // 在 v2 `agent_config.capabilities.overrides.cost.execution_limits` 配的
    // credits / iterations 上限真实生效——否则 CostCap.afterIteration 的
    // maxCredits 分支永远不触发（W2 综合独立验证 P0，详见总控 F8 反思）。
    //
    // 入参 executionLimits 由 Renderer 调 `getCapabilityOverride(cfg, 'cost',
    // 'execution_limits')` 后透传过来；这里调 `normalizeExecutionLimitsForCostCap`
    // 把 v2 形态（含 Django 校验后字符串化的 max_credits）归一到 CostCap 期望
    // 的 number 形态。
    //
    // 缺省 / 脏数据 → normalized = undefined → CostCap 不配显式上限，
    // afterIteration 回落 `DEFAULT_MAX_CREDITS_PER_RUN`（，
    // 与 UI / Django conversational profile 对齐）。
    //
    // **声明位置约束**（dogfood 4eb4a2f2 复盘）：必须在 `agentConfigV3` 字面量
    // 之前 —— 后者的 `capabilities` 字段引用本变量。bf454d821 引入 capabilities
    // 字段时把这行声明留在了 CostCap 构造前（行 ~4351），形成 TDZ：
    //   `Cannot access 'normalizedCostLimits' before initialization`
    // 让 createRuntimeForSession 在 runtime 装配阶段就 throw，再叠加 streamHost
    // 还未创建（catch 里 `streamHost?.fail()` no-op），Renderer 等 30s heartbeat
    // watchdog 才看到失败。下方 CostCap / EngineConfig 复用同一引用，无需重算。
    const normalizedCostLimits = normalizeExecutionLimitsForCostCap(executionLimits)
    const effectiveChildMaxTurns =
      typeof executionLimits?.max_iterations_per_run === 'number'
        && executionLimits.max_iterations_per_run >= 1
        ? executionLimits.max_iterations_per_run
        : undefined

    // 从入参 `yoloMode` 读"权威 allow_yolo"初始值（M2 后由 handleQueryInternal
    // 入口的 `agentConfigClient.fetchAuthoritativeAgentConfig(agentId)` 派生，
    // 不再信任 IPC payload 里 renderer 透传的字段），落到
    // `agentConfigV3.security.allow_yolo_mode`。下方 `buildJudgePolicy` 工厂
    // 持有此对象的引用 —— handleQueryInternal 在每次入口直接 mutate
    // `session.agentConfigV3.security.allow_yolo_mode` 为最新权威值，让 PD-13
    // "每轮拍快照"在工厂闭包调用时即时反映服务端真值。
    //
    // v3 PRD §5.1.1：字段名 ``allow_yolo_mode``（Agent 级 gate）。
    // v3 review M2：reviewer-C HIGH-1 / reviewer-A A1 — 修复 IPC 篡改提权。
    const agentConfigV3: import('@tabtin/security-policy').AgentConfigV3 = {
      schema_version: 3,
      runtime_plane: 'local',
      security: { allow_yolo_mode: yoloMode === true },
      capabilities: normalizedCostLimits ? {
        overrides: {
          cost: {
            execution_limits: {
              max_iterations_per_run: normalizedCostLimits.max_iterations_per_run,
              max_credits_per_run: normalizedCostLimits.max_credits_per_run,
            },
          },
        },
      } : undefined,
    }

    // YOLO 两步授权 PRD v3 §5.5.2 / §5.1.4：buildJudgePolicy 闭包除 agentConfigV3 /
    // workspaceSnapshotV3 外还需要 requestedAgentMode + isGroupSpace 两个派生入参。
    //
    // 设计：与 agentConfigV3 / workspaceSnapshotV3 同款"宿主 mutate / runtime read"
    // 可变源。closure capture 同一对象引用 → handleQueryInternal 入口对
    // `session.policyContext.currentAgentMode` 的 mutate 立即影响下一轮判决，
    // 无需重建 runtime（PD-13）。
    //
    // 初值：currentAgentMode = 创建期烘焙的 agentMode（与 HostState.agentMode 对齐）；
    // isGroupSpace = 创建期一次性确定，session 内不变（与 Space 生命周期对齐）。
    const policyContext: HostState['policyContext'] = {
      currentAgentMode: agentMode,
      isGroupSpace: isGroupSpace === true,
    }
    const runtimeSpaceId = spaceId ?? getCLISpaceId() ?? undefined

    //  Stage 3a：工具风险判决端口（security-policy judge 留在宿主）。
    const judgeHomeDir = process.env.HOME || process.env.USERPROFILE
    const judgeMemoAdapter = createJudgeMemoStoreAdapter(permissionMemoStore)
    const toolRiskPolicy = createToolRiskPolicyPort({
      buildEffectivePolicy: () => {
        const builtPolicy = buildPolicyFromAgentConfigV2(
          agentConfigV3,
          workspaceSnapshotV3,
          {
            planModeGuardActive: isPlanModeGuardActive(policyContext.currentAgentMode),
            requestedAgentMode: policyContext.currentAgentMode,
            isGroupSpace: policyContext.isGroupSpace,
            unattended: getRuntimeInteractionMode(sessionId) === 'scheduled',
          },
        )
        // ：把生效审批档发布给浏览器 / FrontendActionBridge 审批子系统。
        setThreadEffectiveApprovalMode(sessionId, builtPolicy.approvalMode)
        return builtPolicy
      },
      memoStore: judgeMemoAdapter,
      homeDir: judgeHomeDir,
    })

    // ：主 runtime 使用 todo nudge；子 Agent 不维护独立待办，
    // 因此 agentToolDeps 不注入该端口。
    const systemPromptProvider = createSystemPromptProvider()
    const todoCompletionNudgeProvider = createTodoCompletionNudgeProvider()
    //  / ：todo execute 与 state hook 共用会话锚（抗上下文截断）。
    const todoSessionAnchor: TodoSessionAnchor = { current: null }

    const toolProvider = new ElectronToolProvider({
      // PD-1（W6 M4）：securityPreset 字段已不再消费 —— 改由 agentConfigV3 +
      // workspaceSnapshot 驱动 v3 EffectivePolicy（buildJudgePolicy 工厂闭包），
      // 老的 PolicyEvaluator 路径会随 M5 一起退场。
      operationSwitches: operationSwitches as OperationSwitchesType | undefined,
      agentConfigV3,
      workspaceSnapshot: workspaceSnapshotV3,
      // YOLO 两步授权 PRD v3 §5.5.2：让 ToolProvider 构造期派生 effectivePolicyV3
      // 时也参与 effectiveMode 三方 AND（与主判决闭包口径一致）。
      isGroupSpace: isGroupSpace === true,
      emitStreamEvent,
      todoSessionAnchor,
      spaceId: runtimeSpaceId,
      projectId,
      apiBaseUrl: API_BASE_URL,
      apiAuthToken: initialToken,
      organizationId,
      toolResultStorage,
      agentToolDeps: {
        provider,
        resolveProviderForModel,
        permissionHandler,
        sessionConfig,
        model: modelId,
        // ：子 Agent 透传同一 untrusted 判定，避免父可子不可（fence 缺口）。
        isUntrustedShellCommand,
        budgetTracker,
        // 子 Agent 不暴露独立步数参数；只继承 Workspace Execution Limits 页面的
        // max_iterations_per_run。页面关闭 / 未配置时保持 undefined。
        maxChildTurns: effectiveChildMaxTurns,
        // W4a S1：透传 session 维度 SubagentManager，让 agent-tool 双写登记
        // active 子（模块级 activeChildren 仍保留给 W0 取消链路）。
        subagentManager,
        readFileState,
        // W2（2026-05-13）image / localDoc dedup 状态——子 Agent fork 时
        // 与 readFileState 同款 shallow clone（fork-query.ts 透传逻辑）。
        imageReadFileState,
        localDocReadFileState,
        // per-file 回退引擎：与下方 EngineConfig 共享同一实例，agent-tool fork 子
        // Agent 时把它透给子（forkQuery 共享不 clone），子改的文件进同一回退账本。
        fileHistory,
        workspaceRoot,
        toolResultStorage,
        // Phase 3：父值仅作「无目录 / 命不中」兜底——子 Agent 实际能力由 agent-tool
        // 按 childModel 从下方 modelCatalog 解析（不再无脑继承父能力，避免子 Agent
        // 套父大窗口跑崩）。无目录（冷启动 / 离线无缓存）时回落父值。
        contextWindowTokens: ctxWindow,
        maxOutputTokens: maxOutput,
        modelCapabilities: modelCaps,
        // Phase 3/4：注入「可用模型菜单」快照（主进程 HTTP 拉的 tier 过滤目录）。
        // agent 工具据此渲染清单 + 按子模型解析能力 + 命不中确定性降级。
        modelCatalog,
        subagentModelPolicy,
        previewChildModelFunding: ({ modelId, estimatedTokens }) =>
          this.previewChildModelFunding(organizationId, { modelId, estimatedTokens }),
        onModelRuntimeFailure: failure =>
          this.ports.refreshModelCatalogAfterRuntimeFailure(owner, failure),
        // W1-A: 子 agent 继承父 mode，保持工具过滤 + 受限模式软拒行为一致
        agentMode,
        //  Stage 2b：子 Agent system prompt 重烘焙经宿主端口，
        // runtime 不再直接 import @tabtin/agent-prompt。
        systemPromptProvider,
        // FR-17.2：子 Agent 完成时是否对 summary 做 microCompact（默认 true）。
        subagentResultCompact,
        // FR-15 (H3-A Review P1)：子 agent 透传同一份 iterationBudget，
        // 避免子级走默认而与父级宿主 env 配置脱锚。
        iterationBudget,
        // W0-3（2026-05-26 总控）：子 agent 透传同一份 toolFailureTracker 配置
        // ——与 Daemon 端 agentToolDeps.toolFailureTracker 对齐。原本 Electron
        // 端漏透此字段，子 Agent fork 时回落 createToolFailureTracker(process.env)，
        // 大多数情况下结果相同（同进程读同一份 env），但宿主显式注入更精准——
        // env unset 后回落默认的边界也按宿主版本生效。
        toolFailureTracker,
        // W0-2（2026-05-26 总控）：子 agent 透传父级 userInteractiveChannel
        // 引用。原本 Electron / Daemon 端 agentToolDeps 都漏透此字段，导致
        // forkQuery 内部走 `createSubagentUserInteractiveChannel(undefined, ...)`
        // 返回 undefined → 子 Agent 调 ask_user / 写授权等 judge ask 决策时
        // permissions/judge-pipeline.ts 走 fail-closed deny + 文案「no
        // UserInteractiveChannel is wired」，造成父对话能弹审批、子任务工具
        // 全自动拒绝的体验割裂。透传后由 `createSubagentUserInteractiveChannel`
        // 包装父 channel，注入「子 Agent 发起」标识到 askHint。
        userInteractiveChannel,
        //  Phase 1：readonly 子 Agent 的 mode-reminder 注入由宿主提供
        // （原 fork-query 硬编码 buildModeReminderHook 已迁到 agent-host/hooks）。
        // 只有 readonlySubagent=true 时 fork-query 才会调用它，注入 ask 模式 reminder。
        buildReadonlySubagentHooks: () =>
          buildModeReminderHook({ getAgentMode: () => 'ask' }),
        // FR-16 H3-B Review fix #7：子 agent 透传 reuse 配置，避免 A/B 测试时
        // 父开发者关掉 reuse 但子仍开启污染数据。
        enableSummaryReuse,
        summaryReuseJudgeSampleRate,
        summaryReuseJudgeWindowSize,
        summaryReuseJudgeThreshold,
        summaryReuseMaxAgeMs,
        summaryReuseMinAddedMessages,
        timeBasedMicroCompact,
        // ：子 Agent 继承同一份压缩分档阈值，父子触发线一致。
        pressureThresholds,
        // 统一审批 W0.2（B3）：把宿主的 waitForUserInput 透传给子 Agent
        // —— 与上方 EngineConfig.waitForUserInput / permissionHandler 共用同一闭包，
        // 共享 `pendingAskUserRequests` map。子 Agent 通过
        // `createSubagentWaitForUserInput(config.waitForUserInput)` 拿到包装函数
        // （挂起计数 + 超时兜底）而非抛错 stub，ask 用户工具能
        // 真正弹审批；undefined 透传则会回退到 stub 抛"requires user approval"。
        waitForUserInput,
        drainSubagentNotifications: async (subagentRunId) =>
          this.ports.drainThreadNotificationsText(subagentRunId, { allowMissingSession: true }),
        // Hilt v3 / W6 M1：透传 judge 三件套到子 Agent。
        //
        // 子 Agent forkQuery 时复用父级工厂闭包 —— 父 yolo / workspace 改动
        // 在父子两边的下一轮 runTools 入口都同步反映（共享同一 agentConfigV3
        // / workspaceSnapshotV3 引用）。memoStore 同实例共享 always memo，
        // 任一方点"一直允许"另一方下次自动放行。
        //
        // 路径权限治理 W7 / L1：把 agentMode 派生的 planModeGuardActive 也
        // 透进 EffectivePolicy —— judge() step 0 据此对 PLAN_TARGET_GUARDED_TOOLS
        // 直接 deny，不再依赖 orchestration pre-check 在 hasJudge=true 路径下
        // 是否跑（之前裸奔，LLM 可对任意 document_id 调 update）。
        //
        // YOLO 两步授权 PRD v3 §5.5.2 / §5.1.4：闭包同时透传 requestedAgentMode +
        // isGroupSpace 让 build-policy 派生 effectiveMode（三方 AND：requested='yolo'
        // && allow_yolo && !isGroupSpace）。`policyContext` 是宿主可变源，
        // handleQueryInternal 入口对其 mutate 后下一轮闭包调用即时反映 PD-13。
        //  Stage 3a：子 Agent 与父共享同一 ToolRiskPolicyPort。
        toolRiskPolicy,
        judgeHomeDir,
        //  Stage 4：子 Agent 按自身 agentMode 绑定 ToolGate / ask 标注。
        bindToolGate: (cfg) =>
          createAgentModesToolGate({
            getAgentMode: () => cfg.agentMode,
            getWorkspaceRoot: () => cfg.workspaceRoot,
          }),
        annotateReadonlyChildTools,
      },
      // W1-A: 让 ToolProvider 在 getTools() 末端按 mode 过滤工具集
      agentMode,
      sessionId,
      agentId,
      //  WP2 / ：与 MemoryHook 同口径——仅显式 true 才挂 memory_search/write。
      memoryEnabled: memoryCapability === true,
      // 本地 Skill 模块 Wave B · M3：skills_read / skills_search 依赖注入
      skillsDeps: skillsToolsDeps,
      // Wave 2b：skill_invoke / skill_create 依赖注入
      skillInvokeDeps,
      skillCreateDeps,
      // Wave 1.5：Skill 运行时密钥注入 resolver
      skillCredentialResolver: skillCredentialResolverHandle.resolver,
      // Phase 3 F5+F7+F12：switch_mode 工具的 proposal 注册中心
      modeSwitchProposalRegistry: this.ports.modeSwitchHandler.asProposalRegistry(),
      hostAgentToolDeps: {
        sessionConfig,
        flushParentMessageBlocks: () => sessionStorage.blockStorage.flushPendingWrites(),
        getTemplateSnapshots: () => this.loadSessionTemplateSnapshots(sessionId, runtimeSpaceId),
      } satisfies HostAgentToolDeps,
    })

    // customRules 由上游 `getOrCreateRuntime` 统一归一化（trim + 空字符串→undefined），
    // 这里直接信任传入值，避免重复规范化逻辑散在多处。
    // H1-E：走统一 telemetry API。敏感原文不进入埋点，只发 len + hash + has_* 衍生字段。
    emitTelemetryEvent(
      TelemetryEvents.PERSONA_APPLIED,
      {
        ...redactCustomRules(customRules),
      },
      { session_id: sessionId, agent_id: agentId ?? undefined },
    )

    // W1-A: 记录本 runtime 生效的 mode（每次 runtime 创建/重建发一次）。
    emitTelemetryEvent(
      TelemetryEvents.AGENT_MODE_APPLIED,
      { mode: agentMode, reason: 'created' },
      { session_id: sessionId, agent_id: agentId ?? undefined },
    )

    // M1.4 / : USER 画像按 (organization, agent) 并发拉取
    const organizationIdForPortrait = owner.organizationId || ''
    // ：旧 baked cliReference（loadCLIReferenceAsync）已下线——CLI 能力改由 CliCap
    // 两区注入（<cli_commands> 静态 + <relevant_cli> 动态）。这里保留画像 / 角色库 /
    //  模板快照（副作用填 map，解构位留空）三项并发拉取。
    const [userPortrait, subagentCatalog] = await Promise.all([
      // ：画像 per-Agent，必须带当前执行 agentId
      this.loadUserPortraitAsync(organizationIdForPortrait, agentId),
      // group 模式才拉角色库；其它模式 buildSystemPrompt 不注入 `<subagent_catalog>`。
      agentMode === 'group' ? this.loadSubagentCatalogAsync(runtimeSpaceId) : Promise.resolve([] as SubagentCatalogEntry[]),
      // 显式 template_id 是运行时能力，不是 group prompt catalog。非 group 的
      // Personal Space 也要填快照 map，否则 host 模板展开会静默退回 ad-hoc。
      runtimeSpaceId ? this.loadSubagentTemplatesFullAsync(runtimeSpaceId) : Promise.resolve([] as SubAgentTemplateSnapshot[]),
    ])

    //  Phase 2：group 模式读会话 group_runtime；激活时把 catalog（prompt 侧）
    // 与可解析模板（hostAgentToolDeps.getTemplateSnapshots，经 sessionGroupRoleIds）都收敛到本 session
    // 编制子集。未激活 → 清 session 编制，用 Space 全量。
    let effectiveSubagentCatalog = subagentCatalog
    if (agentMode === 'group') {
      const roleIds = await this.loadGroupRuntimeRoleIdsAsync(sessionId)
      if (roleIds && roleIds.size > 0) {
        effectiveSubagentCatalog = subagentCatalog.filter(c => !!c.templateId && roleIds.has(c.templateId))
      }
    } else {
      this.sessionGroupRoleIds.delete(sessionId)
    }

    // ── W2.3：先算"对 LLM 可见的工具集合"用于 buildSystemPrompt ──
    //
    // W2.3 之前 buildSystemPrompt 直接用 `toolProvider.getTools()` —— 但
    // 现行装配里 ShellCap 贡献 `run_terminal_command`、SkillsCap 贡献
    // skills_read/skills_search、FileSystemCap 只贡献目录工具；如果 system
    // prompt 仍按旧 ToolProvider 列名，LLM 第一回合会按旧命令工具名调用，
    // 但 EngineConfig.tools = mergedToolProvider 实际只注册 canonical 工具
    // —— 触发 unknown_tool fail-then-retry 链路。
    //
    // 修法：在装配 7 Cap 之前**先计算 capTools 名集合 + 过滤后的 oldTools**，
    // 让 buildSystemPrompt 拿到与 mergedToolProvider 一致的最终视图。
    // bind / hooks 装配仍留在 backendBootstrap 之后做（顺序不变）。
    //
    // 具体计算逻辑与下方 mergedToolProvider 同步——SSoT 写在这里，下方
    // 复用同一份 capTools / capToolNames / filtered old tools。
    const REPLACED_BY_CAPABILITY_NAMES = new Set<string>()
    if (skillsToolsDeps) {
      REPLACED_BY_CAPABILITY_NAMES.add('skills_read')
      REPLACED_BY_CAPABILITY_NAMES.add('skills_search')
    }
    // 临时实例化 ShellCap / FileSystemCap / SkillsCap 拿 tools()——这与
    // 下方真正的"装配 + bind"实例**不同实例**，但 tools() 是无状态查询
    // （Cap 的 tools 不依赖 session），所以 name + description 视图一致。
    // 实际 bind 后的 cap 实例在 backendBootstrap 段构造（下方）。
    //
    // ShellCap 接 PtyManagerBridge：bridge 已由 bridge-core.ts setupCoreAPIs
    // 在 PtyManager 单例就绪后注入（agent-bridge.ts L544-548 硬契约的
    // bootstrap 顺序：PtyManager 就绪 → setPtyManagerBridge → 装配 ShellCap）。
    // 缺失 → fail-fast throw（D6 决策：不留兼容性兜底；让本地 LLM 启动时
    // 就报错而非"工具静默缺失"）。
    const ptyBridge = resolvePtyManagerBridge()
    if (!ptyBridge) {
      throw new Error(
        'ElectronAgentHost: PtyManagerBridge not injected — bridge-core.ts ' +
          'setupCoreAPIs() must run before AgentHost.create() to satisfy ' +
          'agent-bridge.ts L544-548 bootstrap order',
      )
    }
    const previewShellCap = new ShellCap({
      ptyManagerBridge: ptyBridge,
      //  Stage 3c：硬红线由宿主注入，内核不再 import security-policy。
      checkHardlineCommand,
      //  RB2：per-runtime 业务身份烘进 ShellCap（凭据派生 / TABTIN_SPACE_ID
      // env / agentMeta.spaceId / agentId 读这里），不再从运行时 ToolContext 取。
      spaceId,
      agentId,
      organizationId,
      resolvePresentation: resolveCliToolPresentation,
      config: {
        operation_switches: operationSwitches as Record<string, 'allow' | 'confirm' | 'block'> | undefined,
      },
    })
    const previewFsCap = new FileSystemCap()
    const previewPlatformDataCap = new PlatformDataCap({
      archiveDir: sessionDir,
      toolLogsDir,
      archiveSessionId: businessThreadId,
      toolLogsSessionId: sessionId,
    })
    // previewSkillsCap 仅用于算 tools()——SkillsCap.tools() 不依赖 fetchSkills
    // （fetchSkills 在 hooks().beforeIteration 才被调）。所以不传 fetchSkills，
    // 真正的 SkillsCap 在下方装配段构造时再注入 promptSkillsFetch。
    const previewSkillsCap = skillsToolsDeps
      ? new SkillsCap({
          getSkill: skillsToolsDeps.getSkill,
          search: skillsToolsDeps.search,
        })
      : null
    const previewCapTools = [
      ...previewFsCap.tools(),
      ...previewPlatformDataCap.tools(),
      ...previewShellCap.tools(),
      ...(previewSkillsCap ? previewSkillsCap.tools() : []),
    ]
    const previewMergedToolNames = [
      ...previewCapTools.map((t) => ({ name: t.name, description: t.description })),
      ...toolProvider
        .getTools()
        .filter(
          (t) =>
            !REPLACED_BY_CAPABILITY_NAMES.has(t.name) &&
            !previewCapTools.some((c) => c.name === t.name),
        )
        .map((t) => ({ name: t.name, description: t.description })),
    ]

    // Runtime self-knowledge for `<runtime_identity>` block. Only emit when
    // the session is anchored to a real Space + Organization + workspace —
    // otherwise the section's archive paths would be misleading.
    const runtimeIdentity = (spaceId && organizationId && workspaceRoot)
      ? {
          organizationId,
          spaceId,
          // §17.6 D4：RuntimeIdentity.sessionId → threadId（业务对话 thread）。
          threadId: businessThreadId,
          // 来自 query payload 顶层（renderer 从 useSpaceStore.selectedSpace.name /
          // useOrganizationStore.selectedOrganization.name 注入）。缺省时 runtime_identity
          // 段退化为只显示 UUID。
          spaceName,
          organizationName,
          workspaceRoot,
          archiveDir: sessionDir,
          toolLogsDir,
        }
      : undefined

    // ：创建期「烘焙输入」组装一次——原来主 prompt / setSubagentSystemPrompt /
    // mode 热切换闭包 3 处各抄一遍字段的重复全部收敛到这里。每次构建才变的
    // mode / tools 交给 assembleSystemPrompt 作为变体；group-only 的
    // subagentCatalog 门控在装配器内统一处理，host 不再自判 `=== 'group'`。
    const promptBaked: BakedSystemPromptInputs = {
      //  / ：Agent + personal 自由文本都走 pre-user agent-profile；
      // assembleSystemPrompt 会清掉 system 中的长期自由文本。
      customRules: undefined,
      // 保留为创建期数据 / cache 对齐；不直接进入 system。
      personalRules,
      personalRulesPlacement: 'pre-user-context',
      // workspaceRoot / spaceId 顶层字段已下线（2026-05-14 runtime_identity
      // 拆分）；这两个事实由下方 runtimeIdentity 携带。
      // ：cliReference baked 字段下线，CLI 能力改由 CliCap 两区注入。
      // W7b M3 (PRD 真相 I5)：注入 `<agent_memory_capability>` 段，让 LLM 不再
      // 说"我没有记忆"，并能正确解释 context 中的 `<memory_*>` 块。
      memoryCapability,
      // work_mode：注入对应 `<work_mode>` 段（code/doc/mixed 的默认执行策略）。
      // 归一化后的 undefined → buildSystemPrompt 跳过段注入（旧行为兼容）。
      workingDirType,
      // M1.4 / : USER 画像 per-(Organization, Agent)（人设隔离 / 隐私 / 计费）。
      userPortrait: userPortrait ?? undefined,
      runtimeIdentity,
      // ：把实际使用的 shell（与 spawnAgentShellProcess 同源）注入
      // `<shell_runtime>` 段，避免 LLM 在 zsh 上误用 bash 专属语法、Windows 上套 POSIX。
      shellInfo: resolveAgentShellInfo(),
      // 当前 Space 启用的 App 能力图谱（renderer 透传）。
      // 装配到 `<apps>` 段——让 Agent 用 "多维表 / 文档 / ..." 这些显示名跟用户对话，
      // 同时知道每个 App 的能力（用户问"你能做什么"时有具体答案）。
      enabledApps,
      // group 模式：Space 可复用的子 Agent 角色库（main 自拉）。#2845：喂 session 编制
      // 收敛后的 effectiveSubagentCatalog；group-only 门控在 assembleSystemPrompt 装配器内。
      subagentCatalog: effectiveSubagentCatalog,
    }

    // ：轮内模式热切换用的 system prompt 重建闭包。捕获本次创建期已
    // 加载 / 计算好的全部烘焙输入，切换时只替换 agentMode + tools —— 保证除
    // `<agent_mode>` / `<tools_reference>` 外其余段逐字节不变，且不再重复异步加载。
    const buildSystemPromptForMode = (
      mode: AgentModeName,
      toolsForPrompt: Array<{ name: string; description: string }>,
    ): { systemPrompt: string; buildConfig: SystemPromptConfig } =>
      assembleSystemPrompt(promptBaked, { agentMode: mode, tools: toolsForPrompt })

    // 主 prompt 就是「当前 mode + 当前工具集」这一变体——直接复用闭包，不再另抄。
    const { systemPrompt, buildConfig: promptBuildConfig } = buildSystemPromptForMode(
      agentMode,
      previewMergedToolNames,
    )
    // readonly 子 Agent 重烘焙 ask prompt 用（以 buildConfig 为基，见 subagent-readonly.ts）
    toolProvider.setSubagentSystemPrompt(systemPrompt, promptBuildConfig)

    // Phase 3：扩成查目录任意模型（不只 session 模型）——子 Agent 选小窗口模型时
    // `resolveContextWindow(子模型)` 要返回子模型真实窗口，而非 session 大窗口 /
    // FALLBACK。优先 IPC → catalog → 本地 Codex SSoT → FALLBACK。
    const dynamicResolveContextWindow = (mid: string): number => {
      if (mid === modelId && modelContextWindow != null && modelContextWindow > 0) {
        return modelContextWindow
      }
      const hit = findCatalogEntry(modelCatalog, mid)
      if (hit && hit.capabilities.contextWindowTokens > 0) {
        return hit.capabilities.contextWindowTokens
      }
      if (isOpenAICodexModel(mid)) {
        return resolveOpenAICodexModelCapabilities(mid).contextWindowTokens
      }
      // ：catalog miss（session IPC 没值 + 目录快照不中）→ 回落 32k。此处经
      // `resolveContextWindow` 每 query 调一次，是大窗口子模型"按 32k 算 pressure /
      // blockingLimit"的真根因——去重 warn（每 mid 一次，catalog 刷新时清空）让回落
      // 可观测可诊断，而非静默误触发 blocking。
      const warningKey = `${catalogScopeKey}:${mid}`
      if (!this.ports.catalogFallbackWarned.has(warningKey)) {
        this.ports.catalogFallbackWarned.add(warningKey)
        log.warn(
          `[AgentHost] model "${mid}" not resolvable (IPC + catalog snapshot miss, ` +
          `snapshot size=${modelCatalog.length}) — falling back to ` +
          `contextWindowTokens=${FALLBACK_MODEL_CAPABILITIES.contextWindowTokens}. ` +
          `pressure/blocking will be computed against this fallback; if the real model ` +
          `has a larger window, expect premature compaction / blocking .`,
        )
      }
      return FALLBACK_MODEL_CAPABILITIES.contextWindowTokens
    }

    // FR-01 / FR-03 / FR-04 / FR-07 / FR-09: ops-facing knobs resolved
    // from env. Logged once per runtime creation so a malformed env only
    // warns once, not per query. The Runtime's own defaults (`'soft'` /
    // 1_000_000 / `'conservative'` / `'warn'` / `true`) kick in when env
    // is unset or invalid, so a clean install is unaffected.
    //
    // FR-07/09 接线说明：`toolSchemaValidation` 和 `toolOutputScan` 必须
    // 同时进 EngineConfig，引擎才能在 `query.ts` 把它们透传到 runTools。
    // 上一轮 H2-C 主体落地把 helper 接到了 host-knobs 但没接到
    // EngineConfig 字面量上（仅 import 未消费），导致 Electron 端配置
    // 完全不生效（Daemon 已正确接通）；这里补齐 cross-host parity。
    const doomLoopPolicy = resolveDoomLoopPolicy(process.env, log)
    const maxMessageChars = resolveMaxMessageChars(process.env, log)
    const normalizationLevel = resolveNormalizationLevel(process.env, log)
    const toolSchemaValidation = resolveToolSchemaValidation(process.env, log)
    const toolOutputScan = resolveToolOutputScan(process.env, log)
    // FR-15 / FR-16 H3-B: iterationBudget + 6 个 reuse knob 已在上方 toolProvider
    // 创建之前解析（让子 agent 透传），此处直接复用，避免父子在同一进程内对同一
    // env 二次解析（SSoT）。

    // Agent prompt Skills follow the same local runtime registry as
    // `skills_read` / `skills_search`. If the registry is temporarily
    // unavailable, omit `<skills>` for this turn instead of falling back to
    // Django's legacy `/skills/index` view.
    const promptSkillsFetch = async (ctx: { query?: string; focusedApp?: string | null; runId?: string }) => (
      fetchSkills ? fetchSkills(ctx) : null
    )

    // ── W1.2：装配 NativeBackendSession（feature flag 默认开）──
    //
    // W2.3 改：把 bootstrap 提前到 EngineConfig 装配之前——7 Capability
    // 实例化时需要 backendBootstrap.session 做 bind 入参，所以顺序变成：
    //   1. bootstrap session
    //   2. 实例化 + bind 7 Capability
    //   3. prepareAgentTools 把 Cap 工具贡献合并进 ToolProvider
    //   4. composeCapabilityHooks 出 capHooks
    //   5. config.hooks = composeHooks(capHooks, ...host-side-hooks)
    //
    // 关闭：bundle.session.shutdown() 由 host runtime rebuild 路径调用；
    // registry 在 host shutdown 时通过 backendRegistry.dispose() 清理。
    // C14 (2026-05-13)：第一次拿到 workspace root 时 init lsp-runtime singleton。
    // 后续 session 共享同一个 singleton；TABTIN_DISABLE_LSP=1 时 noop。
    // 失败不阻塞 runtime 创建（lsp-runtime 是可选增强，singleton 未 init 时
    // notifyLspAfterEdit / buildLspDiagnosticHook 都会静默 noop）。
    this.ensureLspInitialized(workspaceRoot)

    let backendBootstrap: NativeBackendBootstrapResult | null = null
    if (agentId && isNativeBackendSessionEnabled()) {
      try {
        if (!this.backendRegistry) {
          this.backendRegistry = new ExecutionBackendRegistry()
        }
        backendBootstrap = await bootstrapNativeBackend({
          sessionId,
          agentId,
          workspaceRoot,
          registry: this.backendRegistry,
        })
        log.debug(
          `[NativeBackendSession] bootstrapped agentId=${agentId.slice(0, 8)}… ` +
            `home=${backendBootstrap.session.agentHome.scratchpad}`,
        )
      } catch (err) {
        // 装配失败不阻塞 runtime 创建；老路径（PtyManager / FrontendActionBridge）
        // 完全不依赖 backendBootstrap，仅 W2 Capability 在 backendBootstrap===null
        // 时应优雅降级。记录错误但不抛。
        log.warn(
          `[NativeBackendSession] bootstrap failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    } else if (!agentId) {
      // W4.1（dogfood fix）：之前用 log.debug 静默走过——ELECTRON_VERBOSE 默认
      // 不开启时这条 debug 日志被吞掉，用户跟工程师都不知道 7 Capability 没接
      // 通；唯一线索是工具调用时撞 "capability not bound"，回溯 5 层栈才能查
      // 到根因。改成 warn + 完整文案：
      //   - 主因（Renderer 漏传 agentId）
      //   - 后果（7 Cap 全部 bind 失败）
      //   - 修复指引（Renderer 必须传 selectedAgent.id）
      // 这是给工程师看的诊断信息，和 ensureSession 给 LLM 的"capability not bound"
      // 文案分工：前者诊断装配错配，后者帮 LLM 自我恢复（详见
      // capability/core/_utils.ts:ensureSession）。
      log.warn(
        '[NativeBackendSession] skipped: missing agentId — 7 Capability cannot bind to BackendSession, ' +
          'all FileSystem/Shell tool calls will fail with "capability not bound". ' +
          'Renderer must pass selectedAgent.id in IPC payload (see localAgentClient.LocalAgentStreamOptions.agentId).',
      )
    } else if (!isNativeBackendSessionEnabled()) {
      // W4.1：feature flag opt-out 路径——也别静默。运维 / 自动化测试如果显式
      // 关掉 TABTIN_NATIVE_BACKEND_SESSION 然后又奇怪 Capability 不工作，看到
      // 这行 warn 立刻知道是自己关掉的开关。
      log.warn(
        '[NativeBackendSession] skipped: TABTIN_NATIVE_BACKEND_SESSION env disables it (feature flag opt-out). ' +
          '7 Capability will not bind. Set env to enabled / 1 / on to restore.',
      )
    }

    // ── 实例化 5 Capability ──
    //
    // 历史上 7 Capability：TabDataCap (Wave 4a 2026-05-01 退役) +
    // TabDocCap (Wave 12 2026-05-04 退役)；产品方向：内置 App 的 Agent 操作
    // 主要靠 CLI（`tabtin table *` / `tabtin doc *`），不依赖 FC。剩 5 件：
    //
    //   - FileSystemCap：目录工具 list_directory / mkdir；文件读写删由
    //     TabCode adapter/action-tools 的 read_file / write_file /
    //     edit_file / delete_file 承担。
    //   - ShellCap：现行命令工具 run_terminal_command；宿主注入 hardline checker
    //     做硬红线兜底；接 SkillContextProvider 做凭据注入 + 脱敏；接
    //     emitStreamEvent 发 SYSTEM_NOTICE 中文文案
    //   - SkillsCap：skills_search / skills_read 取代 ToolProvider 老
    //     `createSkillsTools` 路径；hooks().beforeIteration 写
    //     state.__skillsHint（与原 createSkillsAndNotes 行为 100% 对齐）
    //   - AuditCap：W2.2.3 takeaway —— writer = undefined → hooks() 返回 null
    //     no-op（给后续专题落地真 writer 留 escape hatch）
    //   - CostCap：token / credit 预算判定读 state 扁平字段（engine 的
    //     syncStateFromTracker 已写成本 run 增量，含子 Agent，）
    //
    // 工具贡献规则（避免与旧 ToolProvider 双重注册）：
    //   - 进 prepareAgentTools 的：FileSystemCap / ShellCap / SkillsCap
    //     （2+1+2 = 5 件 LLM 可见的 capability 工具）
    //   - 不进 prepareAgentTools 的：AuditCap / CostCap（hooks-only 模板
    //     天然不贡献工具）
    //   - 旧 ToolProvider getTools() 在 wrapper 里 filter 掉被 Cap 接管的
    //     旧命令工具名与 skills_read / skills_search—— 保留剩余 N 件套

    // SkillContextProvider 包装：宿主已有 createSkillCredentialResolver
    // 派生的 resolver；Cap 形态 = 把 resolver 装到一个对象方法里
    const skillContextProvider: SkillContextProvider = {
      resolveCredentials: (params, signal) =>
        skillCredentialResolverHandle.resolver(params, signal),
    }

    const fileSystemCap = new FileSystemCap()
    const platformDataCap = new PlatformDataCap({
      archiveDir: sessionDir,
      toolLogsDir,
      archiveSessionId: businessThreadId,
      toolLogsSessionId: sessionId,
    })

    // ── L16 W5.5：受限模式下注入 input 级 shell 白名单 checker ──
    //
    // Plan/Ask/Study 模式装配 ShellCap 时附带 `restrictedShellChecker`，让
    // `run_terminal_command.execute` 入口对命令字符串做白名单检查（仅放行
    // tabtin 已注册的 RiskNone 子命令）。Agent / Group 模式不传 → 不限制。
    //
    // checker 的 fetchCommandRisk 实现：调本地 tabtin 拉 schema 列表
    //   → 用 `@tabtin/agent-runtime/capability/buildRiskMapFromSchemas`
    //     压成 Map<fullName, riskString>
    //   → checker 内部按子命令 path 查 Map
    //
    // 短 TTL 缓存（30s，见 CLI_RISK_MAP_TTL_MS）避免每次命令都 spawn 子进程；缓存失败回落到 lookupFailed
    // → 受限模式 fail-close 拒绝（safety > 可用性，错的代价是 LLM 多换条命令）。
    const restrictedShellChecker = this.buildRestrictedShellChecker(agentMode, workspaceRoot)

    // ShellCap 真装配：复用 preview 段已断言非空的 ptyBridge（fail-fast 在
    // 上方完成，此处直接构造，不再做 null 检查 / 包装）。
    const shellCap = new ShellCap({
      ptyManagerBridge: ptyBridge,
      //  Stage 3c：硬红线由宿主注入，内核不再 import security-policy。
      checkHardlineCommand,
      //  RB2：per-runtime 业务身份烘进 ShellCap（凭据派生 / TABTIN_SPACE_ID
      // env / agentMeta.spaceId / agentId 读这里），不再从运行时 ToolContext 取。
      spaceId,
      agentId,
      organizationId,
      config: {
        operation_switches: operationSwitches as Record<string, 'allow' | 'confirm' | 'block'> | undefined,
      },
      // 外层 v3 judge() 负责 confirm/allow；此处硬红线为不可绕过兜底。
      skillContextProvider,
      emitStreamEvent,
      restrictedShellChecker,
      resolvePresentation: resolveCliToolPresentation,
    })
    // SkillsCap 必须有 getSkill / search 才能注册——否则不装配（保留老
    // ToolProvider skills_read / skills_search 走 createSkillsTools 路径）
    const skillsCap = skillsToolsDeps
      ? new SkillsCap({
          beginRun: beginSkillRun,
          endRun: endSkillRun,
          fetchSkills: promptSkillsFetch,
          getSkill: skillsToolsDeps.getSkill,
          search: skillsToolsDeps.search,
          listSkillResources: skillsToolsDeps.listSkillResources,
          readSkillResource: skillsToolsDeps.readSkillResource,
          contextWindowTokens: ctxWindow,
        })
      : null
    // McpCap：把当前会话 Agent 已启用的 MCP server 名单 +
    // 与本轮 query 相关的工具主动注入上下文。fetcher 自带 Agent 级缓存 + TTL + 抗抖动。
    // hooks-only（不贡献 FC 工具——mcp_call_tool 仍由 ToolProvider 提供）。
    //  双路召回：MCP / CLI 动态段叠加本地语义路（就绪前自动词法单路）。
    const semanticScorer = getSemanticScorer()
    const mcpCap = new McpCap({ fetchMcp: createMcpListingFetcher(agentId), contextWindowTokens: ctxWindow, semanticScorer })
    // CliCap：把 tabtin CLI 命令树静态（<cli_commands>）+ 动态（<relevant_cli>）
    // 注入上下文。取代空掉的 baked cliReference（旧 loadCLIReferenceAsync 已下线）。hooks-only。
    const cliCap = new CliCap({ fetchCli: createGatedCliListingFetcher(organizationId), contextWindowTokens: ctxWindow, semanticScorer })
    const auditCap = new AuditCap({
      writer: createRelayAuditWriter(emitStreamEvent),
      level: 'standard',
    })
    // 双端 SSoT：`buildCostCapConfig`（`@tabtin/agent-host/runtime`）统一
    // v2 execution_limits 归一 + CostCapInit shape 组合。上方 `normalizedCostLimits`
    // 仍保留作 `agentConfigV3.capabilities.overrides.cost.execution_limits` 的
    // baked 字段（policy-context 读），本处装配 CostCap 用 helper 走同一份归一
    // 规则，避免漂移。
    // CostCap 不再直接读 BudgetTracker：预算判定走 state 扁平字段（已由
    // engine 的 syncStateFromTracker 写成本 run 增量，含子 Agent 累计，）。
    const costCap = new CostCap(buildCostCapConfig({
      executionLimits,
      contextWindowTokens: ctxWindow,
      resolveContextWindow: dynamicResolveContextWindow,
    }))

    const allCaps = [fileSystemCap, platformDataCap, shellCap, ...(skillsCap ? [skillsCap] : []), mcpCap, cliCap, auditCap, costCap]
    // bind 顺序：依次给每个 Cap 注入 backendBootstrap.session，让 Cap.tools
    // execute 时能拿到 session.exec / read / write 调用。bootstrap 失败时
    // session 为 null —— Cap 仍可装配（不抛错），但 tools execute 会
    // ensureSession 拒绝（明确 fail-fast）
    if (backendBootstrap?.session) {
      for (const cap of allCaps) {
        await cap.bind(backendBootstrap.session)
      }
    }

    // 工具贡献：装配 fileSystem / platform-data / shell / skills
    // （AuditCap/CostCap hooks-only 不贡献工具）
    const toolContributingCaps = [fileSystemCap, platformDataCap, shellCap, ...(skillsCap ? [skillsCap] : [])]
    const { tools: capTools } = prepareAgentTools(toolContributingCaps)
    const capToolNames = new Set(capTools.map((t) => t.name))
    // 永久剔除清单：旧命令工具名已被 ShellCap.run_terminal_command 取代；skills_read /
    // skills_search 已被 SkillsCap 取代（如果 SkillsCap 装配成功）
    const REPLACED_BY_CAPABILITY = new Set<string>()
    if (skillsCap) {
      REPLACED_BY_CAPABILITY.add('skills_read')
      REPLACED_BY_CAPABILITY.add('skills_search')
    }
    const allRemovedToolNames = new Set<string>([...REPLACED_BY_CAPABILITY, ...capToolNames])
    const mergedToolProvider: RuntimeToolProvider = {
      getTools: () => {
        const old = toolProvider.getTools().filter((t) => !allRemovedToolNames.has(t.name))
        return [...capTools, ...old]
      },
      refreshTools: toolProvider.refreshTools?.bind(toolProvider),
    }
    // 子 Agent fork 工具集修复：把含 Cap 工具（尤其 ShellCap.run_terminal_command）
    // 的 mergedToolProvider 回注给 ToolProvider，让 `agent` 工具 fork 子 Agent 时
    // 继承与主 Agent 一致的完整工具集。否则子 Agent 走裸 provider 缺
    // run_terminal_command，CLI-first 下无法执行任何 tabtin 命令。
    toolProvider.setSubagentToolProvider(mergedToolProvider)

    const capHooks = composeCapabilityHooks(allCaps)

    // ── v3 judge() 装配 + UserInteractiveChannel HITL 通道 ─────────────
    //
    //   - 真正的判决从下方 `EngineConfig.buildJudgePolicy` 注入的 v3
    //     `judge()` 出（PD-13：每轮 runTools 入口由工厂闭包派生
    //     `EffectivePolicy`，闭包持有 `agentConfigV3` / `workspaceSnapshotV3`
    //     可变引用，保证 yolo 切换 / 工作区变化下一轮立即生效）。
    //
    //   - 子 Agent 透传（W6 M2）：fork-query 路径通过
    //     `agentToolDeps.{buildJudgePolicy,judgeMemoStore,judgeHomeDir}` 把 v3
    //     judge 三件套透传给子 Agent —— 父 yolo / 工作区改动通过共享的
    //     `agentConfigV3` / `workspaceSnapshotV3` 同源引用立即被子 Agent
    //     工厂闭包看到。
    //
    //   - batch HITL 通道：UserInteractiveChannel.requestApprovalsBatch →
    //     LocalPermissionHandler.requestPermissionsBatch（v0.4 W1.5 协议）；
    //     judge ask 路径走这条通道，保证 UX 一致 + 批量场景 N>1 只发一张
    //     审批卡片。
    //
    //   - memo store 共享：permissionMemoStore 在 permissionHandler 创建前
    //     装配（让 batch decision 回灌路径能写入）；下方
    //     `EngineConfig.judgeMemoStore` 直接复用同一引用，保证 v3 judge step 2
    //     read 与 batch resolve 写共享同一份缓存。

    const config: EngineConfig = {
      provider,
      tools: mergedToolProvider,
      permissionHandler,
      sessionConfig,
      businessThreadId,
      model: modelId,
      systemPrompt,
      // ：tabtin fetch/browser 输出算外部不可信字节的判定由宿主注入，
      // core 默认不因 shell 命令判 untrusted。漏注入 = 注入防护被绕过（P0）。
      isUntrustedShellCommand,
      emitStreamEvent,
      eventEmitter: runtimeEventEmitter,
      waitForUserInput,
      runtimeMode: () => getRuntimeInteractionMode(sessionId) ?? 'interactive',
      budgetTracker,
      toolResultStorage,
      resolveContextWindow: dynamicResolveContextWindow,
      contextWindowTokens: ctxWindow,
      maxOutputTokens: maxOutput,
      modelCapabilities: modelCaps,
      // 子 Agent 模型自由度（Phase 3/4）：目录快照一等运行时输入（文档化锚点；
      // agent 工具实际经 agentToolDeps.modelCatalog 读取，同源）。
      modelCatalog,
      workspaceRoot,
      // **W2.1 收尾（2026-05-13 Review 3 fix-8）**：复用上方提前 new 的同款
      // const 引用（agentToolDeps 也用同一份），让"父 runtime → fork 子 Agent"
      // 共享 dedup state。旧实现 EngineConfig 又 `new Map()` 出三份独立 Map，
      // 主 query 写到 EngineConfig 那份，agent-tool fork 子 Agent 时却从
      // agentToolDeps 那份**永远空的 Map** clone → 子 Agent 拿到空 dedup state，
      // "父→子继承"完全失效。L4234-4239 的注释明示"必须共享同一引用"，但
      // 上一波 Wave 1 实施时只覆盖了 readFileState，imageReadFileState /
      // localDocReadFileState 在 W2 引入时沿用了同款错误模式。现在统一修复。
      readFileState,
      imageReadFileState,
      localDocReadFileState,
      // per-file 回退引擎（替代 shadow git）：query 主循环每轮 beginSnapshot(runId)、
      // 写文件工具写盘前 trackEdit。与 agentToolDeps 共享同一 per-thread 实例。
      fileHistory,
      fallbackChain: buildModelFallbackChain(modelId),
      // 受限模式（plan / study / ask）拦截统一走 judge step 0 SSoT：runTools /
      // pre-start 路径读 `config.agentMode` 判定，`isPlanModeGuardActive` 短路
      // agent / group；judge step 0 另读 `policy.planModeGuardActive` 硬兜底。
      // ：legacy planModeGuard 实例已删除。
      agentMode,
      //  Stage 2c：end_turn 待办收尾文案由宿主注入（与 agentToolDeps 同实例）。
      todoCompletionNudgeProvider,
      userInteractiveChannel,
      // PD-13：每轮 runTools 入口由本工厂闭包从最新可变源派生 EffectivePolicy。
      // 闭包持有 agentConfigV3 / workspaceSnapshotV3 / policyContext 引用，
      // handleQueryInternal 入口的 mutate（yolo 切换 / agent_mode 切换）以及
      // IPC `workspace:paths-changed` 的就地改写都能在下一轮工具调度时立即反映。
      //
      // 路径权限治理 W7 / L1：把 agentMode 派生的 planModeGuardActive 也
      // 透进 EffectivePolicy（详见上方 agentToolDeps.buildJudgePolicy 注释）。
      //
      // YOLO 两步授权 PRD v3 §5.5.2：闭包透传 requestedAgentMode + isGroupSpace
      // 让 build-policy 派生 effectiveMode（三方 AND）。
      // ：审批档只读取权威 Workspace approval_grant；消息体
      // approval_mode 仅作为旧 wire 字段保留，不再进入判决。
      //  Stage 3a：主循环经 ToolRiskPolicyPort 判决。
      toolRiskPolicy,
      judgeHomeDir,
      //  Stage 4：产品模式策略经 ToolGate 注入（读写本 config.agentMode）。
      bindToolGate: (cfg) =>
        createAgentModesToolGate({
          getAgentMode: () => cfg.agentMode,
          getWorkspaceRoot: () => cfg.workspaceRoot,
        }),
      annotateReadonlyChildTools,
      onOSAccessError: notifyHostOsAccessError,
      doomLoopPolicy,
      maxMessageChars,
      normalizationLevel,
      toolSchemaValidation,
      toolOutputScan,
      iterationBudget,
      // W3 stall detector：host-knobs 解析后的 thresholds + enabled 透传到 runtime。
      toolFailureTracker,
      // FR-16 H3-B：reuse 总开关 + 5 个细粒度 judge knob（H3-B Review fix）。
      enableSummaryReuse,
      summaryReuseJudgeSampleRate,
      summaryReuseJudgeWindowSize,
      summaryReuseJudgeThreshold,
      summaryReuseMaxAgeMs,
      summaryReuseMinAddedMessages,
      timeBasedMicroCompact,
      //  第一波：压缩分档阈值（undefined → runtime 默认）。
      pressureThresholds,
      // Host-only 字段（引擎不读）；relay / managed-task 持久化仍使用该开关。
      syncPersistence: this.ports.syncPersistenceEnabled,
      // FR-17.1 / FR-17.2：把 host-knobs 解析后的子 Agent 治理参数也写入
      // EngineConfig SSoT。引擎主循环本身不读这两个字段——真正生效的位置
      // 是上方 `new BudgetTracker({ maxConcurrentChildren })` 和
      // `agentToolDeps.subagentResultCompact`。但写到 EngineConfig 让
      // `getOrCreateRuntime` / 调试断言 / 未来 Hook 能从单一处读取实际生效值。
      maxConcurrentChildren,
      maxSubagentQueue,
      subagentResultCompact,
      // Wave 5a (L-W4-1)：让 agent-runtime 在每轮 ReAct loop 起始处通过此
      // callback 拉"自上次以来新增的相关 observation"注入 LLM 上下文，让
      // Agent 能感知主进程异步触发的 autofill 失败 / Space env 切换事件。
      // 子 Agent（forkQuery）默认不继承（PRD §Story 5：父 RunSession 不
      // 应串扰子任务）。
      getRecentRunObservations: runObservationInjectorHandle.injector,
      // ：后台任务完成「turn 内注入」。让 agent-runtime 在当前 turn
      // 还在循环时，每轮迭代边界 drain 该 thread 的后台完成通知拼成注入文本，
      // 使 Agent 当轮即可见并响应，而非等整轮结束靠 _tryDrain 另起 push turn。
      // 与 _tryDrain 消费同一 NotificationQueue，互斥零重复。子 Agent 不继承。
      drainThreadNotifications: async () => this.ports.drainThreadNotificationsText(sessionId),
      //  / ：仅斜杠直链 force 刷新；普通 fetchSkills 尊重 TTL。
      refreshSkillEnablementForSlash: agentSkillEnablement
        ? async () => {
            await agentSkillEnablement.refresh({ force: true })
          }
        : undefined,
      hooks: composeHooks(
        capHooks,
        buildWorktreeRoutingHook({ workingDirType }),
        this.ports.agentWorktreeLifecycleHook ?? {},
        // ：run_terminal_command 完成后识别 browser/table/oss 并发交付物卡。
        createTerminalArtifactCardHook(),
        // ：成功的 edit/write/delete 冻结补丁落入本机 jsonl，不进后端。
        createFileEditPatchPersistHook({
          resolveThreadId: () => sessionId,
          persist: async ({ threadId, toolUseId, patch }) => {
            log.debug('[DEBUG-code-diff-review] persist editor patch', {
              threadId,
              toolUseId,
              toolName: patch.toolName,
              relativePath: patch.relativePath,
              status: patch.status,
              codeRootPath: workspaceRoot,
            })
            await recordFileEditPatch({
              threadId,
              toolUseId,
              codeRootPath: workspaceRoot,
              patch,
            })
          },
        }),
        // 引擎层 host hook —— 每轮 LLM 前注入 Tab/App context
        buildContextHook({
          // ：每轮把 runtime modelId 并入 environment，避免 Agent 自述读成 preferred。
          getAppContext: async () => {
            const session = this.ports.sessions.get(sessionId)
            if (!session) return null
            const modelId = typeof session.modelId === 'string' ? session.modelId.trim() : ''
            const catalogHit = modelId
              ? findCatalogEntry(modelCatalog, modelId)
              : undefined
            const codexHit = modelId && isOpenAICodexModel(modelId)
              ? OPENAI_CODEX_MODELS.find((m) => m.id === modelId)
              : undefined
            const displayName =
              catalogHit?.displayName
              ?? codexHit?.displayName
              ?? (modelId || null)
            const base = session.appContext
            if (!base && !modelId) return null
            return {
              ...(base ?? {}),
              currentModelId: modelId || null,
              currentModelDisplayName: displayName,
            }
          },
          // ：App 详情段（按 appType 渲染产品字段 + CLI 配方）由宿主 formatter 注入。
          formatAppMeta: createAppMetaFormatter(),
          // ：相关召回块（`<relevant_*>`）已迁出到 buildRelevantRecallHook
          // （见下方），本 hook 只注入环境快照。
        }),
        // Project Task 的 project/task ID 是系统结构化上下文，不混入 renderer
        // 可见的 environment user context；仅完整 task execution context 才注入。
        buildProjectTaskContextHook({
          getAppContext: async () => this.ports.sessions.get(sessionId)?.appContext ?? null,
          // Project Task 是强工作流，不依赖语义召回是否把 Skill 排进 top-k。
          // 仅已验证的 task execution context 才读取并注入完整正文。
          getProjectTaskSkillContent: async () => (
            hostRef.skillsModule?.registry
              .getByKey('app:tabtin-project/tabtin-project')
              ?.content ?? null
          ),
        }),
        // Memory v2 阶段 3（M3，2026-05-21 拍板）：每轮 LLM 前从 TabMemo
        // HTTP API 召回相关 memo 注入 `<memory_recall>` 段，紧挨 `<context>` 之后。
        //
        // 装配语义：
        //   - enabled = memoryCapability（renderer 透传的 agent_config.memory.enabled）
        //   - injection.auto_inject：未上线 UI 暴露前 hardcoded `true`（spec §4 Hardcoded 默认）。
        //     待 UI 拉出 auto_inject 控件后改成读 IPC 字段。
        //   - organizationId / agentId 从可信执行上下文拿，
        //     auth token 现拉（与 dataTools / portrait fetcher 同源）
        buildMemoryHook({
          fetchAgentConfig: () => ({
            enabled: memoryCapability === true,
            injection: { auto_inject: true },
          }),
          fetchMemories: async (query, limit) => {
            const token = await TokenManager.getAccessToken()
            if (!token) return []
            return callMemorySearchAPI(
              {
                apiBaseUrl: API_BASE_URL,
                apiAuthToken: token,
                organizationId,
                agentId,
              },
              {
                query,
                limit,
              },
            )
          },
        }),
        //  / ：Agent 档案 + personal_rules 合成同一 user context，
        // 贴当前真实 user 前。Agent 档案每轮可切；personalRules 已在 cache key，
        // 变更时 runtime 重建并让本闭包读取新 session。
        buildAgentProfileHook({
          getAgentProfile: async () => this.ports.sessions.get(sessionId)?.agentProfile ?? null,
          getPersonalRules: async () => this.ports.sessions.get(sessionId)?.personalRules,
        }),
        // C14 (2026-05-13)：LSP 诊断 attachment 注入
        //
        // 时序：
        //   1. session 第一次创建时 ensureLspInitialized 用当前 workspace root
        //      init lsp-runtime singleton（已经在下面 createRuntimeForSession 末尾调）
        //   2. session edit_file/write_file 时 tabcode-adapter 内 notifyLspAfterEdit
        //      通知 LSP server didChange/didSave（fire-and-forget）
        //   3. LSP server 异步算诊断 → publishDiagnostics → registry pending
        //   4. 下一轮 LLM 前 buildLspDiagnosticHook 取出 + 包成
        //      <system-reminder><new-diagnostics>...</new-diagnostics></system-reminder>
        //      user message 注入到 messages
        //
        // 守门员（C10）：检查当前 session 工具白名单是否含 `run_terminal_command`
        //   —— 没有就不推（"能修才推"）。从 toolProvider.getTools() 查找。
        //
        // mainThread（C11）：fork-query 路径会用不同 host 装配（非这条），
        //   所以这个 hook 默认 isMainThread=true，sub-agent 不会接到本 hook。
        buildLspDiagnosticHook({
          hasShellTool: () => {
            try {
              // 当前 session 工具白名单是否含 run_terminal_command
              return toolProvider
                .getTools()
                .some((t) => t.name === 'run_terminal_command')
            } catch {
              return false
            }
          },
          isMainThread: true,
        }),
        // Phase 2：ask/plan 每轮 sparse mode reminder（D5 per-turn 默认）
        buildModeReminderHook({
          getAgentMode: () => policyContext.currentAgentMode,
          getPendingModeTransition: () =>
            this.ports.sessions.get(sessionId)?.pendingModeTransition,
          clearPendingModeTransition: () => {
            const s = this.ports.sessions.get(sessionId)
            if (s) s.pendingModeTransition = undefined
          },
          // ：本地 plan 落文件后，per-turn reminder 带上当前 plan 文件相对路径，
          // 让模型知道「继续修订同一份 plan」的目标文件（file 载体才有值）。
          getActivePlanFilePath: () => getActivePlanFilePath(sessionId) ?? undefined,
        }),
        // ：每轮注入活跃待办快照 + end_turn 完成度 gate（仅 agent mode）
        buildTodoStateHook({
          getAgentMode: () => policyContext.currentAgentMode,
          sessionAnchor: todoSessionAnchor,
        }),
        // ：每轮注入相关能力召回块（`<relevant_*>`）。从 context-injector 拆出，
        // 让召回随 in_progress todo 推进刷新（三个 cap 的 beforeIteration 已重算）。
        // 排在 todo-state 之后：cap beforeIteration（capHooks 在前）先刷新 getRelevantBlock()，
        // 且注入点落在 context / memory / active-todos 块之后、贴当前 user 前。
        buildRelevantRecallHook({
          getRelevantContextBlocks: (state) => [
            skillsCap?.getRelevantBlock(state),
            mcpCap.getRelevantBlock(),
            cliCap.getRelevantBlock(),
          ],
        }),
        // 持久化 assistant 消息（保留 inline，不抽 helper —— 与 sessionStorage
        // 闭包绑定，单独抽出反而模糊）
        {
          afterIteration: async (ctx) => {
            const last = ctx.state.messages.at(-1)
            if (last?.role === 'assistant') {
              await sessionStorage.recordAssistantMessage(last)
            }
          },
        },
        // 项目规则自动加载（AGENTS.md MVP，PRD §4.3 / B3）：每轮 LLM 前从
        // working_dir 根部 AGENTS.md 读到"项目规约"注入 messages 最前，与
        // custom_rules 并存。
        //
        // **必须放 composeHooks 数组末位**：composeHooks 同名钩子按数组顺序
        // 串行 await，本 hook beforeIteration unshift 到 messages[0]，末位执行
        // → 稳定占 messages[0]，得 [project_rules, context, memory_recall, ...]
        // （规约在最前，每轮变化的环境 / 召回在其后）。
        //
        // 读盘走 readProjectRules（mtime 缓存 + 截断），workspaceRoot 为本次
        // runtime 创建时快照的值——hook 本体不碰 fs。
        buildRulesHook({
          fetchProjectRules: () => readProjectRules(workspaceRoot),
          onInjected: ({ chars, truncated }) => {
            log.debug(
              `[rules-injector] injected project_rules from ${workspaceRoot}/AGENTS.md, ${chars} chars (truncated=${truncated})`,
            )
          },
        }),
      ),
      skillActivation: skillInvokeDeps ? createSkillActivation(skillInvokeDeps) : undefined,
    }

    // W4a S3（PR2）：把当前 runtime 的 live 依赖灌进 Manager（含 carry-forward
    // 复用的旧 Manager）。后台子 outlive 父 turn / resume 子在新 turn 时，经
    // Manager.resolveLiveDeps 取这份活体依赖构造 forkQuery，而非 spawn 快照——
    // 否则后台子的 HITL 落 fail-closed deny、judge 用过期 yolo 快照（plan 第六节）。
    // 同时刷新 enqueueNotification（reuse 旧 Manager 跨重建时保持完成句柄最新）。
    // emitStreamEvent 用 HostState 上的 sink（活体），与 EngineConfig.emitStreamEvent
    // 同源。
    const liveDeps: SubagentLiveDeps = {
      emitStreamEvent,
      budgetTracker: config.budgetTracker,
      userInteractiveChannel: config.userInteractiveChannel,
      waitForUserInput: config.waitForUserInput,
      toolRiskPolicy: config.toolRiskPolicy,
      workspaceRoot: config.workspaceRoot,
      osErrorBlacklist: config.osErrorBlacklist,
    }
    subagentManager.rebindLiveDeps(liveDeps, enqueueSubagentCompletion)

    // W4b：崩溃残留子 Agent 收口（orphan reaper）。进程崩溃 / 强杀会让正在跑的子
    // 只写了 started 没写 ended，重启后这些孤儿在 foldSubagentRuns 下永远是 running。
    // 这里趁 runtime 装配完成、本 session 的 SubagentManager 就绪后，把进程已死的
    // 孤儿 reconcile 成 cancelled——判活用 `manager.has(childId)`（内存登记态）：
    //   - 首建时 manager 空 → 所有孤儿被收口；
    //   - carry-forward 复用 / 本进程后台子在跑时 → `has===true` 保护，绝不误杀。
    // fire-and-forget + 日志：reap 内部已 best-effort（失败不抛），这里不 await，
    // 不阻塞 runtime 返回。
    void reapOrphanedSubagentRuns(sessionDir, sessionId, (childId) =>
      subagentManager.has(childId),
    )
      .then((reconciled) => {
        if (reconciled > 0) {
          log.info(`[subagent-reaper] reconciled ${reconciled} orphaned subagent run(s) for session ${sessionId}`)
        }
      })
      .catch((err) => {
        log.warn(`[subagent-reaper] failed for session ${sessionId}`, err)
      })

    return {
      runtime: createRuntime(config),
      sessionStorage,
      snapshotStorage,
      eventStorage,
      toolLogWriter,
      toolProvider,
      // ：透出 ShellCap 实例 + 模式重建闭包，getOrCreateRuntime 写入
      // HostState，供 reconfigureSessionModeInPlace 轮内热换 shell 档位 / 重建 prompt。
      shellCap,
      buildSystemPromptForMode,
      engineConfig: config,
      skillCredentialResolverHandle,
      backendBootstrap,
      // W4a S1：把 SubagentManager 透出去——getOrCreateRuntime 写入 HostState，
      // host.stop() / runtime 重建时 dispose 只取消本 session 的子。
      subagentManager,
      // W4a S2：把 session 级 subagentStreamSink 透出去 → 写入 HostState（跨
      // query 存活），让后续 PR 的后台子 / resume 子能从 HostState 拿到 / 重绑它。
      subagentStreamSink,
      eventEmitter: runtimeEventEmitter,
      // bf454d821 漏传修复（dogfood 4eb4a2f2 第二轮）：getOrCreateRuntime 写
      // HostState.workspaceSnapshot 时引用本字段，必须通过返回值传出去，否则
      // 撞 `workspaceSnapshotV3 is not defined` ReferenceError。
      workspaceSnapshotV3,
      // Hilt v3 / W6 M1：把 AgentConfigV3 传出去 —— getOrCreateRuntime 写
      // HostState.agentConfigV3，让 handleQueryInternal 能 mutate yolo_mode
      // 让 PD-13 工厂闭包当下读到新值。
      agentConfigV3,
      // YOLO 两步授权 PRD v3 §5.5.2：同款"可变源透出"，让 handleQueryInternal
      // 入口 mutate `currentAgentMode` 让 PD-13 工厂闭包当下读到新值。
      policyContext,
    }
  }

  /**
   * ：按 agentMode 构建 shell 受限档 checker（受限模式 = tabtin-readonly；
   * agent/group/yolo = undefined 无限制）。抽出复用：创建期装配 ShellCap + 轮内
   * 模式热切换（reconfigureSessionModeInPlace）都用它。checker 构造同步，命令风险
   * 查询走 loadCliCommandRiskMapAsync（30s 缓存），受限模式 fail-close。
   */
  buildRestrictedShellChecker(
    mode: AgentModeName,
    workspaceRoot?: string,
  ): RestrictedShellAllowlistChecker | undefined {
    if (getRestrictedShellAllowlist(mode) !== 'tabtin-readonly') return undefined
    return createTabtinReadonlyChecker({
      fetchCommandRisk: async (subcmdPath: string) => {
        const map = await this.loadCliCommandRiskMapAsync()
        if (!map) {
          throw new Error('CLI risk catalog unavailable or incomplete')
        }
        if (map.has(subcmdPath)) return map.get(subcmdPath) ?? ''
        return null
      },
      allowedCwdRoot: workspaceRoot,
      // ：TabTin CLI 只读兜底动词表由宿主注入，core 默认空集。
      readonlyVerbs: RESTRICTED_READONLY_VERBS,
      // ：所有受限模式（ask / plan / study）都可浏览导航；页面交互仍按写风险拒绝。
      ...(shouldInjectBrowserNavigationAllowlist(mode)
        ? { browserNavAllowlist: RESTRICTED_BROWSER_NAV_ALLOWLIST }
        : {}),
    })
  }

  /**
   * ：**轮内**（mid-turn）模式热切换——switch_mode HITL 批准后调用。
   *
   * 与 `getOrCreateRuntime` 的软切换（跨轮、runningSessions 互斥内）不同：本方法在
   * 一次 query 正**挂起等待** switch_mode 的 `waitForUserInput` 时被调用，query 处于
   * suspended 状态（JS 单线程，不会读 config）。必须在 **resolve 该 HITL 之前**完成
   * 全部同步 mutation，让 query 恢复后回读 config 立即拿到新模式。
   *
   * 三层能力一致切换（缺一即降级，见  分析）：
   *   1. 工具集——`toolProvider.reconfigure({ agentMode })`
   *   2. shell 档位——`shellCap.setRestrictedShellChecker(...)`（新增热更入口）
   *   3. system prompt——`buildSystemPromptForMode` 闭包重建后 mutate engineConfig
   *   + policyContext.currentAgentMode（判决路径每轮读）。
   *
   * 不设 pendingModeTransition：本切换在**同一轮内**生效，iteration 0 已过，
   * transition-reminder 无处注入；新模式的 `<agent_mode>` 段 + switch_mode 工具
   * 返回值已把"你现在处于 X 模式"讲清楚。也不 cancel HITL（switch_mode 自身的
   * HITL 正等着被 resolve，误 cancel 会打断本流程）。
   */
  reconfigureSessionModeInPlace(
    session: HostState,
    toMode: AgentModeName,
  ): void {
    const fromMode = session.agentMode

    // 离开 plan/study 家族且不进入 plan 家族 → 清理 active plan（与软切换对齐）。
    const leavingPlanFamily = fromMode === 'plan' || fromMode === 'study'
    const enteringPlanFamily = toMode === 'plan' || toMode === 'study'
    if (leavingPlanFamily && !enteringPlanFamily) {
      clearAllActivePlansForSession(session.sessionId)
    }

    // 1. 工具集热换
    session.toolProvider.reconfigure({ agentMode: toMode })
    // 2. shell 档位热换（本次改造的核心解锁点）
    session.shellCap?.setRestrictedShellChecker(this.buildRestrictedShellChecker(toMode, session.workspaceRoot))
    // 3. system prompt 重建（闭包捕获创建期输入，只换 mode + tools）
    const toolsForPrompt = session.toolProvider
      .getTools()
      .map((t) => ({ name: t.name, description: t.description }))
    const { systemPrompt: newSystemPrompt, buildConfig } =
      session.buildSystemPromptForMode(toMode, toolsForPrompt)
    session.toolProvider.setSubagentSystemPrompt(newSystemPrompt, buildConfig)
    // 直接 mutate EngineConfig —— runtime 通过闭包持有同一引用；query 恢复后在
    // contextModifier.modeOverride 分支回读 config.systemPrompt / config.tools 即得新值。
    session.engineConfig.systemPrompt = newSystemPrompt
    session.engineConfig.agentMode = toMode
    session.agentMode = toMode
    session.policyContext.currentAgentMode = toMode
    // ：轮内 HITL 批准后写入跨轮权威，防止下一条陈旧 plan IPC 打回。
    session.modeAuthoritySticky = toMode

    log.info(
      `[mode-switch] in-place reconfigure session=${session.sessionId.slice(0, 8)}… ${fromMode} → ${toMode}`,
    )
  }

  /**
   * L16 W5.5 /  C1：异步加载 `tabtin commands` schema 列表，编译成
   * `Map<fullName, riskString>`。给受限模式 shell allowlist checker 用（另供 `<apps>`
   * 子命令富化）。
   *
   * 与 CliCap listing 共用 Host 初始化预热出的 `cli-commands-materializer`
   * 常驻快照：schemas 含 Hidden（risk map），listing 取可见子集。热路径
   * 不再同步 spawn；缺快照时触发后台补暖并让本轮降级。
   */
  async loadCliCommandsAsync(): Promise<
    ReadonlyArray<CliCommandSchema> | null
  > {
    const materialized = getCliCommandsMaterializedSnapshot()
    if (!materialized) {
      void warmCliCommandsMaterialized('runtime-load-cli-commands-miss')
    }
    return completeCliRiskSchemas(materialized)
  }

  async loadCliCommandRiskMapAsync(): Promise<Map<string, string> | null> {
    const schemas = await this.loadCliCommandsAsync()
    if (!schemas) return null
    return buildRiskMapFromSchemas(schemas)
  }

  /**
   * M1.4 / /#4118/#7145：异步加载当前 (Organization, Agent) 的 USER 画像 markdown。
   *
   * 调 Django `/user-portrait/me/{organization_id}?agent_id=...`，提取 `content_md`。
   * 缺 `organizationId` / `agentId`、失败、空画像 → 返回 null（不注入 prompt 段）。
   * 短 TTL 缓存（10 分钟），按 `(organizationId, agentId)` 分槽位。
   *
   * 设计：故意不阻塞 runtime 创建——HTTP 失败时不抛异常，只是没有 user portrait。
   * 后端缺 `agent_id` 时 fail-closed 空画像；host 必须显式传执行 Agent，绝不能省略。
   */
  async loadUserPortraitAsync(
    organizationId: string | undefined | null,
    agentId?: string | null,
  ): Promise<string | null> {
    const scope = resolveUserPortraitFetchScope(organizationId, agentId)
    // ：与后端 GET 契约对齐——无 agent scope 绝不请求（避免拿空画像写负缓存）
    if (!scope) return null
    const { orgId, agentId: aid } = scope

    const cacheKey = buildUserPortraitCacheKey(orgId, aid)
    const cached = this.userPortraitCache.get(cacheKey)
    if (cached) {
      const ttl = cached.value !== null
        ? ElectronRuntimeAssembly.USER_PORTRAIT_CACHE_TTL_MS
        : ElectronRuntimeAssembly.USER_PORTRAIT_NEGATIVE_CACHE_TTL_MS
      if (Date.now() - cached.timestamp < ttl) {
        return cached.value
      }
    }

    try {
      const token = await TokenManager.getAccessToken()
      if (!token) {
        this.userPortraitCache.set(cacheKey, { value: null, timestamp: Date.now() })
        return null
      }

      const qs = buildUserPortraitMeQuery(aid)
      const url = joinApiPath(
        API_BASE_URL,
        `/user-portrait/me/${encodeURIComponent(orgId)}?${qs}`,
      )
      const resp = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5_000),
      })

      if (!resp.ok) {
        this.userPortraitCache.set(cacheKey, { value: null, timestamp: Date.now() })
        return null
      }

      const body = await resp.json() as {
        success?: boolean
        data?: {
          content_md?: string
          version?: number
        }
      }

      const contentMd = body?.data?.content_md?.trim() || ''
      const value = contentMd ? contentMd : null
      this.userPortraitCache.set(cacheKey, { value, timestamp: Date.now() })
      return value
    } catch (err) {
      log.debug(
        'loadUserPortraitAsync failed for organization=%s agent=%s: %s',
        orgId,
        aid,
        err instanceof Error ? err.message : err,
      )
      this.userPortraitCache.set(cacheKey, { value: null, timestamp: Date.now() })
      return null
    }
  }

  /**
   * Group 模式：拉取当前 Space 的可复用子 Agent 角色库（SubAgentTemplate）。
   *
   * 与 loadUserPortraitAsync 同构（main 自拉 Django，复用 TokenManager /
   * API_BASE_URL）。走保留的纯数据 CRUD 路由
   * `/orchestration/spaces/{id}/subagent-templates`（编排运行时路由虽下线，
   * 但该 CRUD 路由在 urls_deferred 显式保留）。失败 / 空 → 返回 []，
   * buildSystemPrompt 跳过 `<subagent_catalog>` 段（主 Agent ad-hoc 组队）。
   *
   * 仅 group 模式 runtime 创建 / 软切换时调用，per-Space 短 TTL 缓存。
   */
  async loadSubagentCatalogAsync(spaceId: string | undefined | null): Promise<SubagentCatalogEntry[]> {
    if (!spaceId) return []

    const cached = this.subagentCatalogCache.get(spaceId)
    if (cached && Date.now() - cached.timestamp < ElectronRuntimeAssembly.SUBAGENT_CATALOG_CACHE_TTL_MS) {
      return cached.value
    }

    try {
      const token = await TokenManager.getAccessToken()
      if (!token) return []

      const url = joinApiPath(API_BASE_URL, `/orchestration/spaces/${encodeURIComponent(spaceId)}/subagent-templates`)
      const resp = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5_000),
      })

      if (!resp.ok) {
        this.subagentCatalogCache.set(spaceId, { value: [], timestamp: Date.now() })
        return []
      }

      const body = await resp.json() as {
        items?: Array<{ id?: string; name?: string; description?: string; subagent_type?: string; is_enabled?: boolean }>
      }
      const items = Array.isArray(body?.items) ? body.items : []
      const catalog: SubagentCatalogEntry[] = items
        .filter(t => t.is_enabled !== false && !!t.name?.trim())
        .map(t => ({
          // ：带 template_id 让主 Agent 能精确指定模板派发。
          templateId: typeof t.id === 'string' ? t.id : undefined,
          name: t.name!.trim(),
          description: (t.description ?? '').trim(),
          subagentType: t.subagent_type || 'execute',
        }))
      this.subagentCatalogCache.set(spaceId, { value: catalog, timestamp: Date.now() })
      return catalog
    } catch (err) {
      log.debug('loadSubagentCatalogAsync failed for space %s: %s',
        spaceId, err instanceof Error ? err.message : err)
      this.subagentCatalogCache.set(spaceId, { value: [], timestamp: Date.now() })
      return []
    }
  }

  /**
   * ：拉取当前 Space 的**全量**子 Agent 模板快照，供 agent-tool 经
   * template_id 驱动 spawn（persona / model / 工具白黑名单 / 继承模式 / 类型只读）。
   *
   * 与 `loadSubagentCatalogAsync` 复用同一 CRUD 路由，但保留全部策略字段。每次
   * runtime 创建实时 fetch，并把「id → snapshot」live map 写入 `subagentTemplatesBySpace`——
   * `hostAgentToolDeps.getTemplateSnapshots` 闭包据此**同步**取值。失败 / 空 → 写空 map，
   * 所有 template_id 解析失败 → 静默 ad-hoc（行为不变）。
   *
   * 仅 group 模式 runtime 创建 / 软切换时调用（与 catalog 同门槛）。
   */
  async loadSubagentTemplatesFullAsync(spaceId: string | undefined | null): Promise<SubAgentTemplateSnapshot[]> {
    if (!spaceId) return []

    const commit = (snapshots: SubAgentTemplateSnapshot[]): SubAgentTemplateSnapshot[] => {
      this.subagentTemplatesBySpace.set(spaceId, new Map(snapshots.map(s => [s.id, s])))
      return snapshots
    }

    try {
      const token = await TokenManager.getAccessToken()
      if (!token) return commit([])

      const url = joinApiPath(API_BASE_URL, `/orchestration/spaces/${encodeURIComponent(spaceId)}/subagent-templates`)
      const resp = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5_000),
      })

      if (!resp.ok) return commit([])

      const body = await resp.json() as { items?: Array<Record<string, unknown>> }
      const items = Array.isArray(body?.items) ? body.items : []
      const snapshots = items
        .map(mapRawTemplateToSnapshot)
        .filter((s): s is SubAgentTemplateSnapshot => s !== null)
        .map(snapshot => ({
          ...snapshot,
          modelId: resolveSharedTemplateModelId(snapshot.modelId),
        }))
      return commit(snapshots)
    } catch (err) {
      log.debug('loadSubagentTemplatesFullAsync failed for space %s: %s',
        spaceId, err instanceof Error ? err.message : err)
      return commit([])
    }
  }

  /**
   *  Phase 2：读取会话 group_runtime，激活时返回本 session 允许的
   * template_id 集合（enabled resolved_roles），并写入 `sessionGroupRoleIds`；
   * 未激活 / 空 / 失败 → 清除本 session 编制（回落 Space 全量）。仅 group 模式调用。
   *
   * 会话编制存于 Django `ChatSessionContext.context_data.group_runtime`（后端
   * `GroupRuntimeService` 已把 roles 展开成 resolved_roles）。这里只取 enabled
   * template_id 做「可见 / 可解析模板」收敛，不改后端。
   */
  async loadGroupRuntimeRoleIdsAsync(sessionId: string): Promise<Set<string> | null> {
    try {
      const token = await TokenManager.getAccessToken()
      if (!token) { this.sessionGroupRoleIds.delete(sessionId); return null }

      const url = joinApiPath(API_BASE_URL, `/chat/sessions/${encodeURIComponent(sessionId)}/context`)
      const resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5_000),
      })
      if (!resp.ok) { this.sessionGroupRoleIds.delete(sessionId); return null }

      const body = await resp.json() as {
        group_runtime?: { is_active?: boolean; roles?: Array<{ template_id?: string; enabled?: boolean }> } | null
      }
      const gr = body?.group_runtime
      if (!gr || gr.is_active !== true || !Array.isArray(gr.roles)) {
        this.sessionGroupRoleIds.delete(sessionId)
        return null
      }
      const ids = new Set(
        gr.roles
          .filter(r => r.enabled !== false && typeof r.template_id === 'string' && r.template_id.trim())
          .map(r => r.template_id!.trim()),
      )
      if (ids.size === 0) { this.sessionGroupRoleIds.delete(sessionId); return null }
      this.sessionGroupRoleIds.set(sessionId, ids)
      return ids
    } catch (err) {
      log.debug('loadGroupRuntimeRoleIdsAsync failed for session %s: %s',
        sessionId, err instanceof Error ? err.message : err)
      this.sessionGroupRoleIds.delete(sessionId)
      return null
    }
  }

  /**
   *  Phase 2：给 host 模板展开用的 per-session 取值。
   * 返回 Space 全量模板 map；若本 session 有 group_runtime 编制（sessionGroupRoleIds），
   * 收敛为编制子集（新建过滤 map，不改共享 space map，避免跨 session 污染）。
   */
  resolveSessionTemplateSnapshots(
    sessionId: string,
    spaceId: string | undefined,
  ): Map<string, SubAgentTemplateSnapshot> | undefined {
    const full = spaceId ? this.subagentTemplatesBySpace.get(spaceId) : undefined
    if (!full) return undefined
    const allow = this.sessionGroupRoleIds.get(sessionId)
    if (!allow || allow.size === 0) return full
    return new Map([...full].filter(([id]) => allow.has(id)))
  }

  async loadSessionTemplateSnapshots(
    sessionId: string,
    spaceId: string | undefined,
  ): Promise<Map<string, SubAgentTemplateSnapshot> | undefined> {
    if (!spaceId) return undefined
    await this.loadSubagentTemplatesFullAsync(spaceId)
    return this.resolveSessionTemplateSnapshots(sessionId, spaceId)
  }

  /**
   * 失效画像缓存。
   * - 传 organizationId + agentId：只清该 (org, agent) 槽位（`orgId::agentId`）
   * - 仅传 organizationId：清该组织下全部 agent 槽位
   * - 不传：清空全部
   */
  invalidateUserPortraitCache(organizationId?: string, agentId?: string): void {
    if (!organizationId) {
      this.userPortraitCache.clear()
      return
    }
    const scope = resolveUserPortraitFetchScope(organizationId, agentId)
    if (scope && agentId) {
      this.userPortraitCache.delete(buildUserPortraitCacheKey(scope.orgId, scope.agentId))
      return
    }
    const orgTrimmed = organizationId.trim()
    const prefix = `${orgTrimmed}::`
    const keysToDelete: string[] = []
    for (const key of this.userPortraitCache.keys()) {
      if (key === orgTrimmed || key.startsWith(prefix)) {
        keysToDelete.push(key)
      }
    }
    for (const key of keysToDelete) {
      this.userPortraitCache.delete(key)
    }
  }

  /** Host `stop()` — dispose shared NativeBackend registry owned by assembly. */
  async disposeBackendRegistry(): Promise<void> {
    if (!this.backendRegistry) return
    try {
      await this.backendRegistry.dispose()
    } catch (err) {
      log.warn(
        `[NativeBackendSession] registry.dispose failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    this.backendRegistry = null
  }
}
