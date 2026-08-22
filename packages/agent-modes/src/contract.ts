/**
 * Agent Mode Contract — TypeScript SSoT for the cross-runtime mode → tools matrix.
 *
 * 这份文件是本地 Runtime 端的真实数据源。Django 端通过 `agent_mode_contract.json`
 * （由本文件序列化生成，commit 进 git）镜像同一份配置，并通过单元测试断言两端一致。
 *
 * 修改本文件后**必须**同步更新 `packages/agent-runtime/agent-mode-contract.json`，
 * 否则 `tests/agent-modes-contract.test.ts` 会失败。CI 强制保护。
 */

import type {
  AgentModeConfig,
  AgentModeMetadata,
  AgentModeName,
  AgentModeToolPolicy,
} from './types.js';
import { AGENT_MODE_NAMES, SELECTABLE_AGENT_MODES } from './types.js';
import {
  AGENT_MODE_PROMPT_SECTIONS,
  SECTION_AGENT_MODE_AGENT,
} from './prompt-sections.js';

// ─── 工具白名单 ──────────────────────────────────────────────────────
//
// 名字采用现有本地 Runtime 工具的 `name` 字段。Plan 系列工具尚未实现（W1-C / W2-A
// 才落地），但提前在 allow 列表里登记 — 后续注册到 ToolProvider 时不需要再改这份
// 配置。Plan 工具未注册前不会出现在 ToolProvider.getTools() 里，过滤函数会自动跳过。

/** 所有模式都允许的核心交互工具（最小集）。 */
//
// 2026-04-30 dogfood P0 改名复盘新增 `show_widget`：
// show_widget 是 LLM 视觉输出通道（chat 内联可视化 SVG / Mermaid / HTML），
// 跟 `present_to_user` 同类——用户在 ask/plan/study 模式下问"画一个 X" 时，
// Agent 应该能调它出图，而不是退化为纯文字描述。
// 之前因 `isReadOnly: false`（preStart 防御 OSS 烤图副作用所必需）走不到
// `defaultAllowReadOnly` 默认放行路径，被 contract 静默拒绝；漂移基线里
// `('show_widget', ask|plan|study)` 三条预存漂移就是这个 bug 的痕迹。
// 显式加进 SHARED_CORE_TOOLS 让所有受限模式都能调到，对齐 Django 主流程
// `available_modes=None`（全模式可见）的语义。
//
// 2026-05-10 Wave 4.5：移除 `think` 工具——模型应使
// 用原生 thinking block 进行内省；外化 think 工具会双倍 context 成本并诱
// 导高频调用。
//
// 2026-05-11 W4：原 `ask_choice` 由 `ask_user` 替代（multi-choice + 自动 Other
// 选项 + 1-4 题分组 + dedup）。
// 2026-05-11 W4 R3：dogfood 复盘后保留 `ask_form`（多字段填表）。
// 2026-07-08 ：下架 `request_approval`——其批准结果只是文本回流、不授予权限，
// 后续工具调用仍触发系统拦截（judge 管线），造成同一动作双重审批。高危动作
// 安全兜底由系统拦截承担；意图级确认由 ask_user / 纯文本承接。
// 按场景选用：
//   - ask_user: 提问 + 选选项（multi-choice，含 Other 自动注入）
//   - ask_form: 让用户填多个具体字段（schema 化的填表）
const SHARED_CORE_TOOLS = [
  'ask_user',
  'ask_form',
  'show_widget',
] as const;

/** Plan 系列工具名。提前在白名单中登记。 */
//
// 命名约束：必须匹配 LLM 上游正则 `^[a-zA-Z0-9_-]{1,64}$`（不允许点号）。
// `plan_exit` 已移除（产品上线前重构）：LLM 不再持有「自己宣告 plan 完成请审批」
// 的工具；执行由用户点击 PlanProposalCard 完成，参见
// `packages/agent-runtime/src/tools/plan-tools.ts` 顶部注释。
const PLAN_FAMILY_TOOLS = [
  'plan_create',
  'plan_update_todos',
] as const;

/**
 * 通用「提议切模式」工具。 起任意模式都可提议切到其余用户可达模式，
 * 故受限模式（plan/ask/study）的 toolPolicy 都显式放行它；实际可提议的目标由
 * 各模式 `proposableTargets` 决定（见下方 AGENT_MODE_CONFIGS）。
 */
const SWITCH_MODE_TOOL = 'switch_mode' as const;

/**
 * 显式禁止的写工具名（适用 Plan / Ask / Study）。
 *
 * `mcp_call_tool` 在工具元数据上是 `isReadOnly=false`，按 readOnly 默认
 * 也会被排除，但显式列出可以让审计日志和测试断言更清晰，避免未来某个工具误把
 * `isReadOnly` 改成 true 导致悄悄被放行。
 */
const WRITE_TOOLS_DENYLIST = [
  // **L16 修复（2026-05-04 W5.5）**：`run_terminal_command` 不再整体拒绝。
  // 受限模式（plan/ask/study）通过 `restrictedShellAllowlist: 'tabtin-readonly'`
  // 在工具内做 input 级过滤——tabtin 只读子命令放行，写命令拒绝。
  // 这是宪法不变量 2（业务能力走 CLI）与受限模式权衡后的产品决策（方案 A）。
  'mcp_call_tool',
  // D12.1（2026-05-28）：`agent` 保留在 denylist（plan/study 默认拒）；
  // ASK_MODE_POLICY 从 deny 剔除 + 加入 allow，evaluate 层再强制 readonly: true。
  // ask 模式允许 `agent(readonly: true)` 派 readonly 子 Agent。
  'agent',
  'write_file',
  'edit_file',
  'delete_file',
  'save_attachment',
  // 命名约束（dogfood P0 修复 2026-04-30）：旧名 `tabdoc.update_document` 是
  // 死字符串——本地 Runtime 真实工具是 `tabdoc_update_document`（下划线）；
  // Django 端工具改名后也是 snake_case。两端统一这一个名字。
  'tabdoc_update_document',
  // ── Phase 1 P1-2 修复（2026-05-27）：显式补全 ──
  //
  // **背景**：之前很多 isReadOnly=false 的写工具不在 denylist，靠"不在 allow +
  // 默认 deny"兜底。一旦谁手滑改 isReadOnly=true 或为了 preStartedTools 池
  // 而误标，就会被静默放行。显式列出让审计 + grep 友好，避免 dogfood "skill_create
  // 在 ask 模式偶然能跑"这种事。
  //
  // grep 全仓库 `isReadOnly: false` 的工具 → 对照原 denylist → 漏的补上：
  'skill_create',           // 写 .tabtin/skills/<slug>.md 真文件
  'memory_write',           // 写跨 session 持久化记忆
  'memory_delete',          // 软删记忆（用户可恢复但仍是状态变更）
  'tabdoc_replace_content', // 在 PLAN_TARGET_GUARDED_TOOLS 里，target 不匹配时应当被 mode 默认 deny 兜底；
                            // 显式列入 denylist 保证 ask 模式从不放行（与 tabdoc_update_document 同款）。
  // W4 R2 (P2-9, 2026-05-11): summarize_context / retrieve_tool_result / tool_search
  // 已清理——W3 删工具后这里"显式 deny"也是冗余债务（工具不存在时 deny 没意义，
  // 默认 default_deny 已 cover）。alias 表已从 tool-system.ts 删，无回归路径。
] as const;

const ALL_MODE_POLICY: AgentModeToolPolicy = {
  kind: 'all',
  allowToolNames: [],
  denyToolNames: [],
  defaultAllowReadOnly: true,
  mcpReadOnlyOnly: false,
};

const PLAN_MODE_POLICY: AgentModeToolPolicy = {
  kind: 'restricted',
  allowToolNames: [
    ...SHARED_CORE_TOOLS,
    'todo_write',
    ...PLAN_FAMILY_TOOLS,
    SWITCH_MODE_TOOL,
    // L16 W5.5：让 `run_terminal_command` 进入工具列表（绕过 isReadOnly=false 的默认排除）。
    // 实际可执行命令由 `restrictedShellAllowlist: 'tabtin-readonly'` 在 shell.ts 入口做 input 级过滤。
    'run_terminal_command',
  ],
  denyToolNames: [...WRITE_TOOLS_DENYLIST],
  defaultAllowReadOnly: true,
  mcpReadOnlyOnly: true,
  restrictedShellAllowlist: 'tabtin-readonly',
};

// D12.1（2026-05-28）：Ask 模式允许 `agent(readonly: true)` 派 readonly 子 Agent
// （ask 模式 Task readonly）。contract 放行 `agent` 进 allow 列表；
// `evaluateAgentModeToolAccess` 在 input 层强制 readonly: true，非 readonly fork 仍拒。
// 仅改 ASK_MODE_POLICY；plan/study 仍靠 guard 层 input-aware 分支，不在 contract 放行。
const ASK_MODE_POLICY: AgentModeToolPolicy = {
  kind: 'restricted',
  allowToolNames: [
    ...SHARED_CORE_TOOLS,
    'run_terminal_command',
    'agent',
    // ：ask 可提议切到 plan（proposableTargets: ['plan']）——工具本身
    // 只读（emit 提案 + 等审批，不直接改 mode），受限模式需显式放行。
    SWITCH_MODE_TOOL,
  ],
  denyToolNames: [
    ...WRITE_TOOLS_DENYLIST.filter((t) => t !== 'agent'),
    'todo_write',
    ...PLAN_FAMILY_TOOLS,
  ],
  defaultAllowReadOnly: true,
  mcpReadOnlyOnly: true,
  restrictedShellAllowlist: 'tabtin-readonly',
};

const STUDY_MODE_POLICY: AgentModeToolPolicy = {
  kind: 'restricted',
  allowToolNames: [
    ...SHARED_CORE_TOOLS,
    'todo_write',
    ...PLAN_FAMILY_TOOLS,
    'present_to_user',
    'run_terminal_command',
    // ：study 可提议切到 plan（proposableTargets: ['plan']）。
    SWITCH_MODE_TOOL,
  ],
  denyToolNames: [...WRITE_TOOLS_DENYLIST],
  defaultAllowReadOnly: true,
  mcpReadOnlyOnly: true,
  restrictedShellAllowlist: 'tabtin-readonly',
};

const GROUP_MODE_POLICY: AgentModeToolPolicy = {
  kind: 'all',
  allowToolNames: [],
  denyToolNames: [],
  defaultAllowReadOnly: true,
  mcpReadOnlyOnly: false,
};

// ─── 元数据 ──────────────────────────────────────────────────────────

const ASK_METADATA: AgentModeMetadata = {
  name: 'ask',
  label: '问答 (Ask)',
  description: '只读问答与分析；不允许任何修改类操作。',
  authorizationPreset: 'cautious',
  skipExecutionSection: true,
};

const AGENT_METADATA: AgentModeMetadata = {
  name: 'agent',
  label: '执行 (Agent)',
  description: '默认执行模式；所有工具可用，按授权预设审批写操作。',
  authorizationPreset: 'collaborative',
  skipExecutionSection: false,
};

const PLAN_METADATA: AgentModeMetadata = {
  name: 'plan',
  label: '规划 (Plan)',
  description: '只读规划模式；产出结构化方案，由用户审批后切换 Agent 执行。',
  authorizationPreset: 'cautious',
  skipExecutionSection: true,
};

const STUDY_METADATA: AgentModeMetadata = {
  name: 'study',
  label: '学习 (Study)',
  description: '教学模式；以教会用户为目标，允许创建学习材料但禁止破坏性写操作。',
  authorizationPreset: 'collaborative',
  skipExecutionSection: true,
};

const GROUP_METADATA: AgentModeMetadata = {
  name: 'group',
  label: 'PMO',
  description: '以项目管理者身份拆解任务、跟进进度，并调度子 Agent 协作完成。',
  authorizationPreset: 'collaborative',
  skipExecutionSection: true,
};

// PR1 (2026-05-18) — Yolo 模式：
//   工具集复用 `ALL_MODE_POLICY`（同 agent / group，由 ALL_MODE_POLICY 单例提供）。
//   授权预设 `full_auto`：
//     - Daemon 路径下激活 sandbox `full_auto` preset（派生改造见 PR0/PR2）
//     - Electron 本地 runtime 由 PR2 judge.ts step3 实施 ask→allow 旁路
//   `skipExecutionSection: false` 与 agent 对齐——yolo 仍以执行模式工作，不走受限模式
//   的额外 prompt section。`promptSection` 因此为 null（同 agent，无 yolo.md）。
//   yolo 的 Agent 级 gate / group 互斥 / 工具放行（judge.ts）由后续 PR2/PR3 落实。
const YOLO_METADATA: AgentModeMetadata = {
  name: 'yolo',
  label: '全自动 (Yolo)',
  description:
    '全自动执行模式；工具集同 agent，授权预设 full_auto（不打扰干活，红线与敏感 deny 仍生效）。',
  authorizationPreset: 'full_auto',
  skipExecutionSection: false,
};

// ─── 整体 Contract ───────────────────────────────────────────────────

// ─── 模式切换提议目标（机制与策略分离，本地 runtime 专属，不进跨端契约） ──
//
// `switch_mode` 是通用「提议切模式」机制；能切到哪些由 `proposableTargets` 说了算。
//
// 策略：**任意模式都可提议切到其余任意用户可达模式**——不再限制方向。
// 之前只开 `plan↔agent`导致用户口头要求切 group 时 LLM 无正当目标可提，
// 只能歪填 plan、给出「切换失败但又执行」的矛盾反馈。放开后 switch_mode 工具的
// `target_mode_id` 枚举会自动列出全部可达目标，LLM 按用户诉求正确提案。
//
// 「可达目标」= `SELECTABLE_AGENT_MODES`（ask/agent/plan/group；yolo 已由授权策略承接、
// study UI 暂隐，见 types.ts），与模式选择器共用同一单源。每个模式可提议切到「该集合 − 自身」。
//
// 整条管线（工具 enum / 校验 / 审批卡文案 / host 热切换）本就 target 无关，改这里即可；
// 受限模式（plan/ask/study）的 toolPolicy 已显式放行 switch_mode，无需再动。
const proposableTargetsFor = (self: AgentModeName): readonly AgentModeName[] =>
  SELECTABLE_AGENT_MODES.filter((mode) => mode !== self);

export const AGENT_MODE_CONFIGS: Readonly<Record<AgentModeName, AgentModeConfig>> =
  {
    ask: {
      metadata: ASK_METADATA,
      toolPolicy: ASK_MODE_POLICY,
      promptSection: AGENT_MODE_PROMPT_SECTIONS.ask,
      proposableTargets: proposableTargetsFor('ask'),
    },
    agent: {
      metadata: AGENT_METADATA,
      toolPolicy: ALL_MODE_POLICY,
      promptSection: SECTION_AGENT_MODE_AGENT,
      proposableTargets: proposableTargetsFor('agent'),
    },
    plan: {
      metadata: PLAN_METADATA,
      toolPolicy: PLAN_MODE_POLICY,
      promptSection: AGENT_MODE_PROMPT_SECTIONS.plan,
      proposableTargets: proposableTargetsFor('plan'),
    },
    study: {
      metadata: STUDY_METADATA,
      toolPolicy: STUDY_MODE_POLICY,
      promptSection: AGENT_MODE_PROMPT_SECTIONS.study,
      proposableTargets: proposableTargetsFor('study'),
    },
    yolo: {
      metadata: YOLO_METADATA,
      // PR1：直接复用 ALL_MODE_POLICY 单例（同 agent / group）。
      // 严禁新建 `YOLO_MODE_POLICY` —— 工具集语义和 agent / group 完全一致，
      // 差异只在 authorizationPreset。
      toolPolicy: ALL_MODE_POLICY,
      // 同 agent，不注入额外 prompt section（AGENT_MODE_PROMPT_SECTIONS.yolo === null）
      promptSection: AGENT_MODE_PROMPT_SECTIONS.yolo,
      proposableTargets: proposableTargetsFor('yolo'),
    },
    group: {
      metadata: GROUP_METADATA,
      toolPolicy: GROUP_MODE_POLICY,
      promptSection: AGENT_MODE_PROMPT_SECTIONS.group,
      proposableTargets: proposableTargetsFor('group'),
    },
  };

export function getAgentModeConfig(mode: AgentModeName): AgentModeConfig {
  return AGENT_MODE_CONFIGS[mode];
}

/**
 * 本模式下 Agent 可提议切换到的目标模式白名单（空 = 不提供 switch_mode）。
 * 工具注册 / 工具 enum / 卡片方向都以本函数为准，杜绝硬编码方向。
 */
export function getProposableModeTargets(
  mode: AgentModeName,
): readonly AgentModeName[] {
  return AGENT_MODE_CONFIGS[mode].proposableTargets;
}

// ─── JSON Contract Shape (for cross-runtime sync) ────────────────────
//
// 序列化 shape — Django 端 `agent_mode_contract.py` 直接 json.load() 这份结构。
// 字段命名采用 snake_case 以贴近 Python 风格，避免 Django 端做额外转换。
// 修改本结构必须同步：
//   1. `packages/agent-runtime/agent-mode-contract.json` 重新导出
//   2. `apps/tabtin_django/apps/services/agent_engine/agent_mode_contract.py` 反序列化
//   3. 双端测试断言 round-trip 一致

export interface SerializedAgentModeToolPolicy {
  kind: 'all' | 'restricted';
  allow_tool_names: string[];
  deny_tool_names: string[];
  default_allow_read_only: boolean;
  mcp_read_only_only: boolean;
  /**
   * L16 W5.5：受限模式 input 级 shell 白名单。omit / null 表示不应用（agent/group）。
   * 序列化时只在显式设置时输出，避免对未消费此字段的旧 reader 造成漂移。
   */
  restricted_shell_allowlist?: 'tabtin-readonly';
}

export interface SerializedAgentModeMetadata {
  name: AgentModeName;
  label: string;
  description: string;
  // PR1 (2026-05-18)：扩展为三档；`full_auto` 仅 yolo 档使用。Daemon 端 sandbox_policy
  // 派生 / Electron 端 judge.ts step3 都依据此字段做分支。
  authorization_preset: 'cautious' | 'collaborative' | 'full_auto';
  skip_execution_section: boolean;
}

export interface SerializedAgentModeConfig {
  metadata: SerializedAgentModeMetadata;
  tool_policy: SerializedAgentModeToolPolicy;
  /** 是否注入 prompt section（boolean，避免 JSON 中携带大段提示词文本）。 */
  has_prompt_section: boolean;
}

export interface SerializedAgentModeContract {
  /** Contract 版本号；Django 端校验时若版本不一致直接拒绝。 */
  version: number;
  modes: AgentModeName[];
  configs: Record<AgentModeName, SerializedAgentModeConfig>;
}

/** Contract 当前版本号 — 任何 breaking change 必须 +1。 */
export const AGENT_MODE_CONTRACT_VERSION = 1;

/**
 * 把 TS SSoT 序列化为 JSON contract shape。
 * Django 端通过 `json.load()` + 类型化包装消费同样结构。
 */
export function serializeAgentModeContract(): SerializedAgentModeContract {
  const configs = {} as Record<AgentModeName, SerializedAgentModeConfig>;
  for (const name of AGENT_MODE_NAMES) {
    const cfg = AGENT_MODE_CONFIGS[name];
    configs[name] = {
      metadata: {
        name: cfg.metadata.name,
        label: cfg.metadata.label,
        description: cfg.metadata.description,
        authorization_preset: cfg.metadata.authorizationPreset,
        skip_execution_section: cfg.metadata.skipExecutionSection,
      },
      tool_policy: {
        kind: cfg.toolPolicy.kind,
        allow_tool_names: [...cfg.toolPolicy.allowToolNames],
        deny_tool_names: [...cfg.toolPolicy.denyToolNames],
        default_allow_read_only: cfg.toolPolicy.defaultAllowReadOnly,
        mcp_read_only_only: cfg.toolPolicy.mcpReadOnlyOnly,
        ...(cfg.toolPolicy.restrictedShellAllowlist
          ? { restricted_shell_allowlist: cfg.toolPolicy.restrictedShellAllowlist }
          : {}),
      },
      has_prompt_section: cfg.promptSection != null,
    };
  }
  return {
    version: AGENT_MODE_CONTRACT_VERSION,
    modes: [...AGENT_MODE_NAMES],
    configs,
  };
}
