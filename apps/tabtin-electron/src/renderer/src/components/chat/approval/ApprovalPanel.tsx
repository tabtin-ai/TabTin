import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, FolderPlus } from 'lucide-react'
import { cn } from '@utils/cn'
import type { CliSpecForUI, ReviewConfig } from '@tabtin/chat-client'
import {
  normalizeToRegistrationRiskLevel,
  type DecisionReason,
  type ToolRegistrationRiskLevel,
} from '@tabtin/agent-wire'
import { HitlResourceLabel } from '../../permission/HitlResourceLabel'
import { formatApprovalDetailLines, parseApprovalDetail } from '../../sandbox/approvalDetailFormat'
import { ApprovalTierUpgradeButton } from './ApprovalTierUpgradeButton'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import { useSpaceStore } from '@stores/useSpaceStore'
import { getToolDisplayName } from '../registry/toolDisplayName'
import { getToolRiskLevel } from '../registry/toolCardRegistry'
import { scrollToToolCall } from '../tool/scrollToToolCall'
import { toast } from '@tabtin/smartsheet-ui/toast'
import { UNKNOWN_WORKSPACE_OUT_PATH } from '@tabtin/security-policy/approval-contract'

export type ApprovalScope = 'once' | 'thread' | 'always'

export interface ApprovalSubagentContext {
  parent_tool_call_id: string
  subagent_run_id?: string
  label?: string
}

export interface ApprovalActionItem {
  request_id?: string
  tool_call_id?: string
  name?: string
  tool_name?: string
  description?: string
  arguments?: Record<string, unknown>
  args?: Record<string, unknown>
  cli_spec?: CliSpecForUI
  decision_reason?: { type?: string } & Record<string, unknown>
  /** ：judge 人话判决说明；reason type 无 i18n 文案时兜底渲染（不再裸奔 raw type） */
  user_visible_reason?: string
  ask_hint?: { summary?: string; suggested_scope?: ApprovalScope } & Record<string, unknown>
  allowed_scopes?: ApprovalScope[]
  allowed_outcomes?: Array<'allow' | 'deny'>
  /** Wire 低/中/高 或注册表 safe/review/strict；展示层归一后对齐工具卡片 */
  risk_level?: ToolRegistrationRiskLevel | 'low' | 'medium' | 'high' | 'safe' | 'review' | 'strict'
  workspace_zone?: 'inside' | 'outside' | 'sensitive'
  /** 子 Agent HITL 来源（wire subagent_context；#2579） */
  subagent_context?: ApprovalSubagentContext
}

export interface PerToolApprovalDecision {
  request_id?: string
  tool_call_id?: string
  decision: 'approve' | 'reject'
  scope: ApprovalScope
  rejection_message?: string
  pattern_key?: string
  scope_description?: string
  decision_kind?: 'exact' | 'pattern'
}

interface ApprovalPanelProps {
  actionRequests: ApprovalActionItem[]
  onSubmit: (decisions: PerToolApprovalDecision[]) => void
  /** 当前审批所属会话；就地升档按钮需要它读写会话审批档。 */
  sessionId?: string | null
  isSubmitting?: boolean
  message?: string
  reviewConfigs?: ReviewConfig[]
  submitError?: string
  interruptedAt?: number
  approvalTtlSeconds?: number
  expiresAt?: number
  runtimeMode?: 'interactive' | 'solo' | 'scheduled' | 'batch'
  canResolve?: boolean
  /**
   * panel：详情面板本身负责允许/拒绝；external：详情只读，决策由外部 Dock 负责。
   * 用单一动作归属避免同一审批同时出现两套“允许”按钮。
   */
  decisionSurface?: 'panel' | 'external'
  teamSpaceWaiting?: boolean
  executionOwnerName?: string
  onExpired?: () => void
  /**
   * ：手动放弃审批恢复输入。仅在 submitError 存在且未过期时渲染按钮。
   * 触发源是用户点击"放弃审批"——和 onExpired（倒计时归零自动）语义不同，
   * 但调用方通常都路由到同一个 dismissApprovalForSession。
   */
  onDismiss?: () => void
  /**
   * 「一直允许」是否提供 exact / pattern 颗粒度下拉。
   *
   * Agent 工具审批（默认 true）：exact「仅此命令」与 pattern「同类+工作区内」有真实
   * 区别（key 精确到命令 vs 同类限工作区）。
   * 平台 / 远程审批（false）：粒度只有 actionType 级，两档效果相同——收成单个
   * 「一直允许」按钮，避免呈现无意义选项。
   */
  supportsAlwaysGranularity?: boolean
}

const REJECTION_MESSAGE_MAX = 500

/* ─── platform / shortcut ─────────────────────────────────────────── */

const IS_MAC = typeof navigator !== 'undefined'
  && /Mac|Macintosh|iPhone|iPad/i.test(navigator.platform || '')

const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl'
const ENTER_LABEL = '↵'

/**
 * 按钮副文本里的快捷键提示。
 *
 * 视觉上是次要信息——但语义上是产品对「键盘可达」的承诺，对应的 keydown
 * handler 必须真实生效，否则等于撒谎。
 *
 * 颜色继承父按钮文字色（`text-current`）再降一档透明度，让同一个组件在三种
 * 按钮上自动适配：
 *   - 白底按钮（拒绝 / 一直允许）→ 灰文字基础上再淡 = 浅灰
 *   - accent 蓝底按钮（这次允许）→ 白文字基础上再淡 = 半透白
 *   - disabled 态 → 一并淡化，不会出现"按钮变灰但快捷键反而显眼"的反差
 *
 * 这种"按钮内副信息"的语言全模块统一走 opacity-60 + currentColor，避免
 * 按 tone 拆三套颜色 token。
 */
const Shortcut: React.FC<{ keys: string }> = ({ keys }) => (
  <span className="ml-1.5 text-current opacity-60 tabular-nums" aria-hidden>
    {keys}
  </span>
)

/** 底部审批按钮：窄面板下禁止压缩/换行，放不下时 flex-wrap 折到下一排。 */
const APPROVAL_ACTION_BTN = cn(
  'inline-flex shrink-0 items-center whitespace-nowrap rounded-md px-3 h-7',
  'text-body transition-colors',
  'disabled:opacity-40 disabled:cursor-not-allowed',
)

/* ─── tool args 摘要（保留 W4 dogfood 防崩逻辑） ────────────────── */

function formatToolArgs(args: Record<string, unknown> | undefined): string | null {
  if (!args || Object.keys(args).length === 0) return null
  const entries = Object.entries(args).slice(0, 3)
  const parts = entries
    .map(([k, v]) => {
      const val = typeof v === 'string' ? v : JSON.stringify(v)
      if (val === undefined || val === null) return null
      const truncated = val.length > 60 ? val.slice(0, 57) + '...' : val
      return `${k}: ${truncated}`
    })
    .filter((entry): entry is string => entry !== null)
  return parts.length > 0 ? parts.join(', ') : null
}

/**
 * 浏览器动作平台审批的 `description` 是 browser-policy 生成的机读 key=value 串
 * （如 `actionId=open risk=write`）。这里复用统一的审批详情格式化逻辑
 * 解析/翻译（`approvalDetailFormat`，依赖 `sandbox` namespace 的 t），把它译成
 * 中文行；无法结构化解析的（如裸 shell 命令）返回 null，交由调用方回落原文。
 */
function formatBrowserApprovalDetail(
  detail: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string[] | null {
  const pairs = parseApprovalDetail(detail)
  const isRawFallback = pairs.length === 1 && pairs[0]?.key === 'raw'
  if (isRawFallback) return null
  return formatApprovalDetailLines(detail, t)
}

/* ─── 结构化参数摘要（可读性重排） ──────────────────────────────
 *
 * 历史问题：后端 extractOperationSummary 把完整参数（路径可达 2000 字的
 * temp 落盘路径 + 大段 question）拼成一个 description 字符串，前端再把它和
 * 工具名挤在同一行 font-mono 里——审批卡片沦为一大坨不可读文本。
 *
 * 现在：tool_input 结构化参数本来就在 wire payload 里（arguments 字段），
 * 直接按语义字段分行渲染：路径中间省略 + title 悬停看全、长文本折叠可展开。
 * 字段词表与后端 extractOperationSummary 保持同一套 canonical keys，
 * 保证「后端能摘要的，前端都能结构化」。description 只在无结构化参数时兜底。
 */

interface ApprovalSummaryField {
  labelKey: string
  labelDefault: string
  value: string
  kind: 'path' | 'code' | 'text'
}

const SUMMARY_FIELD_GROUPS: Array<{
  keys: string[]
  labelKey: string
  labelDefault: string
  kind: ApprovalSummaryField['kind']
}> = [
  { keys: ['command', 'cmd', 'shell_command', 'shell', 'script'], labelKey: 'approval.field.command', labelDefault: '命令', kind: 'code' },
  { keys: ['path', 'file_path', 'filepath', 'target_file', 'file', 'uri', 'destination'], labelKey: 'approval.field.path', labelDefault: '路径', kind: 'path' },
  { keys: ['url', 'href'], labelKey: 'approval.field.url', labelDefault: '地址', kind: 'code' },
  { keys: ['query', 'search_query', 'search_term', 'prompt', 'question', 'input'], labelKey: 'approval.field.query', labelDefault: '查询', kind: 'text' },
  { keys: ['pattern', 'regex', 'glob', 'include', 'exclude'], labelKey: 'approval.field.pattern', labelDefault: '模式', kind: 'code' },
  { keys: ['skill'], labelKey: 'approval.field.skill', labelDefault: 'Skill', kind: 'text' },
]

function summaryFieldValue(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function extractSummaryFields(args: Record<string, unknown> | undefined): ApprovalSummaryField[] {
  if (!args) return []
  const fields: ApprovalSummaryField[] = []
  for (const group of SUMMARY_FIELD_GROUPS) {
    for (const key of group.keys) {
      if (!(key in args)) continue
      const value = summaryFieldValue(args[key])
      if (!value) continue
      fields.push({ labelKey: group.labelKey, labelDefault: group.labelDefault, value, kind: group.kind })
      break
    }
  }
  // skill_invoke 的 args 是用户原话，仅在 skill 字段存在时透出（与后端摘要对齐）
  if (fields.some(f => f.labelKey === 'approval.field.skill')) {
    const skillArgs = summaryFieldValue(args.args)
    if (skillArgs) {
      fields.push({ labelKey: 'approval.field.args', labelDefault: '参数', value: skillArgs, kind: 'text' })
    }
  }
  return fields
}

/** 中间省略：路径这类「头尾都有信息」的字符串，保留开头和结尾、省略中段。 */
const PATH_DISPLAY_MAX = 64

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) * 0.35)
  const tail = max - 1 - head
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

/** 长文本折叠：默认 3 行 line-clamp，超长时提供展开 / 收起。 */
const EXPANDABLE_TEXT_THRESHOLD = 160

const ExpandableText: React.FC<{ text: string; className?: string }> = ({ text, className }) => {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = useState(false)
  const isLong = text.length > EXPANDABLE_TEXT_THRESHOLD || text.split('\n').length > 3
  return (
    <div className={cn('min-w-0', className)}>
      <span
        className={cn(
          'block whitespace-pre-wrap break-words [overflow-wrap:anywhere]',
          isLong && !expanded && 'line-clamp-3',
        )}
      >
        {text}
      </span>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded(prev => !prev)}
          className="mt-0.5 text-caption text-accent hover:underline"
        >
          {expanded
            ? t('approval.collapse', { defaultValue: '收起' })
            : t('approval.expand', { defaultValue: '展开' })}
        </button>
      )}
    </div>
  )
}

const SummaryFieldRow: React.FC<{ field: ApprovalSummaryField }> = ({ field }) => {
  const { t } = useTranslation('chat')
  return (
    <div className="flex items-baseline gap-2 min-w-0 text-caption">
      <span className="shrink-0 text-muted-foreground/60">
        {t(field.labelKey, { defaultValue: field.labelDefault })}
      </span>
      {field.kind === 'path' ? (
        <span
          className="min-w-0 font-mono text-muted-foreground/80 break-all"
          title={field.value}
        >
          {truncateMiddle(field.value, PATH_DISPLAY_MAX)}
        </span>
      ) : (
        <ExpandableText
          text={field.value}
          className={cn(
            'text-muted-foreground/80',
            field.kind === 'code' && 'font-mono',
          )}
        />
      )}
    </div>
  )
}

function normalizePathForDisplay(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/')
  if (normalized.length > 1) return normalized.replace(/\/+$/g, '')
  return normalized
}

function parentDirectoryOfPath(path: string): string {
  const normalized = normalizePathForDisplay(path)
  const idx = normalized.lastIndexOf('/')
  if (idx <= 0) return normalized
  return normalized.slice(0, idx)
}

function basenameOfPath(path: string): string {
  const normalized = normalizePathForDisplay(path)
  return normalized.split('/').filter(Boolean).at(-1) || normalized
}

function workspaceRootFromDecisionReason(reason: ApprovalActionItem['decision_reason']): string | null {
  if (reason?.type !== 'workspace_out' || typeof reason.path !== 'string' || !reason.path.trim()) {
    return null
  }
  const rawPath = normalizePathForDisplay(reason.path)
  if (rawPath === UNKNOWN_WORKSPACE_OUT_PATH) return null
  return reason.kind === 'cwd' ? rawPath : parentDirectoryOfPath(rawPath)
}

export function resolveApprovalWorkspaceZone(
  action: ApprovalActionItem,
): ApprovalActionItem['workspace_zone'] {
  if (
    action.workspace_zone === 'inside'
    || action.workspace_zone === 'outside'
    || action.workspace_zone === 'sensitive'
  ) {
    return action.workspace_zone
  }

  switch (action.decision_reason?.type) {
    case 'workspace_out':
    case 'deny_read_path':
    case 'deny_write_path':
      return 'outside'
    case 'sensitive_in_ask':
    case 'sensitive_out_deny':
      return 'sensitive'
    default:
      return undefined
  }
}

/* ─── countdown ───────────────────────────────────────────────────── */

function useApprovalCountdown(
  interruptedAt: number | undefined,
  ttlSeconds: number | undefined,
  expiresAt: number | undefined,
  onExpired?: () => void,
): { remainingSeconds: number | null; isExpired: boolean } {
  const computeRemaining = useCallback((): number | null => {
    if (expiresAt) return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
    if (interruptedAt && ttlSeconds) {
      const elapsed = (Date.now() / 1000) - interruptedAt
      return Math.max(0, Math.ceil(ttlSeconds - elapsed))
    }
    return null
  }, [expiresAt, interruptedAt, ttlSeconds])

  const [remaining, setRemaining] = useState<number | null>(() => computeRemaining())

  useEffect(() => {
    if (!expiresAt && (!interruptedAt || !ttlSeconds)) return
    const tick = () => {
      const left = computeRemaining()
      setRemaining(left)
      if (left !== null && left <= 0) onExpired?.()
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [computeRemaining, expiresAt, interruptedAt, ttlSeconds, onExpired])

  return { remainingSeconds: remaining, isExpired: remaining !== null && remaining <= 0 }
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `${s}s`
}

/* ─── decision_reason 文案（保留 W6 M4.1 i18n 模板） ──────────── */

function slugToI18nKey(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function useDecisionReasonText(
  reason: ApprovalActionItem['decision_reason'],
  userVisibleReason?: string,
): string | null {
  const { t } = useTranslation('chat')
  if (!reason || typeof reason !== 'object') return null
  const reasonType = typeof reason.type === 'string' ? reason.type : ''
  if (!reasonType) return null

  const r = reason as Record<string, unknown>
  const params: Record<string, string> = {}
  // 完整路径动辄上百字符（temp 落盘路径），插进理由文案会把整行撑爆——
  // 展示层中间省略，完整值由 DecisionReasonRow 的 title 悬停兜底。
  if (typeof r.path === 'string') params.path = truncateMiddle(normalizePathForDisplay(r.path), PATH_DISPLAY_MAX)

  if (typeof r.category === 'string' && r.category) {
    const catKey = `approval.reason.sensitiveCategory.${slugToI18nKey(r.category)}`
    const catLabel = t(catKey, { defaultValue: '' })
    params.category = (catLabel && catLabel !== catKey) ? catLabel : r.category
  }

  if (typeof r.pattern === 'string' && r.pattern) {
    const patKey = `approval.reason.hardlinePattern.${slugToI18nKey(r.pattern)}`
    const patLabel = t(patKey, { defaultValue: '' })
    params.pattern = (patLabel && patLabel !== patKey) ? patLabel : r.pattern
  }

  if (reasonType === 'memo_allow' || reasonType === 'memo_deny') {
    const scopeDesc = typeof r.scope_description === 'string' ? r.scope_description : ''
    const rawKey = typeof r.key === 'string' ? r.key : ''
    params.key = scopeDesc || rawKey
  } else if (typeof r.key === 'string') {
    params.key = r.key
  }

  if (typeof r.server === 'string') params.server = r.server
  if (typeof r.device_action === 'string') params.device_action = r.device_action

  let subKey = reasonType
  const kind = typeof r.kind === 'string' ? r.kind : ''
  if ((reasonType === 'workspace_in' || reasonType === 'workspace_out') && kind === 'cwd') {
    subKey = `${reasonType}_cwd`
  } else if (reasonType === 'mcp_default_ask' && !params.server) {
    subKey = 'mcp_default_ask_no_server'
  } else if (reasonType === 'device_default_ask' && !params.device_action) {
    subKey = 'device_default_ask_no_action'
  }

  const primaryKey = `approval.reason.${subKey}`
  const fallbackKey = `approval.reason.${reasonType}`
  const primary = t(primaryKey, { defaultValue: '', ...params })
  if (primary && primary !== primaryKey) return primary
  const fallback = t(fallbackKey, { defaultValue: '', ...params })
  if (fallback && fallback !== fallbackKey) return fallback
  // ：i18n 未覆盖的 reason type（新增 type 尚未配 locale / 版本混跑）时，
  // 优先渲染 runtime 透传的人话判决说明（judge Decision.userVisibleReason），
  // 最后才裸奔 raw type 字符串（保底可读，Live 取证发现的 UI 缺口）。
  if (userVisibleReason && userVisibleReason.trim()) return userVisibleReason.trim()
  return reasonType
}

const DecisionReasonRow: React.FC<{
  reason: ApprovalActionItem['decision_reason']
  userVisibleReason?: string
}> = ({ reason, userVisibleReason }) => {
  const text = useDecisionReasonText(reason, userVisibleReason)
  if (!text) return null
  const fullPath = typeof reason?.path === 'string' ? reason.path : undefined
  return (
    <p
      className="mt-1 text-caption text-muted-foreground/80 break-words [overflow-wrap:anywhere]"
      title={fullPath}
    >
      {text}
    </p>
  )
}

/**
 * 「高风险操作，请仔细确认」只对**灾难性 / 高危不可逆**操作透出（ 收敛）。
 *
 * 判据是 judge 的判决理由而非名义风险档：注册表 strict（如子 Agent 工具）、
 * wire high 这类"分类学上的高风险"不再整行红字警示——为什么要确认由
 * DecisionReasonRow 的理由文案说明，避免警示疲劳把真正的危险信号淹掉。
 *
 * 命中集合（判据是 judge 的判决理由）：
 *   - hardline_confirm / hardline_command / hardline_path：命中安全红线
 *     （sudo / 关机 / 系统路径等危险命令，deny 兜底展示同理）
 *   - rule_high_risk_allowlist_miss：高风险命令不在允许列表
 *   - destructive_in_workspace_ask：删除类不可逆操作
 *
 * 集合成员类型钉死为 `DecisionReason['type']`（`@tabtin/agent-wire` SSoT）——
 * 后端一旦重命名任一 reason type，这里直接编译报错，而不是让安全红字静默失效。
 */
const STRICT_HINT_REASON_TYPES: ReadonlySet<DecisionReason['type']> = new Set([
  'hardline_confirm',
  'hardline_command',
  'hardline_path',
  'rule_high_risk_allowlist_miss',
  'destructive_in_workspace_ask',
])

export function isApprovalHighRisk(action: ApprovalActionItem): boolean {
  const reasonType = action.decision_reason?.type
  return reasonType != null
    && (STRICT_HINT_REASON_TYPES as ReadonlySet<string>).has(reasonType)
}

/** 归一 wire / 注册表两套词表，与 toolCardRegistry 警示等级对齐。 */
function resolveDisplayRiskLevel(action: ApprovalActionItem): ToolRegistrationRiskLevel | null {
  const fromPayload = normalizeToRegistrationRiskLevel(action.risk_level)
  if (fromPayload) return fromPayload
  const toolName = action.tool_name || action.name
  if (!toolName) return null
  return getToolRiskLevel(toolName)
}

/**
 * 风险提示行：
 * - strict：灾难/不可逆红字（仅配合 showStrictHint）
 * - review：中性「建议确认」——不再写「写操作」（review ≠ 写；shell 只读已降为 low）
 */
const RiskLevelRow: React.FC<{ level: 'strict' | 'review' }> = ({ level }) => {
  const { t } = useTranslation('chat')
  const isStrict = level === 'strict'
  return (
    <p
      className={cn(
        'mt-1 text-caption break-words [overflow-wrap:anywhere]',
        isStrict ? 'text-destructive/80' : 'text-muted-foreground/80',
      )}
      data-testid={isStrict ? 'approval-risk-strict' : 'approval-risk-review'}
    >
      {isStrict
        ? t('approval.riskStrict', { defaultValue: '高风险操作，请仔细确认' })
        : t('approval.riskReview', { defaultValue: '建议确认后再允许' })}
    </p>
  )
}

const SubagentSourceRow: React.FC<{ context: ApprovalSubagentContext }> = ({ context }) => {
  const { t } = useTranslation('chat')
  const label = context.label?.trim()
    || t('approval.subagentSourceFallback', { defaultValue: '子 Agent' })

  const handleClick = useCallback(() => {
    scrollToToolCall(context.parent_tool_call_id, {
      onMissing: () => {
        toast({
          title: t('approval.subagentSourceLocateMissing', {
            defaultValue: '找不到对应工具调用，可能已被清理',
          }),
        })
      },
    })
  }, [context.parent_tool_call_id, t])

  return (
    <button
      type="button"
      onClick={handleClick}
      data-testid="approval-subagent-source"
      className={cn(
        'mt-1 inline-flex items-center text-caption text-accent hover:underline',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 rounded-sm',
      )}
    >
      {t('approval.subagentSource', {
        label,
        defaultValue: '来自子 Agent：{{label}}',
      })}
    </button>
  )
}

/* ─── 主面板 ──────────────────────────────────────────────────── */

export const ApprovalPanel: React.FC<ApprovalPanelProps> = ({
  actionRequests,
  onSubmit,
  sessionId = null,
  isSubmitting = false,
  message,
  reviewConfigs,
  submitError,
  interruptedAt,
  approvalTtlSeconds,
  expiresAt,
  runtimeMode,
  canResolve = true,
  decisionSurface = 'panel',
  teamSpaceWaiting = false,
  executionOwnerName,
  onExpired,
  onDismiss,
  supportsAlwaysGranularity = true,
}) => {
  const { t } = useTranslation('chat')
  // 浏览器动作 detail 的字段/动作/风险译文都在 sandbox namespace（与
  // 平台审批共用一套 approval.detailKeys/browserActions/risks…）。
  const { t: tSandbox } = useTranslation('sandbox')
  const activeSpaceId = useSpaceStore(state => state.selectedSpace?.id)

  const { remainingSeconds, isExpired } = useApprovalCountdown(
    interruptedAt, approvalTtlSeconds, expiresAt, onExpired,
  )

  const [rejectionMessages, setRejectionMessages] = useState<Record<number, string>>({})
  const [showRejectInput, setShowRejectInput] = useState<Record<number, boolean>>({})
  // 「记住」选框：勾选时「允许」按所选范围写记忆（空间内=always / 对话内=thread），
  // 不勾选时等价旧「这次允许」。默认勾选 + 空间内（原「一直允许」推荐档）。
  const [rememberChecked, setRememberChecked] = useState(true)
  const [rememberScope, setRememberScope] = useState<'always' | 'thread'>('always')
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false)
  const scopeMenuRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const configByAction = useMemo(() => {
    if (!reviewConfigs?.length) return null
    const map = new Map<string, ReviewConfig>()
    for (const cfg of reviewConfigs) map.set(cfg.action_name, cfg)
    return map
  }, [reviewConfigs])

  // 兼容字段保留：reviewConfigs / allowed_outcomes 用于将来按条禁用，
  // 当前 UI 仍按"批量提交三档"，未在此 hook 上消费——保留以避免回归。
  const _getAllowedDecisions = useCallback((action: ApprovalActionItem) => {
    if (!configByAction) {
      const outcomes = action.allowed_outcomes
      if (outcomes && outcomes.length > 0) {
        return { canApprove: outcomes.includes('allow'), canReject: outcomes.includes('deny') }
      }
      return { canApprove: true, canReject: true }
    }
    const toolName = action.tool_name || action.name || ''
    const cfg = configByAction.get(toolName)
    if (!cfg) return { canApprove: true, canReject: true }
    return {
      canApprove: cfg.allowed_decisions.includes('approve'),
      canReject: cfg.allowed_decisions.includes('reject'),
    }
  }, [configByAction])
  void _getAllowedDecisions

  const anyRejectShown = Object.values(showRejectInput).some(Boolean)
  const ownsDecision = canResolve && decisionSurface === 'panel'
  const actionsDisabled = isSubmitting || isExpired || !ownsDecision
  const ownerLabel = executionOwnerName?.trim() || t('approval.executionOwnerFallback', { defaultValue: 'Owner' })

  const handleApproveOnce = useCallback(() => {
    if (!canResolve) return
    const result: PerToolApprovalDecision[] = actionRequests.map(action => ({
      request_id: action.request_id,
      tool_call_id: action.tool_call_id,
      decision: 'approve',
      scope: 'once' as ApprovalScope,
    }))
    onSubmit(result)
  }, [actionRequests, canResolve, onSubmit])

  const handleApproveThread = useCallback(() => {
    if (!canResolve) return
    const result: PerToolApprovalDecision[] = actionRequests.map(action => ({
      request_id: action.request_id,
      tool_call_id: action.tool_call_id,
      decision: 'approve',
      scope: 'thread' as ApprovalScope,
    }))
    onSubmit(result)
  }, [actionRequests, canResolve, onSubmit])

  // 平台 / 远程审批：无 exact/pattern 颗粒度，直接一档 always（不带 pattern_key）。
  const handleAlwaysAllowSimple = useCallback(() => {
    if (!canResolve) return
    const result: PerToolApprovalDecision[] = actionRequests.map(action => ({
      request_id: action.request_id,
      tool_call_id: action.tool_call_id,
      decision: 'approve',
      scope: 'always' as ApprovalScope,
    }))
    onSubmit(result)
  }, [actionRequests, canResolve, onSubmit])

  const showThreadScope = useMemo(() => {
    if (actionRequests.length === 0) return true
    return actionRequests.every((action) => {
      const scopes = action.allowed_scopes
      if (!scopes || scopes.length === 0) return true
      return scopes.includes('thread')
    })
  }, [actionRequests])

  const showAlwaysScope = useMemo(() => {
    if (actionRequests.length === 0) return true
    return actionRequests.every((action) => {
      const scopes = action.allowed_scopes
      if (!scopes || scopes.length === 0) return true
      return scopes.includes('always')
    })
  }, [actionRequests])

  const showRememberControls = showThreadScope || showAlwaysScope

  const handleAlwaysAllow = useCallback(async (kind: 'exact' | 'pattern') => {
    if (!canResolve) return
    const secApi = window.tabtin?.agentSecurity
    const scope: 'exact' | 'scoped' = kind === 'pattern' ? 'scoped' : 'exact'

    const result: PerToolApprovalDecision[] = await Promise.all(
      actionRequests.map(async (action) => {
        const toolName = action.tool_name || action.name || 'unknown'
        const toolArgs = action.arguments || action.args || {}
        const inWorkspace = resolveApprovalWorkspaceZone(action) === 'inside'
        const subcmd = typeof toolArgs.command === 'string'
          ? (toolArgs.command.trim().split(/\s+/)[0] ?? '_')
          : '_'

        let patternKey: string | undefined
        let scopeDesc: string | undefined

        if (secApi) {
          try {
            const [key, desc] = await Promise.all([
              secApi.buildApprovalKey({ toolName, subcmd, input: toolArgs, inWorkspace, scope, kind: 'object' }),
              secApi.buildScopeDescription({
                toolName,
                subcmd,
                scope: scope === 'scoped' ? (inWorkspace ? 'workspace-internal' : 'workspace-external') : 'exact',
              }),
            ])
            patternKey = key
            scopeDesc = desc
          } catch { /* best-effort */ }
        }

        return {
          request_id: action.request_id,
          tool_call_id: action.tool_call_id,
          decision: 'approve' as const,
          scope: 'always' as ApprovalScope,
          decision_kind: kind,
          pattern_key: patternKey,
          scope_description: scopeDesc,
        }
      }),
    )
    onSubmit(result)
  }, [actionRequests, canResolve, onSubmit])

  // 「允许」统一出口：按「记住」选框 + 范围下拉分发到三档 scope。
  const handleAllow = useCallback(() => {
    if (!showRememberControls || !rememberChecked) {
      handleApproveOnce()
      return
    }
    if (rememberScope === 'thread' && showThreadScope) {
      handleApproveThread()
      return
    }
    if (showAlwaysScope) {
      if (supportsAlwaysGranularity) void handleAlwaysAllow('pattern')
      else handleAlwaysAllowSimple()
      return
    }
    if (showThreadScope) handleApproveThread()
  }, [
    handleAlwaysAllow,
    handleAlwaysAllowSimple,
    handleApproveOnce,
    handleApproveThread,
    rememberChecked,
    rememberScope,
    showAlwaysScope,
    showRememberControls,
    showThreadScope,
    supportsAlwaysGranularity,
  ])

  // 范围下拉点外部收起
  useEffect(() => {
    if (!scopeMenuOpen) return
    const onMouseDown = (e: MouseEvent) => {
      if (!scopeMenuRef.current?.contains(e.target as Node)) setScopeMenuOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [scopeMenuOpen])

  const handleRejectAll = useCallback(() => {
    if (!canResolve) return
    const result: PerToolApprovalDecision[] = actionRequests.map((action, i) => ({
      request_id: action.request_id,
      tool_call_id: action.tool_call_id,
      decision: 'reject',
      scope: 'once' as ApprovalScope,
      rejection_message: rejectionMessages[i]?.trim() || undefined,
    }))
    onSubmit(result)
  }, [actionRequests, canResolve, rejectionMessages, onSubmit])

  const openRejectInputs = useCallback(() => {
    if (!canResolve) return
    setShowRejectInput(Object.fromEntries(actionRequests.map((_, i) => [i, true])))
  }, [actionRequests, canResolve])

  // 单根契约 §2.4 P0 修复：审批通过的路径**真的要能被 Agent 后续访问**。
  //
  // 历史 bug：旧实现调 `addSpaceFolder({kind:'user'})` 写到 store——但单根
  // 契约下 `notifyWorkspacePathsForSpace` 只读 `agent.working_dir`，**不读**
  // store 里的 user folder。结果 store 多了条数据，但 main 端 allowedPaths
  // 完全没扩；Agent 下次访问该路径仍 `outside_workspace` 被拒。审批面板成了
  // 安慰剂。
  //
  // 现在：通过 `workspace:append-session-allowed-path` IPC 把路径推到 main
  // 端的 `session.workspaceSnapshot.sources.sessionApprovedPaths`，re-derive
  // allowedPaths——session 内 Agent 后续访问全部放行。session 重启失效，需要
  // 重新审批（避免持久化 multi-root 列表，符合单根契约）。
  const handleAddWorkspacePathAndApprove = useCallback((action: ApprovalActionItem, path: string) => {
    if (!canResolve) return
    if (!activeSpaceId || !path) return
    void window.tabtin?.workspace?.appendSessionAllowedPath?.({
      spaceId: activeSpaceId,
      path,
    })
    onSubmit([{
      request_id: action.request_id,
      tool_call_id: action.tool_call_id,
      decision: 'approve',
      scope: 'once' as ApprovalScope,
      decision_kind: 'exact',
      scope_description: path,
    }])
  }, [activeSpaceId, canResolve, onSubmit])

  const handleDenyClick = useCallback(() => {
    if (anyRejectShown) handleRejectAll()
    else openRejectInputs()
  }, [anyRejectShown, handleRejectAll, openRejectInputs])

  /* ── 真实键盘可达 ──
   * `⌘↵` / Ctrl+↵ → Allow（按「记住」选框与范围下拉分发；在 rejection
   *                  textarea 聚焦时也响应，作为 reject 提交）
   * `Esc`         → 第一次按打开 rejection 输入，再次按提交 reject
   *
   * 仅在面板可用时响应（非提交中、未过期），且不与文档级输入流冲突——
   * 为此本 handler 用 capture=false 监听 document.keydown，由 ApprovalPanel
   * 内的目标元素自然冒泡。textarea / input 内会主动 stopPropagation 的场景
   * 不会触发——这是预期行为，让用户能正常编辑文本。
   */
  useEffect(() => {
    if (actionsDisabled) return
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const isInRejectionTextarea = !!(
        target
        && target.tagName === 'TEXTAREA'
        && containerRef.current?.contains(target)
      )
      const isInOtherEditable = !!(
        target
        && !isInRejectionTextarea
        && (
          target.tagName === 'INPUT'
          || target.tagName === 'TEXTAREA'
          || target.isContentEditable
        )
      )

      const mod = IS_MAC ? e.metaKey : e.ctrlKey
      const isEnter = e.key === 'Enter' || e.key === 'Return'

      if (mod && isEnter && !e.shiftKey) {
        if (isInOtherEditable) return
        e.preventDefault()
        if (anyRejectShown) handleRejectAll()
        else handleAllow()
        return
      }
      if (e.key === 'Escape') {
        if (isInOtherEditable) return
        e.preventDefault()
        if (scopeMenuOpen) {
          setScopeMenuOpen(false)
          return
        }
        if (anyRejectShown) handleRejectAll()
        else openRejectInputs()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [
    actionsDisabled,
    anyRejectShown,
    handleAllow,
    handleRejectAll,
    openRejectInputs,
    scopeMenuOpen,
  ])

  const runtimeModeLabel = useMemo(() => {
    if (!runtimeMode) return null
    const i18nKey = `approval.runtimeMode.${runtimeMode}`
    const localized = t(i18nKey, { defaultValue: '' })
    if (localized && localized !== i18nKey) return localized
    switch (runtimeMode) {
      case 'interactive': return '陪跑'
      case 'solo': return '托管'
      case 'scheduled': return '定时'
      case 'batch': return '批处理'
      default: return runtimeMode
    }
  }, [runtimeMode, t])

  /* ── 容器 ──
   * chat-motion-approval-enter 挂在根节点：仅组件首次挂载入场，
   * 内部 state（拒绝输入 / 倒计时 / 记住范围）更新不会 remount，故不重放。
   */
  return (
    <div
      ref={containerRef}
      data-testid="approval-panel"
      className={cn(
        'relative min-w-0 min-h-0 max-h-[min(60vh,32rem)]',
        'rounded-xl bg-background p-4 flex flex-col gap-3',
        'chat-motion-approval-enter',
      )}
      role="group"
      aria-label={decisionSurface === 'external'
        ? t('approval.attentionDock.detailsTitle', { defaultValue: '操作详情' })
        : t('review.title', { defaultValue: '请确认 Agent 操作' })}
    >
      {/* ── 头部 ──
          标题 + 计数（左）；runtime mode + 倒计时（右）。
          已过期态：标题文字色切到 destructive/80，**不**改容器边框/底色——
          色彩作为"点状信号"只落在文字上，与产品整体语言一致。 */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0 flex-1">
          <span
            className={cn(
              'text-body font-medium truncate',
              isExpired ? 'text-destructive/80' : 'text-foreground',
            )}
          >
            {isExpired
              ? t('review.expired', { defaultValue: '审批已过期' })
              : decisionSurface === 'external'
                ? t('approval.attentionDock.detailsTitle', { defaultValue: '操作详情' })
                : t('review.title')}
          </span>
          <span className="text-caption text-muted-foreground/60 tabular-nums shrink-0">
            {t('review.count', { count: actionRequests.length })}
          </span>
        </div>
        <div className="flex items-center gap-3 text-caption text-muted-foreground/60 shrink-0">
          {runtimeModeLabel && <span>{runtimeModeLabel}</span>}
          {remainingSeconds !== null && !isExpired && (
            <span className={cn(
              'tabular-nums',
              remainingSeconds <= 60 && 'text-destructive/80',
            )}>
              {formatCountdown(remainingSeconds)}
            </span>
          )}
        </div>
      </div>

      {decisionSurface === 'external' && (
        <p
          className="text-caption text-muted-foreground/80"
          data-testid="approval-external-decision-hint"
        >
          {t('approval.attentionDock.detailsHint', {
            defaultValue: '此处仅展示操作内容；允许或拒绝请使用下方授权栏。',
          })}
        </p>
      )}

      {/* ── 成员只读态（决策 Q5）──
          Project 里非 execution owner 只看到「正在等待审批」，**不渲染**
          审批消息、工具名、参数、命令等具体内容——这些细节属于 Owner 的执行
          现场。注意这只是展示层收敛：HITL payload 经 agent.stream 广播仍会
          到达成员客户端，网络层过滤是后端的后续增量（见 dev-plan 阶段 2）。 */}
      {!canResolve ? (
        <div
          data-testid="approval-panel-body-readonly"
          className="min-h-0 flex-1 space-y-2"
        >
          <p className="text-body text-muted-foreground/80 min-w-0 break-words [overflow-wrap:anywhere]">
            {t('approval.teamSpaceReadonlyWaiting', {
              owner: ownerLabel,
              defaultValue: 'Agent 请求了需要确认的操作，正在等待 {{owner}} 审批。',
            })}
          </p>
          <p className="text-caption text-muted-foreground/60">
            {isExpired
              ? t('approval.teamSpaceReadonlyExpired', { defaultValue: '审批已过期，可在会话中重新发起任务。' })
              : t('approval.teamSpaceReadonlyHint', { defaultValue: '审批通过后 Agent 会继续执行，结果将同步到这里。' })}
          </p>
        </div>
      ) : (
      <div
        data-testid="approval-panel-body"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1 -mr-1 space-y-3"
      >
        {message && (
          <p className="text-body text-muted-foreground/80 min-w-0 break-words [overflow-wrap:anywhere]">
            {message}
          </p>
        )}
        {teamSpaceWaiting && (
          <p className="text-caption text-muted-foreground/80 min-w-0 break-words [overflow-wrap:anywhere]">
            {t('approval.teamSpaceOwnerAction', {
              owner: ownerLabel,
              defaultValue: 'Project 正在等待 {{owner}} 审批；通过后将继续在 Owner 的工作空间执行。',
            })}
          </p>
        )}

        {/* ── 工具列表 ──
            每条用「浅灰代码块」呈现，呼应 Claude 路径展示的语言。
            不再用 border + bg-muted/10 双层框，减少视觉噪声。 */}
        <div className="space-y-2">
          {actionRequests.map((action, i) => {
            const toolName = action.tool_name || action.name || 'unknown'
            const toolLabel = getToolDisplayName(t, toolName)
            const toolArgs = action.arguments || action.args
            const explanation = toolArgs?.explanation as string | undefined
            const argsWithoutExplanation = toolArgs
              ? Object.fromEntries(Object.entries(toolArgs).filter(([k]) => k !== 'explanation'))
              : undefined
            const argsSummary = formatToolArgs(
              Object.keys(argsWithoutExplanation || {}).length > 0 ? argsWithoutExplanation : undefined,
            )
            const summaryFields = extractSummaryFields(argsWithoutExplanation)
            // 浏览器动作平台审批的 description 是机读 key=value 串（如
            // actionId=open risk=write），先按 sandbox 同款汉化成中文行；detail
            // 只由 browser-policy 生成、且仅在 browser.* 工具时映射进 description，
            // 故此仅对 browser.* 处理，避免误伤其它审批的人话 description。
            const browserDetailLines = summaryFields.length === 0
              && toolName.startsWith('browser.')
              && action.description
              ? formatBrowserApprovalDetail(action.description, tSandbox)
              : null
            // 结构化字段优先；没有可结构化的参数时才回退到后端拼好的 description /
            // 前端 argsSummary（保持旧 payload / 未知工具的兼容展示）。
            const fallbackSummary = summaryFields.length === 0 && !browserDetailLines
              ? (action.description || argsSummary)
              : null
            const workspaceZone = resolveApprovalWorkspaceZone(action)
            const isSensitive = workspaceZone === 'sensitive'
            const isOutside = workspaceZone === 'outside'
            const workspaceOutPath = workspaceRootFromDecisionReason(action.decision_reason)
            const workspaceOutTitle = workspaceOutPath ? basenameOfPath(workspaceOutPath) : null
            // decision_reason 已经用完整句子说明「路径在工作区外」，
            // zoneOutside 小标签是同一信息的重复噪声——仅在没有 workspace_out
            // 理由行时才透出。
            const showOutsideLabel = isOutside && !isSensitive
              && action.decision_reason?.type !== 'workspace_out'
            // strict 红字警示只对灾难性 / 高危不可逆操作透出（判据=判决理由）；
            // 名义 strict 但非灾难/不可逆的（子 Agent 等）不再整行警示。
            const displayRiskLevel = resolveDisplayRiskLevel(action)
            const showStrictHint = isApprovalHighRisk(action)

            return (
              <div
                key={action.request_id || action.tool_call_id || i}
                className="min-w-0 rounded-md bg-muted/30 px-3 py-2"
              >
                <p className="text-body leading-snug font-medium text-foreground break-words [overflow-wrap:anywhere]">
                  {toolLabel}
                </p>
                {explanation && (
                  <p className="mt-0.5 text-caption text-muted-foreground/80 break-words [overflow-wrap:anywhere]">
                    {explanation}
                  </p>
                )}
                {summaryFields.length > 0 && (
                  <div className="mt-1 space-y-0.5">
                    {summaryFields.map(field => (
                      <SummaryFieldRow key={field.labelKey} field={field} />
                    ))}
                  </div>
                )}
                {browserDetailLines && (
                  <div className="mt-1 space-y-0.5">
                    {browserDetailLines.map((line, idx) => (
                      <p
                        key={idx}
                        className="text-caption text-muted-foreground/80 break-words [overflow-wrap:anywhere]"
                      >
                        {line}
                      </p>
                    ))}
                  </div>
                )}
                {fallbackSummary && (
                  <ExpandableText
                    text={fallbackSummary}
                    className="mt-1 text-caption font-mono text-muted-foreground/80"
                  />
                )}
                {action.cli_spec && (
                  <div className="mt-1 min-w-0">
                    <HitlResourceLabel cliSpec={action.cli_spec} />
                  </div>
                )}
                {/* workspace zone：去掉 emoji；仅 sensitive / outside 透出，
                    且只用文字（点状信号 = 一行小字，非整面染色）。 */}
                {isSensitive && (
                  <p className="mt-1 text-caption text-destructive/80">
                    {t('approval.zoneSensitive', { defaultValue: '敏感区域：会触达受保护资源' })}
                  </p>
                )}
                {showOutsideLabel && (
                  <p className="mt-1 text-caption text-muted-foreground/80">
                    {t('approval.zoneOutside', { defaultValue: '工作区外路径' })}
                  </p>
                )}
                {showStrictHint
                  ? <RiskLevelRow level="strict" />
                  : displayRiskLevel === 'review' && <RiskLevelRow level="review" />}
                <DecisionReasonRow
                  reason={action.decision_reason}
                  userVisibleReason={action.user_visible_reason}
                />
                {action.subagent_context?.parent_tool_call_id && (
                  <SubagentSourceRow context={action.subagent_context} />
                )}
                {workspaceOutPath && ownsDecision && (
                  <button
                    type="button"
                    onClick={() => handleAddWorkspacePathAndApprove(action, workspaceOutPath)}
                    disabled={!activeSpaceId || actionsDisabled}
                    title={workspaceOutPath}
                    className={cn(
                      'mt-2 inline-flex items-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 px-2.5 h-7',
                      'text-caption font-medium text-accent hover:bg-accent/15 transition-colors',
                      'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-accent/10',
                    )}
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                    {t('approval.addFolderAndAllow', {
                      // 文件夹名可能是几十位的 UUID / hash（temp 落盘目录），
                      // 按钮上中间省略，完整路径靠 title 悬停查看。
                      name: workspaceOutTitle ? truncateMiddle(workspaceOutTitle, 28) : workspaceOutTitle,
                      defaultValue: '添加 {{name}} 文件夹并允许',
                    })}
                  </button>
                )}
                {showRejectInput[i] && (
                  <div className="mt-2">
                    <textarea
                      value={rejectionMessages[i] || ''}
                      onChange={(e) =>
                        setRejectionMessages(prev => ({
                          ...prev,
                          [i]: e.target.value.slice(0, REJECTION_MESSAGE_MAX),
                        }))
                      }
                      placeholder={t('review.rejectionPlaceholder', {
                        defaultValue: '可选：告诉 Agent 为什么拒绝（最多 500 字）',
                      })}
                      rows={2}
                      disabled={isSubmitting}
                      autoFocus
                      className={cn(
                        'w-full resize-none rounded-md border border-border/40 bg-background px-2.5 py-1.5 text-caption',
                        'placeholder:text-muted-foreground/60',
                        'focus:outline-none focus:border-accent/60',
                        isSubmitting && 'opacity-50 cursor-not-allowed',
                      )}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {isExpired && (
          <p className="text-caption text-muted-foreground/80">
            {t('review.expiredHint', { defaultValue: '审批已过期，请重新发送消息让 Agent 重新执行' })}
          </p>
        )}
      </div>
      )}

      {/* ── 底部操作区（ 改版）──
          [升档快捷按钮（居左）] … [拒绝] [☑记住 + 范围下拉] [允许]
            主按钮  Allow  → accent（适度品牌识别）
            弱     Deny   → 白底 hairline，灰文字
            升档按钮按当前会话审批档显示下一档（自动通过 / 全部允许），
            点击=就地升档并放行本批；不可升（PMO / 组织未开放 / 无权限 /
            已是全部允许）时整个按钮不渲染。
          键盘：⌘↵=允许（按记住选框分发）、esc=拒绝。
          成员只读态（!canResolve）不渲染操作按钮——没有可执行的动作。 */}
      {canResolve && (ownsDecision || Boolean(submitError)) && (
      <div
        data-testid="approval-panel-footer"
        className="shrink-0 space-y-2 pt-1"
      >
        {submitError && !isExpired && (
          <div className="space-y-1">
            <p className="text-caption text-destructive/80 break-words [overflow-wrap:anywhere]">
              {submitError}
            </p>
            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                disabled={isSubmitting}
                data-testid="approval-dismiss-link"
                className={cn(
                  'text-caption text-muted-foreground underline hover:text-foreground',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                )}
              >
                {t('approval.dismissToRestore', {
                  defaultValue: '放弃审批并恢复输入',
                })}
              </button>
            )}
          </div>
        )}
        {/* 行内间距：拒绝与「空间内|记住|允许」button group 之间 gap-3，
            拉开否定/肯定动作；组内无间距（segmented 形态）。 */}
        {ownsDecision && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <ApprovalTierUpgradeButton
            spaceId={activeSpaceId}
            sessionId={sessionId}
            disabled={actionsDisabled}
            onUpgraded={handleApproveOnce}
            className="mr-auto"
          />

          <button
            type="button"
            onClick={handleDenyClick}
            disabled={actionsDisabled}
            className={cn(
              APPROVAL_ACTION_BTN,
              'border border-border/60 bg-background text-muted-foreground',
              'hover:bg-muted/40 hover:text-foreground disabled:hover:bg-background',
            )}
          >
            {t('approval.reject', { defaultValue: '拒绝' })}
            <Shortcut keys="esc" />
          </button>

          {/* 「在空间内记住 ▾ | 允许」单个 button group（split-button 形态）：
              - 「在空间内记住 / 在对话中记住」是 toggle button（aria-pressed），
                按下=按当前范围写记忆、抬起=仅本次；文字随范围变化；
              - 小三角单独成段，打开范围菜单；从菜单选范围会顺带按下 toggle；
              - 「允许」accent 主段在最右，-m-px 盖住 hairline 收出干净右缘。
              菜单走统一浮层材质。 */}
          <div
            className={cn(
              'inline-flex h-7 shrink-0 items-stretch whitespace-nowrap rounded-md',
              'border border-border/60 bg-background',
            )}
          >
            {showRememberControls && (
              <button
                type="button"
                onClick={() => setRememberChecked(prev => !prev)}
                disabled={actionsDisabled}
                aria-pressed={rememberChecked}
                data-testid="approval-remember-toggle"
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-l-[5px] px-2.5 text-body transition-colors',
                  'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                  'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
                )}
              >
                {/* 自绘勾选框（原生 checkbox 跨平台观感不齐）：勾选状态落在这里 */}
                <span
                  aria-hidden
                  className={cn(
                    'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
                    rememberChecked
                      ? 'border-accent bg-accent text-accent-foreground'
                      : 'border-border bg-background text-transparent',
                  )}
                >
                  <Check className="h-2.5 w-2.5" strokeWidth={3} />
                </span>
                {(rememberScope === 'thread' && showThreadScope) || !showAlwaysScope
                ? t('approval.rememberInThread', { defaultValue: '在对话中记住' })
                : t('approval.rememberInSpace', { defaultValue: '在空间内记住' })}
              </button>
            )}

            {/* 范围切换三角：只有 thread / always 均可用时才渲染 */}
            {showThreadScope && showAlwaysScope && (
              <div ref={scopeMenuRef} className="relative flex items-stretch">
                <button
                  type="button"
                  onClick={() => setScopeMenuOpen(prev => !prev)}
                  disabled={actionsDisabled}
                  data-testid="approval-remember-scope"
                  aria-expanded={scopeMenuOpen}
                  aria-label={t('approval.rememberScopeMenu', { defaultValue: '选择记住范围' })}
                  className={cn(
                    'inline-flex items-center px-1',
                    'text-muted-foreground transition-colors',
                    'hover:bg-muted/40 hover:text-foreground',
                    'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
                  )}
                >
                  <ChevronDown
                    className={cn(
                      'h-3 w-3 opacity-60 transition-transform',
                      scopeMenuOpen && 'rotate-180',
                    )}
                  />
                </button>
                {scopeMenuOpen && (
                  <div
                    role="menu"
                    className={cn(
                      'absolute bottom-full right-0 mb-1.5 min-w-[8.5rem] rounded-md p-1 z-dropdown',
                      'animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-1 duration-100',
                      OVERLAY_SURFACE_CLASS,
                    )}
                  >
                    {([
                      { value: 'always' as const, label: t('approval.rememberInSpace', { defaultValue: '在空间内记住' }) },
                      { value: 'thread' as const, label: t('approval.rememberInThread', { defaultValue: '在对话中记住' }) },
                    ]).map(option => (
                      <button
                        key={option.value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={rememberScope === option.value}
                        data-testid={`approval-remember-scope-${option.value}`}
                        onClick={() => {
                          setRememberScope(option.value)
                          setRememberChecked(true)
                          setScopeMenuOpen(false)
                        }}
                        className={cn(
                          'flex w-full items-center justify-between gap-3 rounded-sm px-2 h-7',
                          'text-body transition-colors hover:bg-muted/40',
                          rememberScope === option.value ? 'text-foreground' : 'text-foreground/80',
                        )}
                      >
                        {option.label}
                        <Check
                          className={cn(
                            'h-3 w-3 text-accent',
                            rememberScope !== option.value && 'invisible',
                          )}
                        />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={handleAllow}
              disabled={actionsDisabled}
              data-testid="approval-allow"
              className={cn(
                '-m-px inline-flex shrink-0 items-center whitespace-nowrap rounded-md px-3',
                showRememberControls && 'rounded-l-none',
                'text-body font-medium transition-colors',
                'bg-accent text-accent-foreground hover:bg-accent/90',
                'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-accent',
              )}
            >
              {isSubmitting
                ? t('review.submitting')
                : t('approval.allow', { defaultValue: '允许' })}
              <Shortcut keys={`${MOD_LABEL}${ENTER_LABEL}`} />
            </button>
          </div>
        </div>
        )}
      </div>
      )}
    </div>
  )
}
