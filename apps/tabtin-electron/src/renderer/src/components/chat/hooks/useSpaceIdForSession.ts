/**
 * useSpaceIdForSession — 由 sessionId 反查会话作用域宿主 ID 的 selector hook。
 *
 * 用途：subagent_session tab 触发点（SubagentProgressCard / SubagentAggregateView /
 * SubagentDetailPane）需要把"我属于哪个工作空间"传给 `openResourceTab(spaceId, ...)`，
 * 但卡片本身只持有 parent `sessionId`，要去查 ChatSession 作用域。
 *
 * 实现要点：
 * - 用 `getSessionById` selector（PRD 红线 #3：useChatStore 不存在 `sessionsBySessionId` 字段）
 * - 过渡期 `space_id ?? workspace_id`
 * - 返回 null 时上层应禁用按钮（拼不出请求）
 */

import { resolveSessionScopeId } from '@tabtin/app-shell'
import { useChatStore } from '@/stores/chat/useChatStore'

export function useSpaceIdForSession(sessionId: string | null | undefined): string | null {
  return useChatStore(s => {
    if (!sessionId) return null
    return resolveSessionScopeId(s.getSessionById(sessionId))
  })
}
