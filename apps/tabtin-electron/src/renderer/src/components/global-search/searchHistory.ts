/**
 * 本地搜索历史（PRD 8.3.E / 3.7）
 *
 * - 存最近 10 条
 * - localStorage key: `tabtin:search-history`
 * - 同一关键词去重
 * - 失败 swallow（隐私模式 / quota 超限不影响搜索功能）
 */

const SEARCH_HISTORY_KEY = 'tabtin:search-history'
const MAX_HISTORY = 10

export function pushSearchHistory(query: string): void {
  const q = query.trim()
  if (!q) return
  try {
    const list = readSearchHistory()
    const next = [q, ...list.filter((item) => item !== q)].slice(0, MAX_HISTORY)
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next))
  } catch {
    // localStorage 不可用：静默失败
  }
}

export function readSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((s): s is string => typeof s === 'string').slice(0, MAX_HISTORY)
  } catch {
    return []
  }
}

export function clearSearchHistory(): void {
  try {
    localStorage.removeItem(SEARCH_HISTORY_KEY)
  } catch {
    // ignore
  }
}
