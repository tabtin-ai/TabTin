import type { EditorInstance } from 'novel'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import type { CommentThread } from '../../comment-threads/types'
import { revealDocSelection } from '../reveal-doc-selection'
import {
  resolveCommentAnchor,
  type ResolveCommentAnchorOptions,
  type ResolvedCommentAnchor,
} from './anchor'
import { commentDecorationsPluginKey } from './decorations'

/**
 * 正文 → 线程：根据 PM 位置找到覆盖该点的线程 id（最近/最短优先）。
 */
export function findCommentThreadsAtPos(
  resolvedByThread: ReadonlyMap<string, ResolvedCommentAnchor>,
  pos: number,
): string[] {
  const hits: Array<{ id: string; span: number }> = []
  for (const [id, range] of resolvedByThread) {
    if (pos >= range.from && pos <= range.to) {
      hits.push({ id, span: range.to - range.from })
    }
  }
  hits.sort((a, b) => a.span - b.span)
  return hits.map((h) => h.id)
}

/**
 * 从编辑器 decorations 插件状态读取已解析 range，再查位置。
 */
export function findCommentThreadsAtEditorPos(
  editor: Pick<EditorInstance, 'state'>,
  pos: number,
): string[] {
  const pluginState = commentDecorationsPluginKey.getState(editor.state)
  if (!pluginState) return []
  return findCommentThreadsAtPos(pluginState.resolved, pos)
}

export interface FocusCommentAnchorInEditorResult {
  matched: boolean
  strategy: ResolvedCommentAnchor['strategy'] | 'reveal' | 'none'
  from?: number
  to?: number
}

/**
 * 线程 → 正文：解析锚点、滚动揭示，并可选设置选区。
 */
export function focusCommentAnchorInEditor(
  editor: EditorInstance,
  thread: Pick<CommentThread, 'anchor' | 'scope' | 'anchor_status'>,
  options: ResolveCommentAnchorOptions & {
    scrollContainer?: HTMLElement | null
    setSelection?: boolean
  } = {},
): FocusCommentAnchorInEditorResult {
  if (thread.scope === 'document') {
    return { matched: false, strategy: 'none' }
  }

  const doc = editor.state.doc as ProseMirrorNode
  const resolved = resolveCommentAnchor(doc, thread.anchor, {
    yjsCodec: options.yjsCodec,
    state: options.state ?? editor.state,
  })

  if (!resolved) {
    return { matched: false, strategy: 'none' }
  }

  if (options.setSelection !== false) {
    try {
      const selection = TextSelection.create(editor.state.doc, resolved.from, resolved.to)
      const tr = editor.state.tr.setSelection(selection)
      editor.view.dispatch(tr)
    } catch {
      // NodeSelection 场景下 TextSelection 可能失败；仍尝试滚动
    }
  }

  if (options.scrollContainer) {
    const blockIds = resolved.blockIds
    revealDocSelection(editor, options.scrollContainer, {
      blockIds,
      fullText: typeof (thread.anchor as any)?.selected_text === 'string'
        ? (thread.anchor as any).selected_text
        : undefined,
    })
    return {
      matched: true,
      strategy: 'reveal',
      from: resolved.from,
      to: resolved.to,
    }
  }

  return {
    matched: true,
    strategy: resolved.strategy,
    from: resolved.from,
    to: resolved.to,
  }
}
