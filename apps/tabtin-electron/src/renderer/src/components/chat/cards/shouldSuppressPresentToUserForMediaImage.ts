/**
 * present_to_user 输入里的 image URL 是否已全部被 CLI 内联卡展示过。
 */

import { getNestedArgs } from '../registry/toolCardUtils'
import { wasMediaImageShown } from './mediaImageInlineShown'

function collectPresentImageUrls(input: unknown): string[] {
  const args = getNestedArgs(input)
  if (!args) return []
  const items = args.items
  if (!Array.isArray(items)) return []
  const urls: string[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    if (rec.kind !== 'image') continue
    const url = typeof rec.url === 'string' ? rec.url : typeof rec.image_url === 'string' ? rec.image_url : ''
    if (url) urls.push(url)
  }
  return urls
}

/**
 * 若 present_to_user 只有 image 项，且 URL 均已由 MediaImageInlineCard 展示 → 应隐藏折叠行与图卡。
 * 含非 image 项时返回 false（仍要展示）。
 */
export function shouldSuppressPresentToUserForMediaImage(
  input: unknown,
  sessionId: string | null | undefined,
): boolean {
  const args = getNestedArgs(input)
  if (!args || !sessionId) return false
  const items = args.items
  if (!Array.isArray(items) || items.length === 0) return false
  const hasNonImage = items.some((item) => {
    if (!item || typeof item !== 'object') return true
    return (item as Record<string, unknown>).kind !== 'image'
  })
  if (hasNonImage) return false
  const urls = collectPresentImageUrls(input)
  if (urls.length === 0) return false
  return urls.every((url) => wasMediaImageShown(sessionId, url))
}
