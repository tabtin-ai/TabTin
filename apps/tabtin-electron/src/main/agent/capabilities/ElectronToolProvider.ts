import type { SystemPromptConfig } from '@tabtin/agent-prompt'
import type {
  ToolProvider,
  Tool,
  StreamEvent,
  ToolResultStorage,
} from '@tabtin/agent-runtime/engine'
import { sanitizeToolOutput } from '@tabtin/agent-runtime/engine'
//  批次 13：engine barrel 收敛——subagent / tools / agent-modes 符号改从包入口 import。
import type { AgentToolDeps, TodoSessionAnchor } from '@tabtin/agent-runtime'
import type { HostAgentToolDeps } from '@tabtin/agent-host/configuration'
import {
  createHostAgentTool,
  createSubagentToolProvider,
} from '@tabtin/agent-host/configuration'
import { createOssFileMaterializer } from '@tabtin/agent-host/tools'
import { createAgentTool } from '@tabtin/agent-runtime'
import type { AgentModeName } from '@tabtin/agent-modes'
import {
  createPlanTools,
  LocalFilePlanStore,
  createSwitchModeTool,
  type SwitchModeProposalRegistry,
} from '@tabtin/agent-runtime'
import {
  annotateToolsForMode,
  resolveAgentModeName,
  getProposableModeTargets,
} from '@tabtin/agent-modes'
import {
  createSkillsTools,
  createSkillCreateTool,
  createProjectTaskTools,
  type SkillsToolsDeps,
  type SkillInvokeDeps,
  type SkillCreateDeps,
  type SkillCredentialResolver,
} from '@tabtin/agent-runtime/tools'
import {
  type UnifiedSecurityPolicy,
  buildPolicyFromAgentConfigV2,
  type EffectivePolicy,
  type AgentConfigV3,
  type WorkspaceSnapshot,
} from '@tabtin/security-policy'

// PD-1（W6 M4）：AuthorizationPreset 类型已不再被本文件消费 —— 仅 OperationSwitches
// 仍由 Settings 透传，但同步标 deprecated 让 M5 统一清理。
type OperationSwitches = Record<string, 'allow' | 'confirm' | 'block'>
import { createLogger } from '../../logger.js'
import { localMcpAgentTools } from '../../services/local-mcp-agent-tools.js'
import { getLocalMcpService } from '../../services/LocalMcpService.js'
import type { ToolResult } from '@tabtin/agent-runtime/engine'
import {
  createCoreTools,
  createWebTools,
  createDocumentTools,
  createAttachmentTools,
  createPresentationTools,
  createDataTools,
  createTabCodeTools,
} from './index.js'
import { saveAttachmentToWorkspace } from '../attachment-save-adapter.js'
// ：show_widget 烤图 + present 资源类型/特判由宿主注入。
import {
  bakeAndUploadWidget,
  buildLocalFileArtifactUrl,
  PRESENT_SUPPORTED_RESOURCE_TYPES,
  presentAutoOpenPolicy,
} from '@tabtin/agent-host/capabilities'
import { uploadFileToOSS } from '@tabtin/action-tools/headless'
import { createSystemPromptProvider } from '@tabtin/agent-host/prompt'
// W3 (2026-05-10): `ToolResultStore` (alias of legacy `ToolResultArchive`)
// removed along with `retrieve_tool_result` — large-output disk persistence
// stays on `FileToolResultStorage`, but no LLM-facing tool retrieves by ID.
// `ToolLogReader` was the same tool's level-3 fallback; also gone.

const log = createLogger('plan-tools')

// ─── Provider ────────────────────────────────────────────────────────

export interface ElectronToolProviderOptions {
  // PD-1（W6 M4）：securityPreset 字段已删除 —— 不再传任何 preset 字符串。
  // ShellCap 仍消费 UnifiedSecurityPolicy 做硬红线一致性兜底；M5 收敛 v1 类型时同步删。
  securityPolicy?: UnifiedSecurityPolicy;
  // operationSwitches 在 W6 仍由 Settings 透传到 PolicyEvaluator；M5 把 PolicyEvaluator 整套删干净。
  operationSwitches?: OperationSwitches;
  agentConfigV3?: AgentConfigV3;
  workspaceSnapshot?: WorkspaceSnapshot;
  emitStreamEvent?: (event: StreamEvent) => void;
  /**
   *  / ：与 `buildTodoStateHook({ sessionAnchor })` 共用的会话锚。
   * 窗口内 todo 事件被截断后，`todo` execute 仍能以锚为种子做 update/close。
   */
  todoSessionAnchor?: TodoSessionAnchor;
  /**
   * Sub-agent support: provide these to enable the `agent` tool.
   *
   * Uses SSoT `AgentToolDeps` from `@tabtin/agent-runtime/engine` so adding a
   * new `AgentToolConfig` field does not require mirroring here and in Daemon.
   */
  agentToolDeps?: AgentToolDeps;
  /** ：host 侧 agent 工具包装（模板展开 + 交付物 enrich）。 */
  hostAgentToolDeps?: HostAgentToolDeps;
  /**
   * T-P1-4 / W3: disk-backed storage for oversized tool results.
   * `tool-orchestration.ts::enforceToolOutputBudget` writes the
   * pre-truncation content here, then injects a `<persisted-output>`
   * pointer telling the LLM to re-read via `read_file`. The legacy
   * `retrieve_tool_result` tool that consumed this storage was removed
   * in W3 — the LLM now reaches the persisted file by path, not by ID.
   */
  toolResultStorage?: ToolResultStorage;
  /** Django API base URL for web_search (default from env or https://api.example.com) */
  apiBaseUrl?: string;
  /** Auth token for Django API calls (web_search) */
  apiAuthToken?: string;
  /** Organization ID for billing attribution */
  organizationId?: string;
  /** Workspace ID for filesystem/platform tools; MCP authorization uses agentId. */
  spaceId?: string;
  /** Project ID from app context. Distinct from the member execution Workspace/Space ID. */
  projectId?: string;
  /**
   * W1-A: 用户在 ChatInput 选择的 Agent Mode。决定 `getTools()` 暴露给模型的工具集。
   *
   * - 'agent'（或省略）：所有工具可用（回归基线）
   * - 'plan' / 'ask' / 'study'：工具列表不做物理过滤（`annotateToolsForMode`
   *   只标注），调用时由 judge() step 0 按 mode 策略软拒
   * - 'group'：与 'agent' 等价的工具集，但宿主侧会注入 group 的 prompt 段
   *
   * 由 ElectronAgentHost 在 createRuntimeForSession 时透传，runtime 缓存键也包含
   * 它（mode 改变会触发 runtime 重建，避免旧 mode 的工具集继续生效）。
   */
  agentMode?: AgentModeName;
  /**
   * YOLO 两步授权 PRD v3 §5.5.2：当前 Space 是否 group 类型。
   *
   * 由 ElectronAgentHost 在 createRuntimeForSession 时透传（同 agentMode 同模式）。
   * 仅参与构造期 `buildPolicyFromAgentConfigV2` 派生 effectivePolicyV3 的 isGroupSpace
   * 入参（让 getEffectivePolicyV3() 暴露的策略与主判决路径 buildJudgePolicy 闭包一致）。
   *
   * **重要**：判决主路径不读 ToolProvider 持有的 effectivePolicyV3——它走宿主端
   * agentToolDeps.buildJudgePolicy 闭包派生的最新快照。本字段仅供观察 / debug。
   */
  isGroupSpace?: boolean;
  /** 当前 chat session id，用于 plan-tools 写入 active-plan-tracker。 */
  sessionId?: string;
  /** 当前 Agent id（bot Agent 与 Space 一对一），plan-tools 透传到 Django。 */
  agentId?: string;
  /**
   *  / ：隐私总闸（MemoRecordStyle.enabled 派生的 memoryCapability）。
   * ``false`` 时 createDataTools 不注册 memory_search / memory_write。
   */
  memoryEnabled?: boolean;
  /**
   *  WP3：判断当前 Agent 是否附着了至少一个 MCP server。
   * 未注入时回落 `LocalMcpService.listAttachedServers`；长度为 0 则不挂
   * `mcp_call_tool`，避免无配置时的幽灵工具。
   */
  hasAttachedMcpServers?: (agentId: string) => boolean;
  // planApprovalChannel 已随 plan_exit 工具一并移除：执行流程改由 PlanProposalCard
  // → IPC `agent-engine:plan-execute` 完成，runtime 工具集不再持有审批通道。
  /**
   * 本地 Skill 模块 Wave B · M3：宿主注入的 `skills_read` / `skills_search`
   * 能力回调（PRD §5.2 M3 / §5.4）。
   *
   * 由 `ElectronAgentHost` 在 `createRuntimeForSession` 时基于 main 进程的
   * `LocalSkillRegistry` 构造并传入：
   * ```ts
   * skillsDeps: {
   *   getSkill: (key) => registry.getByKey(key),
   *   search: (q, opts) => registry.search(q, opts),
   * }
   * ```
   *
   * 未注入（注册表尚未 ready 或宿主未接入）时，本 Provider 不会把 skills 工具
   * 放入 `getTools()` 返回列表——LLM 就看不到这两个工具，避免"声明了却没用"
   * 的幽灵工具。
   */
  skillsDeps?: SkillsToolsDeps;
  /**
   * Wave 2b：`skill_invoke` 依赖——按 canonical key 取 skill 记录。
   * 复用 `skillsDeps.getSkill` 即可（同一 LocalSkillRegistry 回调）。
   * 未注入时不注册 `skill_invoke` 工具。
   */
  skillInvokeDeps?: SkillInvokeDeps;
  /**
   * Wave 2b：`skill_create` 依赖——宿主负责写文件到当前 Space sandbox。
   * 未注入时不注册 `skill_create` 工具。
   */
  skillCreateDeps?: SkillCreateDeps;
  /**
   * Wave 1.5：Skill 运行时密钥注入 resolver。
   *
   * 宿主通过 `createSkillCredentialResolver(...)` 构造；每次
   * `createRuntimeForSession` 创建新 ToolProvider 时传入最新 token 对应的
   * resolver（与 `apiAuthToken` 同生命周期——token 刷新 → runtime 重建 →
   * resolver 换新，缓存自然抛弃）。
   *
   * 未注入时：`run_terminal_command` 工具在遇到 `skillContext` 时静默 no-op（与 Daemon /
   * 测试环境一致），历史行为不受影响。
   */
  skillCredentialResolver?: SkillCredentialResolver;
  // W3 (2026-05-10): `toolLogReader` was the level-3 fallback for the
  // removed `retrieve_tool_result` tool — large outputs now point the LLM
  // straight at the persisted-output file via `read_file`, so the reader
  // has no consumer left. Field removed from options to keep host-side
  // wiring honest about what the runtime actually consumes.
  /**
   * Phase 3 F5+F7：switch_mode 工具的 proposal 注册中心（由 ElectronAgentHost
   * 持有的 `ModeSwitchHandler.asProposalRegistry()` 注入）。
   *
   * 缺省时 switch_mode 仍能工作，但失去：
   *   - F5 proposal_id 防伪 / 防 double-approve
   *   - F7 同 session 重复调 already_pending 阻挡
   *
   * 生产路径必传；测试 / Daemon 可省略。
   */
  modeSwitchProposalRegistry?: SwitchModeProposalRegistry;
}

/**
 * **装配点边界说明**：
 *
 * 本 ToolProvider **不**装配 ShellCap —— ShellCap 在 `ElectronAgentHost.ts` 下
 * `backendBootstrap` 段构造（与 FileSystemCap / SkillsCap / AuditCap / CostCap
 * 同处装配），并通过 capability registry → `prepareAgentTools` 合并到最终的
 * tools 列表中（与本 Provider 的 `getTools()` 输出取 union）。
 *
 * Provider 这一层提供的是非 Cap 化的"传统工具"集合（read_file / glob_search /
 * grep_search / mcp_* / 平台 tools 等）。本地 LLM 的 `run_terminal_command` 由
 * ShellCap 贡献，与本 Provider 无关。
 *
 * **PtyManagerBridge 注入路径**（仅作为读者地图，本文件不参与）：
 *   1. `apps/tabtin-electron/src/main/services/bridge-core.ts` `setupCoreAPIs`
 *      在 `setPtyManagerAPI`（4 件套人控路径）之后立即调
 *      `setPtyManagerBridge(getOrCreateElectronPtyManagerBridge())` 完成注入。
 *      时序满足 agent-bridge.ts L544-548 硬约束（PtyManager 单例同步可用,
 *      无需 await ready）。
 *   2. `ElectronAgentHost.ts` 装配 ShellCap 前调 `resolvePtyManagerBridge()`
 *      拿真实 bridge；bridge 为 null（注入失败 / 模块加载顺序错误）→ fail-fast
 *      throw（D6 决策：不留兼容性兜底，让本地 LLM 启动时立刻报错而非"工具
 *      静默缺失"）。
 *   3. ShellCap.handler → bridge.executeAgentCommand → PTY session 真跑命令。
 */
export class ElectronToolProvider implements ToolProvider {
  private policy: UnifiedSecurityPolicy
  private effectivePolicyV3?: EffectivePolicy
  private emitStreamEvent?: (event: StreamEvent) => void
  private todoSessionAnchor?: TodoSessionAnchor
  private agentToolDeps?: ElectronToolProviderOptions['agentToolDeps']
  private hostAgentToolDeps?: HostAgentToolDeps
  // W3: legacy `toolResultStore` (Map) field removed — only the disk-backed
  // `toolResultStorage` survives, used by `enforceToolOutputBudget` to write
  // pre-truncation content; LLM reaches it via `read_file`, not by ID.
  private toolResultStorage?: ToolResultStorage
  private apiBaseUrl: string
  private apiAuthToken?: string
  private organizationId?: string
  private spaceId?: string
  private projectId?: string
  private isGroupSpace: boolean
  private sessionId?: string
  private agentId?: string
  private memoryEnabled?: boolean
  private hasAttachedMcpServers?: (agentId: string) => boolean
  // planApprovalChannel 字段已删除（见 ElectronToolProviderOptions 注释）。
  private agentMode: AgentModeName
  private skillsDeps?: SkillsToolsDeps
  private skillInvokeDeps?: SkillInvokeDeps
  private skillCreateDeps?: SkillCreateDeps
  private skillCredentialResolver?: SkillCredentialResolver
  // W3: `toolLogReader` field removed (sole consumer was `retrieve_tool_result`).
  private modeSwitchProposalRegistry?: SwitchModeProposalRegistry
  /** W1-A-LEG-3: getTools 缓存 — 同参数下避免每轮 LLM iteration 重建工具列表 */
  private cachedTools: Tool[] | null = null
  /**
   * 子 Agent fork 用的「完整工具集」provider（含 host 层 `prepareAgentTools`
   * 合并的 Capability 工具，尤其 ShellCap 的 `run_terminal_command`）。
   *
   * **为何需要**：本 Provider 自身 `getTools()` **不含** Cap 工具——
   * `run_terminal_command` 由 ShellCap 贡献，经 host 的 `prepareAgentTools`
   * 与本 Provider 取 union 后才进主 runtime（见 ElectronAgentHost
   * `mergedToolProvider`）。若 `agent` 工具用 `tools: this`，fork 出的子
   * Agent 只拿裸 Provider 工具、**唯独缺 `run_terminal_command`**，CLI-first
   * 平台下无法执行任何 `tabtin` 命令（建表格/文档/slide 全废）。
   *
   * **时序**：本 Provider 构造时 mergedToolProvider 尚未装配（ShellCap 更晚
   * 才 new），只能由 host 装好后回注；回注前 `agent` 工具兜底用 `this`。
   */
  private subagentToolProvider?: ToolProvider

  constructor(options?: ElectronToolProviderOptions) {
    if (options?.agentConfigV3 && options?.workspaceSnapshot) {
      // YOLO 两步授权 PRD v3 §5.5.2：构造期派生 effectivePolicyV3 时透传
      // requestedAgentMode + isGroupSpace，让 ToolProvider 暴露的快照与主判决
      // 路径（agentToolDeps.buildJudgePolicy 闭包）派生口径一致。
      // 主判决仍走宿主闭包（每轮重新派生 PD-13），本字段只供 getEffectivePolicyV3() 观察用。
      this.effectivePolicyV3 = buildPolicyFromAgentConfigV2(
        options.agentConfigV3,
        options.workspaceSnapshot,
        {
          requestedAgentMode: resolveAgentModeName(options.agentMode, 'agent'),
          isGroupSpace: options.isGroupSpace === true,
        },
      )
    }
    // L-W6-06: PolicyEvaluator 已删。ShellCap._policy 存了不读取（v3 用 checkHardlineCommand），
    // 保留空对象占位避免 ShellCap 构造签名变更。后续清理 ShellCap._policy 时本行可删。
    this.policy = options?.securityPolicy ?? ({} as UnifiedSecurityPolicy)
    this.emitStreamEvent = options?.emitStreamEvent
    this.todoSessionAnchor = options?.todoSessionAnchor
    this.agentToolDeps = options?.agentToolDeps
    this.hostAgentToolDeps = options?.hostAgentToolDeps
    //  Stage 2b：宿主侧默认注入 system prompt 重烘焙端口。
    if (this.agentToolDeps && !this.agentToolDeps.systemPromptProvider) {
      this.agentToolDeps.systemPromptProvider = createSystemPromptProvider()
    }
    this.toolResultStorage = options?.toolResultStorage
    this.apiBaseUrl = options?.apiBaseUrl ?? process.env.TABTIN_API_URL ?? 'https://api.example.com'
    this.apiAuthToken = options?.apiAuthToken
    this.organizationId = options?.organizationId
    this.spaceId = options?.spaceId
    this.projectId = options?.projectId
    this.isGroupSpace = options?.isGroupSpace === true
    this.sessionId = options?.sessionId
    this.agentId = options?.agentId
    this.memoryEnabled = options?.memoryEnabled
    this.hasAttachedMcpServers = options?.hasAttachedMcpServers
    this.agentMode = resolveAgentModeName(options?.agentMode, 'agent')
    this.skillsDeps = options?.skillsDeps
    this.skillInvokeDeps = options?.skillInvokeDeps
    this.skillCreateDeps = options?.skillCreateDeps
    this.skillCredentialResolver = options?.skillCredentialResolver
    this.modeSwitchProposalRegistry = options?.modeSwitchProposalRegistry
  }

  /**
   * W1-A: 暴露当前 mode 给宿主侧 telemetry / 调试断言用。
   * 调用方不应依赖这个值做业务逻辑（业务路径都走 `getTools()`）。
   */
  getAgentMode(): AgentModeName {
    return this.agentMode
  }

  /**
   * ShellCap PolicyEvaluator 硬红线兜底用。Hilt v3 下主判决走 judge()，
   * 这份 policy 仅供 ShellCap 内置的 block 分支做一致性兜底。
   */
  getPolicy(): UnifiedSecurityPolicy {
    return this.policy
  }

  getEffectivePolicyV3(): EffectivePolicy | undefined {
    return this.effectivePolicyV3
  }

  // W3 (2026-05-10): `getToolResultStore()` removed — the legacy `Map`-shaped
  // store only existed to back the deleted `retrieve_tool_result` tool.
  // Disk persistence still happens via `toolResultStorage` injected into
  // EngineConfig, but it has no LLM-facing tool that consumes it.

  getTools(): Tool[] {
    if (this.cachedTools) return this.cachedTools

    const documentTools = createDocumentTools({
      apiBaseUrl: this.apiBaseUrl,
      apiAuthToken: this.apiAuthToken,
      organizationId: this.organizationId,
    })
    const parseDocument = documentTools.find((tool) => tool.name === 'parse_document')

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
      ...documentTools,
      ...createAttachmentTools({
        apiBaseUrl: this.apiBaseUrl,
        apiAuthToken: this.apiAuthToken,
        organizationId: this.organizationId,
        saveToWorkspace: saveAttachmentToWorkspace,
      }),
      // W13c：本地 Runtime 4 类 FC 工具补全（rag/memory/conv/credential）。
      // 与 Daemon 同 deps + 同实现，UI 与无头端体验一致。
      ...createDataTools({
        apiBaseUrl: this.apiBaseUrl,
        apiAuthToken: this.apiAuthToken,
        organizationId: this.organizationId,
        agentId: this.agentId,
        memoryEnabled: this.memoryEnabled,
      }),
      // W3 (2026-05-10): `createContextTools` deleted — the two tools it
      // produced (`retrieve_tool_result` / `summarize_context`) were
      // self-invented and dogfood-proven harmful. Large outputs are
      // disk-persisted by `enforceToolOutputBudget` and re-read via
      // `read_file`; condensation is runtime-driven via `auto-compact`.
      ...createPresentationTools({
        emitStreamEvent: this.emitStreamEvent,
        //  RB1：show_widget 烤图 OSS 上传的 organizationId 由 host 烘进
        // deps，工具不再从 ToolContext 读。
        organizationId: this.organizationId,
        spaceId: this.spaceId,
        // ：资源类型枚举 / slide 禁自动打开 / 烤图实现由宿主注入。
        supportedResourceTypes: PRESENT_SUPPORTED_RESOURCE_TYPES,
        autoOpenPolicy: presentAutoOpenPolicy,
        buildLocalFileArtifactUrl,
        publishLocalFileArtifact: async ({
          absolutePath,
          mimeType,
          threadId,
          agentRunId,
          toolUseId,
        }) => {
          const contextId = [
            'agent-artifact',
            agentRunId || threadId,
            toolUseId || 'present',
          ].join(':')
          const uploaded = await uploadFileToOSS(absolutePath, {
            folder: 'agent/artifacts',
            module: 'agent',
            contextType: 'agent_artifact',
            contextId,
            mimeType,
            organizationId: this.organizationId,
            // Agent 已显式把该文件呈递给当前会话；仍使用私有 FileRecord，
            // 由移动端按 file_id 换取当前有效的访问地址。
            isPublic: false,
          })
          return {
            fileId: uploaded.fileId,
            // `url` 是 OSS 确认上传后返回的当前可访问地址。私有 FileRecord
            // 不能以 CDN 地址替代它；移动端会再用 file_id 刷新有效地址。
            url: uploaded.url || uploaded.cdnUrl || undefined,
            error: uploaded.error,
          }
        },
        bakeAndUpload: bakeAndUploadWidget,
      }),
      // PRD 08 W1：tabcode 4 件套（read_file / edit_file / write_file / delete_file）。
      // adapter 层从 ToolContext.workspaceRoot 读 workspace 根（query.ts 透传
      // EngineConfig.workspaceRoot）；focus_context 对话上线后由它接管注入。
      // workspaceRoot dep 缺省 → adapter 从 ctx 读，再回退 process.cwd()。
      //
      // 非文本 read_file 的材料化能力烘焙进工具闭包。子 Agent 复用父级
      // ToolProvider，因此无需经 EngineConfig / ToolContext 重复透传宿主端口。
      //
      // **W4 (2026-05-12)** getToolResultsDir：summarizeToolOutput /
      // enforceToolOutputBudget 把超阈值的工具输出持久化到
      // `<sessionDir>/tool-results/<id>.txt`，给 LLM 的 banner 里有引用路径；
      // 但该目录不在 workspace 内，没有此豁免 read_file 会被 workspace
      // boundary 拦截。从 toolResultStorage 同源派生（MemoryToolResultStorage
      // 没实现该方法 → 返 undefined → adapter 不注入豁免字段 → 行为退化为
      // "LLM 看到 banner 但读不了"，与不绑 storage 时一致）。
      ...createTabCodeTools({
        fileMaterializer: createOssFileMaterializer({ organizationId: this.organizationId }),
        getToolResultsDir: () => this.toolResultStorage?.getResultsDir?.(),
        parseMaterializedDocument: parseDocument
          ? async (fileId, context) => {
              const startedAt = Date.now()
              log.info('[read_file] materialized document parse started', { fileId })
              const input = { file_id: fileId, mode: 'overview' }
              const result = await parseDocument.execute(input, context)
              const rawLlmContent = result.llmContextContent ?? result.content
              const maxChars = parseDocument.maxResultSizeChars
              const boundedLlmContent = typeof rawLlmContent === 'string'
                && typeof maxChars === 'number'
                && Number.isFinite(maxChars)
                && rawLlmContent.length > maxChars
                ? `${rawLlmContent.slice(0, maxChars)}\n[Document output truncated at ${maxChars} characters.]`
                : rawLlmContent
              const protectedLlmContent = typeof boundedLlmContent === 'string'
                ? sanitizeToolOutput(boundedLlmContent, parseDocument, input).content
                : boundedLlmContent
              log.info('[read_file] materialized document parse finished', {
                fileId,
                durationMs: Date.now() - startedAt,
                isError: result.isError === true,
              })
              return protectedLlmContent === undefined
                ? result
                : {
                    ...result,
                    content: protectedLlmContent,
                    llmContextContent: protectedLlmContent,
                  }
            }
          : undefined,
      }),
    ]

    if (this.projectId) {
      tools.push(...createProjectTaskTools({
        apiBaseUrl: this.apiBaseUrl,
        apiAuthToken: this.apiAuthToken,
        organizationId: this.organizationId,
        projectId: this.projectId,
      }))
    }

    if (this.agentId) {
      tools.push(...this.createMcpTools())
    }

    // 本地 Skill 模块 Wave B · M3：skills_read / skills_search 两件套。
    // 注入依赖齐全时才把工具暴露给 LLM——否则宿主 registry 尚未 ready，工具
    // 会 getByKey(undefined) 全部落空，不如完全不注册（避免 system prompt
    // 声称工具存在但 LLM 一调就 "not found" 的"撒谎"症状，见 PRD §二 L12）。
    if (this.skillsDeps) {
      tools.push(...createSkillsTools(this.skillsDeps))
    }

    // Skill 激活由 runtime beforeRun hook 处理，不向模型注册工具。
    if (this.skillCreateDeps) {
      tools.push(createSkillCreateTool(this.skillCreateDeps))
    }

    if (
      (this.agentMode === 'plan' || this.agentMode === 'study') &&
      this.organizationId &&
      this.spaceId
    ) {
      const planOnLog = (level: 'error' | 'warn' | 'info', msg: string, err?: unknown) => {
        if (level === 'error') log.error(msg, err)
        else if (level === 'warn') log.warn(msg, err)
        else log.info(msg, err)
      }
      tools.push(
        ...createPlanTools({
          // §17.6 D4：PlanToolsDeps.sessionId → threadId（业务对话 thread）。
          threadId: this.sessionId,
          onLog: planOnLog,
          // 本地运行时（Electron）：plan 落 working_dir 本地 .md 文件。
          // LocalFilePlanStore 从 ToolContext.workspaceRoot 读工作区根。
          planStore: new LocalFilePlanStore({
            threadId: this.sessionId,
            agentId: this.agentId,
            agentMode: this.agentMode,
            onLog: planOnLog,
          }),
        }),
      )
    }

    // 通用「提议切模式」工具：注册与否、可切目标全由 contract 的 proposableTargets
    // 白名单驱动（机制与策略分离）：plan→agent；agent/ask/study→plan 等由 contract.proposableTargets 决定。
    const proposableTargets = getProposableModeTargets(this.agentMode)
    if (proposableTargets.length > 0 && this.organizationId && this.spaceId) {
      tools.push(
        createSwitchModeTool({
          isHeadlessHost: false,
          proposalRegistry: this.modeSwitchProposalRegistry,
          currentMode: this.agentMode,
          allowedTargets: proposableTargets,
        }),
      )
    }

    if (this.agentToolDeps) {
      const subagentTools = createSubagentToolProvider(this.subagentToolProvider ?? this)
      const agentConfig = {
        ...this.agentToolDeps,
        // 子 Agent 须继承「完整工具集」（含 ShellCap 的 run_terminal_command），
        // 但不装只属于父 Agent 编排面的工具（如 todo）。
        // host 回注 subagentToolProvider 前兜底用 this（仅缺 Cap 工具的裸集）。
        tools: subagentTools,
      }
      tools.push(this.hostAgentToolDeps
        ? createHostAgentTool(agentConfig, this.hostAgentToolDeps)
        : createAgentTool(agentConfig))
    }

    // Agent mode Phase 1：不再 filter 工具（filterToolsForMode 已删除，
    // ）。改用 annotateToolsForMode 把当前 mode 拒绝的工具在 description
    // 末尾加 mode 提示——让模型在工具列表能"看见"完整能力边界，调用时由
    // judge.ts step 0 / plan-mode-guard 软拒并返回带 remediation 的结构化错误。
    const result = annotateToolsForMode(tools, this.agentMode)
    this.cachedTools = result
    return result
  }

  /**
   * W1-A-LEG-3: 手动失效工具缓存。
   * 调用时机：MCP 工具列表变化、deferred tools 激活等外部事件触发。
   */
  invalidateToolCache(): void {
    this.cachedTools = null
  }

  /**
   * Review P2-1 修复：实现 ToolProvider.refreshTools 接口，
   * 确保引擎侧 pendingToolRefresh 路径正确失效缓存。
   */
  async refreshTools(): Promise<void> {
    this.cachedTools = null
  }

  /**
   * W1-A-LEG-1: 就地重配置 agentMode，避免整体重建 ToolProvider。
   *
   * 副作用：
   * - 更新内部 agentMode 字段
   * - 同步更新 agentToolDeps.agentMode（子 agent 继承新 mode）
   * - 失效工具缓存（下次 getTools 按新 mode 重新构建并过滤）
   */
  reconfigure(opts: { agentMode: AgentModeName }): void {
    this.agentMode = resolveAgentModeName(opts.agentMode, 'agent')
    if (this.agentToolDeps) {
      this.agentToolDeps.agentMode = this.agentMode
    }
    this.cachedTools = null
  }

  /**
   * 回注「子 Agent 完整工具集」provider（host 装好 `mergedToolProvider` 后调用）。
   * 失效工具缓存，确保下次 `getTools()` 重建的 `agent` 工具持有完整集引用。
   */
  setSubagentToolProvider(provider: ToolProvider): void {
    this.subagentToolProvider = provider
    this.cachedTools = null
  }

  setSubagentSystemPrompt(prompt: string, buildConfig?: SystemPromptConfig): void {
    if (this.agentToolDeps) {
      this.agentToolDeps.systemPrompt = prompt
      if (buildConfig !== undefined) {
        this.agentToolDeps.systemPromptBuildConfig = buildConfig
      }
    }
  }

  /**
   * LH2-A1（H3-C）：在 host `handleQuery` 中，deliveryBuffer 创建之后注入子
   * Agent trace 中继 emitter 与父 trace_id getter。
   *
   * 必须在每次 query 都重新注入（每次 query 都会新建 deliveryBuffer + 新的
   * `currentTraceId` closure）。本方法是 mutation 而非构造时一次性赋值——
   * 对应"runtime / toolProvider 跨 query 复用，deliveryBuffer 每 query 重建"
   * 的 ElectronAgentHost 复用模式。
   *
   * 旧 host 不调本方法 → agentToolDeps 中两个字段保持 undefined →
   * agent-tool 跳过 child trace 转发（行为完全等同 H2-A）。
   */
  setSubagentTraceWiring(
    subagentTraceEmitter: ((event: StreamEvent) => void | Promise<void>) | undefined,
    getParentTraceId: (() => string | undefined) | undefined,
  ): void {
    if (this.agentToolDeps) {
      this.agentToolDeps.subagentTraceEmitter = subagentTraceEmitter
      this.agentToolDeps.getParentTraceId = getParentTraceId
    }
  }

  // ─── MCP tools (adapted from local-mcp-agent-tools) ────────────────

  private adaptMcpTool(agentTool: (typeof localMcpAgentTools)[number]): Tool {
    const agentId = this.agentId
    return {
      name: agentTool.name,
      description: agentTool.description,
      inputSchema: agentTool.parameters as Tool['inputSchema'],
      isReadOnly: false,
      policyActionKind: 'mcp',
      disablePreStart: true,
      async execute(input: unknown): Promise<ToolResult> {
        const enriched = {
          ...(input != null && typeof input === 'object' && !Array.isArray(input) ? input : {}),
          _agent_id: agentId,
        } as Record<string, unknown>
        try {
          const result = await agentTool.execute(enriched)
          return { content: JSON.stringify(result), isError: !result.success }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          return { content: JSON.stringify({ success: false, error: msg }), isError: true }
        }
      },
    }
  }

  /**
   * W3 MCP 单入口收敛后，localMcpAgentTools 只含 mcp_call_tool 一个工具，
   * 不再需要 resident/deferred 分离。全部作为 resident 工具直接注册。
   *
   *  WP3：仅当当前 Agent 附着了至少一个 MCP server 时才注册，
   * 避免「声明了却没有 server」的幽灵工具。
   */
  private createMcpTools(): Tool[] {
    const agentId = this.agentId
    if (!agentId) return []
    const hasAttached = this.hasAttachedMcpServers
      ? this.hasAttachedMcpServers(agentId)
      : getLocalMcpService().listAttachedServers(agentId).length > 0
    if (!hasAttached) return []
    return localMcpAgentTools.map(t => this.adaptMcpTool(t))
  }
}
