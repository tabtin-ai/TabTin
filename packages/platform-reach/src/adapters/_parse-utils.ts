/**
 * 跨平台防御式解析小工具（无浏览器依赖，可单测）。
 * 平台 JSON 字段漂移频繁——多路径兜底，接线 live 后再收紧。
 */

export function parseCount(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (!s) return undefined
  const m = s.match(/^([\d.]+)\s*(万|亿|w|k)?$/i)
  if (!m) {
    const n = Number(s.replace(/,/g, ''))
    return Number.isFinite(n) ? n : undefined
  }
  const base = Number(m[1])
  if (!Number.isFinite(base)) return undefined
  const unit = (m[2] ?? '').toLowerCase()
  if (unit === '亿') return Math.round(base * 1e8)
  if (unit === '万' || unit === 'w') return Math.round(base * 10000)
  if (unit === 'k') return Math.round(base * 1000)
  return Math.round(base)
}

/**
 * 剥掉 JSONP 回调外壳：`jQuery351_xxx({...})` / `callback({...});` → `{...}`。
 * 纯 JSON 字符串原样返回。东方财富 search 等站常用 JSONP。
 */
export function stripJsonp(raw: string): string {
  const trimmed = raw.trim()
  const m = trimmed.match(/^[a-zA-Z_$][\w$]*\s*\(([\s\S]*)\)\s*;?\s*$/)
  return m ? m[1] : trimmed
}

export function coerceJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(stripJsonp(raw))
  } catch {
    return undefined
  }
}

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/** 在若干路径里找第一个数组（点号路径，如 `data.items` / `data.result`）。 */
export function pickItemsArray(root: unknown, paths: string[]): unknown[] {
  const r = asRecord(root)
  if (!r) return []
  for (const path of paths) {
    let cur: unknown = r
    for (const seg of path.split('.')) {
      const obj = asRecord(cur)
      if (!obj) {
        cur = undefined
        break
      }
      cur = obj[seg]
    }
    if (Array.isArray(cur)) return cur
  }
  return []
}

export function strField(
  obj: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!obj) return undefined
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return undefined
}

/**
 * 抽取原始指标标量，供 `NormalizedItem.platformMetrics` 透传。
 *
 * 原样保留平台字段名，只收数值型（含可数值化字符串如 `"1.2万"`），
 * 丢弃 id / url / 文本 / 嵌套对象——避免把非指标字段塞进指标袋。
 *
 * @param obj 平台原始指标容器（如 bilibili `stat`、小红书 `interact_info`）
 * @param allowKeys 可选白名单；不传则收全部数值字段（适合干净的 stat 对象）
 */
export function numericBag(
  obj: Record<string, unknown> | undefined,
  allowKeys?: string[],
): Record<string, number> | undefined {
  if (!obj) return undefined
  const out: Record<string, number> = {}
  const keys = allowKeys ?? Object.keys(obj)
  for (const k of keys) {
    if (!(k in obj)) continue
    const n = parseCount(obj[k])
    if (n !== undefined) out[k] = n
  }
  return Object.keys(out).length ? out : undefined
}
