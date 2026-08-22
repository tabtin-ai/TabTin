/**
 * 把 present_to_user resource_ref 卡片的 type/id/hint 转成 ResourcePointer。
 *
 * 必须走 parseResourcePointer：Markdown / 本轮产物链接已靠它做
 * `doc → document` 等别名归一化；卡片点击若手造 pointer 会跳过归一化，
 * 落到 system_fallback。
 */

import { parseResourcePointer, type ResourcePointer } from '@tabtin/resource-router'

export function buildRichResourcePointer(
  resourceType: string,
  resourceId: string,
  hint?: string | null,
): ResourcePointer {
  const hintQuery = hint
    ? `?hint=${encodeURIComponent(hint)}`
    : ''
  const raw =
    `tabtin://resource/${encodeURIComponent(resourceType)}/` +
    `${encodeURIComponent(resourceId)}${hintQuery}`
  return parseResourcePointer(raw)
}
