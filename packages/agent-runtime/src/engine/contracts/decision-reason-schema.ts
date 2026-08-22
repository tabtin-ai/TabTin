/**
 * DecisionReason Zod。
 *
 * 与 `@tabtin/agent-wire` `approval.ts` 中 DecisionReasonSchema 对齐；
 * 生产路径不得 import agent-wire。parity 见
 * `engine/contracts/__tests__/approval-schema-parity.test.ts`。
 */

import { z } from 'zod';

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
 * 历史（W1A 轮 2 落地的 19 个 legacy type）：对应 PRD 05 §8.4 6 层 pipeline 设计，
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
