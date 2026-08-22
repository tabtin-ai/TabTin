/**
 * 服务端 ProseMirror Schema
 *
 * 提供与编辑器一致的 Schema 供服务端（collab-live、yjsConverters）使用，
 * 确保 markdown ↔ Y.js 转换时所有节点类型都被正确识别。
 *
 * 基于 createDefaultDocExtensions 生成，禁用仅客户端的扩展
 * （tiptap-markdown、History），额外注册 markdownToPmJson 可能产出
 * 但编辑器尚未内置的 image / mathematics 节点。
 */

/**
 * TabDoc ProseMirror Schema 版本号。
 * 每次 schema 增减节点/mark/属性时手动递增。
 * collab-live 用此版本号检测客户端与服务端 schema 兼容性。
 *
 * v4：新增 htmlBlock 节点（HTML 嵌入块）。
 * v5：image 新增可选 fileId，私有图片以稳定文件引用作为 source of truth。
 * 递增仅触发 collab-live 的版本重戳（migrateDocument 为 no-op，纯新增节点无需数据迁移）。
 */
export const DOC_SCHEMA_VERSION = 5

import type { Schema } from '@tiptap/pm/model'
import { Extension, getSchema, Mark as TiptapMark, Node as TiptapNode } from '@tiptap/core'
import type { AnyExtension } from '@tiptap/core'
import { createDefaultDocExtensions } from '../extensions/createDefaultDocExtensions.js'
import { COLLABORATIVE_BLOCK_TYPES } from '../extensions/createCollaborativeDocExtensions.js'

const MinimalImage = TiptapNode.create({
  name: 'image',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return {
      src: { default: null },
      fileId: { default: null },
      alt: { default: null },
      title: { default: null },
      width: { default: null },
      height: { default: null },
    }
  },
})

const MinimalMathematics = TiptapNode.create({
  name: 'mathematics',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return {
      latex: { default: '' },
      display: { default: false },
    }
  },
})

/**
 * 块级数学公式节点（$$...$$）。
 * markdownToPmJson / Django 对块级公式产出此节点，
 * 避免把 inline `mathematics` 放在块级位置导致 schema 校验失败。
 * 历史顶层 `mathematics{display:true}` 由 normalizeMathPmJson 迁到本节点。
 */
const MinimalMathBlock = TiptapNode.create({
  name: 'mathematicsBlock',
  group: 'block',
  atom: true,
  addAttributes() {
    return {
      latex: { default: '' },
    }
  },
})

const tabDataBlockAttributes = () => ({
  tableId: { default: '' },
  viewId: { default: null },
  title: { default: '未命名表格' },
  maxHeight: { default: 400 },
})

const renderTabDataBlockHtml = (HTMLAttributes: Record<string, unknown>) => ['div', {
  'data-type': 'tabdata-block',
  'data-table-id': HTMLAttributes.tableId ?? '',
  ...(HTMLAttributes.viewId ? { 'data-view-id': HTMLAttributes.viewId } : {}),
  'data-table-title': HTMLAttributes.title ?? '未命名表格',
  'data-max-height': String(HTMLAttributes.maxHeight ?? 400),
}] as const

const MinimalTabDataBlock = TiptapNode.create({
  name: 'tabdataBlock',
  group: 'block',
  atom: true,
  addAttributes() {
    return tabDataBlockAttributes()
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-type="tabdata-block"]',
        getAttrs(dom: HTMLElement) {
          return {
            tableId: dom.getAttribute('data-table-id') || '',
            viewId: dom.getAttribute('data-view-id') || null,
            title: dom.getAttribute('data-table-title') || '未命名表格',
            maxHeight: Number(dom.getAttribute('data-max-height')) || 400,
          }
        },
      },
    ]
  },
  renderHTML({ HTMLAttributes }) {
    return renderTabDataBlockHtml(HTMLAttributes)
  },
})

const tabWhiteboardAttributes = () => ({
  canvasId: { default: '' },
  title: { default: '未命名白板' },
})

const renderTabWhiteboardHtml = (HTMLAttributes: Record<string, unknown>) => ['div', {
  'data-type': 'tabwhiteboard',
  'data-canvas-id': HTMLAttributes.canvasId ?? '',
  'data-canvas-title': HTMLAttributes.title ?? '未命名白板',
}] as const

const MinimalTabWhiteboard = TiptapNode.create({
  name: 'tabwhiteboard',
  group: 'block',
  atom: true,
  addAttributes() {
    return tabWhiteboardAttributes()
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-type="tabwhiteboard"]',
        getAttrs(dom: HTMLElement) {
          return {
            canvasId: dom.getAttribute('data-canvas-id') || '',
            title: dom.getAttribute('data-canvas-title') || '未命名白板',
          }
        },
      },
    ]
  },
  renderHTML({ HTMLAttributes }) {
    return renderTabWhiteboardHtml(HTMLAttributes)
  },
})

/**
 * HTML 嵌入块节点。
 * 只存 OSS 文件引用（fileId + src），渲染为受控 sandbox iframe。
 * 需在 serverSchema 注册，否则协作加载（Y.js → PM JSON）时会被
 * degradeUnknownNodes 降级为 paragraph 导致节点丢失（历史坑 TD-13 / ）。
 */
const htmlBlockAttributes = () => ({
  fileId: { default: '' },
  src: { default: '' },
  title: { default: '未命名 HTML' },
  height: { default: 480 },
})

const MinimalHtmlBlock = TiptapNode.create({
  name: 'htmlBlock',
  group: 'block',
  atom: true,
  addAttributes() {
    return htmlBlockAttributes()
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-type="html-block"]',
        getAttrs(dom: HTMLElement) {
          const rawHeight = Number(dom.getAttribute('data-height'))
          return {
            fileId: dom.getAttribute('data-file-id') || '',
            src: dom.getAttribute('data-src') || '',
            title: dom.getAttribute('data-title') || '未命名 HTML',
            height: Number.isFinite(rawHeight) && rawHeight > 0 ? Math.floor(rawHeight) : 480,
          }
        },
      },
    ]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', {
      'data-type': 'html-block',
      'data-file-id': HTMLAttributes.fileId ?? '',
      'data-src': HTMLAttributes.src ?? '',
      'data-title': HTMLAttributes.title ?? '未命名 HTML',
      'data-height': String(HTMLAttributes.height ?? 480),
    }] as const
  },
})

/**
 * YouTube 嵌入节点。
 * pmJsonToHtml 已处理此节点（渲染为 iframe），
 * 需在 serverSchema 注册以避免 Y.js 转换时被 degradeUnknownNodes 不可逆降级。
 */
const MinimalYoutube = TiptapNode.create({
  name: 'youtube',
  group: 'block',
  atom: true,
  addAttributes() {
    return {
      src: { default: '' },
      width: { default: 640 },
      height: { default: 480 },
    }
  },
})

const MinimalHighlight = TiptapMark.create({
  name: 'highlight',
  addAttributes() {
    return {
      color: { default: 'yellow' },
    }
  },
})

const MinimalTextStyle = TiptapMark.create({
  name: 'textStyle',
  addAttributes() {
    return {
      color: { default: null },
    }
  },
})

const MinimalSuperscript = TiptapMark.create({
  name: 'superscript',
  excludes: 'subscript',
  parseHTML() {
    return [{ tag: 'sup' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['sup', HTMLAttributes, 0]
  },
})

const MinimalSubscript = TiptapMark.create({
  name: 'subscript',
  excludes: 'superscript',
  parseHTML() {
    return [{ tag: 'sub' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['sub', HTMLAttributes, 0]
  },
})

/** 与客户端 TextAlign 对齐：保留导入/协作里的 paragraph/heading textAlign */
const MinimalTextAlign = Extension.create({
  name: 'textAlign',
  addGlobalAttributes() {
    return [
      {
        types: ['heading', 'paragraph'],
        attributes: {
          textAlign: {
            default: null,
            parseHTML: (element) => {
              const align = (element as HTMLElement).style?.textAlign
              return align || null
            },
            renderHTML: (attributes) => {
              if (!attributes.textAlign) return {}
              return { style: `text-align: ${attributes.textAlign}` }
            },
          },
        },
      },
    ]
  },
})

/**
 * 为指定节点类型注入 blockId 属性（对齐客户端 UniqueID 扩展）。
 * 服务端不生成新 blockId，仅保证已有 blockId 在 Y.js ↔ ProseMirror 转换时不被丢弃。
 */
function injectBlockIdAttribute(ext: AnyExtension): AnyExtension {
  const nodeExt = ext as unknown as { name?: string; options?: Record<string, unknown> }
  if (nodeExt.name && COLLABORATIVE_BLOCK_TYPES.includes(nodeExt.name)) {
    return (ext as any).extend({
      addAttributes() {
        return {
          ...this.parent?.(),
          blockId: { default: null },
        }
      },
    })
  }
  return ext
}

let cached: Schema | null = null

/**
 * 获取服务端 ProseMirror Schema（单例缓存）。
 *
 * 包含 createDefaultDocExtensions 的全部节点/marks，
 * 以及 markdownToPmJson 可能额外产出的 image / mathematics / youtube /
 * tabdataBlock / tabwhiteboard / htmlBlock 节点，highlight / textStyle marks。
 *
 * 注意: 此 schema 仅供服务端使用，不得用于客户端编辑器初始化。
 */
export function getDocServerSchema(): Schema {
  if (cached) return cached

  const baseExtensions = createDefaultDocExtensions({
    disableMarkdown: true,
    disableHistory: true,
  })

  const withBlockId = baseExtensions.map(injectBlockIdAttribute)

  const allExtensions: AnyExtension[] = [
    ...withBlockId,
    MinimalImage,
    MinimalMathematics,
    MinimalMathBlock,
    MinimalTabDataBlock,
    MinimalTabWhiteboard,
    MinimalHtmlBlock,
    MinimalYoutube,
    MinimalHighlight,
    MinimalTextStyle,
    MinimalSuperscript,
    MinimalSubscript,
    MinimalTextAlign,
  ]

  cached = getSchema(allExtensions)
  return cached
}
