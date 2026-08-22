/**
 * Agent 操作审批弹窗的 detail 展示层格式化——纯函数，不碰 UI。
 *
 * `detail` 由 packages/browser-core/src/orchestration/browser-policy.ts 生成，格式是机读
 * `key=value`（空格分隔，value 可为 `[a, b]` 括号列表）或 `prefix: rest`（如 `act: click, type`）。
 * 生成端保持机读格式不变，本模块只负责把它解析、翻译成人类可读的中文行。
 *
 * i18n key 假定调用方已绑定 `sandbox` namespace。
 */

export interface ApprovalDetailPair {
  key: string
  value: string
}

type TranslateFn = (key: string, opts?: Record<string, unknown>) => string

/** 未命中翻译文案时的中文兜底字段名。 */
const DETAIL_KEY_FALLBACK: Readonly<Record<string, string>> = {
  actionId: '操作',
  risk: '风险',
  childActions: '子操作',
  guardrail: '护栏信号',
  suggestAsync: '建议异步执行',
  act: '操作类型',
  raw: '原始参数',
}

const KV_PATTERN = /([a-zA-Z][\w.]*)=(\[[^\]]*\]|\S+)/g
const PREFIX_PATTERN = /^([a-zA-Z][\w.]*)\s*:\s*(.+)$/

/**
 * 解析 detail 为 { key, value } 列表。解析失败（无法识别的格式）时兜底返回单条
 * `{ key: 'raw', value: detail }`，保留原文不丢信息。
 */
export function parseApprovalDetail(detail: string): ApprovalDetailPair[] {
  const trimmed = detail.trim()
  if (!trimmed) return [{ key: 'raw', value: detail }]

  const kvPairs = parseKeyValuePairs(trimmed)
  if (kvPairs) return kvPairs

  const prefixMatch = PREFIX_PATTERN.exec(trimmed)
  if (prefixMatch) {
    return [{ key: prefixMatch[1]!, value: prefixMatch[2]!.trim() }]
  }

  return [{ key: 'raw', value: detail }]
}

/** `key=value key2=[a, b]` 空格分隔多对；要求匹配片段能覆盖整段文本，否则视为不可靠解析。 */
function parseKeyValuePairs(trimmed: string): ApprovalDetailPair[] | null {
  const pairs: ApprovalDetailPair[] = []
  let match: RegExpExecArray | null
  const pattern = new RegExp(KV_PATTERN)
  while ((match = pattern.exec(trimmed)) !== null) {
    let value = match[2]!
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1)
    }
    pairs.push({ key: match[1]!, value })
  }
  if (pairs.length === 0) return null

  const remainder = trimmed.replace(new RegExp(KV_PATTERN), '').trim()
  if (remainder.length > 0) return null

  return pairs
}

/** 把 detail 解析并翻译为可读行数组，形如 `操作：打开页面`。 */
export function formatApprovalDetailLines(detail: string, t: TranslateFn): string[] {
  return parseApprovalDetail(detail).map(({ key, value }) => formatDetailLine(key, value, t))
}

function formatDetailLine(key: string, value: string, t: TranslateFn): string {
  const label = t(`approval.detailKeys.${key}`, {
    defaultValue: DETAIL_KEY_FALLBACK[key] ?? key,
  })
  return `${label}：${formatDetailValue(key, value, t)}`
}

function formatDetailValue(key: string, value: string, t: TranslateFn): string {
  switch (key) {
    case 'risk':
      return t(`approval.risks.${value}`, { defaultValue: value })
    case 'actionId':
      return translateBrowserActionId(value, t)
    case 'childActions':
      return splitList(value)
        .map((id) => translateBrowserActionId(id, t))
        .join('、')
    case 'guardrail':
      return splitList(value)
        .map((signal) => t(`approval.guardrailSignals.${signal}`, { defaultValue: signal }))
        .join('、')
    case 'suggestAsync':
      return value === 'true'
        ? t('approval.detailValues.yes', { defaultValue: '是' })
        : t('approval.detailValues.no', { defaultValue: '否' })
    default:
      return value
  }
}

function translateBrowserActionId(actionId: string, t: TranslateFn): string {
  return t(`approval.browserActions.${actionId}`, { defaultValue: actionId })
}

function splitList(value: string): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

/**
 * 审批卡片顶部「AI Agent 请求 <label>」的动作名翻译。
 * 优先 `approval.actions.<actionType>`；`browser.xxx` 且无直接 key 时再试
 * `approval.browserActions.xxx`；都未命中则回落原始 actionType。
 */
export function getApprovalActionLabel(actionType: string, t: TranslateFn): string {
  const direct = t(`approval.actions.${actionType}`, { defaultValue: '' })
  if (direct) return direct

  const BROWSER_PREFIX = 'browser.'
  if (actionType.startsWith(BROWSER_PREFIX)) {
    const browserId = actionType.slice(BROWSER_PREFIX.length)
    const browserLabel = t(`approval.browserActions.${browserId}`, { defaultValue: '' })
    if (browserLabel) return browserLabel
  }

  return t(`approval.actions.${actionType}`, { defaultValue: actionType })
}
