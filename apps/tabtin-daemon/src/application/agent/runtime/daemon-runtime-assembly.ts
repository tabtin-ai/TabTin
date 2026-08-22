/**
 * Daemon runtime assembly — agent-runtime 装配知识从 DaemonAgentHost 抽出。
 *
 * DaemonAgentHost 保持 headless 平台外壳；本模块拥有 runtime 生命周期
 * （build / soft-reconfigure / rebuild）+ createRuntimeForSession + 各 catalog /
 * portrait / cli-reference loader。与 ElectronRuntimeAssembly 同构：host 注入
 * `DaemonRuntimeAssemblyPorts` 提供 gateway/config/logger/sessions/core 等真实依赖。
 */
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import {
  filterTemporarilyHiddenCliPromptReference,
  isTemporarilyHiddenCliPromptCommand,
} from './cli-prompt-filter.js';
import { AgentHost } from '@tabtin/agent-host'
import type {
  AgentRuntime,
  EngineConfig,
  ModelCapabilities,
  ModelCatalogEntry,
  StreamEvent,
  Tool
} from '@tabtin/agent-runtime/engine';
//  批次 13：engine barrel 收敛为 engine-only。非 engine 目录的符号
// （runtime 组装根 / session / subagent / providers / telemetry / agent-modes /
// permissions / host / capability injectors）改从包入口 `@tabtin/agent-runtime` import。
import type { AgentModeName } from '@tabtin/agent-modes'
import {
  clearAllActivePlansForSession,
  getActivePlanFilePath
} from '@tabtin/agent-runtime';
import {
  createSubagentStreamRouter,
  SessionPauseController
} from '@tabtin/agent-host/delivery'
import {
  canSoftReconfigureByShellTier,
  resolveSubagentCarryForward,
  resolveSubagentCompletionSpaceId,
  buildCostCapConfig,
  createSessionStorageBundle,
  assemblePermissionShell,
  RuntimeSessionFactory,
  type RuntimeBuildContext,
  type RuntimeSessionFactoryAdapter,
  type SubagentManagerLike
} from '@tabtin/agent-host/runtime'
// ：per-session 串行执行器 + FIFO 队列（host 侧 busy/queue 唯一真相源）。
// 子代理历史恢复·方案 A：子/孙代理 persist_message 也落父会话 message-blocks.jsonl（判定事件类型用）。
import { buildModelFallbackChain } from '@tabtin/agent-runtime/engine';
import { createSkillActivation } from '@tabtin/agent-runtime/tools';
// 路径权限治理 W7 / L1：派生 EffectivePolicy.planModeGuardActive
import { isPlanModeGuardActive } from '@tabtin/agent-modes';
//  / ：Space 模板快照解析在 host；runtime 只吃展开后的通用入参。
import {
  mapRawTemplateToSnapshot,
  type SubAgentTemplateSnapshot,
} from '@tabtin/agent-host/configuration';
import type { HostAgentToolDeps } from '@tabtin/agent-host/configuration';
import {
  createRuntime,
  TabTinProxyProvider,
  SubagentManager,
  reapOrphanedSubagentRuns,
  LocalPermissionHandler,
  EventEmitter,
  TelemetryEvents,
  emitTelemetryEvent,
  redactCustomRules,
  resolveWorkspaceSessionArchiveDir,
  resolveWorkspaceToolLogsDir,
  type SessionStorage,
  type SnapshotStorage,
  type EventStorage,
  type ToolLogWriter,
  type TodoSessionAnchor,
  resolveOrganizationSkillDir
} from '@tabtin/agent-runtime'
import { getRestrictedShellAllowlist } from '@tabtin/agent-modes'
//  Phase 1：6 段上下文贡献 hook + relevant-recall 已从
// runtime 迁到宿主内容包 @tabtin/agent-host/hooks（引擎只留 EngineHooks 注入原语）。
// buildLspDiagnosticHook：W7c · Stage 4 Daemon 路径对齐（治理 07 §F.4）——
// edit_file / write_file 后 LSP 诊断包成 `<system-reminder><new-diagnostics>` 注入。
import {
  buildMemoryHook,
  buildAgentProfileHook,
  buildModeReminderHook,
  buildTodoStateHook,
  buildRelevantRecallHook,
  buildContextHook,
  getFocusedAppKey,
  buildRulesHook,
  buildLspDiagnosticHook
} from '@tabtin/agent-host/hooks';
import {
  BudgetTracker,
  composeHooks
} from '@tabtin/agent-runtime/engine';
// ：系统提示词装配的权威真相源在 agent-runtime。Daemon 不再直接调
// buildSystemPrompt 手抄入参，统一走 assembleSystemPrompt（烘焙输入 + 变体）。
import {
  assembleSystemPrompt,
  createSystemPromptProvider,
  createTodoCompletionNudgeProvider
} from '@tabtin/agent-host/prompt';
import {
  createToolRiskPolicyPort,
  createJudgeMemoStoreAdapter,
  createAgentModesToolGate,
  annotateReadonlyChildTools
} from '@tabtin/agent-host/policy';
import type { BakedSystemPromptInputs } from '@tabtin/agent-host/prompt';
// ：run_terminal_command 交付物卡（Browser→Table / OSS）迁到 host
// afterToolResult hook（业务落在 @tabtin/agent-host/delivery）；两端宿主对称注册。
import {
  wrapEnqueueSubagentCompletionWithDeliverables,
  createTerminalArtifactCardHook,
} from '@tabtin/agent-host/delivery';
import type {
  WorkingDirType,
  SubagentCatalogEntry
} from '@tabtin/agent-prompt';
// W7c · Stage 4 Daemon 路径对齐（治理 07 §F.4）：LSP runtime singleton + 诊断
// 注入。与 ElectronAgentHost 同款使用 `initializeLspServerManager` lazy 启动
// LSP server，第一次 session 创建时用当前 workspace root init；TABTIN_DISABLE_LSP=1
// 由 lsp-runtime 内部处理，与 Electron 行为一致。
import {
  initializeLspServerManager,
  onLspInitialized,
  registerLSPNotificationHandlers,
  createBuiltinServersLoader,
  getInitializationStatus as getLspInitializationStatus
} from '@tabtin/lsp-runtime';
import {
  ExecutionBackendRegistry,
  resolveDataRoot,
  tabtinAgentTasksDir,
  buildSubagentCompletionEnvelope,
  resolveAgentShellInfo
} from '@tabtin/terminal-core';
// W1.2 /  Stage 6d：装配 NativeBackendSession + ExecutionBackendRegistry。
// bootstrap 在 agent-host（依赖 terminal-core）；session 实现仍在 agent-runtime。
import {
  bootstrapNativeBackend,
  isNativeBackendSessionEnabled,
  type NativeBackendBootstrapResult
} from '@tabtin/agent-host/native';
// ShellCap 接 PtyManagerBridge — 装配点拿 bridge。
// bootstrap 顺序（agent-bridge.ts L544-548）：
//   PtyManager.initialize() 完成 → daemon.ts 调 setPtyManagerBridge →
//   此处 resolvePtyManagerBridge 拿到真实 bridge → 装配 ShellCap
// W7c · Stage 4 Daemon 路径对齐（治理 07 §F.5）：Daemon 端 run-observation injector
// 显式降级实现 —— Daemon 当前没 host-side observation 源（autofill / RunSessionManager
// 在 Electron 主进程），injector 恒返回空数组但暴露 ``isNoop`` / ``reason`` 元信息
// 供 P5 audit 显式登记差异。详见同名文件 doc-string。
import { createDaemonRunObservationInjector } from '../run-observation-injector.js';
// Capability + capability 装配 helper（5 件套）：
// - TabDataCap 已随 Wave 4a (2026-05-01) D4 全删 FC 一并删除（Agent 走 `tabtin table *` CLI）
// - TabDocCap 已随 Wave 12 (2026-05-04) 退役（Agent 走 `tabtin doc *` CLI）
import {
  FileSystemCap,
  PlatformDataCap,
  RawRefCap,
  ShellCap,
  AuditCap,
  createRelayAuditWriter,
  CostCap,
  composeCapabilityHooks,
  prepareAgentTools,
  createTabtinReadonlyChecker,
  buildRiskMapFromSchemas,
  parseTabtinCommandsJson,
  type CliCommandSchema,
  type SkillContextProvider,
  type RestrictedShellAllowlistChecker
} from '@tabtin/agent-runtime/capability';
// ：平台目录类 Cap（SkillsCap）已迁至共享宿主包。
// ：受限 shell 动词表 / Plan 浏览器导航豁免 / untrusted 判定 / 烤图 /
// present 资源策略 / 本地产物 URI / 隐藏 skill 名单——TabTin 业务知识由宿主注入。
import {
  SkillsCap,
  RESTRICTED_READONLY_VERBS,
  RESTRICTED_BROWSER_NAV_ALLOWLIST,
  isUntrustedShellCommand,
} from '@tabtin/agent-host/capabilities';
import { createAppMetaFormatter } from '@tabtin/agent-host/delivery';
import type { ToolProvider as RuntimeToolProvider } from '@tabtin/agent-runtime/engine';
import type { PersistedEntryOwner } from '@tabtin/agent-runtime';
// W4a S3-S5（PR2）：live 依赖重绑 + 完成回调契约类型（与 Electron 对称）。
import type {
  SubagentLiveDeps,
  EnqueueSubagentCompletion
} from '@tabtin/agent-runtime';
import { daemonHostRuntimeOptions } from '@tabtin/agent-host/configuration'
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
} = daemonHostRuntimeOptions
import type { DaemonConfig } from '../../../base/types/daemon-config.js';
import type { Logger } from '../../../platform/observability/logging/logger.js';
import type { RunDocParserTask } from '@tabtin/local-docparse';
import { DaemonToolProvider } from '../daemon-tool-provider.js';
import {
  buildPolicyFromAgentConfigV2,
  checkHardlineCommand
} from '@tabtin/security-policy';
import { getSharedOSErrorBlacklist } from '@tabtin/agent-runtime/permissions';
import {
  createSkillCredentialResolver,
  type SkillCredentialResolverHandle,
  type SkillCredentialResolverLogger
} from '@tabtin/agent-host/credentials';
import {
  loadEnabledPersonalPluginSkillSnapshot,
  mergeSkillListsForRuntime,
  searchRuntimeSkills,
  SkillEnablementMapCache,
  isSkillEnabledByMap,
  type PersonalPluginSkillSnapshot
} from '@tabtin/agent-runtime/skills';
import type { SkillsModuleHandle } from '@tabtin/agent-host/skills';
import type {
  SkillsToolsDeps,
  SkillInvokeDeps,
  SkillCreateDeps
} from '@tabtin/agent-runtime/tools';
// Memory v2 阶段 3：memory-injector hook 复用 memory_search 工具同款 helper。
// 项目规则自动加载（AGENTS.md MVP）：rules-injector hook 复用 readProjectRules
// 读盘 helper（mtime 缓存 + 截断），与 Electron 宿主 import 同一份。
import { readProjectRules } from '@tabtin/agent-runtime/tools';
// ：memory_search helper 随 data-tools 迁宿主业务工具包。
import { callMemorySearchAPI } from '@tabtin/agent-host/tools';
import {
  deriveApiBaseUrl,
  joinApiPath
} from '@tabtin/config';
// W3：UserInteractiveChannel 桥接 + ApprovalMemoStore 装配（与 Electron 同构）。
// 生产链路 100% 走 `@tabtin/security-policy` `judge()` 主路径——历史 6 层
// PermissionPipeline（driver / layers / 配套接口）已整体清退。
import { cancelAllPendingHitlRequests } from '@tabtin/agent-runtime';
import { getOrCreateFileHistory } from '../../../platform/workspace/file-history/file-history-registry.js';
// W4 (2026-05-13)：持久通道改造——不再直接 import parseLocalAttachment，改走
// `@tabtin/file-pipeline` 的 `FileResolver`。channel 只决定策略 + 装配 prompt。

import type {
  RuntimeBuildInputContract as RuntimeBuildInput,
  RuntimeCarryForwardContract as RuntimeCarryForward,
  DaemonHostStateContract as DaemonHostState,
  CatalogEntryContract as CatalogEntry,
  DaemonQueryRequestContract as DaemonQueryRequest,
  DaemonQueryResult,
  AgentTerminalPort,
} from '../contracts.js'
import type { AgentSessionState } from '../session/agent-session-state.js'
import {
  type DaemonRuntimeExtraKey,
  daemonRuntimeExtraKeysMatch,
  normalizeDaemonRuntimeExtraKey
} from './daemon-runtime-key.js'

// pending-input 超时常量（仅装配路径 createRuntimeForSession → waitForUserInput 使用）。
const PENDING_INPUT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

type TimedValue<T> = { value: T; timestamp: number };

/** Owns runtime-context cache identity, TTL policy, and scoped invalidation. */
export class RuntimeContextCatalog {
  private cliCommands: TimedValue<ReadonlyArray<CliCommandSchema> | null> | null = null;
  private cliReference: TimedValue<string | null> | null = null;
  private readonly userPortraits = new Map<string, TimedValue<string | null>>();
  private readonly subagentCatalogs = new Map<string, TimedValue<SubagentCatalogEntry[]>>();
  private readonly templatesBySpace = new Map<string, Map<string, SubAgentTemplateSnapshot>>();
  private readonly groupRoleIdsBySession = new Map<string, Set<string>>();

  getCliCommands(): TimedValue<ReadonlyArray<CliCommandSchema> | null> | null { return this.cliCommands; }
  setCliCommands(value: ReadonlyArray<CliCommandSchema> | null): void { this.cliCommands = { value, timestamp: Date.now() }; }
  invalidateCliCommands(): void { this.cliCommands = null; }

  getCliReference(): TimedValue<string | null> | null { return this.cliReference; }
  setCliReference(value: string | null): void { this.cliReference = { value, timestamp: Date.now() }; }
  invalidateCliReference(): void { this.cliReference = null; }

  getUserPortrait(organizationId: string): TimedValue<string | null> | undefined { return this.userPortraits.get(organizationId); }
  setUserPortrait(organizationId: string, value: string | null): void {
    this.userPortraits.set(organizationId, { value, timestamp: Date.now() });
  }
  invalidateUserPortrait(organizationId?: string): void {
    if (organizationId) this.userPortraits.delete(organizationId);
    else this.userPortraits.clear();
  }

  getSubagentCatalog(spaceId: string): TimedValue<SubagentCatalogEntry[]> | undefined {
    return this.subagentCatalogs.get(spaceId);
  }
  setSubagentCatalog(spaceId: string, value: SubagentCatalogEntry[]): void {
    this.subagentCatalogs.set(spaceId, { value, timestamp: Date.now() });
  }

  commitTemplates(spaceId: string, snapshots: SubAgentTemplateSnapshot[]): SubAgentTemplateSnapshot[] {
    this.templatesBySpace.set(spaceId, new Map(snapshots.map(snapshot => [snapshot.id, snapshot])));
    return snapshots;
  }
  setGroupRoleIds(sessionId: string, roleIds: Set<string> | null): void {
    if (roleIds?.size) this.groupRoleIdsBySession.set(sessionId, roleIds);
    else this.groupRoleIdsBySession.delete(sessionId);
  }
  resolveTemplates(sessionId: string, spaceId: string | undefined): Map<string, SubAgentTemplateSnapshot> | undefined {
    const templates = spaceId ? this.templatesBySpace.get(spaceId) : undefined;
    if (!templates) return undefined;
    const allowed = this.groupRoleIdsBySession.get(sessionId);
    if (!allowed?.size) return templates;
    return new Map([...templates].filter(([id]) => allowed.has(id)));
  }
}

/**
 * host 注入给 DaemonRuntimeAssembly 的依赖端口。字段用 getter 保证读到 host 侧
 * 最新值（skillsModule / skillsReady / sharedHost 等在 host 生命周期内会变）；
 * 装配路径只读这些端口、从不回写，故全部声明为只读。
 */
export interface DaemonRuntimeAssemblyPorts {
  readonly logger: Logger
  readonly config: DaemonConfig
  getAccessToken: () => string
  runDocParserTask: RunDocParserTask
  readonly terminal: { current(): AgentTerminalPort | null }
  readonly workspaceRoot: string | undefined
  readonly session: {
    readonly sessions: AgentHost<DaemonQueryRequest, DaemonQueryResult, DaemonHostState>['sessions']
    readonly state: AgentSessionState<DaemonQueryRequest, SkillCredentialResolverHandle>
    readonly interactionRegistry: AgentHost<DaemonQueryRequest, DaemonQueryResult, DaemonHostState>['interactions']['registry']
    getHost(): AgentHost<DaemonQueryRequest, DaemonQueryResult, DaemonHostState>
  }
  readonly skills: {
    module(): SkillsModuleHandle | null
    ready(): Promise<void> | null
    readonly enablementCache: SkillEnablementMapCache
  }
  resolveModelFromCatalog: (modelId: string) => CatalogEntry
  readonly syncPersistenceEnabled: boolean
  drainThreadNotificationsText: (threadId: string) => string | null
  buildModelCatalogSnapshot: () => ModelCatalogEntry[]
  relaySubagentStreamEventDirect: (sessionId: string, event: StreamEvent) => void
  applyPendingPauseToSession: (
    sessionId: string,
    fileHistoryThreadId: string,
    pauseController: SessionPauseController,
  ) => void
}

export class DaemonRuntimeAssembly {
  constructor(private readonly ports: DaemonRuntimeAssemblyPorts) {}

  private static readonly CLI_RISK_MAP_TTL_MS = 30 * 1000;
  private static readonly CLI_RISK_MAP_NEGATIVE_TTL_MS = 5 * 1000;
  private static readonly SUBAGENT_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
  private static readonly USER_PORTRAIT_CACHE_TTL_MS = 10 * 60 * 1000;
  private static readonly USER_PORTRAIT_NEGATIVE_CACHE_TTL_MS = 60 * 1000;
  private static readonly CLI_CACHE_TTL_MS = 30 * 60 * 1000;
  private static readonly CLI_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;

  private _runtimeFactory: RuntimeSessionFactory<
    RuntimeBuildInput,
    DaemonHostState,
    AgentModeName,
    RuntimeCarryForward,
    DaemonRuntimeExtraKey
  > | null = null;
  private backendRegistry: ExecutionBackendRegistry | null = null;
  private lspInitialized = false;
  private readonly contextCatalog = new RuntimeContextCatalog();

  /**
   * 懒建 RuntimeSessionFactory：session bag = DaemonHostState 直挂
   * `this.ports.sessions`，factory 完整接管 reuse / soft-reconfigure / rebuild。
   * host 侧 EOL 编排 + resource factory 都经 getRuntimeFactory() 拿到同一实例。
   */
  getRuntimeFactory(): RuntimeSessionFactory<
    RuntimeBuildInput,
    DaemonHostState,
    AgentModeName,
    RuntimeCarryForward,
    DaemonRuntimeExtraKey
  > {
    if (!this._runtimeFactory) {
      this._runtimeFactory = new RuntimeSessionFactory<
        RuntimeBuildInput,
        DaemonHostState,
        AgentModeName,
        RuntimeCarryForward,
        DaemonRuntimeExtraKey
      >(this.buildRuntimeFactoryAdapter(), this.ports.session.sessions);
    }
    return this._runtimeFactory;
  }

  /**
   * W1.2：dispose 跨 session 共享的 ExecutionBackendRegistry（host.stop() 调用）。
   * 与原 DaemonRuntimeAssembly.stop() 内联逻辑逐字一致。
   */
  async disposeBackendRegistry(): Promise<void> {
    if (this.backendRegistry) {
      try {
        await this.backendRegistry.dispose();
      } catch (err) {
        this.ports.logger.warn(
          `[NativeBackendSession] registry.dispose failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.backendRegistry = null;
    }
  }

  /**
   * 装配 `RuntimeSessionFactory` adapter：session bag = `DaemonHostState` 直挂
   * `this.ports.sessions`，factory 完整接管 reuse / soft-reconfigure / rebuild
   * 决策与顺序。与 ElectronAgentHost.buildRuntimeFactoryAdapter 行为对称——
   * 只是 shellCap 热更 / IPC 通道 / renderer 相关差异在 Daemon 侧不适用。
   */
  buildRuntimeFactoryAdapter(): RuntimeSessionFactoryAdapter<
    RuntimeBuildInput,
    DaemonHostState,
    AgentModeName,
    RuntimeCarryForward,
    DaemonRuntimeExtraKey
  > {
    return {
      getMode: (session) => session.agentMode,
      setMode: (session, mode) => {
        session.agentMode = mode;
      },
      // DaemonHostState extends RuntimeCacheKey —— `runtimeCacheKeysMatch` 只
      // 读约定字段，其它字段无副作用。
      getCacheKey: (session) => session,
      getExtraKey: (session) =>
        normalizeDaemonRuntimeExtraKey(session.disabledApps, session.disabledToolPrefixes, session.workspaceId),
      extraKeysMatch: daemonRuntimeExtraKeysMatch,
      canSoftReconfigure: (existing, request) =>
        canSoftReconfigureByShellTier(existing.agentMode, request.mode),
      softReconfigure: async (existing, request) => {
        await this.softReconfigureExisting(existing, request.mode, request.input);
      },
      captureCarryForward: (existing) => ({ subagentManager: existing.subagentManager }),
      teardownForRebuild: async (existing) => {
        await this.teardownForRebuild(existing);
      },
      build: async (context) => this.buildDaemonHostState(context),
    };
  }

  /**
   * Rebuild 硬拆：cancel HITL + 清 active plan + 断掉旧 sessionStorage /
   * backend session / skill-credential handle。**不**调 `this.ports.sessions.delete`——
   * factory 内部按 teardown 后是否仍指向旧引用统一删除（与 Electron 对称）。
   */
  private async teardownForRebuild(existing: DaemonHostState): Promise<void> {
    // Phase 3 F1 语义：只清本 session 的 HITL，别误杀其它 session。
    cancelAllPendingHitlRequests({
      hitlMap: this.ports.session.interactionRegistry,
      sessionId: existing.sessionId,
      reason: 'Pending tool approval cancelled because agent runtime is rebuilding.',
    });
    // 重建前清 active-plan-tracker，避免新 runtime 拿到旧 active plan 状态。
    try {
      clearAllActivePlansForSession(existing.sessionId);
    } catch {
      // best effort —— tracker 自身的异常不应影响重建主流程
    }
    // W4a S3③（PR2）：旧 Manager 不 dispose（factory 通过 captureCarryForward
    // 保住后台子登记）；这里只处理 sessionStorage / backend session /
    // skill-credential handle（与 Electron 对称）。
    await existing.sessionStorage.dispose();
    try {
      await existing.backendBootstrap?.session.shutdown();
    } catch {
      // shutdown 已内吞错误；这里是双层保险
    }
    // Wave 2a 补丁 P0-2：重建前先从 Map 删除旧 handle（新 handle 会在
    // createRuntimeForSession 里按同 sessionId 写回）。避免 rebuild 过程中
    // invalidateSkillCredentialCaches 被并发调用时同一 session 出现 "旧+新"
    // 两份 handle 的过渡窗口。
    this.ports.session.state.deleteCredentialResolver(existing.sessionId);
  }

  /**
   * Soft-reconfigure：与 ElectronAgentHost.softReconfigureExisting 同构 —— 仅
   * mode 变化且 shell 档位不变时保留 runtime / BudgetTracker / appContext /
   * subagentManager，重装 toolProvider + system prompt。日志文案 / telemetry /
   * 异步 CLI/portrait 加载顺序都保留。Daemon 无 IPC / shellCap 热更等宿主
   * 专属副作用，其它步骤（HITL cancel + mode 同步 + toolProvider.reconfigure +
   * system prompt 更新）与 Electron 完全对齐。
   */
  private async softReconfigureExisting(
    existing: DaemonHostState,
    agentMode: AgentModeName,
    input: RuntimeBuildInput,
  ): Promise<void> {
    const sessionId = existing.sessionId;
    const { agentId } = input;
    this.ports.logger.info(
      `[DaemonAgentHost] Runtime soft-reconfigure: agentMode ${existing.agentMode} → ${agentMode} [session=${sessionId.slice(0, 8)}…]`,
    );
    emitTelemetryEvent(
      TelemetryEvents.AGENT_MODE_CHANGED,
      { from: existing.agentMode, to: agentMode, reason: 'user_switch_soft' },
      { session_id: sessionId, agent_id: agentId ?? undefined },
    );

    // 离开 plan/study 且不再进 plan 家族时清理 active plan（与 Electron 对称）。
    const leavingPlanFamily = existing.agentMode === 'plan' || existing.agentMode === 'study';
    const enteringPlanFamily = agentMode === 'plan' || agentMode === 'study';
    if (leavingPlanFamily && !enteringPlanFamily) {
      try {
        clearAllActivePlansForSession(existing.sessionId);
      } catch {
        // tracker 自身异常不影响主流程
      }
    }

    // Phase 3 F1 双保险：软切也 cancel 当前 session 的 pending HITL。
    cancelAllPendingHitlRequests({
      hitlMap: this.ports.session.interactionRegistry,
      sessionId,
      reason: 'Pending tool approval cancelled because agent mode changed.',
    });

    // 先 await 异步依赖，再同步完成 reconfigure/prompt 装配 + mutation，避免
    // await 窗口中间不一致（与 Electron 对称）。
    const spaceId = existing.spaceId;
    const organizationIdForPortrait = existing.owner.organizationId || '';
    const [userPortrait, subagentCatalog, subagentTemplates, effectiveCliReference] =
      await this.loadSoftReconfigureDependencies(agentMode, spaceId, organizationIdForPortrait, input.cliReference);
    // subagentTemplates 只需触发一次加载让 live map 就位；软切换无需再重装 agentToolDeps。
    void subagentTemplates;

    const reconfigSubagentCatalog = await this.filterGroupSubagentCatalog(agentMode, sessionId, subagentCatalog);

    existing.toolProvider.reconfigure({ agentMode });

    // （硬切）：会话归档路径改走 dataRoot + userId（PersistedEntryOwner
    // 契约保证 existing.owner.userId 非空），不再回落 legacy platformDataRoot。
    const runtimeIdentity = this.buildSoftReconfigureRuntimeIdentity(spaceId, existing, input);

    const reconfigBaked: BakedSystemPromptInputs = {
      customRules: existing.customRules,
      personalRules: existing.personalRules,
      enabledApps: input.enabledApps,
      memoryCapability: existing.memoryCapability,
      workingDirType: existing.workingDirType,
      cliReference: effectiveCliReference,
      userPortrait: userPortrait ?? undefined,
      runtimeIdentity,
      shellInfo: resolveAgentShellInfo(),
      subagentCatalog: reconfigSubagentCatalog,
    };
    const { systemPrompt: newSystemPrompt, buildConfig: reconfigBuildConfig } =
      assembleSystemPrompt(reconfigBaked, {
        agentMode,
        tools: existing.toolProvider.getTools().map((t: Tool) => ({ name: t.name, description: t.description })),
      });
    existing.toolProvider.setSubagentSystemPrompt(newSystemPrompt, reconfigBuildConfig);
    // 直接 mutate EngineConfig —— Runtime 通过闭包持有同一引用，下次
    // runtime.query() 在 runQuery 开头即读到新值。**不变量**：此 mutate
    // 必须在 factory 的 runExclusive 互斥保护内执行。
    existing.engineConfig.systemPrompt = newSystemPrompt;
    existing.engineConfig.agentMode = agentMode;
    // agentMode 由 factory 通过 setMode 写回；policyContext 同步。
    existing.policyContext.currentAgentMode = agentMode;

    emitTelemetryEvent(
      TelemetryEvents.AGENT_MODE_APPLIED,
      { mode: agentMode, reason: 'soft_reconfigure' },
      { session_id: sessionId, agent_id: agentId ?? undefined },
    );
  }

  private async loadSoftReconfigureDependencies(
    agentMode: AgentModeName,
    spaceId: string | undefined,
    organizationId: string,
    cliReference: string | undefined,
  ) {
    return Promise.all([
      this.loadUserPortraitAsync(organizationId),
      agentMode === 'group' ? this.loadSubagentCatalogAsync(spaceId) : Promise.resolve([] as SubagentCatalogEntry[]),
      spaceId ? this.loadSubagentTemplatesFullAsync(spaceId) : Promise.resolve([] as SubAgentTemplateSnapshot[]),
      (cliReference?.trim() ? Promise.resolve(cliReference) : this.loadCLIReferenceAsync())
        .then((value) => filterTemporarilyHiddenCliPromptReference(value ?? undefined)),
    ] as const);
  }

  private buildSoftReconfigureRuntimeIdentity(
    spaceId: string | undefined,
    existing: DaemonHostState,
    input: RuntimeBuildInput,
  ): BakedSystemPromptInputs['runtimeIdentity'] {
    if (!spaceId || !existing.owner.organizationId || !this.ports.workspaceRoot) return undefined;
    const dataRoot = resolveDataRoot();
    return {
      organizationId: existing.owner.organizationId,
      spaceId,
      threadId: existing.businessThreadId || existing.sessionId,
      spaceName: input.spaceName,
      organizationName: input.organizationName,
      workspaceRoot: this.ports.workspaceRoot,
      archiveDir: resolveWorkspaceSessionArchiveDir(dataRoot, existing.owner.userId, existing.owner.organizationId, spaceId),
      toolLogsDir: resolveWorkspaceToolLogsDir(dataRoot, existing.owner.userId, existing.owner.organizationId, spaceId),
    };
  }

  private async filterGroupSubagentCatalog(
    agentMode: AgentModeName,
    sessionId: string,
    catalog: SubagentCatalogEntry[],
  ): Promise<SubagentCatalogEntry[]> {
    if (agentMode !== 'group') return catalog;
    const roleIds = await this.loadGroupRuntimeRoleIdsAsync(sessionId);
    if (!roleIds || roleIds.size === 0) return catalog;
    return catalog.filter((entry) => Boolean(entry.templateId) && roleIds.has(entry.templateId!));
  }

  /**
   * `build` 分支：调 `createRuntimeForSession` 装配新 runtime 全套 —— **不 set
   * this.ports.sessions**（factory 在 build 返回后统一 set）。carry-forward 只透传
   * SubagentManager（W4a S3③），旧 sessionStorage / backend session 已在
   * teardownForRebuild 收尾。
   */
  private async buildDaemonHostState(
    context: RuntimeBuildContext<RuntimeBuildInput, AgentModeName, RuntimeCarryForward>,
  ): Promise<DaemonHostState> {
    const { sessionId, mode: agentMode, cacheKey, input, carryForward } = context;
    const normalizedRules = cacheKey.customRules;
    const normalizedPersonalRules = cacheKey.personalRules;
    const normalizedMemoryCapability = cacheKey.memoryCapability;
    const normalizedWorkingDirType = cacheKey.workingDirType;

    const {
      runtime,
      sessionStorage,
      snapshotStorage,
      eventStorage,
      toolLogWriter,
      toolProvider,
      engineConfig,
      backendBootstrap,
      agentConfigV3,
      workspaceSnapshotV3,
      policyContext,
      subagentManager,
      subagentStreamSink,
      eventEmitter,
      fileHistoryThreadId,
    } = await this.createRuntimeForSession(
      sessionId,
      input.modelId,
      input.agentId,
      input.workspaceId,
      input.authorizationPreset,
      normalizedRules,
      input.owner,
      agentMode,
      input.spaceId,
      input.operationSwitches,
      input.disabledApps,
      input.disabledToolPrefixes,
      normalizedMemoryCapability,
      normalizedWorkingDirType,
      input.executionLimits,
      input.yoloMode,
      input.workspaceSnapshot,
      input.isByokMode,
      input.enabledApps,
      input.isGroupSpace,
      input.spaceName,
      input.organizationName,
      input.cliReference,
      normalizedPersonalRules,
      input.threadId,
      input.cloudPressureThresholds,
      carryForward?.subagentManager,
    );
    const abortController = new AbortController();
    const existing = this.ports.session.sessions.get(sessionId);
    const pauseController = existing?.pauseController ?? new SessionPauseController();

    const state: DaemonHostState = {
      runtime,
      sessionId,
      businessThreadId: fileHistoryThreadId,
      fileHistoryThreadId,
      ...cacheKey,
      agentMode,
      workspaceId: input.workspaceId,
      disabledApps: input.disabledApps,
      disabledToolPrefixes: input.disabledToolPrefixes,
      operationSwitches: input.operationSwitches,
      abortController,
      pauseController,
      sessionStorage,
      snapshotStorage,
      eventStorage,
      toolLogWriter,
      toolProvider,
      appContext: null,
      agentProfile: null,
      engineConfig,
      backendBootstrap,
      agentConfigV3,
      workspaceSnapshot: workspaceSnapshotV3,
      policyContext,
      subagentManager,
      subagentStreamSink,
      eventEmitter,
    };

    this.ports.applyPendingPauseToSession(sessionId, fileHistoryThreadId, pauseController);

    this.ports.logger.info(
      `[DaemonAgentHost] Runtime created for session=${sessionId.slice(0, 8)}…, model=${input.modelId}, mode=${agentMode}, space=${input.spaceId ?? 'n/a'}`,
    );
    return state;
  }

  private async createRuntimeForSession(
    sessionId: string,
    modelId: string,
    agentId?: string,
    workspaceId?: string,
    authorizationPreset?: 'cautious' | 'collaborative' | 'full_auto' | 'server_auto',
    customRules?: string,
    owner?: PersistedEntryOwner,
    /**
     * W7a：烘焙到 ToolProvider 的 mode（与 Electron 同构）。
     * 'agent'（默认）保持现有行为完全不变（回归基线）。
     */
    agentMode: AgentModeName = 'agent',
    /**
     * W7a：当前 chat 所属 Space id，传入 ToolProvider（plan-tools 需要）+
     * buildSystemPrompt（context 注入）。
     */
    spaceId?: string,
    /**
     * W7b M3 (PRD 真相 A2)：用户配置的细粒度操作开关。
     * mergeOperationSwitches(preset, overrides) 后写入 DaemonToolProvider.policy。
     */
    operationSwitches?: Record<string, 'allow' | 'confirm' | 'block'>,
    disabledApps?: string[],
    disabledToolPrefixes?: string[],
    /**
     * W7b M3：是否启用 memory 能力，buildSystemPrompt 据此注入
     * `<agent_memory_capability>` 段。
     */
    memoryCapability?: boolean,
    /**
     * work_mode：Agent 工作目录类型（已归一化）。buildSystemPrompt 据此注入
     * 对应 `<work_mode>` 段。
     */
    workingDirType?: WorkingDirType,
    /**
     * W2.3-fix（F8 修复）：v2 `agent_config.capabilities.overrides.cost.execution_limits`
     * 经 `normalizeExecutionLimitsForCostCap` 归一后的 number 形态。装配 CostCap 时
     * 注入 `CostCapInit.config.execution_limits`，使用户在 Settings 配的 credits
     * 上限真实生效（修复 F8 两宿主硬编码 undefined 接线 P0）。
     *
     * 缺省（v1 / 未配 / 脏数据） → CostCap 无显式上限，afterIteration 回落
     * `DEFAULT_MAX_CREDITS_PER_RUN`。迭代轮数另由
     * `effectiveMaxTurns` / `DEFAULT_MAX_TURNS`（200）约束。
     */
    executionLimits?: { max_iterations_per_run?: number; max_credits_per_run?: number },
    /**
     * Hilt v3 / W6 M2：用户在 Settings 切换的 yolo 真值。决定
     * `agentConfigV3.security.allow_yolo_mode` 初值（v3 PRD §5.1.1 改名）；
     * 后续切换由 handleQuery mutate session.agentConfigV3 + PD-13 工厂闭包实时反映。
     */
    yoloMode?: boolean,
    /**
     * Hilt v3 / W6 M2：客户端工作区快照（主控端 Electron 透传 / 缺省走 sandbox 兜底）。
     */
    workspaceSnapshot?: import('@tabtin/security-policy').WorkspaceSnapshot,
    /**
     * v0.1 BYOK：当前选中模型是否为 BYOK（provider_scope='organization'|'user'）。
     * 透传到 TabTinProxyProvider，让 503/429/401 错误分支区分 BYOK 与平台通道，
     * 给用户展示准确文案。不进入 cache key —— 通常伴随 modelId 切换，runtime
     * 会自然重建。
     */
    isByokMode?: boolean,
    /**
     * R4.2 (review fix)：当前 Space 启用的 App 能力图谱（Electron 同款，由远端
     * 客户端通过 Django forward payload 透传）。烘焙到 `<apps>` 段，让远程客户
     * 端的 Agent 知道当前 Space 能用哪些 App。缺省 → 跳过该段。
     */
    enabledApps?: ReadonlyArray<{ key: string; cliKey?: string; displayName: string; capability: string; aliases?: readonly string[] }>,
    /**
     * PRD §1.4 + DR-15（H5 修复）：当前 Space 是否 group 类型。
     *
     * 由 handleQuery → createRuntimeForSession 从 request.isGroupSpace 透传过来。
     * **createRuntimeForSession 写入 policyContext.isGroupSpace**——这正是
     * 修复 H5 fail-open 的关键点（之前硬编码 false，让 group Space + yolo
     * 互斥契约失效）。
     *
     * 缺省 undefined → 兜底 false（保留向后兼容：旧客户端 / mobile 主控端
     * 没传 is_group_space 时仍按非 group 处理，最终安全靠 yolo gate 兜底）。
     */
    isGroupSpace?: boolean,
    /**
     * W7c · Stage 4 Daemon 路径对齐：人类可读 Space / Organization 名。
     * 烘焙到 runtimeIdentity 让 ``<environment>`` 段显名而非裸 UUID。
     */
    spaceName?: string,
    organizationName?: string,
    /**
     * W7c · Stage 4 Daemon 路径对齐：CLI 工具命令清单文本。
     * Django 端透传非空时直接用；空时 ``createRuntimeForSession`` 内调
     * ``loadCLIReferenceAsync()`` 兜底（与 Electron 同款 spawn ``tabtin commands --format json``）。
     */
    cliReference?: string,
    /**
     * 分层规则·个人通用层（IA Phase 3 §8.6）：与 customRules 一起烘焙进
     * <custom_rules> 块（buildSystemPrompt），由 agent-prompt 指示分类合并。
     */
    personalRules?: string,
    /**
     * P0（file-history 跨进程统一）：稳定业务对话 threadId（forward 路径
     * = envelope.thread_id `chat-session-<uuid>`，整对话恒定）。用作 per-file
     * 回退账本 key，使创建侧与回退侧 action-bridge `_thread_id` 相交。缺省
     * （极端兜底）回落 `sessionId`，保持旧行为不崩。
     *
     * **只用于 file-history**——SnapshotStorage/EventStorage/SessionStorage/
     * ProxyProvider 仍按 `sessionId` 建 key（本次刻意不动会话存储路径，详见
     * getOrCreateFileHistory 调用处注释）。
     */
    threadId?: string,
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
     * `set` 顺序的隐式依赖（与 Electron `carryForwardSubagentManager` 对称）。
     * 未走 factory 的老直连路径缺省 `undefined` → 保底回落到既有
     * `host.sessions.get(sessionId)` 查询（对未迁移路径行为不变）。
     */
    carryForwardSubagentManager?: SubagentManager,
  ): Promise<{
    runtime: AgentRuntime;
    /**
     * P0（file-history 跨进程统一）：本次实际用于 getOrCreateFileHistory 的
     * key（= threadId ?? sessionId）。透出给 buildDaemonHostState 写入
     * DaemonHostState.businessThreadId / .fileHistoryThreadId 别名，reset
     * 据此对称 removeFileHistory。
     */
    fileHistoryThreadId: string;
    sessionStorage: SessionStorage;
    snapshotStorage: SnapshotStorage;
    eventStorage: EventStorage;
    /**
     * 工具调用日志 writer（per-Space tool-logs 目录）。spaceId 缺失或
     * ToolLogWriter 初始化失败时为 null —— 调用方调用前必须做 null 检查。
     */
    toolLogWriter: ToolLogWriter | null;
    toolProvider: DaemonToolProvider;
    engineConfig: EngineConfig;
    /**
     * W1.2：NativeBackendSession + 关联 ExecutionBackend。feature flag 关闭
     * 或装配失败时为 null；query.ts 主路径不消费 —— 仅供 W2 Capability 装配。
     */
    backendBootstrap: NativeBackendBootstrapResult | null;
    /**
     * Hilt v3 / W6 M2：构造 toolProvider / agentConfigV3 时 new 出的 v3 工件，
     * 透出供 createRuntimeForSession 写入 DaemonHostState（buildJudgePolicy 闭包
     * 通过 DaemonHostState 持有的引用实时读取最新 yolo / workspace）。
     */
    agentConfigV3: import('@tabtin/security-policy').AgentConfigV3;
    workspaceSnapshotV3: import('@tabtin/security-policy').WorkspaceSnapshot;
    /**
     * YOLO 两步授权 PRD v3 §5.5.2：buildJudgePolicy 闭包派生 effectiveMode
     * 所需的两个入参容器。透出给 createRuntimeForSession 写到 HostState（与 Electron 同构）。
     */
    policyContext: DaemonHostState['policyContext'];
    /** W4a S1：session 维度子 Agent 登记中心，透出给 createRuntimeForSession 写 HostState。 */
    subagentManager: DaemonHostState['subagentManager'];
    /** W4a S2：子 Agent 实时流 session 级出口，透出给 createRuntimeForSession 写 HostState。 */
    subagentStreamSink: DaemonHostState['subagentStreamSink'];
    eventEmitter: DaemonHostState['eventEmitter'];
  }> {
    if (!owner) {
      throw new Error('createRuntimeForSession: owner is required (LH2-D3)');
    }
    const assembleFoundation = async () => {
    const token = this.ports.getAccessToken();
    if (!token) {
      throw new Error('Not authenticated — cannot create agent runtime');
    }

    const apiBase = deriveApiBaseUrl(this.ports.config.server_url);
    const proxyUrl = joinApiPath(apiBase, '/llm/proxy');

    // W5 fix: compute model capabilities before provider so it gets correct
    // cacheType (avoids spurious cache_control on OpenAI/DeepSeek models).
    // W6: catalog 现在提供全部 7 个字段，不再只覆盖 2 个。
    const catalogEntry = this.ports.resolveModelFromCatalog(modelId);
    const ctxWindow = catalogEntry.contextWindowTokens;
    const maxOutput = catalogEntry.maxOutputTokens;
    const modelCaps: ModelCapabilities = {
      contextWindowTokens: ctxWindow,
      maxOutputTokens: maxOutput,
      maxInputTokens: ctxWindow,
      supportsVision: catalogEntry.supportsVision,
      supportsFunctionCalling: catalogEntry.supportsFunctionCalling,
      supportsPromptCaching: catalogEntry.supportsPromptCaching,
      cacheType: catalogEntry.cacheType,
      reasoningHistoryPolicy: catalogEntry.reasoningHistoryPolicy,
    };
    // 子 Agent 模型自由度（Phase 3/4）：当前 organization 的「可用模型菜单」快照。
    const modelCatalog = this.ports.buildModelCatalogSnapshot();

    const provider = new TabTinProxyProvider({
      proxyUrl,
      deviceToken: async () => {
        const t = this.ports.getAccessToken();
        if (!t) throw new Error('Token expired — re-authentication required');
        return t;
      },
      agentId,
      // §17.6 D4：ProxyProviderConfig.sessionId → threadId（业务对话 thread）。
      threadId: sessionId,
      organizationId: this.ports.config.organization_id,
      modelCapabilities: modelCaps,
      // 长上下文档位（Daemon 模式）：每次 LLM 调用前从 sessionContextTiers 读最新值，
      // 由外部 agent 协议消息或 control API 写入；不强求 daemon 此版支持切档，
      // 提供 hook 让上层（CLI、API）后续接入。
      contextTierId: () => this.ports.session.state.getContextTier(sessionId),
      isByokMode,
    });

    // owner 由调用方（buildDaemonHostState，经 RuntimeSessionFactory.resolve 透传 build context）注入，缺失抛错。
    // W6a：会话存储束下沉到 agent-host（双端共享）。
    // （硬切）：dataRoot + owner.userId 是唯一路径来源——owner 已在
    // 函数入口校验非空（LH2-D3），不再回落 legacy platformDataRoot。
    const dataRoot = resolveDataRoot();
    const organizationId = this.ports.config.organization_id || undefined;
    if (!organizationId || !spaceId) {
      throw new Error(
        'createRuntimeForSession requires organizationId+spaceId ( hard-cut — no _unscoped)',
      );
    }
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
      archiveThreadId: sessionId,
      sessionConfigThreadId: sessionId,
      toolLogSessionId: sessionId,
      dataRoot,
      userId: owner.userId,
      log: this.ports.logger,
    });

    // 确保当前用户 / 组织的 skills 目录已预装默认 skill（ 硬切：
    // ensureUserSkills + ensureOrganizationSkills，不再走 legacy ensureSpaceSkills）。
    const skillsModule = this.ports.skills.module();
    if (organizationId && skillsModule) {
      try {
        await skillsModule.ensureUserSkills(owner.userId);
        await skillsModule.ensureOrganizationSkills(owner.userId, organizationId);
      } catch (err) {
        this.ports.logger.warn(`[Skills] ensure skills dir failed for user=${owner.userId} wt=${organizationId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const host = this.ports;
    // W4a S2（2026-05-30）：子 Agent 实时流的 session 级统一出口（跨 query 存活，
    // 挂 DaemonHostState.subagentStreamSink）。与 Electron 对称——Daemon 无 sender
    // 概念（所有流走 gateway relay），故省略 sendToActiveClient。query 内表现与原
    // `emitStreamEvent`（仅 eventInterceptor 转发）一致；query 外（后台子，S5 接入）
    // 改走 `relaySubagentStreamEventDirect` 直接 gateway relay，不再 no-op 丢弃
    // （现状 query 外 emitStreamEvent 即 no-op，plan 第六节「致命 1」之一）。
    const subagentStreamSink = createSubagentStreamRouter({
      getInQueryRelay: () => host.session.sessions.get(sessionId)?.eventInterceptor,
      relayOutOfQuery: (event) => host.relaySubagentStreamEventDirect(sessionId, event),
      log: (msg, err) => host.logger.warn(`[subagent-sink] ${msg}${err ? ` ${String(err)}` : ''}`),
    });
    // emitStreamEvent 经 HostState 上的 sink 统一入口；sessions.set 之前的极小
    // 窗口 fallback 到本地 const（行为同上，零差异）。
    const rawStreamSink = (event: StreamEvent): void => {
      const sink = host.session.sessions.get(sessionId)?.subagentStreamSink ?? subagentStreamSink;
      sink(event);
    };
    const runtimeEventEmitter = new EventEmitter(rawStreamSink, {
      threadId: sessionId,
    });
    const emitStreamEvent = (event: StreamEvent): void => runtimeEventEmitter.emitStream(event);

    // W7a：HITL 超时语义统一 —— 与 Electron `ElectronAgentHost.waitForUserInput`
    // 完全对齐：超时只删除 pending（不 resolve），让外层 abortController.abort()
    // 或 dispose 兜底解 promise。
    //
    // 旧 Daemon 实现是 `resolve({ cancelled: true, reason: 'timeout' })`：调用方
    // （tool 内部）拿到 cancelled 后语义不明（用户主动取消？超时？还是 host stop？），
    // 与 Electron 永不 resolve 的行为不一致 → Agent 行为漂移。
    //
    // 新行为：超时静默删除 pending。如果调用方还在 await，就一直挂着——直到：
    //   1. 用户重发消息：handleQuery 进入新一轮，旧轮的 abortController.abort() 解 await；
    //   2. handleAbort 触发：runningSessions.delete + abortController.abort()；
    //   3. host.stop() 触发：所有 pending 通过 stop() 末尾的 resolve({cancelled:true})
    //      路径解开。
    // 这样 cancelled 语义专属"用户主动取消 / host stop"，超时不污染该信号。
    const waitForUserInput = (requestId: string): Promise<unknown> => {
      const scheduled = this.ports.session.state.getInteractionMode(sessionId) === 'scheduled';
      return this.ports.session.getHost().interactions.waitForInput({
        requestId,
        conversationId: sessionId,
        timeoutMs: PENDING_INPUT_TIMEOUT_MS,
        unavailableReason: scheduled
          ? 'Unattended (scheduled) session: no human available to answer HITL request; failing fast'
          : undefined,
      });
    };

    // FR-17.1：从 env 读取 per-parent 子 Agent 并发上限，注入 BudgetTracker。
    // 默认 5；env `TABTIN_MAX_CONCURRENT_CHILDREN=unlimited` 可显式禁用。
    const maxConcurrentChildren = resolveMaxConcurrentChildren(process.env, this.ports.logger);
    const maxSubagentQueue = resolveMaxSubagentQueue(process.env, this.ports.logger);
    const subagentResultCompact = resolveSubagentResultCompact(process.env, this.ports.logger);
    // W4 (2026-05-26)：与 Electron 对称——BudgetTracker 同时接 active 上限 + queue 上限。
    // W4a S3③（PR2 review P1 修复，与 Electron 对称）：硬重建时若旧 Manager 仍有
    // 后台子在跑，复用旧 tracker（后台子与新子计入同一并发账本），避免击穿 maxActive。
    // factory 硬重建路径下 `host.sessions` 已在 build 前被摘除，必须优先取 factory
    // 通过 `carryForward` 透传下来的旧 Manager；未走 factory 的兜底路径继续用
    // `host.sessions.get()` 查询（保底行为不变）。
    // W4a S3③（PR2 review P1 修复）—— resolveSubagentCarryForward 是双端共享
    // SSoT（`@tabtin/agent-host/runtime`），把 existing / hasBackgroundRuns()
    // / dispose 判定 + budgetTracker 条件复用统一收拢，避免与 Electron 漂移。
    // 详见 `packages/agent-host/src/runtime/subagent-carry-forward.ts` 头注释。
    // W4a S5（2026-05-30）：完成回调投递句柄（与 Electron 对称）——子终态经
    // Manager.notifyCompleted 入本 host 的 NotificationQueue 跨 turn 唤醒主 Agent。
    const deliverablesEnricherDeps = {
      sessionConfig,
      flushParentMessageBlocks: () => sessionStorage.blockStorage.flushPendingWrites(),
    };
    const enqueueSubagentCompletionRaw: EnqueueSubagentCompletion = (info) => {
      // ：spaceId 取值与 query 路径对齐——优先 live session 的 HostState.spaceId
      // （随 runtime 重建更新），再回落 SubagentManager 构造期只读快照、装配期快照
      // （Daemon 无 CLI 上下文，cliSpaceIdFallback=null）。
      // 注意顺序：liveEntry.spaceId 必须先于 subagentManager.spaceId——后者是构造期
      // readonly 字段，carry-forward 复用时不随 runtime 重建更新，Space 切换硬重建后
      // 仍是旧值。派生走 `resolveSubagentCompletionSpaceId`（`@tabtin/agent-host/runtime`
      // SSoT），与 Electron 共享同一份决策。
      const liveEntry = host.session.sessions.get(sessionId);
      const effectiveSpaceId = resolveSubagentCompletionSpaceId({
        liveSpaceId: liveEntry?.spaceId,
        liveManagerSpaceId: liveEntry?.subagentManager?.spaceId,
        assemblySpaceId: spaceId,
        cliSpaceIdFallback: null,
      });
      if (!effectiveSpaceId) {
        this.ports.logger.warn(
          `[SubagentManager] notifyCompleted skipped: missing spaceId ` +
          `(thread=${sessionId} child=${info.subagent_run_id.slice(0, 8)}…)`,
        );
        return false;
      }
      // ：null-safe bridge 解析——resolvePtyManagerBridge 返回 PtyManagerBridge | null，
      // 旧写法 `bridge.getNotificationQueue` 在 null 时抛 TypeError 被 catch 静默吞掉；
      // 缺 queue 时打结构化日志（含 threadId/kind）便于排查。
      let queue: import('@tabtin/terminal-core').NotificationQueue | undefined;
      try {
        queue = this.ports.terminal.current()?.getNotificationQueue();
      } catch (err) {
        this.ports.logger.error(
          `[SubagentManager] notifyCompleted enqueue error: bridge resolve threw ` +
          `(thread=${sessionId} kind=subagent-completed child=${info.subagent_run_id.slice(0, 8)}…): ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
      if (!queue) {
        this.ports.logger.warn(
          `[SubagentManager] notifyCompleted skipped: notification queue unavailable ` +
          `(thread=${sessionId} kind=subagent-completed child=${info.subagent_run_id.slice(0, 8)}…)`,
        );
        return false;
      }
      return queue.enqueue(buildSubagentCompletionEnvelope(info, { spaceId: effectiveSpaceId, threadId: sessionId }));
    };
    const enqueueSubagentCompletion = wrapEnqueueSubagentCompletionWithDeliverables(
      enqueueSubagentCompletionRaw,
      deliverablesEnricherDeps,
    );

    // W4a S1（2026-05-30）：session 维度子 Agent 登记中心（与 Electron 对称）。
    // 挂到 DaemonHostState，agent-tool active 子 spawn 时双写登记（模块级
    // activeChildren 保留给 W0 取消链路），host.stop() / session 销毁时 dispose
    // 只取消本 session 的子。
    //
    // W4a S3③（PR2）：runtime 重建时 **无条件 carry-forward 同一 Manager** 而非
    // dispose（避免误杀后台子）——host.sessions 此刻仍持旧 entry，复用其 Manager，
    // 下方 rebindLiveDeps 灌入新 runtime 的 live 依赖。budgetTracker 的 carry-forward
    // 是条件式（仅有后台子时，见上方）。详见 Electron 同段注释。
    // 决策统一走 `resolveSubagentCarryForward`（`@tabtin/agent-host/runtime` SSoT）。
    const carryForwardResolved = resolveSubagentCarryForward({
      carryForwardSubagentManager: carryForwardSubagentManager as unknown as SubagentManagerLike | undefined,
      liveSessionManager: host.session.sessions.get(sessionId)?.subagentManager as unknown as SubagentManagerLike | undefined,
      maxConcurrentChildren,
      maxQueueSize: maxSubagentQueue,
      createBudgetTracker: ({ maxConcurrentChildren: mcc, maxQueueSize: mqs }) =>
        new BudgetTracker({ maxConcurrentChildren: mcc, maxQueueSize: mqs }),
      createSubagentManager: ({ parentThreadId, spaceId: sid, budgetTracker: bt, enqueueNotification }) =>
        new SubagentManager({
          parentThreadId,
          spaceId: sid,
          budgetTracker: bt,
          enqueueNotification: enqueueNotification as unknown as EnqueueSubagentCompletion,
          log: (msg, err) => this.ports.logger.warn(`[SubagentManager] ${msg}${err ? ` ${String(err)}` : ''}`),
        }),
      parentThreadId: sessionId,
      spaceId,
      enqueueNotification: enqueueSubagentCompletion as unknown as (...args: unknown[]) => boolean,
    });
    const budgetTracker = carryForwardResolved.budgetTracker;
    // Manager 一律是 SubagentManager——SubagentManagerLike 是 SSoT 的窄口，
    // 这里 as 回具体类型让下游 rebindLiveDeps / dispose 等方法可用。
    const subagentManager = carryForwardResolved.subagentManager as SubagentManager;

    // W6a：ApprovalMemo + permission handler + UserInteractiveChannel 下沉到
    // agent-host（双端共享）。Daemon 仅注入 apiBase / token / LocalPermissionHandler。
    if (!workspaceId) {
      throw new Error('assemblePermissionShell: workspaceId is required');
    }
    const {
      permissionMemoStore,
      permissionHandler,
      userInteractiveChannel,
    } = assemblePermissionShell({
      sessionId,
      workspaceId,
      apiBaseUrl: apiBase,
      getAuthToken: () => this.ports.getAccessToken(),
      emitStreamEvent,
      waitForUserInput,
      runtimeMode: this.ports.session.state.getInteractionMode(sessionId) ?? 'interactive',
      interactiveThreadId: sessionId,
      log: this.ports.logger,
      registerApprovalMemo: (memo) => {
        this.ports.session.getHost().registerApprovalMemo(memo);
      },
      createPermissionHandler: (options) =>
        new LocalPermissionHandler({
          ...options,
          onLog: (level, message) => {
            if (level === 'warn') this.ports.logger.warn(message);
            else this.ports.logger.info(message);
          },
        }),
    });

    return {
      token, apiBase, provider, modelCatalog, ctxWindow, maxOutput, modelCaps, dataRoot, organizationId, sessionDir, toolLogsDir,
      sessionStorage, snapshotStorage, eventStorage, toolLogWriter, toolResultStorage, sessionConfig,
      host, subagentStreamSink, runtimeEventEmitter, emitStreamEvent, waitForUserInput,
      maxConcurrentChildren, maxSubagentQueue, subagentResultCompact, budgetTracker, subagentManager, enqueueSubagentCompletion,
      permissionMemoStore, permissionHandler, userInteractiveChannel,
    };
    };
    const foundation = await assembleFoundation();
    const {
      token, apiBase, provider, modelCatalog, ctxWindow, maxOutput, modelCaps, dataRoot, organizationId, sessionDir, toolLogsDir,
      sessionStorage, snapshotStorage, eventStorage, toolLogWriter, toolResultStorage, sessionConfig,
      host, subagentStreamSink, runtimeEventEmitter, emitStreamEvent, waitForUserInput,
      maxConcurrentChildren, maxSubagentQueue, subagentResultCompact, budgetTracker, subagentManager, enqueueSubagentCompletion,
      permissionMemoStore, permissionHandler, userInteractiveChannel,
    } = foundation;

    const assembleSkills = async () => {
    const dynamicResolveContextWindow = (mid: string): number =>
      this.ports.resolveModelFromCatalog(mid).contextWindowTokens;

    // FR-15 H3-A Review P1：iterationBudget 解析提前到 toolProvider 创建之前
    // （与 Electron 同模式），让 agentToolDeps.iterationBudget 透传到子 Agent。
    const iterationBudget = resolveIterationBudget(process.env, this.ports.logger);
    // W3 stall detector knobs（与 iterationBudget 同 ops 模式）。
    const toolFailureTracker = resolveToolFailureTracker(process.env, this.ports.logger);
    // FR-16 H3-B Review fix #7：reuse 配置同样提前，让 agentToolDeps 把 reuse
    // 配置透传到子 Agent，避免 A/B 测试时父子配置脱锚。
    const enableSummaryReuse = resolveSummaryReuse(process.env, this.ports.logger);
    const summaryReuseJudgeSampleRate = resolveSummaryReuseJudgeSampleRate(process.env, this.ports.logger);
    const summaryReuseJudgeWindowSize = resolveSummaryReuseJudgeWindowSize(process.env, this.ports.logger);
    const summaryReuseJudgeThreshold = resolveSummaryReuseJudgeThreshold(process.env, this.ports.logger);
    const summaryReuseMaxAgeMs = resolveSummaryReuseMaxAgeMs(process.env, this.ports.logger);
    const summaryReuseMinAddedMessages = resolveSummaryReuseMinAddedMessages(process.env, this.ports.logger);
    const timeBasedMicroCompact = resolveTimeBasedMicroCompact(process.env, this.ports.logger);
    //  压缩分档阈值：云端 AdminDash（prompt.forward 下发，已校验）>
    // env 旋钮 TABTIN_PRESSURE_THRESHOLDS > runtime 默认（与 Electron 对称）。
    // agentToolDeps 与 EngineConfig 复用同一份解析结果，父子触发线一致。
    const pressureThresholds = cloudPressureThresholds ?? resolvePressureThresholds(process.env, this.ports.logger);

    // Wave 3a N2：构建 skill 工具依赖（与 ElectronAgentHost 同构）。
    // 闭包捕获 `host` 引用惰性读 `skillsModule`——createRuntime 时 init 可能
    // 尚未完成，每次调用时才取最新值（和 Electron 的 hostRef 模式一样）。
    const skillsReady = this.ports.skills.ready();
    let personalPluginSkillSnapshot: PersonalPluginSkillSnapshot = {
      enabledPluginIds: [],
      skills: [],
    };
    if (spaceId && organizationId) {
      try {
        personalPluginSkillSnapshot = await loadEnabledPersonalPluginSkillSnapshot({
          dataRoot,
          userId: owner.userId,
          organizationId,
          spaceId,
          onWarn: (message) => this.ports.logger.warn(message),
        });
      } catch (err) {
        this.ports.logger.warn(`[PersonalPlugin] failed to load enabled plugin skill snapshot: ${(err as Error).message}`);
      }
    }
    const getPersonalPluginSkillsForContext = (ctx?: { spaceId?: string }) => {
      const targetSpaceId = ctx?.spaceId ?? spaceId;
      return targetSpaceId && targetSpaceId === spaceId
        ? personalPluginSkillSnapshot.skills
        : [];
    };
    const agentSkillEnablement = agentId?.trim()
      ? host.skills.enablementCache.forAgent(agentId)
      : null;
    if (!agentSkillEnablement) {
      this.ports.logger.warn(
        '[SkillEnablement] missing agentId; all Skills disabled (closed carry set)',
      );
    }
    const skillsToolsDeps: SkillsToolsDeps | undefined = skillsReady
      ? {
          getSkill: (key, ctx) => {
            const skill =
              getPersonalPluginSkillsForContext(ctx).find((s) => s.canonicalKey === key)
              ?? host.skills.module()?.registry.getByKey(key, { spaceId: ctx?.spaceId });
            if (!skill) return undefined;
            const map = agentSkillEnablement?.getSync();
            return isSkillEnabledByMap(skill, map) ? skill : undefined;
          },
          search: (q, opts, ctx) => {
            const registry = host.skills.module()?.registry;
            const map = agentSkillEnablement?.getSync();
            if (!registry) {
              return searchRuntimeSkills(getPersonalPluginSkillsForContext(ctx), q, opts)
                .filter((s) => isSkillEnabledByMap(s, map));
            }
            const baseSkills = ctx?.spaceId
              ? registry.listForSpace(ctx.spaceId)
              : registry.listAll();
            return searchRuntimeSkills(
              mergeSkillListsForRuntime(baseSkills, getPersonalPluginSkillsForContext(ctx)),
              q,
              opts,
            ).filter((s) => isSkillEnabledByMap(s, map));
          },
          // Tier-3：references/ examples/ 附属文档的清单 + 按需读取（skills_read path）。
          listSkillResources: (key, ctx) =>
            host.skills.module()?.registry.listResources(key, { spaceId: ctx?.spaceId }) ?? [],
          readSkillResource: (key, relPath, ctx) =>
            host.skills.module()?.registry.readResource(key, relPath, { spaceId: ctx?.spaceId }) ?? {
              ok: false,
              error: 'Skill registry 未就绪，无法读取附属文件。',
            },
          //  RB1：per-runtime 业务身份烘进 deps，工具不再从 ToolContext 读。
          spaceId,
          organizationId,
        }
      : undefined;
    const skillInvokeDeps: SkillInvokeDeps | undefined = skillsReady
      ? {
          getSkill: (key, ctx) => {
            const skill =
              getPersonalPluginSkillsForContext(ctx).find((s) => s.canonicalKey === key)
              ?? host.skills.module()?.registry.getByKey(key, { spaceId: ctx?.spaceId });
            if (!skill) return undefined;
            const map = agentSkillEnablement?.getSync();
            return isSkillEnabledByMap(skill, map) ? skill : undefined;
          },
          listSkillResources: (key, ctx) =>
            host.skills.module()?.registry.listResources(key, { spaceId: ctx?.spaceId }) ?? [],
          //  RB1：per-runtime 业务身份烘进 deps，工具不再从 ToolContext 读。
          spaceId,
          organizationId,
        }
      : undefined;
    // （硬切）：skill_create 改写到新布局
    // `{dataRoot}/users/{userId}/organizations/{orgId}/skills/`；spaceId 仅保留
    // 作为上下文兜底（不再参与路径计算）。缺少 Organization 上下文时显式失败，
    // 不再退回 legacy platform-data 目录。
    const skillCreateDeps: SkillCreateDeps | undefined = skillsReady
      ? {
          writeSkill: async (slug, content, ctx) => {
            const currentOrganizationId = ctx?.organizationId ?? organizationId;
            if (!currentOrganizationId) {
              throw new Error('缺少 Organization 上下文，无法创建 Skill。请在具体组织中重新发起请求。');
            }
            const dir = resolveOrganizationSkillDir(
              resolveDataRoot(),
              owner.userId,
              currentOrganizationId,
              slug,
            );
            await mkdir(dir, { recursive: true });
            const filePath = join(dir, 'SKILL.md');
            const { writeFile } = await import('node:fs/promises');
            await writeFile(filePath, content, 'utf-8');
            return filePath;
          },
          //  / ：Skill HTTP 只认 organization_id + agent_id，禁止再传 space_id。
          registerSkill: async (params) => {
            const token = host.getAccessToken();
            if (!token) return { error: '未登录，无法注册 Skill', status: 401 };
            const regApiBase = deriveApiBaseUrl(host.config.server_url);
            const url = joinApiPath(regApiBase, '/skills/create');
            const body: Record<string, unknown> = {
              organization_id: params.organizationId,
              name: params.name,
              description: params.description,
              slug: params.slug,
              emoji: params.emoji || '',
            };
            if (params.agentId) {
              body.agent_id = params.agentId;
              // 创建即挂载到当前对话 Agent（对齐 UI CreateSkillDialog 的 enable_agent_ids 契约）。
              body.enable_agent_ids = [params.agentId];
            }
            const resp = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify(body),
            });
            if (!resp.ok) {
              const text = await resp.text().catch(() => '');
              let parsed: unknown = { error: text };
              try {
                parsed = JSON.parse(text);
              } catch {
                // keep plain text envelope
              }
              return {
                error: `API ${resp.status}: ${text.slice(0, 200)}`,
                status: resp.status,
                body: parsed,
              };
            }
            const json = await resp.json();
            const data = json?.data ?? json;
            return { skill_id: data?.skill_id, slug: data?.slug };
          },
          //  RB1：per-runtime 业务身份烘进 deps，工具不再从 ToolContext 读。
          spaceId,
          organizationId,
          agentId,
        }
      : undefined;

    // Wave 1.5 PROD-3：Skill 运行时密钥注入 resolver（Daemon 端）。
    //
    // 与 Electron 一致的设计——resolver 与 runtime 同生命周期（token
    // 快照从 this.ports.getAccessToken() 取）。session 重建（persona / mode /
    // owner 切换）会自动触发 resolver 重建，cache 随之丢弃；下次 query
    // 拿最新 token。Daemon 没有 UI"改完密钥刷新缓存"入口（Wave 5
    // Electron UI 才接），此处依靠 5min TTL 兜底——用户在网页端改了
    // Skill 绑定后最长 5 分钟生效（运维可接受）。
    //
    // getApiAuthToken 用 getter：Daemon token 可能在 session 期间被
    // gateway 刷新，共享 resolver 的每次 HTTP 调用都会取最新值。
    //
    // resolver 自带"无 token → 返回 null"降级，所以即便启动期 JWT 不
    // 可用也不会抛错——run_terminal_command 工具拿到 null 继续走 SYSTEM_NOTICE 路径。
    const skillCredentialLogger: SkillCredentialResolverLogger = {
      debug: (message, fields) => {
        if (fields) this.ports.logger.debug(`[SkillCredential] ${message}`, fields);
        else this.ports.logger.debug(`[SkillCredential] ${message}`);
      },
      info: (message, fields) => {
        if (fields) this.ports.logger.info(`[SkillCredential] ${message}`, fields);
        else this.ports.logger.info(`[SkillCredential] ${message}`);
      },
      warn: (message, fields) => {
        if (fields) this.ports.logger.warn(`[SkillCredential] ${message}`, fields);
        else this.ports.logger.warn(`[SkillCredential] ${message}`);
      },
    };
    const skillCredentialResolverHandle = createSkillCredentialResolver({
      apiBaseUrl: apiBase,
      getApiAuthToken: () => this.ports.getAccessToken(),
      organizationId: this.ports.config.organization_id,
      logger: skillCredentialLogger,
    });
    // Wave 2a 补丁 P0-2（独立质疑 2）：把 handle 注册到 per-session Map，让
    // Wave 5 IPC 调 invalidateSkillCredentialCaches 时能遍历**所有**活跃 session
    // 的 resolver 一并清除 cache，而不是只清到最近一次构造的那个。
    this.ports.session.state.setCredentialResolver(sessionId, skillCredentialResolverHandle);

    // OS 访问错误 Organization 级共享黑名单（进程内生命周期）。
    // organizationId 来自 resolveOwner / DaemonConfig.organization_id 的宿主认证上下文；
    // ToolProvider 与 EngineConfig 共享同一实例，保证 clear 与 block 同源。
    const osErrorBlacklist = getSharedOSErrorBlacklist(owner.organizationId);

    return {
      dynamicResolveContextWindow, iterationBudget, toolFailureTracker, enableSummaryReuse,
      summaryReuseJudgeSampleRate, summaryReuseJudgeWindowSize, summaryReuseJudgeThreshold,
      summaryReuseMaxAgeMs, summaryReuseMinAddedMessages, timeBasedMicroCompact, pressureThresholds,
      skillsReady, agentSkillEnablement, getPersonalPluginSkillsForContext, skillsToolsDeps, skillInvokeDeps, skillCreateDeps,
      skillCredentialResolverHandle, osErrorBlacklist,
    };
    };
    const skillAssembly = await assembleSkills();
    const {
      dynamicResolveContextWindow, iterationBudget, toolFailureTracker, enableSummaryReuse,
      summaryReuseJudgeSampleRate, summaryReuseJudgeWindowSize, summaryReuseJudgeThreshold,
      summaryReuseMaxAgeMs, summaryReuseMinAddedMessages, timeBasedMicroCompact, pressureThresholds,
      skillsReady, agentSkillEnablement, getPersonalPluginSkillsForContext, skillsToolsDeps, skillInvokeDeps, skillCreateDeps,
      skillCredentialResolverHandle, osErrorBlacklist,
    } = skillAssembly;

    // Hilt v3 / W6 M2：构造可变 v3 工件，让 buildJudgePolicy 闭包持有引用。
    //
    // workspace 优先级：
    //   1. 主控端 Electron 通过 prompt.forward 透传的 WorkspaceSnapshot
    //      （含用户在 TabCode/TabFolder 打开的目录、附件等）；
    //   2. fallback：Daemon 自己的 sandbox 目录（DaemonConfig.workspace_root），
    //      与 Electron 缺省走 `workspaceRoot ?? sessionDir` 的兜底语义对齐。
    //
    // session.workspaceSnapshot / session.agentConfigV3 持有这两个对象的同一
    // 引用；handleQuery 入口 mutate 让 PD-13 工厂闭包当下读到新值，无需重建
    // runtime。spaceSessionId 取 sessionId 兜底（与 Electron 同模式）。
    const assemblePolicy = async () => {
    const fallbackWorkspaceRoot = this.ports.workspaceRoot ?? sessionDir;
    // Internal tool-output 白名单：`tabtinAgentTasksDir()` 是
    // `run_terminal_command` 后台执行链路写 `output_file` 的固定位置
    // （`packages/terminal-core/src/agent-output-tail.ts`），工具自创中间产物，
    // 子 Agent / yolo / 普通 mode 任何路径调 read_file 都该放行——跟 Electron
    // `deriveAllowedPathsFromSources` SSoT 对称（dogfood 314d7f23 修复）。
    const internalAgentTasksDir = tabtinAgentTasksDir();
    const workspaceSnapshotV3: import('@tabtin/security-policy').WorkspaceSnapshot = workspaceSnapshot ?? {
      sources: {
        sandbox: fallbackWorkspaceRoot,
        // 单根契约：daemon 自启动 fallback 没有 user working_dir，留空让 derive
        // 退化到 sandbox-only。主控端 forward 的 snapshot 会带 workingDir。
        workingDir: '',
        sessionApprovedPaths: [],
        attachedFiles: [],
      },
      allowedPaths: [fallbackWorkspaceRoot, internalAgentTasksDir],
      allowedFiles: [],
      spaceSessionId: sessionId,
    };
    // v3 PRD §5.1.1：DB 字段改名 yolo_mode → allow_yolo_mode（Agent 级 gate）。
    const agentConfigV3: import('@tabtin/security-policy').AgentConfigV3 = {
      schema_version: 3,
      runtime_plane: 'local',
      security: { allow_yolo_mode: yoloMode === true },
      capabilities: executionLimits ? {
        overrides: {
          cost: {
            execution_limits: {
              max_iterations_per_run: executionLimits.max_iterations_per_run,
              max_credits_per_run: executionLimits.max_credits_per_run,
            },
          },
        },
      } : undefined,
    };

    // YOLO 两步授权 PRD v3 §5.5.2：buildJudgePolicy 闭包除 agentConfigV3 /
    // workspaceSnapshotV3 外还需要 requestedAgentMode + isGroupSpace 两个派生入参。
    // 与 ElectronAgentHost 同款"宿主 mutate / runtime read"可变源（详见 Electron
    // policyContext 注释）。
    //
    // PR4-yolo H5 修复（2026-05-19）：之前 isGroupSpace 硬编码 false fail-open
    // 让 group Space + yolo 互斥契约在 daemon 路径全程失效；现从 wire payload
    // 通过 request.isGroupSpace 透传（Django 始终从 Space.type 派生写入，任务 1），
    // 缺省 undefined 时 `!!isGroupSpace === false` 与历史 fail-safe 等价兜底。
    const policyContext: DaemonHostState['policyContext'] = {
      currentAgentMode: agentMode,
      isGroupSpace: !!isGroupSpace,
    };

    // **W5 L36（2026-05-14）**：daemon 端 read-before-edit / image / localDoc dedup
    // 跨工具共享状态。提前 new 一次，让下方 EngineConfig 与 agentToolDeps **共享
    // 同一引用** —— 与 Electron 同款 W2.1 收尾 fix-8 模式（详见
    // ElectronAgentHost.ts：4267-4279 注释 + W1 第一轮 Review BUG-1 / W2.1 Review 3
    // fix-8 教训）。
    //
    // 历史 BUG（W1 / W2 沿用至 W4）：daemon 的 EngineConfig.{readFileState,
    // imageReadFileState, localDocReadFileState} 用 inline `new Map()`，且
    // `agentToolDeps` 完全不传这三件套。子 Agent fork 时
    // `agent-tool.ts::executeChildAgent` 取 `config.readFileState/...` 是 undefined
    // → forkQuery 拿到 undefined → 子 EngineConfig 拿到 undefined dedup state
    // → 子 Agent 反复 read 父 Agent 已读过的文件，bypass W2 dedup 主线收益。
    // Electron W1 已修但 daemon 沿用同款 BUG，§七 L36 跟踪到 W5 收。
    const readFileState: import('@tabtin/agent-runtime/engine').ReadFileState = new Map();
    const imageReadFileState: import('@tabtin/agent-runtime').ImageReadFileState = new Map();
    const localDocReadFileState: import('@tabtin/agent-runtime').LocalDocReadFileState = new Map();

    // per-file 回退引擎（替代 shadow git）：按**稳定 threadId** 取/建 **per-thread**
    // 实例（与 per-query 新建的 readFileState 不同——同一 thread 多轮 query 复用同实例
    // 让 snapshots 累积、跨轮回退找得到 anchor）。
    //
    // P0（file-history 跨进程统一）修复：此前用 `sessionId` 当 key，但 forward 入口
    // 的 sessionId = `payload.task_id`（`prompt_<uuid12>`，**每轮 prompt 都变**），
    // 导致 ① 每轮新建 sha256 目录、跨轮快照永不累积；② 回退侧
    // `action-bridge.file_history_rewind` 用 envelope 已认证的 `_thread_id`（= 稳定
    // thread）取账本，与写键永不相交 → Daemon 会话回退 100% 失败。改用稳定
    // `threadId`（forward = envelope.thread_id；drain/push 路径 sessionId 本就 =
    // threadId，无变化）→ 创建键 == 回退键。threadId 缺省（极端兜底）回落 sessionId，
    // 保持旧行为不崩。**仅 file-history 改键**，会话存储（Snapshot/Event/Session/
    // ProxyProvider）仍按 sessionId，本次刻意不动。
    //
    // 与下方 EngineConfig + agentToolDeps 共享同一引用，子 Agent fork 落同一账本。
    // workspaceRoot 仅用于相对路径压缩，缺省回落 sessionDir（fallbackWorkspaceRoot，
    // 与 Electron `workspaceRoot ?? sessionDir` 对称）。
    //
    // 兜底用**非空判定**而非 `??`：forward 入口（daemon.ts）在 envelope 缺
    // `thread_id` 时给的是空字符串 `''`（不是 undefined），`??` 不会回落 → 会拿
    // 空串当 key。这里用 `threadId && threadId.length > 0` 同时挡住 undefined 与
    // 空串，回落 sessionId 保持旧行为不崩。
    const fileHistoryThreadId = threadId && threadId.length > 0 ? threadId : sessionId;
    const fileHistory = await getOrCreateFileHistory(fileHistoryThreadId, fallbackWorkspaceRoot);

    //  Stage 3a：工具风险判决端口（security-policy judge 留在宿主）。
    const judgeHomeDir = process.env.HOME || process.env.USERPROFILE;
    const judgeMemoAdapter = createJudgeMemoStoreAdapter(permissionMemoStore);
    const toolRiskPolicy = createToolRiskPolicyPort({
      buildEffectivePolicy: () => buildPolicyFromAgentConfigV2(
        agentConfigV3,
        workspaceSnapshotV3,
        {
          planModeGuardActive: isPlanModeGuardActive(policyContext.currentAgentMode),
          requestedApprovalMode: policyContext.requestedApprovalMode,
          requestedAgentMode: policyContext.currentAgentMode,
          isGroupSpace: policyContext.isGroupSpace,
          unattended: this.ports.session.state.getInteractionMode(sessionId) === 'scheduled',
        },
      ),
      memoStore: judgeMemoAdapter,
      homeDir: judgeHomeDir,
    });

    // ：主 runtime 使用 todo nudge；子 Agent 不维护独立待办，
    // 因此 agentToolDeps 不注入该端口。
    const systemPromptProvider = createSystemPromptProvider();
    const todoCompletionNudgeProvider = createTodoCompletionNudgeProvider();
    //  / ：todo execute 与 state hook 共用会话锚（抗上下文截断）。
    const todoSessionAnchor: TodoSessionAnchor = { current: null };

    const toolProvider = new DaemonToolProvider({
      runDocParserTask: this.ports.runDocParserTask,
      securityPreset: authorizationPreset,
      // Hilt v3：注入 v3 工件，让 DaemonToolProvider 在构造时也能 `buildPolicy*`
      // 一次（与 ElectronToolProvider 同模式）。注：DaemonToolProvider 内部目前
      // 仍把这份初值缓存为 effectivePolicyV3 字段（未来 M5/M6 清理），但本 wave
      // 主决策路径走 EngineConfig.buildJudgePolicy，缓存只供调试 / 一致性兜底。
      agentConfigV3,
      workspaceSnapshot: workspaceSnapshotV3,
      // YOLO 两步授权 PRD v3 §5.5.2：让 ToolProvider 构造期派生 effectivePolicyV3
      // 时也参与 effectiveMode 三方 AND（与主判决闭包口径一致）。
      isGroupSpace: policyContext.isGroupSpace,
      disabledApps,
      disabledToolPrefixes,
      emitStreamEvent,
      todoSessionAnchor,
      apiBaseUrl: apiBase,
      apiAuthToken: token,
      organizationId: this.ports.config.organization_id,
      spaceId,
      sessionId,
      agentId,
      agentMode,
      //  WP2 / ：与 MemoryHook 同口径——仅显式 true 才挂 memory_search/write。
      memoryEnabled: memoryCapability === true,
      logger: this.ports.logger,
      toolResultStorage,
      // Wave 3a N2：注入 skill 依赖（与 ElectronToolProvider 对齐）。
      skillsDeps: skillsToolsDeps,
      skillInvokeDeps,
      skillCreateDeps,
      // Wave 1.5 PROD-3：Skill 运行时密钥注入（与 Electron 对齐）。
      skillCredentialResolver: skillCredentialResolverHandle.resolver,
      // OS 访问错误黑名单 + 自重启实现 —— Daemon 没有 Electron `app.relaunch()`，
      // 这里默认不暴露重启工具：launchd 重启策略由部署者通过外部 plist 控制，
      // Agent 不应擅自决定重启 daemon 进程。Agent 收到 OS 错误时仍能按
      // userGuidance 引导用户去系统设置授权，授权后让 daemon 在下次健康检查
      // 自动 reload 即可（关闭后 launchd ThrottleInterval=30s 后自动拉起）。
      osErrorBlacklist,
      agentToolDeps: {
        provider,
        permissionHandler,
        sessionConfig,
        model: modelId,
        // ：子 Agent 透传同一 untrusted 判定，避免父可子不可（fence 缺口）。
        isUntrustedShellCommand,
        budgetTracker,
        // W4a S1：透传 session 维度 SubagentManager（与 Electron 对称），让
        // agent-tool 双写登记 active 子（模块级 activeChildren 保留给 W0）。
        subagentManager,
        osErrorBlacklist,
        // **W5 L36（2026-05-14）**：与 EngineConfig 共享同一引用让父→子 fork
        // 透传 dedup state，详见上方 const 声明注释。Electron 同款 W1 / W2.1 收尾
        // 已修，daemon 沿用 BUG 到 W5 收。
        readFileState,
        imageReadFileState,
        localDocReadFileState,
        // per-file 回退引擎：与下方 EngineConfig 共享同一实例，agent-tool fork 子
        // Agent 时透给子（forkQuery 共享不 clone），子改的文件进同一回退账本。
        fileHistory,
        workspaceRoot: this.ports.workspaceRoot,
        toolResultStorage,
        // Phase 3：父值仅作「无目录 / 命不中」兜底；子 Agent 实际能力由
        // agent-tool 按 childModel 从 modelCatalog 解析（不再无脑继承父）。
        contextWindowTokens: ctxWindow,
        maxOutputTokens: maxOutput,
        modelCapabilities: modelCaps,
        // Phase 3/4：注入「可用模型菜单」快照（复用 W1b catalog 缓存，已 tier 过滤）。
        // agent 工具据此渲染清单 + 按子模型解析能力 + 命不中确定性降级。
        modelCatalog,
        // W7a：子 agent 继承父 mode，保持工具过滤 + plan-mode-guard 行为一致。
        agentMode,
        //  Stage 2b：子 Agent system prompt 重烘焙经宿主端口，
        // runtime 不再直接 import @tabtin/agent-prompt。
        systemPromptProvider,
        // FR-17.2：子 Agent 完成时是否对 summary 做 microCompact（默认 true）。
        subagentResultCompact,
        // FR-15 (H3-A Review P1)：子 agent 透传同一份 iterationBudget，
        // 避免子级走默认而与父级宿主 env 配置脱锚。
        iterationBudget,
        // W3：子 agent 透传同一份 stall detector 配置（与 iterationBudget 同模式）。
        toolFailureTracker,
        // W0-2（2026-05-26 总控）：子 agent 透传父级 userInteractiveChannel
        // 引用——与 Electron 端对齐。原本 daemon 端 agentToolDeps 漏透此字段，
        // 导致 forkQuery 内部走 `createSubagentUserInteractiveChannel(undefined, ...)`
        // 返回 undefined → 子 Agent 调 ask_user / 写授权等 judge ask 决策时
        // permissions/judge-pipeline.ts 走 fail-closed deny + 文案「no
        // UserInteractiveChannel is wired」，造成父对话能弹审批、子任务工具
        // 全自动拒绝的体验割裂。Daemon 路径下父级 channel 由 assemblePermissionShell
        // 桥接到 LocalPermissionHandler，与 EngineConfig.userInteractiveChannel 共用同一引用。
        userInteractiveChannel,
        //  Phase 1：readonly 子 Agent 的 mode-reminder 注入由宿主提供
        // （原 fork-query 硬编码的「ask 模式」reminder 已迁到宿主内容包）。
        // 只有 readonlySubagent=true 时 fork-query 才会调用它，注入 ask 模式 reminder。
        buildReadonlySubagentHooks: () =>
          buildModeReminderHook({ getAgentMode: () => 'ask' }),
        // FR-16 H3-B Review fix #7：子 agent 透传 reuse 配置避免 A/B 测试时
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
        // —— 与上方 EngineConfig.waitForUserInput / LocalPermissionHandler 共用同一闭包，
        // 共享 `pendingUserInputRequests` map（同一 requestId 由父端响应回填）。
        // 子 Agent 通过 `createSubagentWaitForUserInput(config.waitForUserInput)`
        // 拿到包装函数（挂起计数 + 超时兜底）而非抛错 stub，ask 用户工具
        // HITL 工具能真正经父 Agent 审批通道弹给用户；undefined 透传则会回退到
        // stub 抛"requires user approval"——这正是当前 (W0.2 修复前) 的现象。
        waitForUserInput,
        // Hilt v3 / W6 M2：透传 judge 三件套到子 Agent，与 Electron 同构。
        // 父 yolo / workspace 改动通过共享的 agentConfigV3 / workspaceSnapshotV3
        // 引用同步反映在子 Agent 下一轮 runTools 入口的策略快照中。
        //
        // 路径权限治理 W7 / L1：把 agentMode 派生的 planModeGuardActive 也
        // 透进 EffectivePolicy —— judge() step 0 据此对 PLAN_TARGET_GUARDED_TOOLS
        // 直接 deny，与 Electron 同构。
        //
        // YOLO 两步授权 PRD v3 §5.5.2：闭包同时透传 requestedAgentMode + isGroupSpace
        // 让 build-policy 派生 effectiveMode（三方 AND，与 Electron 同构）。
        // policyContext 是可变源 —— handleQuery 入口 mutate `currentAgentMode`
        // 让 PD-13 闭包当下读到新值。
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
      hostAgentToolDeps: {
        sessionConfig,
        flushParentMessageBlocks: () => sessionStorage.blockStorage.flushPendingWrites(),
        getTemplateSnapshots: () => this.loadSessionTemplateSnapshots(sessionId, spaceId),
      } satisfies HostAgentToolDeps,
    });

    // customRules 由上游 submitHostQuery → RuntimeBuildInput 归一化，这里直接消费。
    // H1-E：走统一 telemetry API，与 Electron 输出同一 TelemetryRecord 结构。
    emitTelemetryEvent(
      TelemetryEvents.PERSONA_APPLIED,
      {
        ...redactCustomRules(customRules),
      },
      { session_id: sessionId, agent_id: agentId ?? undefined },
    );

    return {
      workspaceSnapshotV3, agentConfigV3, policyContext, readFileState, imageReadFileState,
      localDocReadFileState, fileHistoryThreadId, fileHistory, judgeHomeDir, toolRiskPolicy,
      todoCompletionNudgeProvider, todoSessionAnchor, toolProvider,
    };
    };
    const policyAssembly = await assemblePolicy();
    const {
      workspaceSnapshotV3, agentConfigV3, policyContext, readFileState, imageReadFileState,
      localDocReadFileState, fileHistoryThreadId, fileHistory, judgeHomeDir, toolRiskPolicy,
      todoCompletionNudgeProvider, todoSessionAnchor, toolProvider,
    } = policyAssembly;

    // W7a / W7b M3：buildSystemPrompt 接入 spaceId + agentMode + memoryCapability。
    // - spaceId 影响 <identity> 段的 space 信息行（缺省时不渲染）。
    // - agentMode 决定 <agent_mode> 段（plan/ask/study/group 各自 mode-specific 段；
    //   agent 模式下不渲染该段）。
    // - memoryCapability=true 时注入 `<agent_memory_capability>` 段（W7b M3，PRD 真相 I5）。
    //
    // M1.4 / v0.2 per-Organization · Wave 2：USER 画像 per-(user, organization) 异步装配。
    // 与 ElectronAgentHost 完全同构——按当前 runtime 的 organizationId 拉对应 Organization
    // 的画像并注入 system prompt；空 organizationId / fetch 失败 / 空画像 → 回落 undefined
    // （buildSystemPrompt 不会渲染 user_portrait 段）。
    //
    // 不阻塞规则：fetch 失败被吞掉（loadUserPortraitAsync 内部捕获），保证 runtime
    // 创建一定能完成；最差情况下用户的画像缺失但 Agent 仍能正常对话。
    //
    // owner.organizationId 在 Daemon 单 owner 模型下恒等于 this.ports.config.organization_id
    // （resolveOwner 缺失即抛错），所以直接读 owner.organizationId；保留 || '' 兜底
    // 仅是类型缩窄（loadUserPortraitAsync 已对空值早返回）。
    const assemblePrompt = async () => {
    const userPortrait = await this.loadUserPortraitAsync(owner.organizationId);
    // group 模式：拉当前 Space 可复用角色库（与 Electron 同构）；非 group → []。
    const subagentCatalog = agentMode === 'group'
      ? await this.loadSubagentCatalogAsync(spaceId)
      : [];
    // ：模板快照是显式 template_id 的运行时解析源，不能跟 group
    // catalog 绑定。Personal Space 不展示 <subagent_catalog>，但仍允许用户显式
    // 通过 template_id 套用模板 persona / model / tools / max_turns / enabled。
    await this.loadSubagentTemplatesFullAsync(spaceId);
    // Phase 2：读会话 group_runtime；激活时把 catalog 与可解析模板收敛到编制子集。
    const effectiveSubagentCatalog = await this.filterGroupSubagentCatalog(agentMode, sessionId, subagentCatalog);
    if (agentMode !== 'group') {
      this.contextCatalog.setGroupRoleIds(sessionId, null);
    }

    // ── W2.3：先算"对 LLM 可见的工具集合"用于 buildSystemPrompt ──
    // 与 Electron 同构 —— ShellCap 贡献 run_terminal_command / skills_* → SkillsCap /
    // FileSystemCap 只贡献目录工具，system prompt 工具清单必须与
    // mergedToolProvider 完全一致；否则 LLM 第一回合会按旧工具名调用，
    // 触发 unknown_tool fail-then-retry。
    const REPLACED_BY_CAPABILITY_NAMES = new Set<string>();
    if (skillsToolsDeps) {
      REPLACED_BY_CAPABILITY_NAMES.add('skills_read');
      REPLACED_BY_CAPABILITY_NAMES.add('skills_search');
    }
    // PD-1：terminal_mode 四档已砍。ShellCap 仅消费 operation_switches；
    // 不再向 ShellCap 传 terminal_mode 字段，让其内部 default 行为生效。
    //
    // ShellCap 接 PtyManagerBridge：bridge 已由 daemon.ts start() 在
    // PtyManager.initialize() 完成后注入（agent-bridge.ts L544-548 硬契约的
    // bootstrap 顺序：PtyManager 就绪 → setPtyManagerBridge → 装配 ShellCap）。
    // 缺失 → fail-fast throw（D6 决策：node-pty 加载失败 / PTY 不可用时
    // Daemon 本地 LLM 启动就报错，不静默降级）。
    const ptyBridge = this.ports.terminal.current();
    if (!ptyBridge) {
      throw new Error(
        'DaemonAgentHost: PtyManagerBridge not injected — daemon.ts start() ' +
          'must complete PtyManager.initialize() + setPtyManagerBridge() ' +
          'before AgentHost.create() (agent-bridge.ts L544-548 bootstrap order)',
      );
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
      config: {
        operation_switches: operationSwitches as Record<string, 'allow' | 'confirm' | 'block'> | undefined,
      },
    });
    const previewFsCap = new FileSystemCap();
    const previewPlatformDataCap = new PlatformDataCap({
      archiveDir: sessionDir,
      toolLogsDir,
      archiveSessionId: sessionId,
      toolLogsSessionId: sessionId,
    });
    const previewRawRefCap = new RawRefCap({ toolLogsDir, sessionId });
    const previewSkillsCap = skillsToolsDeps
      ? new SkillsCap({
          getSkill: skillsToolsDeps.getSkill,
          search: skillsToolsDeps.search,
        })
      : null;
    const previewCapTools = [
      ...previewFsCap.tools(),
      ...previewPlatformDataCap.tools(),
      ...previewRawRefCap.tools(),
      ...previewShellCap.tools(),
      ...(previewSkillsCap ? previewSkillsCap.tools() : []),
    ];
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
    ];

    // Runtime self-knowledge for `<runtime_identity>` block. Only emit when
    // the session is anchored to a real Space + Organization + workspace —
    // otherwise the archive paths would be misleading.
    //
    // W7c · Stage 4 Daemon 路径对齐：携带 Django 透传的人类可读名（治理 07 §F.1），
    // 让 ``<environment>`` 段在 Daemon 路径上也显"团队：研究组 / 空间：研究 Space"
    // 而不是裸 UUID。来源为空时退回旧行为（只显 ID），与 Electron 同款。
    const runtimeIdentity = (spaceId && organizationId && this.ports.workspaceRoot)
      ? {
          organizationId,
          spaceId,
          // §17.6 D4：RuntimeIdentity.sessionId → threadId（业务对话 thread）。
          threadId: sessionId,
          spaceName,
          organizationName,
          workspaceRoot: this.ports.workspaceRoot,
          archiveDir: sessionDir,
          toolLogsDir,
        }
      : undefined;

    // W7c · Stage 4 Daemon 路径对齐（治理 07 §F.1）：CLI 工具命令清单。
    // 优先级：Django 透传 → Daemon 自己 spawn ``tabtin commands --format json`` 兜底。
    // 与 Electron 同款 ``loadCLIReferenceAsync`` 行为：30 分钟正向缓存 + 失败 5 分钟负缓存，
    // 失败回退到 null（``<cli_capabilities>`` 段跳过，旧行为）。
    const effectiveCliReference = filterTemporarilyHiddenCliPromptReference(
      cliReference && cliReference.trim()
        ? cliReference
        : (await this.loadCLIReferenceAsync()) ?? undefined,
    );

    // ：创建期「烘焙输入」组装一次——每次构建才变的 mode / tools 交给
    // assembleSystemPrompt 作为变体。group-only 的 subagentCatalog 门控在装配器内
    // 统一处理，Daemon 不再自判 `=== 'group'`。
    const promptBaked: BakedSystemPromptInputs = {
      // ：Agent 专属 `custom_rules` 改走 agent-profile（贴用户消息前），
      // 支持对话中切 Agent；system `<custom_rules>` 只保留个人通用层。
      customRules: undefined,
      // 分层规则·个人通用层（IA Phase 3 §8.6）。缺省 → 该层跳过。
      personalRules,
      // workspaceRoot / spaceId 顶层字段已下线（2026-05-14 runtime_identity
      // 拆分）；这两个事实由下方 runtimeIdentity 携带。
      // enabledApps 烘焙到 `<apps>` 段；缺省 → 段跳过（向后兼容老 forward payload）。
      enabledApps,
      memoryCapability,
      // work_mode：注入对应 `<work_mode>` 段（已归一化，undefined 时跳过）。
      workingDirType,
      // W7c · Stage 4 Daemon 路径对齐：CLI 参考烘焙到 ``<cli_capabilities>`` 段。
      cliReference: effectiveCliReference,
      // M1.4 / v0.2: USER 画像 per-Organization——该 Organization 内的成员画像。
      // 同一用户在不同 Organization 装配的画像是独立的（人设隔离 / 隐私 / 计费）。
      userPortrait: userPortrait ?? undefined,
      runtimeIdentity,
      // ：把实际使用的 shell（与 spawnAgentShellProcess 同源）注入
      // `<shell_runtime>` 段，避免 LLM 在 zsh 上误用 bash 专属语法、Windows 上套 POSIX。
      shellInfo: resolveAgentShellInfo(),
      // group 模式：当前 Space 可复用的子 Agent 角色库（与 Electron 同构）。
      // ：喂 session 编制收敛后的 effectiveSubagentCatalog（非 group 时已为
      // undefined）；group-only 门控在 assembleSystemPrompt 装配器内完成。
      subagentCatalog: effectiveSubagentCatalog,
    };
    const { systemPrompt, buildConfig: promptBuildConfig } = assembleSystemPrompt(
      promptBaked,
      { agentMode, tools: previewMergedToolNames },
    );
    toolProvider.setSubagentSystemPrompt(systemPrompt, promptBuildConfig);

    return { systemPrompt, promptBuildConfig, effectiveSubagentCatalog, ptyBridge };
    };
    const promptAssembly = await assemblePrompt();
    const { systemPrompt, promptBuildConfig, effectiveSubagentCatalog, ptyBridge } = promptAssembly;

    // FR-01 / FR-03 / FR-04 / FR-07 / FR-09: ops-facing knobs resolved
    // from env at runtime creation time. Malformed overrides warn once
    // via the Daemon logger so misconfig surfaces in ops logs without
    // spamming per query. Runtime defaults (`'soft'` / 1_000_000 /
    // `'conservative'` / `'warn'` / scan-on) hold when env is unset or
    // invalid, so a clean install is unaffected.
    const doomLoopPolicy = resolveDoomLoopPolicy(process.env, this.ports.logger);
    const maxMessageChars = resolveMaxMessageChars(process.env, this.ports.logger);
    const normalizationLevel = resolveNormalizationLevel(process.env, this.ports.logger);
    const toolSchemaValidation = resolveToolSchemaValidation(process.env, this.ports.logger);
    const toolOutputScan = resolveToolOutputScan(process.env, this.ports.logger);
    // FR-15 / FR-16 H3-B: iterationBudget + 6 个 reuse knob 已在上方 toolProvider
    // 创建之前解析（让 agentToolDeps 能透传给子 Agent），此处直接复用 SSoT。
    // FR-15: iterationBudget 已在上方 toolProvider 创建之前解析（让子 agent
    // 透传），此处直接复用。

    // ── W1.2：装配 NativeBackendSession（feature flag 默认开）──
    // W2.3 改：把 bootstrap 提前到 EngineConfig 装配之前——7 Capability
    // 实例化时需要 backendBootstrap.session 做 bind 入参（与 Electron 同构）。
    const assembleCapabilities = async () => {
    const bootstrapBackend = async (): Promise<NativeBackendBootstrapResult | null> => {
    let backendBootstrap: NativeBackendBootstrapResult | null = null;
    if (agentId && isNativeBackendSessionEnabled()) {
      try {
        if (!this.backendRegistry) {
          this.backendRegistry = new ExecutionBackendRegistry();
        }
        backendBootstrap = await bootstrapNativeBackend({
          sessionId,
          agentId,
          workspaceRoot: this.ports.workspaceRoot,
          registry: this.backendRegistry,
        });
        this.ports.logger.debug(
          `[NativeBackendSession] bootstrapped agentId=${agentId.slice(0, 8)}… ` +
            `home=${backendBootstrap.session.agentHome.scratchpad}`,
        );
      } catch (err) {
        this.ports.logger.warn(
          `[NativeBackendSession] bootstrap failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (!agentId) {
      // W4.1（dogfood fix）：与 ElectronAgentHost 同构警告。Daemon 路径上
      // agentId 来自 Django prompt.forward envelope.payload.agent_id（见
      // daemon.ts:routeToLocalAgentHost）；如果 Django 端漏传或字段名拼错，
      // 这条 warn 是排查的第一抓手。详见 ElectronAgentHost 同段注释。
      this.ports.logger.warn(
        '[NativeBackendSession] skipped: missing agentId — 7 Capability cannot bind to BackendSession, ' +
          'all FileSystem/Shell tool calls will fail with "capability not bound". ' +
          'Daemon receives agentId from envelope.payload.agent_id (Django prompt.forward); verify upstream payload.',
      );
    } else if (!isNativeBackendSessionEnabled()) {
      this.ports.logger.warn(
        '[NativeBackendSession] skipped: TABTIN_NATIVE_BACKEND_SESSION env disables it (feature flag opt-out). ' +
          '7 Capability will not bind. Set env to enabled / 1 / on to restore.',
      );
    }
    return backendBootstrap;
    };
    const backendBootstrap = await bootstrapBackend();

    // ── 实例化 5 Capability（与 Electron 同构）──
    //
    // Wave 4a (2026-05-01)：TabDataCap 退役（D4 全删 FC，Agent 走 `tabtin table *`）。
    // Wave 12 (2026-05-04)：TabDocCap 退役（Agent 走 `tabtin doc *`）。
    // 剩 FileSystem / Shell / Skills / Audit / Cost。装配映射 + 工具贡献规则
    // 详见 ElectronAgentHost.ts 同段注释。

    const skillContextProvider: SkillContextProvider = {
      resolveCredentials: (params, signal) =>
        skillCredentialResolverHandle.resolver(params, signal),
    };

    // Agent prompt Skills follow the same local runtime registry as
    // `skills_read` / `skills_search`. If the registry is temporarily
    // unavailable, omit `<skills>` for this turn instead of falling back to
    // Django's legacy `/skills/index` view.
    const skillsFetcher = async (ctx: { query?: string; focusedApp?: string | null }) => {
      if (!skillsReady) {
        host.logger.debug('[DaemonAgentHost] [fetchSkills] registry unavailable, skills degraded');
        return null;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          skillsReady.finally(() => {
            if (timer) clearTimeout(timer);
          }),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => resolve(), 15_000);
          }),
        ]);
      } catch {
        if (timer) clearTimeout(timer);
      }
      const registry = host.skills.module()?.registry;
      if (!registry) {
        host.logger.debug('[DaemonAgentHost] [fetchSkills] registry unavailable, skills degraded');
        return null;
      }
      // ：spaceId / organizationId 是 per-runtime 常量（切 Space 重建
      // runtime），用装配作用域的快照值（L962-963）烘进闭包，Cap 不再经 ctx 传入。
      const enabledMap = agentSkillEnablement
        ? await agentSkillEnablement.refresh({ force: true })
        : undefined;
      return registry.render({
        spaceId,
        organizationId,
        // 透传相关性排序 query（by SkillsCap）→ skill-renderer.ts 组内相关性排序。
        query: ctx.query,
        focusedApp: ctx.focusedApp ?? getFocusedAppKey(this.ports.session.sessions.get(sessionId)?.appContext ?? null),
        personalPluginSkills: getPersonalPluginSkillsForContext({ spaceId }),
        budgetChars: 8_000,
        enabledMap,
      });
    };

    const fileSystemCap = new FileSystemCap();
    const platformDataCap = new PlatformDataCap({
      archiveDir: sessionDir,
      toolLogsDir,
      archiveSessionId: sessionId,
      toolLogsSessionId: sessionId,
    });
    const rawRefCap = new RawRefCap({ toolLogsDir, sessionId });

    // ── L16 W5.5：受限模式 input 级 shell 白名单 checker（与 Electron 同构）──
    const restrictedShellAllowlist = getRestrictedShellAllowlist(agentMode);
    let restrictedShellChecker: RestrictedShellAllowlistChecker | undefined;
    if (restrictedShellAllowlist === 'tabtin-readonly') {
      restrictedShellChecker = createTabtinReadonlyChecker({
        fetchCommandRisk: async (subcmdPath: string) => {
          const map = await this.loadCliCommandRiskMapAsync();
          if (!map) return null;
          if (map.has(subcmdPath)) return map.get(subcmdPath) ?? '';
          return null;
        },
        allowedCwdRoot: this.ports.workspaceRoot,
        // ：TabTin CLI 只读兜底动词表由宿主注入，core 默认空集。
        readonlyVerbs: RESTRICTED_READONLY_VERBS,
        // ：仅 Plan 模式放行浏览器导航（open/nav/tab switch）；ask/study 保持纯只读。
        ...(agentMode === 'plan' ? { browserNavAllowlist: RESTRICTED_BROWSER_NAV_ALLOWLIST } : {}),
      });
    }

    // PD-1：删 terminal_mode 字面量；ShellCap 仅消费 operation_switches。
    //
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
    });
    const skillsCap = skillsToolsDeps
      ? new SkillsCap({
          fetchSkills: skillsFetcher,
          getSkill: skillsToolsDeps.getSkill,
          search: skillsToolsDeps.search,
          listSkillResources: skillsToolsDeps.listSkillResources,
          readSkillResource: skillsToolsDeps.readSkillResource,
          contextWindowTokens: ctxWindow,
        })
      : null;
    const auditCap = new AuditCap({
      writer: createRelayAuditWriter(emitStreamEvent),
      level: 'standard',
    });
    // 双端 SSoT：`buildCostCapConfig`（`@tabtin/agent-host/runtime`）统一
    // v2 execution_limits 归一 + CostCapInit shape 组合，与 Electron 走同一份
    // 归一规则，避免漂移。executionLimits 已在 daemon.ts decodeExecutionLimits
    // → normalizeExecutionLimitsForCostCap 链路中完成 v2 归一（含 string
    // max_credits 接受），helper 内会再走一次 defensively normalize（幂等）。
    // CostCap 不再直接读 BudgetTracker：预算判定走 state 扁平字段（已由
    // engine 的 syncStateFromTracker 写成本 run 增量，含子 Agent 累计，）。
    const costCap = new CostCap(buildCostCapConfig({
      executionLimits,
      contextWindowTokens: ctxWindow,
      resolveContextWindow: dynamicResolveContextWindow,
    }));

    const allCaps = [fileSystemCap, platformDataCap, rawRefCap, shellCap, ...(skillsCap ? [skillsCap] : []), auditCap, costCap];
    if (backendBootstrap?.session) {
      for (const cap of allCaps) {
        await cap.bind(backendBootstrap.session);
      }
    }

    const toolContributingCaps = [fileSystemCap, platformDataCap, rawRefCap, shellCap, ...(skillsCap ? [skillsCap] : [])];
    const { tools: capTools } = prepareAgentTools(toolContributingCaps);

    // W7c · Stage 4 Daemon 路径对齐（治理 07 §F.5）：实例化显式降级的
    // run-observation injector，让 ``getRecentRunObservations`` 接到一个
    // 元信息齐全（``isNoop`` / ``reason``）的 NoOp 实现，供 P5 audit 校验。
    const daemonRunObservationInjector = createDaemonRunObservationInjector();
    const capToolNames = new Set(capTools.map((t) => t.name));
    const REPLACED_BY_CAPABILITY = new Set<string>();
    if (skillsCap) {
      REPLACED_BY_CAPABILITY.add('skills_read');
      REPLACED_BY_CAPABILITY.add('skills_search');
    }
    const allRemovedToolNames = new Set<string>([...REPLACED_BY_CAPABILITY, ...capToolNames]);
    const mergedToolProvider: RuntimeToolProvider = {
      getTools: () => {
        const old = toolProvider.getTools().filter((t) => !allRemovedToolNames.has(t.name));
        return [...capTools, ...old];
      },
      refreshTools: toolProvider.refreshTools?.bind(toolProvider),
    };
    // 子 Agent fork 工具集修复（与 Electron 同构）：把含 Cap 工具（尤其
    // ShellCap.run_terminal_command）的 mergedToolProvider 回注给 ToolProvider，
    // 让 `agent` 工具 fork 子 Agent 时继承与主 Agent 一致的完整工具集。否则子
    // Agent 走裸 provider 缺 run_terminal_command，CLI-first 下无法执行 tabtin 命令。
    toolProvider.setSubagentToolProvider(mergedToolProvider);

    const capHooks = composeCapabilityHooks(allCaps);

    return { backendBootstrap, skillsCap, mergedToolProvider, capHooks, daemonRunObservationInjector };
    };
    const capabilityAssembly = await assembleCapabilities();
    const { backendBootstrap, skillsCap, mergedToolProvider, capHooks, daemonRunObservationInjector } = capabilityAssembly;

    // ── v3 judge() + UserInteractiveChannel 装配 ───────────────────────
    // 主判决走 buildJudgePolicy → judge() 主路径；userInteractiveChannel
    // 作 HITL ask 通道（judge ask 路径走它弹审批）。

    const config: EngineConfig = {
      provider,
      tools: mergedToolProvider,
      permissionHandler,
      sessionConfig,
      model: modelId,
      systemPrompt,
      // ：tabtin fetch/browser 输出算外部不可信字节的判定由宿主注入，
      // core 默认不因 shell 命令判 untrusted。漏注入 = 注入防护被绕过（P0）。
      isUntrustedShellCommand,
      emitStreamEvent,
      eventEmitter: runtimeEventEmitter,
      waitForUserInput,
      budgetTracker,
      toolResultStorage,
      resolveContextWindow: dynamicResolveContextWindow,
      contextWindowTokens: ctxWindow,
      maxOutputTokens: maxOutput,
      modelCapabilities: modelCaps,
      // 子 Agent 模型自由度（Phase 3/4）：目录快照一等运行时输入（文档化锚点；
      // agent 工具实际经 agentToolDeps.modelCatalog 读取，同源）。
      modelCatalog,
      workspaceRoot: this.ports.workspaceRoot,
      // **W5 L36（2026-05-14）**：复用上方提前 new 的同款 const 引用（agentToolDeps
      // 也用同一份），让"父 runtime → fork 子 Agent"共享 dedup state。详见上方
      // const 声明注释 + ElectronAgentHost.ts 同款修复（W2.1 收尾 fix-8）。
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
      // PD-13：与 Electron 同构 —— 每轮 runTools 入口由本工厂从最新可变源
      // 派生 EffectivePolicy。闭包持有 agentConfigV3 / workspaceSnapshotV3 /
      // policyContext 引用（handleQuery 入口 mutate 让 yolo / workspace / mode
      // 切换即时反映）。
      //
      // 路径权限治理 W7 / L1：把 agentMode 派生的 planModeGuardActive 也
      // 透进 EffectivePolicy（详见上方 agentToolDeps.buildJudgePolicy 注释）。
      //
      // YOLO 两步授权 PRD v3 §5.5.2：闭包透传 requestedAgentMode + isGroupSpace
      // 让 build-policy 派生 effectiveMode（三方 AND）。
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
      // OS 访问错误 Organization 级共享黑名单 —— 与 toolProvider 共享同一实例，
      // tool-orchestration 据此短路 + 写入。
      osErrorBlacklist,
      doomLoopPolicy,
      maxMessageChars,
      normalizationLevel,
      toolSchemaValidation,
      toolOutputScan,
      iterationBudget,
      // W3 stall detector：host-knobs 解析后的 thresholds + enabled 透传到 runtime。
      toolFailureTracker,
      // FR-16 H3-B：Daemon 端必须把 env 解析的 enableSummaryReuse 注入 EngineConfig，
      // 否则 `TABTIN_SUMMARY_REUSE=off` 在 Daemon 完全无效（H3-B Review P0 fix）。
      enableSummaryReuse,
      summaryReuseJudgeSampleRate,
      summaryReuseJudgeWindowSize,
      summaryReuseJudgeThreshold,
      summaryReuseMaxAgeMs,
      summaryReuseMinAddedMessages,
      timeBasedMicroCompact,
      //  第一波：压缩分档阈值（undefined → runtime 默认）。
      pressureThresholds,
      syncPersistence: this.ports.syncPersistenceEnabled,
      maxConcurrentChildren,
      maxSubagentQueue,
      subagentResultCompact,
      // Wave 5a (L-W4-1) / W7c · Stage 4 Daemon 路径对齐：与 Electron 对称的
      // ``getRecentRunObservations`` 接线点。
      //
      // Daemon 当前没 host-side observation 源（autofill / RunSessionManager 在
      // Electron 主进程）—— 走显式 NoOp injector（``DAEMON_RUN_OBSERVATION_NOOP_REASON``）
      // 而不是 inline ``async () => []``，让 P5 audit 能区分"主动降级"和"漏接"。
      // 治理 07 §F.5 / 99 §阶段 4 留给后续：接入远端 autofill 推送后摘除本降级。
      getRecentRunObservations: daemonRunObservationInjector.injector,
      // ：后台任务完成「turn 内注入」（与 Electron 对称）。当前 turn
      // 还在循环时，每轮迭代边界 drain 该 thread 的后台完成通知拼成注入文本，
      // 使 Agent 当轮即可见并响应。与 _tryDrain 消费同一队列，互斥零重复。
      drainThreadNotifications: async () => this.ports.drainThreadNotificationsText(sessionId),
      hooks: composeHooks(
        capHooks,
        // ：run_terminal_command 完成后识别 browser/table/oss 并发交付物卡。
        createTerminalArtifactCardHook(),
        buildContextHook({
          getAppContext: async () => this.ports.session.sessions.get(sessionId)?.appContext ?? null,
          // ：App 详情段（按 appType 渲染产品字段 + CLI 配方）由宿主 formatter 注入。
          formatAppMeta: createAppMetaFormatter(),
          // ：相关召回块（`<relevant_skills>`）已迁出到 buildRelevantRecallInjectorHook
          // （见下方 todo-state 之后），本 hook 只注入环境快照。Daemon 无 mcp/cli Cap。
        }),
        // Memory v2 阶段 3（M3，2026-05-21 拍板）：与 ElectronAgentHost 对称装配
        // memory-injector hook —— 每轮 LLM 前从 TabMemo HTTP API 召回相关 memo
        // 注入 `<memory_recall>` 段，紧挨 `<context>` 之后。
        //
        // Daemon 与 Electron 的差异：
        //   - apiBaseUrl 走 ``deriveApiBaseUrl(this.ports.config.server_url)``（已有 apiBase 变量）；
        //   - token 走 ``this.ports.getAccessToken()`` 同步快照——每轮 LLM 前都现拉一次，
        //     与 fetchCloudSummary / DaemonToolProvider.apiAuthToken 同源；
        //   - organizationId 走 ``this.ports.config.organization_id``（init 时写入；运行期不变）。
        buildMemoryHook({
          fetchAgentConfig: () => ({
            enabled: memoryCapability === true,
            // 未上线 UI 暴露前 hardcoded `true`（spec §4 Hardcoded 默认）。
            // 待 UI 拉出 auto_inject 控件后改成读 IPC 字段。
            injection: { auto_inject: true },
          }),
          fetchMemories: async (query, limit) => {
            const memoToken = this.ports.getAccessToken();
            if (!memoToken) return [];
            return callMemorySearchAPI(
              {
                apiBaseUrl: apiBase,
                apiAuthToken: memoToken,
                organizationId: this.ports.config.organization_id,
                agentId,
              },
              {
                query,
                limit,
              },
            );
          },
        }),
        // ：当前 Agent 展示名 / 人设与规则——贴用户消息前注入（对话中可切 Agent）。
        buildAgentProfileHook({
          getAgentProfile: async () => this.ports.session.sessions.get(sessionId)?.agentProfile ?? null,
        }),
        // W7c · Stage 4 Daemon 路径对齐（治理 07 §F.4）：LSP 诊断 attachment 注入。
        //
        // 与 ElectronAgentHost 同款时序：
        //   1. 上方 ``ensureLspInitialized`` 用当前 workspace root init LSP singleton
        //      （第一次 session 创建时触发；TABTIN_DISABLE_LSP=1 由 lsp-runtime 内部处理）；
        //   2. session edit_file/write_file 时 tabcode-adapter 调 notifyLspAfterEdit
        //      通知 LSP server didChange/didSave（fire-and-forget）；
        //   3. LSP server 异步算诊断 → publishDiagnostics → registry pending；
        //   4. 下一轮 LLM 前本 hook 取出 + 包成
        //      ``<system-reminder><new-diagnostics>...</new-diagnostics></system-reminder>``
        //      user message 注入到 messages。
        //
        // 守门员（C10）：检查当前 session 工具白名单是否含 ``run_terminal_command``
        // —— 没有就不推（"能修才推"）。Daemon 默认 ToolProvider 提供 shell 工具，
        // 但 plan/ask 模式下被裁掉时本守门员让 hook 自然 no-op。
        buildLspDiagnosticHook({
          hasShellTool: () => {
            try {
              return toolProvider
                .getTools()
                .some((t) => t.name === 'run_terminal_command');
            } catch {
              return false;
            }
          },
          isMainThread: true,
        }),
        buildModeReminderHook({
          getAgentMode: () => policyContext.currentAgentMode,
          // ：本地 plan 落文件后，per-turn reminder 带上当前 plan 文件相对路径。
          getActivePlanFilePath: () => getActivePlanFilePath(sessionId) ?? undefined,
        }),
        buildTodoStateHook({
          getAgentMode: () => policyContext.currentAgentMode,
          sessionAnchor: todoSessionAnchor,
        }),
        // ：每轮注入相关能力召回块，随 in_progress todo 推进刷新。Daemon 仅 skills。
        buildRelevantRecallHook({
          getRelevantContextBlocks: () => [skillsCap?.getRelevantBlock()],
        }),
        {
          afterIteration: async (ctx) => {
            const last = ctx.state.messages.at(-1);
            if (last?.role === 'assistant') {
              await sessionStorage.recordAssistantMessage(last);
            }
          },
        },
        // 项目规则自动加载（AGENTS.md MVP，PRD §4.3 / B3）：与 ElectronAgentHost
        // 对称装配。每轮 LLM 前从 working_dir 根部 AGENTS.md 读到"项目规约"注入
        // messages 最前，与 custom_rules 并存。
        //
        // **必须放 composeHooks 数组末位**：composeHooks 同名钩子按数组顺序串行
        // await，本 hook beforeIteration unshift 到 messages[0]，末位执行 → 稳定占
        // messages[0]，得 [project_rules, context, memory_recall, ...]。
        //
        // 读盘走 readProjectRules（mtime 缓存 + 截断），workspaceRoot 为 Daemon
        // 构造期快照的 this.ports.workspaceRoot——hook 本体不碰 fs。
        buildRulesHook({
          fetchProjectRules: () => readProjectRules(this.ports.workspaceRoot),
          onInjected: ({ chars, truncated }) => {
            this.ports.logger.debug(
              `[rules-injector] injected project_rules from ${this.ports.workspaceRoot}/AGENTS.md, ${chars} chars (truncated=${truncated})`,
            );
          },
        }),
      ),
      skillActivation: skillInvokeDeps ? createSkillActivation(skillInvokeDeps) : undefined,
    };

    // W7c · Stage 4 Daemon 路径对齐（治理 07 §F.4）：lazy init LSP runtime
    // singleton。与 Electron 同款放在 runtime config 装配之后、createRuntime 之前
    // —— 第一次 session 创建时启动；幂等闸防止重复 init。失败 log warn 不抛错
    // （LSP 是"能跑就跑"的增强，不阻塞 Daemon）。
    this.ensureLspInitialized(this.ports.workspaceRoot);

    // W4a S3（PR2）：把当前 runtime 的 6 类 live 依赖灌进 Manager（与 Electron 对称）。
    // 后台 / resume 子经 resolveLiveDeps 取活体依赖构造 forkQuery；同时刷新完成句柄。
    const liveDeps: SubagentLiveDeps = {
      emitStreamEvent,
      budgetTracker: config.budgetTracker,
      userInteractiveChannel: config.userInteractiveChannel,
      waitForUserInput: config.waitForUserInput,
      toolRiskPolicy: config.toolRiskPolicy,
      osErrorBlacklist: config.osErrorBlacklist,
    };
    subagentManager.rebindLiveDeps(liveDeps, enqueueSubagentCompletion);

    // W4b：崩溃残留子 Agent 收口（orphan reaper），与 Electron 对称。进程崩溃 / 强杀
    // 会让正在跑的子只写了 started 没写 ended，重启后这些孤儿在 foldSubagentRuns 下
    // 永远是 running。趁 runtime 装配完成、本 session 的 SubagentManager 就绪后，把
    // 进程已死的孤儿 reconcile 成 cancelled——判活用 `manager.has(childId)`（内存登记态）：
    //   - 首建时 manager 空 → 所有孤儿被收口；
    //   - carry-forward 复用 / 本进程后台子在跑时 → `has===true` 保护，绝不误杀。
    // fire-and-forget + 日志：reap 内部已 best-effort（失败不抛），这里不 await，不阻塞返回。
    void reapOrphanedSubagentRuns(sessionDir, sessionId, (childId) =>
      subagentManager.has(childId),
    )
      .then((reconciled) => {
        if (reconciled > 0) {
          this.ports.logger.info(`[subagent-reaper] reconciled ${reconciled} orphaned subagent run(s) for session ${sessionId}`);
        }
      })
      .catch((err) => {
        this.ports.logger.warn(`[subagent-reaper] failed for session ${sessionId}`, err);
      });

    return {
      runtime: createRuntime(config),
      // P0（file-history 跨进程统一）：透出实际用于 getOrCreateFileHistory 的 key，
      // createRuntimeForSession 写入 DaemonHostState 供 reset 对称 removeFileHistory。
      fileHistoryThreadId,
      sessionStorage,
      snapshotStorage,
      eventStorage,
      toolLogWriter,
      toolProvider,
      engineConfig: config,
      backendBootstrap,
      // W4a S1：透出 SubagentManager —— createRuntimeForSession 写入 DaemonHostState，
      // host.stop() / runtime 重建时 dispose 只取消本 session 的子（与 Electron 对称）。
      subagentManager,
      // W4a S2：透出 session 级 subagentStreamSink → 写入 DaemonHostState（跨
      // query 存活），让后续 PR 的后台子 / resume 子能从 HostState 拿到 / 重绑它。
      subagentStreamSink,
      eventEmitter: runtimeEventEmitter,
      // Hilt v3 / W6 M2：透出 v3 工件，让 createRuntimeForSession 写入
      // DaemonHostState（buildJudgePolicy 工厂闭包通过宿主持有的引用同步
      // 读 yolo / workspace 切换）。与 ElectronAgentHost 同构。
      agentConfigV3,
      workspaceSnapshotV3,
      // YOLO 两步授权 PRD v3 §5.5.2：同款"可变源透出"，让 handleQuery 入口
      // mutate `currentAgentMode` 让 PD-13 工厂闭包当下读到新值。
      policyContext,
    };
  }

  /**
   * M1.4 / v0.2 per-Organization · Wave 2：异步加载用户在指定 Organization 的 USER 画像
   * markdown，与 ElectronAgentHost.loadUserPortraitAsync 完全同构。
   *
   * 直接调 Django 的 `/user-portrait/me/{organization_id}` 端点，提取 `content_md`。
   * 失败 / 空画像 → 返回 null（buildSystemPrompt 不会注入 user_portrait 段）。
   * 短 TTL 缓存（10 分钟），按 organization_id 分槽位。
   *
   * 设计：故意不阻塞 runtime 创建——HTTP 失败时不抛异常，只是没有 user portrait。
   * 隔离不变量：必须传 organizationId；空 organizationId 直接返回 null（与 Electron 一致）。
   *
   * @param organizationId 必传——画像 per-(user, organization) 隔离；空字符串直接返回 null
   */
  /**
   * Group 模式：拉取当前 Space 的可复用子 Agent 角色库（SubAgentTemplate）。
   * 与 ElectronAgentHost.loadSubagentCatalogAsync 同构——main 自拉保留的纯数据
   * CRUD 路由 `/orchestration/spaces/{id}/subagent-templates`。失败 / 空 → []，
   * buildSystemPrompt 跳过 `<subagent_catalog>` 段（主 Agent ad-hoc 组队）。
   */
  private async loadSubagentCatalogAsync(spaceId: string | undefined | null): Promise<SubagentCatalogEntry[]> {
    if (!spaceId) return [];

    const cached = this.contextCatalog.getSubagentCatalog(spaceId);
    if (cached && Date.now() - cached.timestamp < DaemonRuntimeAssembly.SUBAGENT_CATALOG_CACHE_TTL_MS) {
      return cached.value;
    }

    try {
      const token = this.ports.getAccessToken();
      if (!token) return [];

      const apiBase = deriveApiBaseUrl(this.ports.config.server_url);
      const url = joinApiPath(apiBase, `/orchestration/spaces/${encodeURIComponent(spaceId)}/subagent-templates`);
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5_000),
      });

      if (!resp.ok) {
        this.contextCatalog.setSubagentCatalog(spaceId, []);
        return [];
      }

      const body = (await resp.json()) as {
        items?: Array<{ id?: string; name?: string; description?: string; subagent_type?: string; is_enabled?: boolean }>;
      };
      const items = Array.isArray(body?.items) ? body.items : [];
      const catalog: SubagentCatalogEntry[] = items
        .filter((t) => t.is_enabled !== false && !!t.name?.trim())
        .map((t) => ({
          // ：带 template_id 让主 Agent 能精确指定模板派发。
          templateId: typeof t.id === 'string' ? t.id : undefined,
          name: t.name!.trim(),
          description: (t.description ?? '').trim(),
          subagentType: t.subagent_type || 'execute',
        }));
      this.contextCatalog.setSubagentCatalog(spaceId, catalog);
      return catalog;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ports.logger.debug(
        `[DaemonAgentHost] loadSubagentCatalogAsync failed for space=${spaceId}: ${message}`,
      );
      this.contextCatalog.setSubagentCatalog(spaceId, []);
      return [];
    }
  }

  /**
   * ：拉取当前 Space 的**全量**子 Agent 模板快照，供 agent-tool 经
   * template_id 驱动 spawn。与 ElectronAgentHost.loadSubagentTemplatesFullAsync 同构：
   * 每次 runtime 创建实时 fetch，并写入「id → snapshot」live map（hostAgentToolDeps
   * 闭包据此同步取值）。失败 / 空 → 写空 map → 所有 template_id 解析失败 → 静默 ad-hoc。
   */
  private async loadSubagentTemplatesFullAsync(spaceId: string | undefined | null): Promise<SubAgentTemplateSnapshot[]> {
    if (!spaceId) return [];

    const commit = (snapshots: SubAgentTemplateSnapshot[]): SubAgentTemplateSnapshot[] => {
      return this.contextCatalog.commitTemplates(spaceId, snapshots);
    };

    try {
      const token = this.ports.getAccessToken();
      if (!token) return commit([]);

      const apiBase = deriveApiBaseUrl(this.ports.config.server_url);
      const url = joinApiPath(apiBase, `/orchestration/spaces/${encodeURIComponent(spaceId)}/subagent-templates`);
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5_000),
      });

      if (!resp.ok) return commit([]);

      const body = (await resp.json()) as { items?: Array<Record<string, unknown>> };
      const items = Array.isArray(body?.items) ? body.items : [];
      const snapshots = items
        .map(mapRawTemplateToSnapshot)
        .filter((s): s is SubAgentTemplateSnapshot => s !== null);
      return commit(snapshots);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ports.logger.debug(
        `[DaemonAgentHost] loadSubagentTemplatesFullAsync failed for space=${spaceId}: ${message}`,
      );
      return commit([]);
    }
  }

  /**
   *  Phase 2：读会话 group_runtime，激活时返回本 session 允许的
   * template_id 集合并写入 sessionGroupRoleIds；否则清除（回落 Space 全量）。
   * 与 ElectronAgentHost.loadGroupRuntimeRoleIdsAsync 同构。仅 group 模式调用。
   */
  private async loadGroupRuntimeRoleIdsAsync(sessionId: string): Promise<Set<string> | null> {
    try {
      const token = this.ports.getAccessToken();
      if (!token) { this.contextCatalog.setGroupRoleIds(sessionId, null); return null; }

      const apiBase = deriveApiBaseUrl(this.ports.config.server_url);
      const url = joinApiPath(apiBase, `/chat/sessions/${encodeURIComponent(sessionId)}/context`);
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!resp.ok) { this.contextCatalog.setGroupRoleIds(sessionId, null); return null; }

      const body = (await resp.json()) as {
        group_runtime?: { is_active?: boolean; roles?: Array<{ template_id?: string; enabled?: boolean }> } | null;
      };
      const gr = body?.group_runtime;
      if (!gr || gr.is_active !== true || !Array.isArray(gr.roles)) {
        this.contextCatalog.setGroupRoleIds(sessionId, null);
        return null;
      }
      const ids = new Set(
        gr.roles
          .filter((r) => r.enabled !== false && typeof r.template_id === 'string' && r.template_id.trim())
          .map((r) => r.template_id!.trim()),
      );
      if (ids.size === 0) { this.contextCatalog.setGroupRoleIds(sessionId, null); return null; }
      this.contextCatalog.setGroupRoleIds(sessionId, ids);
      return ids;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ports.logger.debug(`[DaemonAgentHost] loadGroupRuntimeRoleIdsAsync failed for session=${sessionId}: ${message}`);
      this.contextCatalog.setGroupRoleIds(sessionId, null);
      return null;
    }
  }

  /**
   *  Phase 2：host 模板展开的 per-session 取值（与 Electron 同构）。
   * 有会话编制 → 收敛子集（新建过滤 map，不改共享 space map）；否则 Space 全量。
   */
  private resolveSessionTemplateSnapshots(
    sessionId: string,
    spaceId: string | undefined,
  ): Map<string, SubAgentTemplateSnapshot> | undefined {
    return this.contextCatalog.resolveTemplates(sessionId, spaceId);
  }

  private async loadSessionTemplateSnapshots(
    sessionId: string,
    spaceId: string | undefined,
  ): Promise<Map<string, SubAgentTemplateSnapshot> | undefined> {
    if (!spaceId) return undefined;
    await this.loadSubagentTemplatesFullAsync(spaceId);
    return this.resolveSessionTemplateSnapshots(sessionId, spaceId);
  }

  private async loadUserPortraitAsync(organizationId: string | undefined | null): Promise<string | null> {
    if (!organizationId) return null;

    const cached = this.contextCatalog.getUserPortrait(organizationId);
    if (cached) {
      const ttl = cached.value !== null
        ? DaemonRuntimeAssembly.USER_PORTRAIT_CACHE_TTL_MS
        : DaemonRuntimeAssembly.USER_PORTRAIT_NEGATIVE_CACHE_TTL_MS;
      if (Date.now() - cached.timestamp < ttl) {
        return cached.value;
      }
    }

    try {
      // 与 Electron 一致：token 获取也放进 try，防止同步 getter 抛错时
      // 破坏"失败吞掉、仅落盘负缓存"的契约（即便当前 daemon 的 getAccessToken
      // 是同步 getter，未来若改 async / 抛错也不会泄漏到 createRuntime 主流程）。
      const token = this.ports.getAccessToken();
      if (!token) {
        this.contextCatalog.setUserPortrait(organizationId, null);
        return null;
      }

      const apiBase = deriveApiBaseUrl(this.ports.config.server_url);
      const url = joinApiPath(apiBase, `/user-portrait/me/${encodeURIComponent(organizationId)}`);
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5_000),
      });

      if (!resp.ok) {
        this.contextCatalog.setUserPortrait(organizationId, null);
        return null;
      }

      const body = (await resp.json()) as {
        success?: boolean;
        data?: {
          content_md?: string;
          version?: number;
        };
      };

      const contentMd = body?.data?.content_md?.trim() || '';
      const value = contentMd ? contentMd : null;
      this.contextCatalog.setUserPortrait(organizationId, value);
      return value;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ports.logger.debug(
        `[DaemonAgentHost] loadUserPortraitAsync failed for organization=${organizationId}: ${message}`,
      );
      this.contextCatalog.setUserPortrait(organizationId, null);
      return null;
    }
  }

  /**
   * W7c · Stage 4 Daemon 路径对齐：异步加载 CLI 工具参考（与 Electron 同构）。
   *
   * Daemon 之前 ``<cli_capabilities>`` 段恒缺失（治理 07 §F.1）。本方法与
   * ``ElectronAgentHost.loadCLIReferenceAsync`` 完全同构：
   *
   *   1. 优先读缓存（正向 30 分钟 / 负向 5 分钟，避免热路径重复 spawn）；
   *   2. ``execFile('tabtin', ['commands', '--format', 'json'])``
   *      子进程取真实命令清单 + 描述；超时 5s（避免卡 createRuntimeForSession）；
   *   3. 解析失败 / 空数组 / 命令不可用 → 缓存 null，``<cli_capabilities>`` 段跳过。
   *   4. ：输出收敛为一级命令（``tabtin <domain>``），与 CliCap 静态段一致。
   *
   * 与 Electron 端的差异：Daemon 用 ``import('node:child_process').execFile``，
   * 不依赖 Electron `app.getPath` 主进程上下文，跨平台行为一致。
   */
  private async loadCLIReferenceAsync(): Promise<string | null> {
    const cached = this.getFreshCliReferenceCache();
    if (cached.hit) return cached.value;

    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync(
        'tabtin',
        ['commands', '--format', 'json'],
        { timeout: 5_000, encoding: 'utf-8' },
      );

      const tools = parseTabtinCommandsJson(stdout) as Array<{ name?: string; description?: string }> | null;
      if (!Array.isArray(tools) || tools.length === 0) {
        this.contextCatalog.setCliReference(null);
        return null;
      }

      const value = this.formatCliReference(tools);
      const normalized = value || null;
      this.contextCatalog.setCliReference(normalized);
      return normalized;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ports.logger.debug(
        `[DaemonAgentHost] loadCLIReferenceAsync failed: ${message}`,
      );
      this.contextCatalog.setCliReference(null);
      return null;
    }
  }

  private getFreshCliReferenceCache(): { hit: boolean; value: string | null } {
    const cache = this.contextCatalog.getCliReference();
    if (!cache) return { hit: false, value: null };
    const ttl = cache.value === null
      ? DaemonRuntimeAssembly.CLI_NEGATIVE_CACHE_TTL_MS
      : DaemonRuntimeAssembly.CLI_CACHE_TTL_MS;
    return Date.now() - cache.timestamp < ttl
      ? { hit: true, value: cache.value }
      : { hit: false, value: null };
  }

  private formatCliReference(tools: Array<{ name?: string; description?: string }>): string {
    const topLevel = new Map<string, { name: string; description?: string }>();
    for (const tool of tools) {
      if (typeof tool.name !== 'string' || !tool.name.trim()) continue;
      const trimmedName = tool.name.trim();
      const path = trimmedName.startsWith('tabtin ') ? trimmedName.slice('tabtin '.length) : trimmedName;
      if (isTemporarilyHiddenCliPromptCommand(path)) continue;
      const domain = path.split(/\s+/)[0];
      if (!domain) continue;
      const isRoot = path === domain;
      const previous = topLevel.get(domain);
      if (!previous) topLevel.set(domain, { name: domain, description: isRoot ? tool.description : undefined });
      else if (isRoot && tool.description) topLevel.set(domain, { name: domain, description: tool.description });
    }
    return [...topLevel.values()]
      .map((tool) => `- \`tabtin ${tool.name}\`${tool.description ? `: ${tool.description}` : ''}`)
      .join('\n');
  }

  /** W7c · Stage 4 Daemon 路径对齐：手动失效 CLI 参考缓存（测试 / CLI 升级后用）。 */
  invalidateCLIReferenceCache(): void {
    this.contextCatalog.invalidateCliReference();
  }

  /**
   * W7c · Stage 4 Daemon 路径对齐（治理 07 §F.4）：LSP runtime singleton lazy init。
   *
   * 与 ``ElectronAgentHost.ensureLspInitialized`` 完全同款：
   *   - 幂等：``lspInitialized`` 标记防止重复 init；
   *   - 容错：init 失败 log warn 不抛错——LSP 是"能跑就跑"的增强，不阻塞 Daemon；
   *   - 异步：``initializeLspServerManager`` 内部异步起 LSP server pool；
   *   - publishDiagnostics 回调通过 ``onLspInitialized`` 注册，
   *     ``buildLspDiagnosticInjectorHook`` 据此把诊断包装成 ``<system-reminder>``
   *     注入下一轮 user message；
   *   - ``TABTIN_DISABLE_LSP=1`` 由 lsp-runtime 内部处理（与 Electron 同款）。
   *
   * 当前简化：第一次 session 的 workspace root 作 projectRoot，后续 session 不切换
   * （与 Electron 同款，W2 范围如要 reinit 由 ``reinitializeLspServerManager`` 接通）。
   */
  private ensureLspInitialized(workspaceRoot: string | undefined): void {
    if (this.lspInitialized) return;
    this.lspInitialized = true;

    try {
      const projectRoot = workspaceRoot ?? process.cwd();
      const loader = createBuiltinServersLoader({ projectRoot });

      onLspInitialized((manager) => {
        try {
          registerLSPNotificationHandlers(manager);
          this.ports.logger.info(
            `[lsp-runtime] passive feedback handlers registered for ${manager.getAllServers().size} server(s)`,
          );
        } catch (err) {
          this.ports.logger.warn(
            `[lsp-runtime] registerLSPNotificationHandlers failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });

      initializeLspServerManager(loader);

      const status = getLspInitializationStatus();
      this.ports.logger.info(
        `[lsp-runtime] initialization started (state=${status.status}, projectRoot=${projectRoot})`,
      );
    } catch (err) {
      this.ports.logger.warn(
        `[lsp-runtime] init failed (non-fatal, falling back to no-LSP mode): ${err instanceof Error ? err.message : String(err)}`,
      );
      // 不重置 lspInitialized——避免每个 session 都重试这种确定会失败的 init。
    }
  }

  /**
   * M1.4 / v0.2 per-Organization · Wave 2：手动失效 USER 画像缓存（与 Electron 同构 API）。
   *
   * 当前 Daemon 路径下没有调用方（Daemon 没有 IPC，且本 Wave 不修改 Django 来推送
   * WS envelope）。保留 API 是为了：
   *   1. 与 Electron 接口对称——后续如要做"hint 提交后立即刷新 Daemon 缓存"
   *      只需 Django 推一条 `agent.user_portrait.invalidate` envelope 后调用本方法；
   *   2. 单元测试 / 调试场景可手动清缓存；
   *   3. host.stop() 路径如需主动清空（目前不需要——Map 跟着实例消亡）。
   *
   * @param organizationId 传 organizationId 失效该 Organization 单个槽位；
   *                   传 undefined / 空字符串清空所有槽位
   */
  invalidateUserPortraitCache(organizationId?: string): void {
    if (organizationId) {
      this.contextCatalog.invalidateUserPortrait(organizationId);
    } else {
      this.contextCatalog.invalidateUserPortrait();
    }
  }

  /**
   * L16 W5.5 / L31：异步加载 `tabtin commands --format json` 原始 schemas 数组。
   *
   * 与 ElectronAgentHost.loadCliCommandsAsync 同构。Daemon 端通过 spawn
   * 子进程调 tabtin（已经在 PATH 里），失败时 cache.value=null 让 checker fail-close。
   */
  private async loadCliCommandsAsync(): Promise<
    ReadonlyArray<CliCommandSchema> | null
  > {
    const cachedCommands = this.contextCatalog.getCliCommands();
    if (cachedCommands) {
      const ttl = cachedCommands.value !== null
        ? DaemonRuntimeAssembly.CLI_RISK_MAP_TTL_MS
        : DaemonRuntimeAssembly.CLI_RISK_MAP_NEGATIVE_TTL_MS;
      if (Date.now() - cachedCommands.timestamp < ttl) {
        return cachedCommands.value;
      }
    }

    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      // ：默认 `commands` 剔除 Hidden；受限模式 risk map 需 --include-hidden。
      const { stdout } = await execFileAsync(
        'tabtin',
        ['commands', '--format', 'json', '--include-hidden'],
        { timeout: 5_000, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 },
      );
      // 解析与 envelope 解包由 @tabtin/agent-runtime 的 parseTabtinCommandsJson 统一提供，
      // 与 ElectronAgentHost 共用同一实现，避免两端 inline 解析漂移。
      const schemas = parseTabtinCommandsJson(stdout);
      this.contextCatalog.setCliCommands(schemas);
      return schemas;
    } catch (err) {
      this.ports.logger.debug(
        `[DaemonAgentHost] loadCliCommandsAsync failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.contextCatalog.setCliCommands(null);
      return null;
    }
  }

  private async loadCliCommandRiskMapAsync(): Promise<Map<string, string> | null> {
    const schemas = await this.loadCliCommandsAsync();
    if (!schemas) return null;
    return buildRiskMapFromSchemas(schemas);
  }

  /** L16 W5.5 / L31：测试用——清空 commands 缓存让下一次调用强制重新拉取。 */
  invalidateCliRiskMapCache(): void {
    this.contextCatalog.invalidateCliCommands();
  }
}
