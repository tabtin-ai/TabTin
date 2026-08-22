/**
 * 统一处理多选修饰键。
 *
 * 规则：
 * - Shift 始终表示追加选择
 * - macOS 使用 Meta(Command) 追加选择
 * - 非 macOS 使用 Ctrl 追加选择
 */
const MAC_PLATFORM_RE = /Mac|iPod|iPhone|iPad/i

export function isMacPlatform(platform: string | undefined): boolean {
  if (!platform) return false
  return MAC_PLATFORM_RE.test(platform)
}

export function shouldAppendSelection(
  keys: Pick<MouseEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>,
  platform: string | undefined = typeof navigator !== 'undefined' ? navigator.platform : undefined,
): boolean {
  if (keys.shiftKey) return true
  if (keys.metaKey) return true
  if (!isMacPlatform(platform) && keys.ctrlKey) return true
  return false
}

