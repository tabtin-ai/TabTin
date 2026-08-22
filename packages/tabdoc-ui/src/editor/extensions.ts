/**
 * Tabdoc editor extensions configuration.
 *
 * Uses novel's re-exported Tiptap extensions + tiptap-markdown for automatic
 * Markdown ↔ ProseMirror bidirectional conversion.
 */
import {
  AIHighlight,
  CharacterCount,
  CodeBlockLowlight,
  Color,
  CustomKeymap,
  HighlightExtension,
  HorizontalRule,
  Placeholder,
  StarterKit,
  TaskItem,
  TaskList,
  TextStyle,
  TiptapImage,
  TiptapLink,
  TiptapUnderline,
  Twitter,
  Youtube,
} from 'novel'
import { Markdown } from 'tiptap-markdown'
import { Table } from '@tiptap/extension-table'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableRow } from '@tiptap/extension-table-row'
import { TableCell } from '@tiptap/extension-table-cell'
import TextAlign from '@tiptap/extension-text-align'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import { cx } from 'class-variance-authority'
import { common, createLowlight } from 'lowlight'

import { mergeAttributes, type Extensions } from '@tiptap/core'
import UniqueID from '@tiptap/extension-unique-id'
import { ReactNodeViewRenderer } from '@tiptap/react'
import {
  TabDataBlock,
  CanvasBlock,
  HtmlBlock,
} from '@tabtin/doc-editor'
import { TabDataBlockView } from './tabdata-block/TabDataBlockView'
import { CanvasBlockView } from './canvas-block/CanvasBlockView'
import { HtmlBlockView } from './html-block/HtmlBlockView'
import { ImageAssetView } from './image-asset/ImageAssetView'
import { MathematicsWithMarkdown } from './math-serializer'
import { TabDocGlobalDragHandle } from './global-drag-handle'
import { TableExit } from './table-exit'
import { isPristineEmptyDocumentBody } from './empty-document-body'
import { insertCodeBlockTab } from './editor-keyboard'

type TranslateFn = (key: string, options?: Record<string, unknown>) => string

const defaultPlaceholderText = 'Type "/" to quickly insert content'
export const TABDOC_DRAG_HANDLE_ID_ATTR = 'data-tabdoc-drag-handle-id'

const aiHighlight = AIHighlight

let tabDocDragHandleIdCounter = 0

export function createTabDocDragHandleId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `tabdoc-drag-handle-${uuid}`

  tabDocDragHandleIdCounter += 1
  return `tabdoc-drag-handle-${tabDocDragHandleIdCounter}`
}

export function getTabDocDragHandleSelector(id: string): string {
  return `[${TABDOC_DRAG_HANDLE_ID_ATTR}="${id}"]`
}

/**
 * 仅在整篇可编辑正文为空时显示引导。
 *
 * 不使用 emptyNodeClass 对普通空段落展示提示，避免已有正文末尾的新段落
 * 重复出现“输入 /”引导；只读态由 Placeholder 自身自动隐藏。
 */
export function createEmptyDocumentPlaceholder(
  t?: TranslateFn,
): Extensions[number] {
  return Placeholder.configure({
    placeholder: ({ editor }) => {
      if (!isPristineEmptyDocumentBody(editor.state.doc)) return ''
      return t?.('editorPlaceholder', { defaultValue: defaultPlaceholderText }) ?? defaultPlaceholderText
    },
    includeChildren: false,
    showOnlyWhenEditable: true,
  })
}

const tiptapLink = TiptapLink.configure({
  // ：链接点击由宿主接管（useDocEditorViewState 的 editorProps.handleClick
  // → TabDocHostActions.openWebUrl → 当前 Space 内置浏览器）。关闭扩展自带的
  // openOnClick，避免重复触发或直跳系统浏览器。
  openOnClick: false,
  HTMLAttributes: {
    class: cx(
      'text-muted-foreground underline underline-offset-[3px] hover:text-primary transition-colors cursor-pointer',
    ),
  },
})

const IMAGE_DIMENSION_RE = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i

function normalizeImageDimension(value: unknown): number | null {
  let numeric: number
  if (typeof value === 'number') {
    numeric = value
  } else if (typeof value === 'string') {
    const match = IMAGE_DIMENSION_RE.exec(value)
    if (!match) return null
    numeric = Number(match[1])
  } else {
    return null
  }
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return Math.max(1, Math.round(numeric))
}

function renderImageDimensionAttribute(value: unknown, attrName: 'width' | 'height'): Record<string, string> {
  const normalized = normalizeImageDimension(value)
  return normalized === null ? {} : { [attrName]: String(normalized) }
}

function renderImageDimensionStyle(attributes: Record<string, unknown>): Record<string, string> {
  const width = normalizeImageDimension(attributes.width)
  const height = normalizeImageDimension(attributes.height)
  const sizeStyle = [
    width === null ? '' : `width: ${width}px`,
    height === null ? '' : `height: ${height}px`,
  ].filter(Boolean)
  if (sizeStyle.length === 0) return {}
  const existingStyle = typeof attributes.style === 'string'
    ? attributes.style.trim().replace(/;$/, '')
    : ''
  const style = [existingStyle, ...sizeStyle].filter(Boolean).join('; ')
  return { style }
}

const docImage = TiptapImage.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ImageAssetView)
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      fileId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-file-id'),
        renderHTML: (attributes: Record<string, unknown>) => {
          const fileId = typeof attributes.fileId === 'string' ? attributes.fileId.trim() : ''
          return fileId ? { 'data-file-id': fileId } : {}
        },
      },
      width: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          normalizeImageDimension(element.getAttribute('width') || element.style.width),
        renderHTML: (attributes: Record<string, unknown>) =>
          renderImageDimensionAttribute(attributes.width, 'width'),
      },
      height: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          normalizeImageDimension(element.getAttribute('height') || element.style.height),
        renderHTML: (attributes: Record<string, unknown>) =>
          renderImageDimensionAttribute(attributes.height, 'height'),
      },
    }
  },
  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(
      this.options.HTMLAttributes,
      HTMLAttributes,
      renderImageDimensionStyle(HTMLAttributes),
    )]
  },
  // 不再挂 Novel UploadImagesPlugin：其 Decoration.widget(pos+1) 会把粘贴/斜杠
  // 插入点偏一格；上传占位与最终插入改由 TabDoc image-upload / image-insert 自管。
}).configure({
  // TD-13 : inline 图片节点，与服务端 schema（serverSchema 的 image
  // group:'inline'）及 markdown/历史二进制里「段落内 inline 图片」的形态对齐。
  // 此前编辑器用 @tiptap/extension-image 默认 inline:false（block），段落里的
  // inline 图片在协作加载时被 schema 判非法丢弃，导致「AI 写的图片正文看不到、
  // 历史里却在」。改回 inline 后图片可合法地待在段落内，无需迁移历史数据。
  inline: true,
  allowBase64: true,
  HTMLAttributes: {
    class: cx('rounded-lg border border-muted'),
  },
})

const taskList = TaskList.configure({
  HTMLAttributes: {
    class: cx('not-prose pl-0'),
  },
})

const taskItem = TaskItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      todoId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-todo-id'),
        renderHTML: (attributes: Record<string, unknown>) => {
          if (!attributes.todoId) return {}
          return { 'data-todo-id': attributes.todoId }
        },
      },
    }
  },
}).configure({
  HTMLAttributes: {
    class: cx('flex items-start gap-1 my-1'),
  },
  nested: true,
})

const horizontalRule = HorizontalRule.configure({
  HTMLAttributes: {},
})

const starterKit = StarterKit.configure({
  bulletList: {
    HTMLAttributes: {},
  },
  orderedList: {
    HTMLAttributes: {},
  },
  listItem: {
    HTMLAttributes: {},
  },
  blockquote: {
    HTMLAttributes: {},
  },
  codeBlock: false,
  code: {
    HTMLAttributes: {
      spellcheck: 'false',
    },
  },
  horizontalRule: false,
  dropcursor: {
    color: '#DBEAFE',
    width: 4,
  },
  // Gapcursor 打开：表/图片等结构块为末节点时可落点到块后
})

const codeBlockLowlight = CodeBlockLowlight.extend({
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      Tab: () => insertCodeBlockTab(this.editor),
    }
  },
}).configure({
  lowlight: createLowlight(common),
})

const characterCount = CharacterCount.configure({})

const table = Table.configure({
  resizable: true,
  allowTableNodeSelection: true,
})
const tableRow = TableRow.configure()
const tableCell = TableCell.configure()
const tableHeader = TableHeader.configure()

const youtube = Youtube.configure({
  HTMLAttributes: {
    class: cx('rounded-lg border border-muted'),
  },
  inline: false,
})

const twitter = Twitter.configure({
  HTMLAttributes: {
    class: cx('not-prose'),
  },
  inline: false,
})

const mathematics = MathematicsWithMarkdown.configure({
  HTMLAttributes: {
    class: cx('text-foreground rounded p-1 hover:bg-accent cursor-pointer'),
  },
  katexOptions: {
    throwOnError: false,
  },
})

const markdownExtension = Markdown.configure({
  html: true,
  tightLists: true,
  tightListClass: 'tight',
  bulletListMarker: '-',
  linkify: false,
  breaks: false,
  transformPastedText: true,
  transformCopiedText: true,
})

const createGlobalDragHandle = (dragHandleSelector?: string) => TabDocGlobalDragHandle.configure({
  ...(dragHandleSelector ? { dragHandleSelector } : {}),
  customNodes: ['tabdata-block', 'tabwhiteboard', 'html-block'],
})

const tabDataBlock = TabDataBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(TabDataBlockView)
  },
})

const canvasBlock = CanvasBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CanvasBlockView)
  },
})

const textAlign = TextAlign.configure({
  types: ['heading', 'paragraph'],
  alignments: ['left', 'center', 'right', 'justify'],
})

const importFidelityMarks = [
  textAlign,
  Subscript,
  Superscript,
] as const

const htmlBlock = HtmlBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(HtmlBlockView)
  },
})

/** Share / preview path also needs NodeView so private HTML can Blob-resolve . */
const standaloneHtmlBlock = HtmlBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(HtmlBlockView)
  },
})

/**
 * 给文本类顶层块补稳定 blockId。
 * 故意不含 atom（htmlBlock / tabdataBlock / tabwhiteboard）：
 * UniqueID 在 content.size===0 时会挪 id，可能改写已分享 html 块的 blockId。
 * atom 的 id 由插入路径 + HtmlBlockView 自愈负责。
 */
const UNIQUE_ID_TEXT_BLOCK_TYPES = [
  'heading',
  'paragraph',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'blockquote',
  'codeBlock',
  'table',
  'horizontalRule',
  'image',
] as const

const uniqueIdExtension = UniqueID.configure({
  types: [...UNIQUE_ID_TEXT_BLOCK_TYPES],
  attributeName: 'blockId',
})

export const defaultExtensions: Extensions = [
  starterKit,
  tiptapLink,
  docImage,
  taskList,
  taskItem,
  table,
  tableRow,
  tableCell,
  tableHeader,
  TableExit,
  horizontalRule,
  aiHighlight,
  codeBlockLowlight,
  youtube,
  twitter,
  mathematics,
  characterCount,
  TiptapUnderline,
  markdownExtension,
  HighlightExtension,
  TextStyle,
  Color,
  ...importFidelityMarks,
  CustomKeymap,
  createGlobalDragHandle(),
  tabDataBlock,
  canvasBlock,
  htmlBlock,
  uniqueIdExtension,
]

/**
 * 独立渲染扩展集（公开分享页 / 预览 / 嵌入等场景，与宿主 runtime 解耦）。
 *
 * 当前服务于只读渲染，但**不限于只读**——可编辑态由 DocRenderer 的 `editable`
 * 开关控制，本扩展集对两者通用。与 defaultExtensions 的差异：
 * - 不含强编辑期能力：GlobalDragHandle（拖拽手柄）、CustomKeymap（编辑快捷键）、Placeholder。
 * - tabdata / canvas 嵌入块用 @tabtin/doc-editor 的**原始 Node 定义**（自带 renderHTML 占位：
 *   📊/🔀 + 标题），**不挂 React NodeView** —— 因此无需宿主 runtime（TabDocHostActions /
 *   表格 store），可安全用于匿名公开页。嵌入表格在此场景降级为占位（v1）。
 * - html 嵌入块挂 React NodeView（与编辑器一致），通过 HtmlArtifactLoader 拉取私有
 *   内容并 Blob 渲染；历史公开 src 仍可回退。renderHTML 仅作无 React 时的降级。
 *
 * 其余文本/排版扩展与编辑器完全一致，保证渲染与编辑器视觉一致。
 */
export const standaloneExtensions: Extensions = [
  starterKit,
  tiptapLink,
  docImage,
  taskList,
  taskItem,
  table,
  tableRow,
  tableCell,
  tableHeader,
  horizontalRule,
  aiHighlight,
  codeBlockLowlight,
  youtube,
  twitter,
  mathematics,
  characterCount,
  TiptapUnderline,
  markdownExtension,
  HighlightExtension,
  TextStyle,
  Color,
  ...importFidelityMarks,
  TabDataBlock,
  CanvasBlock,
  standaloneHtmlBlock,
]

/**
 * 可编辑的独立扩展集（公开分享 edit 权限 / 可编辑预览等场景）。
 *
 * = standaloneExtensions（嵌入块占位渲染、不依赖宿主 runtime）
 *   + GlobalDragHandle（左侧拖拽手柄，editable 态才有意义）
 *   + CustomKeymap（编辑期快捷键）。
 *
 * 与 defaultExtensions 的区别仍是「嵌入块用原始 Node 占位、不挂 React NodeView」，
 * 因此可安全用于匿名公开页；slash command 由调用方按需追加（需注入 t / 上传函数）。
 */
export const standaloneEditableExtensions: Extensions = [
  ...standaloneExtensions,
  TableExit,
  CustomKeymap,
  createGlobalDragHandle(),
]

export function createEditableExtensions(options: {
  dragHandleSelector?: string
  disableMarkdown?: boolean
  /** 协作态须关闭：StarterKit History 与 @tiptap/extension-collaboration 的 yUndo 冲突 */
  disableHistory?: boolean
} = {}): Extensions {
  const markdownParts = options.disableMarkdown ? [] : [markdownExtension]
  const kit = options.disableHistory ? starterKit.configure({ history: false }) : starterKit
  return [
    kit,
    tiptapLink,
    docImage,
    taskList,
    taskItem,
    table,
    tableRow,
    tableCell,
    tableHeader,
    TableExit,
    horizontalRule,
    aiHighlight,
    codeBlockLowlight,
    youtube,
    twitter,
    mathematics,
    characterCount,
    TiptapUnderline,
    ...markdownParts,
    HighlightExtension,
    TextStyle,
    Color,
    ...importFidelityMarks,
    CustomKeymap,
    createGlobalDragHandle(options.dragHandleSelector),
    tabDataBlock,
    canvasBlock,
    htmlBlock,
    uniqueIdExtension,
  ]
}

export function createStandaloneEditableExtensions(options: { dragHandleSelector?: string } = {}): Extensions {
  return [
    ...standaloneExtensions,
    TableExit,
    CustomKeymap,
    createGlobalDragHandle(options.dragHandleSelector),
  ]
}

/**
 * 创建包含 Placeholder 的完整扩展列表。
 * Placeholder 需要 i18n 翻译函数，由宿主注入。
 */
export function createDefaultExtensionsWithPlaceholder(
  t?: TranslateFn,
): Extensions {
  return [createEmptyDocumentPlaceholder(t), ...defaultExtensions]
}
