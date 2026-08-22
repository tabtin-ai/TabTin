import type {
  StreamEvent,
} from '../engine/contracts/wire-protocol.js';
import type {
  EnginePermissionHandler,
  PermissionRequest,
  PermissionDecisionResult,
  PermissionBatchRequest,
  PermissionBatchDecision,
} from '../engine/contracts/hitl.js';
import { ApprovalRequestedPayloadSchema } from '../engine/contracts/approval-requested-schema.js'
import type { DecisionReason } from '../engine/contracts/wire-payloads.js'
import { randomUUID } from 'node:crypto'
import {
  HitlInteractionEvent,
  hitlMessageId,
  type HitlStatus,
} from '../event/events/persist-events.js'
import { EventEmitter } from '../event/event-emitter.js'
import {
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
} from '../event/events/hitl-events.js'
import type { ApprovalMemoStore } from './types.js'
import type { BuildMemoPatternKeyInput } from '../engine/contracts/tool-risk-policy.js'
import { shouldSkipMemoize } from './approval-key.js'
import { deriveTerminalStatus } from './hitl-terminal-status.js'
import { requireAgentRunId } from './hitl-persist.js'

/**
 * （第二刀）：wire decision → hitl_interaction status 的严档映射
 * 已抽到 `hitl-terminal-status.ts`（含语义表、CANCELLED/EXPIRED 集合、
 * `PermissionWireDecisionOutcome` 类型）。本文件的 `requestPermissionsBatch`
 * 只消费 `deriveTerminalStatus(wireDecisions)`，pending → resolved/cancelled/
 * expired 分档在同一处收敛，杜绝旧实装始终写 'resolved' 导致的消息终态漂移。
 */

const SUMMARY_MAX = 2000

/**
 * v0.4：按 runtime_mode 推断超时（PRD §6.7.4）。
 *
 * 表格语义：
 *   interactive → 30 min（用户接电话回来不被误 deny）
 *   solo        → 7 day（持久化审批，等用户离线后回来批）
 *   scheduled   → 0（自动化无人介入，立即超时 deny / fail-fast）
 *   batch       → 24 hour（批处理任务首批审批后走 ALWAYS memo）
 *
 * 注意：超时仅是 runtime 内部 promise reject 的兜底；UI 倒计时按 wire 协议
 * `expires_at` 字段渲染（与 §6.7.4 表对齐）。
 *
 *  跨模块说明：interactive 模式 runtime 侧 30 min 是正确语义；Electron
 * `ApprovalManager` 另有 120s 进程内超时（apps/tabtin-electron，本包不碰）。
 * 用户在 120s–30min 窗口内点批准可能已被 Electron 侧 cancel，需 Electron 对齐
 * 30 min 才能端到端一致——主修点在 Electron，runtime 侧保持 30 min 不变。
 */
export type RuntimeMode = 'interactive' | 'solo' | 'scheduled' | 'batch'

export function inferTimeoutByRuntimeMode(mode: RuntimeMode | undefined): number {
  switch (mode) {
    case 'solo': return 7 * 24 * 60 * 60 * 1000
    case 'scheduled': return 0
    case 'batch': return 24 * 60 * 60 * 1000
    case 'interactive':
    default: return 30 * 60 * 1000
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

function formatValue(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') {
    const t = value.trim()
    return t.length > 0 ? truncate(t, SUMMARY_MAX) : null
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return truncate(JSON.stringify(value), SUMMARY_MAX)
  } catch {
    return String(value)
  }
}

function pickField(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    if (!(key in obj)) continue
    const formatted = formatValue(obj[key])
    if (formatted) return formatted
  }
  return null
}

function extractCommand(input: unknown): string | undefined {
  if (input === null || input === undefined || typeof input !== 'object') return undefined
  const o = input as Record<string, unknown>
  const val = pickField(o, ['command', 'cmd', 'shell_command', 'shell', 'script'])
  return val ?? undefined
}

function extractOperationSummary(input: unknown): string {
  if (input === null || input === undefined) return '（无具体参数）'

  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        return extractOperationSummary(JSON.parse(trimmed) as unknown)
      } catch {
        /* fall through */
      }
    }
    return truncate(trimmed, SUMMARY_MAX)
  }

  if (typeof input !== 'object') return String(input)

  const o = input as Record<string, unknown>
  const parts = buildOperationSummaryParts(o)

  if (parts.length === 0) {
    try {
      return truncate(JSON.stringify(o), SUMMARY_MAX)
    } catch {
      return '（无法解析参数）'
    }
  }

  return parts.join('\n')
}

const SUMMARY_FIELD_GROUPS: Array<{ label: string; keys: string[] }> = [
  { label: '命令', keys: ['command', 'cmd', 'shell_command', 'shell', 'script'] },
  { label: '路径', keys: ['path', 'file_path', 'filepath', 'target_file', 'file', 'uri', 'destination'] },
  { label: '地址', keys: ['url', 'href'] },
  // search_term 是 web_search / 通用搜索类工具的 canonical 字段；不加这一项，
  // description 会落成整段 JSON（参见 W4 dogfood 三视角 review 反馈）。
  { label: '查询', keys: ['query', 'search_query', 'search_term', 'prompt', 'question', 'input'] },
  { label: '模式', keys: ['pattern', 'regex', 'glob', 'include', 'exclude'] },
]

function buildOperationSummaryParts(o: Record<string, unknown>): string[] {
  const parts: string[] = []
  for (const group of SUMMARY_FIELD_GROUPS) {
    const value = pickField(o, group.keys)
    if (value) parts.push(`${group.label}：${value}`)
  }
  // skill_invoke 的 {skill, args}：skill 是 canonical key，args 是用户原话（最可读）。
  // 不识别会让审批卡片描述落成整段 JSON。
  const skill = pickField(o, ['skill'])
  if (skill) {
    const skillArgs = pickField(o, ['args'])
    parts.push(skillArgs ? `技能：${skill}（${skillArgs}）` : `技能：${skill}`)
  }
  return parts
}

/** 静默判决（auto-approve / judge 短路）单条 audit 决策输入。 */
export interface SilentPermissionAuditDecision {
  requestId: string
  toolCallId: string
  toolName: string
  toolNamespace?: string
  toolInput: unknown
  outcome: 'allow' | 'deny'
  decisionReason: DecisionReason
}

function buildToolInputPreview(input: unknown): string {
  if (input === null || input === undefined) return ''
  if (typeof input === 'string') return truncate(input, SUMMARY_MAX)
  try {
    return truncate(JSON.stringify(input), SUMMARY_MAX)
  } catch {
    return truncate(String(input), SUMMARY_MAX)
  }
}

/** DecisionReason.type → PermissionAudit.source（对齐 Django model SOURCE_CHOICES）。 */
export function mapDecisionReasonToAuditSource(reason: DecisionReason): string {
  return DECISION_REASON_AUDIT_SOURCE[reason.type] ?? 'rule'
}

const DECISION_REASON_AUDIT_SOURCE: Record<string, string> = {
  memo_allow: 'memoization',
  memo_deny: 'memoization',
  memoized_always: 'memoization',
  memoized_thread: 'memoization',
  plan_guard: 'plan_guard',
  plan_blocked: 'plan_guard',
  hardline_block: 'hardline',
  hardline_confirm: 'hardline',
  hardline_command: 'hardline',
  hardline_path: 'hardline',
  skill_not_approved: 'skill_trust',
  skill_trust_downgrade: 'skill_trust',
  classifier_low_confidence: 'classifier',
  classifier_decided: 'classifier',
  user_interactive: 'user_interactive',
}

/**
 * 静默判决 audit：emit `approval_resolved` + `silent=true` passthrough，
 * 由 Django relay_audit_writer 落 PermissionAudit（不经 HITL UI）。
 */
export function emitSilentPermissionAudit(
  emitStreamEvent: ((event: StreamEvent) => void) | undefined,
  params: {
    batchId?: string
    runtimeMode?: RuntimeMode
    decisions: SilentPermissionAuditDecision[]
  },
): void {
  if (!emitStreamEvent || params.decisions.length === 0) return

  const batchId = params.batchId ?? randomUUID()
  const runtimeMode = params.runtimeMode ?? 'interactive'

  try {
    emitStreamEvent(new ApprovalResolvedEvent({
        batch_id: batchId,
        silent: true,
        // 顶层 audit_source 仅取首条兜底——真实映射按每条 decision 的 reason 计算并
        // 随 decision 下发（bugbot 评审  medium：混源批次不能全记成同一 source）。
        // Django _resolve_audit_source 已优先用 decision.decision_reason 逐条映射。
        audit_source: mapDecisionReasonToAuditSource(params.decisions[0]!.decisionReason),
        runtime_mode: runtimeMode,
        schema_version: 1,
        decisions: params.decisions.map((d) => ({
          request_id: d.requestId,
          tool_call_id: d.toolCallId,
          outcome: d.outcome,
          tool_name: d.toolName,
          tool_namespace: d.toolNamespace ?? '',
          tool_input_preview: buildToolInputPreview(d.toolInput),
          decision_reason: d.decisionReason,
          // 每条决策自带 audit_source，供 Django 逐条落库（不再被批次顶层值覆盖）。
          audit_source: mapDecisionReasonToAuditSource(d.decisionReason),
        })),
    }).toStreamEvent())
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[LocalPermissionHandler] silent permission audit emit failed: ${msg}`)
  }
}

function buildHitlUnavailableDenyReason(): DecisionReason {
  return {
    type: 'fallback_preset',
    preset: 'hitl_channel_unavailable',
  }
}

type PermissionWireDecision = {
  tool_call_id?: string
  // 语义分档见 `hitl-terminal-status.ts`（allow/deny → resolved；cancelled →
  // renderer dismiss / mode 切换 / rollback；expired → 服务端过期扫描回灌）。
  outcome?: 'allow' | 'deny' | 'cancelled' | 'expired'
  decision?: 'allow' | 'deny' | 'approve' | 'reject'
  type?: string
  // W2-轮 1：scope / 拒绝消息 / 审批者身份从 wire decisions 透传给 memoStore
  scope?: 'once' | 'thread' | 'always'
  rejection_message?: string
  approver_identity?: { user_id?: string }
  // M4.1 L-W6-24：前端生成的人话标签，随 always 决策写入 memo entry 供 UI 展示
  scope_description?: string
  // M4.2 L-W6-37 close：客户端按 spec 附录 B 生成的 pattern_key
  pattern_key?: string
  decision_kind?: string
}

type PermissionBatchWireResponse = {
  decisions?: PermissionWireDecision[]
}

interface LocalApprovalActionRequest {
  request_id: string
  tool_call_id: string
  tool_name: string
  tool_input: unknown
  decision_reason: DecisionReason
  user_visible_reason?: string
  ask_hint: {
    summary: string
    suggested_scope: 'once'
  }
  allowed_scopes: Array<'once' | 'thread' | 'always'>
  allowed_outcomes: Array<'allow' | 'deny'>
  risk_level: PermissionRequest['riskLevel']
  command?: string
  description: string
  subagent_context?: PermissionRequest['subagentContext']
}

interface PermissionRoutingResult {
  decisions: Map<string, PermissionDecisionResult>
  askQueue: PermissionRequest[]
  silentAuditDecisions: SilentPermissionAuditDecision[]
}

type ApprovalMemoEntry = Parameters<ApprovalMemoStore['putAlways']>[1]

interface ApprovalMemoWrite {
  scope: 'thread' | 'always'
  approvalKey: string
  entry: ApprovalMemoEntry
  toolName: string
}

function toolCallIdForRequest(req: PermissionRequest): string {
  return req.toolCallId ?? req.tool.name
}

function buildPermissionDecisionList(
  requests: PermissionRequest[],
  decisions: Map<string, PermissionDecisionResult>,
  defaultDecision: PermissionDecisionResult,
): PermissionBatchDecision[] {
  return requests.map(r => ({
    toolCallId: toolCallIdForRequest(r),
    decision: decisions.get(toolCallIdForRequest(r)) ?? defaultDecision,
  }))
}

function routePermissionRequests(
  requests: PermissionRequest[],
): PermissionRoutingResult {
  //  Phase 2：legacy `shouldAutoApprove(toolName, permissionMode)` 短路
  // 已删除——判决权威是 judge()（能到达本 handler 的请求都是 judge 判 `ask`
  // 或不走 judge 的冷门直连路径），handler 只负责 emit approval_requested +
  // wait，不再自动批准任何请求。#5393 安全不变量（judge 判 ask 必弹卡）
  // 由此从「硬闸拦短路」升级为「短路不存在」。
  return {
    decisions: new Map<string, PermissionDecisionResult>(),
    askQueue: [...requests],
    silentAuditDecisions: [],
  }
}

function emitSilentAuditsIfAny(
  emitStreamEvent: ((event: StreamEvent) => void) | undefined,
  params: {
    batchId: string
    runtimeMode: RuntimeMode
    decisions: SilentPermissionAuditDecision[]
  },
): void {
  if (params.decisions.length === 0) return
  emitSilentPermissionAudit(emitStreamEvent, {
    batchId: params.batchId,
    runtimeMode: params.runtimeMode,
    decisions: params.decisions,
  })
}

function buildHitlUnavailableDenyAudits(
  askQueue: PermissionRequest[],
  decisions: Map<string, PermissionDecisionResult>,
): SilentPermissionAuditDecision[] {
  const hitlDenyAudits: SilentPermissionAuditDecision[] = []
  for (const r of askQueue) {
    const toolCallId = toolCallIdForRequest(r)
    decisions.set(toolCallId, 'deny')
    hitlDenyAudits.push({
      requestId: randomUUID(),
      toolCallId,
      toolName: r.tool.name,
      toolNamespace: r.tool.toolNamespace,
      toolInput: r.input,
      outcome: 'deny',
      decisionReason: r.decisionReason ?? buildHitlUnavailableDenyReason(),
    })
  }
  return hitlDenyAudits
}

function logUnauditedHitlDenyBatch(
  onLog: ((level: 'info' | 'warn', message: string) => void) | undefined,
  batchId: string,
  hitlDenyAudits: SilentPermissionAuditDecision[],
): void {
  // bugbot 评审  high：没有 relay 通道时至少走 onLog 兜底记录。
  onLog?.(
    'warn',
    `[PermissionAudit] HITL-unavailable deny batch not audited to relay ` +
    `(no emitStreamEvent); batch=${batchId} decisions=` +
    hitlDenyAudits
      .map((d) => `${d.toolName}:${(d.decisionReason as { type?: string })?.type ?? '?'}`)
      .join(','),
  )
}

function denyBatchWhenHitlUnavailable(params: {
  batchId: string
  requests: PermissionRequest[]
  askQueue: PermissionRequest[]
  decisions: Map<string, PermissionDecisionResult>
  emitStreamEvent?: (event: StreamEvent) => void
  runtimeMode: RuntimeMode
  onLog?: (level: 'info' | 'warn', message: string) => void
}): PermissionBatchDecision[] {
  params.onLog?.('warn', `HITL capability not available, denying batch (size=${params.askQueue.length})`)
  const hitlDenyAudits = buildHitlUnavailableDenyAudits(params.askQueue, params.decisions)
  if (params.emitStreamEvent) {
    emitSilentPermissionAudit(params.emitStreamEvent, {
      batchId: params.batchId,
      runtimeMode: params.runtimeMode,
      decisions: hitlDenyAudits,
    })
  } else {
    logUnauditedHitlDenyBatch(params.onLog, params.batchId, hitlDenyAudits)
  }
  return buildPermissionDecisionList(params.requests, params.decisions, 'deny')
}

function buildApprovalActionRequest(req: PermissionRequest): LocalApprovalActionRequest {
  const subRequestId = randomUUID()
  const description = extractOperationSummary(req.input)
  const command = extractCommand(req.input)
  const decisionReason = req.decisionReason ?? {
    type: 'fallback_preset' as const,
    preset: 'legacy_handler',
  }
  return {
    request_id: subRequestId,
    tool_call_id: req.toolCallId ?? subRequestId,
    tool_name: req.tool.name,
    tool_input: req.input,
    decision_reason: decisionReason,
    // ：judge 的人话判决说明透传到 wire。
    ...(req.userVisibleReason ? { user_visible_reason: req.userVisibleReason } : {}),
    ask_hint: {
      summary: description,
      suggested_scope: 'once',
    },
    allowed_scopes: ['once', 'thread', 'always'],
    allowed_outcomes: ['allow', 'deny'],
    risk_level: req.riskLevel,
    // 兼容字段：旧前端按 description / command 渲染时仍能 grep 到
    ...(command !== undefined && { command }),
    description,
    ...(req.subagentContext ? { subagent_context: req.subagentContext } : {}),
  }
}

function buildApprovalActionRequests(askQueue: PermissionRequest[]): LocalApprovalActionRequest[] {
  return askQueue.map(buildApprovalActionRequest)
}

function buildApprovalRequestedPayload(params: {
  batchId: string
  actionRequests: LocalApprovalActionRequest[]
  runtimeMode: RuntimeMode
  timeoutMs: number
  /** ：与 HitlInteractionEvent / ChatMessage.id 同源的稳定 UUID。 */
  messageId: string
}): ReturnType<typeof ApprovalRequestedPayloadSchema.parse> {
  const expiresAt = Date.now() + (params.timeoutMs > 0 ? params.timeoutMs : 0)
  return ApprovalRequestedPayloadSchema.parse({
    batch_id: params.batchId,
    approval_type: 'tool_permission',
    action_requests: params.actionRequests,
    runtime_mode: params.runtimeMode,
    expires_at: expiresAt,
    schema_version: 1,
    message_id: params.messageId,
  })
}

function buildPermissionTimeoutPromise(
  timeoutMs: number,
  runtimeMode: RuntimeMode,
): Promise<never> {
  if (timeoutMs <= 0) {
    return Promise.reject<never>(new Error(`Permission batch fail-fast (mode=${runtimeMode})`))
  }
  return new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`Permission batch timed out (${timeoutMs}ms, mode=${runtimeMode})`)),
      timeoutMs,
    )
  })
}

function parsePermissionBatchResponse(response: unknown): PermissionBatchWireResponse {
  const r = (response ?? {}) as PermissionBatchWireResponse
  if (!Array.isArray(r.decisions) || r.decisions.length === 0) {
    throw new Error(
      `Invalid permission batch response: expected { decisions: [...] }, got ${JSON.stringify(r).slice(0, 200)}`,
    )
  }
  return r
}

function normalizeWireDecision(d: PermissionWireDecision): PermissionDecisionResult {
  // outcome 是 wire 协议 SSoT 字段；decision/type 是前端历史命名 fallback。
  // 'cancelled' / 'expired' 从 engine 的判决角度都是「工具不该跑」→ 归 deny；
  // 但 hitl_interaction 消息状态另外走 `deriveTerminalStatus`（hitl-terminal-status.ts）
  // 保留原语义。
  const raw = d.outcome ?? d.decision ?? (d.type as ('approve' | 'reject') | undefined)
  return (raw === 'allow' || raw === 'approve') ? 'allow' : 'deny'
}


function applyWireDecisions(
  wireDecisions: PermissionWireDecision[],
  decisions: Map<string, PermissionDecisionResult>,
): Map<string, PermissionWireDecision> {
  const wireDecisionByToolCallId = new Map<string, PermissionWireDecision>()
  for (const d of wireDecisions) {
    if (!d.tool_call_id) continue
    decisions.set(d.tool_call_id, normalizeWireDecision(d))
    wireDecisionByToolCallId.set(d.tool_call_id, d)
  }
  return wireDecisionByToolCallId
}

function fillMissingActionDecisions(
  actionRequests: LocalApprovalActionRequest[],
  decisions: Map<string, PermissionDecisionResult>,
): void {
  // 缺省的工具 fail-closed deny（前端漏报某条 decision 不能被解释为"通过"）
  for (const ar of actionRequests) {
    if (!decisions.has(ar.tool_call_id)) {
      decisions.set(ar.tool_call_id, 'deny')
    }
  }
}

function logPermissionUiDecisions(params: {
  actionRequests: LocalApprovalActionRequest[]
  decisions: Map<string, PermissionDecisionResult>
  batchId: string
  onLog?: (level: 'info' | 'warn', message: string) => void
}): void {
  for (const ar of params.actionRequests) {
    const d = params.decisions.get(ar.tool_call_id) ?? 'deny'
    params.onLog?.(
      'info',
      `Permission UI: tool="${ar.tool_name}" risk=${ar.risk_level} batch=${params.batchId} → ${d}`,
    )
  }
}

function resolveMemoApprovalKey(
  askedReq: PermissionRequest,
  actionRequest: LocalApprovalActionRequest,
  wireDecision: PermissionWireDecision | undefined,
  buildMemoPatternKey?: (input: BuildMemoPatternKeyInput) => string,
): string | null | undefined {
  // M4.2 L-W6-37：优先用 wire 上行的 pattern_key（spec 附录 B 形态）。
  if (wireDecision?.pattern_key && wireDecision.pattern_key.length > 0) {
    return wireDecision.pattern_key
  }
  if (shouldSkipMemoize(askedReq.tool, actionRequest.tool_input)) {
    return undefined
  }
  // 无宿主注入的 key 重建器时不写 memo（避免落入 legacy 死 key）。
  if (!buildMemoPatternKey) {
    return undefined
  }
  return buildMemoPatternKey({
    toolName: askedReq.tool.name,
    policyActionKind: askedReq.tool.policyActionKind,
    toolInput: actionRequest.tool_input,
    extractPolicyParams: askedReq.tool.extractPolicyParams,
    decisionReason: askedReq.decisionReason as BuildMemoPatternKeyInput['decisionReason'],
  })
}

function writeApprovalMemoEntries(params: {
  memoStore?: ApprovalMemoStore
  askQueue: PermissionRequest[]
  actionRequests: LocalApprovalActionRequest[]
  wireDecisionByToolCallId: Map<string, PermissionWireDecision>
  decisions: Map<string, PermissionDecisionResult>
  onLog?: (level: 'info' | 'warn', message: string) => void
  buildMemoPatternKey?: (input: BuildMemoPatternKeyInput) => string
}): void {
  if (!params.memoStore) return

  const askByToolCallId = new Map(
    params.askQueue.map(req => [toolCallIdForRequest(req), req] as const),
  )
  for (const ar of params.actionRequests) {
    writeOneApprovalMemoEntry({
      memoStore: params.memoStore,
      actionRequest: ar,
      askedReq: askByToolCallId.get(ar.tool_call_id),
      wireDecision: params.wireDecisionByToolCallId.get(ar.tool_call_id),
      finalOutcome: params.decisions.get(ar.tool_call_id),
      onLog: params.onLog,
      buildMemoPatternKey: params.buildMemoPatternKey,
    })
  }
}

function writeOneApprovalMemoEntry(params: {
  memoStore: ApprovalMemoStore
  actionRequest: LocalApprovalActionRequest
  askedReq: PermissionRequest | undefined
  wireDecision: PermissionWireDecision | undefined
  finalOutcome: PermissionDecisionResult | undefined
  onLog?: (level: 'info' | 'warn', message: string) => void
  buildMemoPatternKey?: (input: BuildMemoPatternKeyInput) => string
}): void {
  const memoWrite = buildApprovalMemoWrite(params)
  if (!memoWrite) return

  try {
    persistApprovalMemoWrite(params.memoStore, memoWrite)
  } catch (err) {
    // 写 memo 失败不影响主流程的 decisions 返回；只 warn 记录
    const msg = err instanceof Error ? err.message : String(err)
    params.onLog?.(
      'warn',
      `[Memo] putAlways/putThread failed for tool=${memoWrite.toolName} scope=${memoWrite.scope}: ${msg}`,
    )
  }
}

function buildApprovalMemoWrite(params: {
  actionRequest: LocalApprovalActionRequest
  askedReq: PermissionRequest | undefined
  wireDecision: PermissionWireDecision | undefined
  finalOutcome: PermissionDecisionResult | undefined
  buildMemoPatternKey?: (input: BuildMemoPatternKeyInput) => string
}): ApprovalMemoWrite | null {
  const scope = normalizeMemoScope(params.wireDecision?.scope)
  if (!scope || !isMemoOutcome(params.finalOutcome) || !params.askedReq) return null

  const approvalKey = resolveMemoApprovalKey(
    params.askedReq,
    params.actionRequest,
    params.wireDecision,
    params.buildMemoPatternKey,
  )
  if (approvalKey === undefined || approvalKey === null) return null

  return {
    scope,
    approvalKey,
    entry: buildApprovalMemoEntry(params.finalOutcome, params.wireDecision),
    toolName: params.actionRequest.tool_name,
  }
}

function normalizeMemoScope(scope: PermissionWireDecision['scope']): 'thread' | 'always' | null {
  return scope === 'thread' || scope === 'always' ? scope : null
}

function isMemoOutcome(outcome: PermissionDecisionResult | undefined): outcome is 'allow' | 'deny' {
  return outcome === 'allow' || outcome === 'deny'
}

function buildApprovalMemoEntry(
  finalOutcome: 'allow' | 'deny',
  wireDecision: PermissionWireDecision | undefined,
): ApprovalMemoEntry {
  const now = Date.now()
  return {
    decision: finalOutcome,
    createdAt: now,
    updatedAt: now,
    approverUserId: wireDecision?.approver_identity?.user_id,
    reason: wireDecision?.rejection_message,
    ...(wireDecision?.scope_description
      ? { scope_description: wireDecision.scope_description }
      : {}),
  }
}

function persistApprovalMemoWrite(
  memoStore: ApprovalMemoStore,
  memoWrite: ApprovalMemoWrite,
): void {
  if (memoWrite.scope === 'always') {
    memoStore.putAlways(memoWrite.approvalKey, memoWrite.entry)
  } else {
    memoStore.putThread(memoWrite.approvalKey, memoWrite.entry)
  }
}

function markActionRequestsDenied(
  actionRequests: LocalApprovalActionRequest[],
  decisions: Map<string, PermissionDecisionResult>,
): void {
  for (const ar of actionRequests) {
    if (!decisions.has(ar.tool_call_id)) {
      decisions.set(ar.tool_call_id, 'deny')
    }
  }
}

function emitApprovalResolvedEvent(params: {
  emitStreamEvent?: (event: StreamEvent) => void
  askQueueLength: number
  batchId: string
  runtimeMode: RuntimeMode
  actionRequests: LocalApprovalActionRequest[]
  decisions: Map<string, PermissionDecisionResult>
  /**
   * 本轮 hitl_interaction 消息终态（`deriveTerminalStatus` 派发，见 hitl-terminal-status.ts）。
   * 'cancelled' / 'expired' 时整批 `payload.decisions[*].outcome` 归一到该值，
   * 让 Django `mark_tool_approval_resolved_from_payload` 侧推出的
   * PendingInteraction.status 与 ChatMessage.metadata.hitl.status 对齐。
   */
  terminalStatus: Extract<HitlStatus, 'resolved' | 'cancelled' | 'expired'>
  onLog?: (level: 'info' | 'warn', message: string) => void
}): void {
  if (!params.emitStreamEvent || params.askQueueLength === 0) return

  try {
    params.emitStreamEvent(new ApprovalResolvedEvent({
        batch_id: params.batchId,
        runtime_mode: params.runtimeMode,
        schema_version: 1,
        decisions: params.actionRequests.map(ar => ({
          request_id: ar.request_id,
          tool_call_id: ar.tool_call_id,
          outcome: params.terminalStatus === 'resolved'
            ? (params.decisions.get(ar.tool_call_id) ?? 'deny')
            : params.terminalStatus,
        })),
    }).toStreamEvent())
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    params.onLog?.('warn', `[#2843] approval_resolved emit failed: batch=${params.batchId} ${msg}`)
  }
}

export interface LocalPermissionHandlerOptions {
  emitStreamEvent?: (event: StreamEvent) => void
  waitForUserInput?: (requestId: string) => Promise<unknown>
  onLog?: (level: 'info' | 'warn', message: string) => void
  /**
   * v0.4：当前 runtime_mode（PRD §6.7.4）。
   *
   * 缺省 `'interactive'`，超时按 30 min。宿主在装配 LocalPermissionHandler
   * 时透传 PromptForwardPayload.runtime_mode，让超时分档生效。
   */
  runtimeMode?: 'interactive' | 'solo' | 'scheduled' | 'batch'
  /**
   * W2-轮 1（PRD 05 v0.4 §6.5 + §7.3）：用户决策回灌时按 scope 写入 memo store。
   *
   * - scope='always' → ``putAlways``（跨会话跨设备的"始终允许/拒绝"，
   *   commitAlways 回调由 store 自身上行同步到 Django）
   * - scope='thread' → ``putThread``（本 thread 内复用，纯内存）
   * - scope='once'   → 不写（只本次有效）
   *
   * 缺省（未注入 store）→ 不写入；用于 legacy 没有 pipeline 的宿主（兜底）。
   * 接通后 Layer 4 Memoization 在下次同 approval_key 命中时自动放行。
   */
  memoStore?: ApprovalMemoStore
  /**
   *  Stage 3b：wire 缺 pattern_key 时重建 memo 主键。
   * 由宿主注入（通常为 ToolRiskPolicyPort.buildMemoPatternKey）；未注入则不写 fallback key。
   */
  buildMemoPatternKey?: (input: BuildMemoPatternKeyInput) => string
}

export class LocalPermissionHandler implements EnginePermissionHandler {
  private emitStreamEvent?: (event: StreamEvent) => void
  private waitForUserInput?: (requestId: string) => Promise<unknown>
  private onLog?: (level: 'info' | 'warn', message: string) => void
  private runtimeMode: 'interactive' | 'solo' | 'scheduled' | 'batch'
  private memoStore?: ApprovalMemoStore
  private buildMemoPatternKey?: (input: BuildMemoPatternKeyInput) => string

  constructor(options: LocalPermissionHandlerOptions = {}) {
    this.emitStreamEvent = options.emitStreamEvent
    this.waitForUserInput = options.waitForUserInput
    this.onLog = options.onLog
    this.runtimeMode = options.runtimeMode ?? 'interactive'
    this.memoStore = options.memoStore
    this.buildMemoPatternKey = options.buildMemoPatternKey
  }

  /**
   * v0.4 W1.5（PRD 05 §6.7.2 / §6.10）—— **唯一对外接口**。
   *
   * 行为（ Phase 2 起 handler 不再自动批准任何请求——判决权威是 judge()）：
   *   1. 全部请求一次 emit `agent.stream.approval_requested`（payload.action_requests 含 N 条）
   *   2. 一次 await `waitForUserInput(batchId)` 拿响应；响应 schema 见 PRD §7.4 LocalRtUserResponsePayload
   *   3. 按 toolCallId 把 decisions 分发回各请求；缺省的工具默认 deny（fail-closed）
   *
   * 超时按 `runtimeMode` 分档（详见 §6.7.4）。emit/wait 缺失时整批 deny。
   *
   * 单工具退化为 N=1 的 batch（`tool-orchestration.executeSingleTool` 走同一接口）。
   * 旧 `requestPermission(single)` 接口已按 D6 一刀切删除，未上线项目不留过渡形态。
   */
  async requestPermissionsBatch(
    request: PermissionBatchRequest,
  ): Promise<PermissionBatchDecision[]> {
    const { batchId, requests } = request
    const agentRunId = requireAgentRunId(
      request.agentRunId,
      'LocalPermissionHandler.requestPermissionsBatch',
    )
    if (requests.length === 0) return []

    const { decisions, askQueue, silentAuditDecisions } = routePermissionRequests(
      requests,
    )
    emitSilentAuditsIfAny(this.emitStreamEvent, {
      batchId,
      runtimeMode: this.runtimeMode,
      decisions: silentAuditDecisions,
    })

    if (askQueue.length === 0) {
      // 全部自动批准；按 requests 顺序返回
      return buildPermissionDecisionList(requests, decisions, 'allow')
    }

    // Phase 2：HITL 通道缺失 → 整批 deny（不能静默放行）
    if (!this.emitStreamEvent || !this.waitForUserInput) {
      return denyBatchWhenHitlUnavailable({
        batchId,
        requests,
        askQueue,
        decisions,
        emitStreamEvent: this.emitStreamEvent,
        runtimeMode: this.runtimeMode,
        onLog: this.onLog,
      })
    }

    // Phase 3：构造 action_requests 数组（每条独立的 request_id）
    // v0.4：字段满足 ApprovalActionRequestSchema（必填 decision_reason / allowed_*）。
    //
    // L-W6-16（2026-05-03 W6 M4）：decision_reason **优先取 req.decisionReason**
    // （上游 judge / pipeline 透传的真实判决理由）。旧 hardcode
    // `{ type: 'fallback_preset', preset: 'legacy_handler' }` 是 W3 时期 W6 v3
    // 主路径还没打通时的兜底——会让 35 条 sensitive 模式 + workspace/memo/yolo
    // 的 path/category/pattern/key 等关键字段在 UI 全部降级为含糊文案。
    //
    // 只有 `decisionReason` 缺失时才回退到 `fallback_preset`（保留此兜底是为了
    // 冷门 legacy 路径，譬如宿主绕过 `user-interactive-bridge` 直连 handler 的场景，
    // 或老 API 客户端没填 reason 的兼容形态）。
    const actionRequests = buildApprovalActionRequests(askQueue)

    // Phase 4：一次 emit batch 事件 + 一次 await 响应
    // v0.4 W1.5：emit 切到 APPROVAL_REQUESTED；payload 是 batch schema
    // （ApprovalRequestedPayloadSchema），前端按 batch_id + action_requests[] 渲染
    const timeoutMs = inferTimeoutByRuntimeMode(this.runtimeMode)

    // ：卡片事件与 hitl_interaction 落库共用同一 message_id（在铸造
    // batchId 的同作用域一次算出），前端/通知/around= 不再依赖 hitl-review-* 合成 ID。
    const messageId = hitlMessageId('tool_approval', batchId)

    // L1.5-1-B：emit 前过 ApprovalRequestedPayloadSchema.parse 运行时验证（防御性）。
    // parse 失败说明 actionRequests 构造时有 schema drift（譬如新增字段忘了同步），
    // 立即抛出比静默 emit 错误事件给客户端要安全得多——客户端解析错误事件最多
    // fallback 为"原始"渲染，但服务端这层应该 fail-fast 暴露问题。
    const parsedPayload = buildApprovalRequestedPayload({
      batchId,
      actionRequests,
      runtimeMode: this.runtimeMode,
      timeoutMs,
      messageId,
    })

    this.emitStreamEvent(new ApprovalRequestedEvent(
      parsedPayload as Record<string, unknown>,
    ).toStreamEvent())

    // HITL transcript（pending）：与审批卡片对称，走同一条 persist 管线
    // （buildHitlInteractionPersistEvent → 同 emitter → host eventInterceptor →
    // jsonl + Django），本机会话冷启动 / 换端可恢复审批面板。
    const hitlExpiresAtMs = typeof (parsedPayload as { expires_at?: unknown }).expires_at === 'number'
      ? (parsedPayload as { expires_at: number }).expires_at
      : Date.now() + timeoutMs
    new EventEmitter(this.emitStreamEvent).emit(new HitlInteractionEvent({
      kind: 'tool_approval',
      requestKey: batchId,
      status: 'pending',
      payload: parsedPayload as Record<string, unknown>,
      agentRunId,
      expiresAtMs: hitlExpiresAtMs,
      messageId,
    }))

    const timeoutPromise = buildPermissionTimeoutPromise(timeoutMs, this.runtimeMode)

    // 本轮 hitl_interaction 终态 status；默认 'resolved'，catch 走 'expired'，
    // cancelled 由 `deriveTerminalStatus` 上翻——语义见 `hitl-terminal-status.ts`。
    let terminalStatus: Extract<HitlStatus, 'resolved' | 'cancelled' | 'expired'> = 'resolved'

    try {
      const response = await Promise.race([
        this.waitForUserInput(batchId),
        timeoutPromise,
      ])
      // v0.4 W1.5（PRD §7.4 LocalRtUserResponsePayload）：响应 schema 严格走 batch 形态
      // —— { batch_id, decisions: [{ request_id, tool_call_id, outcome, scope?, rejection_message? }] }。
      //
      // L1.5-1-D（轮 3 顺手清）：v0.3a 的 `{ approved: bool }` 整批同决策格式按 D6 直接删除，
      // 不再 fallback——前端 / mobile 端 / WS gateway 必须都升 batch decisions[] schema。
      // 字段名同时兼容 'allow'/'deny'（wire 协议）与 'approve'/'reject'（前端历史命名），
      // 这是命名偏好分歧而非协议形态分歧，不算 D6 违例。
      const r = parsePermissionBatchResponse(response)
      // 先按原始 wire decisions 推终态（保留 cancelled/expired 语义），
      // 之后 `applyWireDecisions` 会把 cancelled/expired 都归成 engine 侧的
      // 'deny'（因为工具不该跑）——两条链路必须先严档、后归 deny，顺序不可换。
      terminalStatus = deriveTerminalStatus(r.decisions)
      // 维护 toolCallId → 完整 wire decision 的索引，以便 Phase 4.5 写 memoStore 时取
      // scope / approver / rejection_message
      const wireDecisionByToolCallId = applyWireDecisions(r.decisions!, decisions)
      fillMissingActionDecisions(actionRequests, decisions)

      // 日志（按 toolCallId 单条记录）
      logPermissionUiDecisions({
        actionRequests,
        decisions,
        batchId,
        onLog: this.onLog,
      })

      // Phase 4.5（W2-轮 1 + M4.2 L-W6-37 close）：按 scope 把决策写入 ApprovalMemoStore
      //
      // 接通点（PRD §7.3）：
      //   - scope='always' → putAlways（commitAlways 回调由 store 上行同步到 Django）
      //   - scope='thread' → putThread（纯内存，本 thread 内 Layer 4 命中）
      //   - scope='once'   → 不写
      //
      // 跨设备同步北极星（§1.3）：用户在 Desktop A 点"总是同意 npm install" →
      // 这里调 putAlways → store.commitAlways 回调把决策上行到 Django
      // Agent.agent_config.approval_memo → Django 广播 approval_memo_updated →
      // Desktop B 的 store maybeRefetch 拉到新 always entry → 下次 npm install
      // judge.lookupMemo 命中 memo_allow → 自动放行不弹审批。
      //
      // ── M4.2 L-W6-37 close · key 来源切换 ──────────────────────────────
      //
      // 历史 bug：原本 putAlways 的 key 走 `memoization-layer.buildApprovalKey(tool, input)`
      // —— 形态 `<ns>::<tool.name.toLowerCase()>::<stableJsonStringify(input)>`，
      // 而 W6 v3 主路径 `judge.ts → JudgeMemoStoreAdapter.lookup → lookupMemo
      // (pattern-key.ts)` 用 spec 附录 B 形态 `<tool>::<subcmd>:<scope>` 查找。
      // 两套 key 空间永不相交 → memo 永远 miss → 用户点"一直允许"实际下次仍 ask。
      // 全 production tool 都没实装 `getApprovalKey`（grep 验证），fallback 100%
      // 退化到 stableJsonStringify(input)，bug 必然触发。
      //
      // M4.2 修法：**优先消费 wire `decisions[].pattern_key`**（Electron M4.1 +
      // iOS/Android M4.2 已在客户端按附录 B 算好上行）。runtime 直接拿来作 key，
      // 跟 judge.lookup 用的 lookupMemo scoped key 字面对齐——下次同 toolName +
      // subcmd + workspace 状态再调，scoped 命中 → memo_allow + scope_description
      // 透传。这是修法路径 ① "消费 wire pattern_key"，比路径 ② "给 12+ production
      // tool 实装 getApprovalKey" 改动面小 50 倍。
      //
      // fallback 含义：客户端**没传** pattern_key 时由宿主注入的
      // `buildMemoPatternKey` 按 tool+input 重建，与 judge.lookup
      // 的 exact key 空间对齐。未注入则跳过写 memo，避免 legacy 死 key。
      writeApprovalMemoEntries({
        memoStore: this.memoStore,
        askQueue,
        actionRequests,
        wireDecisionByToolCallId,
        decisions,
        onLog: this.onLog,
        buildMemoPatternKey: this.buildMemoPatternKey,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.onLog?.('warn', `Permission batch denied (timeout/error, size=${askQueue.length}): ${msg}`)
      markActionRequestsDenied(actionRequests, decisions)
      // timeout / 宿主 reject（scheduled 模式 fail-fast）都归 'expired'——
      // 与 ask-tools timeout 分支同语义（「交互无答案终结」）。
      terminalStatus = 'expired'
    }

    // ：交互式审批终态回流。用户判决（或超时→整批 deny）后补发一条
    // **非 silent** approval_resolved 经 relay 转发——让 Django
    // mark_tool_approval_resolved 落 PG 终态、relay_audit_writer 从 interrupt_state
    // 缓存补齐 decision_reason 落 PermissionAudit，并 reliable 重广播到 topic，
    // 观察镜像 / 其它端 / 遥控器据此关面板。补上「本地 IPC 判决只在内存 resolve、
    // 服务端 pending 永不收口」的缺口（本地路径 Django 从未被通知）。
    //
    // 与 emitSilentPermissionAudit 区分：silent=true 只落审计、relay_handler 显式
    // 跳过 pending 状态变更；此处是真实用户判决，必须收口 pending。
    // 与 localrt_user_response._publish_approval_resolved_to_mirror 同形态——跨端
    // 场景下两份副本按 batch_id / request_id 幂等去重（该处注释已预期本转发副本）。
    emitApprovalResolvedEvent({
      emitStreamEvent: this.emitStreamEvent,
      askQueueLength: askQueue.length,
      batchId,
      runtimeMode: this.runtimeMode,
      actionRequests,
      decisions,
      terminalStatus,
      onLog: this.onLog,
    })

    // HITL transcript（终态）：与上面 pending 同 message_id（ 显式复用），
    // upsert 后 renderer 据 status 关面板。status 分档见 `hitl-terminal-status.ts`：
    // allow/deny → 'resolved'；cancelled resolver → 'cancelled'；超时 / 宿主 reject → 'expired'。
    new EventEmitter(this.emitStreamEvent).emit(new HitlInteractionEvent({
      kind: 'tool_approval',
      requestKey: batchId,
      status: terminalStatus,
      payload: parsedPayload as Record<string, unknown>,
      agentRunId,
      expiresAtMs: hitlExpiresAtMs,
      result: { decisions: Object.values(decisions) },
      resolvedAtMs: Date.now(),
      messageId,
    }))

    // Phase 5：按 requests 顺序返回 decisions
    return buildPermissionDecisionList(requests, decisions, 'deny')
  }
}
