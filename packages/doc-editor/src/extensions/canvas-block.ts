/**
 * TabWhiteboard Block — TipTap Node Extension
 *
 * 在 TabDoc 文档中嵌入画布预览块。
 * 以 canvasId 引用外部 TabWhiteboard 资源，渲染为只读缩略图。
 *
 * ProseMirror schema:
 *   tabwhiteboard: { attrs: { canvasId: string, title: string } }
 */

import { Node, mergeAttributes } from '@tiptap/core'

export interface CanvasBlockOptions {
  HTMLAttributes: Record<string, unknown>
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    canvasBlock: {
      insertCanvasBlock: (options: { canvasId: string; title?: string }) => ReturnType
    }
  }
}

export const CanvasBlock = Node.create<CanvasBlockOptions>({
  name: 'tabwhiteboard',

  group: 'block',

  atom: true,

  addOptions() {
    return {
      HTMLAttributes: {},
    }
  },

  addAttributes() {
    return {
      canvasId: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-canvas-id') || '',
        renderHTML: (attributes) => ({
          'data-canvas-id': attributes.canvasId,
        }),
      },
      title: {
        default: '未命名白板',
        parseHTML: (element) => element.getAttribute('data-canvas-title') || '未命名白板',
        renderHTML: (attributes) => ({
          'data-canvas-title': attributes.title,
        }),
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="tabwhiteboard"]',
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-type': 'tabwhiteboard',
        class: 'tabwhiteboard-block',
      }),
      ['div', { class: 'tabwhiteboard-block-inner' },
        ['span', { class: 'tabwhiteboard-block-icon' }, '🔀'],
        ['span', { class: 'tabwhiteboard-block-title' }, HTMLAttributes['data-canvas-title'] || '白板'],
      ],
    ]
  },

  addStorage() {
    return {
      markdown: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serialize(state: any, node: any) {
          const canvasId = node.attrs?.canvasId || ''
          const title = node.attrs?.title || '未命名白板'
          state.write(`[🔀 ${title}](tabwhiteboard://${canvasId})`)
          state.closeBlock(node)
        },
        parse: {},
      },
    }
  },

  addCommands() {
    return {
      insertCanvasBlock:
        (options) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: {
              canvasId: options.canvasId,
              title: options.title || '未命名白板',
            },
          })
        },
    }
  },
})

export default CanvasBlock
