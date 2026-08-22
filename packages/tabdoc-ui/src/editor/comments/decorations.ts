import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { CommentAnchorV1, CommentThread } from '../../comment-threads/types'
import { isAnchorDetached } from '../../comment-threads/types'
import { collectTopLevelBlockIdsInRange } from '../doc-selection-blocks'
import {
  resolveCommentAnchor,
  type ResolveCommentAnchorOptions,
  type ResolvedCommentAnchor,
} from './anchor'

export const COMMENT_HIGHLIGHT_CLASS = 'tabdoc-comment-highlight'
export const COMMENT_HIGHLIGHT_ACTIVE_CLASS = 'tabdoc-comment-highlight--active'
export const COMMENT_HIGHLIGHT_INLINE_NODE_CLASS = 'tabdoc-comment-highlight--inline-node'
export const COMMENT_BLOCK_BADGE_CLASS = 'tabdoc-comment-block-badge'
export const commentDecorationsPluginKey = new PluginKey<CommentDecorationsPluginState>('tabdocCommentDecorations')

export interface CommentDecorationThreadInput {
  id: string
  scope: CommentThread['scope']
  status: CommentThread['status']
  anchor: CommentAnchorV1 | Record<string, unknown>
  anchor_status: CommentThread['anchor_status']
}

export interface CommentDecorationsPluginState {
  threads: CommentDecorationThreadInput[]
  activeThreadId: string | null
  resolved: Map<string, ResolvedCommentAnchor>
  anchorStatuses: Map<string, 'attached' | 'detached'>
  decorations: DecorationSet
}

export interface CommentDecorationsOptions {
  resolveOptions?: ResolveCommentAnchorOptions
}

const emptyState: CommentDecorationsPluginState = {
  threads: [],
  activeThreadId: null,
  resolved: new Map(),
  anchorStatuses: new Map(),
  decorations: DecorationSet.empty,
}

export type CommentDecorationsMeta =
  | { type: 'setThreads'; threads: CommentDecorationThreadInput[] }
  | { type: 'setActiveThread'; threadId: string | null }

function buildDecorations(
  doc: ProseMirrorNode,
  threads: CommentDecorationThreadInput[],
  activeThreadId: string | null,
  resolveOptions: ResolveCommentAnchorOptions | undefined,
  resolvedOverrides?: ReadonlyMap<string, ResolvedCommentAnchor | null>,
): Pick<CommentDecorationsPluginState, 'resolved' | 'anchorStatuses' | 'decorations'> {
  const resolved = new Map<string, ResolvedCommentAnchor>()
  const anchorStatuses = new Map<string, 'attached' | 'detached'>()
  const decos: ReturnType<typeof Decoration.inline>[] = []

  for (const thread of threads) {
    if (thread.scope === 'document') continue
    if (thread.status === 'resolved') continue
    if (isAnchorDetached(thread.anchor_status)) {
      anchorStatuses.set(thread.id, 'detached')
      continue
    }

    const range = resolvedOverrides?.has(thread.id)
      ? resolvedOverrides.get(thread.id) ?? null
      : resolveCommentAnchor(doc, thread.anchor, resolveOptions)
    if (!range) {
      anchorStatuses.set(thread.id, 'detached')
      continue
    }
    anchorStatuses.set(thread.id, 'attached')
    resolved.set(thread.id, range)

    const isActive = activeThreadId === thread.id
    const anchor = thread.anchor as CommentAnchorV1
    const isBlock = thread.scope === 'block' || Boolean(anchor.block_type)
    const resolvedNode = doc.nodeAt(range.from)
    const isInlineNode = Boolean(
      resolvedNode?.isInline && range.to === range.from + resolvedNode.nodeSize,
    )

    if (isBlock) {
      decos.push(
        Decoration.node(range.from, range.to, {
          class: [
            COMMENT_HIGHLIGHT_CLASS,
            isActive ? COMMENT_HIGHLIGHT_ACTIVE_CLASS : '',
            isInlineNode ? COMMENT_HIGHLIGHT_INLINE_NODE_CLASS : '',
          ].filter(Boolean).join(' '),
          'data-comment-thread-id': thread.id,
        }),
      )
      if (!isInlineNode) {
        decos.push(
          Decoration.widget(range.from, () => {
            const el = document.createElement('span')
            el.className = COMMENT_BLOCK_BADGE_CLASS
            el.dataset.commentThreadId = thread.id
            el.setAttribute('contenteditable', 'false')
            el.textContent = '评论'
            return el
          }, { side: -1, key: `comment-badge-${thread.id}` }),
        )
      }
    } else {
      decos.push(
        Decoration.inline(range.from, range.to, {
          class: `${COMMENT_HIGHLIGHT_CLASS} ${isActive ? COMMENT_HIGHLIGHT_ACTIVE_CLASS : ''}`.trim(),
          'data-comment-thread-id': thread.id,
        }),
      )
    }
  }

  return {
    resolved,
    anchorStatuses,
    decorations: DecorationSet.create(doc, decos),
  }
}

export function getCommentDecorationAnchorStatuses(
  state: EditorState,
): ReadonlyMap<string, 'attached' | 'detached'> {
  return commentDecorationsPluginKey.getState(state)?.anchorStatuses ?? new Map()
}

export function createCommentDecorationsExtension(
  options: CommentDecorationsOptions = {},
): Extension {
  return Extension.create({
    name: 'tabdocCommentDecorations',
    addProseMirrorPlugins() {
      return [createCommentDecorationsPlugin(options)]
    },
  })
}

export function createCommentDecorationsPlugin(
  options: CommentDecorationsOptions = {},
): Plugin<CommentDecorationsPluginState> {
  const resolveOptions = options.resolveOptions
  return new Plugin<CommentDecorationsPluginState>({
    key: commentDecorationsPluginKey,
    state: {
      init: () => emptyState,
      apply(tr, prev, _oldState, newState) {
        const meta = tr.getMeta(commentDecorationsPluginKey) as CommentDecorationsMeta | undefined
        let threads = prev.threads
        let activeThreadId = prev.activeThreadId
        let dirty = tr.docChanged

        if (meta?.type === 'setThreads') {
          threads = meta.threads
          dirty = true
        }
        if (meta?.type === 'setActiveThread') {
          activeThreadId = meta.threadId
          dirty = true
        }

        if (!dirty && threads === prev.threads && activeThreadId === prev.activeThreadId) {
          return prev
        }

        const resolvedOverrides = new Map<string, ResolvedCommentAnchor | null>()
        if (meta?.type !== 'setThreads') {
          const currentBlockIds = new Set(collectTopLevelBlockIdsInRange(
            newState.doc,
            0,
            newState.doc.content.size,
          ))
          for (const thread of threads) {
            if (thread.scope !== 'text_range') continue
            const previousRange = prev.resolved.get(thread.id)
            if (previousRange) {
              const from = tr.docChanged ? tr.mapping.map(previousRange.from, 1) : previousRange.from
              const to = tr.docChanged ? tr.mapping.map(previousRange.to, -1) : previousRange.to
              const anchor = thread.anchor as CommentAnchorV1
              const anchorBlockIds = (anchor.block_ids ?? []).filter(Boolean)
              const mappedBlockIds = from < to
                ? collectTopLevelBlockIdsInRange(newState.doc, from, to)
                : []
              const mappedRangeStillInAnchorBlock = anchorBlockIds.length === 0
                || mappedBlockIds.some(blockId => anchorBlockIds.includes(blockId))

              if (from < to && mappedRangeStillInAnchorBlock) {
                resolvedOverrides.set(thread.id, {
                  ...previousRange,
                  from,
                  to,
                  blockIds: mappedBlockIds,
                })
                continue
              }

              const anchorBlockStillExists = anchorBlockIds.some(blockId => (
                currentBlockIds.has(blockId)
              ))
              resolvedOverrides.set(
                thread.id,
                anchorBlockStillExists
                  ? resolveCommentAnchor(newState.doc, anchor, {
                      ...resolveOptions,
                      yjsCodec: null,
                      state: undefined,
                    })
                  : null,
              )
            } else if (prev.anchorStatuses.get(thread.id) === 'detached') {
              resolvedOverrides.set(thread.id, null)
            }
          }
        }

        const next = buildDecorations(
          newState.doc,
          threads,
          activeThreadId,
          resolveOptions,
          resolvedOverrides,
        )
        return {
          threads,
          activeThreadId,
          ...next,
        }
      },
    },
    props: {
      decorations(state) {
        return commentDecorationsPluginKey.getState(state)?.decorations ?? DecorationSet.empty
      },
    },
  })
}

export function setCommentDecorationThreads(
  view: { dispatch: (tr: any) => void; state: { tr: any } },
  threads: CommentDecorationThreadInput[],
): void {
  view.dispatch(view.state.tr.setMeta(commentDecorationsPluginKey, {
    type: 'setThreads',
    threads,
  } satisfies CommentDecorationsMeta))
}

export function setActiveCommentThread(
  view: { dispatch: (tr: any) => void; state: { tr: any } },
  threadId: string | null,
): void {
  view.dispatch(view.state.tr.setMeta(commentDecorationsPluginKey, {
    type: 'setActiveThread',
    threadId,
  } satisfies CommentDecorationsMeta))
}

/** 纯函数：便于单测装饰数据，不依赖挂载 Extension。 */
export function computeCommentDecorations(
  doc: ProseMirrorNode,
  threads: CommentDecorationThreadInput[],
  activeThreadId: string | null = null,
  resolveOptions?: ResolveCommentAnchorOptions,
): CommentDecorationsPluginState {
  const next = buildDecorations(doc, threads, activeThreadId, resolveOptions)
  return {
    threads,
    activeThreadId,
    ...next,
  }
}
