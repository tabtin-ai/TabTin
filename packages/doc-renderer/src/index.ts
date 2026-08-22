export interface DocRendererModuleInfo {
  name: string
  version: string
}

export const DOC_RENDERER_MODULE_INFO: DocRendererModuleInfo = {
  name: '@tabtin/doc-renderer',
  version: '0.1.0',
}

export type {
  MarkdownRenderOptions,
  MarkdownRenderResult,
  MarkdownRendererAdapter,
} from './types'

export {
  configureMarkdownRenderer,
  getMarkdownRenderer,
  resetMarkdownRenderer,
} from './runtime/rendererRegistry'

export { sanitizeHtml } from './sanitizeHtml'
export { basicMarkdownToHtml } from './basicMarkdownToHtml'
export { renderMarkdown } from './renderMarkdown'

export {
  SANITIZE_ALLOWED_TAGS,
  SANITIZE_ALLOWED_ATTRS,
  SANITIZE_SAFE_URL_RE,
  SANITIZE_SAFE_HREF_PROTOCOLS,
  SANITIZE_SAFE_SRC_PROTOCOLS,
  SANITIZE_INPUT_ALLOWED_TYPES,
  SANITIZE_CSS_PROP_RE,
  SANITIZE_CSS_VALUE_RE,
  SANITIZE_DANGEROUS_CSS_FN_RE,
  SANITIZE_DANGEROUS_CSS_POSITION_RE,
} from './sanitize-config'

