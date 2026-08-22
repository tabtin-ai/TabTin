/** 看板 / 画廊卡片标题空值统一兜底文案 */
export const DEFAULT_UNTITLED_RECORD_TITLE = '未命名记录'

export function toTitleText(value: unknown): string | undefined {
  if (value == null) return undefined
  const text = String(value).trim()
  return text ? text : undefined
}

/**
 * 用户已显式配置卡片标题字段时：空值 →「未命名记录」，不再回退其它字段。
 */
export function resolveConfiguredCardTitle(value: unknown): string {
  return toTitleText(value) ?? DEFAULT_UNTITLED_RECORD_TITLE
}
