import type { CommentThread } from '@tabtin/tabdoc-ui/api-client'

type SelectableCommentThread = Pick<CommentThread, 'id' | 'scope'>

export interface SharedDocCommentSelectionActions {
  selectDocumentThread: (threadId: string) => void
  selectAnchoredThread: (threadId: string) => void
  closeRail: () => void
  openRail: () => void
  focusAnchor: (threadId: string) => void
}

/**
 * 全文评论与正文锚定批注属于两个独立选择面：前者留在文档底部，
 * 后者才驱动右侧批注栏及正文定位。
 */
export function selectSharedDocCommentThread(
  thread: SelectableCommentThread,
  actions: SharedDocCommentSelectionActions,
): void {
  if (thread.scope === 'document') {
    actions.selectDocumentThread(thread.id)
    actions.closeRail()
    return
  }

  actions.selectAnchoredThread(thread.id)
  actions.openRail()
  actions.focusAnchor(thread.id)
}
