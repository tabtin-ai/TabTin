/**
 * types-v3.ts — 授权策略 v3（"yolo + 工作区 + 红线 + 记忆"）的核心类型定义
 *
 *
 * 设计取舍：
 *   - 不复用旧 `types.ts` 的 `UnifiedSecurityPolicy` / `OperationSwitches` 等结构
 *     （它们是 v2 / W1A 的概念，本 wave 整体被替代）
 *   - 旧类型保留不动（W1 期间不破坏现有 import 链路），W2 开始陆续退役
 *   - 名字带 v3 后缀的（如 `AgentConfigV3`）是为了在过渡期跟旧 v2 schema 区分
 *
 * 与附录 D 的微小差异（本文件均加注释说明）：
 *   1. `MemoStore.lookup` 签名追加 `inWorkspace: boolean` 参数 —— specificity
 *      排序必须知道工作区命中状态，附录 D 字面 `lookup(toolName, subcmd, input)`
 *      会让实现方在 lookup 内部反推 inWorkspace（不可能，input 是不透明的）
 *   2. `JudgeContext.tool` 用本地最小 `JudgeTool` 接口而不是 `Tool & ToolPolicyMeta`
 *      —— 本包不依赖 `@tabtin/agent-runtime`（避免循环依赖），只声明 judge 实际
 *      用到的字段（name / policyActionKind / extractPath / extractSubcmd / isWriteOp）
 */

import type { PermissionBehavior as LegacyPermissionBehavior } from './types.js';

// ─────────────────────────────────────────────────────────────
// D.1 核心配置（Agent.agent_config 顶层 security 节）
// ─────────────────────────────────────────────────────────────

/**
 * 三档审批策略。字面量 SSoT 在
 * `@tabtin/agent-modes` 的 `APPROVAL_MODE_NAMES`（wire / IPC / renderer 共用）。
 *
 * - `always_ask`：请求批准（默认）——工作区内自动，出界/敏感/破坏性/MCP/设备 ask
 * - `auto`：替我审批——除灾难级红线外自动批，风险操作 ask
 * - `full_access`：完全访问——仅灾难级命令 deny，其余放行
 */
export type ApprovalMode = import('@tabtin/agent-modes').ApprovalModeName;

/** Agent 已授权的最高审批档位（就地升档确认后持久化）。 */
export type ApprovalGrant = ApprovalMode;

/**
 * Agent.agent_config.security 子树（DB 持久态）。
 *
 * v3 PRD §5.1.1（2026-05-19）：`allow_yolo_mode` 为 legacy gate；
 *  起以 `approval_grant` 记录已授权档位。`allow_yolo_mode=true` 读时
 * 等价 `approval_grant='auto'`。
 */
export interface AgentSecurityConfig {
  /** @deprecated 读兼容；新写入用 approval_grant */
  allow_yolo_mode?: boolean;
  approval_grant?: ApprovalGrant;
}

export interface AgentConfigV3 {
  schema_version: 3;
  runtime_plane: 'local' | 'cloud';
  security: AgentSecurityConfig;
  capabilities?: {
    overrides?: {
      cost?: {
        execution_limits?: {
          max_iterations_per_run?: number;
          max_credits_per_run?: number | string;
        };
      };
    };
  };
  conversation?: {
    cross_turn_memory?: boolean;
    max_history_messages?: number;
  };
  approval_memo?: ApprovalMemoSnapshot;
}

// ─────────────────────────────────────────────────────────────
// D.2 工作区
// ─────────────────────────────────────────────────────────────

export interface WorkspaceSources {
  /** 永久：Space sandbox 目录绝对路径（已 realpath）。平台兜底。 */
  sandbox: string;
  /**
   * Agent 工作目录绝对路径（= agent.working_dir，已 realpath）。
   *
   * 单根契约（见 `docs/single-root-space-prd.md` §2.1）：每个 Space 只有一个
   * 用户配置的执行根 = 该 Space 绑定 Agent 的 working_dir。空字符串
   * 表示 Agent 还没设置工作目录（此时 allowedPaths 只有 sandbox 兜底）。
   *
   * 取代了早期的 `tabcodeProjects` + `tabfolderDirs` 两个数组——TabTin 不再
   * 支持"在一个 Space 里挂载多个项目"。
   */
  workingDir: string;
  /**
   * Session 内通过 ApprovalPanel 审批通过的临时授权路径（已 realpath，去重）。
   *
   * 单根契约（见 `docs/single-root-space-prd.md` §2.4）：Agent 工具尝试访问
   * `working_dir` 子树**之外**的路径时，`path-access-checker` 拦截弹审批；
   * 用户点"允许"后路径加进这里，**当前 session 内**后续所有 fs/git/checkpoint
   * 等访问全部放行——一次审批，session 内持续可用。
   *
   * 不持久化、不进 store、不进 UI 列表。session 重启 / 切 Space / 切 Agent
   * 后失效，需要重新审批。
   */
  sessionApprovedPaths: string[];
  /** 当前对话气泡里的拖拽附件（文件级，已 realpath） */
  attachedFiles: string[];
}

export interface WorkspaceSnapshot {
  sources: WorkspaceSources;
  /** 合成视图：所有目录 = sandbox + workingDir + sessionApprovedPaths（已规范化，过滤过宽路径） */
  allowedPaths: readonly string[];
  /** 合成视图：所有附件文件（精确匹配） */
  allowedFiles: readonly string[];
  /** Space session 标识，生命周期内不变；session 重启时改变 */
  spaceSessionId: string;
}

// ─────────────────────────────────────────────────────────────
// D.3 Policy 快照（每轮 runTools 入口拍）
// ─────────────────────────────────────────────────────────────

export interface ExecutionLimitsV3 {
  max_iterations_per_run?: number;
  max_credits_per_run?: number;
}

export interface EffectivePolicy {
  /**
   * 本轮对话的有效审批档位（ 三档策略）。
   *
   * 由 `build-policy.ts` 从 `requestedApprovalMode` + `approval_grant` +
   * `isGroupSpace` + `unattended` 派生。与 AgentMode（ask/plan/agent…）正交。
   *
   * judge step 3：`auto` / `full_access` 旁路 ask；step 2.5：`auto`/`full_access`
   * 豁免 sensitive_in_ask；step 1：按档位区分 deny / ask / 放行。
   */
  approvalMode: ApprovalMode;
  workspace: WorkspaceSnapshot;
  /**
   * 记忆快照（注意是只读视图，judge 不直接改）。
   * - generation：单调递增，跨端同步用
   * - entries：key=`<tool>::<subcmd>:<scope>`（见附录 B / `pattern-key.ts`）
   */
  memo: {
    readonly generation: number;
    readonly entries: Readonly<Record<string, ApprovalMemoEntry>>;
  };
  /** 独立维度，不参与 judge，由调用方在 PermissionContext 里另行使用 */
  executionLimits: ExecutionLimitsV3;
  /** 由 agentMode 派生（plan 模式 = true）。judge 不直接消费，由 orchestration 在 judge 之前拦截 */
  planModeGuardActive: boolean;
}

// ─────────────────────────────────────────────────────────────
// D.4 判决结果
// ─────────────────────────────────────────────────────────────

/**
 * v3 对外暴露的三态决策。
 *
 * 与旧 `types.ts` 的 `PermissionBehavior` 关系：
 *   - 旧：四态 `'allow' | 'deny' | 'ask' | 'passthrough'`（pipeline 内部 layer 间传递语义）
 *   - 新：三态（passthrough 仅作为 judge 函数内部 step fallthrough，不对外）
 *
 * 用 `Exclude` 派生而不是新写联合，是为了让两者保持类型层面的子集关系，
 * 未来旧类型退役时改名一次即可。
 */
export type DecisionBehavior = Exclude<LegacyPermissionBehavior, 'passthrough'>;

/** 判决结果 */
export interface Decision {
  behavior: DecisionBehavior;
  reason: DecisionReason;
  /** 若要被 memo 记忆，使用这个 key（仅 ask 决策必填；allow / deny 可选） */
  approvalKey?: string;
  /** 给用户/Agent 看的人话；deny 必填，ask 推荐填，allow 可选 */
  userVisibleReason?: string;
  /** Agent 侧解析渲染的下一步建议 */
  resolutionHints?: ResolutionHint[];
}

/**
 * 判决原因（discriminated union）。
 *
 * 含 v0.3 新增：object_write_ask / device_observe_allow。
 *
 * `plan_blocked`（路径权限治理 W7 修正）：W7 把单点判决落到 judge() 内部 ——
 * 当 `policy.planModeGuardActive=true` + `tool.planTargetWriteGuarded=true`
 * 时 judge() 直接 deny 并 emit `plan_blocked`。
 *
 * **W7 / B1 后**：legacy plan-mode-guard pre-check 在 hasJudge=true 主路径下
 * 不跑（orchestration `if (!hasJudge)` pre-check 仅在 hasJudge=false 测试
 * 场景生效）。"target_field 细颗粒度校验"语义（譬如 `document_id === active_plan_id`）
 * 当前**已退役**——plan 流程走独立的 `plan_create` / `plan_update_todos`
 * 命令，不再经过 `tabdoc_update_document` 这条工具。如未来要复活该语义，
 * 应在 judge step 0 加 `policy.activePlanDocId` + `JudgeTool.planTargetField` 做 inline check。
 */
export type DecisionReason =
  | { type: 'hardline_command'; pattern: string }
  | { type: 'hardline_path'; pattern: string }
  | { type: 'sensitive_out_deny'; path: string; category: string }
  | { type: 'sensitive_in_ask'; path: string; category: string }
  // M4.1 L-W6-24 扩展：scope_description 携带记忆创建时的业务名（"总是允许推送代码"），
  // UI 优先展示，缺失时回退到 pattern_key（"run_terminal_command::git-push:exact:a4f3b2c1"）。
  | { type: 'memo_allow'; key: string; createdAt: string; specificity: MemoSpecificity; scope_description?: string }
  | { type: 'memo_deny'; key: string; createdAt: string; specificity: MemoSpecificity; scope_description?: string }
  | { type: 'yolo_allow' }
  /** ：替我审批档旁路（原 yolo_allow 语义） */
  | { type: 'auto_allow' }
  /** ：完全访问档旁路 */
  | { type: 'full_access_allow' }
  /** ：替我审批档对非灾难级红线/敏感操作的 ask */
  | { type: 'policy_risk_ask'; pattern?: string; category?: string }
  | { type: 'workspace_in'; path: string; kind: 'path' | 'cwd' }
  | { type: 'workspace_out'; path: string; kind: 'path' | 'cwd' }
  /**
   * 平台自产产物目录只读放行（cli-outputs / tabtin-agent-tasks）。
   * 路径不在 working_dir，但不是用户资产边界穿越——勿冒充 workspace_in。
   */
  | { type: 'platform_artifact_allow'; path: string }
  /**
   * ：shell 为平台受管 tabtin CLI（browser / desktop）且本将
   * workspace_out ask 时，judge 让位给 host ApprovalGate。deny /
   * sensitive_in_ask 不走此 reason。
   */
  | { type: 'platform_gate_deferred'; surface: string }
  /**
   * ：工作区内破坏性写操作需用户确认。
   *
   * 产品决策：非 yolo 模式下，即便路径在工作区内，破坏性（不可逆）写操作
   * 仍需弹审批——对齐 `authorization_policy.py` 的 `delete_system: confirm`
   * 语义（`delete_file` 注册 `riskLevel: 'strict'` → `delete_system` category）。
   *
   * 触发条件（judge step 4 file 分支）：`inWorkspace && isWrite &&
   * tool.riskLevel === 'strict'`。当前唯一声明 `strict` 的 file 工具是
   * `delete_file`；未来任何声明 `strict` 的破坏性 file 写工具自动获得同款保护，
   * 无需在此再改。
   *
   * yolo 模式不触发（step 3 已 allow）；memo 命中 allow 仍放行（用户已知情同意）。
   */
  | { type: 'destructive_in_workspace_ask'; path: string }
  | { type: 'object_default_allow' }
  | { type: 'object_write_ask' }
  | { type: 'mcp_default_ask'; server?: string }
  | { type: 'device_default_ask'; device_action?: string }
  | { type: 'device_observe_allow' }
  /**
   * Plan / Ask / Study 模式 mode-level 软拒。
   *
   * - `mode`: 当前 agentMode（'plan' / 'ask' / 'study'）
   * - `deny_code`: 细粒度 deny 原因（v3 新增；ModeDenyCode 枚举来自
   *   `@tabtin/agent-modes::ModeDenyCode`，judge 这里不引该类型避免循环；
   *   语义对齐：'mode_disallowed_tool' / 'mode_tool_only_in_plan' /
   *   'no_active_plan' / 'wrong_target_document' / 'invalid_document_id_type' /
   *   'mode_disallowed_path'）
   * - `error_kind`: 与 `agent-runtime/engine/error-kinds.ts::MODE_RESTRICTED`
   *   对齐，让前端 `toolErrorClassification.ts` 能据此走专属 humanize 链路
   * - `tool_name`: 触发拒绝的工具名（telemetry / 文案用）
   */
  | {
      type: 'plan_blocked';
      mode: string;
      deny_code?: string;
      error_kind?: 'mode_restricted';
      tool_name?: string;
    }
  | { type: 'fallback_ask' };

/** Agent 侧渲染的下一步建议 */
export interface ResolutionHint {
  action: 'open_settings' | 'switch_tool' | 'request_user_help';
  /**
   * 当 action='open_settings' 时指向具体配置项；当前 v3 唯一可改项是
   * `yolo_mode`，未来扩展再追加。
   */
  setting_key?: keyof AgentSecurityConfig;
  suggestion?: string;
}

// ─────────────────────────────────────────────────────────────
// D.5 记忆
// ─────────────────────────────────────────────────────────────

/**
 * memo entry 单条结构。
 *
 * 字段命名采用 snake_case 是为了对齐 Django 侧 `Agent.agent_config.approval_memo.entries`
 * 的 PG JSON 落库形态（`approval_memo_service.py`），跨端 SDK 不需要再做命名转换。
 */
export interface ApprovalMemoEntry {
  decision: 'allow' | 'deny';
  created_at: string;
  updated_at: string;
  approver_user_id: string;
  /** 用户填写的拒绝理由 / 备注（可选） */
  reason?: string;
  /** 必填：人话标签，UI 主标题用（不允许出现 `::` 等技术分隔符） */
  scope_description: string;
}

export interface ApprovalMemoSnapshot {
  version: 2;
  entries: Record<string, ApprovalMemoEntry>;
  generation: number;
}

/** 记忆命中的 specificity 等级（值越小越具体）。 */
export type MemoSpecificity = 'exact' | 'scoped' | 'wildcard';

export interface ApprovalMemoLookupResult {
  decision: 'allow' | 'deny';
  matchedKey: string;
  specificity: MemoSpecificity;
  entry: ApprovalMemoEntry;
}

/** 跨端同步状态（refetch / bootstrap 由 host 注入实现） */
export interface MemoSyncSurface {
  readonly generation: number;
  maybeRefetch(remoteGeneration: number): Promise<boolean>;
  bootstrap(): Promise<void>;
  replaceAll(entries: Record<string, ApprovalMemoEntry>, generation: number): void;
}

// ─────────────────────────────────────────────────────────────
// D.6 工具分类
// ─────────────────────────────────────────────────────────────

export type PolicyActionKind = 'file' | 'shell' | 'object' | 'object_read' | 'object_write' | 'mcp' | 'device';

/**
 * Tool 注册时的策略元数据（被 `judge` 内部读取）。
 *
 * - `policyActionKind` 未声明时按 'object' 处理（保守：不走工作区，直接 allow / ask）
 * - `extractPath` shell / file 类必须实现；其他可不实现
 *   - 返回 `string`：单路径；
 *   - 返回 `string[]`：多路径（譬如 `read_lints.paths[]`），judge 文件分支按
 *     **AND 严格语义** 处理
 *     —— 所有元素都在 workspace 内才放行 `workspace_in`，任一不在则拍 ask
 *     `workspace_out`。任意元素在工作区都允许的"OR 宽松"语义不取，因为
 *     "用户授权了 X 不等于自动授权 Y"（路径权限治理 Wave 4 决策；见
 *   - 返回 `undefined`：路径未传 / 无法提取，按 `inWorkspace=false` 处理
 * - `extractSubcmd` shell 类必须实现
 * - `isWriteOp` 文件 / shell 类敏感路径四态判定的写操作识别钩子；未实现按 'read' 处理
 */
export interface ToolPolicyMeta {
  policyActionKind?: PolicyActionKind;
  extractPath?: (input: unknown) => string | readonly string[] | undefined;
  extractSubcmd?: (input: unknown) => string | undefined;
  isWriteOp?: (input: unknown) => boolean;
}

/**
 * judge 实际需要的 Tool 投影（最小集）。
 *
 * 故意不 import `@tabtin/agent-runtime` 的 `Tool`，避免循环依赖。
 * 调用方传入的 `Tool` 对象可以直接 satisfy 本接口（subset 兼容）。
 */
export interface JudgeTool extends ToolPolicyMeta {
  name: string;
  deviceActionRisk?: 'observe' | 'interact';
  /**
   * 路径权限治理 W7 / L1 修复：plan / study / ask 模式下需要绑定 active plan
   * 才能调用的写工具（譬如 `tabdoc_update_document` / `tabdoc_replace_content`）。
   *
   * `true` 时 judge() step 0 在 `policy.planModeGuardActive=true` 直接 deny 并
   * emit `plan_blocked`。SSoT 是 agent-runtime 端 `PLAN_TARGET_GUARDED_TOOLS`
   * Map —— runJudgeFilter 投影 JudgeTool 时按 Map 命中 setter 此标志。
   *
   * orchestration 层保留 legacy plan-mode-guard pre-check 做 target field 细
   * 颗粒度校验（譬如 `document_id === active_plan_id`），与本闸门正交。
   */
  planTargetWriteGuarded?: boolean;
  /**
   * P0-2 修复（2026-05-27）：工具自声明 `isReadOnly`。
   *
   * **历史 bug**：judge.ts step 0 之前用 `isReadOnly: !isWrite`（从
   * `safeIsWrite(tool, input)` 推断）作为 `evaluateAgentModeToolAccess` 入参。
   * `safeIsWrite` 对 `kind='device'/'object'/'mcp'` 默认返回 `false` → 派生
   * `isReadOnly=true` → 这些工具被 `defaultAllowReadOnly` 错误放行——譬如
   * `relaunch_app` (kind=device, isReadOnly=false) 在 ask 模式应当软拒，但
   * 旧路径直接通过 step 4 的 `device_default_ask` 走 ask 弹审批，破坏
   * "受限模式禁止破坏性副作用" 的产品意图。
   *
   * **修法**：runJudgeFilter 投影 JudgeTool 时显式透传 `item.tool.isReadOnly`
   * （Tool 类型已有此字段），让 step 0 SSoT evaluate 优先消费工具自声明。
   * 旧 fallback `!isWrite` 仅在 `isReadOnly === undefined` 时启用（兼容
   * 不绑定 SSoT 字段的早期测试 fixture）。
   */
  isReadOnly?: boolean;
  /**
   * ：工具注册时自声明的风险档位（词表与 agent-runtime `Tool.riskLevel`
   * 一致， 引入）。
   *
   * judge 目前仅消费 `'safe'`：`object`/`object_write` 分支先查此字段，
   * `'safe'` 直接 allow——针对 todo / plan_create / plan_update_todos
   * 这类「Agent 自身任务状态」工具（不碰用户资产、无损失面），避免把
   * 透明化进度看板误伤成每次都弹审批的打扰源。
   *
   * 其余档位（'review' / 'strict'）不改变现有判决路径。
   */
  riskLevel?: 'safe' | 'review' | 'strict';
}

// ─────────────────────────────────────────────────────────────
// D.7 判决函数签名
// ─────────────────────────────────────────────────────────────

export interface JudgeContext {
  tool: JudgeTool;
  /** 工具入参，judge 不假设具体形状，由 `JudgeTool.extractPath` 等钩子解释 */
  input: Record<string, unknown>;
  effectivePolicy: EffectivePolicy;
  memoStore: MemoStore;
  /**
   * 进程当前用户主目录（用于 ~ 展开、敏感路径匹配等）。
   * 调用方必须传，避免 judge 内部读 process.env 引入隐式状态。
   */
  homeDir?: string;
  /**
   * 路径权限治理 W7 / L1 修复：当前 agent mode 名（譬如 `'plan'` / `'study'`）。
   *
   * 用于 `plan_blocked.mode` 字段的回填——让前端 / 审计日志 / LLM 自纠
   * 提示能看到具体是哪个 mode 拒绝了 tool。缺省 `'plan'` 占位（保持 deny
   * 决策成立）；调用方推荐传入真实 mode 名。
   */
  agentMode?: string;
}

// ─────────────────────────────────────────────────────────────
// D.5 记忆 - MemoStore 接口
// ─────────────────────────────────────────────────────────────
//
// MemoStore interface 定义放在 types-v3.ts 末尾，因为它依赖前面的 ApprovalMemoEntry /
// ApprovalMemoLookupResult / MemoSyncSurface。
//
// 设计：
//   - lookup(): 同步纯查（judge 热路径调用），实现方可调用 SP 包提供的
//     `lookupMemo(entries, params)` helper 来满足契约
//   - putAlways / revoke：异步（典型路径走 HTTP PUT / DELETE）
//   - generation / maybeRefetch / bootstrap / replaceAll：跨端同步控制面
// ─────────────────────────────────────────────────────────────

export interface MemoStore extends MemoSyncSurface {
  /**
   * 同步查找记忆（judge 热路径调用，**禁止 await 网络**）。
   *
   * 推荐实现方式：内部缓存所有 entries → 调 `lookupMemo(entries, params)` helper。
   *
   * @param params.toolName 工具注册名（run_terminal_command / write_file 等）
   * @param params.subcmd  按 §B.2 规则提取的子命令；shell 类必填，其他可空串
   * @param params.input   原始工具入参
   * @param params.inWorkspace judge 已算好的工作区命中状态（specificity 排序用）
   */
  lookup(params: {
    toolName: string;
    subcmd: string;
    input: unknown;
    inWorkspace: boolean;
  }): ApprovalMemoLookupResult | null;

  /**
   * 写入"一直允许"记忆。
   * 典型实现：本地缓存先写 + fire-and-forget HTTP PUT。
   */
  putAlways(key: string, entry: ApprovalMemoEntry): Promise<void>;

  /**
   * 撤销记忆。
   * 典型实现：本地缓存先删 + HTTP DELETE。
   */
  revoke(key: string): Promise<void>;
}
