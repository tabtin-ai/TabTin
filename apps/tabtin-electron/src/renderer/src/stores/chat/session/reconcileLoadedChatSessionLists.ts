/**
 * ：丢 activity / 离线后，对已加载 Space 桶做 REST SWR 补拉。
 *
 * - 只碰 `sessionsBySpaceId` 里已有的桶，避免冷启动全组织扫
 * - 激活 Space 优先；其余限流，防止 focus/reconnect 打爆 list API
 * - 复用 `loadSessions`（含 merge/epoch）
 *   （有 message_count/has_messages 的真实会话不会被误归档）
 */

import { createLogger } from '@/utils/logger'

const log = createLogger('ChatSessionListReconcile')

/** 单次 reconcile 最多补拉的 Space 数（含当前激活） */
export const CHAT_SESSION_LIST_RECONCILE_SPACE_LIMIT = 6

export function pickSpaceIdsForSessionListReconcile(input: {
  loadedSpaceIds: readonly string[]
  activeSpaceId?: string | null
  limit?: number
}): string[] {
  const limit = input.limit ?? CHAT_SESSION_LIST_RECONCILE_SPACE_LIMIT
  const unique = [...new Set(input.loadedSpaceIds.filter(Boolean))]
  const active = input.activeSpaceId && unique.includes(input.activeSpaceId)
    ? input.activeSpaceId
    : null
  const rest = active ? unique.filter((id) => id !== active) : unique
  const ordered = active ? [active, ...rest] : rest
  return ordered.slice(0, Math.max(0, limit))
}

export async function reconcileLoadedChatSessionLists(
  organizationId: string,
): Promise<void> {
  if (!organizationId) return

  const { useChatStore } = await import('@/stores/chat/useChatStore')
  const { useSpaceStore } = await import('@/stores/useSpaceStore')

  const chatState = useChatStore.getState()
  const loadedSpaceIds = Object.keys(chatState.sessionsBySpaceId)
  if (loadedSpaceIds.length === 0) return

  const activeSpaceId = useSpaceStore.getState().selectedSpace?.id ?? null
  const targets = pickSpaceIdsForSessionListReconcile({
    loadedSpaceIds,
    activeSpaceId,
  })
  if (targets.length === 0) return

  log.info('reconcile session lists', {
    organizationId: organizationId.slice(0, 8),
    count: targets.length,
    active: activeSpaceId ? activeSpaceId.slice(0, 8) : null,
  })

  await Promise.all(
    targets.map((spaceId) =>
      chatState.loadSessions(spaceId, organizationId).catch((error: unknown) => {
        log.warn('reconcile loadSessions failed', { spaceId: spaceId.slice(0, 8), error })
      }),
    ),
  )
}
