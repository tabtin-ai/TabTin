import type { CommentThread, CommentThreadStatusFilter } from './types'
import { isAnchorDetached } from './types'

export function filterCommentThreads(
  threads: readonly CommentThread[],
  filter: CommentThreadStatusFilter,
): CommentThread[] {
  if (filter === 'all') return [...threads]
  return threads.filter((thread) => thread.status === filter)
}

/** 右侧评论栏：只展示锚定到正文的线程，全文评论归底部区。 */
export function filterAnchoredCommentThreads(
  threads: readonly CommentThread[],
): CommentThread[] {
  return threads.filter((thread) => thread.scope !== 'document')
}

/** 底部全文区：只展示文档级线程。 */
export function filterDocumentScopeCommentThreads(
  threads: readonly CommentThread[],
): CommentThread[] {
  return threads.filter((thread) => thread.scope === 'document')
}

export function partitionDetachedThreads(threads: readonly CommentThread[]): {
  attached: CommentThread[]
  detached: CommentThread[]
} {
  const attached: CommentThread[] = []
  const detached: CommentThread[] = []
  for (const thread of threads) {
    if (thread.scope !== 'document' && isAnchorDetached(thread.anchor_status)) {
      detached.push(thread)
    } else {
      attached.push(thread)
    }
  }
  return { attached, detached }
}
