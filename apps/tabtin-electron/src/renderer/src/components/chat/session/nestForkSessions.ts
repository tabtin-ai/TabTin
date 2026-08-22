import type { ChatSession } from '@tabtin/chat-client'
import { sortSessionsByActivity } from '@/utils/chat-session-sort'

/**
 * fork 子行 └ 折线宽度（px）。
 * 子行布局为「状态图标 → 折线+标题」：折线左缘与父行标题首字对齐（承接 SIDEBAR_ROW 的 gap-2），
 * 不再给整行加 paddingLeft。
 */
export const FORK_TREE_GUIDE_WIDTH_PX = 10

export type ForkChildrenIndex = {
  /** 列表根 → 其全部 fork 后代（含孙级），统一一层挂载 */
  childrenByParentId: Map<string, ChatSession[]>
  nestedChildIds: Set<string>
}

/**
 * 将 fork 链上的会话全部挂到「列表根」下（一层）：
 * 沿 forked_from_id 向上走到当前列表中的最顶祖先，所有后代平铺为其子行。
 * 父链上的会话不在列表中时，该会话自己作为列表根（或其可见祖先下的子行）。
 */
export function buildForkChildrenIndex(sessions: ChatSession[]): ForkChildrenIndex {
  const sessionById = new Map(sessions.map((session) => [session.id, session]))
  const sessionIds = new Set(sessionById.keys())
  const childrenByParentId = new Map<string, ChatSession[]>()

  const resolveListRootId = (session: ChatSession): string | null => {
    let current = session
    const seen = new Set<string>()
    while (current.forked_from_id && sessionIds.has(current.forked_from_id)) {
      if (seen.has(current.id)) break
      seen.add(current.id)
      if (current.forked_from_id === current.id) break
      const parent = sessionById.get(current.forked_from_id)
      if (!parent) break
      current = parent
    }
    if (current.id === session.id) return null
    return current.id
  }

  for (const session of sessions) {
    const rootId = resolveListRootId(session)
    if (!rootId) continue
    const siblings = childrenByParentId.get(rootId)
    if (siblings) siblings.push(session)
    else childrenByParentId.set(rootId, [session])
  }

  for (const [rootId, children] of childrenByParentId) {
    childrenByParentId.set(rootId, sortSessionsByActivity(children))
  }

  const nestedChildIds = new Set<string>()
  for (const children of childrenByParentId.values()) {
    for (const child of children) nestedChildIds.add(child.id)
  }

  return { childrenByParentId, nestedChildIds }
}

export function forkCollapseKey(sessionId: string): `fork:${string}` {
  return `fork:${sessionId}`
}

/** 分组内只排「列表根」：已挂到父下的子会话不参与时间桶 / Space 独立占位 */
export function filterForkListRoots(
  sessions: ChatSession[],
  nestedChildIds: Set<string>,
): ChatSession[] {
  if (nestedChildIds.size === 0) return sessions
  return sessions.filter((session) => !nestedChildIds.has(session.id))
}

/** 列表根 + 其平铺挂载的全部 fork 后代数量（不受折叠影响） */
export function countForkTreeSessions(
  roots: ChatSession[],
  childrenByParentId: Map<string, ChatSession[]>,
): number {
  let count = 0
  for (const root of roots) {
    count += 1
    // 索引已扁平：只有列表根有 children，无孙级嵌套
    count += childrenByParentId.get(root.id)?.length ?? 0
  }
  return count
}
