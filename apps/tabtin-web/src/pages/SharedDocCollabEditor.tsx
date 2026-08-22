/**
 * SharedDocCollabEditor — 分享页 edit 权限协作编辑器。
 *
 * 优先 Yjs 双向协作；连接失败时回退 REST 独立编辑器。
 * 可挂 comment_threads_v1 气泡批注入口与装饰扩展。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react'
import {
  DocBubbleMenu,
  EditorContent,
  EditorRoot,
  DocStandaloneEditor,
  StartCommentButton,
  createCollaborationExtensions,
  createCommentDecorationsExtension,
  standaloneEditableExtensions,
  type CommentYjsCodec,
  type EditorInstance,
} from '@tabtin/tabdoc-ui/editor'
import { Separator } from '@tabtin/smartsheet-ui'
import { useSharedDocCollab } from './hooks/useShareCollab'

const EMPTY_DOC = { type: 'doc', content: [] } as const

export interface SharedDocCollabEditorProps {
  shareId: string
  password?: string
  contentJson?: Record<string, unknown> | null
  contentMarkdown?: string | null
  onFallbackUpdate?: (editor: EditorInstance) => void
  className?: string
  enableComments?: boolean
  editorRef?: RefObject<EditorInstance | null>
  onEditorReady?: (editor: EditorInstance | null) => void
  onStartComment?: () => void
  yjsCodec?: CommentYjsCodec | null
  bubbleMenuExtra?: ReactNode
}

export function SharedDocCollabEditor({
  shareId,
  password,
  contentJson,
  contentMarkdown,
  onFallbackUpdate,
  className,
  enableComments = false,
  editorRef,
  onEditorReady,
  onStartComment,
  yjsCodec = null,
  bubbleMenuExtra,
}: SharedDocCollabEditorProps) {
  const collab = useSharedDocCollab({ shareId, password, enabled: true })
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

  const extensions = useMemo(() => {
    if (!collab.isRealtime || !collab.ydoc) return null
    const provider = collab.provider?.getProvider?.() ?? null
    const base = [
      ...standaloneEditableExtensions,
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

  const handleFallbackUpdate = useCallback((editor: EditorInstance) => {
    assignEditor(editor)
    onFallbackUpdate?.(editor)
  }, [assignEditor, onFallbackUpdate])

  if (!collab.isRealtime || !extensions || !collab.canEdit) {
    // DocStandaloneEditor 暂无批注 bubble 插槽；仍暴露 onUpdate 以拿到 editor 实例供线程宿主定位
    return (
      <DocStandaloneEditor
        contentJson={contentJson}
        contentMarkdown={contentMarkdown}
        onUpdate={handleFallbackUpdate}
        className={className}
      />
    )
  }

  return (
    <EditorRoot>
      <EditorContent
        key={`share-collab-edit-${collab.resourceId ?? shareId}`}
        immediatelyRender={false}
        initialContent={EMPTY_DOC as never}
        extensions={extensions}
        editorProps={{ editable: () => true }}
        className={className ?? 'relative w-full'}
        onCreate={({ editor }: { editor: EditorInstance }) => assignEditor(editor)}
        onUpdate={({ editor }: { editor: EditorInstance }) => {
          assignEditor(editor)
          onFallbackUpdate?.(editor)
        }}
      >
        {enableComments ? (
          <DocBubbleMenu open={bubbleOpen} onOpenChange={setBubbleOpen}>
            <Separator orientation="vertical" />
            <StartCommentButton onStartComment={onStartComment} />
            {bubbleMenuExtra}
          </DocBubbleMenu>
        ) : null}
      </EditorContent>
    </EditorRoot>
  )
}
