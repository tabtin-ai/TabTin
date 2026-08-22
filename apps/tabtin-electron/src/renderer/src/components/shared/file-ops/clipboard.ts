/**
 * 复制文本到剪贴板。
 *
 * 优先 navigator.clipboard；失败时用 textarea + execCommand 兜底。
 * 调用方应在用户手势的同步栈里发起（可先同步拼好 text，再 void copyToClipboard(text)）。
 */
export const copyToClipboard = async (text: string): Promise<boolean> => {
  if (!text) return false

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}
