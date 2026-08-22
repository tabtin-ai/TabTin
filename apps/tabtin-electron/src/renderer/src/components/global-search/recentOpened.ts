/**
 * 最近打开（PRD 3.7）—— 本地 localStorage 记录最近 N 次"全局搜索点击导航"动作
 *
 * 数据 shape：
 * - type: 6 类对象之一（messages 模式下 type='message'）
 * - id: 业务主键（messageId / resourceId / spaceId / agentId / memoId / conversationId）
 * - title: 显示标题
 * - spaceId / sessionId 等：导航回放需要的最小上下文
 * - openedAt: 时间戳（ms）
 *
 * 设计取舍：
 * - 仅在 GlobalSearch.handleNavigate 末尾埋点（**不**侵入 enterChatSession / dispatchSelect
 *   等通用导航 API，避免影响其他场景）；意味着该列表本质上是"全局搜索后再打开"的历史，
 *   而非"全局打开过的资源"全集。这是 Wave 3 务实选择，未来若要扩展可在通用导航 API 加埋点
 * - 失败 swallow（隐私模式 / quota 超限不影响搜索功能）
 */

import type { FtsResultType } from '@tabtin/app-shell'

const RECENT_OPENED_KEY = 'tabtin:recent-opened'
const MAX_RECENT = 10

export interface RecentOpenedItem {
  type: FtsResultType
  id: string
  title: string
  /** 导航回放所需的上下文 */
  spaceId?: string | null
  sessionId?: string | null
  resourceId?: string | null
  /** 资源子类型（item_type），用于 emoji */
  itemType?: string | null
  /**
   * 记录条目归属的 organization。Cmd+K 空态按当前 organization 过滤"最近打开"，避免切团队后
   * 看到上一团队的历史；navigate 时调用方应该用这个值切到对应 organization 再激活资源。
   * 可选（兼容历史无 organizationId 的旧条目——读出时按 null 处理，过滤逻辑会跳过它们）。
   */
  organizationId?: string | null
  openedAt: number
}

export function pushRecentOpened(item: Omit<RecentOpenedItem, 'openedAt'>): void {
  if (!item.id || !item.type) return
  try {
    const list = readRecentOpened()
    // 同 type+id 去重（标题/openedAt 用最新）
    const next: RecentOpenedItem[] = [
      { ...item, openedAt: Date.now() },
      ...list.filter((r) => !(r.type === item.type && r.id === item.id)),
    ].slice(0, MAX_RECENT)
    localStorage.setItem(RECENT_OPENED_KEY, JSON.stringify(next))
  } catch {
    // localStorage 不可用：静默
  }
}

export function readRecentOpened(): RecentOpenedItem[] {
  try {
    const raw = localStorage.getItem(RECENT_OPENED_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((r): r is RecentOpenedItem =>
        r && typeof r === 'object'
        && typeof r.id === 'string'
        && typeof r.type === 'string'
        && typeof r.title === 'string'
        && typeof r.openedAt === 'number',
      )
      .slice(0, MAX_RECENT)
  } catch {
    return []
  }
}

export function clearRecentOpened(): void {
  try {
    localStorage.removeItem(RECENT_OPENED_KEY)
  } catch {
    // ignore
  }
}
