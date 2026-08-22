/**
 * DaemonToolProvider — Tool registry for the headless Daemon runtime.
 *
 * Mirrors ElectronToolProvider but swaps Electron-specific integrations:
 *   - MCP: deferred to a follow-up wave (see ./mcp-todo block below)
 *   - Auth: token from DaemonGatewayClient, not Electron TokenManager
 *   - UI: events relay via WS, not Electron IPC
 *
 * W7a M3 接线（与 ElectronToolProvider 对齐）：
 *   - agentMode：缓存 + annotateToolsForMode 标注（调用时 judge step 0 软拒）
 *   - createPlanTools：plan / study 模式追加（依赖 spaceId / organizationId）
 *   - reconfigure：软切换 agentMode 时复用同一 ToolProvider，避免重建 runtime
 *   - cachedTools：避免每轮 LLM iteration 重建工具列表
 *
 * Tool source files in ./tools/ are isomorphic with the Electron host (pure Node.js).
 * TODO: Extract tools to packages/agent-tools for single-source sharing.
 */

import type { SystemPromptConfig } from '@tabtin/agent-prompt';
import type {
  ToolProvider,
  Tool,
  StreamEvent,
  ToolResultStorage,
} from '@tabtin/agent-runtime/engine';
//  批次 13：engine barrel 收敛——subagent / tools / agent-modes 符号改从包入口 import。
import type { AgentToolDeps, TodoSessionAnchor } from '@tabtin/agent-runtime'
import type { HostAgentToolDeps } from '@tabtin/agent-host/configuration'
import {
  createHostAgentTool,
  createSubagentToolProvider,
} from '@tabtin/agent-host/configuration'
import type { AgentModeName } from '@tabtin/agent-modes'
import {
  createAgentTool,
  createPlanTools,
  LocalFilePlanStore,
  createSwitchModeTool,
} from '@tabtin/agent-runtime'
import {
  getProposableModeTargets,
  annotateToolsForMode,
  resolveAgentModeName,
} from '@tabtin/agent-modes'
import {
  buildPolicyFromAgentConfigV2,
  type UnifiedSecurityPolicy,
  type EffectivePolicy,
  type AgentConfigV3,
  type WorkspaceSnapshot,
} from '@tabtin/security-policy';

type AuthorizationPreset = 'cautious' | 'collaborative' | 'full_auto' | 'server_auto';
import {
  matchDisabledToolDomain,
  resolveDisabledToolPrefixes,
} from '@tabtin/agent-wire';
import type { Logger } from '../../platform/observability/logging/logger.js';
import type { RunDocParserTask } from '@tabtin/local-docparse';
import { createRunTempPptxParse } from '../../platform/content/document/tempPptxParse.js';
import {
  createCoreTools,
  createWebTools,
  createPresentationTools,
  createSkillsTools,
  createSkillCreateTool,
  createSystemTools,
  type SkillsToolsDeps,
  type SkillInvokeDeps,
  type SkillCreateDeps,
  type SkillCredentialResolver,
} from '@tabtin/agent-runtime/tools';
//  / ：data/document/tabcode 业务工具在宿主工具包。
import {
  createDataTools,
  createDocumentTools,
  createTabCodeTools,
} from '@tabtin/agent-host/tools';
// ：show_widget 烤图 + present 资源类型/特判由宿主注入。
import {
  bakeAndUploadWidget,
  buildLocalFileArtifactUrl,
  PRESENT_SUPPORTED_RESOURCE_TYPES,
  presentAutoOpenPolicy,
} from '@tabtin/agent-host/capabilities';
import { createSystemPromptProvider } from '@tabtin/agent-host/prompt';
// W3 (2026-05-10): `ToolResultStore` (alias of legacy `ToolResultArchive`)
// removed along with `retrieve_tool_result`.
import type { OSErrorBlacklist } from '@tabtin/agent-runtime/permissions';

// ─── Options ─────────────────────────────────────────────────────────

export interface DaemonToolProviderOptions {
  runDocParserTask: RunDocParserTask;
  securityPreset?: AuthorizationPreset;
  securityPolicy?: UnifiedSecurityPolicy;
  agentConfigV3?: AgentConfigV3;
  workspaceSnapshot?: WorkspaceSnapshot;
  disabledApps?: string[];
  disabledToolPrefixes?: string[];
  emitStreamEvent?: (event: StreamEvent) => void;
  /**
   *  / ：与 `buildTodoStateHook({ sessionAnchor })` 共用的会话锚。
   * 窗口内 todo 事件被截断后，`todo` execute 仍能以锚为种子做 update/close。
   */
  todoSessionAnchor?: TodoSessionAnchor;
  /**
   * Sub-agent support via SSoT `AgentToolDeps`. See ElectronToolProvider's
   * `agentToolDeps` doc for the one-place-to-change rationale.
   */
  agentToolDeps?: AgentToolDeps;
  /** ：host 侧 agent 工具包装（模板展开 + 交付物 enrich）。 */
  hostAgentToolDeps?: HostAgentToolDeps;
  /**
   * T-P1-4 / W3: disk-backed storage for oversized tool results.
   * Used by `enforceToolOutputBudget` to write pre-truncation content;
   * LLM reaches the file via `read_file` (no LLM-facing retrieve tool).
   */
  toolResultStorage?: ToolResultStorage;
  apiBaseUrl?: string;
  apiAuthToken?: string;
  organizationId?: string;
  /**
   * W7a：当前 chat 所属 Space id —— 由 daemon.ts 从 prompt.forward payload 解出。
   * plan / study 模式构造 createPlanTools 时必传（plan 工具需要落到 Space 维度的 Plan 文档）。
   * 缺省时 plan-tools 跳过注册（plan/study 模式仍可工作但 plan_create 会失败）。
   */
  spaceId?: string;
  /**
   * W7a：当前 session id（与 host 同源），plan-tools 透传到 Django plan API
   * 用于关联 plan 文档与会话。
   */
  sessionId?: string;
  /** W7a：当前 Agent id，plan-tools 透传到 Django 关联记录。 */
  agentId?: string;
  /**
   *  / ：隐私总闸（MemoRecordStyle.enabled 派生的 memoryCapability）。
   * ``false`` 时 createDataTools 不注册 memory_search / memory_write。
   */
  memoryEnabled?: boolean;
  /**
   * W7a：用户在客户端选择的 Agent Mode。决定 `getTools()` 的工具标注
   * （annotateToolsForMode）以及 plan-tools 是否注册。
   *
   * - 'agent'（或省略）：所有工具可用（回归基线）
   * - 'plan' / 'ask' / 'study'：工具列表不做物理过滤，调用时由 judge step 0 软拒
   * - 'group'：与 'agent' 工具集等价
   *
   * 由 DaemonAgentHost 在 createRuntimeForSession 时透传，runtime 缓存键也包含
   * 它（mode 改变会触发 runtime 重建）。
   */
  agentMode?: AgentModeName;
  /**
   * YOLO 两步授权 PRD v3 §5.5.2：当前 Space 是否 group 类型。
   *
   * 由 DaemonAgentHost 在 createRuntimeForSession 时透传（与 Electron 同构）。
   * 仅参与构造期 `buildPolicyFromAgentConfigV2` 派生 effectivePolicyV3 的 isGroupSpace
   * 入参（让 getEffectivePolicyV3() 暴露的策略与主判决路径 buildJudgePolicy 闭包一致）。
   *
   * 主判决主路径不读 ToolProvider 持有的 effectivePolicyV3 —— 走宿主端
   * agentToolDeps.buildJudgePolicy 闭包派生的最新快照。本字段仅供观察 / debug。
   */
  isGroupSpace?: boolean;
  // planApprovalChannel 已随 plan_exit 一并移除：执行流程改由 PlanProposalCard
  // → IPC `agent-engine:plan-execute` 完成；Daemon 端目前没有对等 UI 入口，
  // 后续如需远端执行可在 daemon 内独立加 HTTP 通道。
  /**
   * W7a P2-C：宿主 logger，用于 plan-tools 内部 catch 块的错误堆栈输出。
   *
   * 缺省时 plan-tools 错误用 `console.warn` 兜底（plan-tools 默认行为）。
   * 实际生产环境应当透传 DaemonAgentHost 的 structured logger，让运维能
   * grep 到 `[plan-tools]` 前缀定位 plan API 调用失败原因。
   */
  logger?: Logger;
  /**
   * Wave 3a N2：skills_read / skills_search 依赖（与 ElectronToolProvider 对齐）。
   * 未注入时不注册这两个工具。
   */
  skillsDeps?: SkillsToolsDeps;
  /**
   * Wave 3a N2：skill_invoke 依赖（与 ElectronToolProvider 对齐）。
   * 未注入时不注册 skill_invoke。
   */
  skillInvokeDeps?: SkillInvokeDeps;
  /**
   * Wave 3a N2：skill_create 依赖（与 ElectronToolProvider 对齐）。
   * 未注入时不注册 skill_create。
   */
  skillCreateDeps?: SkillCreateDeps;
  /**
   * Wave 1.5：Skill 运行时密钥注入 resolver（与 ElectronToolProvider 对齐）。
   * Daemon 场景同样需要通过 HTTP 反查 Skill 绑定凭据，资源复用与 Electron
   * 一致；目前 Daemon 宿主尚未接入（TODO：DaemonAgentHost 构造 resolver）。
   */
  skillCredentialResolver?: SkillCredentialResolver;
  /**
   * OS 访问错误黑名单 —— 由 DaemonAgentHost 按 Organization 取进程内共享
   * store，并同步注入到 EngineConfig.osErrorBlacklist。两端必须同实例：本 ToolProvider 注册的
   * `clear_os_error_blacklist` 工具操作的、与 tool-orchestration 短路
   * 检查的，是同一对象。
   *
   * 缺省时 clear 工具会自报 unsupported，orchestration 不做短路（行为退回旧路径）。
   */
  // W3 (2026-05-10): `toolLogReader` removed — sole consumer was the deleted
  // `retrieve_tool_result` tool (level-3 fallback to scan tool-logs/*.md).
  osErrorBlacklist?: OSErrorBlacklist;
  /**
   * 宿主提供的"重启自身"实现 —— Daemon 模式下没有 Electron `app.relaunch()`，
   * 由 DaemonAgentHost 注入 spawn 新进程后 `process.exit(0)` 的实现。
   * 缺省时 relaunch_app 工具返回 unsupported_in_this_runtime（典型
   * Daemon 部署场景）+ isError:false + 中文 user_message。
   */
  relaunchApp?: () => Promise<void>;
  /**
   * 重启前的 unsaved 状态保护钩子 —— 与 ElectronToolProvider.beforeRelaunch
   * 接口对称（Wave 1 第二轮 Review S-5）。Daemon 当前没有 GUI 也就没有
   * unsaved 概念，本字段短期不会被用；保留给未来"未提交工作流配置 / 草稿"
   * 等场景复用，让两端 API 保持对称。
   */
  beforeRelaunch?: () => Promise<void>;
}

// ─── MCP TODO ────────────────────────────────────────────────────────
//
// W7a：Daemon 端 MCP 工具注入留作 follow-up Wave 处理。
//
// 现状：ElectronToolProvider 通过 `localMcpAgentTools` + `LocalMcpService`
// 暴露 mcp_list_servers / mcp_call_tool 等元工具，让 Agent 能与用户在 Electron
// 客户端配置的本地 MCP Server（claude_desktop / windsurf 等 stdio MCP）交互。
//
// Daemon 没有 LocalMcpService；它有 TabTinMcpServer（HTTP MCP Server，把
// Daemon 自身能力暴露给外部 client，与"作为 client 调用其它 MCP Server"是
// 反向）。要让 Daemon Agent 能访问 MCP 工具，需要：
//   1. 抽 LocalMcpService 到共享包（packages/local-mcp/），让 Daemon 也能维护
//      本地 MCP Server 连接池；或
//   2. 走 Django REST API 拿到 Space attached MCP servers 元数据，再 stdio
//      / HTTP 连接到目标服务（与 Electron 等价但跨进程）；或
//   3. Daemon 上层暴露 mcp_call_tool 之类的元工具，但内部走 TabTinMcpServer
//      的 HTTP endpoint —— 这只能调到 Daemon 自己的工具，与 native tools 重复。
//
// 三种方案都涉及独立设计与排期，不在 W7a 范围内。当前 Daemon Agent 仍可使用
// 全部 native tools（core / control / web / document / data / context /
// presentation 等）；MCP 工具暂不可达。
//
// 跟踪项：M3 follow-up「Daemon MCP 客户端方案选型」。

// ─── Provider ────────────────────────────────────────────────────────

/**
 * **装配点边界说明**：
 *
 * 本 ToolProvider **不**装配 ShellCap —— ShellCap 在 `DaemonAgentHost.ts` 下
 * `backendBootstrap` 段构造（与 FileSystemCap / SkillsCap / AuditCap / CostCap
 * 同处装配），通过 capability registry → `prepareAgentTools` 合并到最终的
 * tools 列表（与本 Provider 的 `getTools()` 输出取 union）。
 *
 * Provider 这一层提供的是非 Cap 化的"传统工具"集合（read_file / glob_search /
 * grep_search / 平台 tools 等）。本地 LLM 的 `run_terminal_command` 由 ShellCap
 * 贡献，与本 Provider 无关。
 *
 * **PtyManagerBridge 注入路径**（仅作为读者地图，本文件不参与）：
 *   1. `apps/tabtin-daemon/src/bootstrap/daemon.ts` `start()` 在
 *      `ptyManager.initialize()` await 完成后立即 `createDaemonPtyManagerBridge`
 *      + `setPtyManagerBridge(this.ptyManagerBridge)`，时序满足 agent-bridge.ts
 *      L544-548 硬约束（PtyManager.initialize → setPtyManagerBridge → 装配
 *      ShellCap）。
 *   2. `DaemonAgentHost.ts` 装配 ShellCap 前调 `resolvePtyManagerBridge()`
 *      拿真实 bridge；bridge 为 null（node-pty 加载失败 / PtyManager.initialize
 *      返回 false）→ fail-fast throw（D6 决策：Daemon 本地 LLM 启动就报错，
 *      不静默降级）。
 *   3. ShellCap.handler → bridge.executeAgentCommand → PTY session 真跑命令。
 */
export class DaemonToolProvider implements ToolProvider {
  private policy!: UnifiedSecurityPolicy;
  private emitStreamEvent?: (event: StreamEvent) => void;
  private todoSessionAnchor?: TodoSessionAnchor;
  private agentToolDeps?: DaemonToolProviderOptions['agentToolDeps'];
  private hostAgentToolDeps?: HostAgentToolDeps;
  // W3: legacy `toolResultStore` (Map) field removed; only the disk-backed
  // `toolResultStorage` survives (consumed by `enforceToolOutputBudget`).
  private toolResultStorage?: ToolResultStorage;
  private apiBaseUrl!: string;
  private apiAuthToken?: string;
  private organizationId?: string;
  private spaceId?: string;
  private sessionId?: string;
  private agentId?: string;
  private memoryEnabled?: boolean;
  private agentMode!: AgentModeName;
  private disabledToolPrefixes!: string[];
  /** W7a P2-C：宿主 logger（仅 plan-tools onLog 使用；缺省走 noop fallback）。 */
  private logger!: Pick<Logger, 'info' | 'warn' | 'error'>;
  private skillsDeps?: SkillsToolsDeps;
  private skillInvokeDeps?: SkillInvokeDeps;
  private skillCreateDeps?: SkillCreateDeps;
  private skillCredentialResolver?: SkillCredentialResolver;
  // W3: `toolLogReader` field removed (sole consumer was `retrieve_tool_result`).
  private osErrorBlacklist?: OSErrorBlacklist;
  private relaunchApp?: () => Promise<void>;
  private beforeRelaunch?: () => Promise<void>;
  private readonly runDocParserTask: RunDocParserTask;
  /** W7a：与 Electron 同构 — 同参数下避免每轮 LLM iteration 重建工具列表。 */
  private cachedTools: Tool[] | null = null;
  /**
   * 子 Agent fork 用的「完整工具集」provider（含 host `prepareAgentTools` 合并的
   * Cap 工具，尤其 ShellCap 的 `run_terminal_command`）。与 Electron 同构：本
   * Provider 自身 `getTools()` 不含 Cap 工具，若 `agent` 工具用 `tools: this`，
   * 子 Agent 会缺 `run_terminal_command`，CLI-first 下无法执行 tabtin 命令。
   * 由 host 装好 `mergedToolProvider` 后回注；回注前兜底用 `this`。
   */
  private subagentToolProvider?: ToolProvider;

  private effectivePolicyV3?: EffectivePolicy;

  constructor(options?: DaemonToolProviderOptions) {
    if (!options?.runDocParserTask) {
      throw new Error('DaemonToolProvider requires runDocParserTask');
    }
    this.runDocParserTask = options.runDocParserTask;
    this.initializeEffectivePolicy(options);
    this.initializeCoreOptions(options);
    this.initializeIdentityOptions(options);
    this.initializeExtensionOptions(options);
  }

  private initializeEffectivePolicy(options?: DaemonToolProviderOptions): void {
    if (options?.agentConfigV3 && options?.workspaceSnapshot) {
      // YOLO 两步授权 PRD v3 §5.5.2：构造期派生 effectivePolicyV3 时透传
      // requestedAgentMode + isGroupSpace（与 Electron 同构）。Daemon 端 isGroupSpace
      // 默认 false（mobile / Web 主控端 wire forward 加 is_group_space 字段后再切实）。
      // 主判决仍走宿主闭包；本字段只供 getEffectivePolicyV3() 观察用。
      this.effectivePolicyV3 = buildPolicyFromAgentConfigV2(
        options.agentConfigV3,
        options.workspaceSnapshot,
        {
          requestedAgentMode: resolveAgentModeName(options.agentMode, 'agent'),
          isGroupSpace: options.isGroupSpace === true,
        },
      );
    }
  }

  private initializeCoreOptions(options?: DaemonToolProviderOptions): void {
    // L-W6-06: PolicyEvaluator + getPresetPolicy 已删。ShellCap._policy 存了不读取，
    // 保留空对象占位。后续清理 ShellCap._policy 时本行可删。
    this.policy = options?.securityPolicy ?? ({} as UnifiedSecurityPolicy);
    this.emitStreamEvent = options?.emitStreamEvent;
    this.todoSessionAnchor = options?.todoSessionAnchor;
    this.agentToolDeps = options?.agentToolDeps;
    this.hostAgentToolDeps = options?.hostAgentToolDeps;
    //  Stage 2b：宿主侧默认注入 system prompt 重烘焙端口。
    if (this.agentToolDeps && !this.agentToolDeps.systemPromptProvider) {
      this.agentToolDeps.systemPromptProvider = createSystemPromptProvider();
    }
    this.toolResultStorage = options?.toolResultStorage;
    this.apiBaseUrl = options?.apiBaseUrl ?? process.env.TABTIN_API_URL ?? 'https://api.example.com';
  }

  private initializeIdentityOptions(options?: DaemonToolProviderOptions): void {
    this.apiAuthToken = options?.apiAuthToken;
    this.organizationId = options?.organizationId;
    this.spaceId = options?.spaceId;
    this.sessionId = options?.sessionId;
    this.agentId = options?.agentId;
    this.memoryEnabled = options?.memoryEnabled;
    this.agentMode = resolveAgentModeName(options?.agentMode, 'agent');
    const disabledApps = options?.disabledApps ?? [];
    this.disabledToolPrefixes = resolveDisabledToolPrefixes(
      disabledApps,
      options?.disabledToolPrefixes,
    );
  }

  private initializeExtensionOptions(options?: DaemonToolProviderOptions): void {
    // W7a P2-C：单元测试 / 嵌入式场景可能不传 logger；用 console fallback
    // 保证 plan-tools 错误至少有去处，避免 silent failure。生产环境
    // DaemonAgentHost 始终注入 structured Logger。
    this.logger = options?.logger ?? {
      info: (msg: string) => console.info(msg),
      warn: (msg: string) => console.warn(msg),
      error: (msg: string) => console.error(msg),
    };
    this.skillsDeps = options?.skillsDeps;
    this.skillInvokeDeps = options?.skillInvokeDeps;
    this.skillCreateDeps = options?.skillCreateDeps;
    this.skillCredentialResolver = options?.skillCredentialResolver;
    this.osErrorBlacklist = options?.osErrorBlacklist;
    this.relaunchApp = options?.relaunchApp;
    this.beforeRelaunch = options?.beforeRelaunch;
  }

  /** W7a：暴露当前 mode 给宿主侧 telemetry / 调试。业务路径都走 `getTools()`。 */
  getAgentMode(): AgentModeName {
    return this.agentMode;
  }

  /**
   * W2.3: 暴露当前合并后的 UnifiedSecurityPolicy 给宿主装配代码——
   * ShellCap 在装配时通过此 getter 拿到 policy 做 PolicyEvaluator
   * 工具层硬拒绝兜底（与既有工具层硬拒绝行为对齐）。Electron 同构。
   */
  getPolicy(): UnifiedSecurityPolicy {
    return this.policy;
  }

  getEffectivePolicyV3(): EffectivePolicy | undefined {
    return this.effectivePolicyV3;
  }

  // W3 (2026-05-10): `getToolResultStore()` removed — see Electron parallel.

  getTools(): Tool[] {
    if (this.cachedTools) return this.cachedTools;

    const tools: Tool[] = [
      ...createCoreTools({
        emitStreamEvent: this.emitStreamEvent,
        todoSessionAnchor: this.todoSessionAnchor,
      }),
      ...createWebTools({
        apiBaseUrl: this.apiBaseUrl,
        apiAuthToken: this.apiAuthToken,
        organizationId: this.organizationId,
      }),
      ...createDocumentTools({
        apiBaseUrl: this.apiBaseUrl,
        apiAuthToken: this.apiAuthToken,
        organizationId: this.organizationId,
      }),
      // W13c：本地 Runtime 4 类 FC 工具补全（rag/memory/conv/credential）。
      ...createDataTools({
        apiBaseUrl: this.apiBaseUrl,
        apiAuthToken: this.apiAuthToken,
        organizationId: this.organizationId,
        agentId: this.agentId,
        memoryEnabled: this.memoryEnabled,
      }),
      // W3 (2026-05-10): `createContextTools` deleted — see Electron parallel.
      // Large outputs land in `toolResultStorage` via `enforceToolOutputBudget`
      // and the LLM re-reads them through `read_file`; no LLM-facing retrieve
      // tool exists. Condensation runs entirely inside `compaction-orchestrator`.
      ...createPresentationTools({
        emitStreamEvent: this.emitStreamEvent,
        //  RB1：show_widget 烤图 OSS 上传的 organizationId 由 host 烘进
        // deps，工具不再从 ToolContext 读。
        organizationId: this.organizationId,
        // ：资源类型枚举 / slide 禁自动打开 / 烤图实现由宿主注入。
        supportedResourceTypes: PRESENT_SUPPORTED_RESOURCE_TYPES,
        autoOpenPolicy: presentAutoOpenPolicy,
        buildLocalFileArtifactUrl,
        bakeAndUpload: bakeAndUploadWidget,
      }),
      // PRD 08 W1：tabcode 4 件套（read_file / edit_file / write_file / delete_file）。
      // 与 Electron 同构。adapter 通过 ToolContext.workspaceRoot 拿 workspace 根。
      //
      // runDocParserTask 注入：让 read_file 能对 .pdf/.docx/.xlsx 走 parseLocalAttachment
      // 临时本地解析（0 OSS / 0 入库 / 0 索引 / 0 计费）。worker pool 在 daemon 端默认
      // 并发 1（apps/tabtin-daemon/src/platform/content/document/doc-parser-runner.ts）—— LLM 多次并发
      // read_file 时会排队，可接受。
      //
      // **W4 (2026-05-12)** getToolResultsDir：与 ElectronToolProvider 对齐
      // —— summarizeToolOutput / enforceToolOutputBudget 持久化的引用文件
      // 不在 workspace 内，需要专门豁免 read_file 才能让 LLM 沿着 banner
      // 路径读回完整内容。从 toolResultStorage 同源派生（缺省时返 undefined
      // → 行为退化，与不绑 storage 一致）。
      ...createTabCodeTools({
        runDocParserTask: this.runDocParserTask,
        // **W3 (2026-05-13)** PPTX 临时通道注入（与 Electron 同款）：
        // read_file('./foo.pptx') 走 OSS short TTL + parse-sync-temp 链路，
        // 不写 FileRecord / FileUsage / ParsedDocument。token / apiBase
        // 走 ToolProvider 已注入字段，避免硬编码。
        runTempPptxParse: createRunTempPptxParse({
          apiBaseUrl: this.apiBaseUrl,
          getAuthToken: () => this.apiAuthToken,
        }),
        getToolResultsDir: () => this.toolResultStorage?.getResultsDir?.(),
      }),
    ];

    // Wave 3a N2：skill 工具四件套（与 ElectronToolProvider 对齐）。
    if (this.skillsDeps) {
      tools.push(...createSkillsTools(this.skillsDeps));
    }
    // Skill 激活由 runtime beforeRun hook 处理，不向模型注册工具。
    if (this.skillCreateDeps) {
      tools.push(createSkillCreateTool(this.skillCreateDeps));
    }

    // W7a：plan / study 模式按需注入 plan-tools（与 ElectronToolProvider 对齐）。
    // 缺 spaceId / organizationId 时跳过 —— Daemon 单 Agent 通常有这两个 id；缺失
    // 表明 Django 没传完整 payload，此时 plan_create 会因为 deps 不全失败，
    // 用户体感是 LLM 调 plan_create 报错。
    if (
      (this.agentMode === 'plan' || this.agentMode === 'study') &&
      this.organizationId &&
      this.spaceId
    ) {
      const planOnLog = (level: 'error' | 'warn' | 'info', msg: string, err?: unknown) => {
        const detail = err instanceof Error ? `: ${err.message}` : err !== undefined ? `: ${String(err)}` : '';
        const line = `[plan-tools] ${msg}${detail}`;
        if (level === 'error') this.logger.error(line);
        else if (level === 'warn') this.logger.warn(line);
        else this.logger.info(line);
      };
      tools.push(
        ...createPlanTools({
          // §17.6 D4：PlanToolsDeps.sessionId → threadId（业务对话 thread）。
          threadId: this.sessionId,
          // W7a P2-C：与 ElectronToolProvider 同构 —— plan-tools 内部 catch
          // 块的错误堆栈通过 onLog 进入宿主 logger。
          onLog: planOnLog,
          // 本地运行时（Daemon）：plan 落 working_dir 本地 .md 文件，与 Electron 对齐。
          planStore: new LocalFilePlanStore({
            threadId: this.sessionId,
            agentId: this.agentId,
            agentMode: this.agentMode,
            onLog: planOnLog,
          }),
        }),
      );
    }

    // ：与 Electron 对齐——由 contract 的 proposableTargets 驱动注册方向，
    // 不再硬编码「仅 plan」。daemon 是 headless 宿主，工具会直接返回
    // requires_client_approval，引导用户去桌面端审批切换。
    const proposableTargets = getProposableModeTargets(this.agentMode);
    if (proposableTargets.length > 0 && this.organizationId && this.spaceId) {
      tools.push(
        createSwitchModeTool({
          isHeadlessHost: true,
          currentMode: this.agentMode,
          allowedTargets: proposableTargets,
        }),
      );
    }

    if (this.agentToolDeps) {
      const subagentTools = createSubagentToolProvider(this.subagentToolProvider ?? this);
      const agentConfig = {
        ...this.agentToolDeps,
        // 子 Agent 继承完整工具集（含 ShellCap.run_terminal_command）；
        // 但不装只属于父 Agent 编排面的工具（如 todo）。
        // host 回注前兜底用 this（缺 Cap 工具的裸集）。
        tools: subagentTools,
      };
      tools.push(this.hostAgentToolDeps
        ? createHostAgentTool(agentConfig, this.hostAgentToolDeps)
        : createAgentTool(agentConfig));
    }

    // System 工具组 —— 恒注册（Wave 1 第二轮 Review S-3 解耦修订）。
    //   - relaunchApp 缺省 → 工具返回 unsupported_in_this_runtime + 中文 user_message
    //   - osErrorBlacklist 缺省 → clear 工具自报 unsupported
    // 两个 dep 之间产品语义无关，不该相互绑死。
    tools.push(...createSystemTools({
      relaunchApp: this.relaunchApp,
      osErrorBlacklist: this.osErrorBlacklist,
      beforeRelaunch: this.beforeRelaunch,
    }));

    // 与 ElectronToolProvider 同构：不再 filter 工具集。
    // 改为 annotateToolsForMode 在受限模式下给被拒工具的 description
    // 末尾追加 mode 提示；调用时由 judge.ts step 0 / plan-mode-guard 软拒。
    // matchDisabledTool 仍生效——disabledApps / disabledToolPrefixes 是用户级
    // 偏好（与 mode 正交），不属于 mode 软拒治理范围。
    const result = annotateToolsForMode(tools, this.agentMode)
      .filter(tool => !this.matchDisabledTool(tool.name));
    this.cachedTools = result;
    return result;
  }

  private matchDisabledTool(toolName: string): string | null {
    return matchDisabledToolDomain(toolName, this.disabledToolPrefixes);
  }

  /** W7a：手动失效工具缓存（外部事件触发，如 deferred tools 激活）。 */
  invalidateToolCache(): void {
    this.cachedTools = null;
  }

  /**
   * W7a：实现 ToolProvider.refreshTools 接口，确保引擎侧
   * pendingToolRefresh 路径正确失效缓存。
   */
  async refreshTools(): Promise<void> {
    this.cachedTools = null;
  }

  /**
   * W7a：就地重配置 agentMode（软切换路径），避免重建整个 ToolProvider。
   *
   * 副作用：
   *   - 更新内部 agentMode 字段
   *   - 同步更新 agentToolDeps.agentMode（子 agent 继承新 mode）
   *   - 失效工具缓存（下次 getTools 按新 mode 重新构建并过滤）
   *
   * 与 ElectronToolProvider.reconfigure 接口完全对称。
   */
  reconfigure(opts: { agentMode: AgentModeName }): void {
    this.agentMode = resolveAgentModeName(opts.agentMode, 'agent');
    if (this.agentToolDeps) {
      this.agentToolDeps.agentMode = this.agentMode;
    }
    this.cachedTools = null;
  }

  /**
   * 回注「子 Agent 完整工具集」provider（host 装好 `mergedToolProvider` 后调用）。
   * 与 ElectronToolProvider.setSubagentToolProvider 同名同语义。
   */
  setSubagentToolProvider(provider: ToolProvider): void {
    this.subagentToolProvider = provider;
    this.cachedTools = null;
  }

  setSubagentSystemPrompt(prompt: string, buildConfig?: SystemPromptConfig): void {
    if (this.agentToolDeps) {
      this.agentToolDeps.systemPrompt = prompt;
      if (buildConfig !== undefined) {
        this.agentToolDeps.systemPromptBuildConfig = buildConfig;
      }
    }
  }

  /**
   * LH2-A1（H3-C）：与 ElectronToolProvider 同名同语义——host `handleQuery`
   * 在 DeliveryBatchBuffer 创建后调用，让 agent-tool 能转发子 Agent raw events 到
   * 独立 trace 通道（带 parent_trace_id / child_trace_id 注入）。
   *
   * 旧 host 不调用本方法即等同 H2-A 行为（向后兼容）。
   */
  setSubagentTraceWiring(
    subagentTraceEmitter: ((event: StreamEvent) => void | Promise<void>) | undefined,
    getParentTraceId: (() => string | undefined) | undefined,
  ): void {
    if (this.agentToolDeps) {
      this.agentToolDeps.subagentTraceEmitter = subagentTraceEmitter;
      this.agentToolDeps.getParentTraceId = getParentTraceId;
    }
  }

}
