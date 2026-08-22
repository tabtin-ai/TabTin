import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { Extension, type AnyExtension } from '@tiptap/core'
import { useEditor, EditorContent } from '@tiptap/react'
import { createDefaultDocExtensions } from '@tabtin/doc-editor'
import TextAlign from '@tiptap/extension-text-align'
import TextStyleExt from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
// 注意：不使用 @tiptap/extension-font-family，改用下方自定义的 PptFontFamily 扩展
// 原因：@tiptap/extension-font-family 的 setFontFamily 命令内部嵌套了 chain().run()，
// 在外层 chain 上下文中可能导致事务分发冲突
import Highlight from '@tiptap/extension-highlight'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import type { PPTTextElement as PPTTextEl } from '../../types/slides'
import { buildShadowStyle } from '../../utils/geometry'
import { sanitizeHtml } from '../../utils/sanitize'
import { useSlideStore } from '../../store/slide'
import { useHistoryStore } from '../../store/history'
import TextBubbleMenu from './TextBubbleMenu'

// ── PPT 专用自定义扩展 ──

const GENERIC_FONT_FAMILY_KEYWORDS = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
])

const INLINE_FONT_FALLBACK = `var(--tabslide-minor-font, 'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans SC', 'Source Han Sans SC', sans-serif)`

function splitFirstFontFamilyToken(input: string): string {
  let quote: '"' | '\'' | null = null
  let depth = 0
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === '\'') {
      const prev = i > 0 ? input[i - 1] : ''
      if (!prev || /\s|,|\(/.test(prev)) {
        quote = ch
        continue
      }
    }
    if (ch === '(') {
      depth += 1
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (ch === ',' && depth === 0) {
      return input.slice(0, i)
    }
  }
  return input
}

function extractPrimaryFontFamilyName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const primary = splitFirstFontFamilyToken(trimmed).trim().replace(/^['"]|['"]$/g, '')
  if (!primary) return null
  const lower = primary.toLowerCase()
  if (lower.startsWith('var(')) return null
  if (GENERIC_FONT_FAMILY_KEYWORDS.has(lower)) return null
  return primary
}

function toCssFontFamilyToken(fontName: string): string {
  const escaped = fontName.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  return `'${escaped}'`
}

/**
 * fontFamily — 在 textStyle mark 上增加 fontFamily 属性（替代 @tiptap/extension-font-family）
 *
 * 字体解析策略：
 * 后端 pptx_io 输出带 fallback 链的 font-family（如 "Calibri, 'Segoe UI', Arial, sans-serif"）。
 * Tiptap 只需存储**主字体名**（第一个），因为：
 * 1. fallback 链由容器的 defaultFontName 兜底
 * 2. 避免 Tiptap 将整个逗号分隔列表当成单一字体名
 */
const PptFontFamily = Extension.create({
  name: 'fontFamily',
  addGlobalAttributes() {
    return [{
      types: ['textStyle'],
      attributes: {
        fontFamily: {
          default: null,
          parseHTML: (el) => {
            const ff = (el as HTMLElement).style.fontFamily
            return extractPrimaryFontFamilyName(ff)
          },
          renderHTML: (attrs) => {
            if (!attrs.fontFamily) return {}
            const name = extractPrimaryFontFamilyName(attrs.fontFamily)
            if (!name) return {}
            return { style: `font-family: ${toCssFontFamilyToken(name)}, ${INLINE_FONT_FALLBACK}` }
          },
        },
      },
    }]
  },
})

/** themeColorKey — 在 textStyle mark 上保留 data-theme-color-key（用于主题色语义） */
const ThemeColorKey = Extension.create({
  name: 'themeColorKey',
  addGlobalAttributes() {
    return [{
      types: ['textStyle'],
      attributes: {
        themeColorKey: {
          default: null,
          parseHTML: (el) => (el as HTMLElement).getAttribute('data-theme-color-key') || null,
          renderHTML: (attrs) => attrs.themeColorKey
            ? { 'data-theme-color-key': String(attrs.themeColorKey) }
            : {},
        },
      },
    }]
  },
})

/** fontSize — 在 textStyle mark 上增加 fontSize 属性 */
const FontSize = Extension.create({
  name: 'fontSize',
  addGlobalAttributes() {
    return [{
      types: ['textStyle'],
      attributes: {
        fontSize: {
          default: null,
          parseHTML: (el) => (el as HTMLElement).style.fontSize || null,
          renderHTML: (attrs) => attrs.fontSize ? { style: `font-size: ${attrs.fontSize}` } : {},
        },
      },
    }]
  },
})

/** letterSpacing — 在 textStyle mark 上增加 letterSpacing 属性 */
const LetterSpacing = Extension.create({
  name: 'letterSpacing',
  addGlobalAttributes() {
    return [{
      types: ['textStyle'],
      attributes: {
        letterSpacing: {
          default: null,
          parseHTML: (el) => (el as HTMLElement).style.letterSpacing || null,
          renderHTML: (attrs) => attrs.letterSpacing ? { style: `letter-spacing: ${attrs.letterSpacing}` } : {},
        },
      },
    }]
  },
})

/** lineHeight — 在 paragraph 上增加 lineHeight 属性 */
const ParagraphLineHeight = Extension.create({
  name: 'paragraphLineHeight',
  addGlobalAttributes() {
    return [{
      types: ['paragraph'],
      attributes: {
        lineHeight: {
          default: null,
          parseHTML: (el) => (el as HTMLElement).style.lineHeight || null,
          renderHTML: (attrs) => attrs.lineHeight ? { style: `line-height: ${attrs.lineHeight}` } : {},
        },
      },
    }]
  },
})

/** marginTop — 段前间距（后端从 PPTX space_before 提取） */
const ParagraphSpaceBefore = Extension.create({
  name: 'paragraphSpaceBefore',
  addGlobalAttributes() {
    return [{
      types: ['paragraph'],
      attributes: {
        marginTop: {
          default: null,
          parseHTML: (el) => (el as HTMLElement).style.marginTop || null,
          renderHTML: (attrs) => attrs.marginTop ? { style: `margin-top: ${attrs.marginTop}` } : {},
        },
      },
    }]
  },
})

/** marginBottom — 段后间距（后端从 PPTX space_after 提取） */
const ParagraphSpaceAfter = Extension.create({
  name: 'paragraphSpaceAfter',
  addGlobalAttributes() {
    return [{
      types: ['paragraph'],
      attributes: {
        marginBottom: {
          default: null,
          parseHTML: (el) => (el as HTMLElement).style.marginBottom || null,
          renderHTML: (attrs) => attrs.marginBottom ? { style: `margin-bottom: ${attrs.marginBottom}` } : {},
        },
      },
    }]
  },
})

/** paddingLeft — 段落缩进（后端从 PPTX para.level / marL 提取） */
const ParagraphIndent = Extension.create({
  name: 'paragraphIndent',
  addGlobalAttributes() {
    return [{
      types: ['paragraph'],
      attributes: {
        paddingLeft: {
          default: null,
          parseHTML: (el) => (el as HTMLElement).style.paddingLeft || null,
          renderHTML: (attrs) => attrs.paddingLeft ? { style: `padding-left: ${attrs.paddingLeft}` } : {},
        },
        textIndent: {
          default: null,
          parseHTML: (el) => (el as HTMLElement).style.textIndent || null,
          renderHTML: (attrs) => attrs.textIndent ? { style: `text-indent: ${attrs.textIndent}` } : {},
        },
      },
    }]
  },
})

/**
 * PPT 专用 Tiptap 扩展集
 *
 * 基于 @tabtin/doc-editor 的 createDefaultDocExtensions，
 * 关闭 PPT 不需要的块级结构，追加文本样式扩展。
 *
 * 禁用 Tiptap 内置 History：PPT 编辑器使用全局 useHistoryStore 统一管理
 * undo/redo，避免 Tiptap 内部撤销与全局撤销两套独立系统造成体验断层。
 * 文本编辑中的 Ctrl+Z 会触发全局 undo，恢复到上一个 pushSnapshot 保存的状态。
 *
 * 静态创建，避免每次渲染重新实例化。
 */
const pptExtensions = [
  ...createDefaultDocExtensions({
    profile: {
      heading: false,
      codeBlock: false,
      table: false,
      taskList: false,
      blockquote: false,
    },
    disableMarkdown: true,
    disableHistory: true,
  }),
  TextAlign.configure({ types: ['paragraph'], alignments: ['left', 'center', 'right', 'justify'] }),
  TextStyleExt,
  Color,
  ThemeColorKey,
  PptFontFamily,
  FontSize,
  LetterSpacing,
  ParagraphLineHeight,
  ParagraphSpaceBefore,
  ParagraphSpaceAfter,
  ParagraphIndent,
  Highlight.configure({ multicolor: true }),
  Subscript,
  Superscript,
  // ⌘K 插入/编辑超链接快捷键 → 触发 TextBubbleMenu 中的 LinkPopover
  Extension.create({
    name: 'pptLinkShortcut',
    addKeyboardShortcuts() {
      return {
        'Mod-k': () => {
          window.dispatchEvent(new CustomEvent('tabslide:open-link-popover'))
          return true
        },
      }
    },
  }),
] as unknown as AnyExtension[]

interface TextElementProps {
  element: PPTTextEl
  isEditing: boolean
  onStartEdit: () => void
}

const justifyMap = { top: 'flex-start', middle: 'center', bottom: 'flex-end' } as const

// 文本渲染 fallback：优先元素声明字体，其次内嵌 Inter / Noto Sans SC（与 HTML 抽取端
// 量框所用字体一致），最后回退系统中文字体。这样 HTML 导入的文本在渲染端与量框用同一
// 套字体，避免字宽差异导致 overflow 截断。内嵌 Noto Sans SC 排在系统中文字体
// 之前，确保有嵌入时优先命中、与量框对齐。
const TEXT_FONT_FALLBACK =
  "'Inter', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif"

function buildTextFontFamily(defaultFontName?: string): string {
  const name = defaultFontName?.trim()
  if (!name) return TEXT_FONT_FALLBACK
  const token = /['",]/.test(name) ? name : `'${name}'`
  return `${token}, ${TEXT_FONT_FALLBACK}`
}

function buildTextContainerStyle(
  element: PPTTextEl,
  isEditing: boolean,
): React.CSSProperties {
  // 内边距（PPT 默认 left/right=7.2pt, top/bottom=3.6pt）
  const margin = element.margin
  const paddingStyle = margin
    ? `${margin.top ?? 3.6}pt ${margin.right ?? 7.2}pt ${margin.bottom ?? 3.6}pt ${margin.left ?? 7.2}pt`
    : '3.6pt 7.2pt'

  // 垂直对齐
  const vAlign = element.verticalAlign || 'top'

  // 阴影
  const shadowStyle = element.shadow
    ? buildShadowStyle(element.shadow)
    : undefined

  // 边框
  const outlineStyle = element.outline
    ? `${element.outline.width}px ${element.outline.style} ${element.outline.color}`
    : undefined

  return {
    width: '100%',
    height: '100%',
    fontFamily: buildTextFontFamily(element.defaultFontName),
    fontSize: element.defaultFontSize ? `${element.defaultFontSize}pt` : undefined,
    fontWeight: element.defaultFontWeight || undefined,
    color: element.defaultColor || undefined,
    lineHeight: element.lineHeight ? `${element.lineHeight}` : undefined,
    letterSpacing: element.wordSpace ? `${element.wordSpace}px` : undefined,
    textAlign: element.defaultTextAlign || undefined,
    background: element.fill || 'transparent',
    writingMode: element.vertical ? 'vertical-rl' : undefined,
    overflow: 'hidden',
    cursor: isEditing ? 'text' : 'default',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: justifyMap[vAlign],
    padding: paddingStyle,
    boxShadow: shadowStyle,
    border: outlineStyle,
  }
}

const TextElementStatic: React.FC<{
  element: PPTTextEl
  onStartEdit: () => void
}> = ({ element, onStartEdit }) => {
  const updateElement = useSlideStore((s) => s.updateElement)
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const paragraphSpaceVal = element.paragraphSpace ? element.paragraphSpace : 0
  const style = buildTextContainerStyle(element, false)

  // autoFit: 'shrink' — scale down content via CSS transform to fit container
  useLayoutEffect(() => {
    const container = containerRef.current
    const content = contentRef.current
    if (!container || !content) return

    if (element.autoFit !== 'shrink') {
      content.style.transform = ''
      content.style.width = '100%'
      content.style.transformOrigin = ''
      return
    }

    content.style.transform = 'none'
    content.style.width = '100%'
    content.style.transformOrigin = ''

    const isVertical = !!element.vertical
    const total = isVertical ? content.scrollWidth : content.scrollHeight
    const available = isVertical ? content.clientWidth : content.clientHeight

    if (total > available && total > 0) {
      const scale = Math.max(available / total, 0.25)
      content.style.transformOrigin = 'top left'
      content.style.transform = `scale(${scale})`
      if (isVertical) {
        content.style.height = `${100 / scale}%`
      } else {
        content.style.width = `${100 / scale}%`
      }
    }
  }, [
    element.autoFit, element.content, element.width, element.height,
    element.defaultFontSize, element.lineHeight, element.wordSpace,
    element.paragraphSpace, element.margin, element.vertical,
  ])

  // autoFit: 'resize' — expand element height (or width for vertical) to fit content
  useLayoutEffect(() => {
    if (element.autoFit !== 'resize') return
    const container = containerRef.current
    if (!container) return

    const isVertical = !!element.vertical
    const prop = isVertical ? 'width' : 'height'
    const saved = container.style[prop]
    container.style[prop] = 'auto'
    const naturalSize = isVertical ? container.scrollWidth : container.scrollHeight
    container.style[prop] = saved
    const currentSize = isVertical ? element.width : element.height

    if (Math.abs(naturalSize - currentSize) > 2) {
      // 在下一次动画帧执行，避免 React 同步 commit 导致的深度更新循环
      requestAnimationFrame(() => {
        const latestEl = useSlideStore.getState().presentation?.pages
          .flatMap(p => p.elements)
          .find(el => el.id === element.id) as PPTTextEl | undefined
        // 确保元素仍然存在且大小依然需要更新
        if (latestEl && Math.abs(naturalSize - (isVertical ? latestEl.width : latestEl.height)) > 2) {
          updateElement(element.id, { [prop]: naturalSize } as Partial<PPTTextEl>)
        }
      })
    }
  }, [
    element.autoFit, element.content, element.id, element.height, element.width,
    element.defaultFontSize, element.lineHeight, element.wordSpace,
    element.paragraphSpace, element.margin, element.vertical, updateElement,
  ])

  return (
    <div
      ref={containerRef}
      id={`tabslide-text-${element.id}`}
      style={style}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onStartEdit()
      }}
    >
      {paragraphSpaceVal > 0 && (
        <style>{`#tabslide-text-${element.id} .tabslide-text-content p + p:not([style*="margin-top"]) { margin-top: ${paragraphSpaceVal}pt; }`}</style>
      )}
      <div
        ref={contentRef}
        className="tabslide-text-content"
        style={{ width: '100%', height: '100%' }}
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(element.content || '') }}
      />
    </div>
  )
}

const TextElementEditing: React.FC<{
  element: PPTTextEl
  onStartEdit: () => void
}> = ({ element, onStartEdit }) => {
  const updateElement = useSlideStore((s) => s.updateElement)

  // 追踪编辑器最新内容（不触发渲染）
  const latestHtmlRef = useRef(element.content || '')
  // 追踪 store 中的最新 content（避免 effect 中闭包问题）
  const storeContentRef = useRef(element.content || '')
  storeContentRef.current = element.content || ''

  // debounce 自动快照定时器
  const autoSnapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const autoFitSizeRef = useRef(element.vertical ? element.width : element.height)
  autoFitSizeRef.current = element.vertical ? element.width : element.height

  /**
   * 将编辑器当前内容 flush 到 store。
   * 由 tabslide:flush-text-edit 事件触发（全局 undo/redo 前调用），
   * 确保撤销前的文本修改不丢失。
   */
  const flushTextToStore = useCallback(() => {
    const html = latestHtmlRef.current
    if (html !== storeContentRef.current) {
      const presentation = useSlideStore.getState().presentation
      if (presentation) {
        useHistoryStore.getState().pushSnapshot(presentation.pages)
      }
      updateElement(element.id, { content: html } as Partial<PPTTextEl>)
      storeContentRef.current = html
    }
  }, [element.id, updateElement])

  const editor = useEditor({
    extensions: pptExtensions,
    content: element.content || '',
    editable: true,
    editorProps: {
      attributes: {
        style: [
          'outline: none',
          'border: none',
          'box-shadow: none',
          'height: 100%',
          'white-space: pre-wrap',
          'word-break: break-word',
        ].join('; '),
      },
    },
    onUpdate: ({ editor: ed }) => {
      latestHtmlRef.current = ed.getHTML()

      // 文本编辑中自动推快照（debounce 600ms），
      // 让全局 undo/redo 能恢复文字编辑的中间状态
      if (autoSnapshotTimerRef.current) clearTimeout(autoSnapshotTimerRef.current)
      autoSnapshotTimerRef.current = setTimeout(() => {
        autoSnapshotTimerRef.current = null
        flushTextToStore()
      }, 600)
    },
  })

  // ── Effect: 监听 flush 事件（全局 undo/redo 前触发） ──
  useEffect(() => {
    const handler = () => {
      if (autoSnapshotTimerRef.current) {
        clearTimeout(autoSnapshotTimerRef.current)
        autoSnapshotTimerRef.current = null
      }
      flushTextToStore()
    }
    window.addEventListener('tabslide:flush-text-edit', handler)
    return () => window.removeEventListener('tabslide:flush-text-edit', handler)
  }, [flushTextToStore])

  // 首次挂载聚焦
  useEffect(() => {
    if (!editor) return
    let mounted = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const raf = requestAnimationFrame(() => {
      if (!mounted) return
      editor.commands.focus('end')
      // 某些场景下（双击切换编辑态）需要再补一次异步 focus，确保光标稳定出现
      timer = setTimeout(() => {
        if (!mounted) return
        editor.commands.focus('end')
      }, 0)
    })
    return () => {
      mounted = false
      cancelAnimationFrame(raf)
      if (timer) clearTimeout(timer)
    }
  }, [editor])

  // 卸载时落盘最新文本，避免模式切换丢字
  useEffect(() => {
    return () => {
      if (autoSnapshotTimerRef.current) {
        clearTimeout(autoSnapshotTimerRef.current)
        autoSnapshotTimerRef.current = null
      }
      flushTextToStore()
    }
  }, [flushTextToStore])

  // ── Effect: 外部 store 变化（undo/redo/AI 更新/协同同步）→ 同步到编辑器 ──
  useEffect(() => {
    if (!editor) return
    const storeContent = element.content || ''
    const editorContent = editor.getHTML()

    if (editorContent !== storeContent) {
      // B1-01 LWW 缓解：用户正在打字时（debounce 定时器活跃），跳过外部同步，
      // 避免远程协同更新无声覆盖本地正在编辑的内容。
      // Undo/redo 会先 dispatch flush-text-edit 清空定时器，因此不受影响。
      // B1-05: 编辑器聚焦时也跳过，防止 setContent 重置光标位置抢夺焦点。
      if (autoSnapshotTimerRef.current !== null || editor.isFocused) {
        return
      }
      editor.commands.setContent(storeContent, false)
      latestHtmlRef.current = storeContent
    }
  }, [element.content, editor])

  // autoFit: 'resize' — expand element height as user types
  useEffect(() => {
    if (element.autoFit !== 'resize') return
    if (!editor) return
    const container = containerRef.current
    if (!container) return

    const isVertical = !!element.vertical
    const measure = () => {
      const prop = isVertical ? 'width' : 'height'
      const saved = container.style[prop]
      container.style[prop] = 'auto'
      const naturalSize = isVertical ? container.scrollWidth : container.scrollHeight
      container.style[prop] = saved

      if (Math.abs(naturalSize - autoFitSizeRef.current) > 1) {
        updateElement(element.id, { [prop]: naturalSize } as Partial<PPTTextEl>)
        autoFitSizeRef.current = naturalSize
      }
    }

    editor.on('update', measure)
    measure()
    return () => { editor.off('update', measure) }
  }, [element.autoFit, element.id, element.vertical, editor, updateElement])

  const style = buildTextContainerStyle(element, true)
  const paragraphSpaceVal = element.paragraphSpace ? element.paragraphSpace : 0

  return (
    <div
      ref={containerRef}
      id={`tabslide-text-${element.id}`}
      style={style}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onStartEdit()
      }}
      onMouseDown={(e) => {
        // 编辑模式下阻止冒泡，避免触发 Canvas 的框选/拖拽
        e.stopPropagation()
      }}
      onKeyDown={(e) => {
        // 阻止 Delete/Backspace/Ctrl+A 等冒泡到 useKeyboard，
        // 仅放行 Escape（退出编辑）和 Undo/Redo（全局历史管理）。
        const isMod = e.ctrlKey || e.metaKey
        const isUndoRedo = isMod && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')
        if (e.key !== 'Escape' && !isUndoRedo) {
          e.stopPropagation()
        }
      }}
    >
      {paragraphSpaceVal > 0 && (
        <style>{`#tabslide-text-${element.id} .ProseMirror p + p:not([style*="margin-top"]) { margin-top: ${paragraphSpaceVal}pt; }`}</style>
      )}

      <EditorContent
        editor={editor}
        style={{ width: '100%', height: '100%' }}
      />

      {/* 浮动格式化工具栏：始终挂载，通过 shouldShow 控制可见性 */}
      {editor && <TextBubbleMenu editor={editor} isEditing />}
    </div>
  )
}

/**
 * TextElement — PPT 富文本元素
 *
 * 非编辑态使用轻量静态 HTML 渲染；仅在编辑态挂载 Tiptap，
 * 避免缩略图/普通浏览状态为每个文本框创建 Editor 实例。
 *
 * 交互流程：
 * 1. 默认只读展示 HTML 内容
 * 2. 双击进入编辑模式（Tiptap 变为 editable + 自动聚焦）
 * 3. 编辑过程中实时追踪内容（通过 onUpdate ref，不触发 React 渲染）
 * 4. 退出编辑时一次性保存到 store
 * 5. 外部 store 变化（undo/redo）→ 同步回编辑器
 */
const TextElement: React.FC<TextElementProps> = ({ element, isEditing, onStartEdit }) => {
  if (!isEditing) {
    return <TextElementStatic element={element} onStartEdit={onStartEdit} />
  }
  return <TextElementEditing element={element} onStartEdit={onStartEdit} />
}

export default React.memo(TextElement)
