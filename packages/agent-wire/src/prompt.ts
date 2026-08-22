/**
 * Zod schemas for `agent.prompt.*` and `agent.permission.*` payloads.
 *
 * These are commands sent from the Backend to the Daemon via WebSocket.
 */

import { z } from 'zod';
import { FocusSnapshotSchema } from '@tabtin/contracts/agent';
import {
  AgentBackendConfigSchema,
  PermissionDecisionSchema,
  PermissionModeSchema,
} from './common.js';

/**
 * prompt.forward 的 `app_context`：FocusSnapshot 核心字段 + host 透传扩展。
 *
 * - 核心字段对齐 `@tabtin/contracts` `FocusSnapshotSchema`（全部 optional，兼容子集）
 * - `.passthrough()` 保留 Django wire 上的 host-only 键
 *   （`collaborationSpaceId` / `executionSpaceId` / `initiatorUserId` 等）
 * - `.nullable()` 兼容上游序列化为 `null` 的情况
 *
 * 非法 Focus **不得**拖垮整包 `PromptForwardPayloadSchema`（ P1-6）：
 * 在 payload 字段上 `.catch(undefined)` 降级丢弃，正文继续。
 */
export const PromptAppContextSchema = FocusSnapshotSchema.passthrough();

// ─── Authorization Sub-payloads (W7b M3) ─────────────────────────────
//
// 这些字段是 Space Settings 里"安全"面板让用户配置的细粒度授权策略。
// 旧 PromptForwardPayload 只传了 authorization_preset 顶层标签 → 客户端只
// 用预设兜底，用户的自定义细粒度开关在 PolicyEvaluator 中完全失效（PRD
// 真相 A2）。本 Wave 把完整的 4 个字段都传过来，让本地 runtime 能合并到
// PolicyEvaluator。
//
// 4 个字段都设为 optional + passthrough — 后端如果未设置某个字段，前端 fallback
// 到对应 preset 的默认值（getPresetPolicy + mergeOperationSwitches 自带这一行为）。

export const OperationSwitchValueSchema = z.enum(['allow', 'confirm', 'block']);

export const OperationSwitchesSchema = z.record(OperationSwitchValueSchema);

export type OperationSwitches = z.infer<typeof OperationSwitchesSchema>;

export const AuthorizationActionSchema = z.enum(['auto', 'confirm']);

export const AuthorizationRulesSchema = z.record(AuthorizationActionSchema);

export type AuthorizationRules = z.infer<typeof AuthorizationRulesSchema>;

export const DevicePermissionsSchema = z.record(OperationSwitchValueSchema);

export type DevicePermissions = z.infer<typeof DevicePermissionsSchema>;

export const ExecutionLimitsSchema = z.object({
  max_iterations_per_run: z.number().int().positive().optional(),
  max_credits_per_run: z.number().nonnegative().optional(),
}).passthrough();

export type ExecutionLimits = z.infer<typeof ExecutionLimitsSchema>;

// W4 (2026-05-13)：移除 `cloud_first` 死配置字面值（T8 / 总控 §三 F5）。旧
// `cloud_first` 与 `cloud_only` 在 host 端是同一个 if 分支，未真正实现差异
// 语义。D1 不留兼容直接删除。Django 后端 agent_wire.py + host-knobs decoder
// 全部同步。
export const AttachmentStrategySchema = z.enum([
  'local_first',
  'cloud_only',
]);

export type AttachmentStrategy = z.infer<typeof AttachmentStrategySchema>;

// ─── Sub-agent Configuration (PRD 06 §5.3.1) ────────────────────────
//
// 子 Agent 的配置信息通过 prompt.forward 从 Django 传到客户端 runtime。
// 主 Agent 启动后即知道 Space 里配了哪些子 Agent 模板、工具策略和并发限制。

export const InheritModeSchema = z.enum(['full', 'filtered', 'summary', 'none']);

export const SubAgentTemplateDtoSchema = z.object({
  template_id: z.string(),
  template_version: z.number().int(),
  name: z.string(),
  subagent_type: z.enum(['explore', 'plan', 'execute']),
  persona: z.string(),
  tools: z.array(z.string()),
  model: z.string().nullable().optional(),
  display_color: z.string().nullable().optional(),
  max_turns: z.number().int().optional(),
}).passthrough();

export type SubAgentTemplateDto = z.infer<typeof SubAgentTemplateDtoSchema>;

export const SubAgentPolicyDtoSchema = z.object({
  tool_whitelist: z.array(z.string()),
  tool_blacklist: z.array(z.string()),
  model_override: z.string().nullable().optional(),
  thinking_config: z.record(z.unknown()).nullable().optional(),
}).passthrough();

export type SubAgentPolicyDto = z.infer<typeof SubAgentPolicyDtoSchema>;

export const SubAgentRuntimeConfigDtoSchema = z.object({
  max_active_children: z.number().int().optional(),
  max_queue_size: z.number().int().optional(),
}).passthrough();

export type SubAgentRuntimeConfigDto = z.infer<typeof SubAgentRuntimeConfigDtoSchema>;

/**
 * 子 Agent 配置总包（prompt.forward 中的 subagent_config 字段）。
 *
 * - `templates`：Space 里用户预配的子 Agent 模板列表
 * - `policy`：全局工具策略（白名单 / 黑名单 / 模型覆盖）
 * - `runtime`：并发调度参数（max_active_children / max_queue_size）
 */
export const SubagentConfigDtoSchema = z.object({
  templates: z.array(SubAgentTemplateDtoSchema).optional(),
  policy: SubAgentPolicyDtoSchema.nullable().optional(),
  runtime: SubAgentRuntimeConfigDtoSchema.nullable().optional(),
}).passthrough();

export type SubagentConfigDto = z.infer<typeof SubagentConfigDtoSchema>;

// ─── Enabled Apps (W7c · Stage 4 双路径对齐) ─────────────────────────
//
// Daemon 路径上 `<apps>` 段恒空（agent-prompt 治理 07 §F.1 / §F.7）：Daemon 没
// renderer，wire 也从来没字段携带"当前 Space 启用了哪些 App + 各自能力图谱"。
// Stage 4 起 Django 端 ``prompt_forward_service`` 从 manifest + ``AppSettings``
// 派生 ``EnabledAppDto[]`` 透传给 Daemon，让本地 ``buildAppsSection`` 真正生效。
//
// 形态对齐 ``@tabtin/agent-prompt`` 的 ``EnabledAppInfo`` —— 4 个字段同名同义：
//   - key          : 与 handler.appId / manifest.id 一致
//   - cliKey       : 与 handler.backendAliases[0] / manifest.typeAliases[0] 一致
//   - displayName  : 跟用户对话的中文权威名
//   - capability   : ≤80 字能力描述（注入 `<apps>` 段）
//   - aliases      : 用户口语别名（帮 Agent 理解用户消息）
//
// **`passthrough()`** 允许 Django 端追加字段（譬如 manifest 的 ``description``、
// ``icon``）而不破坏 Daemon 端 schema 校验。
// 必填三字段（key / display_name / capability）语义上不该为空，但**故意不用**
// ``.min(1)`` 强校验 —— 它会让一条脏 app 把整个 ``PromptForwardPayloadSchema``
// safeParse 拖挂，进而 daemon 整轮 prompt.forward 失败、对话直接报错（杀伤过大）。
// 改走 fail-soft 双保险：
//   1. Django 派生侧 `derive_enabled_apps_for_forward` 跳过 description 为空的 app；
//   2. daemon `resolveEnabledApps` 对空串字段 trim 后 skip 该条（不挂整个 payload）。
export const EnabledAppDtoSchema = z.object({
  key: z.string(),
  cli_key: z.string().optional(),
  display_name: z.string(),
  capability: z.string(),
  aliases: z.array(z.string()).optional(),
}).passthrough();

export type EnabledAppDto = z.infer<typeof EnabledAppDtoSchema>;

// ─── Crash Resume: interrupt_state.pending_approvals (PRD 05 v0.4 §7.1) ──
//
// W3-轮 1：runtime 进程崩溃后从 Django `ConversationState.interrupt_state`
// 还原批量审批快照。Django relay_audit_writer 在收到 approval_requested /
// approval_resolved 时持续维护此结构；`prompt.forward.resume` 路径通过
// `PromptForwardPayload.interrupt_state.pending_approvals` 把快照透传给
// 客户端 host，host 转成 `SerializedPendingApproval[]` 注入 EngineConfig。
//
// schema 字段与 PRD §7.1 表对齐（snake_case wire 协议）；命名映射详见
// `agent-runtime/src/engine/types.ts` 的 SerializedPendingApproval 文档。
//
// `passthrough()` 让 server 端可附加调试字段（譬如 `tool_input_preview` 字符串
// 或 `created_at` ms timestamp）而不破坏客户端 schema 校验。

// 嵌套 sub-schema 抽到外面避免 `check-agent-wire-sync.py` 的非贪婪 regex
// `z\.object\(\{(.*?)\}\)` 把内嵌 `})` 当成 InterruptStatePendingApprovalSchema
// 的结束符（嵌套 z.object 会污染顶层字段抓取）。
const _InterruptStateAskHintSchema = z.object({
  summary: z.string(),
  suggested_scope: z.enum(['once', 'thread', 'always']),
}).passthrough();

const _InterruptStateApproverIdentitySchema = z.object({
  user_id: z.string(),
  client_info: z.string().optional(),
  timestamp: z.number(),
}).passthrough();

export const InterruptStatePendingApprovalSchema = z.object({
  batch_id: z.string(),
  request_id: z.string(),
  tool_call_id: z.string(),
  tool_name: z.string(),
  tool_namespace: z.string().optional(),
  tool_input: z.unknown().optional(),
  status: z.enum(['pending', 'resolved', 'expired']),
  // ：未决审批在 PG/JSON 里常把 outcome/scope/resolved_at 存成 null；
  // Zod `.optional()` 只接受缺省，不接受 null——须 `.nullable()`，否则整包
  // prompt.forward 被 Electron/Daemon decoder 拒收，会话卡死。
  outcome: z.enum([
    'allow', 'deny', 'cancelled', 'expired', 'cancelled_by_rollback',
  ]).nullable().optional(),
  scope: z.enum(['once', 'thread', 'always']).nullable().optional(),
  rejection_message: z.string().nullable().optional(),
  decision_reason: z.unknown().optional(),
  ask_hint: _InterruptStateAskHintSchema.nullable().optional(),
  allowed_scopes: z.array(z.enum(['once', 'thread', 'always'])).optional(),
  allowed_outcomes: z.array(z.enum(['allow', 'deny'])).optional(),
  risk_level: z.enum(['low', 'medium', 'high']).nullable().optional(),
  runtime_mode: z.enum(['interactive', 'solo', 'scheduled', 'batch']).nullable().optional(),
  expires_at: z.number().nullable().optional(),
  created_at: z.number().nullable().optional(),
  resolved_at: z.number().nullable().optional(),
  approver_user_id: z.string().nullable().optional(),
  approver_identity: _InterruptStateApproverIdentitySchema.nullable().optional(),
  /** Django relay_audit_writer 端为节省 WS 体积写入的截断字符串（≤2000 字）。 */
  tool_input_preview: z.string().optional(),
}).passthrough();

export type InterruptStatePendingApproval = z.infer<typeof InterruptStatePendingApprovalSchema>;

// ─── Crash Resume: interrupt_state.pending_single_hitl () ──
//
// 与 pending_approvals 对称，承载 ask_choice / ask_form / permission_request
// 单 HITL 交互的未完态。Django 侧数据源是 ``PendingInteraction`` PG 表
// （relay 处理 ``ask_*_required`` / ``single_hitl_resolved`` 时维护）；
// ``prompt_forward_service`` 在 resume 路径上把 pending 行读出后放进
// ``interrupt_state.pending_single_hitl`` 透传到 daemon → runtime。
//
// runtime 收到后由 ``pending-single-hitl-restorer`` 处理：
//   - ``status='pending'`` → 通过 ``InterruptPort.interrupt`` 重挂 UI 卡片
//     + 再等一次 ``waitForUserInput``，用户答后 inject 合成 tool_result。
//   - ``status='resolved'`` / ``'expired'`` → 直接按 ``result`` 合成 tool_result
//     inject（工具在 runtime 崩前未产出结果，需要让 LLM 看到用户答复）。
//
// 字段命名对齐 Django ``PendingInteraction``（snake_case wire）：
export const InterruptStatePendingSingleHitlSchema = z.object({
  /** ask_choice / ask_form / permission_request（与 runtime HitlKind 一致）。 */
  kind: z.enum(['ask_choice', 'ask_form', 'permission_request']),
  /** 单 HITL 幂等键（== 交互 request_id，用作 waitForUserInput 挂起键）。 */
  request_key: z.string(),
  /** thread_id 归属（保留字段——runtime 用 EngineConfig.threadId，兼容跨核。） */
  thread_id: z.string().optional(),
  status: z.enum(['pending', 'resolved', 'expired', 'cancelled']),
  /** ask_* / request_approval_required 原始 wire payload（含 questions / fields / etc）。 */
  payload: z.unknown().optional(),
  /** 用户答复；resolved 时非空。runtime inject tool_result 时用此 payload 复原
   *  ask-tools 里的 formatAnswered 输出文案，让 LLM 看到用户答的内容。 */
  result: z.unknown().optional(),
  expires_at: z.number().nullable().optional(),
  created_at: z.number().optional(),
  resolved_at: z.number().nullable().optional(),
  /** runtime 崩溃前挂起时的 mode；重挂时 interrupt.interrupt 用此选取 timeout 档。 */
  runtime_mode: z.enum(['interactive', 'solo', 'scheduled', 'batch']).optional(),
}).passthrough();

export type InterruptStatePendingSingleHitl = z.infer<typeof InterruptStatePendingSingleHitlSchema>;

export const InterruptStateSchema = z.object({
  /** PRD §7.1 schema_version；resume 协议升级时 bump。 */
  // ：上游可能显式写 `"version": null`（未合成 metadata 时）。
  version: z.number().nullable().optional(),
  pending_approvals: z.array(InterruptStatePendingApprovalSchema).optional(),
  /**  单 HITL 断点恢复：ask_* / permission_request 未决快照。 */
  pending_single_hitl: z.array(InterruptStatePendingSingleHitlSchema).optional(),
  /** §7.2.1 snapshot 字段（budget / lastSummary / activePlan 等）；本轮不强约束。 */
  snapshot: z.unknown().nullable().optional(),
}).passthrough();

export type InterruptState = z.infer<typeof InterruptStateSchema>;

// ─── Prompt Forward (Backend → Daemon) ───────────────────────────────

export const PromptForwardPayloadSchema = z.object({
  task_id: z.string(),
  /** Django 生成的业务执行 ID；只进入 host，由 host 在业务投递边界完成映射。 */
  run_id: z.string().uuid().optional(),
  prompt: z.string(),
  attachments: z.array(z.unknown()).default([]),
  /**
   * ：用户消息结构化块（ContextRef / 非 text content_blocks）。
   * 与 Electron IPC `userMessageBlocks` 同源；缺省时 host 仍可仅靠 attachments
   * 拼伪块（旧客户端兼容），但远控切会话 / transcript 会丢引用芯片。
   */
  user_message_blocks: z.array(z.unknown()).optional(),
  agent_config: AgentBackendConfigSchema,
  model_id: z.string().optional(),
  system_prompt: z.string().optional(),
  agent_id: z.string().optional(),
  /** 群聊 @ 等高优先级指令可抢占同一 Agent 的当前 run。 */
  interrupt_active: z.boolean().optional(),
  workspace_id: z.string().min(1),
  attachment_strategy: AttachmentStrategySchema.optional(),
  workspace_root: z.string().nullable().optional(),
  permission_mode: PermissionModeSchema.optional(),
  // PD-1（W6 M5）：authorization_preset 字段已退场，v3 唯一安全开关是 yolo_mode。
  /**
   * Hilt v3 / W6 M2：用户在 Settings 切换的"超级权限" toggle 真值。
   *
   * Django `prompt_forward_service.forward_prompt` 从 `Agent.agent_config.security.allow_yolo_mode`
   * （v3 PRD §5.1.1 字段改名）读出后透传；客户端 host（Daemon / Electron-via-forward）
   * 解析后落到 `agentConfigV3.security.allow_yolo_mode`，让 `buildPolicyFromAgentConfigV2`
   * 派生 EffectivePolicy 时真实生效（PD-1）。
   *
   * ⚠️ wire 字段名 `yolo_mode` 是协议名（Daemon ↔ Django），**PR3 不改**——
   * 改 wire 协议名属 PR2 范围。本字段映射到 DB 的 `security.allow_yolo_mode`。
   *
   * 缺省视为 false（与默认 yolo 关一致），客户端必须以"未传"和"显式 false"
   * 等价处理，避免 Django 旧版本不传字段时主进程错误地保持上次的 yolo 状态。
   */
  yolo_mode: z.boolean().optional(),
  /**
   * Hilt v3 / W6 M2：客户端工作区快照（Space sandbox + TabCode/TabFolder 累积 + 附件）。
   *
   * 主要给 Daemon 用 —— Electron 主对话路径通过 IPC 直接持有 WorkspaceSnapshot
   * 不需要走 wire；Daemon 没有自己的 TabCode UI，只能从用户的主控端（Electron）
   * 通过 `prompt.forward` 透传过来。Daemon 收到后传给 `DaemonToolProvider`
   * 与 Electron 同构走 judge()。
   *
   * 形态用 `z.unknown()` 不强校验（同 `history` 模式）：
   * `WorkspaceSnapshot` 类型只在 `@tabtin/security-policy` 内定义，wire 包不
   * 反向依赖；Daemon 侧用 type guard + `buildPolicyFromAgentConfigV2` 兜底
   * 形态错误。缺省 → Daemon 自己用 sandbox 目录兜底（详见 daemon 同 wave 同步改动）。
   */
  workspace_snapshot: z.unknown().optional(),
  runtime_mode: z.string().optional(),
  /**
   * Agent 专属规则（`Agent.custom_rules` / 配置页「人设与规则」）。
   * ：host 写入 session.agentProfile.customRules，由 agent-profile hook
   * 贴用户消息前注入；不再烘焙进 system `<custom_rules>`。非空才写。
   * ：这是存量自由文本字段，不做正文分类；已迁移宿主可与
   * `personal_rules` 按固定来源顺序合并到同一 pre-user context。
   */
  custom_rules: z.string().optional(),
  /**
   * ：当前 Agent 展示名。host 解包后写入 session.agentProfile，由
   * agent-profile hook 包成 `<context type="agent-profile">` 贴用户消息前注入
   *（对话中可切 Agent，故不进静态 system prompt）。非空才写。
   */
  agent_name: z.string().optional(),
  /**
   * 历史字段：曾用于 agent-profile「当前目标」。产品已去掉独立目标设计，
   * 仅保留人设与规则；旧 payload 若仍带此键则忽略，不参与注入。
   */
  goal: z.string().optional(),
  /**
   * 设置 IA Phase 3 §8.6 分层规则·**个人基线层**。
   *
   * Django `prompt_forward_service.forward_prompt` 从 **Agent owner** 的
   * `UserProfile.personal_rules`（per-User 全局跨 Organization）读出后透传（非空才写）。
   * ：这是存量自由文本字段，不做正文分类。shared assembler 默认保留
   * system 语义；仅已接好 personal pre-user hook 的宿主显式 opt-in 迁移。
   * 平台 safety / 权限 / 审批 / sandbox 仍由 system 与运行时 policy 强制。
   *
   * 缺省 / 不传 → 该层跳过。
   * （原团队基线层 `team_rules` 已下线：团队级一刀切 prompt 难适配不同岗位，
   * 岗位差异化交给 skill 系统按需装载。）
   */
  personal_rules: z.string().optional(),
  agent_mode: z.string().optional(),
  /**
   *  三档审批策略：对话级请求的审批档位（与 `agent_mode` 正交——前者管
   * "做什么类型的事"，本字段管"多大程度放手"）。host 透传给
   * `buildPolicyFromAgentConfigV2({ requestedApprovalMode })` 派生 judge 三档。
   *
   * 缺省 / 不传 → host 走 legacy 归一：`agent_mode='yolo'` → `'auto'`，
   * 否则 `'always_ask'`（旧客户端零回归）。
   */
  approval_mode: z.enum(['always_ask', 'auto', 'full_access']).optional(),
  /**
   * ：Agent 已授权的最高审批档位（服务端权威值——Django 从
   * `Agent.agent_config.security` resolve，legacy `allow_yolo_mode=true`
   * 已映射为 `'auto'`）。host 写进 `agentConfigV3.security.approval_grant`，
   * `deriveApprovalMode` 用它做升档闸门（requested ≤ grant）。
   *
   * Django 始终显式写入（同 `is_group_space` 语义，避免默认值漂移）；
   * 缺省 / 不传（旧 Django）→ host 回落 legacy `yolo_mode` bool 派生。
   */
  approval_grant: z.enum(['always_ask', 'auto', 'full_access']).optional(),
  /**
   * 交互档（HITL 四态，与顶层 `runtime_mode` 区分：后者是执行位置 local/cloud，
   * 本字段是「人机交互档」）。无人值守任务（Tracker 后台/立即执行）传 `'scheduled'`，
   * 让设备 host 把 LocalPermissionHandler.runtimeMode 设为 scheduled（审批 0 秒
   * fail-fast）并让 host 的 waitForUserInput 对该 session 立即 reject（LLM 主动
   * ask_user/request_approval 也 fail-fast，不再干等 30 分钟）。
   * 缺省 / 不传 → host 走 `'interactive'`（普通 chat 行为不变）。
   */
  interaction_mode: z.enum(['interactive', 'solo', 'scheduled', 'batch']).optional(),
  /**
   * PRD §1.4 + DR-15（PR4-yolo Daemon 路径 wire 字段）：当前运行时是否群协作上下文。
   *
   * Space-first Phase 4 后不再从 `Space.type` 派生；Django 当前显式写 false
   * （即使 False 也写——避免 default 漂移让下游 fail-open）。
   * 未来多 Agent 群聊应由 group runtime 配置写入。
   * Daemon `decodeForwardRequest` / `DaemonAgentHost` 透到
   * `policyContext.isGroupSpace`，与 yolo gate + requestedAgentMode 三方 AND
   * 派生 effectiveMode：group runtime 与 yolo 强制互斥。
   *
   * 缺省 `false`（向后兼容：旧 Django 版本不传时按非 group 处理，安全靠 gate 兜底）。
   */
  is_group_space: z.boolean().optional(),
  /**
   * W7b M3：Space ID 透传（让 Daemon 调 Skills/Memory API 时携带 space 维度）。
   * Electron 通过 IPC 已有 spaceId（从 useSpaceStore 来），Daemon 之前没有此字段
   * （遗留项 W3-fix），导致 buildSystemPrompt 拿不到 spaceId、SkillsFetcher 拉不到 enabled skills。
   */
  space_id: z.string().nullable().optional(),
  /**
   * W7c · Stage 4 Daemon 路径对齐 ── Space / Organization 的人类可读名。
   *
   * Electron 路径 ``renderer`` 通过 ``useSpaceStore.selectedSpace.name`` /
   * ``useOrganizationStore.selectedOrganization.name`` 注入到 `<environment>` 段；
   * Daemon 路径 wire 之前没字段携带，``<environment>`` 段只显 UUID（治理 07 §F.1）。
   *
   * Django 端 ``prompt_forward_service`` 从 ``Space.name`` / ``space.organization.name``
   * 派生后透传——非空字符串才有意义（空串保持 wire 简洁，Daemon ``runtimeIdentity``
   * 缺省回退到只显 ID 的旧行为）。
   */
  space_name: z.string().nullable().optional(),
  organization_name: z.string().nullable().optional(),
  /**
   * W7c · Stage 4 Daemon 路径对齐 ── 当前 Space 启用的 App 能力图谱。
   *
   * Daemon 之前 ``<apps>`` 段恒空（07 §F.7）：wire schema 完全没 enabled_apps，
   * ``buildSystemPrompt`` 入参恒 undefined。本字段由 Django ``prompt_forward_service``
   * 从 manifest + ``AppSettings.resolve_enabled_app_ids`` 派生后透传。
   *
   * 缺省 / 空数组 → Daemon ``<apps>`` 段跳过（与未升级 host 兼容）。Electron 路径
   * 维持 renderer 注入（``QueryRequest.enabledApps``），不走 wire ——
   * forward 路径未来若需要走 Electron 端（譬如 Cloud Sandbox 转发），主控端 renderer
   * 可以把同一份 ``EnabledAppInfo[]`` 塞进 ``app_context.enabled_apps`` 让 Django 透传，
   * 复用本字段即可（双源也能共存）。
   *
   * `.nullable()` 与下方 `space_name` / `organization_name` / `cli_reference` 形态对齐
   * —— Django 端 `derive_enabled_apps_for_forward` 返回空列表时上游可能序列化成
   * `null`，统一接受 `null` 避免 TS zod reject（review P1）。
   */
  enabled_apps: z.array(EnabledAppDtoSchema).nullable().optional(),
  /**
   * W7c · Stage 4 Daemon 路径对齐 ── CLI 工具命令清单（``tabtin capabilities tools``）。
   *
   * Electron 路径 ``loadCLIReferenceAsync()`` 在主进程异步 spawn 取；Daemon 路径
   * 之前完全没有 `<cli_capabilities>` 段（07 §F.1）。本字段由 Django 端在 forward 前
   * 注入（可选——Daemon 拿到为空时也会本地 fallback 通过 ``loadCLIReferenceAsync``
   * 自己 spawn ``tabtin capabilities tools``）。
   *
   * 当 Django 端能更高频缓存或精修结果时，优先用 wire 字段；否则 Daemon 端 spawn
   * 兜底，与 Electron 路径同款。
   */
  cli_reference: z.string().nullable().optional(),
  /**
   * W7b M3：用户在 Settings 里配置的细粒度操作开关（git/rm/mv/db/...）。
   * 客户端 ToolProvider 通过 mergeOperationSwitches 合并到 preset 默认值。
   */
  operation_switches: OperationSwitchesSchema.optional(),
  /**
   * W7b M3：用户配置的类别级授权规则（read/write/install/...）。
   * 当前主要在 Django PolicyEvaluator 用，转发出来让 Daemon 端有完整 SSoT。
   */
  authorization_rules: AuthorizationRulesSchema.optional(),
  /**
   * W7b M3：移动/桌面端设备权限（screen_capture/launch_app/...）。
   * 主要给移动 Daemon 用；桌面 Daemon 当前不消费但保留以避免协议漂移。
   */
  device_permissions: DevicePermissionsSchema.optional(),
  /**
   * W7b M3：执行预算（最大迭代轮数 / 最大 credits）。
   * `max_iterations_per_run` → DaemonAgentHost 转成 `runtime.query({ maxTurns })`
   * 使 Settings 里"最大迭代轮数"在本地 runtime 真正生效（PRD 真相 A3）。
   */
  execution_limits: ExecutionLimitsSchema.optional(),
  /**
   * W7b M3：是否启用 memory 能力（用于 buildSystemPrompt 注入
   * `<agent_memory_capability>` 段）。Django 端从 agent_config.memory_enabled / 是否
   * 配置了记忆模块 派生。缺省 false 时不注入，行为完全兼容旧版。
   */
  memory_capability: z.boolean().optional(),
  /**
   * work_mode：Agent 工作目录类型（code/doc/mixed）。Django
   * `prompt_forward_service` 从 `Agent.working_dir_type` 读出后透传，Daemon 据此
   * 注入 system prompt 的 `<work_mode>` 默认执行策略段。
   *
   * 用 `z.string().optional()`（而非 enum）保持宽松——脏值不会让整个
   * prompt.forward safeParse 失败；合法性由 daemon.ts 解码时的枚举守卫兜底
   * （非 code/doc/mixed → 跳过段注入）。缺省时段不注入，向后兼容旧 Django。
   */
  working_dir_type: z.string().optional(),
  /**
   * W7a：用户聚焦的 App + 打开的标签上下文（FocusSnapshot）。
   *
   * 核心字段合同见 `@tabtin/contracts` `FocusSnapshotSchema`：
   *   `{ appType?, appMeta?, openTabs?, spaceId?, userTimeZone?, workspaceMode? }`
   *
   * Django `project_focus_for_wire` 可能只输出子集；schema 字段均为 optional。
   * host-only 扩展键（`collaborationSpaceId` / `executionSpaceId` 等）经
   * `PromptAppContextSchema`（= FocusSnapshot + passthrough）保留透传。
   *
   * 非法 Focus 降级为 `undefined`（`.catch`），**不**让整个 prompt.forward
   * safeParse 失败阻断正文（ P1-6）。
   *
   * Daemon / Electron host 由 `decodeAppContext` → `buildContextHook` 消费；
   * Electron 主路径仍可走 IPC `agent-engine:update-context` 旁路。
   */
  app_context: PromptAppContextSchema.nullable().optional().catch(undefined),
  /**
   * PRD 06 §5.3.1：子 Agent 配置（模板 + 策略 + 运行时参数）。
   *
   * Django `prompt_forward_service` 从 `SubAgentTemplate` 表和 Agent 配置
   * 组装此字段，让客户端 runtime 的 `agent` 工具知道 Space 里有哪些可用模板。
   * 缺省 / undefined 时主 Agent 只能走 `source='inherit'` 和 `source='blank'`
   * 路径，无法按名匹配模板。
   */
  subagent_config: SubagentConfigDtoSchema.optional(),
  /**
   * 客户端生成的 user message UUID。Daemon runtime yield `agent.stream.user`
   * 时透传，Django 用它闭合客户端 temp id → server id 映射。
   */
  client_message_id: z.string().optional(),
  /** 本轮可见 user 消息的真实发送者；与执行设备 owner 身份相互独立。 */
  sender_user_id: z.string().optional(),
  /** Django 为持久化服务端任务签发的计费幂等作用域。 */
  billing_idempotency_scope: z.string().optional(),
  display_message: z.string().optional(),
  reply_to_message_id: z.string().optional(),
  reply_to_preview: z.record(z.unknown()).optional(),
  /**
   *  / ：斜杠 / quick-use Skill 直链。Django 只透传结构化字段，
   * Host 写入 runtime `skillSlashInvoke`；亦可从 user_message_blocks 的
   * composer_preset.skill_key 派生（preset 路径）。
   */
  skill_slash_invoke: z.object({
    skill_key: z.string().min(1),
    args: z.string().optional(),
  }).optional(),
  /**
   * W7a · 跨轮记忆 history（按时间升序的 user/assistant 消息列表）。
   *
   * 与 Electron `QueryRequest.history` 同构。客户端通过
   * `selectRecentHistoryForRuntime` 选最近 N-1 轮（含 tool_use / tool_result
   * 对），Django 透传到设备端。设备端 host 在 `runtime.query` 前拼成
   * `initialMessages`，让引擎走"已有历史"分支让 LLM 真看到多轮上下文。
   *
   * `content` 字段类型 `string | ContentBlock[]`，承载图片等 multi-modal
   * 块；wire 层不强校验 ContentBlock shape（避免反向依赖 runtime 包），
   * 由 host 侧 `resolveHistory` + runtime 内 `normalizeMessages` 兜底处理
   * 畸形 content。
   *
   * Django 透传由 W7c 阶段补齐（chat_service 决定走 local runtime 时调
   * "选最近 N-1 轮"等价逻辑；当前 schema 先就位避免协议漂移）。
   */
  history: z.array(z.unknown()).optional(),
  /**
   *  第三波：云端 AdminDash 配置的压缩分档阈值（EngineRuntimeConfig
   * ctx_* 字段 → 三档语义映射：ctx_pressure_high → micro_compact_start、
   * ctx_summary_trigger_fraction → llm_summary_start、ctx_pressure_critical
   * → emergency_start）。Django `prompt_forward_service` 每次 forward 时读
   * 单例配置注入；宿主解码后按「云端 > env 旋钮 > runtime 默认」优先级落到
   * `EngineConfig.pressureThresholds`。
   *
   * 缺省 / 形态非法 → 宿主回落 env / runtime 默认（向后兼容旧 Django）。
   */
  pressure_thresholds: z.object({
    micro_compact_start: z.number(),
    llm_summary_start: z.number(),
    emergency_start: z.number(),
  }).optional(),
  /**
   * W3-轮 1（PRD 05 v0.4 §7.1 + §7.2.3）：crash resume 状态快照。
   *
   * Django 在 `prompt.forward.resume` 路径上拉
   * `ConversationState.interrupt_state` 直接透传；客户端 host 解析
   * `interrupt_state.pending_approvals[]` 转成
   * `SerializedPendingApproval[]` 注入 `EngineConfig.pendingApprovalsSerialized`。
   *
   * 缺省 / 空数组 → 客户端 host 跳过 restore，runtime 按"全新对话"行为推进。
   *
   * schema 字段对齐详见 `InterruptStateSchema` 文档；本字段在 forward.resume
   * 之外的常规 prompt.forward 路径上始终缺省。
   */
  interrupt_state: InterruptStateSchema.optional(),
});

export type PromptForwardPayload = z.infer<typeof PromptForwardPayloadSchema>;

// ─── Prompt Cancel (Backend → Daemon) ────────────────────────────────

/**
 *  按 thread 取消：`task_id` 改 optional。
 *
 * 取消的权威身份是 envelope 顶层 `thread_id`（业务会话）；`task_id`
 * （`prompt_xxx`，每轮变）保留为 sessions key 直达的快路径 + 历史兼容。
 * 宿主（Electron `handleAbortFromEnvelope` / Daemon AgentHost.cancel）
 * 按 task_id → envelope.thread_id 顺序解析候选，经 `resolveConversationAbortKeys`
 * 统一命中——前端停止不再依赖缓存 task_id。
 */
export const PromptCancelPayloadSchema = z.object({
  task_id: z.string().optional(),
  withdraw_unanswered: z.boolean().optional(),
  client_message_id: z.string().optional(),
  session_id: z.string().optional(),
  target_content: z.string().optional(),
  space_id: z.string().optional(),
  organization_id: z.string().optional(),
});

export type PromptCancelPayload = z.infer<typeof PromptCancelPayloadSchema>;

// ─── Subagent Cancel (Backend / UI → Daemon) ─────────────────────────

/**
 * W0（2026-05-30）：取消单个**子 Agent**（区别于 `PromptCancel` 取消整个 turn）。
 *
 * 背景：子 Agent 的取消登记（active / queued AbortController）是 **agent-runtime
 * 模块级进程内状态**——query 跑在哪个进程，登记就在哪个进程。当 Space 绑定 daemon
 * 设备、query 实际在 Daemon 进程跑时，UI 的取消若打到 Electron 进程的
 * `cancelSubagent` 只会 no-op（那进程没这个 childId）。本 envelope 让取消能路由到
 * **query 实际所在的 Daemon 进程**，对照 Electron 的 `agent-engine:cancel-subagent`
 * IPC（同进程直调）。
 *
 * `child_id` 即子 Agent 的 `subagent_run_id`（两者同值，见 agent-tool.ts），
 * 透传给 `DaemonAgentHost.cancelSubagentById(child_id)`。
 */
export const SubagentCancelPayloadSchema = z.object({
  // `.min(1)`：空串 childId 取消无意义（`cancelSubagentById("")` 必 false）。
  // 加约束让 WS 侧（schema safeParse）与 CLI route 的 `if (!childId)` 400 兜底
  // 两端对空串行为一致（都拒），而非 WS 放行空串 → 走到 "not matched" warn。
  child_id: z.string().min(1),
});

export type SubagentCancelPayload = z.infer<typeof SubagentCancelPayloadSchema>;

// ─── Permission Response (Backend → Daemon) ──────────────────────────

export const PermissionResponsePayloadSchema = z.object({
  request_id: z.string(),
  approved: z.boolean(),
  decision: PermissionDecisionSchema.optional(),
});

export type PermissionResponsePayload = z.infer<typeof PermissionResponsePayloadSchema>;

// ─── Permission Reset Session (Backend → Daemon) ─────────────────────

export const PermissionResetSessionPayloadSchema = z.object({}).passthrough();

export type PermissionResetSessionPayload = z.infer<typeof PermissionResetSessionPayloadSchema>;

// ─── Tool Discovery (Backend → Daemon) ───────────────────────────────

export const ToolDiscoveryPayloadSchema = z.object({
  agent_type: z.string().optional(),
});

export type ToolDiscoveryPayload = z.infer<typeof ToolDiscoveryPayloadSchema>;
