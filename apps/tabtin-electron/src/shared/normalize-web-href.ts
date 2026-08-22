/**
 * 把聊天 / Markdown 里常见的「少写协议」网址补成可打开的绝对 URL。
 *
 * 纯文本自动识别已经会把 `www.baidu.com` 写成 `https://www.baidu.com`，
 * Markdown `[文字](www.baidu.com)` 却原样进 ResourceRouter / openExternal。
 * 主进程只放行 http(s)/mailto，无协议字符串会被静默拦掉。
 *
 * 只补最稳妥的两类，避免把 `readme.md` / 相对路径误加成外链：
 *   - `www.host...`
 *   - `//host...`（协议相对）
 * 已有 scheme（含 `tabtin://` / `mailto:` / `https:`）原样返回。
 */
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i
const WWW_HOST_RE = /^www\./i

export function normalizeSchemelessWebHref(href: string): string {
  const raw = href.trim()
  if (!raw) return href
  if (HAS_SCHEME_RE.test(raw)) return raw
  if (raw.startsWith('//')) return `https:${raw}`

  const authority = raw.match(/^[^/?#\s]*/)?.[0] ?? ''
  if (WWW_HOST_RE.test(authority)) return `https://${raw}`
  return raw
}
