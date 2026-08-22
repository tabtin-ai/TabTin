/**
 * 重构来源：apps/tabtin-electron/src/renderer/src/components/chat/RichContentRenderer.tsx（行 457-477）
 * 拆分时间：2026-04-30
 * 重构原因：RichContentRenderer.tsx 1352 行单文件过大，按职责拆分
 * 职责：流式期 HTML widget preview 安全检查 —— 在 final code 尚未 ready 时拒绝渲染
 *       看起来不安全的 partial HTML（含 script / iframe / form / 非 sendPrompt onclick）。
 *       与 packages/agent-runtime/src/tools/show-widget/sanitizer.ts 的 hasDangerousHtml
 *       语义近似，但前端侧版本**接受受限的 sendPrompt onclick**并返回 boolean。
 * 业务逻辑版本：与拆分前完全相同，只是 module 边界调整
 */

export function htmlPreviewLooksUnsafe(code: string): boolean {
  if (/<\s*script\b|\bjavascript\s*:|<\s*(iframe|object|embed|form)\b/i.test(code)) return true
  const eventAttr = /\s(on[a-z]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi
  let match: RegExpExecArray | null
  while ((match = eventAttr.exec(code)) != null) {
    const attrName = match[1].toLowerCase()
    const rawValue = match[2].trim()
    const value =
      (rawValue.startsWith('"') && rawValue.endsWith('"'))
        || (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ? rawValue.slice(1, -1)
        : rawValue
    const isSendPromptClick =
      attrName === 'onclick'
      && /^sendPrompt\s*\(/.test(value)
      && !/[;\n\r]/.test(value.replace(/;\s*$/, ''))
      && /^sendPrompt\s*\(\s*(?:"[^"]{1,1000}"|'[^']{1,1000}')(?:\s*,[\s\S]{1,4096})?\)\s*;?\s*$/.test(value)
    if (!isSendPromptClick) return true
  }
  return false
}
