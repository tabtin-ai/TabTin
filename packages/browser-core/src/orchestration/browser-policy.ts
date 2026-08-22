/**
 * BR-9 浏览器 action 安全策略——纯判定（electron-free）。
 *
 * 设计正典：docs/agent/browser-br-9-design.md §3.2 接口 / §3.3 判定规则。
 *
 * 只回答 allow / block / confirm 三态，不碰 UI、不触发执行：
 *  - block：受限脚本 / 内容硬红线 / 输出路径越界——confirm 也绕不过。
 *  - confirm：contract policyRisk/risk=write 的写操作（act/eval/cookies.set…），处置交 host。
 *  - allow：contract policyRisk/risk=read 的只读或已批准导航操作。
 *
 * 处置（人机确认 / sandbox）由 host 经 BrowserPolicyHostHooks 注入，本模块只判不处置；
 * 挂 Orchestrator 闸门是 P1，本期（P0）仅提供纯函数 + 单测。
 */

import {
  checkHardlineCommand,
  checkHardlinePath,
  isPathInAllowedRoots,
  normalize,
} from '@tabtin/security-policy'
import { isBlockedScript } from '../url-policy/script-policy'
import { evaluateMediaDownloadGuardrail } from '../resources/media-download-guardrail'
import contractData from '../generated/browser-cli-contract.json'
import { evaluateBrowserDomainAllowlist } from './browser-trust-boundary'

// ── contract risk 读取（仿 capability-matrix 读 generated JSON）────────

/** contract 三档风险（Go RiskRead=""/RiskWrite="write"/RiskDestructive="high-risk-write"）。 */
export type BrowserCommandRisk = 'read' | 'write' | 'high-risk-write'

interface ContractCommand {
  id: string
  path: string
  risk?: string
  policyRisk?: string
  fixedFields?: Record<string, unknown>
}

const CONTRACT_COMMANDS = (contractData as { commands: ContractCommand[] }).commands

const RISK_BY_ID: ReadonlyMap<string, BrowserCommandRisk> = new Map(
  CONTRACT_COMMANDS.map((c) => [c.id, normalizeContractRisk(c.policyRisk ?? c.risk)] as const),
)

const COMMANDS_BY_PATH: ReadonlyMap<string, readonly ContractCommand[]> = (() => {
  const groups = new Map<string, ContractCommand[]>()
  for (const command of CONTRACT_COMMANDS) {
    const list = groups.get(command.path) ?? []
    list.push(command)
    groups.set(command.path, list)
  }
  return groups
})()

const LEGACY_ROUTE_ACTIONS: ReadonlyMap<string, string> = new Map([
  ['/browser/execute', 'eval'],
  ['/browser/download', 'resource.download'],
  ['/browser/download-batch', 'resource.download'],
  ['/browser/download-stream', 'stream.download'],
  ['/browser/parse-m3u8', 'stream.parse'],
])

function normalizeContractRisk(risk: string | undefined): BrowserCommandRisk {
  if (risk === 'write') return 'write'
  if (risk === 'high-risk-write') return 'high-risk-write'
  // ''（Go RiskRead）/ 'read' / 未声明 → read
  return 'read'
}

/**
 * 查 contract 里某 action 的风险档。
 * 未注册的 actionId 按 fail-safe 当 'write'：宁可多敲一次门，也不静默放行未知写操作。
 */
export function getBrowserCommandRisk(actionId: string): BrowserCommandRisk {
  return RISK_BY_ID.get(actionId) ?? 'write'
}

/** 从 browser CLI 路由路径解析稳定 actionId（含 cookies fixedFields 与 legacy alias）。 */
export function resolveBrowserActionIdForPolicy(routeOrPath: string, body: unknown): string | undefined {
  const path = normalizeBrowserPolicyPath(routeOrPath)
  if (!path) return undefined

  const legacy = LEGACY_ROUTE_ACTIONS.get(path)
  if (legacy) return legacy

  const commands = COMMANDS_BY_PATH.get(path)
  if (!commands || commands.length === 0) return undefined
  if (commands.length === 1) return commands[0]?.id

  const record = isRecord(body) ? body : {}
  const fixedMatch = commands.find((command) => fixedFieldsMatch(command.fixedFields, record))
  return fixedMatch?.id
}

/**
 * 收集当前路由会触达的 actionId。`batch` 额外递归收集子动作，供 host 已确认一次后
 * 给 Orchestrator 去重审批；未知子动作保留 fail-safe 的外层 batch actionId。
 */
export function collectBrowserActionIdsForPolicy(routeOrPath: string, body: unknown): string[] {
  const actionId = resolveBrowserActionIdForPolicy(routeOrPath, body)
  if (!actionId) return []
  const ids = new Set<string>([actionId])
  if (actionId === 'batch' && isRecord(body) && Array.isArray(body.actions)) {
    for (const action of body.actions) {
      const childPath = batchActionPath(action)
      if (!childPath) continue
      for (const childId of collectBrowserActionIdsForPolicy(childPath, action)) {
        ids.add(childId)
      }
    }
  }
  return [...ids]
}

/** 路由级 policy 入口：Electron/Daemon CLI middleware 可直接复用同一套纯判定。 */
export function evaluateBrowserRoutePolicy(
  routeOrPath: string,
  body: unknown,
  opts?: EvaluateBrowserActionPolicyOptions,
): BrowserPolicyDecision | null {
  const actionId = resolveBrowserActionIdForPolicy(routeOrPath, body)
  if (!actionId) return null
  return evaluateBrowserActionPolicy(actionId, body, opts)
}

// ── 判定结果 + host 注入接口 ────────────────────────────────────────

export type BrowserPolicyDecision =
  | { action: 'allow' }
  | { action: 'block'; code: 'POLICY_BLOCKED'; message: string; ruleName?: string }
  | { action: 'confirm'; reason: string; detail: string; actionType: string }

export interface BrowserPolicyHostHooks {
  /** confirm 的人机闭环；Electron→ApprovalManager，Daemon CLI→默认 reject。P0 仅定义、不接。 */
  resolveConfirmation?(
    d: Extract<BrowserPolicyDecision, { action: 'confirm' }>,
  ): Promise<boolean>
  getSandboxPolicy?(): Record<string, unknown> | undefined
}

/** evaluateBrowserActionPolicy 的可选上下文。 */
export interface EvaluateBrowserActionPolicyOptions {
  /** eval/execute 的脚本表达式；缺省回落到 body.expression / body.code。 */
  expression?: string
  tabId?: string
  url?: string
  /**
   * 当前页面 URL，仅用于 BR-30 媒体下载护栏的 `cross-origin` 判定（下载目标与页面是否同源）。
   * 缺省则跳过跨站判定——纯函数不猜页面上下文，由 host 在能可靠拿到活跃 tab URL 时注入。
   */
  pageUrl?: string
  /**
   * 输出路径边界判定的工作区根（应为绝对路径）。提供后，落盘到根外 → block；
   * 缺省则跳过边界判定——纯函数不猜工作区，由 host 注入（见模块末尾「已知限制」）。
   */
  workspaceRoots?: readonly string[]
  /**
   * Optional BW-5 domain allowlist. Empty/undefined keeps current behavior.
   * Hosts can reuse evaluateBrowserDomainAllowlist for subresource/WebSocket
   * interception; this action policy covers browser actions that carry a URL.
   */
  allowedDomains?: readonly string[]
}

// ── act 子类型 / 输出字段常量 ───────────────────────────────────────

/** 写敏感的 act 子操作（§3.3）：表单填写 / 键入 / 上传 / 提交，confirm 时在 detail 标注。 */
const SENSITIVE_ACT_TYPES: ReadonlySet<string> = new Set([
  'fill',
  'type',
  'keyPress',
  'upload',
  'submit',
])

/**
 * 任务控制原语豁免（BR-10 job 生命周期管理）：`job.status` / `job.cancel` 不操作页面 / 数据 /
 * cookie，只查询或**取消**一个异步任务——`job.cancel` 是「止损」操作（降低而非增加风险），
 * 不该被安全闸门当 write 弹确认拦（否则 Electron 用户取消下载还要弹窗、无 policy 时被 403）。
 * 故显式 allow（`job.status` 本就 contract read，`job.cancel` contract 标 write 在此豁免）。
 */
const JOB_CONTROL_ACTIONS: ReadonlySet<string> = new Set(['job.status', 'job.cancel'])

/**
 * BR-30 媒体下载护栏覆盖的 action：会把媒体「落盘 / 导入」的下载实质操作。
 *
 * 这些 action 的 contract risk 现状全是 `read`（见 browser-cli-contract.json），故 BR-9 闸门本会
 * 直接 allow——本护栏对它们**额外**做风险信号判定：命中（临时签名 URL / 跨站 / 大文件 / 需会话）
 * → 升级为 `confirm`；未命中则继续走下方 contract risk（read→allow，**零行为变更**，不退化正常采集）。
 *
 * 注意刻意**不改 contract risk**：若把 risk 直接升到 write，所有下载（含同站小图）都会弹确认，
 * 退化正常采集流程；故用「信号驱动的 confirm 升级」只在高风险时确认。
 */
const DOWNLOAD_GUARDED_ACTIONS: ReadonlySet<string> = new Set([
  'resource.download',
  'resource.smart-download',
  'resource.capture',
  'stream.download',
])

/** URL-bearing browser actions that can be checked before execution. */
const URL_GUARDED_ACTIONS: ReadonlySet<string> = new Set([
  'open',
  'nav',
  'resource.download',
  'resource.smart-download',
  'resource.capture',
  'stream.parse',
  'stream.download',
])

/** 落盘字段（§3.3 + daemon evaluateCLIPolicy 同语义并集；save = print/glance 的落盘键）。 */
const OUTPUT_PATH_FIELDS = [
  'output',
  'output_path',
  'outputPath',
  'save',
  'save_path',
  'savePath',
  'filename',
] as const

// ── 纯判定 ─────────────────────────────────────────────────────────

export function evaluateBrowserActionPolicy(
  actionId: string,
  body: unknown,
  opts?: EvaluateBrowserActionPolicyOptions,
): BrowserPolicyDecision {
  return evaluateBrowserActionPolicyInternal(actionId, body, opts, 0)
}

function evaluateBrowserActionPolicyInternal(
  actionId: string,
  body: unknown,
  opts: EvaluateBrowserActionPolicyOptions | undefined,
  depth: number,
): BrowserPolicyDecision {
  const record = isRecord(body) ? body : {}

  // 1) 内容级 block——优先级最高，confirm 绕不过。
  const scriptBlock = evaluateScript(record, opts)
  if (scriptBlock) return scriptBlock

  const pathBlock = evaluateOutputPath(record, opts)
  if (pathBlock) return pathBlock

  const domainBlock = evaluateDomainAllowlist(actionId, record, opts)
  if (domainBlock) return domainBlock

  // 2) batch：组合入口本身会 confirm，但子动作里的 block 规则必须先执行，防止 eval 等绕过。
  if (actionId === 'batch') {
    const batchBlock = evaluateBatchChildren(record, opts, depth)
    if (batchBlock) return batchBlock
    return evaluateBatch(record)
  }

  // 3) act：解析 actions[]（risk=write，恒 confirm，detail 标注敏感子类型）。
  if (actionId === 'act') return evaluateAct(record)

  // 3.5) 任务控制原语（job.status/job.cancel）豁免 → allow（见 JOB_CONTROL_ACTIONS 注释）。
  if (JOB_CONTROL_ACTIONS.has(actionId)) return { action: 'allow' }

  // 3.6) BR-30 媒体下载护栏：下载类 action 命中风险信号（临时签名 URL / 跨站 / 大文件 / 需会话）
  //      → 升级为 confirm；未命中则落到下方 contract risk（read→allow，零行为变更）。
  if (DOWNLOAD_GUARDED_ACTIONS.has(actionId)) {
    const guardrail = evaluateDownloadGuardrail(actionId, record, opts)
    if (guardrail) return guardrail
  }

  // 4) contract risk 兜底。
  const risk = getBrowserCommandRisk(actionId)
  if (risk === 'read') return { action: 'allow' }

  return {
    action: 'confirm',
    reason: '该操作会修改浏览器状态或页面内容，需确认',
    detail: `actionId=${actionId} risk=${risk}`,
    actionType: actionId,
  }
}

function evaluateBatchChildren(
  body: Record<string, unknown>,
  opts: EvaluateBrowserActionPolicyOptions | undefined,
  depth: number,
): Extract<BrowserPolicyDecision, { action: 'block' }> | null {
  if (depth >= 8) {
    return {
      action: 'block',
      code: 'POLICY_BLOCKED',
      message: 'browser batch 嵌套过深，已拒绝执行',
      ruleName: 'batch-depth',
    }
  }
  if (!Array.isArray(body.actions)) return null

  for (const action of body.actions) {
    const childPath = batchActionPath(action)
    if (!childPath) continue
    const childId = resolveBrowserActionIdForPolicy(childPath, action) ?? 'batch.unknown'
    const decision = evaluateBrowserActionPolicyInternal(childId, action, opts, depth + 1)
    if (decision.action === 'block') return decision
  }
  return null
}

function evaluateBatch(
  body: Record<string, unknown>,
): Extract<BrowserPolicyDecision, { action: 'confirm' }> {
  const actionIds = collectBrowserActionIdsForPolicy('/browser/batch', body)
  const childActionIds = actionIds.filter((id) => id !== 'batch')
  const actionSummary =
    childActionIds.length > 0 ? childActionIds.join(', ') : '<无可识别子动作>'

  return {
    action: 'confirm',
    reason: '批量浏览器操作会连续修改页面或浏览器状态，需确认',
    detail: `actionId=batch risk=high-risk-write childActions=[${actionSummary}]`,
    actionType: 'batch',
  }
}

function evaluateScript(
  body: Record<string, unknown>,
  opts?: EvaluateBrowserActionPolicyOptions,
): Extract<BrowserPolicyDecision, { action: 'block' }> | null {
  const expression =
    pickString(opts?.expression) ?? pickString(body.expression) ?? pickString(body.code)
  if (!expression) return null

  if (isBlockedScript(expression)) {
    return {
      action: 'block',
      code: 'POLICY_BLOCKED',
      message: '脚本访问受限浏览器存储 API（cookie/localStorage/sessionStorage/indexedDB）',
      ruleName: 'blocked-script',
    }
  }

  const hit = checkHardlineCommand(expression)
  if (hit.hit) {
    return {
      action: 'block',
      code: 'POLICY_BLOCKED',
      message: hit.description ?? '脚本命中命令硬红线',
      ruleName: hit.pattern,
    }
  }

  return null
}

function evaluateOutputPath(
  body: Record<string, unknown>,
  opts?: EvaluateBrowserActionPolicyOptions,
): Extract<BrowserPolicyDecision, { action: 'block' }> | null {
  const raw = firstString(body, OUTPUT_PATH_FIELDS)
  if (!raw) return null

  const normalized = normalize(raw).path
  if (!normalized) return null

  // 系统目录写红线（与文件类写同语义）。
  const hit = checkHardlinePath(normalized, 'file')
  if (hit.hit) {
    return {
      action: 'block',
      code: 'POLICY_BLOCKED',
      message: hit.description ?? '输出路径命中系统目录硬红线',
      ruleName: hit.pattern,
    }
  }

  // 工作区边界：提供 roots 时，落盘到根外 → block。
  const roots = opts?.workspaceRoots
  if (roots && roots.length > 0) {
    const normalizedRoots = roots.map((r) => normalize(r).path).filter(Boolean)
    if (!isPathInAllowedRoots(normalized, normalizedRoots)) {
      return {
        action: 'block',
        code: 'POLICY_BLOCKED',
        message: `输出路径越出工作区边界: ${raw}`,
        ruleName: 'path-out-of-workspace',
      }
    }
  }

  return null
}

function evaluateDomainAllowlist(
  actionId: string,
  body: Record<string, unknown>,
  opts?: EvaluateBrowserActionPolicyOptions,
): Extract<BrowserPolicyDecision, { action: 'block' }> | null {
  if (!opts?.allowedDomains || opts.allowedDomains.length === 0) return null
  if (!URL_GUARDED_ACTIONS.has(actionId)) return null

  const url =
    pickString(opts.url) ??
    pickString(body.url) ??
    pickString(body.targetUrl) ??
    pickString(body.target_url) ??
    pickString(body.href)
  if (!url) return null

  const decision = evaluateBrowserDomainAllowlist({
    url,
    allowedDomains: opts.allowedDomains,
    kind: actionId === 'open' || actionId === 'nav' ? 'navigation' : 'subresource',
  })
  if (decision.action === 'allow') return null
  return {
    action: 'block',
    code: decision.code,
    message: decision.message,
    ruleName: decision.ruleName,
  }
}

/**
 * BR-30 媒体下载护栏：对下载类 action，从请求体 + opts 收集可观测信号（下载 URL / 已知字节数 /
 * 当前页面 URL / 需会话），交纯判定函数 {@link evaluateMediaDownloadGuardrail}。命中风险 →
 * 返回 confirm（detail 带命中的信号 + 是否建议异步）；未命中 → 返回 `null` 让调用方继续走
 * contract risk（read→allow，零行为变更）。
 *
 * 闸门此处只取**执行前可得**的信号：URL 自身的临时签名特征、body 显式 size、以及 host 注入
 * pageUrl 后的跨站判定。size / cross-origin 多数情况下要等执行时才有更准的值——更深的护栏
 * （拿到 content-length / 选中目标后再判）留各端下载 hook，见方案文档。
 */
function evaluateDownloadGuardrail(
  actionId: string,
  body: Record<string, unknown>,
  opts: EvaluateBrowserActionPolicyOptions | undefined,
): Extract<BrowserPolicyDecision, { action: 'confirm' }> | null {
  const result = evaluateMediaDownloadGuardrail({
    url: pickString(body.url) ?? pickString(body.targetUrl) ?? pickString(body.target_url),
    pageUrl: opts?.pageUrl,
    size:
      pickNumber(body.size) ??
      pickNumber(body.contentLength) ??
      pickNumber(body.content_length),
    requiresSession: body.requiresSession === true || body.requires_session === true,
  })
  if (!result.requiresConfirm) return null

  const detailParts = [
    `actionId=${actionId}`,
    `risk=${getBrowserCommandRisk(actionId)}`,
    `guardrail=[${result.signals.join(', ')}]`,
  ]
  if (result.suggestAsync) detailParts.push('suggestAsync=true')

  return {
    action: 'confirm',
    reason: `媒体下载命中风险信号（${result.reasons.join('；')}），需确认`,
    detail: detailParts.join(' '),
    actionType: actionId,
  }
}

function evaluateAct(
  body: Record<string, unknown>,
): Extract<BrowserPolicyDecision, { action: 'confirm' }> {
  const actions = Array.isArray(body.actions) ? body.actions : []
  const types = actions
    .map((a) => (isRecord(a) ? pickString(a.type) : undefined))
    .filter((t): t is string => !!t)
  const sensitive = [...new Set(types.filter((t) => SENSITIVE_ACT_TYPES.has(t)))]

  const detail = types.length > 0 ? `act: ${types.join(', ')}` : 'act: <空 actions>'
  const reason =
    sensitive.length > 0
      ? `页面写操作含敏感子动作（${sensitive.join(', ')}），需确认`
      : '页面写操作（act），需确认'

  return { action: 'confirm', reason, detail, actionType: 'act' }
}

// ── 小工具 ─────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function pickNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function firstString(
  body: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  for (const f of fields) {
    const s = pickString(body[f])
    if (s) return s
  }
  return undefined
}

function normalizeBrowserPolicyPath(routeOrPath: string): string | undefined {
  if (!routeOrPath) return undefined
  const withoutQuery = routeOrPath.split('?')[0] || ''
  if (!withoutQuery.startsWith('/browser/')) return undefined
  return withoutQuery.replace(/\/+$/, '') || '/browser'
}

function fixedFieldsMatch(
  fixedFields: Record<string, unknown> | undefined,
  body: Record<string, unknown>,
): boolean {
  if (!fixedFields || Object.keys(fixedFields).length === 0) return false
  return Object.entries(fixedFields).every(([key, expected]) => body[key] === expected)
}

function batchActionPath(action: unknown): string | undefined {
  if (!isRecord(action)) return undefined
  const rawType = pickString(action.type)
  if (!rawType) return undefined
  const cleaned = rawType.replace(/^\/+/, '')
  return `/browser/${cleaned}`
}
