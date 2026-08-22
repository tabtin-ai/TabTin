/**
 * 关联记录展示标题：识别后端「主字段空 → title=record.id」兜底，
 * 避免选择器把 UUID 当标题露给用户。候选列表仍保留这些记录，仅改展示文案。
 */

export const UNNAMED_RECORD_DISPLAY_NAME = '未命名记录'

export function isIdLikeLinkTitle(id: string, title: string | undefined): boolean {
  if (!title) return true
  if (title === id) return true
  const normId = id.replace(/-/g, '')
  const normTitle = title.replace(/-/g, '')
  return normId.length > normTitle.length && normId.startsWith(normTitle)
}

/** 有效标题原样返回；空 / id-like 返回 fallback（默认「未命名记录」）。 */
export function formatLinkRecordLabel(
  id: string,
  title: string | undefined,
  untitledFallback = UNNAMED_RECORD_DISPLAY_NAME,
): string {
  if (isIdLikeLinkTitle(id, title)) return untitledFallback
  return title as string
}

/**
 * 关联选择器 / 内嵌关联表「多列」单元格文案。
 *
 * 只展示本列 field 值；禁止用 `record.title` 回填——title 来自 lookupFieldId，
 * 弹窗首列未必是标题字段（空「文本」列会被活动名等串进去）。
 * 单列（仅标题）模式请继续用 {@link formatLinkRecordLabel}。
 */
export function resolveLinkGridCellText(cellText: string | undefined | null): string {
  return cellText || ''
}
