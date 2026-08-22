/**
 * DocRenderer — 文档渲染器（宿主无关，独立渲染）
 *
 * 复用编辑器同一套 Tiptap 扩展（standaloneExtensions）渲染 ProseMirror JSON，
 * 保证公开分享页 / 预览 / 嵌入等场景与编辑器视觉一致。
 *
 * - `editable` 默认 false（当前简化版：只读）；后续可传 `editable` + `onUpdate` 支持可编辑分享。
 * - 不依赖宿主 runtime / 协作；嵌入块（tabdata/canvas）降级为占位渲染。
 * - 内容优先用 PM JSON（contentJson）；缺失时退回 markdown（经 doc-editor 转换）。
 */
import { useMemo } from 'react'
import { markdownToPmJson, normalizeMathPmJson } from '@tabtin/doc-editor'
import { EditorContent, EditorRoot, type EditorInstance } from 'novel'
import { standaloneExtensions } from './extensions'

const EMPTY_DOC: Record<string, unknown> = { type: 'doc', content: [] }

export interface DocRendererProps {
  /** ProseMirror / TipTap JSON（首选，保证与编辑器一致） */
  contentJson?: Record<string, unknown> | null
  /** 退路：仅有 markdown 时转换渲染 */
  contentMarkdown?: string | null
  /** 是否可编辑（默认 false：只读）。预留给后续可编辑分享场景 */
  editable?: boolean
  /** 可编辑态的内容更新回调 */
  onUpdate?: (editor: EditorInstance) => void
  /** 编辑器内容容器 className */
  className?: string
}

export function DocRenderer({
  contentJson,
  contentMarkdown,
  editable = false,
  onUpdate,
  className,
}: DocRendererProps) {
  const content = useMemo<Record<string, unknown>>(() => {
    if (
      contentJson &&
      typeof contentJson === 'object' &&
      Object.keys(contentJson).length > 0
    ) {
      return normalizeMathPmJson(contentJson)
    }
    if (contentMarkdown && contentMarkdown.trim().length > 0) {
      try {
        return normalizeMathPmJson(
          markdownToPmJson(contentMarkdown) as Record<string, unknown>,
        )
      } catch {
        return EMPTY_DOC
      }
    }
    return EMPTY_DOC
  }, [contentJson, contentMarkdown])

  const editorProps = useMemo(() => ({ editable: () => editable }), [editable])

  return (
    <EditorRoot>
      <EditorContent
        immediatelyRender={false}
        initialContent={content as never}
        extensions={standaloneExtensions}
        editorProps={editorProps}
        className={className ?? 'relative w-full'}
        onUpdate={onUpdate ? ({ editor }: { editor: EditorInstance }) => onUpdate(editor) : undefined}
      />
    </EditorRoot>
  )
}
