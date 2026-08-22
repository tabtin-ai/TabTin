/**
 * TabData Block — TipTap Node Extension
 *
 * 在 TabDoc 文档中嵌入 TabData 多维表格。
 * 以 tableId 引用外部 TabData 资源，在编辑器中渲染为可交互的表格视图。
 *
 * ProseMirror schema:
 *   tabdataBlock: { attrs: { tableId: string, viewId: string | null, title: string, maxHeight: number } }
 *
 * 渲染方式:
 *   - packages/doc-editor 仅提供 Node 定义和 HTML fallback（服务端/非 React 环境）
 *   - Electron 侧通过 extend() + addNodeView() 注入 ReactNodeViewRenderer
 *   - 输出 `tabdata-block` HTML
 */

import { Node, mergeAttributes } from '@tiptap/core'

export interface TabDataBlockOptions {
  HTMLAttributes: Record<string, unknown>
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    tabDataBlock: {
      insertTabDataBlock: (options: {
        tableId: string
        viewId?: string | null
        title?: string
      }) => ReturnType
      updateTabDataBlock: (options: {
        tableId: string
        attrs: Partial<{ viewId: string | null; title: string; maxHeight: number }>
        pos?: number
      }) => ReturnType
    }
  }
}

export const TabDataBlock = Node.create<TabDataBlockOptions>({
  name: 'tabdataBlock',

  group: 'block',

  atom: true,

  draggable: true,

  addOptions() {
    return {
      HTMLAttributes: {},
    }
  },

  addAttributes() {
    return {
      tableId: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-table-id') || '',
        renderHTML: (attributes) => ({
          'data-table-id': attributes.tableId,
        }),
      },
      viewId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-view-id') || null,
        renderHTML: (attributes) => {
          if (!attributes.viewId) return {}
          return { 'data-view-id': attributes.viewId }
        },
      },
      title: {
        default: '未命名表格',
        parseHTML: (element) => element.getAttribute('data-table-title') || '未命名表格',
        renderHTML: (attributes) => ({
          'data-table-title': attributes.title,
        }),
      },
      maxHeight: {
        default: 400,
        parseHTML: (element) => {
          const val = element.getAttribute('data-max-height')
          if (!val) return 400
          const n = parseInt(val, 10)
          return Number.isFinite(n) ? n : 400
        },
        renderHTML: (attributes) => ({
          'data-max-height': String(attributes.maxHeight),
        }),
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="tabdata-block"]',
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-type': 'tabdata-block',
        class: 'tabdata-block',
      }),
      [
        'div',
        { class: 'tabdata-block-placeholder' },
        ['span', { class: 'tabdata-block-icon' }, '📊'],
        [
          'span',
          { class: 'tabdata-block-title' },
          HTMLAttributes['data-table-title'] || '未命名表格',
        ],
      ],
    ]
  },

  addStorage() {
    return {
      markdown: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serialize(state: any, node: any) {
          const tableId = node.attrs?.tableId || ''
          const title = node.attrs?.title || '未命名表格'
          state.write(`[📊 ${title}](tabdata://${tableId})`)
          state.closeBlock(node)
        },
        parse: {},
      },
    }
  },

  addCommands() {
    return {
      insertTabDataBlock:
        (options) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: {
              tableId: options.tableId,
              viewId: options.viewId ?? null,
              title: options.title || '未命名表格',
            },
          })
        },
      updateTabDataBlock:
        (options) =>
        ({ tr, state }) => {
          if (typeof options.pos === 'number') {
            const node = state.doc.nodeAt(options.pos)
            if (node?.type.name === this.name) {
              tr.setNodeMarkup(options.pos, undefined, {
                ...node.attrs,
                ...options.attrs,
              })
              return true
            }
            return false
          }
          // 无 pos 时只更新第一个匹配的块，避免批量修改同 tableId 的多个块
          let found = false
          state.doc.descendants((node, pos) => {
            if (found) return false
            if (
              node.type.name === this.name &&
              node.attrs.tableId === options.tableId
            ) {
              tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                ...options.attrs,
              })
              found = true
              return false
            }
          })
          return found
        },
    }
  },
})

export default TabDataBlock
