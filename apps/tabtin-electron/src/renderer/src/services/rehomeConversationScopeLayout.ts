/**
 * 草稿 conversation scope → 正式 session scope 时，同步迁布局偏好与胶囊展开态。
 *
 * 必须在写 session 指针 / 切 currentSessionId 的同一同步回合内调用：
 * 若等 React 先按新 key 渲染，getTaskViewMode(新 key) 会回落非 app-focus，
 * 胶囊 Host 卸载。
 *
 *  主路径：预建后首发单跳 draft → `conversation:{realId}`。
 * local-pending 第二跳仅兼容旧失败路径（见 rehomeConversationScopeLayoutAfterProvision）。
 */
import { buildConversationSessionScopeKey } from '@components/layout/workspaceContextState'
import { buildConversationDraftScopeKey } from '@/lib/conversationDraftScopeKey'
import { getDraftMessageById } from '@stores/chat/session/draftMessage'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { useUIStore } from '@stores/useUIStore'

export function rehomeConversationScopeLayout(
  fromScopeKey: string | null | undefined,
  toScopeKey: string | null | undefined,
): void {
  if (!fromScopeKey || !toScopeKey || fromScopeKey === toScopeKey) return
  if (!fromScopeKey.startsWith('conversation:draft:')) return
  if (!toScopeKey.startsWith('conversation:') || toScopeKey.startsWith('conversation:draft:')) {
    return
  }

  const prefs = useSpaceViewPrefsStore.getState()
  const fromMode = prefs.getTaskViewMode(fromScopeKey)
  // 强制覆盖：目标 session key 可能残留历史 chat-focus/split
  prefs.setTaskViewModeForScope(toScopeKey, fromMode)

  const ui = useUIStore.getState()
  const fromOverlayOpen = !!ui.appFocusChatOverlayOpenByScopeKey[fromScopeKey]
  if (fromOverlayOpen) {
    ui.setAppFocusChatOverlayOpen(toScopeKey, true)
    ui.setAppFocusChatOverlayOpen(fromScopeKey, false)
  }
}

/**
 * local-pending → 真 session 的第二跳：overlay 恒迁；mode 仅在 pending scope
 * 显式设置过时覆盖（pending 无显式值时不得把默认档刷掉第一跳迁来的 draft mode）。
 */
function rehomePendingSessionScopeLayout(
  fromScopeKey: string,
  toScopeKey: string,
): void {
  if (fromScopeKey === toScopeKey) return

  const prefs = useSpaceViewPrefsStore.getState()
  const explicitMode = prefs.taskViewModeByScopeKey[fromScopeKey]
  if (explicitMode != null) {
    // 用户可能在 ensure in-flight 窗口内于 pending scope 切过视图，后写胜出
    prefs.setTaskViewModeForScope(toScopeKey, explicitMode)
  }

  const ui = useUIStore.getState()
  if (ui.appFocusChatOverlayOpenByScopeKey[fromScopeKey]) {
    ui.setAppFocusChatOverlayOpen(toScopeKey, true)
    ui.setAppFocusChatOverlayOpen(fromScopeKey, false)
  }
}

/**
 * provision 落库后迁布局。
 *
 *  预建（retainDraft）不调用本函数——shell 仍停草稿。
 * 首发 / 显式 create：draft → real；若仍带 local-pending 兼容 id 则补第二跳。
 *
 * `pendingSessionId` 由调用方在写指针**前**捕获（applyProvisionedSessionPointer
 * 会把 draftMessage 绑定 rehome 到真 session 并解绑 local-pending，事后查不到）。
 */
export function rehomeConversationScopeLayoutAfterProvision(input: {
  spaceId: string
  sessionId: string
  expectedDraftMessageId?: string | null
  /** 首发路径 draftMessage 绑定的 local-pending id；显式建会话等无 pending 路径不传 */
  pendingSessionId?: string | null
}): void {
  const draftMessage = getDraftMessageById(input.expectedDraftMessageId)
  const fromScopeKey =
    draftMessage?.draftScopeKey ?? buildConversationDraftScopeKey(input.spaceId)
  const toScopeKey = buildConversationSessionScopeKey(input.sessionId)
  rehomeConversationScopeLayout(fromScopeKey, toScopeKey)

  if (input.pendingSessionId && input.pendingSessionId !== input.sessionId) {
    rehomePendingSessionScopeLayout(
      buildConversationSessionScopeKey(input.pendingSessionId),
      toScopeKey,
    )
  }
}
