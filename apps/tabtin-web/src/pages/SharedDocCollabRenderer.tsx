/**
 * SharedDocCollabRenderer — 分享页只读协作渲染。
 *
 * 优先用 Y.Doc 实时渲染；连接失败时回退 REST 快照。
 * 可评论权限：editable=false 但仍可选中，挂气泡批注入口与评论装饰。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react'
import {
  DocBubbleMenu,
  DocRenderer,
  EditorContent,
  EditorRoot,
  StartCommentButton,
  createCollaborationExtensions,
  createCommentDecorationsExtension,
  standaloneEditableExtensions,
  standaloneExtensions,
  type CommentYjsCodec,
  type EditorInstance,
} from '@tabtin/tabdoc-ui/editor'
import { useSharedDocCollab } from './hooks/useShareCollab'

const EMPTY_DOC = { type: 'doc', content: [] } as const

export interface SharedDocCollabRendererProps {
  shareId: string
  password?: string
  contentJson?: Record<string, unknown> | null
  contentMarkdown?: string | null
  enabled?: boolean
  className?: string
  /** 可评论：可选中、挂批注入口与装饰 */
  enableComments?: boolean
  editorRef?: RefObject<EditorInstance | null>
  onEditorReady?: (editor: EditorInstance | null) => void
  onStartComment?: () => void
  yjsCodec?: CommentYjsCodec | null
  bubbleMenuExtra?: ReactNode
}

export function SharedDocCollabRenderer({
  shareId,
  password,
  contentJson,
  contentMarkdown,
  enabled = true,
  className,
  enableComments = false,
  editorRef,
  onEditorReady,
  onStartComment,
  yjsCodec = null,
  bubbleMenuExtra,
}: SharedDocCollabRendererProps) {
  const collab = useSharedDocCollab({ shareId, password, enabled })
  const [bubbleOpen, setBubbleOpen] = useState(false)

  const assignEditor = useCallback((editor: EditorInstance | null) => {
    if (editorRef) {
      ;(editorRef as { current: EditorInstance | null }).current = editor
    }
    onEditorReady?.(editor)
  }, [editorRef, onEditorReady])

  useEffect(() => () => {
    assignEditor(null)
  }, [assignEditor])

  const commentResolveOptions = useMemo(
    () => ({ yjsCodec }),
    [yjsCodec],
  )
  const commentDecorationsExtension = useMemo(
    () => (enableComments
      ? createCommentDecorationsExtension({ resolveOptions: commentResolveOptions })
      : null),
    [commentResolveOptions, enableComments],
  )

  const collabExtensions = useMemo(() => {
    if (!collab.isRealtime || !collab.ydoc) return null
    const provider = collab.provider?.getProvider?.() ?? null
    const base = [
      ...standaloneExtensions,
      ...createCollaborationExtensions(collab.ydoc, provider, collab.collabUser),
    ]
    if (!enableComments || !commentDecorationsExtension) return base
    return [...base, commentDecorationsExtension]
  }, [
    collab.collabUser,
    collab.isRealtime,
    collab.provider,
    collab.ydoc,
    commentDecorationsExtension,
    enableComments,
  ])

  const fallbackExtensions = useMemo(() => {
    if (!enableComments) return null
    return [
      ...standaloneEditableExtensions,
      ...(commentDecorationsExtension ? [commentDecorationsExtension] : []),
    ]
  }, [commentDecorationsExtension, enableComments])

  const commentChrome = enableComments ? (
    <DocBubbleMenu open={bubbleOpen} onOpenChange={setBubbleOpen}>
      <StartCommentButton onStartComment={onStartComment} />
      {bubbleMenuExtra}
    </DocBubbleMenu>
  ) : null

  if (!collab.isRealtime || !collabExtensions) {
    if (!enableComments || !fallbackExtensions) {
      return (
        <DocRenderer
          contentJson={contentJson}
          contentMarkdown={contentMarkdown}
          className={className}
        />
      )
    }
    return (
      <EditorRoot>
        <EditorContent
          immediatelyRender={false}
          initialContent={(contentJson && Object.keys(contentJson).length > 0
            ? contentJson
            : EMPTY_DOC) as never}
          extensions={fallbackExtensions}
          editorProps={{ editable: () => false }}
          className={className ?? 'relative w-full'}
          onCreate={({ editor }: { editor: EditorInstance }) => assignEditor(editor)}
        >
          {commentChrome}
        </EditorContent>
      </EditorRoot>
    )
  }

  return (
    <EditorRoot>
      <EditorContent
        key={`share-collab-${collab.resourceId ?? shareId}`}
        immediatelyRender={false}
        initialContent={EMPTY_DOC as never}
        extensions={collabExtensions}
        editorProps={{ editable: () => false }}
        className={className ?? 'relative w-full'}
        onCreate={({ editor }: { editor: EditorInstance }) => assignEditor(editor)}
      >
        {commentChrome}
      </EditorContent>
    </EditorRoot>
  )
}
