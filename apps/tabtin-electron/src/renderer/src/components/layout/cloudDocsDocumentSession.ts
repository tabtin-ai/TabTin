/**
 * 云文档内「当前文档会话」Browser scope 工具（历史兼容）。
 *
 * 3763 初版曾把 HTML 块 tabweb 写入 `:tabdoc-session:` 子 scope 并在编辑器右侧开面板；
 * 现改为与 tabdoc 相同写入 cloud-docs 全局 scope + 侧栏「当前打开」Dock（ 产品口径）。
 */
import { isCloudDocsScopeKey } from './cloudDocsDomain'

const SESSION_MARKER = ':tabdoc-session:'

export function buildCloudDocsDocumentSessionScopeKey(
  cloudDocsScopeKey: string,
  documentId: string,
): string {
  const docId = documentId.trim()
  if (!docId) return cloudDocsScopeKey
  return `${cloudDocsScopeKey}${SESSION_MARKER}${docId}`
}

export function isCloudDocsDocumentSessionScopeKey(scopeKey: string | null | undefined): boolean {
  return Boolean(scopeKey?.includes(SESSION_MARKER))
}

export function parseCloudDocsDocumentSessionScopeKey(
  scopeKey: string | null | undefined,
): { cloudDocsScopeKey: string; documentId: string } | null {
  if (!scopeKey || !scopeKey.includes(SESSION_MARKER)) return null
  const idx = scopeKey.lastIndexOf(SESSION_MARKER)
  const cloudDocsScopeKey = scopeKey.slice(0, idx)
  const documentId = scopeKey.slice(idx + SESSION_MARKER.length)
  if (!isCloudDocsScopeKey(cloudDocsScopeKey) || !documentId) return null
  return { cloudDocsScopeKey, documentId }
}
