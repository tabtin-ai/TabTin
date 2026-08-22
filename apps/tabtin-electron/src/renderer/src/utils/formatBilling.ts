/**
 * 计费模块公共格式化工具
 */

import { formatNumber } from '@/utils/i18n/format'

export const toNumber = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const CHARGE_STATUS_LABELS: Record<string, string> = {
  pending: '待聚合',
  charged: '已扣费',
  aggregated: '已聚合扣款',
  failed: '扣费失败',
  released: '已释放',
  reversed: '已冲正',
  refunded: '已退款',
}

const SCENE_KEY_LABELS: Record<string, string> = {
  _main_chat: '主对话',
  _sub_agent: '子 Agent',
  _compact: '上下文压缩',
  _summary_judge: '摘要评判',
  commit_message_generation: 'Commit 信息生成',
  memory_capture: '记忆增强',
  diary_distill: '记忆增强',
  user_portrait_distill: '记忆增强',
  memory_compaction: '记忆增强',
}

const MEMORY_SCENE_KEYS = new Set([
  'memory_capture',
  'diary_distill',
  'user_portrait_distill',
  'memory_compaction',
])

const BIZ_TYPE_LABELS: Record<string, string> = {
  llm_chat: 'LLM 对话',
  llm_call: '模型调用',
  llm: '模型调用',
  llm_blocked: '调用拦截',
  charge_failed: '扣费失败',
  charge_skipped: '跳过扣费',
  storage: '存储',
  seed: '验收数据',
}

/**
 * 筛选下拉值 → API `biz_type` 查询串。
 * 「模型调用」同时覆盖规范值 `llm_call` 与账本兼容值 `llm`（同屏展示语义）。
 */
const BIZ_TYPE_FILTER_GROUPS: Record<string, readonly string[]> = {
  llm_call: ['llm_call', 'llm'],
  llm: ['llm_call', 'llm'],
}

/** 将 UI 业务类型筛选项展开为后端可识别的查询值（逗号分隔 / 原样透传）。 */
export const resolveUsageBizTypeFilter = (value?: string | null): string | undefined => {
  const key = (value || '').trim()
  if (!key) return undefined
  const group = BIZ_TYPE_FILTER_GROUPS[key]
  return group ? group.join(',') : key
}

export type UsageLedgerFilter = {
  bizType?: string
  sceneKey?: string
}

/**
 * 用量场景筛选的产品语义到后端字段映射。
 * 所有场景均限定在真实 LLM 账本类型内。
 */
export const resolveUsageSceneFilter = (value?: string | null): UsageLedgerFilter => {
  const sceneKey = (value || '').trim()
  const base = { bizType: resolveUsageBizTypeFilter('llm_call') }
  return sceneKey ? { ...base, sceneKey } : base
}

const METER_KEY_LABELS: Record<string, string> = {
  'llm.tokens': 'LLM Token',
  'storage.gb_day': '存储 (GB·天)',
  'storage.bytes': '存储 (字节)',
  'storage.oss.bytes': '对象存储',
}

/** 扣费状态中文；未知枚举原样返回 */
export const labelChargeStatus = (value?: string | null): string => {
  const key = (value || '').trim().toLowerCase()
  if (!key) return ''
  return CHARGE_STATUS_LABELS[key] || value || ''
}

export const labelSceneKey = (value?: string | null): string => {
  const key = (value || '').trim()
  if (!key) return ''
  return SCENE_KEY_LABELS[key] || key
}

/** 从点券交易的计费元数据中提取用户可读来源。 */
export const labelBillingSource = (metadata?: Record<string, unknown> | null): string => {
  const sceneKey = typeof metadata?.scene_key === 'string' ? metadata.scene_key.trim() : ''
  return MEMORY_SCENE_KEYS.has(sceneKey) ? '记忆增强' : ''
}

export const labelBizType = (value?: string | null): string => {
  const key = (value || '').trim()
  if (!key) return ''
  return BIZ_TYPE_LABELS[key] || key
}

export const labelMeterKey = (value?: string | null): string => {
  const key = (value || '').trim()
  if (!key) return ''
  return METER_KEY_LABELS[key] || key
}

export const formatCredits = (val: number | string, precise = false): string => {
  const n = Number(val)
  if (isNaN(n)) return '0'
  if (precise) return n.toFixed(4)
  return n.toLocaleString()
}

export const formatDecimal = (v: unknown, digits = 4): string => {
  return formatNumber(toNumber(v), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export const CREDITS_PER_YUAN = 100

export const creditsToYuan = (val: string | number): number => toNumber(val) / CREDITS_PER_YUAN

/** 格式化为人民币金额（元），用于账户余额类展示 */
export const formatYuan = (val: string | number, digits = 2): string => {
  const n = creditsToYuan(val)
  if (!Number.isFinite(n) || n === 0) return '0.00'
  return formatNumber(n, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

/** 已是元单位的金额格式化（展示用，可含千分位） */
export const formatYuanAmount = (val: string | number, digits = 2): string => {
  const n = toNumber(val)
  if (!Number.isFinite(n) || n === 0) return '0.00'
  return formatNumber(n, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

/**
 * 可编辑金额输入用：无千分位。
 * `<input type="number">` 无法展示 `1,000.00`，回填必须走此函数。
 */
export const formatYuanAmountPlain = (val: string | number, digits = 2): string => {
  const n = toNumber(val)
  if (!Number.isFinite(n)) return '0'
  return String(Number(n.toFixed(digits)))
}

/** 解析金额输入；去掉千分位逗号，兼容粘贴 / 旧回填 */
export const parseYuanInput = (val: string | number): number => {
  if (typeof val === 'number') return Number.isFinite(val) ? val : Number.NaN
  const normalized = String(val).trim().replace(/,/g, '')
  if (!normalized) return Number.NaN
  const n = Number(normalized)
  return Number.isFinite(n) ? n : Number.NaN
}

/** 根据数值大小自动选择精度的点券格式化 */
export const formatCreditsAuto = (val: string | number): string => {
  const n = Number(val)
  if (isNaN(n) || n === 0) return '0'
  if (n < 0.01) return n.toFixed(4)
  if (n < 1) return n.toFixed(2)
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

/** 字节数可读格式化（B / KB / MB / GB / TB）；支持负值（释放/回滚用量）。 */
export const formatBytes = (value: unknown): string => {
  const bytes = toNumber(value)
  if (bytes === 0) return '0 B'
  const sign = bytes < 0 ? '-' : ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let unitIndex = 0
  let current = Math.abs(bytes)
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024
    unitIndex += 1
  }
  return `${sign}${current.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`
}

/**
 * 按 meter_key 格式化用量数量（含可读单位）。
 * 未知 meter 且有 fallbackUnit 时回退「数量 + unit」；无 unit 返回空串，避免裸数字。
 */
export const formatUsageQuantity = (
  meterKey: string | null | undefined,
  quantity: unknown,
  fallbackUnit?: string | null,
): string => {
  if (quantity === null || quantity === undefined || quantity === '') return ''
  const n = Number(quantity)
  if (!Number.isFinite(n)) return ''

  const key = (meterKey || '').trim()
  if (key === 'llm.tokens' || key === 'rag.embedding.tokens') {
    const abs = Math.abs(n)
    const sign = n < 0 ? '-' : ''
    if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M tokens`
    if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K tokens`
    return `${n} tokens`
  }
  if (key === 'storage.bytes' || key === 'storage.oss.bytes') {
    return formatBytes(n)
  }
  if (key === 'storage.gb_day') {
    return `${n.toFixed(3)} GB·天`
  }
  if (key === 'speech.asr.seconds') {
    const abs = Math.abs(n)
    const sign = n < 0 ? '-' : ''
    if (abs >= 3600) return `${sign}${(abs / 3600).toFixed(1)}h`
    if (abs >= 60) return `${sign}${(abs / 60).toFixed(1)}min`
    return `${sign}${abs.toFixed(0)}s`
  }
  if (key === 'speech.tts.characters') {
    return `${n.toLocaleString()} 字符`
  }
  if (key === 'media.image.count') {
    return `${n} 张`
  }
  if (key === 'media.video.seconds' || key === 'media.bgm.seconds') {
    const abs = Math.abs(n)
    const sign = n < 0 ? '-' : ''
    if (abs >= 60) return `${sign}${(abs / 60).toFixed(1)}min`
    return `${sign}${abs.toFixed(0)}s`
  }

  const unit = (fallbackUnit || '').trim()
  if (!unit) return ''
  const qtyText = formatNumber(n, { maximumFractionDigits: 2 })
  return `${qtyText} ${unit}`
}
