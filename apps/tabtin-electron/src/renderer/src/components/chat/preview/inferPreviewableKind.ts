/**
 * 按 mime / 文件名（或 URL）推断聊天可预览资源类型；不可预览返回 null.
 *
 * 实现委托 shared `resolvePreviewKindHints`（Open Intent SSoT），保持对外签名不变。
 */

import { resolvePreviewKindHints } from '@shared/open-intent'
import type { PreviewResourceKind } from './types'

/**
 * @param mime Content-Type
 * @param pathOrName 文件名或 URL（OSS 常返回 application/octet-stream，靠扩展名兜底）
 */
export function inferPreviewableKind(mime?: string, pathOrName?: string): PreviewResourceKind | null {
  const resolved = resolvePreviewKindHints({
    mimeType: mime,
    filename: pathOrName,
    url: pathOrName,
  })
  return resolved?.previewKind ?? null
}
