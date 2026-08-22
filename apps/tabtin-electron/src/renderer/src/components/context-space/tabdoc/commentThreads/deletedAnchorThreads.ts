import type { CommentThread } from '@tabtin/tabdoc-ui/api-client'

type LocalAnchorStatus = 'attached' | 'detached'

/**
 * 只识别一次文档编辑中从有效范围收缩为空的锚点。
 * 初次加载即失效的历史锚点不会进入删除流程。
 */
export function findDeletedAnchorThreadIds(
  previous: ReadonlyMap<string, LocalAnchorStatus>,
  current: ReadonlyMap<string, LocalAnchorStatus>,
  threads: readonly CommentThread[],
): string[] {
  return threads
    .filter((thread) => (
      thread.scope !== 'document'
      && previous.get(thread.id) === 'attached'
      && current.get(thread.id) === 'detached'
    ))
    .map((thread) => thread.id)
}
