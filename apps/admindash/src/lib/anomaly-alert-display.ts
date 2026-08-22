/** 将计费异常告警 message 中的技术字段名翻成运维可读中文（展示层，不改库内原文）。 */

const PHRASE_REPLACEMENTS: Array<[RegExp, string]> = [
  [/成员用量计数器与 BillingUsageEvent 聚合偏差/g, '成员用量计数器与用量事件聚合偏差'],
  [/网关用量计费数据与 BillingUsageEvent 聚合偏差/g, '网关用量计费数据与用量事件聚合偏差'],
  [/BillingUsageEvent/g, '用量事件'],
  [/storage\.bytes/g, '存储·字节'],
  [/storage\.gb_day/g, '存储·GB·天'],
  [/storage\.gb/g, '存储·GB'],
  [/llm\.tokens?/gi, '大模型·Token'],
  [/\bworkteam\b/gi, '组织'],
]

const FIELD_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\borganization\s*=/gi, '组织='],
  [/\buser\s*=/gi, '用户='],
  [/\bcycle\s*=/gi, '账期='],
  [/\bcounter\s*=/gi, '计数器='],
  [/\bactual\s*=/gi, '实际='],
  [/\bdiff\s*=/gi, '偏差='],
  [/\bcredits\b/gi, '点券'],
]

const SEVERITY_LABELS: Record<string, string> = {
  critical: '严重',
  high: '高',
  medium: '中',
  warning: '警告',
  low: '低',
  info: '提示',
}

export function formatAnomalyAlertMessage(message: string | null | undefined): string {
  let text = String(message || '').trim()
  if (!text) return '异常记录'
  for (const [from, to] of PHRASE_REPLACEMENTS) {
    text = text.replace(from, to)
  }
  for (const [from, to] of FIELD_REPLACEMENTS) {
    text = text.replace(from, to)
  }
  return text
}

export function labelAnomalySeverity(severity: string | null | undefined): string {
  const raw = String(severity || '').trim()
  if (!raw) return '未知'
  return SEVERITY_LABELS[raw.toLowerCase()] || raw
}
