/**
 * 诊断包文件名安全校验。
 *
 * 独立成模块（不 import electron），既便于单测这条路径安全底线，也让
 * diagnostics-ipc 的落盘 handler 复用同一份规则。
 */

/** 纯 .zip 文件名校验：拒绝路径分隔符 / `..` / 非法字符 / 非 .zip。合法则返回规整后的名字。 */
export function sanitizeBundleFilename(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (!t) return null
  if (t.includes('/') || t.includes('\\') || t.includes('..')) return null
  if (/[<>:"|?*\u0000]/.test(t)) return null
  if (!t.toLowerCase().endsWith('.zip')) return null
  return t.length > 200 ? t.slice(0, 200) : t
}
