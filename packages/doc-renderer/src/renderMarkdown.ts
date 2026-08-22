import { getMarkdownRenderer } from './runtime/rendererRegistry'
import { basicMarkdownToHtml } from './basicMarkdownToHtml'
import { sanitizeHtml } from './sanitizeHtml'
import type { MarkdownRenderOptions, MarkdownRenderResult, MarkdownRendererAdapter } from './types'

const resolveRenderer = (adapter?: MarkdownRendererAdapter | null): MarkdownRendererAdapter | null => {
  if (adapter !== undefined) return adapter
  return getMarkdownRenderer()
}

export const renderMarkdown = async (
  markdown: string,
  options: MarkdownRenderOptions = {},
  adapter?: MarkdownRendererAdapter | null
): Promise<MarkdownRenderResult> => {
  const renderer = resolveRenderer(adapter)
  let rawHtml: string
  if (renderer) {
    rawHtml = await renderer.renderToHtml(markdown, options)
  } else {
    // PAR-032: 降级到基础渲染器时在非生产环境发出警告
    if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
      console.warn(
        '[doc-renderer] 完整 Markdown 渲染器不可用，降级为 basicMarkdownToHtml。' +
        '该降级渲染器不支持 H4-H6、有序列表、嵌套列表、引用块、表格、图片等语法。'
      )
    }
    rawHtml = basicMarkdownToHtml(markdown)
  }

  if (options.allowUnsafeHtml) {
    // PAR-033: 生产环境也需记录警告，而非静默跳过
    console.warn(
      '[doc-renderer] allowUnsafeHtml=true: HTML 消毒已被跳过。' +
      '如果内容来自用户输入或不可信来源，存在 XSS 风险。'
    )
    return { html: rawHtml }
  }

  const shouldSanitize = options.sanitize !== false
  // PAR-031: sanitize: false 时发出警告
  if (!shouldSanitize) {
    console.warn(
      '[doc-renderer] sanitize=false: HTML 消毒已被显式禁用。' +
      '如果内容来自用户输入或不可信来源，存在 XSS 风险。'
    )
  }
  return {
    html: shouldSanitize ? sanitizeHtml(rawHtml) : rawHtml,
  }
}

