/**
 * Agent Mode 类型定义
 *
 * `AgentModeName` 与 Django 端 `apps.services.agent_engine.agent_mode.AgentModeName`
 * 严格对齐，六个值由产品定义（ChatInput 模式选择器）：
 *   - ask    问答模式：只读 + 不写 todo
 *   - agent  执行模式（默认）：所有工具
 *   - plan   规划模式：只读 + 计划工具，需用户审批后切回 agent
 *   - study  学习模式：只读 + 教学创作（笔记/闪卡）
 *   - yolo   全自动执行模式：工具集同 agent；授权预设 full_auto（不打扰，红线 + 敏感 deny 仍生效）
 *   - group  PMO 模式：主 agent 作为项目管理者，调度子 agent
 *
 * 与 Django 的 `agent_mode.py` 中 `ALL_AGENT_MODES` 必须保持一致；
 * 双端同步通过 `agent-mode-contract.json` SSoT + 单元测试断言强制保证。
 *
 * SSoT 设计：`AGENT_MODE_NAMES` 是字面量元组 SSoT；`AgentModeName` 由其派生
 * （`typeof AGENT_MODE_NAMES[number]`），避免 union 与 array 字面量两处手写漂移。
 * 新增 mode 只需在 `AGENT_MODE_NAMES` 加一项，type / Set / 派生导出会自动联动。
 */

export const AGENT_MODE_NAMES = [
  'ask',
  'agent',
  'plan',
  'study',
  'yolo',
  'group',
] as const;

export type AgentModeName = (typeof AGENT_MODE_NAMES)[number];

/**
 * 用户实际可进入的 Agent 模式——模式选择器可选项 + `switch_mode` 可提议目标共用的单源。
 *
 * 从 `AGENT_MODE_NAMES` 排除两项：
 *   - `yolo`： 起「放手程度」改由授权策略（审批权限授权）承接，不再作为任务模式；
 *   - `study`：后端 contract 仍保留，UI 暂不暴露入口（模式选择器隐藏）。
 *
 * 谁用它：`AgentModeSelector` 渲染下拉项；`contract.ts` 的 `proposableTargets` 由它派生
 * （每个模式可提议切到「本集合 − 自身」，见 ）。改这里一处即同时影响两端，杜绝漂移。
 */
export const SELECTABLE_AGENT_MODES: readonly AgentModeName[] =
  AGENT_MODE_NAMES.filter((m) => m !== 'yolo' && m !== 'study');

const AGENT_MODE_NAME_SET = new Set<string>(AGENT_MODE_NAMES);

export function isAgentModeName(value: unknown): value is AgentModeName {
  return typeof value === 'string' && AGENT_MODE_NAME_SET.has(value);
}

export function resolveAgentModeName(
  value: unknown,
  fallback: AgentModeName = 'agent',
): AgentModeName {
  return isAgentModeName(value) ? value : fallback;
}

/**
 *  三档审批策略 SSoT。与 AgentMode 正交的第二维度：
 * AgentMode 管「做什么类型的事」（工具集 / prompt 段），ApprovalMode 管
 * 「多大程度放手」（judge 审批档）。
 *
 *   - `always_ask` 请求批准（默认）：工作区内自动，出界/敏感/破坏性 → ask
 *   - `auto`       替我审批（= 旧 yolo）：除风险红线 ask 外自动批
 *   - `full_access` 完全访问：仅灾难级命令 deny，其余放行
 *
 * wire `approval_mode` / IPC `approvalMode` / security-policy `ApprovalMode`
 * 均以本元组为单源；legacy `agent_mode='yolo'` 由 host 归一为 `'auto'`。
 */
export const APPROVAL_MODE_NAMES = [
  'always_ask',
  'auto',
  'full_access',
] as const;

export type ApprovalModeName = (typeof APPROVAL_MODE_NAMES)[number];

const APPROVAL_MODE_NAME_SET = new Set<string>(APPROVAL_MODE_NAMES);

export function isApprovalModeName(value: unknown): value is ApprovalModeName {
  return typeof value === 'string' && APPROVAL_MODE_NAME_SET.has(value);
}

export function resolveApprovalModeName(
  value: unknown,
  fallback: ApprovalModeName = 'always_ask',
): ApprovalModeName {
  return isApprovalModeName(value) ? value : fallback;
}

/**
 * 工具过滤策略：
 *
 * - `all`    — 所有工具可用（agent / group 模式默认）
 * - `restricted` — 按 allow / deny 列表 + isReadOnly 默认值过滤（plan / ask / study 等）
 *
 * `restricted` 策略的解析逻辑（与 `agent-mode-contract.json` 字面量对齐）：
 *   1. 工具名出现在 `denyToolNames` → 拒绝
 *   2. 工具名出现在 `allowToolNames` → 允许（即使 isReadOnly=false）
 *   3. 否则按 `defaultAllowReadOnly` 决定是否允许（true 时只读工具默认放行）
 */
export type AgentModeToolPolicyKind = 'all' | 'restricted';

export interface AgentModeToolPolicy {
  kind: AgentModeToolPolicyKind;
  /** 显式允许的工具名（绕过 isReadOnly 默认） */
  allowToolNames: readonly string[];
  /** 显式拒绝的工具名（即使 isReadOnly=true 也拒绝） */
  denyToolNames: readonly string[];
  /**
   * `restricted` 策略下，未在 allow/deny 列出的工具是否依据 `isReadOnly === true` 默认放行。
   * `all` 策略下被忽略。
   */
  defaultAllowReadOnly: boolean;
  /** MCP 工具特殊处理：`mcp_*` 前缀工具是否允许（用于一键收紧 MCP 写工具）。 */
  mcpReadOnlyOnly: boolean;
  /**
   * **L16 修复（2026-05-04 W5.5）**：受限模式下 `run_terminal_command` 的 input 级白名单。
   *
   * 与 `denyToolNames`/`allowToolNames` 的"工具名级"过滤不同，本字段控制 `run_terminal_command`
   * **被允许调用的命令字符串形态**——即使 `run_terminal_command` 工具本身可见，只有命令
   * 满足白名单形态才会真正执行。设计意图：
   *
   *   - **业务能力走 CLI** 是宪法不变量 2 的硬约束；Plan/Ask/Study 受限模式需要让 LLM
   *     仍能调 `tabtin doc list --format json` 等只读 CLI 查询业务对象，否则受限模式就
   *     完全没有业务能力。
   *   - 但不能放行 `tabtin doc create` 等写命令，否则受限模式语义被架空。
   *   - "工具名级"过滤无法表达"同一工具但部分 input 拒绝"——所以用 input 级。
   *
   * 取值：
   *   - `'tabtin-readonly'`：仅允许 `tabtin <subcmd>`（含 `cd <dir> && tabtin ...` 复合形态），
   *     且对应 CLI 命令的 `Risk` 字段为 `RiskNone`（空字符串）。Risk 由 `tabtin commands --format json`
   *     的 schema 自描述提供（详见 `packages/tabtin-cli-go/internal/cmdutil/command_def.go`）。
   *   - `undefined`：不应用 input 级白名单（agent / group 模式默认不限制）。
   *
   * **执行位置**：`packages/agent-runtime/src/capability/core/shell.ts` 在 `_executeCommandTool().execute`
   * 入口判断；checker 由宿主装配时按 `restrictedShellChecker` 注入。
   */
  restrictedShellAllowlist?: 'tabtin-readonly' | undefined;
}

export interface AgentModeMetadata {
  name: AgentModeName;
  /** 用户可见标签（中文）；前端用 i18n key 优先于此字段。 */
  label: string;
  /** 设计语义（用于文档与 telemetry 标注）。 */
  description: string;
  /**
   * 该模式对应的授权预设（与 Django agent_mode.py 对齐）。
   *
   * - `cautious`       — Ask / Plan：保守预设，写操作走最严审批
   * - `collaborative`  — Agent / Study / Group：默认协作预设
   * - `full_auto`      — Yolo（PR1 新增）：daemon 路径下激活 sandbox `full_auto` preset；
   *                       同时驱动 PR2 的 judge.ts step3 改造（受 Agent 级 gate + group 互斥）
   */
  authorizationPreset: 'cautious' | 'collaborative' | 'full_auto';
  /** 是否跳过通用 <execution> 段（plan/ask/study/group 都跳过）。 */
  skipExecutionSection: boolean;
}

export interface AgentModeConfig {
  metadata: AgentModeMetadata;
  toolPolicy: AgentModeToolPolicy;
  /**
   * Plan/Ask/Study/Group 模式注入到 system prompt 的额外段落（XML 包裹）。
   * 'agent' 模式默认无额外段。
   */
  promptSection: string | null;
  /**
   * 本模式下 Agent 可以「提议切换到」的目标模式白名单（机制与策略分离）。
   *
   * `switch_mode` 工具是通用的「提议切模式」机制，能切到哪些模式完全由这份白名单
   * 决定，而不再在工具/wire/卡片里硬编码方向：
   *   - 非空 → 该模式注册 `switch_mode`，其 `target_mode_id` 枚举 = 本数组；
   *   - 空数组 → 该模式不提供 `switch_mode`（模型无法提议切换）。
   *
   * ⚠️ **本字段是本地 runtime（桌面客户端）专属**，故意**不进** serializeAgentModeContract
   * 的跨端 JSON——Django lightweight 路径按 D10 根本不实现 switch_mode，无需镜像。
   *
   * 当前策略：任意模式都可提议切到 `SELECTABLE_AGENT_MODES` 里除自身
   * 外的全部模式（ask/agent/plan/group），不再限制方向。派生逻辑集中在
   * `contract.ts` 的 `proposableTargetsFor`，与模式选择器共用 `SELECTABLE_AGENT_MODES` 单源。
   */
  proposableTargets: readonly AgentModeName[];
}
