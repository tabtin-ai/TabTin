import type { ChatSession } from '@tabtin/chat-client'
import { sessionHasVisibleMessages } from '@/stores/chat/session/sessionHasVisibleMessages'

/**
 * 侧栏 / 顶栏最近对话过滤。
 *
 * ：放弃创建后空会话应由 `discardAbandonedEmptySessions` 立即清掉，
 * 不再依赖 2h `archive_empty_sessions` 窗口。本过滤仅覆盖：
 * - 当前仍在进行的预建草稿槽（顶部「新任务」承载选中态，列表不露空行）；
 * - 清理完成前的短暂竞态。
 *
 * 规则：
 * - 归档会话默认不进主侧栏；正在查看的那条例外（：点开可看可聊，不等于取消归档）；
 * - ：可见性以 `has_messages` / `message_count` 为准（旧后端才回退 `last_message_at`）；
 * - ：不扫 messages store；keepAlive = 发送登记表∪ 外部档案 `boundSessionIds`；
 *   不再隐含「本地 messages 里有 user」——未走 send 登记的 hydrate 消息不保活；
 * - 空会话（含当前选中的预建草稿）一律不进列表——由顶部「新任务」入口承载选中态。
 */
export function filterSidebarSessions(
  sessions: ChatSession[],
  currentSessionId: string | null,
  keepAliveSessionIds: ReadonlySet<string> = new Set(),
): ChatSession[] {
  return sessions.filter((session) => {
    if (session.status === 'archived' && session.id !== currentSessionId) return false
    if (sessionHasVisibleMessages(session)) return true
    if (keepAliveSessionIds.has(session.id)) return true
    return false
  })
}
