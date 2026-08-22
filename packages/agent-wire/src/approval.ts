/**
 * approval.ts — 统一审批事件 schema
 *
 * 背景：引入 `approval_requested` + `approval_resolved`
 * 一对事件作为工具审批的 SSoT；`approval_type: 'tool_permission'`（v0.4 唯一值，
 * 历史 `'plan_exit'` 已删除——plan-approval 整套已下线，新链路走
 * `plan-execute-handler` IPC，与 hitl 完全解耦）。
 *
 * Ask 工具协议演进（W7 → W4 → W4 R3 / 2026-05-11）：
 *   - W7（路径权限治理收尾）：拆 `ask_choice` / `ask_form` / `request_approval` 三件套，
 *     每个独立 schema + 独立 wire 事件。
 *   - W4（2026-05-11 上午）：合并三件套为单 `ask_user` 工具（AskUserQuestion + Other + header）。
 *   - W4 R3（2026-05-11 dogfood 审计后）：拆回三件套——平台型产品里 `ask_form`
 *     （11 种字段类型）和 `request_approval`（risk_level 视觉分级 + 不可逆
 *     destructive 确认）各有独立产品语义不可合并。
 *
 *   W4 R3 后状态：**三个工具 + 三个 wire 事件并存**：
 *   - `ask_user`（继承 W4 改进 + 兼容 ask_choice 场景）：questions[]，options 单/多选
 *     + 自动 Other 选项 + W4 R2 5 分钟窗口 dedup 守护 + header chip + option.preview
 *   - `ask_form`：fields[]，复杂结构化表单（input/textarea/upload/toggle/color 等）
 *   - `request_approval`：destructive 操作授权（rationale + risk_level + details）
 *
 * 本文件职责：
 *   1. 定义 `DecisionReason` discriminated union（35 种 type：Legacy 19 个 W1A-轮 2
 *      + W6 v3 judge 16 个 L-W6-16 扩展）
 *   2. 定义 `ApprovalRequestedEvent` / `ApprovalResolvedEvent` 的 Zod schema
 *   3. 定义 ask 三件套 schema：`AskUserRequestSchema` / `AskFormRequestSchema` /
 *      `RequestApprovalRequestSchema` + 顶层 `AskInteractionRequestSchema`
 *      discriminatedUnion
 *   4. 命名规范：对外导出 `Schema` 后缀 + `Payload` 中缀，参照 plan-approval.ts
 *
 * 双端对齐：Python 侧 `apps/services/common/agent_protocol/agent_wire.py` 的
 * `ApprovalRequestedEvent` / `ApprovalResolvedEvent` / `DecisionReason` 必须与本文件
 * 字段一字不差；偏差会被 `scripts/check-agent-wire-sync.py` 捕获。
 */

import { z } from 'zod';
import { ApprovalWireRiskLevelSchema } from './risk-level.js';

// ─── Ask 三件套 wire schema（W4 R3 / 2026-05-11，三件套并存形态）──────
//
// W4 R3 后三件套并存：
//   1. **三个 schema 全 `.strict()`** —— 拒绝额外字段进 wire（D3 不留兼容）
//   2. **`tool_name` 必填且 `.literal('xxx')`** —— 成为 discriminator 字段
//   3. **`AskInteractionRequestSchema` discriminatedUnion** —— 顶层入口
//      `safeParse()` 时一次过完整 shape 校验
//   4. **runtime emit 的 4 个语义字段必填**（`interaction_type` / `blocking_policy` /
//      `intent` / `form_mode`）—— W7 / A4 三视角 review 命中 P1 的契约稳定要求
//
// `ask_user`：AskUserQuestion 协议（字段 snake_case：prompt / allow_multiple）。
// `ask_form` / `request_approval` 为平台型产品扩展（结构化表单 / 授权 UI）。

/** 工具语义字段（runtime ask-tools.ts emit 这 4 个语义字段） */
const AskInteractionType = z.literal('ask_user');
const AskBlockingPolicy = z.literal('hard');
const AskUserIntent = z.literal('choose');
const AskUserFormMode = z.literal('questions');
const AskFormIntent = z.literal('collect');
const AskFormFormMode = z.literal('fields');
const ApprovalIntent = z.literal('approve');
const ApprovalFormMode = z.literal('approval');

const AskOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  /**
   * W4 新增：可选预览内容（mockup / code snippet / diagram 等）。
   * AskUserQuestion 协议的 `preview` 字段——某些选项
   * 配合视觉对比时可填，UI 渲染时展示在选项卡片下方。
   */
  preview: z.string().optional(),
}).strict();

/** 与 AskOption 同字段；id 可省略（runtime 会补 `__other__`）。 */
const AskOtherOptionSchema = z.object({
  id: z.string().min(1).optional(),
  label: z.string().min(1),
  description: z.string().min(1),
  preview: z.string().optional(),
}).strict();

const AskUserQuestionSchema = z.object({
  id: z.string().min(1),
  /**
   * 完整问题文本（清晰、具体，以问号结束）。
   * AskUserQuestion 协议的 `question` 字段——TabTin wire
   * 历史用 `prompt`，保留 snake_case 风格。
   */
  prompt: z.string().min(1),
  /**
   * 极短标签（≤12 字符 chip / tag），UI 在问题旁显示。
   * AskUserQuestion 协议的 `header` 字段（必填）。
   * W4 R2（2026-05-11）：从 optional 改 required —— LLM 不传 header 时
   * UI 没 chip，体感空、信息密度低；强制后 LLM 必须想清楚分类。
   */
  header: z.string().min(1).max(12),
  options: z.array(AskOptionSchema).min(2).max(5),
  /**
   * 可选：定制本问「其他」入口文案（字段与普通 option 一致）。
   * 未传时 runtime 注入内置 Other，前端用 i18n 展示。
   */
  other_option: AskOtherOptionSchema.optional(),
  allow_multiple: z.boolean().optional(),
  /**
   * W4 后该字段恒为 `true`：runtime normalize 时给所有 question 自动注入
   * "Other" 选项，前端用户选 Other 时可输入自由文本。保留字段是为了 wire
   * 兼容（前端历史按此字段决定是否渲染 free-text input）。
   */
  allow_free_text: z.boolean().optional(),
}).strict();

const LoginWallContextHintSchema = z.object({
  kind: z.literal('login_wall'),
  domain: z.string().min(1),
  tab_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
}).strict();

export const AskUserRequestSchema = z.object({
  request_id: z.string().min(1),
  /** W4 R3：tool_name 是 discriminator literal */
  tool_name: z.literal('ask_user'),
  /**
   * 顶层 title 可选。历史用 title 作整组问题的卡片标题，保留作可选兜底——
   * LLM 不传时 UI fallback 到 i18n "请回答以下问题"（每个 question 另有
   * `header` chip）。
   */
  title: z.string().optional(),
  questions: z.array(AskUserQuestionSchema).min(1).max(4),
  schema_version: z.literal(1).optional(),
  // runtime ask-tools.ts emit 的语义字段（hard-block 阻塞主输入区）
  interaction_type: AskInteractionType,
  blocking_policy: AskBlockingPolicy,
  intent: AskUserIntent,
  form_mode: AskUserFormMode,
  // 历史对齐：runtime 还可能 emit message 字段给前端 fallback 标题
  message: z.string().optional(),
  // wire envelope transport 字段（chat-client / sendMessageAction 真消费）
  message_id: z.string().optional(),
  tool_call_id: z.string().optional(),
  interrupt_id: z.string().optional(),
  trace_id: z.string().optional(),
  preset_id: z.string().optional(),
  /** 登录墙接力的可选执行 tab 定位；旧客户端可忽略。 */
  context_hint: LoginWallContextHintSchema.optional(),
}).strict();

export const AskUserResponseSchema = z.object({
  answers: z.array(z.object({
    question_id: z.string().min(1),
    selected_options: z.array(z.string()),
    free_text: z.string().optional(),
  }).strict()),
}).strict();

const AskFormFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.string().optional(),
  description: z.string().optional(),
  placeholder: z.string().optional(),
  // 历史 form schema 还会带 required / default / options 等额外字段；保留
  // .passthrough() 在 *field* 子 schema（field 内部 schema 受 W7 范围之外
  // composer-presets/registry 决定，不在三件套 SSoT 治理范围内）。
}).passthrough();

export const AskFormRequestSchema = z.object({
  request_id: z.string().min(1),
  /** W4 R3：tool_name 是 discriminator literal */
  tool_name: z.literal('ask_form'),
  title: z.string().min(1),
  fields: z.array(AskFormFieldSchema).min(1),
  addons: z.array(z.unknown()).optional(),
  submit_label: z.string().optional(),
  schema_version: z.literal(1).optional(),
  // runtime ask-tools.ts emit 的语义字段
  interaction_type: AskInteractionType,
  blocking_policy: AskBlockingPolicy,
  intent: AskFormIntent,
  form_mode: AskFormFormMode,
  message: z.string().optional(),
  // wire envelope transport 字段
  message_id: z.string().optional(),
  tool_call_id: z.string().optional(),
  interrupt_id: z.string().optional(),
  trace_id: z.string().optional(),
  preset_id: z.string().optional(),
}).strict();

export const AskFormResponseSchema = z.object({
  field_values: z.record(z.unknown()),
}).strict();

export const RequestApprovalRequestSchema = z.object({
  request_id: z.string().min(1),
  /** W4 R3：tool_name 是 discriminator literal */
  tool_name: z.literal('request_approval'),
  title: z.string().min(1),
  rationale: z.string().min(1),
  risk_level: z.enum(['safe', 'review', 'high']),
  details: z.unknown().optional(),
  submit_label: z.string().optional(),
  decline_label: z.string().optional(),
  schema_version: z.literal(1).optional(),
  // runtime ask-tools.ts emit 的语义字段
  interaction_type: AskInteractionType,
  blocking_policy: AskBlockingPolicy,
  intent: ApprovalIntent,
  form_mode: ApprovalFormMode,
  message: z.string().optional(),
  // wire envelope transport 字段
  message_id: z.string().optional(),
  tool_call_id: z.string().optional(),
  interrupt_id: z.string().optional(),
  trace_id: z.string().optional(),
  preset_id: z.string().optional(),
}).strict();

export const RequestApprovalResponseSchema = z.object({
  approved: z.boolean(),
}).strict();

/**
 * W4 R3：ask 三件套顶层 discriminated union。
 *
 * `chat-client` / `sendMessageAction` / handlers 在 ask 三件套 wire event 入口
 * 用 `AskInteractionRequestSchema.safeParse(payload)` 一次过完整 shape 校验，
 * 不再透传弱类型 payload。`tool_name` 是 discriminator —— Zod parse 失败时
 * 给的错误位置信息更精确。
 */
export const AskInteractionRequestSchema = z.discriminatedUnion('tool_name', [
  AskUserRequestSchema,
  AskFormRequestSchema,
  RequestApprovalRequestSchema,
]);

export type AskUserOption = z.infer<typeof AskOptionSchema>;
export type AskUserQuestion = z.infer<typeof AskUserQuestionSchema>;
export type AskUserRequest = z.infer<typeof AskUserRequestSchema>;
export type AskUserResponse = z.infer<typeof AskUserResponseSchema>;
export type AskFormRequest = z.infer<typeof AskFormRequestSchema>;
export type AskFormResponse = z.infer<typeof AskFormResponseSchema>;
export type RequestApprovalRequest = z.infer<typeof RequestApprovalRequestSchema>;
export type RequestApprovalResponse = z.infer<typeof RequestApprovalResponseSchema>;
export type AskInteractionRequest = z.infer<typeof AskInteractionRequestSchema>;

// ─── DecisionReason（PRD §8.4, 16 种 type 的 discriminated union）─────
//
// PRD 原文是 TypeScript union type；这里翻译成 Zod discriminated union。本 schema
// 被所有审批/权限事件复用（ApprovalRequestedEvent.decision_reason、
// PermissionAudit.reason 等），是跨 Wave 长期稳定契约，修改要走 schema_version bump。

/** plan_guard 拒绝子码（PRD §5.2 Plan Guard 拦截 write 工具时使用） */
export const PlanGuardDenyCodeSchema = z.enum([
  'plan_mode_write_forbidden',
  'plan_approval_pending',
]);

export type PlanGuardDenyCode = z.infer<typeof PlanGuardDenyCodeSchema>;

/** ApprovalScope v0.3 修订：session → thread（PRD §7.2.2 命名去歧） */
export const ApprovalScopeSchema = z.enum(['once', 'thread', 'always']);

export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>;

/** SwitchAction（OperationSwitchValue 的别名，复用 prompt.ts 定义的值域） */
const SwitchActionValueSchema = z.enum(['allow', 'confirm', 'block']);

/**
 * v3 judge 记忆命中的 specificity 等级。
 *
 * SSoT: `@tabtin/security-policy` 的 `MemoSpecificity`（`types-v3.ts`）。本 schema
 * 必须与其枚举值完全一致，否则 judge.ts emit 的 memo_allow / memo_deny reason
 * 在 wire 层 parse 失败。
 */
export const MemoSpecificitySchema = z.enum(['exact', 'scoped', 'wildcard']);

export type MemoSpecificity = z.infer<typeof MemoSpecificitySchema>;

/**
 * `DecisionReason` 判决理由（discriminated union）。
 *
 * 历史（W1A 轮 2 落地的 19 个 legacy type）：对应 6 层 pipeline 设计，
 * 涵盖 plan_guard / hardline_block+confirm / skill / operation_switch /
 * deny_read+write_path / sandbox_readonly / bash / memoized_always+thread /
 * classifier / user_interactive / unknown_tool / fallback_preset /
 * rule_high_risk_allowlist_miss。
 *
 * 2026-05-03 W6 M4 扩展（L-W6-16 P0 修复）：补齐 `@tabtin/security-policy` 的
 * W6 v3 `judge()` 函数 emit 的 16 个新 type，让 judge 直接生成的 reason 对象
 * 能被本 schema 原样 parse 通过 —— `tool-orchestration` 无需再把 reason 降级
 * 成 `{ type } as DecisionReason` 强 cast，避免 35 条 sensitive 模式 +
 * workspace/memo/yolo 的 path/category/pattern/key 等关键字段丢给 UI。
 *
 * **字段命名**：legacy 19 个 type 全用 snake_case（W1A-轮 2 Review P1-1 约定）；
 * v3 新增 `memo_allow` / `memo_deny` 的 `createdAt` **保持 camelCase**
 * 以对齐 `@tabtin/security-policy/src/judge.ts` 实际 emit 的字段名。
 * 这不违反"wire JSON snake_case"约定——那条约定针对事件 payload top-level
 * 字段（batch_id / action_requests 等），而 `DecisionReason` 分支字段的命名
 * 以 judge SSoT 为准，避免 runtime 透传时 wire/runtime 再做一层 mapping。
 *
 * 跨 Wave 契约：schema 以**兼容扩展**方式 grow——加新 type 不影响旧 client
 * （旧 client 收到新 type 走 zod parse 失败时的 fallback；新 client 全识别），
 * 不触发 schema_version bump。
 *
 * Zod 的 `discriminatedUnion` 在 parse 失败时给的错误位置信息更清晰，推荐下游消费
 * 时用 `DecisionReasonSchema.parse(...)` 而非手工 switch。
 */
export const DecisionReasonSchema = z.discriminatedUnion('type', [
  // ── Legacy 19 种（W1A 轮 2，PRD 05 6 层 pipeline 时期）──────────────
  z.object({
    type: z.literal('plan_guard'),
    deny_code: PlanGuardDenyCodeSchema,
    details: z.unknown(),
  }),
  z.object({
    type: z.literal('hardline_block'),
    pattern_name: z.string(),
    matched_text: z.string(),
  }),
  z.object({
    type: z.literal('hardline_confirm'),
    pattern_name: z.string(),
    matched_text: z.string(),
  }),
  z.object({
    type: z.literal('skill_not_approved'),
    skill_id: z.string(),
  }),
  z.object({
    type: z.literal('skill_trust_downgrade'),
    skill_id: z.string(),
    from_preset: z.string(),
    to_preset: z.string(),
  }),
  z.object({
    type: z.literal('operation_switch'),
    switch_key: z.string(),
    switch_action: SwitchActionValueSchema,
  }),
  z.object({
    type: z.literal('deny_read_path'),
    path: z.string(),
    matched_pattern: z.string(),
  }),
  z.object({
    type: z.literal('deny_write_path'),
    path: z.string(),
    matched_pattern: z.string(),
  }),
  z.object({
    type: z.literal('sandbox_readonly'),
    path: z.string(),
    grant_path: z.string(),
  }),
  z.object({
    type: z.literal('bash_too_complex'),
    node: z.string(),
  }),
  z.object({
    type: z.literal('bash_parse_unavailable'),
  }),
  z.object({
    type: z.literal('memoized_always'),
    // 自引用——旧的 reason 可能是任意 DecisionReason；这里退化成 unknown 避免循环
    previous_reason: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('memoized_thread'),
    previous_reason: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('classifier_low_confidence'),
    confidence: z.number(),
  }),
  z.object({
    type: z.literal('classifier_decided'),
    confidence: z.number(),
    llm_reason: z.string(),
  }),
  z.object({
    type: z.literal('user_interactive'),
    scope: ApprovalScopeSchema,
    rejection_message: z.string().optional(),
  }),
  z.object({
    type: z.literal('unknown_tool'),
  }),
  z.object({
    type: z.literal('fallback_preset'),
    preset: z.string(),
  }),
  // W1A-轮 2 Review P1-4：Layer 3 preset 规则判决（白名单外触发审批 / 高危类别等）。
  // 用 risk_signal 枚举承载子原因，避免随着 preset 规则扩展单独加 tag。
  z.object({
    type: z.literal('rule_high_risk_allowlist_miss'),
    preset_name: z.string(),
    risk_signal: z.enum(['allowlist_miss', 'high_risk_category']),
    matched_text: z.string().optional(),
  }),
  // ── W6 v3 judge 16 种（2026-05-03 L-W6-16 扩展）─────────────────────
  // SSoT: packages/security-policy/src/types-v3.ts DecisionReason union
  //       packages/security-policy/src/judge.ts 实际 emit 字段
  //
  // 绝对红线（yolo 也挡）
  z.object({
    type: z.literal('hardline_command'),
    pattern: z.string(),
  }),
  z.object({
    type: z.literal('hardline_path'),
    pattern: z.string(),
  }),
  // 敏感路径四态（§3.3 矩阵）
  z.object({
    type: z.literal('sensitive_out_deny'),
    path: z.string(),
    category: z.string(),
  }),
  z.object({
    type: z.literal('sensitive_in_ask'),
    path: z.string(),
    category: z.string(),
  }),
  // 长期记忆命中（key / createdAt / specificity 字段名严格镜像 judge.ts emit）
  //
  // M4.1 L-W6-24 扩展：新增 scope_description 可选字段，携带记忆创建时用户看到的
  // 业务名（如"总是允许向远程仓库推送代码"），UI 优先用此字段渲染，缺失时回退
  // 到 pattern_key（如 `execute_command::git-push:exact:a4f3b2c1`）。
  z.object({
    type: z.literal('memo_allow'),
    key: z.string(),
    createdAt: z.string(),
    specificity: MemoSpecificitySchema,
    /** 记忆创建时保存的业务名；UI 优先展示，缺失时回退到 key */
    scope_description: z.string().optional(),
  }),
  z.object({
    type: z.literal('memo_deny'),
    key: z.string(),
    createdAt: z.string(),
    specificity: MemoSpecificitySchema,
    /** 记忆创建时保存的业务名；UI 优先展示，缺失时回退到 key */
    scope_description: z.string().optional(),
  }),
  // 超级权限放行（legacy， 后由 auto_allow / full_access_allow 取代）
  z.object({
    type: z.literal('yolo_allow'),
  }),
  //  三档审批：替我审批档旁路
  z.object({
    type: z.literal('auto_allow'),
  }),
  //  三档审批：完全访问档旁路
  z.object({
    type: z.literal('full_access_allow'),
  }),
  //  三档审批：替我审批档对风险级红线/敏感操作的 ask
  z.object({
    type: z.literal('policy_risk_ask'),
    pattern: z.string().optional(),
    category: z.string().optional(),
  }),
  // 工作区判决（kind 区分 file.path vs shell.cwd）
  z.object({
    type: z.literal('workspace_in'),
    path: z.string(),
    kind: z.enum(['path', 'cwd']),
  }),
  z.object({
    type: z.literal('workspace_out'),
    path: z.string(),
    kind: z.enum(['path', 'cwd']),
  }),
  // 平台自产产物只读放行（cli-outputs / tabtin-agent-tasks）
  z.object({
    type: z.literal('platform_artifact_allow'),
    path: z.string(),
  }),
  // ：平台受管 tabtin CLI 让位给 host ApprovalGate
  z.object({
    type: z.literal('platform_gate_deferred'),
    surface: z.string(),
  }),
  // ：工作区内破坏性写操作需确认（对齐 authorization_policy.py
  // delete_system: confirm）。judge step 4 file 分支对 riskLevel='strict' +
  // isWrite + inWorkspace emit。详见 types-v3.ts DecisionReason 注释。
  z.object({
    type: z.literal('destructive_in_workspace_ask'),
    path: z.string(),
  }),
  // 对象/设备/MCP 类工具的默认判决
  z.object({
    type: z.literal('object_default_allow'),
  }),
  z.object({
    type: z.literal('object_write_ask'),
  }),
  z.object({
    type: z.literal('mcp_default_ask'),
    server: z.string().optional(),
  }),
  z.object({
    type: z.literal('device_default_ask'),
    device_action: z.string().optional(),
  }),
  z.object({
    type: z.literal('device_observe_allow'),
  }),
  // orchestration 层产生的 plan 模式拦截（judge 本身不 emit）
  z.object({
    type: z.literal('plan_blocked'),
    mode: z.string(),
  }),
  // 兜底：judge step 5（未命中上述任何规则）
  z.object({
    type: z.literal('fallback_ask'),
  }),
]);

export type DecisionReason = z.infer<typeof DecisionReasonSchema>;

// ─── Approval 事件公用子 schema ──────────────────────────────────────

/**
 * `ask_hint` 是给 UI 的对话框文案 + 推荐 scope 的语义提示（PRD §7.4）。
 * suggested_scope 用新的 `thread` 命名（v0.3 修订把 session 改为 thread）。
 */
export const ApprovalAskHintSchema = z.object({
  summary: z.string(),
  suggested_scope: ApprovalScopeSchema,
});

export type ApprovalAskHint = z.infer<typeof ApprovalAskHintSchema>;

/** runtime_mode 四态（PRD §1.2 三维辨析 + DR-1） */
export const RuntimeModeSchema = z.enum([
  'interactive',
  'solo',
  'scheduled',
  'batch',
]);

export type RuntimeMode = z.infer<typeof RuntimeModeSchema>;

/** approver 身份（Django relay_handler 写 PermissionAudit 时填充） */
export const ApproverIdentitySchema = z.object({
  user_id: z.string(),
  client_info: z.string(),
  timestamp: z.number(),
});

export type ApproverIdentity = z.infer<typeof ApproverIdentitySchema>;

/**
 * Skill 上下文（与 `PromptForwardPayload.skill_context` 对齐）。
 *
 * W1A-轮 2 Review P1-2：场景 3（第三方 Skill 降档）审批框需要结构化显示 skill 来源
 * 与可信度，避免 UI 依赖 `decision_reason.skill_trust_downgrade.from_preset` 字符串
 * 硬匹配判断"是否隐藏 always 按钮"。`source=marketplace/user_shared` 时 UI 强制
 * `allowed_scopes` 收窄为 `['once']`，memo 禁写。
 */
export const ApprovalSkillContextSchema = z.object({
  skill_id: z.string(),
  source: z.enum(['manual', 'builtin', 'marketplace', 'user_shared']),
  permissions_approved: z.boolean(),
});

export type ApprovalSkillContext = z.infer<typeof ApprovalSkillContextSchema>;

/**
 * Batch 上下文占位（W1A-轮 2 Review P1-7）。
 *
 * DR-2 把 TabData batch AI 填值的实装归 M4-B 独立 PRD，但协议层要提前预留字段，
 * 否则 M4-B 要改 schema_version。本 schema 只定最小骨架（batch_id + 可选位置信息），
 * M4-B 落地时按 `.passthrough()` 添加子字段即可，不 bump 主 schema_version。
 */
export const ApprovalBatchContextSchema = z.object({
  batch_id: z.string(),
  current_row_index: z.number().int().nonnegative().optional(),
  total_count: z.number().int().positive().optional(),
  origin_column_id: z.string().optional(),
  memoization_hint: z
    .enum(['first_in_batch', 'memo_hit', 'memo_miss'])
    .optional(),
}).passthrough();

export type ApprovalBatchContext = z.infer<typeof ApprovalBatchContextSchema>;

/**
 * 子 Agent HITL 结构化上下文。
 *
 * 供 ApprovalPanel scrollToToolCall 回定位父 tool_use；仅 runtime 写入，
 * UI 侧待接渲染。
 */
export const ApprovalSubagentContextSchema = z.object({
  /** 父 Agent 触发该子 Agent 的 LLM tool_use_id */
  parent_tool_call_id: z.string().min(1),
  /** 子 Agent run id（subagents.jsonl / SUBAGENT_STARTED 同源，可选） */
  subagent_run_id: z.string().optional(),
  /** 子 Agent 展示名（可选） */
  label: z.string().optional(),
}).passthrough();

export type ApprovalSubagentContext = z.infer<typeof ApprovalSubagentContextSchema>;

// ─── ApprovalRequestedEvent.payload（v0.4 升格 batch）──────────────────
//
// PRD §7.4 / §7.5（v0.4 修订）：v0.3a 的单 `request_id` 形态在 v0.4 升格为
// `batch_id` + `action_requests[]`。一轮 LLM 输出多个并发审批工具时，runtime
// 一次性 emit 单条事件，N 条 action_requests 装在数组里。
//
// `approval_type` v0.4 后唯一值是 `'tool_permission'`（plan-approval 整套已下线，
// 新链路走 `plan-execute-handler` IPC，完全独立通道）。字段保留作 discriminator
// 给未来扩展（譬如 Skill 安装审批、Organization admin 跨成员审批等场景）。

/**
 * v0.4：单条 ActionRequest（同 batch 多条共享 batch_id）。
 *
 * 字段命名 snake_case 与 wire 协议对齐（runtime 内部 camelCase BatchActionRequest
 * 由 channel 实现做命名映射）。
 */
export const ApprovalActionRequestSchema = z.object({
  /** 单条审批 id（runtime 生成；写 PermissionAudit 行级记录） */
  request_id: z.string().min(1),
  /** LLM tool_use_id（决策回灌索引键） */
  tool_call_id: z.string().min(1),
  /** tool_permission 场景（v0.4 唯一） */
  tool_name: z.string(),
  tool_namespace: z.string().optional(),
  tool_input: z.unknown(),
  /** Layer 1-5 给的判决理由 */
  decision_reason: DecisionReasonSchema,
  /**
   * ：judge `Decision.userVisibleReason` 透传（人话判决说明）。
   *
   * UI 渲染 decision_reason 时按 `approval.reason.<type>` 查 i18n；新增 reason
   * type 而 locale 未配置时，优先回退到本字段而不是裸奔 raw type 字符串。
   * 可选：legacy handler / crash-resume 等不走 judge 的路径可缺省。
   */
  user_visible_reason: z.string().optional(),
  /** 给宿主 UI 的提示（v0.3 改 thread scope） */
  ask_hint: ApprovalAskHintSchema.optional(),
  /** 'once' / 'thread' / 'always' */
  allowed_scopes: z.array(ApprovalScopeSchema),
  allowed_outcomes: z.array(z.enum(['allow', 'deny'])),
  /** v0.4 新增：替代 hardcode 'low'；wire 输出 low/medium/high，输入也收 safe/review/strict */
  risk_level: ApprovalWireRiskLevelSchema,
  /** Skill 驱动场景的结构化上下文（供 UI 判断降档/禁 always） */
  skill_context: ApprovalSkillContextSchema.optional(),
  /** batch 场景占位（M4-B TabData AI 填值消费），M4-B 启动后按 passthrough 扩展 */
  batch_context: ApprovalBatchContextSchema.optional(),
  /** 子 Agent HITL：父 tool_call 关联（；UI scrollToToolCall 待接） */
  subagent_context: ApprovalSubagentContextSchema.optional(),
}).passthrough();

export type ApprovalActionRequest = z.infer<typeof ApprovalActionRequestSchema>;

export const ApprovalRequestedPayloadSchema = z.object({
  /** v0.4：批 id（runtime UUID）；同 batch 内的所有 action_requests 共享 */
  batch_id: z.string().min(1),
  /** v0.4：唯一值（保留 discriminator 字段供未来扩展） */
  approval_type: z.literal('tool_permission'),
  /** v0.4：N >= 1 的 action 数组 */
  action_requests: z.array(ApprovalActionRequestSchema).min(1),
  /** runtime_mode 决定 expires_at 分档 */
  runtime_mode: RuntimeModeSchema,
  /** 批 TTL，unix ms（按 runtime_mode 推断） */
  expires_at: z.number(),
  schema_version: z.literal(1),
  /**
   * ：与 hitl_interaction ChatMessage.id 同源的稳定 UUID
   * （uuid5(HITL_MESSAGE_NAMESPACE, "hitl:tool_approval:{batch_id}")）。
   * 旧 runtime 可不填；新客户端缺省时不得合成 hitl-review-*。
   */
  message_id: z.string().optional(),
}).passthrough();

export type ApprovalRequestedPayload = z.infer<
  typeof ApprovalRequestedPayloadSchema
>;

// ─── ApprovalResolvedEvent.payload（v0.4 升格 batch）─────────────────

/**
 * ApprovalResolved outcome 枚举：
 *   - allow / deny：用户/系统明确决策
 *   - cancelled：用户主动取消（不是超时，不算 deny）
 *   - expired：TTL 到期，runtime 触发默认（在 runtime_mode=interactive 时常见）
 *   - cancelled_by_rollback：PRD §7.6 协同，Checkpoint 回滚导致的被动取消
 */
export const ApprovalOutcomeSchema = z.enum([
  'allow',
  'deny',
  'cancelled',
  'expired',
  'cancelled_by_rollback',
]);

export type ApprovalOutcome = z.infer<typeof ApprovalOutcomeSchema>;

/**
 * v0.4：批内单条决策结果（同 batch N 条独立 outcome / scope / rejection_message）。
 */
export const ApprovalDecisionSchema = z.object({
  request_id: z.string().min(1),
  tool_call_id: z.string().min(1),
  outcome: ApprovalOutcomeSchema,
  scope: ApprovalScopeSchema.optional(),
  rejection_message: z.string().optional(),
  approver_identity: ApproverIdentitySchema.optional(),
  pattern_key: z.string().optional(),
  scope_description: z.string().optional(),
  decision_kind: z.string().optional(),
}).passthrough();

export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalResolvedPayloadSchema = z.object({
  /** v0.4：批 id（与 ApprovalRequestedPayload.batch_id 对齐） */
  batch_id: z.string().min(1),
  /** v0.4：N 条决策（顺序与 action_requests 一致） */
  decisions: z.array(ApprovalDecisionSchema).min(1),
  /** outcome=cancelled_by_rollback 时关联 §7.6.2 接口 A 的 rollback_event_id */
  rollback_event_id: z.string().optional(),
  schema_version: z.literal(1),
}).passthrough();

export type ApprovalResolvedPayload = z.infer<
  typeof ApprovalResolvedPayloadSchema
>;

/**
 * v0.4：上行 user response payload（客户端 → Django → runtime）。
 *
 * WS envelope `localrt.user_response` 的 `payload.response` 字段使用此 schema；
 * Django 网关层用 `batch_id` 作 Redis SETNX 仲裁键防重复消费（PRD §7.10）。
 */
export const LocalRtUserResponseDecisionSchema = z.object({
  request_id: z.string().min(1),
  tool_call_id: z.string().min(1),
  // outcome 四档：'cancelled' 走 cancel-hitl IPC / mode 切换 / rollback 上行；
  // 'expired' 预留服务端过期回灌。runtime `deriveTerminalStatus` 消费；
  // engine 侧 `PermissionDecisionResult` 仍是 allow/deny 二元。
  outcome: z.enum(['allow', 'deny', 'cancelled', 'expired']),
  scope: ApprovalScopeSchema.optional(),
  rejection_message: z.string().optional(),
}).passthrough();

export type LocalRtUserResponseDecision = z.infer<typeof LocalRtUserResponseDecisionSchema>;

export const LocalRtUserResponsePayloadSchema = z.object({
  /** v0.4：批 id；Redis SETNX 仲裁键 */
  batch_id: z.string().min(1),
  /** v0.4：批量决策；mobile / Electron / Daemon 共用此 schema */
  decisions: z.array(LocalRtUserResponseDecisionSchema).min(1),
}).passthrough();

export type LocalRtUserResponsePayload = z.infer<typeof LocalRtUserResponsePayloadSchema>;

// ─── 完整事件 schema（含 type + payload） ─────────────────────────────
//
// 约定：下游代码绝大多数场景只校验 payload（stream event 的 type 由 relay 层保证）；
// 但为了对齐 TypeScript PRD §7.4 的 `type + payload` 整体 event shape，也导出
// 完整事件 schema 供需要端到端校验的测试使用。

export const APPROVAL_REQUESTED_EVENT_TYPE =
  'agent.stream.approval_requested' as const;
export const APPROVAL_RESOLVED_EVENT_TYPE =
  'agent.stream.approval_resolved' as const;

export const ApprovalRequestedEventSchema = z.object({
  type: z.literal(APPROVAL_REQUESTED_EVENT_TYPE),
  payload: ApprovalRequestedPayloadSchema,
});

export type ApprovalRequestedEvent = z.infer<typeof ApprovalRequestedEventSchema>;

export const ApprovalResolvedEventSchema = z.object({
  type: z.literal(APPROVAL_RESOLVED_EVENT_TYPE),
  payload: ApprovalResolvedPayloadSchema,
});

export type ApprovalResolvedEvent = z.infer<typeof ApprovalResolvedEventSchema>;

// ─── 单 HITL 终态事件（，ask_user / ask_form / request_approval 共用）──────
//
// 与三件套 *_REQUIRED 对称的「已解决」终态事实。runtime 的 waiter 结束后补发；
// 按 request_id 定位（服务端 mark_single_hitl_resolved kind 无关）。批量审批走
// APPROVAL_RESOLVED，不复用本事件。
export const SINGLE_HITL_RESOLVED_EVENT_TYPE =
  'agent.stream.single_hitl_resolved' as const;

export const SingleHitlResolvedOutcomeSchema = z.enum([
  'answered',
  'skipped',
  'expired',
  // renderer 显式 dismiss（cancel-hitl IPC）→ ask 面板收敛为 cancelled 终态
  // （区别于 skipped 的「用户略过」）。
  'cancelled',
]);
export type SingleHitlResolvedOutcome = z.infer<
  typeof SingleHitlResolvedOutcomeSchema
>;

export const SingleHitlResolvedPayloadSchema = z.object({
  /** 发起时 *_REQUIRED 的 request_id；resolved 的定位主键 */
  request_id: z.string().min(1),
  /** 传输别名（部分历史 payload 以 interrupt_id 承载 request_id） */
  interrupt_id: z.string().optional(),
  thread_id: z.string().optional(),
  outcome: SingleHitlResolvedOutcomeSchema,
  schema_version: z.literal(1).optional(),
}).passthrough();

export type SingleHitlResolvedPayload = z.infer<
  typeof SingleHitlResolvedPayloadSchema
>;

export const SingleHitlResolvedEventSchema = z.object({
  type: z.literal(SINGLE_HITL_RESOLVED_EVENT_TYPE),
  payload: SingleHitlResolvedPayloadSchema,
});

export type SingleHitlResolvedEvent = z.infer<
  typeof SingleHitlResolvedEventSchema
>;
