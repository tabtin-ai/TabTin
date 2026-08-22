/**
 * TabDoc 平台公式节点
 *
 * Canonical 与 Django / @tabtin/doc-editor / serverSchema 对齐：
 * - `mathematics`：行内
 * - `mathematicsBlock`：块级
 *
 * 不再继承 Novel `Mathematics`（硬编码节点名 `math`）。
 * 仍提供 `setLatex` / `unsetLatex`，并兼容历史 `span[data-type="math"]`。
 */
import { Extension, Node, mergeAttributes } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'
import katex from 'katex'

interface SerializerState {
  write(content: string): void
  closeBlock(node: unknown): void
}

interface SerializerNode {
  attrs: Record<string, unknown>
}

type KatexOptions = Record<string, unknown>

export interface TabDocMathematicsOptions {
  shouldRender: (state: EditorState, pos: number) => boolean
  katexOptions?: KatexOptions
  HTMLAttributes: Record<string, unknown>
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    LatexCommand: {
      setLatex: (input: { latex: string }) => ReturnType
      unsetLatex: () => ReturnType
    }
  }
}

const defaultShouldRender = (state: EditorState, pos: number): boolean => {
  const $pos = state.doc.resolve(pos)
  return $pos.parent.isTextblock ? $pos.parent.type.name !== 'codeBlock' : false
}

function createKatexNodeView(options: {
  HTMLAttributes: Record<string, unknown>
  katexOptions?: KatexOptions
  displayMode: boolean
  dataType: string
}) {
  return ({
    node,
    HTMLAttributes,
    getPos,
    editor,
  }: {
    node: { attrs: Record<string, unknown>; nodeSize: number }
    HTMLAttributes: Record<string, unknown>
    getPos: (() => number) | boolean
    editor: { isEditable: boolean; commands: { setTextSelection: (range: { from: number; to: number }) => void } }
  }) => {
    const dom = document.createElement(options.displayMode ? 'div' : 'span')
    const latex = String(node.attrs.latex ?? '')

    Object.entries(options.HTMLAttributes).forEach(([key, value]) => {
      if (value != null) dom.setAttribute(key, String(value))
    })
    Object.entries(HTMLAttributes).forEach(([key, value]) => {
      if (value != null) dom.setAttribute(key, String(value))
    })
    dom.setAttribute('data-type', options.dataType)
    dom.contentEditable = 'false'
    dom.addEventListener('click', () => {
      if (editor.isEditable && typeof getPos === 'function') {
        const pos = getPos()
        editor.commands.setTextSelection({ from: pos, to: pos + node.nodeSize })
      }
    })
    dom.innerHTML = katex.renderToString(latex, {
      throwOnError: false,
      displayMode: options.displayMode,
      ...(options.katexOptions ?? {}),
    })

    return { dom }
  }
}

const markdownSerializeInline = {
  serialize(state: SerializerState, node: SerializerNode) {
    const latex = node.attrs?.latex != null ? String(node.attrs.latex) : ''
    state.write('$')
    state.write(latex)
    state.write('$')
  },
}

const markdownSerializeBlock = {
  serialize(state: SerializerState, node: SerializerNode) {
    const latex = node.attrs?.latex != null ? String(node.attrs.latex) : ''
    // 与前后端围栏解析一致：独立行 $$ ... $$
    state.write('$$\n')
    state.write(latex)
    state.write('\n$$')
    state.closeBlock(node)
  },
}

/** 行内公式（canonical） */
export const MathematicsInline = Node.create<TabDocMathematicsOptions>({
  name: 'mathematics',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  marks: '',

  addOptions() {
    return {
      shouldRender: defaultShouldRender,
      katexOptions: { throwOnError: false },
      HTMLAttributes: {},
    }
  },

  addAttributes() {
    return {
      latex: { default: '' },
      display: { default: false },
    }
  },

  parseHTML() {
    return [
      { tag: 'span[data-type="mathematics"]' },
      // 历史 Novel Slash 节点
      { tag: 'span[data-type="math"]' },
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    const latex = String(node.attrs.latex ?? '')
    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-type': 'mathematics',
      }),
      latex,
    ]
  },

  renderText({ node }) {
    return String(node.attrs.latex ?? '')
  },

  addStorage() {
    return {
      markdown: markdownSerializeInline,
    }
  },

  addCommands() {
    return {
      setLatex:
        ({ latex }) =>
        ({ chain, state }) => {
          if (!latex) return false
          const { from, to, $anchor } = state.selection
          if (!this.options.shouldRender(state, $anchor.pos)) return false
          return chain()
            .insertContentAt(
              { from, to },
              {
                type: 'mathematics',
                attrs: { latex, display: false },
              },
            )
            .setTextSelection({ from, to: from + 1 })
            .run()
        },
      unsetLatex:
        () =>
        ({ state, dispatch }) => {
          const mathNames = new Set(['mathematics', 'mathematicsBlock', 'math'])
          const { from, $from } = state.selection
          let pos = from
          let node = state.doc.nodeAt(from)
          if (!node || !mathNames.has(node.type.name)) {
            if ($from.nodeAfter && mathNames.has($from.nodeAfter.type.name)) {
              node = $from.nodeAfter
            } else if ($from.nodeBefore && mathNames.has($from.nodeBefore.type.name)) {
              node = $from.nodeBefore
              pos = from - node.nodeSize
            } else {
              return false
            }
          }
          const latex = String(node.attrs.latex ?? '')
          if (!dispatch) return true
          const tr = state.tr
          if (node.type.name === 'mathematicsBlock') {
            const paragraph = state.schema.nodes.paragraph.create(
              null,
              latex ? state.schema.text(latex) : undefined,
            )
            tr.replaceWith(pos, pos + node.nodeSize, paragraph)
          } else if (latex) {
            tr.replaceWith(pos, pos + node.nodeSize, state.schema.text(latex))
          } else {
            tr.delete(pos, pos + node.nodeSize)
          }
          dispatch(tr)
          return true
        },
    }
  },

  addNodeView() {
    return createKatexNodeView({
      HTMLAttributes: this.options.HTMLAttributes,
      katexOptions: this.options.katexOptions,
      displayMode: false,
      dataType: 'mathematics',
    })
  },
})

/** 块级公式（canonical） */
export const MathematicsBlock = Node.create<Pick<TabDocMathematicsOptions, 'katexOptions' | 'HTMLAttributes'>>({
  name: 'mathematicsBlock',
  group: 'block',
  atom: true,
  selectable: true,
  marks: '',

  addOptions() {
    return {
      katexOptions: { throwOnError: false },
      HTMLAttributes: {},
    }
  },

  addAttributes() {
    return {
      latex: { default: '' },
    }
  },

  parseHTML() {
    return [
      { tag: 'div[data-type="mathematicsBlock"]' },
      { tag: 'div[data-type="mathematics"][data-display="true"]' },
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    const latex = String(node.attrs.latex ?? '')
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-type': 'mathematicsBlock',
      }),
      latex,
    ]
  },

  renderText({ node }) {
    return String(node.attrs.latex ?? '')
  },

  addStorage() {
    return {
      markdown: markdownSerializeBlock,
    }
  },

  addNodeView() {
    return createKatexNodeView({
      HTMLAttributes: this.options.HTMLAttributes,
      katexOptions: this.options.katexOptions,
      displayMode: true,
      dataType: 'mathematicsBlock',
    })
  },
})

/**
 * 历史兼容：保留 `math` 节点名以便加载旧 Yjs / PM JSON，
 * 渲染与命令行为对齐行内 mathematics；编辑路径会把它当成可点选公式。
 */
export const LegacyMathNode = Node.create<TabDocMathematicsOptions>({
  name: 'math',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  marks: '',

  addOptions() {
    return {
      shouldRender: defaultShouldRender,
      katexOptions: { throwOnError: false },
      HTMLAttributes: {},
    }
  },

  addAttributes() {
    return {
      latex: { default: '' },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="math"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const latex = String(node.attrs.latex ?? '')
    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-type': 'math',
      }),
      latex,
    ]
  },

  renderText({ node }) {
    return String(node.attrs.latex ?? '')
  },

  addStorage() {
    return {
      markdown: markdownSerializeInline,
    }
  },

  addNodeView() {
    return createKatexNodeView({
      HTMLAttributes: this.options.HTMLAttributes,
      katexOptions: this.options.katexOptions,
      displayMode: false,
      dataType: 'math',
    })
  },
})

/**
 * 组合扩展：行内 + 块级 + 历史 `math`。
 * 保持原 `MathematicsWithMarkdown` 导出名，供 extensions.ts configure。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const MathematicsWithMarkdown: any = Extension.create<TabDocMathematicsOptions>({
  name: 'tabdocMathematics',

  addOptions() {
    return {
      shouldRender: defaultShouldRender,
      katexOptions: { throwOnError: false },
      HTMLAttributes: {},
    }
  },

  addExtensions() {
    return [
      MathematicsInline.configure({
        shouldRender: this.options.shouldRender,
        katexOptions: this.options.katexOptions,
        HTMLAttributes: this.options.HTMLAttributes,
      }),
      MathematicsBlock.configure({
        katexOptions: this.options.katexOptions,
        HTMLAttributes: this.options.HTMLAttributes,
      }),
      LegacyMathNode.configure({
        shouldRender: this.options.shouldRender,
        katexOptions: this.options.katexOptions,
        HTMLAttributes: this.options.HTMLAttributes,
      }),
    ]
  },
})
