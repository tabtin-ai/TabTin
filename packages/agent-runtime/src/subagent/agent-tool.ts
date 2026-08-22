/**
 * Agent Tool — factory for the `agent` FC tool that forks child queries.
 *
 * Event strategy:
 *   - Child StreamEvents are forwarded to the parent emitter with a
 *     `child_id` tag so the UI can display/group sub-agent steps.
 *   - Child tool/stream envelopes are forwarded as SUBAGENT_STREAM_EVENT
 *     (same child_event shape as the main Agent stream). Parent progress
 *     cards only get SUBAGENT_PROGRESS metadata (step_count / latest_tool).
 *   - SUBAGENT_STARTED / SUBAGENT_PROGRESS / SUBAGENT_COMPLETED /
 *     SUBAGENT_FAILED provide structured progress for the card UI.
 *
 * Cancel support:
 *   - Module-level registry maps childId -> AbortController.
 *   - Exported cancelSubagent(childId) allows ElectronAgentHost to cancel
 *     a specific child via IPC.
 */

import {
  normalizeAgentToolIntentInput,
  normalizeAgentToolString,
} from './agent-tool-intent.js';
import { ContentBlockEvents, StreamEvents } from '../engine/contracts/stream-events.js';
import type {
  InheritMode,
  SubAgentPolicyDto,
  SpeakerIdentity,
} from '../engine/contracts/wire-payloads.js';
import type {
  StreamEvent,
} from '../engine/contracts/wire-protocol.js';
import { RuntimeSystemNoticeEvent } from '../event/events/observability-events.js';
import {
  SubagentStatusEvent,
} from '../event/events/subagent-events.js';
import type {
  LLMProvider,
  ModelCapabilities,
  ModelCatalogEntry,
} from '../engine/contracts/model-llm.js';
import { FALLBACK_MODEL_CAPABILITIES } from '../engine/contracts/model-llm.js';
import type { ContentBlock, ToolParam } from '../engine/contracts/conversation.js';
import type {
  Tool,
  ToolContext,
  ToolPresentation,
  ToolResult,
  ToolProvider,
} from '../engine/contracts/tools.js';
import {
  AgentError,
  type EngineConfig,
} from '../engine/contracts/kernel.js';
import { estimateFullContextTokens } from '../engine/context/token-budget.js';
import type {
  EnginePermissionHandler,
} from '../engine/contracts/hitl.js';
import type {
  SessionConfig,
} from '../engine/contracts/context-capability.js';
// 子 Agent 模型自由度（Phase 3/4）：照菜单解析 + 命不中确定性降级 + 清单渲染。
import {
  findCatalogEntry,
  isInactiveOrMissingModelErrorType,
  resolveChildModelFromCatalog,
  renderModelCatalogMenu,
} from './model-catalog.js';
import type { BudgetTracker, SubmitResult } from '../engine/guards/budget-tracker.js';
import type {
  SubagentManager,
  SubagentLiveDeps,
  SubagentCompletionInfo,
} from '../session/subagent-manager.js';
// W4a S6（PR3）：check_agent_id 终态回落——只读读父 session 的 subagents.jsonl 索引 +
// resume-aware 折叠（按 (subSessionId,runSeq) 取最新 run）。用 readSubagentIndexEntries
// 纯读（不构造 writer、不 mkdir），保证状态查询无写副作用（review P2）。
import { readSubagentIndexEntries, foldSubagentRuns } from '../session/subagent-index.js';
import { buildChildCompletionEnvelope } from './completion-envelope.js';
import { forkQuery, subagentSessionExists, SUBAGENT_WORKER_SYSTEM_SECTION, type ForkQueryConfig } from './fork-query.js';
// H2-A FR-10：从子 lifecycle.start 提取子 trace_id（与宿主侧同语义），
// 用于在 childEmitter 转发工具内部 emit 的事件时注入子 trace_id。
// 子 Agent 主线 ReAct 事件（lifecycle / assistant / tool）经 fork-query.ts
// `yield`、由 agent-tool 这层消费成 SUBAGENT_PROGRESS，**不**经 childEmitter；
// 因此本注入仅对工具内部 `context.emitStreamEvent(...)` 主动发的事件生效。
import { extractTraceIdFromLifecycleStart } from '../event/trace.js';
// FR-17.2 / LH2-A1（H3-C）：子 Agent summary 轻量压缩 + 子 Agent ReAct
// trace 中继 + spawn_blocked / compact / trace_emitted telemetry。
// W1：从 micro-compact.ts 拆出来，与"主对话历史改写"完全解耦。
import { microCompactSubagentSummary } from '../compact/subagent-summary.js';
import { TelemetryEvents } from '../telemetry/events.js';
import { emitTelemetryEvent } from '../telemetry/emitter.js';
import {
  createSubagentWaitForUserInput,
  createChildWaitForUserInputStub,
  createSubagentUserInteractiveChannel,
} from '../permissions/subagent-hitl.js';
import type { SystemPromptProvider } from '../engine/contracts/system-prompt-provider.js';
import {
  resolveSubagentSystemPromptStringFallback,
  wrapToolProviderForAskMode,
} from './subagent-readonly.js';
import { EnvelopeEmitter } from '../engine/wire/envelope-emitter.js';

// ─── Input Schema ───────────────────────────────────────────────────

// 阶段 6.6 议题 3 翻译 + 瘦身：保留 Agent / sonnet / opus 等术语，
// 自然语言翻译成中文。
//
// 字段说明书的"教学性内容"（详细举例 / 性能调优 / 边角案例）按
// `tool-description-audit` P2-field 治理纪律搬到这里，schema 内 description
// 只留硬契约（参数语义 / 关键效果 / 默认值）。
//
// readonly 字段教学补充（jsdoc / 给维护者读，不进 LLM 视野；schema 受 P2-field 150 字预算）：
//   - 何时设 true：并行调研、信息汇总、安全审查、大文件读后只回摘要；或需 runtime 硬拦写操作。
//   - 何时不设：子任务要写文件 / fork 孙 agent / 改代码 → 缺省继承父 mode（含 yolo）。
//   - 可用工具：只读工具 + ask_user/ask_form + show_widget +
//     run_terminal_command（tabtin-readonly 白名单）。
//   - 禁用：write_file/edit_file/delete_file、mcp_call_tool（非 readonly MCP）、
//     agent、skill_invoke/skill_create、todo、switch_mode 等。
//   - 实现：`EngineConfig.agentMode='ask'` + 重烘焙 systemPrompt + annotateToolsForMode；
//     EffectivePolicy.effectiveMode 降为 agent（剥离父 yolo）。见 fork-query / subagent-readonly.ts。
const agentInputSchema = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      // 字段描述保持极简（一句
      // "The task for the agent to perform"）。怎么写好 prompt、要子 Agent
      // 回报什么，都放工具 description 的通用说明里，不在这里堆场景化例子。
      description:
        '给子 Agent 的自包含任务：目标 + 背景 + 输入 + 交付格式 + 验收。默认要求可复核细节（要点、证据路径/链接、摘录、未决/失败原因），勿只回「完成了」。角色放 role，别在 task 写「你是XX」。',
    },
    description: {
      type: 'string',
      description: '这个子 Agent 任务的简短标签（3-5 个词）。',
    },
    role: {
      type: 'string',
      // Group/Mission 编排：子 Agent 的「角色名/身份」（=派发的「主语」，谁来做，
      // 如「科普撰稿人」「数据整理员」）。用户在协作视图（chip）看到的就是它，故
      // **Group 派发务必填**。与 task 正交：task 写「做什么」，身份别塞进 task。
      // 缺省时 UI 回落「子 Agent · 短id」占位。
      description:
        '子 Agent 的角色名/身份（派发的「主语」——谁来做，如「科普撰稿人」「数据整理员」）；Group 派发务必填，用户在协作视图只看到这个名字。与 task 正交：task 写做什么，别在 task 里用「你是XX」重复身份。',
    },
    template_id: {
      type: 'string',
      //  / ：关联 id；模板差异由宿主在调用前展开为通用入参。
      description:
        '可选：关联的子 Agent 配置 id（如 Space 模板 id）。由宿主解析并展开为模型/工具等通用参数。',
    },
    model: {
      type: 'string',
      // Phase 4：放开模型选择——去掉写死的 sonnet/opus/haiku 三档（那是 Claude
      // 单家的 tier 抽象，与平台「统一多 AI」定位冲突）。改为从工具说明里「可用
      // 模型清单」按任务点 id/alias；缺省 = 跟父 Agent 一样。填了清单外的 id 不
      // 报错，runtime 会确定性降级到一个可用模型并在返回里说明。
      description: '从工具说明「可用模型清单」选一个 id/alias 填入；缺省 = 跟父 Agent 一样。',
    },
    tool_domains: {
      type: 'array',
      items: { type: 'string' },
      description:
        '可选的工具名子集；缺省（未传）时子 Agent 继承父 Agent 所有工具；' +
        '传空数组表示不给子 Agent 任何工具。' +
        '按任务给足工具即可（收窄可省工具定义的上下文开销）：只读约束交给 readonly（模式硬拦写操作），' +
        '不要用收窄工具面代替 readonly；指定子集时别漏掉任务可能用到的只读辅助工具' +
        '（如 skills_read / skills_search / web_search / parse_document）。',
    },
    readonly: {
      type: 'boolean',
      description:
        'true 时子 Agent 进只读问答模式，写操作由运行时硬拦。' +
        'ask/plan/study 模式下必须 true；缺省继承父权限。',
    },
    resume_agent_id: {
      type: 'string',
      // W2（2026-05-30）：W1 当时给 [子 Agent ID] 留的是中性文案、不暗示 resume；
      // 此处补全用途——主 Agent 拿到某子 Agent 返回的 [子 Agent ID] 后，可用它续跑/追问。
      description:
        '传入之前某子 Agent 返回的 [子 Agent ID]，续跑/追问那个子 Agent：' +
        '保留它已积累的上下文（推理与产出），把本次 prompt 作为新指令接续——' +
        '比重新派一个子 Agent 更省 token、不丢它之前做过的工作。' +
        '缺省时正常新派一个子 Agent。只能续跑已结束的子 Agent。',
    },
    background: {
      type: 'boolean',
      // W4a S4（2026-05-30）：后台执行。schema description 只留硬契约（CC 风格）。
      description:
        'true 时子 Agent 在后台跑，本工具立刻返回它的 [子 Agent ID]（不等它跑完），' +
        '你可以继续做别的事；它完成后你会收到一条带结果摘要的通知。' +
        '适合「派出去先跑着、同时干别的」的长任务；需要立刻拿结果再决定下一步时不要设。',
    },
    report_schema: {
      type: 'string',
      enum: ['free', 'findings'],
      description:
        '`findings` 时要求子 Agent 先输出发现/证据/置信度 JSON 代码块；缺省 `free` 保持普通摘要。',
    },
    fork_context: {
      type: 'boolean',
      default: false,
      description:
        'true 时把父对话历史完整转交给新子 Agent；缺省 false，只给本次 prompt。',
    },
    interrupt: {
      type: 'boolean',
      // W4a S7（2026-05-30）：中断重定向。只在配合 resume_agent_id 时生效。
      description:
        '配合 resume_agent_id 使用：true 时**中断**那个正在运行 / 排队中的子 Agent，' +
        '等它真正停下后，再用本次 prompt 作为新指令重新接续它（中断 + 重定向）。' +
        '目标子 Agent 已结束时等同普通续跑。缺省 / false：目标仍在运行则拒绝并发续跑。',
    },
    check_agent_id: {
      type: 'string',
      // W4a S6 / ：只读查状态；可自主查；短间隔冷却；勿代替 wait。
      description:
        '只查不派：传入 [子 Agent ID]，返回排队/运行/完成/失败/取消及步数等。' +
        '可自主查；短间隔复查会节流。等终态用 wait_agent_ids，勿用本字段代替等待。',
    },
    wait_agent_ids: {
      type: 'array',
      items: { type: 'string' },
      description:
        '后台派发拿 ID 后的下一轮：一次性传入待汇总的 [子 Agent ID]，挂起至全部终态。' +
        '只调用一次；勿与派发放同轮；勿用 check_agent_id 代替等待。',
    },
    message_agent_id: {
      type: 'string',
      description:
        '向运行中的子 Agent 投递 mid-flight 指引：填 [子 Agent ID]，指引写在非空 prompt。' +
        '下一轮生效；勿与 interrupt/resume 同用；queued/终态会拒绝。',
    },
  },
  // prompt 仅在「派活 / 续跑」时必填；check_agent_id 纯查询模式不需要 prompt，
  // 故不放进 required，由 execute 按模式校验（见 execute 内 prompt 校验）。
  required: [],
} as const;

// ─── HITL (moved to permissions/subagent-hitl.ts) ───────────────────
// createSubagentWaitForUserInput / createChildWaitForUserInputStub
// imported above — see that module for pending-count + timeout guards.

// ─── Cancel Registry ────────────────────────────────────────────────

const activeChildren = new Map<string, AbortController>();

/**
 * Queued 子 Agent 取消登记（P0-1 修复，2026-05-26）：
 *
 * 修前：cancelSubagent 只看 activeChildren —— queued 子 Agent 的 childId 此时
 * 还没 set 进 activeChildren（在 agent-tool.ts active 路径才 set），所以
 * cancelSubagent 返回 false → store 不 markCancelled → 卡片仍显示"排队中"
 * → BudgetTracker 槽位释放 → onActivate → 子 Agent 醒来正常跑下去。
 * 用户："我明明点了取消，怎么过会儿又跑起来了？"违背哲学 C5 取消有明确语义。
 *
 * 修后：queued 路径在 await onActivate 之前登记 { cancelController, budgetTracker }
 * 到本 Map；cancelSubagent 双查，命中 queued 时：
 *   1. abort cancelController（让 queued 路径下方 abortSignal 检查命中 'cancelled'）
 *   2. 调 budgetTracker.cancelQueued —— 从 queue 移除 + 触发 onActivate callback
 *      让 `await new Promise<void>((resolve) => onActivate(id, resolve))` resolve
 *      （callback 即 `resolve` 本身）。用 cancelQueued 而非 releaseChildAgent：后者
 *      语义是"active 完成归还 slot + drain 队首"，这里要表达的是"显式取消 queued"。
 *   3. 从 queuedChildren 移除
 *
 * 调用次数（W-H④ 订正，2026-05-30）：queued-cancel 与 active 完成是**互斥**两条
 * 路径，同一 childId 不会两者都走——
 *   - 在 queue 阶段被取消：cancelSubagent 调一次 `cancelQueued`；queued 路径检测到
 *     abort 后**提前 return**（不进 try/forkQuery），故 finally 不执行 → 不调
 *     releaseChildAgent。
 *   - 进到 active 阶段（含 queued→激活后完成/失败/active 期被取消）：只在
 *     executeChildAgent 的 finally 调一次 `releaseChildAgent`。
 * 两个方法各自也都幂等（cancelQueued 不在 queue 时返 false no-op；releaseChildAgent
 * 命不中时 no-op），即便边界上被重复调也安全。
 */
interface QueuedChildEntry {
  cancelController: AbortController;
  budgetTracker: BudgetTracker;
}
const queuedChildren = new Map<string, QueuedChildEntry>();

/**
 * W4a PR3 S7（2026-05-30，review P1/P2 收口）：**正在被 interrupt 重定向**的 childId。
 *
 * interrupt 重定向（S7）会先 `cancelSubagent(childId)` 中断旧 run，再用同一 childId
 * resume 新 run。问题：旧 run 被中断后的终态走 `notifyBgIfNeeded({status:'cancelled'})`
 * 入 NotificationQueue（dedupKey = childId）；而新 run（若也后台）完成时 `notifyCompleted`
 * **同 childId** → 旧「已取消」未 drain 时新「已完成」被 dedup 丢弃 → **主 Agent 永远收不到
 * 重定向结果**（两 reviewer 收敛的主要问题）。即便新 run 是前台（结果走 tool_result），
 * 旧 run 那条「已取消」也是矛盾噪声（「我刚成功续跑的子怎么报取消了？」）。
 *
 * 修法：interrupt 预步骤在 `cancelSubagent` **之前**把 childId 记入本 Set，旧 run 的
 * `notifyBgIfNeeded` 命中即**跳过终态通知**（主 Agent 是主动中断方、不需要这条「已取消」，
 * 它要的是 run2 的结果）；`waitUntilSettled` 返回后立刻移除，保证 run2 的终态通知正常发。
 * 模块级（与 activeChildren/queuedChildren 同维度，跨 executeChildAgent 实例通信）。
 */
const interruptingChildren = new Set<string>();

export function cancelSubagent(childId: string): boolean {
  // 优先 active 路径
  const controller = activeChildren.get(childId);
  if (controller) {
    controller.abort();
    // Review L43 修复：abort 后立即从 activeChildren 删掉，让 catch 块的
    // `wasCancelled = !activeChildren.has(childId)` 判断准确。原本只 abort
    // 不 delete 会让 catch 误判为 timeout（abort 触发 timeoutController.signal.aborted
    // → catch 命中 isTimeout 分支输出 "Sub-agent timed out" 而非 "Sub-agent cancelled"）。
    activeChildren.delete(childId);
    return true;
  }
  // P0-1 修复（2026-05-26）：queued 子 Agent 取消路径
  const queuedEntry = queuedChildren.get(childId);
  if (queuedEntry) {
    queuedEntry.cancelController.abort();
    // 用 cancelQueued 而非 releaseChildAgent —— release 对 queued 路径只删
    // callback Map 不调它（设计初衷是"active 完成后归还 slot + drain"），
    // 而 queued cancel 需要主动调 callback 让 executeChildAgent 的
    // `await new Promise<void>((resolve) => onActivate(id, resolve))` unblock。
    // 详见 budget-tracker.ts:cancelQueued JSDoc。
    queuedEntry.budgetTracker.cancelQueued(childId);
    queuedChildren.delete(childId);
    return true;
  }
  return false;
}

export function getActiveSubagentIds(): string[] {
  return [...activeChildren.keys()];
}

/**
 * 仅供测试用：拿到 queuedChildren 的 childId 列表，验证 queued cancel
 * 修复路径（agent-tool-queue.test.ts P0-1 回归测试需要）。
 */
export function getQueuedSubagentIds(): string[] {
  return [...queuedChildren.keys()];
}

// ─── Tool History Helpers ───────────────────────────────────────────

interface PendingToolCall {
  toolName: string;
  toolCallId: string;
  startedAt: number;
  inputSummary?: string;
}

/** Parent progress card only needs a short preview, not the full tool I/O. */
const TOOL_STEP_SUMMARY_MAX_CHARS = 200;

function truncateSummary(
  value: unknown,
  maxLen: number = TOOL_STEP_SUMMARY_MAX_CHARS,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen) + '…';
  } catch {
    return String(value).slice(0, maxLen);
  }
}

// ─── Model Resolution ───────────────────────────────────────────────
// Phase 4：旧的「拿 tier 词正则替换父模型字符串」(`MODEL_TIER_RE` /
// `resolveChildModel`) 已删除——它只在 Claude 单家成立、且完全不经平台目录，
// 换非 Claude 模型必失效。改走 `model-catalog.ts` 的
// `resolveChildModelFromCatalog`（照宿主注入的目录解析 + 命不中确定性降级）。

// ─── Config ─────────────────────────────────────────────────────────

export interface SubagentModelPolicy {
  mode: 'inherit' | 'fixed';
  modelId?: string;
}

export interface AgentToolConfig {
  provider: LLMProvider;
  /**
   * 宿主按最终子模型解析匹配 Provider 的端口。
   *
   * 子模型可能与父模型来自不同路由（例如父模型是本机 ChatGPT Codex，子模型是
   * 平台 / BYOK 模型）。缺省时沿用父 Provider，保持旧宿主兼容；Electron 等支持
   * 多 Provider 的宿主应注入此端口，避免出现“模型已切换、Provider 仍是父模型”
   * 的错配。
   */
  resolveProviderForModel?: (modelId: string) => Promise<LLMProvider>;
  tools: ToolProvider;
  permissionHandler: EnginePermissionHandler;
  sessionConfig: SessionConfig;
  model: string;
  systemPrompt?: string;
  /**
   * 宿主烘焙配置（opaque）；经 `systemPromptProvider.resolveSubagentPrompt` 重烘焙。
   * runtime 不解析字段形状。
   */
  systemPromptBuildConfig?: unknown;
  /**
   * 宿主注入的 system prompt 重烘焙端口（ Stage 2b）。
   * 缺省时走字符串 fallback（无 buildConfig 语义）。
   */
  systemPromptProvider?: SystemPromptProvider;
  budgetTracker?: BudgetTracker;
  /**
   * W4a S1（2026-05-30）：本会话的 SubagentManager（session 维度子 Agent 登记
   * 中心，挂在 host 的 HostState 上）。
   *
   * **双写过渡**：active 子 spawn 时，executeChildAgent 在登记模块级
   * `activeChildren`（W0 取消用，不动）之外**同时**登记到这里（session 隔离
   * 视图，新增）；finally 同时注销两边。模块级 `cancelSubagent` 行为完全不变。
   *
   * 缺省（旧 host / 测试不传）时所有 Manager 调用经 `?.` 静默跳过——行为与
   * 现状完全一致（纯增量、零回归）。透传链路：host createRuntimeForSession
   * → `AgentToolDeps.subagentManager` → `AgentToolConfig` → executeChildAgent。
   *
   * **不**经 forkQuery 透给子 Agent——子 Agent 不应自己往父会话登记表写；
   * 登记是父 turn / host 的职责。
   */
  subagentManager?: SubagentManager;
  /**
   * 宿主资源配置下发的子 Agent 迭代上限。
   *
   * 这是 host/runtime 配置，不是 `agent` 工具参数；模型不能在调用参数里为单个
   * 子 Agent 设置独立步数。未配置时保持 undefined，由子 runtime 继承“无步数墙”。
   */
  maxChildTurns?: number;
  hooks?: EngineConfig['hooks'];
  contextWindowTokens?: number;
  /** W1b fix: 父 EngineConfig.maxOutputTokens 透传到 forkQuery → 子 EngineConfig。 */
  maxOutputTokens?: number;
  /** W1b fix: 父 EngineConfig.modelCapabilities 透传到 forkQuery → 子 EngineConfig。 */
  modelCapabilities?: EngineConfig['modelCapabilities'];
  /**
   * 子 Agent 模型自由度（Phase 3/4）：宿主注入的「可用模型菜单」快照。
   *
   * 透传链路：宿主 catalog 缓存 → `agentToolDeps.modelCatalog` → 本字段。
   * 消费：
   *   - `createAgentTool` 把它渲染成 description 里的「可用模型清单」段（Phase 4）；
   *   - `execute` 用 `resolveChildModelFromCatalog` 照菜单解析子模型 + 命不中降级；
   *   - 命中后用目录里的子模型能力覆盖子 EngineConfig 的 ctx/maxOutput/caps（Phase 3，
   *     不再继承父）。
   *
   * 缺省（宿主未注入 / 旧 host / 测试）时：清单不渲染，子模型沿用「缺省跟父」
   * 行为，能力回落父值或 FALLBACK——向后兼容。
   */
  modelCatalog?: ModelCatalogEntry[];
  /**
   * 默认子 Agent 模型策略。宿主不注入时保留历史“主 Agent 可按目录选模”行为；
   * 注入后由 runtime 硬执行，而不是只靠工具说明约束。
   *
   * 模板携带的显式模型优先于本默认策略；普通 agent 工具调用里的 model 只是主
   * Agent 自主选择，不得越过 inherit / fixed 默认策略。
   */
  subagentModelPolicy?: SubagentModelPolicy;
  /**
   * 子 Agent 启动前的只读资金预检端口。
   *
   * Host 用后端 `/services/llm/billing-precheck` 实现；runtime 只消费
   * allowed/code/message 语义。预检只用于选择当前可支付的子模型，真实放行 /
   * 扣费仍由 LLM 服务端链路决定。端口缺失或异常时 fail-open，保持旧行为。
   */
  previewChildModelFunding?: (input: {
    modelId: string;
    estimatedTokens: number;
    task: string;
    label: string;
  }) => Promise<{
    allowed: boolean;
    code?: string | null;
    message?: string | null;
    requiredCredits?: string | null;
  }>;
  /**
   * 子 Agent 使用目录命中的模型后，运行时发现模型不可用时通知 host。host 可把
   * 目录视为 stale 并刷新 StateRoot 里的可用模型列表。
   */
  onModelRuntimeFailure?: (failure: {
    modelId: string;
    errorType: string;
    statusCode?: number;
    message?: string;
  }) => void;
  /**
   * 可选的子 Agent 激活后执行时限（毫秒）。缺省不限制执行时长；仅供测试或特殊部署
   * 显式启用。排队时间不计入该时限。
   */
  childTimeoutMs?: number;
  /**
   * W4a PR3 P1（2026-05-30）：后台子排队期超时兜底（毫秒），缺省
   * `DEFAULT_BACKGROUND_QUEUE_TIMEOUT_MS`（24h）。host 一般不必设；测试 / 特殊部署
   * 可注入更短值以验证排队超时网。仅作用于**后台**排队子（前台排队由外层 race 兜底）。
   */
  backgroundQueueTimeoutMs?: number;
  /**
   * Workspace root inherited from parent `EngineConfig.workspaceRoot`; forwarded
   * to `forkQuery` so the child runtime's `ToolContext.workspaceRoot` matches.
   */
  workspaceRoot?: string;
  /**
   * W1-A: 父 agent 当前 AgentMode；fork 出的子 agent 默认继承同一 mode。
   *
   * 子 agent 共享父 ToolProvider 实例，所以工具集已经按父 mode 过滤；这里把 mode
   * 也透传到子 EngineConfig 是为了 judge() step 0 的受限模式软拒（SSoT，读
   * EngineConfig.agentMode）在子 agent 层面也能正确生效，避免父子 mode 信息脱钩。
   *
   * 缺省时按 'agent' 处理（与 EngineConfig.agentMode 同一兜底语义）。
   */
  agentMode?: string;
  /**
   * FR-15 (H3-A Review P1)：父 agent 的 IterationBudget 配置。
   *
   * 透传链路：父 EngineConfig → AgentToolDeps → AgentToolConfig → forkQuery →
   * 子 EngineConfig。让子 Agent 与父会话的 warn/grace/terminate 阈值一致。
   *
   * 不透传的话子 Agent 走 `normalizeIterationBudgetConfig(undefined)` 默认
   * （iter 70/90/100 + token 85/95/100），与宿主自定义的灰度阈值脱锚。
   *
   * 与 BudgetTracker 配合：子 Agent 共享同一个 tracker（调度 / 会话硬墙），
   * 但 IterationBudget token 分子按 `budgetScope` per-scope 单独核算。
   */
  iterationBudget?: EngineConfig['iterationBudget'];
  /**
   *  Stage 2c：子 Agent end_turn 待办收尾文案端口（与父同源）。
   */
  todoCompletionNudgeProvider?: EngineConfig['todoCompletionNudgeProvider'];
  /**
   * W3：父 agent 的 ToolFailureTracker 配置（与 iterationBudget 同透传模式）。
   *
   * 透传链路：父 EngineConfig → AgentToolDeps → AgentToolConfig → forkQuery →
   * 子 EngineConfig。让子 Agent 与父会话的 stall notice/nudge 阈值一致。
   *
   * 不透传的话子 Agent 走 `new ToolFailureTracker()` 读 `process.env`——大多数
   * 情况下结果一样（都从同一进程读），但宿主显式传入更精准（避免子 Agent 在
   * env 已被 unset 后回落默认）。
   *
   * **per-Agent 独立 buffer**：fork 出的子 Agent **不共享**父的 buffer，子 Agent
   * 自己重新创建 tracker 实例（fork-query.ts 内部逻辑）——这是 by design：
   * 子 Agent 应有独立 stall 判定（父的"撞墙累积"语义不能跨边界继承）。
   */
  toolFailureTracker?: EngineConfig['toolFailureTracker'];
  /**
   * FR-16 H3-B：父 agent 的 reuse 配置透传到子 Agent（H3-B Review fix #7）。
   *
   * 透传链路：父 EngineConfig → AgentToolDeps → AgentToolConfig → forkQuery →
   * 子 EngineConfig。让 A/B 测试场景下父子配置一致——否则父关掉 reuse 子还开
   * 着会污染统计；测试注入 mock judgeFn 时子 agent 也能拿到桩。
   *
   * 与 BudgetTracker 不同：reuse 不需要"全树共享状态"——每个 Agent 起新
   * ContextManager 实例、摘要缓存自然为空 → 第一次 compact 走全量；
   * 这里透传的仅是 reuse 行为开关 + judge 配置。
   */
  enableSummaryReuse?: EngineConfig['enableSummaryReuse'];
  summaryReuseJudgeSampleRate?: EngineConfig['summaryReuseJudgeSampleRate'];
  summaryReuseJudgeWindowSize?: EngineConfig['summaryReuseJudgeWindowSize'];
  summaryReuseJudgeThreshold?: EngineConfig['summaryReuseJudgeThreshold'];
  summaryReuseMaxAgeMs?: EngineConfig['summaryReuseMaxAgeMs'];
  summaryReuseMinAddedMessages?: EngineConfig['summaryReuseMinAddedMessages'];
  summaryReuseJudgeFn?: EngineConfig['summaryReuseJudgeFn'];
  /**
   * FR-16 / ：父 agent 的 time-based microCompact 配置透传到子 Agent。
   */
  timeBasedMicroCompact?: EngineConfig['timeBasedMicroCompact'];
  /**
   * ：父 agent 的压力分档阈值 / 上下文预算透传到子 Agent，保证父子
   * 压缩触发线一致（同 timeBasedMicroCompact 模式）。
   */
  pressureThresholds?: EngineConfig['pressureThresholds'];
  contextBudget?: EngineConfig['contextBudget'];
  /**
   * FR-17.2（H3-C）：子 Agent 完成后是否对 summary 做 microCompact。
   *
   * 默认 `true`（PRD §5.2 FR-17 决策）。`false` 关闭压缩，子 Agent 直接把
   * 原 summary 写到父 Agent tool_result（A/B 测试 / 与 H3-B summary reuse
   * 兼容性核对场景才需要关）。子 Agent 失败（isError=true）时不走 compact——
   * 错误信息保留全文便于父 Agent 排查。
   *
   * Host 透传链路：`EngineConfig.subagentResultCompact` → 宿主在
   * `createRuntimeForSession` 时把字段塞到 `agentToolDeps.subagentResultCompact`。
   */
  subagentResultCompact?: boolean;
  /**
   * T-P1-4: parent's ToolResultStorage forwarded to child via forkQuery so
   * oversized tool results persist to the same disk-backed store across the
   * parent→child boundary.
   */
  toolResultStorage?: EngineConfig['toolResultStorage'];
  /**
   * W1b HITL：父 Agent 的 waitForUserInput 函数。
   *
   * 由宿主通过 `EngineConfig.waitForUserInput` → `AgentToolDeps` 透传。
   * 非空时，子 Agent 碰到 ask_user / ask_form 等 HITL 工具会委托给父 Agent 的
   * 审批通道，而非抛错。缺省时子 Agent 回退到 stub（抛 "host does not
   * support HITL"）。
   *
   * 接线留给后续 Wave 的宿主层——本期只确保类型定义允许传入，且
   * 三路径工具 + 旧 agent 工具能消费。
   */
  waitForUserInput?: (requestId: string) => Promise<unknown>;
  /**
   * 子/孙 Agent 后台完成通知的本地 drain 入口。
   *
   * 顶层后台通知仍按业务 thread 唤醒主 Agent；嵌套后台通知用发起者子 Agent 的
   * run_id 入队，并由该子 runtime 在 beforeModel 边界按自己的 run_id 主动消费。
   */
  drainSubagentNotifications?: (subagentRunId: string) => Promise<string | null>;
  /**
   * LH2-A1（H3-C）：子 Agent 主线 ReAct 事件的独立 trace emitter。
   *
   * 当 host 注入此 emitter 时，agent-tool 在 while loop 内对每个 child
   * stream event（lifecycle / assistant / tool / step / done / system_notice）
   * 都调用一次：
   *   `subagentTraceEmitter({ ...event, payload: { ...event.payload,
   *     run_id: childId,
   *     trace_id: childTraceId,
   *     parent_trace_id: parentTraceId,
   *     subagent_run_id: childId,  // compat alias 与 SUBAGENT_STARTED 对齐
   *     observer_only: true,
   *   } })`
   *
   * **不经 ToolContext.emitStreamEvent**：父 Agent 的 chat UI 不应渲染 child raw
   * events（已经有 SUBAGENT_PROGRESS 给到父端体感）。这条独立通道的目的是把
   * child events 直接推给 DeliveryBatchBuffer → Django relay_handler → 写入子
   * ExecutionTrace（带 parent_trace_id 关联），让 AdminDash trace-detail 嵌套
   * 展开。host 在 `handleQuery` 里通常实现为 `(evt) => relayBuffer.push(evt)`。
   *
   * 未注入时（旧 host / 测试），agent-tool 行为完全等同 H2-A——只发
   * SUBAGENT_* 父视角事件。这是显式向后兼容。
   */
  subagentTraceEmitter?: (event: StreamEvent) => void | Promise<void>;
  /**
   * Hilt v3 / W6 M1：父子同构走 judge() —— 透传 toolRiskPolicy /
   * homeDir 让子 Agent 也走 v3 判决。
   */
  toolRiskPolicy?: EngineConfig['toolRiskPolicy'];
  judgeHomeDir?: EngineConfig['judgeHomeDir'];
  /**  Stage 4：子 Agent 按自身 agentMode 绑定 ToolGate。 */
  bindToolGate?: EngineConfig['bindToolGate'];
  annotateReadonlyChildTools?: EngineConfig['annotateReadonlyChildTools'];
  /**
   * D-1 Wave 6：父 Agent 的 Organization 级 OS 错误黑名单实例。
   *
   * 透传链路：父 EngineConfig → AgentToolDeps → AgentToolConfig → forkQuery →
   * 子 EngineConfig。子 Agent 与父 Agent 共用同一个引用，保证父写入后子
   * 短路、任一方 clear 后双方立即解封。
   */
  osErrorBlacklist?: EngineConfig['osErrorBlacklist'];
  /**
   * FR-09 / 中性化：父 Agent 的「shell 命令是否返回外部不可信字节」谓词。
   *
   * 透传链路：父 EngineConfig → AgentToolDeps → AgentToolConfig → forkQuery →
   * 子 EngineConfig。子 Agent 必须继承同一谓词，才能与父 Agent 一致地把
   * `run_terminal_command` 的外网字节结果纳入 fence（安全等价）；缺省时子 Agent
   * 的 `run_terminal_command` 不 fence（与主 Agent 中性默认一致）。
   */
  isUntrustedShellCommand?: EngineConfig['isUntrustedShellCommand'];
  /**
   * PRD 08 W1：父 Agent 的 readFileState（read-before-edit 共享快照）。
   *
   * 透传链路：父 EngineConfig → AgentToolDeps → AgentToolConfig → forkQuery →
   * 子 EngineConfig。子 Agent 在 fork 时从父 Map 复制一份独立 snapshot（
   * `forkQuery` 内部 new Map(parent ?? [])），既继承"父读过的文件"信号
   * （子可直接 edit_file 不需重读），又让子的写入不会污染父级 / 子之间不会
   * race（per-fork 隔离）。父 config 未注入则子也是 undefined。
   */
  readFileState?: EngineConfig['readFileState'];
  /**
   * **W2（2026-05-13）**：父 Agent 的 image / localDoc dedup 状态。
   *
   * 同款"父→AgentToolDeps→ForkQuery→子 EngineConfig" 透传链路；forkQuery
   * 内部 shallow clone 让子继承"父已读过哪些图 / 文档"的判等签名，子第一
   * 次撞同款文件直接命中 stub 不重塞 base64 / 全文。父 config 未注入则
   * 子也是 undefined。
   */
  imageReadFileState?: EngineConfig['imageReadFileState'];
  localDocReadFileState?: EngineConfig['localDocReadFileState'];
  /**
   * per-file 回退引擎（替代 shadow git）。
   *
   * 透传链路：父 EngineConfig → AgentToolDeps → AgentToolConfig → forkQuery →
   * 子 EngineConfig。**与 readFileState 的关键区别：子 Agent 共享父的同一实例
   * （forkQuery 不 clone）**——子 Agent 改的文件落到同一 thread 的回退账本（同
   * anchorId/agentRunId），回退时一并还原，不会因 fork 边界漏掉子改动。父 config
   * 未注入则子也是 undefined（trackEdit no-op）。
   */
  fileHistory?: EngineConfig['fileHistory'];
  /**
   * W3：HITL 审批通道。子 Agent 必须继承父级 channel（详见
   * `ForkQueryConfig.userInteractiveChannel` 注释）—— 父级 enforce 时
   * 子 runtime 拿不到 channel，所有 ask 决策落 fail-closed deny + 文案
   * 「no UserInteractiveChannel is wired」，造成父对话能弹审批、子任务
   * 工具全自动拒绝的不一致体验。
   */
  userInteractiveChannel?: EngineConfig['userInteractiveChannel'];
  /**
   *  Phase 1（readonly 子 Agent 注入 DI）：宿主注入的「readonly 子
   * Agent 附加 hook」工厂。原来 fork-query 硬编码一个「ask 模式」mode-reminder
   * 注入，但该注入已迁到宿主内容包，引擎不能反向依赖宿主内容包。改由宿主装配
   * `agent` 工具时把「readonly 子 Agent 附加 hook」工厂经此字段透传到
   * ForkQueryConfig。缺省 → readonly 子 Agent 不加内容注入 hook。
   *
   * 透传链路：宿主装配 → AgentToolDeps → AgentToolConfig → buildChildForkConfig →
   * ForkQueryConfig.buildReadonlySubagentHooks → fork-query buildChildHooks。
   */
  buildReadonlySubagentHooks?: ForkQueryConfig['buildReadonlySubagentHooks'];
  /**
   * LH2-A1（H3-C）：父 Agent 当前 trace_id 的获取器。
   *
   * Host 从 lifecycle.start 维护本 query 的 trace_id，runtime EventEmitter 已在
   * 源头给普通事件盖 trace；本字段用于 child 独立 trace 的父子关联，让 agent-tool 转发 child
   * events 到 `subagentTraceEmitter` 时能注入 `parent_trace_id`，便于 Django
   * 后端写入子 ExecutionTrace.metadata.parent_trace_id 做嵌套关联。
   *
   * 设计为 getter 函数而非 string 字段：
   *   - host 在每次 handleQuery 都重新生成 trace_id；
   *   - agent-tool 实例与 ToolProvider 实例长生（runtime 缓存内复用）；
   *   - 用 closure 让"trace_id 切换"对 agent-tool 透明。
   *
   * 未注入时 `parent_trace_id` 字段会被设为 `undefined`——AdminDash 会优雅
   * 降级（不渲染嵌套链路），但子 trace 仍能独立查看。
   */
  getParentTraceId?: () => string | undefined;
}

/**
 * SSoT for the `agent` tool dependencies shape exposed to tool providers.
 *
 * Hosts wire sub-agent support by passing `agentToolDeps` to their
 * ToolProvider; that shape is structurally `AgentToolConfig` minus `tools`
 * (the provider supplies itself to avoid a circular reference).
 *
 * Electron (`ElectronToolProvider`) and Daemon (`DaemonToolProvider`)
 * should reference this type instead of duplicating the structure inline,
 * so adding a new `AgentToolConfig` field (e.g. later iterations of FR-17
 * sub-agent quotas) requires changing only one place.
 */
export type AgentToolDeps = Omit<AgentToolConfig, 'tools'>;

/**
 * W-H①（2026-05-30）：agent 子 Agent 工具的**外层墙钟兜底**值。
 *
 * 子 Agent 缺省不设激活后的执行时限；仅当 host 显式注入 `childTimeoutMs` 时，内层
 * `timeoutController` 才从 activation 起计时（排队不计入，见 D3a）。本常量只是
 * tool-orchestration / executeTool 那层"工具卡死了就 reject 解锁编排"的最后保险，
 * 从「工具派发时刻」起算（含排队等待）。
 *
 * 为什么是 24h「极大值」而非旧的 `DEFAULT_CHILD_TIMEOUT_MS + 1s`（301s）：
 *   - 旧值从派发时刻起算却只给 301s → 大 fan-out 下排队久（5 active + 95 queue 默认满
 *     队列最坏 ~100min）的子在还没轮到激活、或刚激活就被外层 TOOL_TIMEOUT 冤杀，违背
 *     D3a「排队不计入超时」。这是 W-H① 要根治的 bug。
 *   - 为什么不用 `Infinity`：那会彻底撤掉 orchestration 边界的 `Promise.race` 硬兜底，
 *     万一 forkQuery 的 generator 无法 settle，父 turn 会**永久挂起**。24h 不再作为
 *     子 Agent 的产品执行时限，只保留为工具编排层的故障兜底。
 *   - 若未来有部署真把队列配到使排队 > 24h，这里就是要调的旋钮（但更应先想想为什么
 *     单个子要排这么久）。
 */
const AGENT_TOOL_OUTER_TIMEOUT_BACKSTOP_MS = 24 * 60 * 60 * 1000;

/**
 * W4a PR3 P1（2026-05-30）：**后台子**排队期的超时兜底（safety net）默认值。
 *
 * 前台子排队由外层 orchestration 的 `Promise.race`（从派发时刻起算的 24h backstop）
 * 兜底；但**后台子**一旦 detach，外层 race 不再盯着它——若它永远排不上队（budget
 * 异常 / 队列永不 drain），它会在 Manager 登记表 + detached promise 里**永久泄漏**。
 * 本常量给排队中的后台子一道独立超时网：超过它仍没轮到执行就 cancelQueued + 报
 * timeout 终态，防泄漏。值取 24h——排队本就该「派任务总是被接住」(C3) 地长等，这只是
 * 「绝不该真触发」的极大值兜底；host 可经 `AgentToolConfig.backgroundQueueTimeoutMs`
 * 注入更短值（测试 / 特殊部署）。前台子排队**不**设此 timer（行为不变，外层 race 兜底）。
 */
const DEFAULT_BACKGROUND_QUEUE_TIMEOUT_MS = AGENT_TOOL_OUTER_TIMEOUT_BACKSTOP_MS;

/**
 * W4a PR3 S7（2026-05-30）：interrupt 中断后等待目标子真正 settle 的上限。
 *
 * interrupt 先 `cancelSubagent` 中断当前 run，再 `manager.waitUntilSettled` 等子彻底
 * 收尾（forkQuery finally：storage flush + recordEnd(cancelled)）才走 W2 resume——
 * 避免同 childId 两 run 并发写 messages.jsonl（北极星②）。settle 本应很快（abort 传播
 * + 一次 flush），10s 足够覆盖正常磁盘 I/O；超时未 settle 则放弃 resume 让主 Agent 重试，
 * 而不是冒并发写风险硬上。
 */
const INTERRUPT_SETTLE_TIMEOUT_MS = 10 * 1000;
const SUBAGENT_TERMINAL_FACT_MODEL_ID = 'agent-runtime-subagent';

/**
 * W1（身份延续，2026-05-30）：把子 Agent 的 `childId` 附到 tool_result 末尾，
 * 让主 Agent（LLM）拿到稳定标识——这是 W2 resume / W3 interrupt / W4a 后台查询
 * 的前置：主 Agent 必须先「知道」每个子 Agent 的 id，后续才能引用它。
 *
 * **必须在 microCompactSubagentSummary 之后追加**：成功路径 `finalSummary` 已压缩、
 * 失败路径 `summary` 是短错误消息不压缩，两路在此处 append 都不会被截断（若在
 * 压缩前混入，长 summary 触发头尾截断时 id 可能落在被省略的中段而丢失）。
 *
 * 标记用方括号纯文本而非 XML：与现有 SUBAGENT_COMPLETED.subagent_run_id（给前端）
 * 正交，这条只服务 LLM 文本上下文，简洁可读即可。
 */
function appendSubagentId(content: string, childId: string): string {
  return `${content}\n\n[子 Agent ID: ${childId}]`;
}

function subagentResultPresentation(
  childId: string,
  status: 'completed' | 'cancelled' | 'timeout' | 'failed',
): ToolResult['presentation'] {
  return {
    kind: 'subagent_result',
    data: { subagent_run_id: childId, status },
  };
}

function subagentDispatchPresentation(
  childId: string,
  status: 'pending' | 'queued',
  background: boolean,
): ToolResult['presentation'] {
  return {
    kind: 'subagent_dispatch',
    data: { subagent_run_id: childId, status, background },
  };
}

function buildSubagentTerminalFactEvents(args: {
  threadId: string;
  parentToolCallId: string;
  childId: string;
  status: 'completed' | 'cancelled' | 'timeout' | 'failed';
  content: string;
  isError?: boolean;
}): StreamEvent[] {
  const emitter = new EnvelopeEmitter({
    traceId: crypto.randomUUID(),
    threadId: args.threadId,
    runId: `subagent-terminal-${crypto.randomUUID()}`,
  });
  const block: ContentBlock = {
    type: 'tool_result',
    tool_use_id: args.parentToolCallId,
    content: appendSubagentId(args.content, args.childId),
    ...(args.isError === true ? { is_error: true } : {}),
    presentation: subagentResultPresentation(args.childId, args.status),
  } as ContentBlock;
  return emitter.emitPersistedInlineMessage({
    messageId: crypto.randomUUID(),
    blockId: `blk_${crypto.randomUUID()}`,
    modelId: SUBAGENT_TERMINAL_FACT_MODEL_ID,
    modelName: SUBAGENT_TERMINAL_FACT_MODEL_ID,
    role: 'user',
    block,
  });
}

function emitBackgroundSubagentTerminalFact(
  prepared: PreparedChildExecution,
  args: {
    status: 'completed' | 'cancelled' | 'timeout' | 'failed';
    content: string;
    isError?: boolean;
  },
): void {
  if (!prepared.isBackground) return;
  const parentToolCallId = prepared.params.parentToolCallId;
  if (!parentToolCallId) return;
  for (const event of buildSubagentTerminalFactEvents({
    threadId: prepared.params.config.sessionConfig.threadId,
    parentToolCallId,
    childId: prepared.childId,
    status: args.status,
    content: prependModelNotice(args.content, prepared.params.modelNotice),
    isError: args.isError,
  })) {
    prepared.parentEmitter?.(event);
  }
}

// ─── W4a S6（PR3）：check_agent_id 状态查询 ──────────────────────────────
//
// 给主 Agent 一条「只查不派」的状态查询通道：
//   ① 优先 `manager.getStatus(childId)`——内存活体（running/queued），含 phase /
//      stepCount / latestTool / elapsed（reportProgress 实时回填）。
//   ② 回落 `subagents.jsonl` + `foldSubagentRuns`——终态（completed/failed/cancelled
//      + duration + error），按 (subSessionId,runSeq) 取最新 run 折叠（resume-aware）。
//   ③ 都没有 → 「未找到」isError，让主 Agent 知道 ID 错了 / 不属于本会话。
// 返回主 Agent 可读文本（状态 + 步数 + 最近工具 + 摘要指针 + [子 Agent ID]）。

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}min` : `${m}min ${rem}s`;
}

async function buildCheckAgentStatusResult(
  config: AgentToolConfig,
  checkId: string,
): Promise<ToolResult> {
  // ① 内存活体：running / queued（Manager 是本 session 运行中子的 SSoT）。
  const live = config.subagentManager?.getStatus(checkId);
  if (live) return formatLiveSubagentStatus(live, checkId);

  // ② 终态回落：只读读父 session 的 subagents.jsonl 索引 + resume-aware 折叠。
  try {
    const entries = await readSubagentIndexEntries(
      config.sessionConfig.sessionDir,
      config.sessionConfig.threadId,
    );
    const run = foldSubagentRuns(entries).find((r) => r.childId === checkId);
    if (run) return formatArchivedSubagentStatus(run, checkId);
  } catch {
    // 索引读失败 → 落到「未找到」（可观测性读取失败不该把它谎报成别的状态）。
  }

  // ③ 都没有：明确告诉主 Agent 没找到，让它核对 ID。
  return {
    content: `未找到该子 Agent（ID: ${checkId}）。请确认 [子 Agent ID] 是否正确，以及它是否属于当前会话。`,
    isError: true,
    presentation: buildSubagentStatusCheckPresentation(checkId, 'not_found'),
  };
}

type SubagentStatusCheckState =
  | 'checking'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'orphaned'
  | 'not_found'
  | 'already_checked';

function buildSubagentStatusCheckPresentation(
  childId: string,
  status: SubagentStatusCheckState,
  data: Record<string, unknown> = {},
): ToolPresentation {
  return {
    kind: 'subagent_status_check',
    data: {
      childId,
      status,
      ...data,
    },
  };
}

function formatLiveSubagentStatus(
  live: NonNullable<NonNullable<AgentToolConfig['subagentManager']>['getStatus'] extends (...args: never[]) => infer R ? R : never>,
  checkId: string,
): ToolResult {
  const label = live.label ?? checkId.slice(0, 8);
  const elapsedMs = Math.max(0, Date.now() - (live.startedAt ?? live.registeredAt));
  const elapsed = formatElapsed(elapsedMs);
  if (live.state === 'queued') {
    return {
      content: appendSubagentId(
        `子 Agent「${label}」当前状态：排队中（等待并发槽，尚未开始执行）。已等待约 ${elapsed}。` +
        `${live.background ? '（后台子）' : ''}`,
        checkId,
      ),
      presentation: buildSubagentStatusCheckPresentation(checkId, 'queued', {
        label,
        elapsedMs,
        background: live.background === true,
      }),
    };
  }
  const steps = typeof live.stepCount === 'number' ? live.stepCount : 0;
  const tool = live.latestTool ?? '（暂未调用工具）';
  return {
    content: appendSubagentId(
      `子 Agent「${label}」当前状态：运行中${live.background ? '（后台）' : ''}。` +
      `已执行 ${steps} 步，最近工具：${tool}，已运行约 ${elapsed}。`,
      checkId,
    ),
    presentation: buildSubagentStatusCheckPresentation(checkId, 'running', {
      label,
      elapsedMs,
      background: live.background === true,
      stepCount: steps,
      ...(live.latestTool ? { latestTool: live.latestTool } : {}),
    }),
  };
}

type FoldedSubagentRun = ReturnType<typeof foldSubagentRuns>[number];

function formatArchivedSubagentStatus(run: FoldedSubagentRun, checkId: string): ToolResult {
  const label = run.task ? run.task.slice(0, 40) : checkId.slice(0, 8);
  const durationText =
    typeof run.durationMs === 'number' ? `（耗时约 ${formatElapsed(run.durationMs)}）` : '';
  if (run.status === 'completed') return formatCompletedSubagentStatus(label, durationText, checkId);
  if (run.status === 'failed') return formatFailedSubagentStatus(run, label, durationText, checkId);
  if (run.status === 'cancelled') return formatCancelledSubagentStatus(label, durationText, checkId);
  return formatOrphanRunningSubagentStatus(label, checkId);
}

function formatCompletedSubagentStatus(label: string, durationText: string, checkId: string): ToolResult {
  return {
    content: appendSubagentId(
      `子 Agent「${label}」当前状态：已完成${durationText}。` +
      `结果摘要已通过完成通知送达；如需更多细节或追问，可用 resume_agent_id=该 ID 续跑。`,
      checkId,
    ),
    presentation: buildSubagentStatusCheckPresentation(checkId, 'completed', { label }),
  };
}

function formatFailedSubagentStatus(
  run: FoldedSubagentRun,
  label: string,
  durationText: string,
  checkId: string,
): ToolResult {
  return {
    content: appendSubagentId(
      `子 Agent「${label}」当前状态：已失败${durationText}。` +
      `${run.errorMessage ? `错误：${run.errorMessage}。` : ''}可用 resume_agent_id 续跑重试。`,
      checkId,
    ),
    presentation: buildSubagentStatusCheckPresentation(checkId, 'failed', {
      label,
      ...(run.durationMs != null ? { durationMs: run.durationMs } : {}),
      ...(run.errorMessage ? { error: run.errorMessage } : {}),
    }),
  };
}

function formatCancelledSubagentStatus(label: string, durationText: string, checkId: string): ToolResult {
  return {
    content: appendSubagentId(
      `子 Agent「${label}」当前状态：已取消${durationText}。可用 resume_agent_id 续跑。`,
      checkId,
    ),
    presentation: buildSubagentStatusCheckPresentation(checkId, 'cancelled', { label }),
  };
}

function formatOrphanRunningSubagentStatus(label: string, checkId: string): ToolResult {
  return {
    content: appendSubagentId(
      `子 Agent「${label}」当前状态：运行中（无本会话内存记录——可能在另一进程执行，` +
      `或上次运行未正常收尾）。如确认它已停止，可用 resume_agent_id 续跑。`,
      checkId,
    ),
    presentation: buildSubagentStatusCheckPresentation(checkId, 'orphaned', { label }),
  };
}

/**
 * D11 / W1：子 Agent 工具自发 emit 的事件经 childEmitter 转发到父 UI 时，
 * 仅以下类型会到达 parentEmitter。其余（widget / scratchpad 等子内部组件
 * 元事件）按 C1（子是延伸臂）+ C4（子不开新场所）原则**不转发**——
 * 父 UI 只看真正属于"延伸臂活动"的具体行动。
 *
 * **白名单依据**：扫了 `packages/agent-runtime/src/tools/**` 所有
 * `context.emitStreamEvent?.(...)` 调用点（2026-05-26 W1）—— 以下事件是
 * **工具内部主动 emit 给前端渲染卡片 / 接住用户交互**的，子 Agent 走同款
 * 工具时父 UI 必须接住，否则用户看不到对应卡片 / 无法响应审批：
 *
 *   - **PLAN_PROPOSAL**（`plan-tools.ts` plan_create）：子 Agent 创建的计划
 *     需要在父 chat 流插 inline 卡片让用户审视/执行；按 C1 子是延伸臂，
 *     这是主 Agent 的具体行动产物。
 *   - **ASK_USER_REQUIRED / ASK_FORM_REQUIRED / REQUEST_APPROVAL_REQUIRED**
 *     （`ask-tools.ts`）：子 Agent 的 HITL 询问/审批入口必须能在父 UI 渲染
 *     卡片，否则用户**无法响应**子 Agent 的提问——P0 用户体验回归。
 *     （`createSubagentUserInteractiveChannel` 是 fail-closed deny 兜底，
 *     正常路径走这条 emit 事件让前端渲染。）
 *   - **SYSTEM_NOTICE**（`shell.ts` skill 凭据未注入等）：子 Agent 工具的
 *     系统通知（budget warning / skill credential 缺失 / nudge 等），按 C2
 *     透明性原则用户应该看到。tool_completed / tool_failed 这类 lifecycle
 *     notice 不走 childEmitter（query.ts async generator yield 路径 →
 *     agent-tool while 循环包成 SUBAGENT_STREAM_EVENT），不会重复展示。
 *
 * **不在白名单**（不会到达父 chat 主时间线，走 SUBAGENT_STREAM_EVENT）：
 *   - content_block_* / message_*：与主 Agent 相同的 stream 协议事件，
 *     由详情 transcript 消费，不进父时间线
 *   - step_*：子内部 ReAct 步骤事件
 *   - 子内的 assistant / tool / done 等 ReAct 事件
 *   - 工具内的 widget render / scratchpad 元事件（show-widget 走
 *     emitRichContentBlock 路径不经此处）
 *   - TODO：子 Agent 不维护独立待办，也不把异常 TODO 事件转发到父 UI；
 *     子待办入口应在宿主工具装配阶段移除。
 *
 * **不需要白名单**（已有专门通道）：
 *   - SUBAGENT_STARTED / PROGRESS / COMPLETED / FAILED：agent-tool 直接
 *     parentEmitter()，不经 childEmitter
 *   - SUBAGENT_QUEUED：W4 由 agent-tool 直接 emit
 *   - APPROVAL_REQUESTED（OS 操作审批）：local-permission-handler 直发，
 *     不经子 ToolContext
 *
 * **故意不在本 Set（ Wave3）**：
 *   - `SUBAGENT_HITL_REQUIRED`：W-H④ 幽灵、runtime 零 emit；子 HITL 走
 *     `APPROVAL_REQUESTED`，勿为「清理」强行加入以免双通道重复弹审批。
 *
 * 如未来新增工具通过 context.emitStreamEvent emit 父 UI 必须直接看到的事件，
 * 显式添加到本 Set 并在此 JSDoc 标注：(1) 来源工具；(2) 为什么父必须直接
 * 看到；(3) 与 C1 / C4 信条的兼容性论证。
 */
const PARENT_UI_FORWARD_TYPES: ReadonlySet<string> = new Set<string>([
  StreamEvents.PLAN_PROPOSAL,
  StreamEvents.ASK_USER_REQUIRED,
  StreamEvents.ASK_FORM_REQUIRED,
  StreamEvents.REQUEST_APPROVAL_REQUIRED,
  StreamEvents.SYSTEM_NOTICE,
]);

/**
 * 嵌套子 Agent（孙）的「卡片元数据」事件——必须透传到 renderer，否则孙 Agent
 * 在子 Agent 详情面板里的聚合卡永远卡「连接中」（2026-05-29 dogfood bug 2）。
 *
 * **为什么需要单独一个 set**：`PARENT_UI_FORWARD_TYPES` 是给「子 Agent 工具
 * 内部 emit、父 UI 必须接住的卡片/交互事件」用的；本 set 专门放「子 Agent 又
 * 派的孙 Agent 的生命周期 metadata」。两者语义不同，分开维护。
 *
 * **事件流**：孙的 SUBAGENT_* 由「子」的 agent-tool 经 `parentEmitter`（= 主的
 * `childEmitter`）发出 → 命中本 set → 转发到主的 parentEmitter → IPC → renderer
 * 的 subagentHandler，按 `subagent_run_id`（孙）keyed 进 `subagentRunsBySessionId`
 * [主 session]，`parentToolCallId` = 子的 agent tool_use id。子 Agent 详情面板
 * 的聚合卡按真实父 session + 这些 tool_use id 反查即可解析（见 SubagentDetailPane
 * 的 subagentRunSessionId 透传）。
 *
 * **不污染主 chat UI**：主 chat 的聚合卡按主 Agent 的 tool_use id（agent:0/1…）
 * 反查，孙的 parentToolCallId 是子的 tool_use id，匹配不上 → 孙不会窜进主 chat。
 *
 * **直接子 Agent（子）不走这条**：子的 SUBAGENT_* 由主的 agent-tool 直接
 * `parentEmitter?.()` 发，不经 childEmitter，故不会重复。
 */
const NESTED_SUBAGENT_METADATA_FORWARD_TYPES: ReadonlySet<string> = new Set<string>([
  StreamEvents.SUBAGENT_STARTED,
  StreamEvents.SUBAGENT_PROGRESS,
  StreamEvents.SUBAGENT_COMPLETED,
  StreamEvents.SUBAGENT_FAILED,
  StreamEvents.SUBAGENT_QUEUED,
]);

// ─── 子 Agent 递归封顶（"父子孙三级"） ──────────────────────────────
//
// 最多支持父子孙三级（主 Agent=0 / 子=1 / 孙=2），孙 Agent 不再 fork。
//
// **为什么是结构性剔除工具，而不是只靠 prompt**：fork 子 Agent 历史上曾用
// filtered 继承把父对话原文灌进子 Agent 上下文，弱模型无视 <fork-boilerplate>
// 软约束把父任务整个重跑（dogfood ）。现已改为 none 继承（决策 1，
// agent-tool.ts execute 硬编码 inheritMode='none'），子 Agent 只接受父派送的
// task prompt、不继承父历史，从源头掐断父原文污染。在此保护下，子 Agent
// 持有 agent 工具不再有重演父任务的风险，三级嵌套可安全保留。孙 Agent
// （depth=2）仍结构性剔除 agent 工具作为兜底防御层（防止任何继承模式下
// 可能的边缘泄漏）。
//
// 深度通过 `ToolContext.subagentDepth` 在 runtime 流转（不是工具静态 config——
// agent 工具实例在 fork 链路里是共享的），见 types.ts。

/** `agent` 工具的 canonical 名称（SSoT，createAgentTool 与剔除逻辑共用）。 */
export const AGENT_TOOL_NAME = 'agent';

/**
 * 子 Agent 允许的最大嵌套深度：主 Agent=0 / 子=1 / 孙=2。
 *
 * 语义：fork 出来的子 runtime 的深度 `childDepth >= MAX_SUBAGENT_DEPTH` 时，
 * 剔除其工具集里的 `agent` 工具 —— 即孙 Agent（depth 2）拿不到 `agent`，无法
 * 再派重孙。等价地说，只有 depth 0/1 的 Agent 能 fork。主防线是 none 继承
 * （决策 1）挡住父原文污染，结构性剔除 agent 工具是孙层兜底。
 */
export const MAX_SUBAGENT_DEPTH = 2;

/** 包一层 ToolProvider，从工具集里剔除 `agent` 工具（其余原样透传）。 */
function stripAgentToolFromProvider(base: ToolProvider): ToolProvider {
  return {
    getTools: () => base.getTools().filter((t) => t.name !== AGENT_TOOL_NAME),
    refreshTools: base.refreshTools
      ? async () => {
          await base.refreshTools!();
        }
      : undefined,
  };
}

// ─── Shared Child Agent Executor ────────────────────────────────────

interface ExecuteChildAgentParams {
  config: AgentToolConfig;
  context: ToolContext;
  task: string;
  label: string;
  /** 当前这一层实际父 Agent 模型；多级派发时不等同于根 runtime 配置。 */
  parentModel: string;
  childModel: string;
  /** 固定策略或模板显式模型：不可静默改用其他模型。 */
  strictModel?: boolean;
  /** Internal retry path: keep the same logical child run visible to parent/UI. */
  childIdOverride?: string;
  /**
   * 子 Agent 模型自由度（Phase 3）：按 `childModel` 从目录解析出的能力快照。
   * 用于覆盖子 EngineConfig 的 `contextWindowTokens / maxOutputTokens /
   * modelCapabilities`（不再继承父）。缺省（无目录）时回落父值 / FALLBACK。
   */
  childCapabilities?: ModelCapabilities;
  /**
   * 子 Agent 模型自由度（Phase 4 / R8）：请求的模型命不中目录被确定性降级时的
   * 中文提示，会被前置到子 Agent 的 tool_result content，让主 Agent 知道
   * 「X 不可用、已改用 Y」。命中 / 缺省时为 undefined。
   */
  modelNotice?: string;
  source: SpeakerIdentity['source'];
  inheritMode: InheritMode;
  templateId?: string;
  /** 可选：命中模板时的版本号（归档 / speaker；由宿主决定是否写入）。 */
  templateVersion?: number;
  /** 可选：命中模板时的显示名（归档 / speaker；由宿主决定是否写入）。 */
  templateName?: string;
  /** Group/Mission：主 Agent 经 `agent` 工具 `role` 参数指定的子 Agent 角色名。 */
  role?: string;
  childTools?: ToolProvider;
  systemPrompt: string;
  subagentPolicy?: SubAgentPolicyDto;
  /** tool_use_id of the parent FC call that spawned this child, for UI correlation. */
  parentToolCallId?: string;
  /**
   * 父 Agent fork 时显式收紧子 Agent 权限（YOLO PRD v3 §5.5.3 重修订）：
   * `true` → 子真进 ask（effectiveMode + agentMode + 重烘焙 systemPrompt）；缺省继承父。
   * 详见 `fork-query.ts` ForkQueryConfig.readonlySubagent 注释。
   */
  readonlySubagent?: boolean;
  reportSchema?: AgentToolRequest['report_schema'];
  /**
   * **W2 resume（2026-05-30）**：传入则走 resume 续跑分支——
   *   - 复用此 childId（不新生成 UUID），定位到已有子 session；
   *   - 早检 `subagentSessionExists`：不存在 / 空 → 显式 isError 返回，不消耗并发槽；
   *   - SUBAGENT_STARTED 标 `resumed: true` 让 UI 知道该子又活了；
   *   - forkQuery 收 `resume: true` 走 restoreMessages + active-directive 通道。
   * 终态（COMPLETED / FAILED）与 spawn 完全一致，仍走 W1 的 appendSubagentId 回传 id。
   *
   * 缺省 → 首次 spawn，生成新 childId，行为不变。
   */
  resumeChildId?: string;
  /**
   * **W4a S4 background detach（2026-05-30）**：`true` 时子 Agent **后台执行**——
   * execute 同步前缀（resume 早检 / live 重绑 / trySubmit / 登记）跑完即
   * **立即返回** `{ 已在后台启动 + [子 Agent ID] }`，不 await forkQuery 循环；
   * 子用**独立 AbortController**（不监听 `context.abortSignal`，父 turn 结束不被
   * 误杀），跑完经 `SubagentManager.notifyCompleted` 投进 NotificationQueue 跨
   * turn 唤醒主 Agent（S5）。
   *
   * 仅当 `config.subagentManager` 在场时生效（detach 生命周期 + 完成回调都依赖
   * Manager）；缺 Manager（旧 host / 部分单测）时降级为前台 await（安全兜底）。
   */
  background?: boolean;
  /**
   * **W4a S4**：后台 detach 的「已启动」回调——同步前缀（rebind / trySubmit /
   * 登记）跑完、childId 确定后**同步**触发一次，让 `execute` 拿到 childId 立刻
   * 返回「已在后台启动」给主 Agent，而 forkQuery 循环在 detach 的 promise 里继续。
   *
   * 由 `execute` 的 background 分支注入；前台路径不传（`?.` no-op）。仅在
   * trySubmit **被接受**后触发——被拒（queue full / budget）时不触发，`execute`
   * 改返回 executeChildAgent 的 isError 结果（见 execute background 分支）。
   */
  onStarted?: (childId: string) => void;
}

interface RuntimeModelFailureHint {
  errorType: string;
  statusCode?: number;
  message?: string;
}

const SUBAGENT_MODEL_RUNTIME_FAILURE_KEY = 'subagentModelRuntimeFailure';

interface EffectiveChildLiveDeps {
  budgetTracker?: BudgetTracker;
  waitForUserInput?: AgentToolConfig['waitForUserInput'];
  userInteractiveChannel?: EngineConfig['userInteractiveChannel'];
  toolRiskPolicy?: EngineConfig['toolRiskPolicy'];
  workspaceRoot?: EngineConfig['workspaceRoot'];
  osErrorBlacklist?: EngineConfig['osErrorBlacklist'];
}

type NotifyBackgroundCompletion = (info: {
  status: SubagentCompletionInfo['status'];
  summary: string;
  step_count?: number;
  error_kind?: string;
  stats?: SubagentCompletionInfo['stats'];
}) => void;

interface QueuedActivationOptions {
  params: ExecuteChildAgentParams;
  parentEmitter?: ToolContext['emitStreamEvent'];
  childId: string;
  task: string;
  label: string;
  speaker: SpeakerIdentity;
  startedAt: number;
  isBackground: boolean;
  isResume: boolean;
  budgetTracker: BudgetTracker;
  notifyBgIfNeeded: NotifyBackgroundCompletion;
}

interface ToolHistoryState {
  stepCount: number;
  latestTool?: string;
  latestSuccess: boolean;
  pendingTools: Map<string, PendingToolCall>;
}

interface SubmitStatsSnapshot {
  activeCount: number;
  queuedCount: number;
  maxActive: number | typeof Infinity | undefined;
  maxQueue: number | undefined;
  maxActiveLabel: string;
  maxActivePayload: number | null;
}

interface ToolNoticePayload {
  notice_type?: string;
  tool_call_id?: string;
  tool_name?: string;
  output?: unknown;
  is_error?: boolean;
  duration_ms?: number;
  error_code?: string;
}

function isSubagentInFlight(config: AgentToolConfig, childId: string): boolean {
  return activeChildren.has(childId)
    || queuedChildren.has(childId)
    || (config.subagentManager?.has(childId) ?? false);
}

function validateResumeChildSession(
  config: AgentToolConfig,
  isResume: boolean,
  resumeChildId: string | undefined,
): ToolResult | undefined {
  if (!isResume || !resumeChildId) return undefined;
  if (isSubagentInFlight(config, resumeChildId)) {
    return {
      content:
        '该子 Agent 正在运行中，无法并发续跑。请等它本轮完成后再续跑，' +
        '或在续跑时设 interrupt:true 主动中断并重定向它。',
      isError: true,
    };
  }
  if (!subagentSessionExists(config.sessionConfig, resumeChildId)) {
    return {
      content: '该子 Agent 会话不存在或已失效，请重新派发。',
      isError: true,
    };
  }
  return undefined;
}

function resolveEffectiveChildLiveDeps(
  config: AgentToolConfig,
  isBackground: boolean,
  isResume: boolean,
): EffectiveChildLiveDeps | ToolResult {
  let liveDeps: SubagentLiveDeps | undefined;
  if ((isBackground || isResume) && config.subagentManager) {
    const resolved = config.subagentManager.resolveLiveDeps();
    if (!resolved.ok) return { content: resolved.reason, isError: true };
    liveDeps = resolved.deps;
  }
  return buildEffectiveChildLiveDeps(config, liveDeps);
}

function buildEffectiveChildLiveDeps(
  config: AgentToolConfig,
  liveDeps: SubagentLiveDeps | undefined,
): EffectiveChildLiveDeps {
  if (!liveDeps) {
    return {
      budgetTracker: config.budgetTracker,
      waitForUserInput: config.waitForUserInput,
      userInteractiveChannel: config.userInteractiveChannel,
      toolRiskPolicy: config.toolRiskPolicy,
      workspaceRoot: config.workspaceRoot,
      osErrorBlacklist: config.osErrorBlacklist,
    };
  }
  return {
    budgetTracker: liveDeps.budgetTracker ?? config.budgetTracker,
    waitForUserInput: liveDeps.waitForUserInput ?? config.waitForUserInput,
    userInteractiveChannel: liveDeps.userInteractiveChannel ?? config.userInteractiveChannel,
    toolRiskPolicy: liveDeps.toolRiskPolicy ?? config.toolRiskPolicy,
    workspaceRoot: liveDeps.workspaceRoot ?? config.workspaceRoot,
    osErrorBlacklist: liveDeps.osErrorBlacklist ?? config.osErrorBlacklist,
  };
}

function snapshotSubmitStats(budgetTracker: BudgetTracker | undefined): SubmitStatsSnapshot {
  const stats = budgetTracker?.getSchedulerStats();
  const maxActive = stats?.maxActive;
  const maxActiveIsInfinite = maxActive === Infinity;
  return {
    activeCount: stats?.activeCount ?? 0,
    queuedCount: stats?.queuedCount ?? 0,
    maxActive,
    maxQueue: stats?.maxQueue,
    maxActiveLabel: maxActiveIsInfinite ? '无限' : String(maxActive ?? '?'),
    maxActivePayload: maxActiveIsInfinite ? null : (maxActive ?? null),
  };
}

function buildSubmitBlockedMessage(
  reason: Extract<SubmitResult, { accepted: false }>['reason'],
  stats: SubmitStatsSnapshot,
): string {
  if (reason !== 'queue_full') {
    return '账单余额不足或本次会话 token 配额已耗尽。请减少子 Agent 数量或检查账户余额。';
  }
  return `任务队列已满（当前 ${stats.activeCount} 个进行中、${stats.queuedCount} 个等待中，上限 ${stats.maxActiveLabel} + ${stats.maxQueue ?? '?'}）。` +
    `请等部分任务完成后继续派发，或把这批拆成多轮发送（例如先派 20 个，等几个完成后再派下一批）。`;
}

function emitSubmitBlockedNotice(input: {
  parentEmitter?: ToolContext['emitStreamEvent'];
  message: string;
  reason: Extract<SubmitResult, { accepted: false }>['reason'];
  stats: SubmitStatsSnapshot;
  label: string;
}): void {
  input.parentEmitter?.(new RuntimeSystemNoticeEvent({
      content: input.message,
      notice_type: 'subagent_spawn_blocked',
      reason: input.reason,
      current_children: input.stats.activeCount,
      queued_count: input.stats.queuedCount,
      max_concurrent_children: input.stats.maxActivePayload,
      max_queue: input.stats.maxQueue ?? null,
      label: input.label,
  }).toStreamEvent());
}

function emitSubmitBlockedTelemetry(input: {
  config: AgentToolConfig;
  reason: Extract<SubmitResult, { accepted: false }>['reason'];
  stats: SubmitStatsSnapshot;
  childId: string;
}): void {
  emitTelemetryEvent(
    TelemetryEvents.SUBAGENT_SPAWN_BLOCKED,
    {
      reason: input.reason,
      current_children: input.stats.activeCount,
      queued_count: input.stats.queuedCount,
      max: input.stats.maxActivePayload,
      subagent_run_id: input.childId,
    },
    { session_id: input.config.sessionConfig.threadId },
  );
}

function buildSubmitRejectedResult(input: {
  config: AgentToolConfig;
  parentEmitter?: ToolContext['emitStreamEvent'];
  submitResult: Extract<SubmitResult, { accepted: false }>;
  budgetTracker?: BudgetTracker;
  childId: string;
  label: string;
}): ToolResult {
  const { config, parentEmitter, submitResult, budgetTracker, childId, label } = input;
  const stats = snapshotSubmitStats(budgetTracker);
  const blockedMessage = buildSubmitBlockedMessage(submitResult.reason, stats);
  emitSubmitBlockedNotice({ parentEmitter, message: blockedMessage, reason: submitResult.reason, stats, label });
  emitSubmitBlockedTelemetry({ config, reason: submitResult.reason, stats, childId });
  return { content: blockedMessage, isError: true };
}

async function waitForQueuedActivation(options: QueuedActivationOptions): Promise<ToolResult | undefined> {
  const {
    params, parentEmitter, childId, task, label, speaker, startedAt,
    isBackground, isResume, budgetTracker, notifyBgIfNeeded,
  } = options;
  const { config, context } = params;
  const stats = budgetTracker.getSchedulerStats();
  parentEmitter?.(new SubagentStatusEvent(StreamEvents.SUBAGENT_QUEUED, {
      run_id: childId,
      subagent_run_id: childId,
      task,
      label,
      tool_call_id: params.parentToolCallId,
      parent_tool_call_id: params.parentToolCallId,
      dispatcher_run_id: context.assistantSubagentRunId,
      speaker_id: childId,
      speaker,
      queue_position: stats.queuedCount,
      active_count: stats.activeCount,
      max_active: stats.maxActive === Infinity ? null : stats.maxActive,
      max_queue: stats.maxQueue,
  }).toStreamEvent());

  const queuedCancelController = new AbortController();
  queuedChildren.set(childId, { cancelController: queuedCancelController, budgetTracker });
  let queuedTimedOut = false;
  const queueTimeoutMs = config.backgroundQueueTimeoutMs ?? DEFAULT_BACKGROUND_QUEUE_TIMEOUT_MS;
  const queueTimer = isBackground
    ? createQueueTimeout({
        queueTimeoutMs,
        onTimeout: () => {
          queuedTimedOut = true;
          queuedCancelController.abort();
          budgetTracker.cancelQueued(childId);
        },
      })
    : undefined;

  const unregisterQueuedFromManager = registerQueuedChild({
    params,
    childId,
    label,
    startedAt,
    isBackground,
    isResume,
    budgetTracker,
    queuedCancelController,
  });
  const onParentAbortWhileQueued = () => {
    queuedCancelController.abort();
    budgetTracker.cancelQueued(childId);
  };
  if (!isBackground) {
    context.abortSignal.addEventListener('abort', onParentAbortWhileQueued, { once: true });
  }

  await new Promise<void>((resolve) => {
    budgetTracker.onActivate(childId, resolve);
  });

  cleanupQueuedChild({
    childId,
    isBackground,
    context,
    queueTimer,
    unregisterQueuedFromManager,
    onParentAbortWhileQueued,
  });

  const cancelledWhileQueued = isBackground
    ? queuedCancelController.signal.aborted
    : (context.abortSignal.aborted || queuedCancelController.signal.aborted);
  const trulyActivated = budgetTracker.isActiveChild(childId);
  if (!cancelledWhileQueued && trulyActivated) return undefined;
  return buildQueuedFailureResult({
    parentEmitter,
    parentToolCallId: params.parentToolCallId,
    childId,
    dispatcherRunId: context.assistantSubagentRunId,
    cancelledWhileQueued,
    trulyActivated,
    queuedTimedOut,
    queueTimeoutMs,
    notifyBgIfNeeded,
  });
}

function createQueueTimeout(input: {
  queueTimeoutMs: number;
  onTimeout: () => void;
}): ReturnType<typeof setTimeout> {
  const timer = setTimeout(input.onTimeout, input.queueTimeoutMs);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

function registerQueuedChild(input: {
  params: ExecuteChildAgentParams;
  childId: string;
  label: string;
  startedAt: number;
  isBackground: boolean;
  isResume: boolean;
  budgetTracker: BudgetTracker;
  queuedCancelController: AbortController;
}): (() => void) | undefined {
  const meta = {
    label: input.label,
    startedAt: input.startedAt,
    state: 'queued' as const,
    parentToolCallId: input.params.parentToolCallId,
    resumed: input.isResume,
    onCancel: () => input.budgetTracker.cancelQueued(input.childId),
  };
  return input.isBackground
    ? input.params.config.subagentManager?.spawnBackground(input.childId, input.queuedCancelController, meta)
    : input.params.config.subagentManager?.registerRun(input.childId, input.queuedCancelController, meta);
}

function cleanupQueuedChild(input: {
  childId: string;
  isBackground: boolean;
  context: ToolContext;
  queueTimer?: ReturnType<typeof setTimeout>;
  unregisterQueuedFromManager?: () => void;
  onParentAbortWhileQueued: () => void;
}): void {
  if (input.queueTimer) clearTimeout(input.queueTimer);
  queuedChildren.delete(input.childId);
  input.unregisterQueuedFromManager?.();
  if (!input.isBackground) {
    input.context.abortSignal.removeEventListener('abort', input.onParentAbortWhileQueued);
  }
}

function buildQueuedFailureResult(input: {
  parentEmitter?: ToolContext['emitStreamEvent'];
  parentToolCallId?: string;
  dispatcherRunId?: string;
  childId: string;
  cancelledWhileQueued: boolean;
  trulyActivated: boolean;
  queuedTimedOut: boolean;
  queueTimeoutMs: number;
  notifyBgIfNeeded: NotifyBackgroundCompletion;
}): ToolResult {
  const blockedByBudget = !input.cancelledWhileQueued && !input.trulyActivated;
  const cancelMsg = input.queuedTimedOut
    ? `子 Agent 排队等待超过 ${input.queueTimeoutMs}ms 仍未轮到执行，已超时取消。`
    : blockedByBudget
      ? '子 Agent 排队等待期间会话预算耗尽，已取消。请减少子 Agent 数量或检查账户余额。'
      : '子 Agent 在排队等待时被取消。';
  const queuedErrorKind: 'cancelled' | 'timeout' = input.queuedTimedOut ? 'timeout' : 'cancelled';
  input.parentEmitter?.(new SubagentStatusEvent(StreamEvents.SUBAGENT_FAILED, {
      run_id: input.childId,
      subagent_run_id: input.childId,
      tool_call_id: input.parentToolCallId,
      parent_tool_call_id: input.parentToolCallId,
      dispatcher_run_id: input.dispatcherRunId,
      error: cancelMsg,
      error_kind: queuedErrorKind,
      timeout_ms: input.queuedTimedOut ? input.queueTimeoutMs : undefined,
      cancelled: !input.queuedTimedOut,
  }).toStreamEvent());
  input.notifyBgIfNeeded({
    status: queuedErrorKind,
    summary: cancelMsg,
    step_count: 0,
    error_kind: queuedErrorKind,
  });
  return { content: cancelMsg, isError: true };
}

/**
 * 把被包装事件的身份键 `event_id` 从 payload 提升到 wrapper 顶层。这是
 * 「包装事件 id = 被包装事件 id」不变量的落点：wrapper 顶层带上原始 event_id 后，经
 * runtime EventEmitter 出口命中已有身份、不再重造新 id，于是 IPC 包装副本
 * 与 WS 原始回声携带**同一** event_id → 前端跨源去重生效。
 *
 * `arrival_seq` 一并提升，但**不是去重必需**：前端子 Agent 通路（subagentStreamHandler）
 * 只读 `child_event`、不消费 wrapper 顶层 arrival_seq，去重完全由 event_id 承担。提升它
 * 仅为两点一致性收益——① 避免 EventEmitter 为每层 wrapper 白白 mint 新序号、
 * 空耗全局单调计数；② wrapper 顶层排序键与内层发射保持一致，便于排查。去掉它不影响修复。
 *
 * - 叶子子事件：`source` 是原始 child 事件，读它的 payload.event_id / arrival_seq。
 * - 嵌套（孙代理）：`source` 是上一层已带顶层 event_id 的 wrapper，同样读其顶层，
 *   保证身份贯穿多层透传不变。
 */
export function inheritStreamIdentity(source: StreamEvent): {
  event_id?: string;
  arrival_seq?: number;
  trace_id?: string;
  run_id?: string;
  thread_id?: string;
} {
  const payload = source.payload as Record<string, unknown> | undefined;
  const out: {
    event_id?: string;
    arrival_seq?: number;
    trace_id?: string;
    run_id?: string;
    thread_id?: string;
  } = {};
  if (payload && typeof payload.event_id === 'string' && payload.event_id) {
    out.event_id = payload.event_id;
  }
  if (payload && typeof payload.arrival_seq === 'number') {
    out.arrival_seq = payload.arrival_seq;
  }
  if (payload && typeof payload.trace_id === 'string' && payload.trace_id) out.trace_id = payload.trace_id;
  if (payload && typeof payload.run_id === 'string' && payload.run_id) out.run_id = payload.run_id;
  if (payload && typeof payload.thread_id === 'string' && payload.thread_id) out.thread_id = payload.thread_id;
  return out;
}

function readPayloadRecord(event: StreamEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === 'object'
    ? { ...(event.payload as Record<string, unknown>) }
    : {};
}

function readSubagentRunId(payload: Record<string, unknown>): string {
  return typeof payload.subagent_run_id === 'string' && payload.subagent_run_id
    ? payload.subagent_run_id
    : '';
}

function readSubagentChain(payload: Record<string, unknown>, fallbackRunId: string): string[] {
  const chain = payload.subagent_chain;
  if (Array.isArray(chain) && chain.every((item) => typeof item === 'string') && chain.length > 0) {
    return chain as string[];
  }
  return [fallbackRunId];
}

/**
 * 把子 Agent 正文投影成与主 Agent 同构的 stream 事件：保留原 `type`，
 * 只在 payload 上盖路由字段。旧链路若仍送来 `subagent_stream_event`，这里解包。
 */
export function projectSubagentStreamEvent(childId: string, event: StreamEvent): StreamEvent {
  if (event.type === StreamEvents.SUBAGENT_STREAM_EVENT) {
    const wrapper = readPayloadRecord(event);
    const childEvent = wrapper.child_event;
    if (!childEvent || typeof childEvent !== 'object') {
      return event;
    }
    const inner = childEvent as StreamEvent;
    const leafId = readSubagentRunId(wrapper) || childId;
    const innerChain = readSubagentChain(wrapper, leafId);
    return attachSubagentRouting(inner, {
      subagent_run_id: leafId,
      parent_run_id: childId,
      subagent_chain: innerChain[0] === childId ? innerChain : [childId, ...innerChain],
    });
  }

  const payload = readPayloadRecord(event);
  const existingRunId = readSubagentRunId(payload) || childId;
  const existingChain = readSubagentChain(payload, existingRunId);
  if (existingRunId !== childId) {
    return attachSubagentRouting(event, {
      subagent_run_id: existingRunId,
      parent_run_id: childId,
      subagent_chain: existingChain[0] === childId ? existingChain : [childId, ...existingChain],
    });
  }
  return attachSubagentRouting(event, {
    subagent_run_id: childId,
    parent_run_id: null,
    subagent_chain: [childId],
  });
}

function attachSubagentRouting(
  event: StreamEvent,
  routing: {
    subagent_run_id: string;
    parent_run_id: string | null;
    subagent_chain: string[];
  },
): StreamEvent {
  const identity = inheritStreamIdentity(event);
  return {
    type: event.type,
    payload: {
      ...readPayloadRecord(event),
      ...identity,
      run_id: routing.subagent_run_id,
      subagent_run_id: routing.subagent_run_id,
      parent_run_id: routing.parent_run_id,
      subagent_chain: routing.subagent_chain,
    },
  };
}

export function forwardSubagentStreamToParent(
  parentEmitter: ToolContext['emitStreamEvent'] | undefined,
  childId: string,
  event: StreamEvent,
): void {
  parentEmitter?.(projectSubagentStreamEvent(childId, event));
}

function createToolHistoryState(): ToolHistoryState {
  return {
    stepCount: 0,
    latestSuccess: true,
    pendingTools: new Map<string, PendingToolCall>(),
  };
}

interface ChildToolProgressInput {
  event: StreamEvent;
  parentEmitter?: ToolContext['emitStreamEvent'];
  params: ExecuteChildAgentParams;
  childId: string;
  startedAt: number;
  toolState: ToolHistoryState;
  getChildTraceId: () => string | undefined;
}

function handleChildToolStart(input: ChildToolProgressInput): void {
  const p = input.event.payload as {
    block?: { type?: string; id?: string; name?: string; input?: unknown };
  };
  if (p.block?.type !== 'tool_use' || !p.block.id) return;
  const pendingToolName = p.block.name ?? 'unknown';
  input.toolState.pendingTools.set(p.block.id, {
    toolName: pendingToolName,
    toolCallId: p.block.id,
    startedAt: Date.now(),
    inputSummary: truncateSummary(p.block.input),
  });
  input.parentEmitter?.(new SubagentStatusEvent(StreamEvents.SUBAGENT_PROGRESS, {
      run_id: input.childId,
      subagent_run_id: input.childId,
      tool_call_id: input.params.parentToolCallId,
      parent_tool_call_id: input.params.parentToolCallId,
      step_count: input.toolState.stepCount,
      latest_tool: pendingToolName,
      latest_tool_input: truncateSummary(p.block.input),
      latest_success: input.toolState.latestSuccess,
      latest_tool_status: 'pending' as const,
      elapsed_ms: Date.now() - input.startedAt,
      child_trace_id: input.getChildTraceId(),
  }).toStreamEvent());
  input.params.config.subagentManager?.reportProgress(input.childId, {
    stepCount: input.toolState.stepCount,
    latestTool: pendingToolName,
  });
}

function handleChildToolNotice(input: ChildToolProgressInput): void {
  const payload = input.event.payload as ToolNoticePayload;
  if (isToolProgressNotice(payload)) {
    emitRunningChildToolProgress(input, payload.tool_call_id);
    return;
  }
  if (!isToolEndNotice(payload)) return;
  const pending = input.toolState.pendingTools.get(payload.tool_call_id);
  input.toolState.stepCount++;
  const success = payload.notice_type === 'tool_completed' && payload.is_error !== true;
  input.toolState.latestSuccess = success;
  const toolName = resolveCompletedToolName(payload, pending);
  input.toolState.latestTool = toolName;
  input.toolState.pendingTools.delete(payload.tool_call_id);
  emitChildToolProgress(input, pending?.inputSummary, success);
}

function isToolProgressNotice(
  payload: ToolNoticePayload,
): payload is ToolNoticePayload & { tool_call_id: string } {
  return payload.notice_type === 'tool_progress'
    && typeof payload.tool_call_id === 'string'
    && payload.tool_call_id.length > 0;
}

function isToolEndNotice(
  payload: ToolNoticePayload,
): payload is ToolNoticePayload & { tool_call_id: string } {
  const isToolEnd = payload.notice_type === 'tool_completed' || payload.notice_type === 'tool_failed';
  return isToolEnd && typeof payload.tool_call_id === 'string' && payload.tool_call_id.length > 0;
}

function resolveCompletedToolName(
  payload: ToolNoticePayload,
  pending: PendingToolCall | undefined,
): string {
  return pending?.toolName ?? payload.tool_name ?? 'unknown';
}

function emitRunningChildToolProgress(
  input: ChildToolProgressInput,
  toolCallId: string,
): void {
  const pending = input.toolState.pendingTools.get(toolCallId);
  if (!pending) return;
  input.parentEmitter?.(new SubagentStatusEvent(StreamEvents.SUBAGENT_PROGRESS, {
      run_id: input.childId,
      subagent_run_id: input.childId,
      tool_call_id: input.params.parentToolCallId,
      parent_tool_call_id: input.params.parentToolCallId,
      step_count: input.toolState.stepCount,
      latest_tool: pending.toolName,
      latest_tool_input: pending.inputSummary,
      latest_success: input.toolState.latestSuccess,
      latest_tool_status: 'pending' as const,
      elapsed_ms: Date.now() - input.startedAt,
      child_trace_id: input.getChildTraceId(),
  }).toStreamEvent());
  input.params.config.subagentManager?.reportProgress(input.childId, {
    stepCount: input.toolState.stepCount,
    latestTool: pending.toolName,
  });
}

function emitChildToolProgress(
  input: ChildToolProgressInput,
  latestToolInput: string | undefined,
  success: boolean,
): void {
  input.parentEmitter?.(new SubagentStatusEvent(StreamEvents.SUBAGENT_PROGRESS, {
      run_id: input.childId,
      subagent_run_id: input.childId,
      tool_call_id: input.params.parentToolCallId,
      parent_tool_call_id: input.params.parentToolCallId,
      step_count: input.toolState.stepCount,
      latest_tool: input.toolState.latestTool,
      latest_tool_input: latestToolInput,
      latest_success: input.toolState.latestSuccess,
      latest_tool_status: success ? 'completed' as const : 'failed' as const,
      elapsed_ms: Date.now() - input.startedAt,
      child_trace_id: input.getChildTraceId(),
  }).toStreamEvent());
  input.params.config.subagentManager?.reportProgress(input.childId, {
    stepCount: input.toolState.stepCount,
    latestTool: input.toolState.latestTool,
  });
}

function handleChildStreamEvent(input: {
  event: StreamEvent;
  parentEmitter?: ToolContext['emitStreamEvent'];
  params: ExecuteChildAgentParams;
  childId: string;
  startedAt: number;
  toolState: ToolHistoryState;
  getChildTraceId: () => string | undefined;
  forwardChildEventToTrace: (event: StreamEvent) => void;
}): void {
  input.forwardChildEventToTrace(input.event);
  forwardSubagentStreamToParent(input.parentEmitter, input.childId, input.event);
  if (input.event.type === ContentBlockEvents.CONTENT_BLOCK_START) {
    handleChildToolStart(input);
    return;
  }
  if (input.event.type === StreamEvents.SYSTEM_NOTICE) {
    handleChildToolNotice(input);
  }
}

function createChildEventForwarders(input: {
  config: AgentToolConfig;
  parentEmitter?: ToolContext['emitStreamEvent'];
  childId: string;
  onChildEvent?: (event: StreamEvent, getChildTraceId: () => string | undefined) => void;
}): {
  getChildTraceId: () => string | undefined;
  getTraceForwardedCount: () => number;
  forwardChildEventToTrace: (event: StreamEvent) => void;
  /** ：等待子 persist 已进入父 SessionStorage（含 message-blocks buffer）。 */
  awaitParentPersistWrites: () => Promise<void>;
  childEmitter: (event: StreamEvent) => void;
} {
  let childTraceId: string | undefined;
  let traceForwardedCount = 0;
  const pendingParentPersistWrites: Promise<void>[] = [];
  const subagentTraceEmitter = input.config.subagentTraceEmitter;
  const parentTraceIdSnapshot = input.config.getParentTraceId?.();
  const forwardChildEventToTrace = (event: StreamEvent): void => {
    const fromLifecycle = extractTraceIdFromLifecycleStart(event);
    if (fromLifecycle) childTraceId = fromLifecycle;
    if (!subagentTraceEmitter) return;
    const effectiveTraceId = extractEffectiveTraceId(event, childTraceId);
    if (!effectiveTraceId) return;
    try {
      const emitted = subagentTraceEmitter({
        ...event,
        payload: buildTracePayload(event, input.childId, effectiveTraceId, parentTraceIdSnapshot),
      });
      // 方案 A：persist 写父 blocks；host 常 fire-and-forget，收集前必须排空。
      if (event.type === StreamEvents.PERSIST_MESSAGE && emitted != null) {
        pendingParentPersistWrites.push(Promise.resolve(emitted).then(() => undefined));
      }
      traceForwardedCount++;
    } catch (err) {
      void err;
    }
  };
  return {
    getChildTraceId: () => childTraceId,
    getTraceForwardedCount: () => traceForwardedCount,
    forwardChildEventToTrace,
    awaitParentPersistWrites: async () => {
      if (pendingParentPersistWrites.length === 0) return;
      await Promise.allSettled(pendingParentPersistWrites);
      pendingParentPersistWrites.length = 0;
    },
    childEmitter: createChildEmitter({
      parentEmitter: input.parentEmitter,
      childId: input.childId,
      getChildTraceId: () => childTraceId,
      forwardChildEventToTrace,
      onChildEvent: input.onChildEvent,
    }),
  };
}

function extractEffectiveTraceId(event: StreamEvent, childTraceId: string | undefined): string | undefined {
  const payloadTraceId =
    typeof event.payload?.trace_id === 'string' ? event.payload.trace_id : undefined;
  return payloadTraceId ?? childTraceId;
}

function buildTracePayload(
  event: StreamEvent,
  childId: string,
  effectiveTraceId: string,
  parentTraceIdSnapshot: string | undefined,
): Record<string, unknown> {
  const existingRunId =
    typeof event.payload?.run_id === 'string'
      ? event.payload.run_id
      : typeof event.payload?.subagent_run_id === 'string'
        ? event.payload.subagent_run_id
        : childId;
  const existingToolCallId =
    typeof event.payload?.tool_call_id === 'string'
      ? event.payload.tool_call_id
      : typeof event.payload?.parent_tool_call_id === 'string'
        ? event.payload.parent_tool_call_id
        : undefined;
  const enrichedPayload: Record<string, unknown> = {
    ...event.payload,
    run_id: existingRunId,
    trace_id: effectiveTraceId,
    subagent_run_id: existingRunId,
    observer_only: true,
    trace_forwarded: true,
  };
  if (existingToolCallId) {
    enrichedPayload.tool_call_id = existingToolCallId;
    enrichedPayload.parent_tool_call_id = existingToolCallId;
  }
  if (parentTraceIdSnapshot) {
    enrichedPayload.parent_trace_id = parentTraceIdSnapshot;
  }
  return enrichedPayload;
}

function createChildEmitter(input: {
  parentEmitter?: ToolContext['emitStreamEvent'];
  childId: string;
  getChildTraceId: () => string | undefined;
  forwardChildEventToTrace: (event: StreamEvent) => void;
  onChildEvent?: (event: StreamEvent, getChildTraceId: () => string | undefined) => void;
}): (event: StreamEvent) => void {
  return (event) => {
    input.forwardChildEventToTrace(event);
    input.onChildEvent?.(event, input.getChildTraceId);
    if (event.type === StreamEvents.SUBAGENT_STREAM_EVENT || readSubagentRunId(readPayloadRecord(event))) {
      forwardSubagentStreamToParent(input.parentEmitter, input.childId, event);
      return;
    }
    if (!shouldForwardChildUiEvent(event.type)) return;
    const traceId = input.getChildTraceId();
    const enrichedPayload = buildChildUiPayload(event, input.childId, traceId);
    input.parentEmitter?.({ ...event, payload: enrichedPayload });
  };
}

function shouldForwardChildUiEvent(eventType: string): boolean {
  return PARENT_UI_FORWARD_TYPES.has(eventType)
    || NESTED_SUBAGENT_METADATA_FORWARD_TYPES.has(eventType);
}

function buildChildUiPayload(
  event: StreamEvent,
  childId: string,
  childTraceId: string | undefined,
): Record<string, unknown> {
  const runId =
    typeof event.payload?.run_id === 'string'
      ? event.payload.run_id
      : typeof event.payload?.subagent_run_id === 'string'
        ? event.payload.subagent_run_id
        : childId;
  const toolCallId =
    typeof event.payload?.tool_call_id === 'string'
      ? event.payload.tool_call_id
      : typeof event.payload?.parent_tool_call_id === 'string'
        ? event.payload.parent_tool_call_id
        : undefined;
  const base: Record<string, unknown> = {
    ...event.payload,
    run_id: runId,
    subagent_run_id: runId,
  };
  if (toolCallId) {
    base.tool_call_id = toolCallId;
    base.parent_tool_call_id = toolCallId;
  }
  if (typeof event.payload?.trace_id === 'string' || !childTraceId) {
    return base;
  }
  return { ...base, trace_id: childTraceId };
}

interface PreparedChildExecution {
  params: ExecuteChildAgentParams;
  parentEmitter?: ToolContext['emitStreamEvent'];
  isResume: boolean;
  isBackground: boolean;
  liveDeps: EffectiveChildLiveDeps;
  childId: string;
  startedAt: number;
  childDepth: number;
  speaker: SpeakerIdentity;
  notifyBgIfNeeded: NotifyBackgroundCompletion;
}

interface ActiveChildRun {
  timeoutMs?: number;
  timeoutController: AbortController;
  isTimedOut: () => boolean;
  timer?: ReturnType<typeof setTimeout>;
  unregisterFromManager?: () => void;
  onParentAbort: () => void;
}

interface ChildRuntimeContext {
  toolState: ToolHistoryState;
  childForwarders: ReturnType<typeof createChildEventForwarders>;
  effectiveTools: ToolProvider;
  childSystemPrompt: string;
}

function prepareChildExecution(params: ExecuteChildAgentParams): PreparedChildExecution | ToolResult {
  const { config, context, label, source, inheritMode, templateId, templateVersion, templateName, childModel, resumeChildId } = params;
  const parentEmitter = context.emitStreamEvent;
  const isResume = typeof resumeChildId === 'string' && resumeChildId.length > 0;
  const isBackground = params.background === true && !!config.subagentManager;
  const resumePreflightResult = validateResumeChildSession(config, isResume, resumeChildId);
  if (resumePreflightResult) return resumePreflightResult;
  const liveDeps = resolveEffectiveChildLiveDeps(config, isBackground, isResume);
  if ('content' in liveDeps) return liveDeps;
  const childId = params.childIdOverride ?? (isResume ? resumeChildId : crypto.randomUUID());
  const startedAt = Date.now();
  const speaker = buildChildSpeakerIdentity({
    config,
    params,
    childId,
    startedAt,
    source,
    inheritMode,
    templateId,
    templateVersion,
    templateName,
    childModel,
    label,
  });
  emitChildSpawnTelemetry(config, source, templateId, templateVersion, childId);
  return {
    params,
    parentEmitter,
    isResume,
    isBackground,
    liveDeps,
    childId,
    startedAt,
    childDepth: (context.subagentDepth ?? 0) + 1,
    speaker,
    notifyBgIfNeeded: buildBackgroundNotifier(params, isBackground, childId, startedAt),
  };
}

function buildChildSpeakerIdentity(input: {
  config: AgentToolConfig;
  params: ExecuteChildAgentParams;
  childId: string;
  startedAt: number;
  source: SpeakerIdentity['source'];
  inheritMode: InheritMode;
  templateId?: string;
  templateVersion?: number;
  templateName?: string;
  childModel: string;
  label: string;
}): SpeakerIdentity {
  return {
    speaker_id: input.childId,
    kind: 'sub_agent',
    parent_session_id: input.config.sessionConfig.threadId,
    source: input.source,
    template_id: input.templateId,
    template_version: input.templateVersion,
    template_name: input.templateName,
    inherit_mode: input.inheritMode,
    display_name: buildSpeakerDisplayName(input.source, input.label, input.childId, input.templateId),
    role: input.params.role,
    display_short_id: input.childId.slice(0, 4),
    status: 'running',
    started_at: input.startedAt,
    model: input.childModel,
  };
}

function emitChildSpawnTelemetry(
  config: AgentToolConfig,
  source: SpeakerIdentity['source'],
  templateId: string | undefined,
  templateVersion: number | undefined,
  childId: string,
): void {
  emitTelemetryEvent(
    TelemetryEvents.SUBAGENT_SPAWN,
    {
      source: source ?? 'inherit',
      resolved: source === 'template',
      template_id: templateId,
      template_version: templateVersion,
      child_speaker_id: childId,
    },
    { session_id: config.sessionConfig.threadId },
  );
}

function buildBackgroundNotifier(
  params: ExecuteChildAgentParams,
  isBackground: boolean,
  childId: string,
  startedAt: number,
): NotifyBackgroundCompletion {
  return (info) => {
    if (!isBackground) return;
    if (interruptingChildren.has(childId)) return;
    const durationMs = Date.now() - startedAt;
    params.config.subagentManager?.notifyCompleted(
      buildChildCompletionEnvelope({
        subagentRunId: childId,
        label: params.label,
        parentToolCallId: params.parentToolCallId,
        durationMs,
        status: info.status,
        summary: info.summary,
        stepCount: info.step_count,
        errorKind: info.error_kind,
        runId: params.context.assistantSubagentRunId,
        toolCallId: params.parentToolCallId,
        stats: info.stats ?? { duration_ms: durationMs },
        background: true,
      }),
    );
  };
}

async function enterChildScheduler(prepared: PreparedChildExecution): Promise<ToolResult | undefined> {
  const { params, liveDeps, childId, childDepth, parentEmitter, isBackground, isResume, startedAt, speaker, notifyBgIfNeeded } = prepared;
  const budgetTracker = liveDeps.budgetTracker;
  const submitResult: SubmitResult = budgetTracker
    ? budgetTracker.trySubmit({ speakerId: childId, depth: childDepth })
    : { accepted: true, state: 'active' };
  if (!submitResult.accepted) {
    return buildSubmitRejectedResult({
      config: params.config,
      parentEmitter,
      submitResult,
      budgetTracker,
      childId,
      label: params.label,
    });
  }
  params.onStarted?.(childId);
  if (submitResult.state !== 'queued') return undefined;
  return waitForQueuedActivation({
    params,
    parentEmitter,
    childId,
    task: params.task,
    label: params.label,
    speaker,
    startedAt,
    isBackground,
    isResume,
    budgetTracker: budgetTracker!,
    notifyBgIfNeeded,
  });
}

function emitChildStarted(prepared: PreparedChildExecution): void {
  const { params, parentEmitter, childId, startedAt, speaker, isResume, isBackground } = prepared;
  parentEmitter?.(new SubagentStatusEvent(StreamEvents.SUBAGENT_STARTED, {
      run_id: childId,
      subagent_run_id: childId,
      task: params.task,
      label: params.label,
      tool_call_id: params.parentToolCallId,
      parent_tool_call_id: params.parentToolCallId,
      dispatcher_run_id: params.context.assistantSubagentRunId,
      started_at: startedAt,
      speaker_id: childId,
      speaker,
      ...(isResume ? { resumed: true } : {}),
      ...(isBackground ? { background: true } : {}),
  }).toStreamEvent());
}

function startActiveChildRun(prepared: PreparedChildExecution): ActiveChildRun {
  const configuredTimeoutMs = prepared.params.config.childTimeoutMs;
  const timeoutMs = typeof configuredTimeoutMs === 'number' && Number.isFinite(configuredTimeoutMs)
    ? Math.max(0, configuredTimeoutMs)
    : undefined;
  const timeoutController = new AbortController();
  let timedOut = false;
  const timer = timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
        timedOut = true;
        timeoutController.abort();
      }, timeoutMs);
  activeChildren.set(prepared.childId, timeoutController);
  const unregisterFromManager = registerActiveChildInManager(prepared, timeoutController);
  const onParentAbort = () => timeoutController.abort();
  if (!prepared.isBackground) {
    prepared.params.context.abortSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  return { timeoutMs, timeoutController, isTimedOut: () => timedOut, timer, unregisterFromManager, onParentAbort };
}

function registerActiveChildInManager(
  prepared: PreparedChildExecution,
  timeoutController: AbortController,
): (() => void) | undefined {
  const meta = {
    label: prepared.params.label,
    startedAt: prepared.startedAt,
    state: 'active' as const,
    parentToolCallId: prepared.params.parentToolCallId,
    resumed: prepared.isResume,
  };
  return prepared.isBackground
    ? prepared.params.config.subagentManager?.spawnBackground(prepared.childId, timeoutController, meta)
    : prepared.params.config.subagentManager?.registerRun(prepared.childId, timeoutController, meta);
}

function buildChildRuntimeContext(prepared: PreparedChildExecution): ChildRuntimeContext {
  const effectiveTools = resolveEffectiveChildTools(prepared);
  const runtimeToolState = createToolHistoryState();
  return {
    toolState: runtimeToolState,
    childForwarders: createChildEventForwarders({
      config: prepared.params.config,
      parentEmitter: prepared.parentEmitter,
      childId: prepared.childId,
      onChildEvent: (event, getChildTraceId) => {
        if (
          event.type !== StreamEvents.SYSTEM_NOTICE
          || event.payload?.notice_type !== 'tool_progress'
        ) return;
        handleChildToolNotice({
          event,
          parentEmitter: prepared.parentEmitter,
          params: prepared.params,
          childId: prepared.childId,
          startedAt: prepared.startedAt,
          toolState: runtimeToolState,
          getChildTraceId,
        });
      },
    }),
    effectiveTools,
    childSystemPrompt: buildChildSystemPrompt(prepared, effectiveTools),
  };
}

function resolveEffectiveChildTools(prepared: PreparedChildExecution): ToolProvider {
  let effectiveTools: ToolProvider = prepared.params.childTools ?? prepared.params.config.tools;
  if (prepared.childDepth >= MAX_SUBAGENT_DEPTH) {
    effectiveTools = stripAgentToolFromProvider(effectiveTools);
  }
  if (prepared.params.readonlySubagent) {
    return wrapToolProviderForAskMode(
      effectiveTools,
      prepared.params.config.annotateReadonlyChildTools,
    );
  }
  return effectiveTools;
}

function buildChildSystemPrompt(prepared: PreparedChildExecution, effectiveTools: ToolProvider): string {
  const promptMode = prepared.params.readonlySubagent ? 'ask' : 'agent';
  const baseTools = prepared.params.readonlySubagent
    ? (prepared.params.childTools ?? prepared.params.config.tools).getTools()
    : effectiveTools.getTools();
  const provider = prepared.params.config.systemPromptProvider;
  let childSystemPrompt = provider
    ? provider.resolveSubagentPrompt({
        parentPrompt: prepared.params.systemPrompt,
        buildConfig: prepared.params.config.systemPromptBuildConfig,
        mode: promptMode,
        childTools: baseTools,
      })
    : resolveSubagentSystemPromptStringFallback(
        prepared.params.systemPrompt,
        promptMode,
      );
  childSystemPrompt = `${childSystemPrompt}\n\n${SUBAGENT_WORKER_SYSTEM_SECTION}`;
  return childSystemPrompt;
}

function buildChildForkConfig(
  prepared: PreparedChildExecution,
  activeRun: ActiveChildRun,
  runtime: ChildRuntimeContext,
  provider: LLMProvider,
): ForkQueryConfig {
  const { params, liveDeps, childId, childDepth, isResume } = prepared;
  const { config, context } = params;
  return {
    resume: isResume,
    parentMessages: context.messages,
    taskPrompt: params.task,
    systemPrompt: runtime.childSystemPrompt,
    provider,
    tools: runtime.effectiveTools,
    permissionHandler: config.permissionHandler,
    budgetTracker: liveDeps.budgetTracker,
    model: params.childModel,
    maxTurns: config.maxChildTurns,
    signal: activeRun.timeoutController.signal,
    sessionConfig: config.sessionConfig,
    // 子 storage 用 agent-*；CLI / TABTIN_THREAD_ID 仍跟父业务对话。
    businessThreadId: context.threadId,
    billingIdempotencyScope: context.billingIdempotencyScope
      ? `${context.billingIdempotencyScope}:subagent:${childId}`
      : undefined,
    subagentDepth: childDepth,
    parentToolCallId: params.parentToolCallId,
    role: params.role,
    label: params.label,
    templateId: params.templateId,
    templateVersion: params.templateVersion,
    templateName: params.templateName,
    emitStreamEvent: runtime.childForwarders.childEmitter,
    waitForUserInput: createSubagentWaitForUserInput(liveDeps.waitForUserInput, {
        sessionId: context.threadId,
      })
      ?? createChildWaitForUserInputStub(),
    runtimeMode: context.runtimeMode,
    hooks: config.hooks,
    contextWindowTokens: params.childCapabilities?.contextWindowTokens ?? config.contextWindowTokens,
    maxOutputTokens: params.childCapabilities?.maxOutputTokens ?? config.maxOutputTokens,
    modelCapabilities: params.childCapabilities ?? config.modelCapabilities,
    childId,
    workspaceRoot: liveDeps.workspaceRoot ?? context.workspaceRoot,
    //  RC：子 Agent 复用父 ToolProvider（业务 id 已在 host 装配时烘焙进
    // 各工具 / Capability 的闭包 deps）+ 父 Cap 闭包，无需再经 runtime 契约透传
    // spaceId / organizationId / workspaceScopeKey。
    agentMode: config.agentMode,
    iterationBudget: config.iterationBudget,
    todoCompletionNudgeProvider: config.todoCompletionNudgeProvider,
    enableSummaryReuse: config.enableSummaryReuse,
    summaryReuseJudgeSampleRate: config.summaryReuseJudgeSampleRate,
    summaryReuseJudgeWindowSize: config.summaryReuseJudgeWindowSize,
    summaryReuseJudgeThreshold: config.summaryReuseJudgeThreshold,
    summaryReuseMaxAgeMs: config.summaryReuseMaxAgeMs,
    summaryReuseMinAddedMessages: config.summaryReuseMinAddedMessages,
    summaryReuseJudgeFn: config.summaryReuseJudgeFn,
    timeBasedMicroCompact: config.timeBasedMicroCompact,
    pressureThresholds: config.pressureThresholds,
    contextBudget: config.contextBudget,
    toolResultStorage: config.toolResultStorage,
    readFileState: config.readFileState,
    imageReadFileState: config.imageReadFileState,
    localDocReadFileState: config.localDocReadFileState,
    fileHistory: config.fileHistory,
    fileHistoryAnchorId: context.fileHistoryAnchorId ?? context.agentRunId,
    toolRiskPolicy: liveDeps.toolRiskPolicy,
    judgeHomeDir: config.judgeHomeDir,
    bindToolGate: config.bindToolGate,
    annotateReadonlyChildTools: config.annotateReadonlyChildTools,
    systemPromptProvider: config.systemPromptProvider,
    osErrorBlacklist: liveDeps.osErrorBlacklist,
    isUntrustedShellCommand: config.isUntrustedShellCommand,
    readonlySubagent: params.readonlySubagent,
    //  Phase 1：readonly 子 Agent 的 mode-reminder 注入现由宿主经此工厂
    // 提供（原硬编码的 mode-reminder 注入已迁到宿主内容包）。
    buildReadonlySubagentHooks: config.buildReadonlySubagentHooks,
    userInteractiveChannel: createSubagentUserInteractiveChannel(
      liveDeps.userInteractiveChannel,
      {
        subagentDepth: childDepth,
        parentToolCallId: params.parentToolCallId,
        subagentRunId: childId,
        label: params.label,
      },
    ),
    inheritMode: params.inheritMode,
    subagentPolicy: params.subagentPolicy,
    drainParentMidflightMessages: () =>
      params.config.subagentManager?.drainPendingUserMessages(childId) ?? [],
    drainThreadNotifications: params.config.drainSubagentNotifications
      ? () => params.config.drainSubagentNotifications?.(childId) ?? Promise.resolve(null)
      : undefined,
  };
}

async function consumeChildForkQuery(
  prepared: PreparedChildExecution,
  activeRun: ActiveChildRun,
  runtime: ChildRuntimeContext,
  provider: LLMProvider,
): Promise<string> {
  const gen = forkQuery(buildChildForkConfig(prepared, activeRun, runtime, provider));
  let result = await gen.next();
  while (!result.done) {
    handleChildStreamEvent({
      event: result.value as StreamEvent,
      parentEmitter: prepared.parentEmitter,
      params: prepared.params,
      childId: prepared.childId,
      startedAt: prepared.startedAt,
      toolState: runtime.toolState,
      getChildTraceId: runtime.childForwarders.getChildTraceId,
      forwardChildEventToTrace: runtime.childForwarders.forwardChildEventToTrace,
    });
    result = await gen.next();
  }
  return result.value;
}

function classifyActiveChildFailure(
  prepared: PreparedChildExecution,
  activeRun: ActiveChildRun,
  err: unknown,
): {
  errorKind: 'cancelled' | 'timeout' | 'failed';
  summary: string;
  wasCancelled: boolean;
  isTimeout: boolean;
  modelRuntimeFailure?: RuntimeModelFailureHint;
} {
  const msg = err instanceof Error ? err.message : String(err);
  const cancelledByIpc = !activeChildren.has(prepared.childId);
  const parentAborted = prepared.params.context.abortSignal.aborted;
  const isTimeout = prepared.isBackground
    ? activeRun.isTimedOut()
    : !cancelledByIpc && !parentAborted && activeRun.timeoutController.signal.aborted;
  const wasCancelled = prepared.isBackground
    ? !activeRun.isTimedOut() && (cancelledByIpc || activeRun.timeoutController.signal.aborted)
    : cancelledByIpc || parentAborted;
  const errorKind = wasCancelled ? 'cancelled' : isTimeout ? 'timeout' : 'failed';
  const summary = buildActiveChildFailureSummary({
    label: prepared.params.label,
    msg,
    wasCancelled,
    cancelledByIpc,
    isTimeout,
    timeoutMs: activeRun.timeoutMs,
  });
  const modelRuntimeFailure = wasCancelled || isTimeout
    ? undefined
    : detectRuntimeModelFailure(err);
  return { errorKind, summary, wasCancelled, isTimeout, modelRuntimeFailure };
}

function detectRuntimeModelFailure(err: unknown): RuntimeModelFailureHint | undefined {
  if (!(err instanceof AgentError)) {
    return undefined;
  }

  const details = err.details ?? {};
  const errorType = typeof details.error_type === 'string'
    ? details.error_type
    : undefined;
  const detailMessage = typeof details.user_message === 'string'
    ? details.user_message
    : typeof details.message === 'string'
      ? details.message
      : undefined;
  const message = detailMessage ?? err.message;
  if (!isInactiveOrMissingModelErrorType(errorType)) {
    return undefined;
  }
  const modelErrorType = errorType;
  return {
    errorType: modelErrorType,
    statusCode: err.statusCode,
    message,
  };
}

function buildActiveChildFailureSummary(input: {
  label: string;
  msg: string;
  wasCancelled: boolean;
  cancelledByIpc: boolean;
  isTimeout: boolean;
  timeoutMs?: number;
}): string {
  if (input.wasCancelled && input.cancelledByIpc) {
    return `Sub-agent cancelled by user: ${input.label}. The user actively cancelled this subtask. Do NOT attempt to accomplish the same goal through other means; stop the current line of work and check with the user first, unless the user has already instructed otherwise.`;
  }
  if (input.wasCancelled) return `Sub-agent cancelled: ${input.label}`;
  if (input.isTimeout) return `Sub-agent timed out after ${input.timeoutMs ?? 0}ms: ${input.label}`;
  return `Sub-agent failed: ${input.msg}`;
}

function emitActiveChildFailure(
  prepared: PreparedChildExecution,
  activeRun: ActiveChildRun,
  runtime: ChildRuntimeContext,
  failure: ReturnType<typeof classifyActiveChildFailure>,
): void {
  const failedAt = Date.now();
  prepared.parentEmitter?.(new SubagentStatusEvent(StreamEvents.SUBAGENT_FAILED, {
      run_id: prepared.childId,
      subagent_run_id: prepared.childId,
      tool_call_id: prepared.params.parentToolCallId,
      parent_tool_call_id: prepared.params.parentToolCallId,
      dispatcher_run_id: prepared.params.context.assistantSubagentRunId,
      task: prepared.params.task,
      label: prepared.params.label,
      error: failure.wasCancelled ? 'Cancelled by parent' : failure.summary,
      error_kind: failure.errorKind,
      timeout_ms: failure.isTimeout ? activeRun.timeoutMs : undefined,
      cancelled: failure.wasCancelled,
      ended_at: failedAt,
      stats: { duration_ms: failedAt - prepared.startedAt },
      child_trace_id: runtime.childForwarders.getChildTraceId(),
      speaker_id: prepared.childId,
      speaker: {
        ...prepared.speaker,
        status: failure.wasCancelled ? 'cancelled' as const : 'failed' as const,
        ended_at: failedAt,
      },
  }).toStreamEvent());
}

function cleanupActiveChild(
  prepared: PreparedChildExecution,
  activeRun: ActiveChildRun,
  runtime: ChildRuntimeContext,
): void {
  if (activeRun.timer !== undefined) clearTimeout(activeRun.timer);
  activeChildren.delete(prepared.childId);
  activeRun.unregisterFromManager?.();
  prepared.params.context.abortSignal.removeEventListener('abort', activeRun.onParentAbort);
  prepared.liveDeps.budgetTracker?.releaseChildAgent(prepared.childId);
  maybeEmitTraceTelemetry(prepared, runtime);
}

function maybeEmitTraceTelemetry(
  prepared: PreparedChildExecution,
  runtime: ChildRuntimeContext,
): void {
  const traceCount = runtime.childForwarders.getTraceForwardedCount();
  const childTraceId = runtime.childForwarders.getChildTraceId();
  if (!prepared.params.config.subagentTraceEmitter) return;
  if (traceCount === 0 && !childTraceId) return;
  emitTelemetryEvent(
    TelemetryEvents.SUBAGENT_TRACE_EMITTED,
    {
      event_count: traceCount,
      parent_trace_id: prepared.params.config.getParentTraceId?.() ?? null,
      child_trace_id: childTraceId ?? null,
      subagent_run_id: prepared.childId,
    },
    { session_id: prepared.params.config.sessionConfig.threadId },
  );
}

function buildChildStats(
  prepared: PreparedChildExecution,
  endedAt: number,
): Record<string, unknown> {
  const scopeUsage = prepared.liveDeps.budgetTracker?.getUsageByScope(prepared.childId);
  const childStats: Record<string, unknown> = { duration_ms: endedAt - prepared.startedAt };
  if (!scopeUsage) return childStats;
  childStats.input_tokens = scopeUsage.inputTokens;
  childStats.output_tokens = scopeUsage.outputTokens;
  childStats.total_tokens = scopeUsage.inputTokens + scopeUsage.outputTokens;
  if (typeof scopeUsage.credits === 'number') {
    childStats.credits_consumed = scopeUsage.credits;
  }
  return childStats;
}

function compactChildFinalSummary(
  prepared: PreparedChildExecution,
  summary: string,
  failed: boolean,
): string {
  if (failed || prepared.params.config.subagentResultCompact === false) return summary;
  const compactResult = microCompactSubagentSummary(summary);
  emitTelemetryEvent(
    TelemetryEvents.SUBAGENT_COMPACT,
    {
      msgs_before: 1,
      msgs_after: 1,
      chars_before: compactResult.originalLength,
      chars_after: compactResult.newLength,
      tokens_before: Math.ceil(compactResult.originalLength / 4),
      tokens_after: Math.ceil(compactResult.newLength / 4),
      truncated: compactResult.truncated,
      max_chars: compactResult.maxChars,
      subagent_run_id: prepared.childId,
    },
    { session_id: prepared.params.config.sessionConfig.threadId },
  );
  return compactResult.summary;
}

interface ParsedFindingsReport {
  structuredReport?: unknown;
  violation?: string;
}

function parseFindingsReport(summary: string): ParsedFindingsReport {
  const trimmed = summary.trimStart();
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n```/.exec(trimmed);
  if (!match) return { violation: 'missing_leading_json_code_block' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch {
    return { violation: 'invalid_json_code_block' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { violation: 'json_root_must_be_object' };
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.findings)) return { violation: 'findings_must_be_array' };
  if (record.findings.length > 20) return { violation: 'too_many_findings' };
  for (const finding of record.findings) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
      return { violation: 'finding_must_be_object' };
    }
    const f = finding as Record<string, unknown>;
    if (typeof f.claim !== 'string' || f.claim.trim().length === 0) {
      return { violation: 'finding_claim_required' };
    }
    if (
      !Array.isArray(f.evidence) ||
      f.evidence.length === 0 ||
      !f.evidence.every((e) => typeof e === 'string' && e.trim().length > 0)
    ) {
      return { violation: 'finding_evidence_required' };
    }
    if (f.confidence !== 'high' && f.confidence !== 'medium' && f.confidence !== 'low') {
      return { violation: 'finding_confidence_invalid' };
    }
  }
  if (
    record.limitations !== undefined &&
    (!Array.isArray(record.limitations) ||
      !record.limitations.every((item) => typeof item === 'string'))
  ) {
    return { violation: 'limitations_must_be_string_array' };
  }
  if (typeof record.summary !== 'string' || record.summary.trim().length === 0) {
    return { violation: 'summary_required' };
  }
  if (record.summary.length > 500) return { violation: 'summary_too_long' };
  return { structuredReport: parsed };
}

function appendStructuredReportBlock(
  content: string,
  report: ParsedFindingsReport | undefined,
): string {
  if (!report) return content;
  const payload = report.structuredReport !== undefined
    ? { structured_report: report.structuredReport }
    : { report_schema_violation: report.violation };
  return `${content}\n\n<structured_report>\n${JSON.stringify(payload)}\n</structured_report>`;
}

async function buildSuccessfulChildResult(
  prepared: PreparedChildExecution,
  runtime: ChildRuntimeContext,
  summary: string,
): Promise<ToolResult> {
  const endedAt = Date.now();
  const finalSummary = compactChildFinalSummary(prepared, summary, false);
  const findingsReport = prepared.params.reportSchema === 'findings'
    ? parseFindingsReport(summary)
    : undefined;
  await runtime.childForwarders.awaitParentPersistWrites();
  prepared.parentEmitter?.(new SubagentStatusEvent(StreamEvents.SUBAGENT_COMPLETED, {
      run_id: prepared.childId,
      subagent_run_id: prepared.childId,
      tool_call_id: prepared.params.parentToolCallId,
      parent_tool_call_id: prepared.params.parentToolCallId,
      dispatcher_run_id: prepared.params.context.assistantSubagentRunId,
      task: prepared.params.task,
      label: prepared.params.label,
      summary: finalSummary,
      structured_report: findingsReport?.structuredReport,
      report_schema_violation: findingsReport?.violation,
      ended_at: endedAt,
      stats: buildChildStats(prepared, endedAt),
      child_trace_id: runtime.childForwarders.getChildTraceId(),
      speaker_id: prepared.childId,
      speaker: { ...prepared.speaker, status: 'completed' as const, ended_at: endedAt },
  }).toStreamEvent());
  prepared.notifyBgIfNeeded({
    status: 'completed',
    summary: finalSummary,
    step_count: runtime.toolState.stepCount,
    stats: buildChildStats(prepared, endedAt) as SubagentCompletionInfo['stats'],
  });
  emitBackgroundSubagentTerminalFact(prepared, {
    status: 'completed',
    content: appendStructuredReportBlock(finalSummary, findingsReport),
  });
  return {
    content: appendSubagentId(
      appendStructuredReportBlock(
        prependModelNotice(finalSummary, prepared.params.modelNotice),
        findingsReport,
      ),
      prepared.childId,
    ),
    presentation: subagentResultPresentation(prepared.childId, 'completed'),
  };
}

function buildFailedChildResult(
  prepared: PreparedChildExecution,
  runtime: ChildRuntimeContext,
  failure: ReturnType<typeof classifyActiveChildFailure>,
  options: { notifyBackground?: boolean } = {},
): ToolResult {
  if (options.notifyBackground !== false) {
    prepared.notifyBgIfNeeded({
      status: failure.errorKind,
      summary: failure.summary,
      step_count: runtime.toolState.stepCount,
      error_kind: failure.errorKind,
      stats: { duration_ms: Date.now() - prepared.startedAt },
    });
  }
  emitBackgroundSubagentTerminalFact(prepared, {
    status: failure.errorKind,
    content: failure.summary,
    isError: true,
  });
  return {
    content: appendSubagentId(
      prependModelNotice(failure.summary, prepared.params.modelNotice),
      prepared.childId,
    ),
    isError: true,
    presentation: subagentResultPresentation(prepared.childId, failure.errorKind),
    hostMetadata: failure.modelRuntimeFailure
      ? { [SUBAGENT_MODEL_RUNTIME_FAILURE_KEY]: failure.modelRuntimeFailure }
      : undefined,
  };
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function canRetryInactiveChildModelWithParent(
  params: ExecuteChildAgentParams,
): boolean {
  // 后台 detach / resume 续跑不自动换模型重派，避免生命周期与会话复用纠缠。
  if (params.background || params.resumeChildId) return false;
  if (params.strictModel) return false;
  const parentModel = normalizeNonEmptyString(params.parentModel);
  return !!parentModel && params.childModel !== parentModel;
}

async function runActiveChild(prepared: PreparedChildExecution): Promise<ToolResult> {
  emitChildStarted(prepared);
  const activeRun = startActiveChildRun(prepared);
  const runtime = buildChildRuntimeContext(prepared);
  try {
    const provider = prepared.params.config.resolveProviderForModel
      ? await prepared.params.config.resolveProviderForModel(prepared.params.childModel)
      : prepared.params.config.provider;
    const summary = await consumeChildForkQuery(prepared, activeRun, runtime, provider);
    return buildSuccessfulChildResult(prepared, runtime, summary);
  } catch (err) {
    const failure = classifyActiveChildFailure(prepared, activeRun, err);
    if (failure.modelRuntimeFailure && canRetryInactiveChildModelWithParent(prepared.params)) {
      return buildFailedChildResult(prepared, runtime, failure, { notifyBackground: false });
    }
    emitActiveChildFailure(prepared, activeRun, runtime, failure);
    return buildFailedChildResult(prepared, runtime, failure);
  } finally {
    cleanupActiveChild(prepared, activeRun, runtime);
  }
}

async function executeChildAgentAttempt(params: ExecuteChildAgentParams): Promise<ToolResult> {
  const prepared = prepareChildExecution(params);
  if ('content' in prepared) return prepared;
  const queuedOrRejected = await enterChildScheduler(prepared);
  if (queuedOrRejected) return queuedOrRejected;
  return runActiveChild(prepared);
}

function shouldRetryInactiveChildModelWithParent(
  params: ExecuteChildAgentParams,
  result: ToolResult,
): boolean {
  if (!result.isError) return false;
  return canRetryInactiveChildModelWithParent(params) && getRuntimeModelFailureHint(result) != null;
}

function buildRuntimeInactiveModelFallbackNotice(
  requestedModel: string,
  parentModel: string,
): string {
  return (
    `（注意：你为子 Agent 请求的模型「${requestedModel}」当前不可用或未激活，` +
    `已自动改用父 Agent 模型「${parentModel}」继续执行。）\n\n`
  );
}

async function executeChildAgent(params: ExecuteChildAgentParams): Promise<ToolResult> {
  const first = await executeChildAgentAttempt(params);
  const runtimeFailure = getRuntimeModelFailureHint(first);
  if (runtimeFailure) {
    params.config.onModelRuntimeFailure?.({
      modelId: params.childModel,
      errorType: runtimeFailure.errorType,
      statusCode: runtimeFailure.statusCode,
      message: runtimeFailure.message ?? String(first.content ?? ''),
    });
  }
  if (!shouldRetryInactiveChildModelWithParent(params, first)) return first;

  const parentModel = normalizeNonEmptyString(params.parentModel)!;
  const firstChildId = typeof first.presentation?.data?.subagent_run_id === 'string'
    ? first.presentation.data.subagent_run_id
    : undefined;
  const runtimeNotice = buildRuntimeInactiveModelFallbackNotice(params.childModel, parentModel);
  return executeChildAgentAttempt({
    ...params,
    childModel: parentModel,
    childIdOverride: firstChildId,
    childCapabilities: undefined,
    modelNotice: `${runtimeNotice}${params.modelNotice ?? ''}`,
    resumeChildId: undefined,
  });
}

function getRuntimeModelFailureHint(result: ToolResult): RuntimeModelFailureHint | undefined {
  const value = result.hostMetadata?.[SUBAGENT_MODEL_RUNTIME_FAILURE_KEY];
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const errorType = typeof raw.errorType === 'string' ? raw.errorType : undefined;
  if (!isInactiveOrMissingModelErrorType(errorType)) return undefined;
  return {
    errorType,
    statusCode: typeof raw.statusCode === 'number' ? raw.statusCode : undefined,
    message: typeof raw.message === 'string' ? raw.message : undefined,
  };
}

/**
 * Phase 4 / R8：把「请求的模型不可用、已改用 X」的中文提示前置到子 Agent 的
 * tool_result content。modelNotice 已自带结尾换行；缺省（命中 / 无目录）时原样返回。
 */
function prependModelNotice(content: string, modelNotice?: string): string {
  if (!modelNotice) return content;
  return `${modelNotice}${content}`;
}

interface AgentToolInput {
  prompt?: string;
  description?: string;
  role?: string;
  model?: string;
  tool_domains?: string[];
  readonly?: boolean;
  resume_agent_id?: string;
  background?: boolean;
  interrupt?: boolean;
  check_agent_id?: string;
  wait_agent_ids?: string[];
  message_agent_id?: string;
  report_schema?: 'free' | 'findings';
  fork_context?: boolean;
  /** 可选关联：宿主确认后保留；无效 id 由宿主剥离。 */
  template_id?: string;
}

interface AgentToolRequest extends AgentToolInput {
  prompt: string;
}

interface InterruptResolution {
  resumeChildId?: string;
  result?: ToolResult;
}

interface SpawnPlan {
  baseParams: ExecuteChildAgentParams;
  effectiveBackground: boolean;
  label: string;
}

interface ChildModelCandidate {
  model: string;
  capabilities?: ModelCapabilities;
  entry?: ModelCatalogEntry;
}

interface FundingBlockedCandidate {
  model: string;
  message?: string | null;
  requiredCredits?: string | null;
}

interface FundingAllowedCandidate extends ChildModelCandidate {
  requiredCredits?: string | null;
}

function parseAgentToolInput(input: unknown): AgentToolInput {
  return input as AgentToolInput;
}

const FINDINGS_REPORT_SCHEMA_PROMPT =
  '输出契约：请在最终答复开头先给一个 JSON 对象代码块，形如 ' +
  '{"findings":[{"claim":"...","evidence":["path:line 或命令输出摘录"],"confidence":"high|medium|low"}],"limitations":["..."],"summary":"≤500 字"}。' +
  'findings 最多 20 条；每条 claim 必须有 evidence；不确定处写入 limitations。';

function buildSubagentTaskPrompt(request: AgentToolRequest): string {
  if (request.report_schema !== 'findings') return request.prompt;
  return `${FINDINGS_REPORT_SCHEMA_PROMPT}\n\n任务：\n${request.prompt}`;
}

function resolveChildInheritMode(request: AgentToolRequest): InheritMode {
  return request.fork_context === true ? 'full' : 'none';
}


type SubagentWaitState = 'waiting' | 'completed' | 'error';

function buildSubagentWaitPresentation(
  childIds: string[],
  status: SubagentWaitState,
  data: Record<string, unknown> = {},
): ToolPresentation {
  return {
    kind: 'subagent_wait',
    data: {
      childIds,
      status,
      ...data,
    },
  };
}

const SETTLED_SUBAGENT_RESULTS_HEADER = '\n已结束的子 Agent：\n';

function formatSettledSubagentResults(
  completions: readonly SubagentCompletionInfo[],
): string {
  if (completions.length === 0) return '';
  return SETTLED_SUBAGENT_RESULTS_HEADER + completions.map((info) => {
    const summary = info.summary.trim() || '（无结果摘要）';
    return `- ${info.label}（${info.status}）：${summary}`;
  }).join('\n');
}

function buildWaitForSubagentsResult(
  config: AgentToolConfig,
  childIds: string[],
  waitToolCallId: string,
): ToolResult {
  if (!config.subagentManager) {
    return {
      content: '当前运行时不支持后台子 Agent 等待，请直接以前台模式重新派发任务。',
      isError: true,
      presentation: buildSubagentWaitPresentation(childIds, 'error', { waitToolCallId }),
    };
  }
  const armed = config.subagentManager.armCompletionBarrier(waitToolCallId, childIds);
  if (!armed.ok) {
    return {
      content: armed.reason,
      isError: true,
      presentation: buildSubagentWaitPresentation(childIds, 'error', { waitToolCallId }),
    };
  }
  const completedCount = armed.completions.length;
  const completedChildIds = armed.completions.map((info) => info.subagent_run_id);
  const failedChildIds = armed.completions
    .filter((info) => info.status === 'failed' || info.status === 'timeout')
    .map((info) => info.subagent_run_id);
  const cancelledChildIds = armed.completions
    .filter((info) => info.status === 'cancelled')
    .map((info) => info.subagent_run_id);
  const settledSummary = formatSettledSubagentResults(armed.completions);
  if (armed.pendingChildIds.length === 0) {
    return {
      content:
        `${armed.childIds.length} 个后台子 Agent 均已结束，无需继续挂起。` +
        settledSummary,
      isError: false,
      presentation: buildSubagentWaitPresentation(armed.childIds, 'completed', {
        waitToolCallId: armed.waitToolCallId,
        completedCount,
        completedChildIds,
        failedChildIds,
        cancelledChildIds,
        totalCount: armed.childIds.length,
      }),
    };
  }
  return {
    content:
      `已进入等待：${completedCount}/${armed.childIds.length} 个后台子 Agent 已结束，` +
      `其余 ${armed.pendingChildIds.length} 个全部结束后会自动继续。` +
      '等待期间不要用 check_agent_id 代替本等待；若只需了解进度可偶尔查询。' +
      settledSummary,
    isError: false,
    presentation: buildSubagentWaitPresentation(armed.childIds, 'waiting', {
      waitToolCallId: armed.waitToolCallId,
      completedCount,
      completedChildIds,
      failedChildIds,
      cancelledChildIds,
      pendingCount: armed.pendingChildIds.length,
      totalCount: armed.childIds.length,
    }),
    signals: {
      suspendRun: {
        reason: 'awaiting_subagents',
        pendingSubagentIds: armed.pendingChildIds,
        onDiscard: () => config.subagentManager?.cancelCompletionBarrier(armed.waitToolCallId),
      },
    },
  };
}

function validateAgentPrompt(input: AgentToolInput): ToolResult | AgentToolRequest {
  if (!input.prompt || typeof input.prompt !== 'string') {
    return { content: 'Error: "prompt" is required and must be a non-empty string.', isError: true };
  }
  return { ...input, prompt: input.prompt };
}

function validateSubagentDepth(context: ToolContext): ToolResult | undefined {
  const currentDepth = context.subagentDepth ?? 0;
  if (currentDepth < MAX_SUBAGENT_DEPTH) return undefined;
  return {
    content:
      `子 Agent 嵌套已达上限（父子孙三级，当前第 ${currentDepth} 层）：你不能再派子 Agent。` +
      `请直接完成你被指派的任务并回报，不要再 fork。`,
    isError: true,
  };
}

async function resolveInterruptRedirect(
  config: AgentToolConfig,
  resumeChildId: string | undefined,
  interrupt: boolean | undefined,
): Promise<InterruptResolution> {
  if (!resumeChildId || interrupt !== true || !config.subagentManager) {
    return { resumeChildId };
  }
  if (config.subagentManager.isAwaitingCompletion(resumeChildId)) {
    return {
      result: {
        content: '该后台子 Agent 正在等待汇总，不能在等待期间中断并改写任务。',
        isError: true,
      },
    };
  }
  if (!isSubagentInFlight(config, resumeChildId)) {
    return { resumeChildId };
  }
  interruptingChildren.add(resumeChildId);
  cancelSubagent(resumeChildId);
  const settled = await config.subagentManager.waitUntilSettled(
    resumeChildId,
    INTERRUPT_SETTLE_TIMEOUT_MS,
  );
  interruptingChildren.delete(resumeChildId);
  if (!settled) {
    return {
      result: {
        content:
          '请求中断的子 Agent 未能在预期时间内停止，已避免并发续跑造成历史损坏。' +
          '请稍后用相同 [子 Agent ID] 重试续跑。',
        isError: true,
      },
    };
  }
  return {
    resumeChildId: subagentSessionExists(config.sessionConfig, resumeChildId)
      ? resumeChildId
      : undefined,
  };
}

function resolveChildToolProvider(
  config: AgentToolConfig,
  request: AgentToolRequest,
): ToolProvider | undefined {
  const explicitToolDomains = Array.isArray(request.tool_domains)
    ? request.tool_domains
    : undefined;
  return buildScopedToolProvider(config.tools, explicitToolDomains, undefined);
}

function resolveRequestedChildModel(
  request: AgentToolRequest,
): string | undefined {
  return normalizeNonEmptyString(request.model);
}

function buildModelDowngradeNotice(
  downgrade: ReturnType<typeof resolveChildModelFromCatalog>['downgrade'],
): string | undefined {
  if (!downgrade) return undefined;
  return `（注意：你为子 Agent 请求的模型「${downgrade.requested}」不在当前可用模型清单中，` +
    `已自动改用「${downgrade.resolved}」。可用模型见 agent 工具说明里的「可用模型清单」。）\n\n`;
}

function appendModelNotice(base: string | undefined, next: string | undefined): string | undefined {
  if (!base) return next;
  if (!next) return base;
  return `${base}${next}`;
}

function buildFundingSwitchNotice(
  blocked: FundingBlockedCandidate,
  resolvedModel: string,
): string {
  const reason = blocked.message?.trim()
    ? `原因：${blocked.message.trim()}`
    : '原因：当前余额或预算不足。';
  const credits = blocked.requiredCredits?.trim()
    ? `预计需要 ${blocked.requiredCredits.trim()} credits。`
    : '';
  return (
    `（注意：你为子 Agent 请求的模型「${blocked.model}」当前资金预检未通过，` +
    `${reason}${credits}已自动改用「${resolvedModel}」。）\n\n`
  );
}

function buildAllFundingBlockedResult(blocked: readonly FundingBlockedCandidate[]): ToolResult {
  const details = blocked.slice(0, 4).map((item) => {
    const message = item.message?.trim() || '资金预检未通过';
    const credits = item.requiredCredits?.trim()
      ? `，预计需要 ${item.requiredCredits.trim()} credits`
      : '';
    return `- ${item.model}: ${message}${credits}`;
  }).join('\n');
  return {
    content:
      '子 Agent 未启动：当前可用模型的资金预检均未通过。请充值、调整预算，或稍后重试。' +
      (details ? `\n${details}` : ''),
    isError: true,
    presentation: {
      kind: 'subagent_result',
      data: { status: 'failed', reason: 'funding_precheck_blocked' },
    },
  };
}

function addCandidate(
  candidates: ChildModelCandidate[],
  seen: Set<string>,
  candidate: ChildModelCandidate | undefined,
): void {
  const model = normalizeNonEmptyString(candidate?.model);
  if (!model || seen.has(model)) return;
  seen.add(model);
  candidates.push({ ...candidate, model });
}

function buildFundingCandidateList(input: {
  primary: ChildModelCandidate;
  config: AgentToolConfig;
}): ChildModelCandidate[] {
  const { primary, config } = input;
  const candidates: ChildModelCandidate[] = [];
  const seen = new Set<string>();
  addCandidate(candidates, seen, primary);

  for (const entry of config.modelCatalog ?? []) {
    addCandidate(candidates, seen, {
      model: entry.id,
      capabilities: entry.capabilities,
      entry,
    });
  }

  addCandidate(candidates, seen, {
    model: config.model,
    capabilities: undefined,
  });
  return candidates;
}

function parseCredits(value: string | null | undefined): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function chooseLowestCostAllowed(
  candidates: readonly FundingAllowedCandidate[],
): FundingAllowedCandidate | undefined {
  let best: FundingAllowedCandidate | undefined;
  let bestCredits: number | undefined;
  for (const candidate of candidates) {
    const credits = parseCredits(candidate.requiredCredits);
    if (!best) {
      best = candidate;
      bestCredits = credits;
      continue;
    }
    if (credits == null) continue;
    if (bestCredits == null || credits < bestCredits) {
      best = candidate;
      bestCredits = credits;
    }
  }
  return best;
}

function toolsToParams(provider: ToolProvider | undefined): ToolParam[] | undefined {
  const tools = provider?.getTools() ?? [];
  if (tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

function estimateChildRunTokens(input: {
  task: string;
  systemPrompt: string;
  childTools?: ToolProvider;
  capabilities?: ModelCapabilities;
  config: AgentToolConfig;
}): number {
  const maxOutputTokens =
    input.capabilities?.maxOutputTokens
    ?? input.config.maxOutputTokens
    ?? FALLBACK_MODEL_CAPABILITIES.maxOutputTokens;
  const inputTokens = estimateFullContextTokens(
    [{ role: 'user', content: input.task }],
    input.systemPrompt,
    toolsToParams(input.childTools),
  );
  return Math.max(0, Math.ceil(inputTokens + maxOutputTokens));
}

async function resolveFundingAwareChildModel(input: {
  config: AgentToolConfig;
  task: string;
  label: string;
  systemPrompt: string;
  childTools?: ToolProvider;
  primary: ChildModelCandidate;
  allowFallbacks: boolean;
  modelNotice?: string;
}): Promise<
  | { ok: true; model: string; capabilities?: ModelCapabilities; modelNotice?: string }
  | { ok: false; result: ToolResult }
> {
  const preview = input.config.previewChildModelFunding;
  if (!preview) {
    return {
      ok: true,
      model: input.primary.model,
      capabilities: input.primary.capabilities,
      modelNotice: input.modelNotice,
    };
  }

  const blocked: FundingBlockedCandidate[] = [];
  const allowedFallbacks: FundingAllowedCandidate[] = [];
  const candidates = input.allowFallbacks
    ? buildFundingCandidateList({ primary: input.primary, config: input.config })
    : [input.primary];
  for (const candidate of candidates) {
    // BYOK 使用用户/组织自己的上游额度，不用组织钱包余额预检来挡。
    if (candidate.entry?.providerScope && candidate.entry.providerScope !== 'global') {
      if (blocked.length === 0) {
        return {
          ok: true,
          model: candidate.model,
          capabilities: candidate.capabilities,
          modelNotice: input.modelNotice,
        };
      }
      allowedFallbacks.push(candidate);
      continue;
    }

    const estimatedTokens = estimateChildRunTokens({
      task: input.task,
      systemPrompt: input.systemPrompt,
      childTools: input.childTools,
      capabilities: candidate.capabilities,
      config: input.config,
    });

    let decision: Awaited<ReturnType<NonNullable<AgentToolConfig['previewChildModelFunding']>>>;
    try {
      decision = await preview({
        modelId: candidate.model,
        estimatedTokens,
        task: input.task,
        label: input.label,
      });
    } catch {
      if (!input.allowFallbacks) {
        return {
          ok: false,
          result: buildAllFundingBlockedResult([{
            model: candidate.model,
            message: '资金预检不可用',
            requiredCredits: null,
          }]),
        };
      }
      if (blocked.length > 0) {
        blocked.push({
          model: candidate.model,
          message: '资金预检不可用',
          requiredCredits: null,
        });
        continue;
      }
      return {
        ok: true,
        model: input.primary.model,
        capabilities: input.primary.capabilities,
        modelNotice: input.modelNotice,
      };
    }

    if (decision.allowed) {
      if (blocked.length === 0) {
        return {
          ok: true,
          model: candidate.model,
          capabilities: candidate.capabilities,
          modelNotice: input.modelNotice,
        };
      }
      allowedFallbacks.push({
        ...candidate,
        requiredCredits: decision.requiredCredits,
      });
      continue;
    }

    blocked.push({
      model: candidate.model,
      message: decision.message,
      requiredCredits: decision.requiredCredits,
    });
  }

  const fallback = chooseLowestCostAllowed(allowedFallbacks);
  if (fallback) {
    const notice = blocked[0] ? buildFundingSwitchNotice(blocked[0], fallback.model) : undefined;
    return {
      ok: true,
      model: fallback.model,
      capabilities: fallback.capabilities,
      modelNotice: appendModelNotice(input.modelNotice, notice),
    };
  }

  return { ok: false, result: buildAllFundingBlockedResult(blocked) };
}

function resolveEffectiveBackground(
  request: AgentToolRequest,
): boolean {
  return request.background === true;
}

function resolvePolicyRequestedChildModel(
  config: AgentToolConfig,
  request: AgentToolRequest,
  templateId: string | undefined,
): { requested?: string; strict: boolean } {
  const templateModel = normalizeNonEmptyString(request.model);
  if (templateId && templateModel) return { requested: templateModel, strict: true };
  if (config.subagentModelPolicy?.mode === 'inherit') return { requested: undefined, strict: false };
  if (config.subagentModelPolicy?.mode === 'fixed') {
    return {
      requested: normalizeNonEmptyString(config.subagentModelPolicy.modelId),
      strict: true,
    };
  }
  return { requested: resolveRequestedChildModel(request), strict: false };
}

function buildStrictModelUnavailableResult(requestedModel: string | undefined): ToolResult {
  const model = requestedModel?.trim();
  return {
    content: model
      ? `子 Agent 未启动：指定模型「${model}」当前不可用或不在可用模型清单中。请重新选择可用模型后再试。`
      : '子 Agent 未启动：当前固定模型策略缺少可用模型。请重新选择可用模型后再试。',
    isError: true,
    presentation: {
      kind: 'subagent_result',
      data: { status: 'failed', reason: 'strict_model_unavailable' },
    },
  };
}

async function buildSpawnPlan(input: {
  config: AgentToolConfig;
  context: ToolContext;
  request: AgentToolRequest;
  resumeChildId?: string;
}): Promise<SpawnPlan | ToolResult> {
  const { config, context, request, resumeChildId } = input;
  const childTools = resolveChildToolProvider(config, request);
  const label = request.description ?? request.prompt.slice(0, 60);
  const parentModel = normalizeNonEmptyString(context.model) ?? config.model;
  const templateId = normalizeNonEmptyString(request.template_id);
  const modelIntent = resolvePolicyRequestedChildModel(config, request, templateId);
  if (modelIntent.strict && !modelIntent.requested) {
    return buildStrictModelUnavailableResult(modelIntent.requested);
  }
  const childResolution = resolveChildModelFromCatalog({
    catalog: config.modelCatalog,
    requested: modelIntent.requested,
    parentModel,
  });
  if (modelIntent.strict && childResolution.downgrade) {
    return buildStrictModelUnavailableResult(modelIntent.requested);
  }
  const inheritedParentCapabilities = childResolution.model === parentModel
    && parentModel !== config.model
    ? findCatalogEntry(config.modelCatalog, parentModel)?.capabilities
    : undefined;
  const modelNotice = buildModelDowngradeNotice(childResolution.downgrade);
  const fundedModel = await resolveFundingAwareChildModel({
    config,
    task: request.prompt,
    label,
    systemPrompt: config.systemPrompt ?? '',
    childTools,
    primary: {
      model: childResolution.model,
      capabilities: childResolution.capabilities ?? inheritedParentCapabilities,
      entry: findCatalogEntry(config.modelCatalog, childResolution.model),
    },
    allowFallbacks: !modelIntent.strict,
    modelNotice,
  });
  if (!fundedModel.ok) return fundedModel.result;
  const task = buildSubagentTaskPrompt(request);
  return {
    effectiveBackground: resolveEffectiveBackground(request),
    label,
    baseParams: {
      config,
      context,
      parentToolCallId: context.toolUseId,
      inheritMode: resolveChildInheritMode(request),
      task,
      label,
      parentModel,
      role: normalizeNonEmptyString(request.role),
      childModel: fundedModel.model,
      strictModel: modelIntent.strict,
      childCapabilities: fundedModel.capabilities,
      modelNotice: fundedModel.modelNotice,
      source: templateId ? 'template' : 'inherit',
      templateId,
      childTools,
      systemPrompt: config.systemPrompt ?? '',
      readonlySubagent: request.readonly === true,
      reportSchema: request.report_schema,
      resumeChildId,
    },
  };
}

async function executeForegroundDowngrade(
  context: ToolContext,
  baseParams: ExecuteChildAgentParams,
  label: string,
): Promise<ToolResult> {
  context.emitStreamEvent?.(new RuntimeSystemNoticeEvent({
      content: '后台模式当前不可用（运行时未接 SubagentManager），已改为前台同步执行。',
      notice_type: 'subagent_background_unavailable',
      label,
  }).toStreamEvent());
  const fgResult = await executeChildAgent(baseParams);
  const downgradePrefix = '（后台模式当前不可用，已改为前台同步执行。）\n\n';
  return {
    ...fgResult,
    content: typeof fgResult.content === 'string'
      ? downgradePrefix + fgResult.content
      : fgResult.content,
  };
}

async function startBackgroundChild(baseParams: ExecuteChildAgentParams, label: string): Promise<ToolResult> {
  let started = false;
  return await new Promise<ToolResult>((resolveStarted) => {
    void executeChildAgent({
      ...baseParams,
      background: true,
      onStarted: (childId) => {
        started = true;
        resolveStarted({
          content: appendSubagentId(
            `已在后台启动子 Agent「${label}」。它会独立跑完（不阻塞你当前的工作），` +
            `完成后你会收到一条带结果摘要的通知；中途可用下面的 ID 续跑或查询它。` +
            `若已无其它独立工作，请在本轮所有后台派发都返回 ID 后的下一轮，` +
            `把所有待汇总 ID 一次传给 wait_agent_ids。`,
            childId,
          ),
          isError: false,
          presentation: subagentDispatchPresentation(childId, 'pending', true),
        });
      },
    })
      .then((terminal) => {
        if (!started) resolveStarted(terminal);
      })
      .catch((err) => {
        if (!started) {
          resolveStarted({
            content: `子 Agent 后台启动失败：${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          });
        }
      });
  });
}

async function executeSpawnPlan(
  config: AgentToolConfig,
  context: ToolContext,
  plan: SpawnPlan,
): Promise<ToolResult> {
  if (plan.effectiveBackground && !config.subagentManager) {
    return executeForegroundDowngrade(context, plan.baseParams, plan.label);
  }
  if (plan.effectiveBackground) {
    return startBackgroundChild(plan.baseParams, plan.label);
  }
  return executeChildAgent(plan.baseParams);
}

async function executeAgentToolRequest(
  config: AgentToolConfig,
  input: unknown,
  context: ToolContext,
  checkGuard: AgentStatusCheckGuard,
): Promise<ToolResult> {
  const raw = parseAgentToolInput(input);
  const normalizedIntent = normalizeAgentToolIntentInput(raw);
  if (normalizedIntent.intent === 'wait' && normalizedIntent.waitAgentIds) {
    return buildWaitForSubagentsResult(
      config,
      normalizedIntent.waitAgentIds,
      context.toolUseId ?? `wait:${context.agentRunId ?? context.threadId}`,
    );
  }
  const checkId = normalizedIntent.checkAgentId;
  if (normalizedIntent.intent === 'check' && checkId) {
    if (!checkGuard.claim(context.agentRunId, checkId)) {
      const cooldownSec = Math.round(CHECK_AGENT_STATUS_COOLDOWN_MS / 1000);
      return {
        content:
          `距上次查询该子 Agent（ID: ${checkId}）不足 ${cooldownSec} 秒，请稍后再查或沿用上次结果；` +
          `若必须等待它结束，请改用 wait_agent_ids=["${checkId}"]，不要用 check 代替等待。`,
        isError: true,
        presentation: buildSubagentStatusCheckPresentation(checkId, 'already_checked'),
      };
    }
    return await buildCheckAgentStatusResult(config, checkId);
  }
  const messageId = normalizeAgentToolString(raw.message_agent_id);
  if (messageId) {
    if (
      normalizeAgentToolString(raw.resume_agent_id)
      || raw.interrupt === true
    ) {
      return {
        content: 'Error: message_agent_id 不能与 resume_agent_id / interrupt 同时使用',
        isError: true,
      };
    }
    const text = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
    if (!text) {
      return {
        content: 'Error: message_agent_id 需要非空 prompt 作为指引内容',
        isError: true,
      };
    }
    const injectResult = config.subagentManager?.injectUserMessage(messageId, text);
    if (!injectResult?.ok) {
      return {
        content: `无法向子 Agent 插话：${injectResult?.reason ?? 'no manager'}`,
        isError: true,
      };
    }
    return {
      content: `已向运行中的子 Agent（${messageId.slice(0, 8)}…）投递指引，将在其下一轮生效。`,
    };
  }
  const requestOrError = validateAgentPrompt(raw);
  if ('content' in requestOrError) return requestOrError;
  const depthError = validateSubagentDepth(context);
  if (depthError) return depthError;
  const interruptResolution = await resolveInterruptRedirect(
    config,
    normalizedIntent.resumeAgentId,
    raw.interrupt,
  );
  if (interruptResolution.result) return interruptResolution.result;
  const plan = await buildSpawnPlan({
    config,
    context,
    request: requestOrError,
    resumeChildId: interruptResolution.resumeChildId,
  });
  if ('content' in plan) return plan;
  return executeSpawnPlan(config, context, plan);
}

// ─── Factory ────────────────────────────────────────────────────────

interface AgentStatusCheckGuard {
  claim(agentRunId: string | undefined, childId: string): boolean;
}

const MAX_TRACKED_CHECK_RUNS = 64;

/**
 * ：同一父 run 内对同一子 ID 的 check 最短间隔。
 * 允许主 Agent 自主复查，同时抑制 tight-loop 轮询。
 */
export const CHECK_AGENT_STATUS_COOLDOWN_MS = 15_000;

/** @internal exported for unit tests */
export function createAgentStatusCheckGuard(
  now: () => number = () => Date.now(),
): AgentStatusCheckGuard {
  const lastCheckAtByRun = new Map<string, Map<string, number>>();
  return {
    claim(agentRunId, childId) {
      // legacy host / unit stub 没有 per-run ID 时不施加跨调用约束，避免错误地把整个
      // session 当成一轮；生产 ToolContext 始终带 agentRunId。
      if (!agentRunId) return true;
      let byChild = lastCheckAtByRun.get(agentRunId);
      if (!byChild) {
        if (lastCheckAtByRun.size >= MAX_TRACKED_CHECK_RUNS) {
          const oldestRunId = lastCheckAtByRun.keys().next().value as string | undefined;
          if (oldestRunId) lastCheckAtByRun.delete(oldestRunId);
        }
        byChild = new Map<string, number>();
        lastCheckAtByRun.set(agentRunId, byChild);
      }
      const nowMs = now();
      const last = byChild.get(childId);
      if (last != null && nowMs - last < CHECK_AGENT_STATUS_COOLDOWN_MS) {
        return false;
      }
      byChild.set(childId, nowMs);
      return true;
    },
  };
}

export function createAgentTool(config: AgentToolConfig): Tool {
  // Phase 4：把宿主注入的「可用模型菜单」渲染成清单段，拼到工具 description
  // 末尾（系统 prompt 的一部分 → prompt cache 友好）。无目录时返回 ''，不影响
  // 现有 description（兼容旧 host / 测试）。
  const modelCatalogMenu = config.subagentModelPolicy
    ? ''
    : renderModelCatalogMenu(config.modelCatalog);
  const modelPolicyHint = config.subagentModelPolicy
    ? '\n- 子 Agent 模型由当前默认策略决定；普通调用无需填写 model，模板可显式覆盖。'
    : '';
  const inputSchema = config.subagentModelPolicy
    ? {
        ...agentInputSchema,
        properties: {
          ...agentInputSchema.properties,
          model: {
            type: 'string',
            description: '仅由子 Agent 模板展开；普通调用无需填写，运行时会执行当前默认策略。',
          },
        },
      }
    : agentInputSchema;
  const checkGuard = createAgentStatusCheckGuard();
  return {
    name: AGENT_TOOL_NAME,
    policyActionKind: 'object_read',
    // fork 决策属于 system prompt 的编排策略；工具描述只保留当前调用必须知道的
    // 上下文隔离与参数协议，避免两处规则随版本演进再次漂移。
    description:
      '启动一个子 Agent 独立处理某个任务。' +
      '默认子 Agent 看不到父对话历史，只看你在 prompt 里写的内容；需要完整继承时显式设 `fork_context:true`。自己调工具，返回一条摘要。\n\n' +
      '用法：\n' +
      '- 完成后返回带 [子 Agent ID: xxx]。\n' +
      '- 续跑：`resume_agent_id`（不保留旧 tool 结果；readonly/model/tool_domains 须重传）。\n' +
      '- 后台：`background: true` 立刻拿 ID；无其它工作时别开后台。等终态用一次 `wait_agent_ids`。\n' +
      '- 结构化结果：`report_schema:"findings"` 要求先输出发现/证据/置信度 JSON 代码块。\n' +
      '- 查进度：`check_agent_id`（可自主，短间隔节流）；插话：`message_agent_id`+prompt；' +
      '中断重定向：`interrupt`+`resume_agent_id`。' + modelPolicyHint +
      modelCatalogMenu,
    inputSchema: inputSchema as unknown as Tool['inputSchema'],
    isReadOnly: false,
    concurrencySafe: true,
    // ── Outer-vs-inner timeout 分叉根治（W-H① / 2026-05-30）────────────
    // 背景：tool-orchestration 的外层墙钟（`DEFAULT_TIMEOUT_MS=60_000` 或工具
    // 声明的 executionTimeoutMs）从「工具派发时刻」起算——对普通工具没问题，
    // 但 agent 子 Agent 工具在 fan-out 大时会先排队（D3 队列），排队期间 LLM
    // 一点没跑。若外层墙钟把排队时间也算进去，排队久的子会被外层 TOOL_TIMEOUT
    // 冤杀，违背 D3a「排队不计入超时」。
    //
    // 早先两版都不对：
    //   - 完全不声明 → 外层 60s 兜底从派发时刻起算，子 Agent 跑 read_file 时
    //     被外层 60s abort（dogfood 314d7f23 agent:16）。
    //   - 声明 `DEFAULT_CHILD_TIMEOUT_MS + 1s`（301s）→ 阈值对了但**仍从派发
    //     时刻起算**：排队 250s + 跑 60s = 310s > 301s → 排队子照样冤杀。
    //
    // 根治：声明「极大值」`AGENT_TOOL_OUTER_TIMEOUT_BACKSTOP_MS`（24h），让外层
    // 墙钟在任何真实排队与执行窗口内都不会成为产品级停止条件。子 Agent 缺省不设
    // 激活后的执行时限；只有 host 显式注入 `childTimeoutMs` 时，内层
    // `timeoutController` 才从 activation 起算，排队期间不计时。
    //
    // 为什么不用 `Infinity`：保留外层这层有限兜底，万一 forkQuery generator
    // 无法 settle，orchestration 的 `Promise.race` 仍能在 24h 后
    // reject 解锁父 turn，不至于永久挂起（plan「别引入永不超时」）。详见
    // AGENT_TOOL_OUTER_TIMEOUT_BACKSTOP_MS 常量 JSDoc。
    executionTimeoutMs: AGENT_TOOL_OUTER_TIMEOUT_BACKSTOP_MS,

    resolvePresentation(input: unknown): ToolPresentation | undefined {
      const normalized = normalizeAgentToolIntentInput(parseAgentToolInput(input));
      if (normalized.intent === 'wait' && normalized.waitAgentIds) {
        return buildSubagentWaitPresentation(normalized.waitAgentIds, 'waiting');
      }
      if (normalized.intent === 'check' && normalized.checkAgentId) {
        return buildSubagentStatusCheckPresentation(normalized.checkAgentId, 'checking');
      }
      return undefined;
    },

    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
      return executeAgentToolRequest(config, input, context, checkGuard);
    },
  };
}

// ─── Speaker display name ───────────────────────────────────────────

function buildSpeakerDisplayName(
  source: SpeakerIdentity['source'],
  label: string,
  childId: string,
  _templateId?: string,
): string {
  const shortId = childId.slice(0, 4);
  const taskHint = label.slice(0, 15);
  if (label.includes(shortId)) return label;
  return `${taskHint} · ${shortId}`;
}

// ─── Filtered tool provider helper ───────────────────────────────────

/**
 * 按白名单（可选）+ 黑名单（可选）过滤父工具集，得到子 Agent 工具集。
 *
 * - `allowedNames` 非空 → 只保留其中的工具（白名单）；空 / undefined → 不加白名单。
 * - `deniedNames` 非空 → 从结果里再剔除这些工具（黑名单，优先于白名单）。
 * - 二者都为空 → 返回 undefined，调用方回落「继承父全量工具」（行为不变）。
 *
 * ：模板的 allowed_tools / denied_tools 与显式 tool_domains 都经此收口。
 */
function buildScopedToolProvider(
  parentTools: ToolProvider,
  allowedNames: string[] | undefined,
  deniedNames: string[] | undefined,
): ToolProvider | undefined {
  const hasAllow = Array.isArray(allowedNames);
  const hasDeny = !!deniedNames?.length;
  if (!hasAllow && !hasDeny) return undefined;
  const allowed = hasAllow ? new Set(allowedNames) : undefined;
  const denied = hasDeny ? new Set(deniedNames) : undefined;
  return {
    getTools: () =>
      parentTools.getTools().filter(
        (t) => (!allowed || allowed.has(t.name)) && (!denied || !denied.has(t.name)),
      ),
  };
}
