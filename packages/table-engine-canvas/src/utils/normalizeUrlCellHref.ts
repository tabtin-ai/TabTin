/**
 * 把 URL 单元格里的原始文本收成可打开的 http(s) href。
 *
 * 手动粘贴常带前后空白（浏览器地址栏 / 富文本剪贴板），若不 trim：
 * - `" https://a.com".startsWith('http')` 为 false → 拼成 `https:// https://a.com`
 * - `new URL(...)` 抛错后被静默吞掉，表现为「点了没跳转」。
 *
 * 口径：trim + 拒非 http(s) scheme + 无协议补 https。
 * 合法/非法主机都可以开浏览器；「回表被网页 tab 抢走」由 Space tab 焦点同步修，
 * 不在这里用域名正则猜测能否跳转。
 */
export function normalizeUrlCellHref(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // 已有非 http(s) scheme（如 javascript:）直接拒绝，避免再拼 https:// 绕过。
  // 注意 host:port（localhost:3000）也会匹配 scheme 形态，需放行。
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed) &&
    !/^https?:\/\//i.test(trimmed) &&
    !/^[^\s/:]+:\d+(?:[/?#].*)?$/i.test(trimmed)
  ) {
    return null
  }

  // 相对路径没有打开基址；补 https:// 会变成 https:///path
  if (trimmed.startsWith('/')) return null

  let href: string
  if (/^https?:\/\//i.test(trimmed)) {
    href = trimmed
  } else if (trimmed.startsWith('//')) {
    href = `https:${trimmed}`
  } else {
    href = `https://${trimmed}`
  }

  try {
    const parsed = new URL(href)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return href
  } catch {
    return null
  }
}
