/**
 * open_tabs 会话代码根过滤（ 不变量 #3）。
 *
 * `open_tabs` 会原样暴露给 Agent，作为「用户当前打开了哪些 tab」的上下文。一旦
 * 会话显式绑定了代码根，就只暴露落在该根内的 TabCode tab——避免 Agent 从 tab
 * 列表里发现另一个 checkout（如同时开着的其它 worktree）并误用。非 TabCode 的
 * 应用 tab（TabDoc / 浏览器等）不受影响，始终保留。
 *
 * 未显式绑定时不过滤（`boundRootPath` 传 null）——「哪个根是对的」这个概念只有
 * 绑定之后才成立，避免对尚未选择代码根的会话做出无依据的隐藏。
 *
 * 兼容 `useChatPanelContext.openTabs` 里 TabCode 条目的两种 shape：
 * - 非 active 项：`path` 是项目根（tabcode handler 写入 `meta.path`）；`id` 是
 *   不透明的 base64 token，不能拿来比较。
 * - active + focusedSurface 项：`id` 才是真实根路径；`path` 可能是聚焦文件
 *   （比根更深）。
 * 因此对 `id` / `path` 两个候选都做「等于根或落在根子树内」的匹配，命中任一即
 * 视为属于该根。
 */

export interface FilterableOpenTab {
  type: string
  id: string
  path?: string
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function belongsToRoot(candidate: string, normalizedRoot: string): boolean {
  const normalized = normalize(candidate)
  if (!normalized) return false
  return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`)
}

export function filterOpenTabsForBoundCodeRoot<T extends FilterableOpenTab>(
  openTabs: readonly T[],
  boundRootPath: string | null | undefined,
): T[] {
  if (!Array.isArray(openTabs) || openTabs.length === 0) return openTabs as T[]
  if (typeof boundRootPath !== 'string' || !boundRootPath.trim()) return openTabs as T[]
  const root = normalize(boundRootPath)
  if (!root) return openTabs as T[]

  return openTabs.filter((tab) => {
    if (tab.type !== 'tabcode') return true
    const candidates = [tab.id, tab.path].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )
    return candidates.some((value) => belongsToRoot(value, root))
  })
}
