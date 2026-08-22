import React, { useCallback, useRef, useEffect } from 'react'
import type { PPTShapeElement, ShapeText } from '../../types/slides'
import { useSlideStore } from '../../store/slide'
import { useHistoryStore } from '../../store/history'
import { sanitizeHtml } from '../../utils/sanitize'
import * as t from '../../theme'

interface ShapeTextEditorProps {
  element: PPTShapeElement
  text: ShapeText
  clipPathId: string
}

/**
 * 形状内文字编辑器
 *
 * 使用 HTML overlay（而非 SVG foreignObject 内的 contentEditable），
 * 因为 SVG foreignObject 内的 contentEditable 在部分浏览器中有兼容问题。
 *
 * 交互流程：
 * 1. 双击形状 → MoveableWrapper setEditing → isEditing=true → 覆盖层出现
 * 2. 用户编辑文字
 * 3. 点击形状外部 → blur → 保存到 store
 */
const ShapeTextEditor: React.FC<ShapeTextEditorProps> = ({ element, text }) => {
  const updateElement = useSlideStore((s) => s.updateElement)
  const editorRef = useRef<HTMLDivElement>(null)
  const latestHtmlRef = useRef(text.content || '')
  const storeContentRef = useRef(text.content || '')
  storeContentRef.current = text.content || ''

  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    el.focus()
    // 光标移到末尾
    const selection = window.getSelection()
    if (selection) {
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
    }
  }, [])

  const flushTextToStore = useCallback(() => {
    const rawHtml = editorRef.current?.innerHTML ?? latestHtmlRef.current
    const html = sanitizeHtml(rawHtml || '')
    if (html === storeContentRef.current) return

    const presentation = useSlideStore.getState().presentation
    if (presentation) {
      useHistoryStore.getState().pushSnapshot(presentation.pages)
    }

    const currentPage = useSlideStore.getState().currentPage()
    const currentShape = currentPage?.elements.find(
      (el): el is PPTShapeElement => el.id === element.id && el.type === 'shape',
    )
    const baseText = currentShape?.text ?? text

    updateElement(element.id, {
      text: { ...baseText, content: html },
    } as Partial<PPTShapeElement>)

    latestHtmlRef.current = html
    storeContentRef.current = html
  }, [element.id, text, updateElement])

  const handleBlur = useCallback(() => {
    flushTextToStore()
    useSlideStore.getState().setEditing(null)
  }, [flushTextToStore])

  useEffect(() => {
    const handler = () => flushTextToStore()
    window.addEventListener('tabslide:flush-text-edit', handler)
    return () => {
      window.removeEventListener('tabslide:flush-text-edit', handler)
      flushTextToStore()
    }
  }, [flushTextToStore])

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: text.align === 'right' ? 'flex-end' : text.align === 'center' ? 'center' : 'flex-start',
        justifyContent: text.verticalAlign === 'bottom' ? 'flex-end' : text.verticalAlign === 'middle' ? 'center' : 'flex-start',
        fontSize: text.defaultFontSize || 18,
        color: text.defaultColor || t.textPrimary,
        fontFamily: text.defaultFontName || 'inherit',
        textAlign: text.align || 'left',
        padding: '8px',
        overflow: 'hidden',
        wordBreak: 'break-word',
        zIndex: 5,
      }}
    >
      <style>{`.tabslide-shape-text-${element.id} p { margin: 0; }`}</style>
      <div
        ref={editorRef}
        className={`tabslide-shape-text-${element.id}`}
        contentEditable
        suppressContentEditableWarning
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(text.content || '') }}
        onBlur={handleBlur}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          const isMod = e.ctrlKey || e.metaKey
          const isUndoRedo = isMod && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')
          if (e.key !== 'Escape' && !isUndoRedo) {
            e.stopPropagation()
          }
        }}
        onInput={() => {
          if (editorRef.current) {
            latestHtmlRef.current = editorRef.current.innerHTML
          }
        }}
        style={{
          width: '100%',
          border: 'none',
          outline: 'none',
          boxShadow: 'none',
          background: 'transparent',
          appearance: 'none',
          WebkitAppearance: 'none',
          cursor: 'text',
          minHeight: '1em',
        }}
      />
    </div>
  )
}

export default ShapeTextEditor
