/**
 * 运行时字体注册表
 *
 * 供宿主在运行时注入「系统未安装但可通过 @font-face 使用」的字体族，
 * 例如：从 PPTX 提取的嵌入字体。
 */

let runtimeFontFamilies: string[] = []
const listeners = new Set<(families: string[]) => void>()

const GENERIC_FONT_FAMILY_KEYWORDS = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
])

function splitFirstFontFamilyToken(input: string): string {
  let quote: '"' | '\'' | null = null
  let depth = 0
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === '\'') {
      const prev = i > 0 ? input[i - 1] : ''
      if (!prev || /\s|,|\(/.test(prev)) {
        quote = ch
        continue
      }
    }
    if (ch === '(') {
      depth += 1
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (ch === ',' && depth === 0) {
      return input.slice(0, i)
    }
  }
  return input
}

function normalizeFontFamily(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const first = splitFirstFontFamilyToken(trimmed).trim().replace(/^['"]|['"]$/g, '')
  if (!first) return null
  const lower = first.toLowerCase()
  if (lower.startsWith('var(')) return null
  if (GENERIC_FONT_FAMILY_KEYWORDS.has(lower)) return null
  return first
}

function normalizeList(families: unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of families) {
    const name = normalizeFontFamily(item)
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  out.sort((a, b) => a.localeCompare(b, 'zh-Hans'))
  return out
}

function emit(): void {
  const snapshot = [...runtimeFontFamilies]
  for (const listener of listeners) {
    try {
      listener(snapshot)
    } catch (err) {
      console.warn('[tabslide] runtime font listener error:', err)
    }
  }
}

export function setRuntimeFontFamilies(families: unknown[]): void {
  const next = normalizeList(Array.isArray(families) ? families : [])
  if (
    next.length === runtimeFontFamilies.length
    && next.every((name, idx) => name === runtimeFontFamilies[idx])
  ) {
    return
  }
  runtimeFontFamilies = next
  emit()
}

export function getRuntimeFontFamilies(): string[] {
  return [...runtimeFontFamilies]
}

export function subscribeRuntimeFontFamilies(
  listener: (families: string[]) => void,
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
