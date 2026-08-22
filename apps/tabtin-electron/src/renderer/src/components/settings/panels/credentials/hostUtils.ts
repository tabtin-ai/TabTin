/**
 * 域名规范化与显示工具。
 *
 * 用于把 cookie 的 `.baidu.com` / `.passport.baidu.com` 和密码的
 * `https://passport.baidu.com/login` 这种不同形态的 host 合并展示。
 *
 * 不做"主域聚合"（避免引入 PSL 依赖）；每个具体 host 各占一行，按字母排序。
 */

/**
 * 把任意输入（cookie domain 或 url）规范成 host：
 *  ".baidu.com"                → "baidu.com"
 *  "www.baidu.com"             → "baidu.com"
 *  "https://passport.baidu.com/login" → "passport.baidu.com"
 *  "passport.baidu.com"        → "passport.baidu.com"
 */
export function normalizeHost(input: string): string {
  if (!input) return ''
  let s = input.trim().toLowerCase()
  if (s.startsWith('.')) s = s.slice(1)
  try {
    const withScheme = s.startsWith('http') ? s : `https://${s}`
    const url = new URL(withScheme)
    let host = url.hostname
    if (host.startsWith('www.')) host = host.slice(4)
    return host
  } catch {
    return s
  }
}

/** 用于排序：把主域分组靠近（baidu.com、www.baidu.com、passport.baidu.com 排一起） */
export function sortKey(host: string): string {
  const parts = host.split('.')
  if (parts.length <= 2) return host
  // 把最后两段（主域）前置，再追加子域，保证 baidu.com / *.baidu.com 邻近
  const main = parts.slice(-2).join('.')
  const sub = parts.slice(0, -2).join('.')
  return `${main}\x00${sub}`
}
