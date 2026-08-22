/**
 * HTML Block — TipTap Node Extension
 *
 * 在 TabDoc 文档中嵌入一段外部 HTML（对标飞书文档「插入 HTML」）。
 * HTML 本体以文件形式上传到 OSS，文档块只存**引用**（fileId + access_url），
 * 阅读视图放进受控 sandbox iframe 在线渲染，脚本可交互。
 *
 * 模块职责（本文件 = @tabtin/doc-editor 的 Node 定义层）：
 *   - 定义 ProseMirror schema：attrs / parseHTML / renderHTML / markdown 序列化
 *   - 提供 insertHtmlBlock / updateHtmlBlock 命令
 *   - renderHTML 产出**降级/公开分享**用的 sandbox iframe（无 React runtime 依赖）
 *
 * 渲染分层：
 *   - packages/doc-editor（本文件）：Node 定义 + HTML fallback（服务端 / standalone 公开分享页）
 *   - packages/tabdoc-ui：Electron/Web 侧通过 .extend({ addNodeView }) 挂 React 视图（HtmlBlockView）
 *
 * ProseMirror schema:
 *   htmlBlock: { attrs: { fileId: string, src: string, title: string, height: number } }
 *   - fileId：OSS FileRecord id，**编辑回路的 source of truth**（AI 改 = 下载→改→重传→换 fileId/src）
 *   - src：OSS access_url，仅用于渲染
 *   - title：块标题
 *   - height：渲染高度（px）
 *
 * 安全边界（红线，改动务必守住）：
 *   - iframe sandbox 固定为 `allow-scripts allow-popups`，**绝不含 `allow-same-origin`**
 *     （同源 + 脚本 = 沙箱逃逸，可读写宿主 cookie / DOM）。
 *   - iframe src 仅允许 `http:` / `https:` 协议；相对路径 / `javascript:` / `data:` 一律不输出 src。
 *   - 属性值经 renderHTML 数组式 spec 由 Tiptap 自动转义；markdown 序列化里手动转义引号/反斜杠。
 */

import { Node, mergeAttributes } from '@tiptap/core'

export interface HtmlBlockOptions {
  HTMLAttributes: Record<string, unknown>
}

export const HTML_BLOCK_DEFAULT_TITLE = '未命名 HTML'
export const HTML_BLOCK_DEFAULT_HEIGHT = 480

/** 仅允许 http/https 协议的 iframe src；其余（相对路径 / javascript: / data: / 协议相对）一律拒绝。 */
const HTTP_URL_RE = /^https?:\/\//i

/** 校验 iframe src，安全时原样返回，否则返回空串（不输出 src）。 */
export function sanitizeHtmlBlockSrc(url: unknown): string {
  if (typeof url !== 'string') return ''
  const trimmed = url.trim()
  return HTTP_URL_RE.test(trimmed) ? trimmed : ''
}

/** 归一化渲染高度：有限正数则取整，否则回落默认值。 */
export function normalizeHtmlBlockHeight(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : HTML_BLOCK_DEFAULT_HEIGHT
}

const escapeQuotedAttr = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    htmlBlock: {
      insertHtmlBlock: (options: {
        fileId: string
        src?: string
        title?: string
        height?: number
      }) => ReturnType
      updateHtmlBlock: (options: {
        fileId: string
        attrs: Partial<{ src: string; title: string; height: number }>
        pos?: number
      }) => ReturnType
    }
  }
}

export const HtmlBlock = Node.create<HtmlBlockOptions>({
  name: 'htmlBlock',

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
      // 稳定块身份：块级分享 / Agent 定位依赖它；缺省由插入路径或 UniqueID 补齐。
      blockId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-block-id') || null,
        renderHTML: (attributes) =>
          attributes.blockId ? { 'data-block-id': attributes.blockId } : {},
      },
      fileId: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-file-id') || '',
        renderHTML: (attributes) => ({
          'data-file-id': attributes.fileId,
        }),
      },
      src: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-src') || '',
        // 仅当协议校验通过时才把 src 落到 data-src（wrapper 不携带不安全 URL）。
        renderHTML: (attributes) => {
          const safe = sanitizeHtmlBlockSrc(attributes.src)
          return safe ? { 'data-src': safe } : {}
        },
      },
      title: {
        default: HTML_BLOCK_DEFAULT_TITLE,
        parseHTML: (element) => element.getAttribute('data-title') || HTML_BLOCK_DEFAULT_TITLE,
        renderHTML: (attributes) => ({
          'data-title': attributes.title,
        }),
      },
      height: {
        default: HTML_BLOCK_DEFAULT_HEIGHT,
        parseHTML: (element) => normalizeHtmlBlockHeight(element.getAttribute('data-height')),
        renderHTML: (attributes) => ({
          'data-height': String(normalizeHtmlBlockHeight(attributes.height)),
        }),
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="html-block"]',
      },
    ]
  },

  /**
   * HTML fallback / standalone 公开分享渲染：wrapper div + 受控 sandbox iframe。
   * 数组式 spec 的属性值由 Tiptap 自动 HTML 转义。
   */
  renderHTML({ node, HTMLAttributes }) {
    const src = sanitizeHtmlBlockSrc(node.attrs.src)
    const height = normalizeHtmlBlockHeight(node.attrs.height)
    const title =
      typeof node.attrs.title === 'string' && node.attrs.title.trim()
        ? node.attrs.title
        : HTML_BLOCK_DEFAULT_TITLE

    const iframeAttrs: Record<string, string> = {
      // 安全红线：绝不加 allow-same-origin
      sandbox: 'allow-scripts allow-popups',
      loading: 'lazy',
      title,
      style: `width:100%;height:${height}px;border:0`,
    }
    if (src) iframeAttrs.src = src

    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-type': 'html-block',
        class: 'html-block',
      }),
      ['iframe', iframeAttrs],
    ]
  },

  addStorage() {
    return {
      markdown: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serialize(state: any, node: any) {
          const fileId = escapeQuotedAttr(String(node.attrs?.fileId || ''))
          const src = escapeQuotedAttr(String(node.attrs?.src || ''))
          const title = escapeQuotedAttr(
            String(node.attrs?.title || HTML_BLOCK_DEFAULT_TITLE),
          ).replace(/[\n\r]/g, ' ')
          const height = normalizeHtmlBlockHeight(node.attrs?.height)
          state.write(
            `:::htmlblock{fileId="${fileId}" src="${src}" title="${title}" height="${height}"}\n:::`,
          )
          state.closeBlock(node)
        },
        parse: {},
      },
    }
  },

  addCommands() {
    return {
      insertHtmlBlock:
        (options) =>
        ({ commands }) => {
          const blockId =
            typeof globalThis.crypto?.randomUUID === 'function'
              ? globalThis.crypto.randomUUID()
              : `htmlblk_${Date.now().toString(36)}`
          return commands.insertContent({
            type: this.name,
            attrs: {
              blockId,
              fileId: options.fileId,
              src: options.src ?? '',
              title: options.title || HTML_BLOCK_DEFAULT_TITLE,
              height: normalizeHtmlBlockHeight(options.height),
            },
          })
        },
      updateHtmlBlock:
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
          // 无 pos 时只更新第一个匹配 fileId 的块，避免批量误改同源多个块
          let found = false
          state.doc.descendants((node, pos) => {
            if (found) return false
            if (node.type.name === this.name && node.attrs.fileId === options.fileId) {
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

export default HtmlBlock
