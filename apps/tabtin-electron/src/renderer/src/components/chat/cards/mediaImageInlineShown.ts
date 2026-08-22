/**
 * 会话内「CLI 生图已内联展示」的 URL 身份集合，用于抑制 present_to_user 同图重复。
 * 用 origin+pathname 身份（忽略签名 query / \\u0026 转义差异）。
 */

import { mediaImageUrlIdentity } from './parseMediaImageGenerateResult'

const shownBySession = new Map<string, Set<string>>()

export function markMediaImageShown(sessionId: string | null | undefined, url: string): void {
  if (!sessionId || !url) return
  const id = mediaImageUrlIdentity(url)
  if (!id) return
  let set = shownBySession.get(sessionId)
  if (!set) {
    set = new Set()
    shownBySession.set(sessionId, set)
  }
  set.add(id)
}

export function wasMediaImageShown(
  sessionId: string | null | undefined,
  url: string | null | undefined,
): boolean {
  if (!sessionId || !url) return false
  const id = mediaImageUrlIdentity(url)
  if (!id) return false
  return shownBySession.get(sessionId)?.has(id) === true
}

/** 测试用：清空会话记录 */
export function clearMediaImageShownForTests(sessionId?: string): void {
  if (sessionId) {
    shownBySession.delete(sessionId)
    return
  }
  shownBySession.clear()
}
