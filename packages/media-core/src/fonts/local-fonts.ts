/**
 * 本地系统字体检测
 *
 * 提供跨平台的系统字体枚举能力，供 TabSlide / TabVideo 复用。
 *
 * 策略：
 * 1. 优先使用 Local Font Access API（Chrome 103+，需用户授权）
 * 2. 降级为 canvas measureText 检测（对比候选字体列表）
 * 3. Node.js 环境返回空数组（本地字体是浏览器概念）
 */

// ---------------------------------------------------------------------------
// TypeScript 补充声明 — window.queryLocalFonts 不在标准 lib 中
// ---------------------------------------------------------------------------

interface FontData {
  family: string
  fullName: string
  postscriptName: string
  style: string
}

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<FontData[]>
  }
}

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/** 本地字体信息 */
export interface LocalFontInfo {
  /** 字体族名称 */
  family: string
  /** 完整字体名称（如 "Arial Bold"） */
  fullName?: string
  /** PostScript 名称 */
  postscriptName?: string
  /** 来源：local-font-access API 或 canvas 检测 */
  source: 'local-font-access' | 'canvas-detection'
}

// ---------------------------------------------------------------------------
// 候选字体列表 — canvas fallback 检测时使用
// ---------------------------------------------------------------------------

/**
 * 候选系统字体列表（用于 canvas fallback 检测）。
 * 覆盖 macOS / Windows / Linux 常见预装字体。
 */
export const SYSTEM_FONT_CANDIDATES: string[] = [
  // CJK
  'PingFang SC', 'PingFang TC', 'PingFang HK',
  'Hiragino Sans', 'Hiragino Kaku Gothic Pro',
  'Microsoft YaHei', 'SimSun', 'SimHei', 'KaiTi', 'FangSong',
  'Yu Gothic', 'Meiryo', 'MS Gothic',
  'Malgun Gothic', 'Gulim', 'Batang',
  'Noto Sans CJK SC', 'Noto Sans CJK TC', 'Noto Sans CJK JP', 'Noto Sans CJK KR',
  // Latin — Sans-serif
  'Arial', 'Helvetica', 'Helvetica Neue',
  'Verdana', 'Tahoma', 'Trebuchet MS',
  'Segoe UI', 'Calibri',
  'San Francisco', 'SF Pro', '.AppleSystemUIFont',
  'Ubuntu', 'DejaVu Sans', 'Liberation Sans', 'Cantarell',
  'Fira Sans', 'Source Sans Pro', 'Noto Sans',
  // Latin — Serif
  'Times New Roman', 'Georgia', 'Garamond',
  'Cambria',
  // Latin — Monospace
  'Courier New', 'Lucida Console', 'Consolas',
  'Menlo', 'Monaco', 'Andale Mono',
  // Display / Handwriting
  'Impact', 'Comic Sans MS', 'Papyrus',
  'Brush Script MT', 'Lucida Handwriting',
]

// ---------------------------------------------------------------------------
// 内部缓存
// ---------------------------------------------------------------------------

let _cachedLocalFonts: LocalFontInfo[] | null = null
const _fontCheckCache = new Map<string, boolean>()

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 检测系统本地字体。
 *
 * 策略：
 * 1. 优先使用 Local Font Access API（Chrome 103+，需用户授权）
 * 2. 降级为 canvas measureText 检测（对比候选字体列表）
 * 3. Node.js 环境返回空数组（本地字体是浏览器概念）
 *
 * 结果会缓存，同一会话只检测一次。
 */
export async function queryLocalFonts(): Promise<LocalFontInfo[]> {
  // 返回缓存
  if (_cachedLocalFonts !== null) return _cachedLocalFonts

  // Node.js 环境直接返回空
  if (typeof window === 'undefined') {
    _cachedLocalFonts = []
    return _cachedLocalFonts
  }

  // 尝试 Local Font Access API
  if (typeof window.queryLocalFonts === 'function') {
    try {
      const fonts = await window.queryLocalFonts()
      const seen = new Set<string>()
      const result: LocalFontInfo[] = []

      for (const f of fonts) {
        const family = typeof f.family === 'string' ? f.family.trim() : ''
        if (!family) continue
        const key = family.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        result.push({
          family,
          fullName: f.fullName || undefined,
          postscriptName: f.postscriptName || undefined,
          source: 'local-font-access' as const,
        })
      }

      _cachedLocalFonts = result
      return _cachedLocalFonts
    } catch {
      // 用户拒绝授权或 API 不可用，降级到 canvas 检测
    }
  }

  // Canvas fallback — 遍历候选列表检测
  _cachedLocalFonts = SYSTEM_FONT_CANDIDATES
    .filter((f) => isFontAvailable(f))
    .map((f) => ({
      family: f,
      source: 'canvas-detection' as const,
    }))

  return _cachedLocalFonts
}

/**
 * 检测指定字体是否在系统中可用。
 * 使用 canvas measureText 比较目标字体和基线字体的宽度差异。
 *
 * 原理：如果 `"text in targetFont, monospace"` 的测量宽度与
 * `"text in monospace"` 不同，说明 targetFont 被成功加载。
 */
export function isFontAvailable(family: string): boolean {
  if (_fontCheckCache.has(family)) return _fontCheckCache.get(family)!

  // 非浏览器环境无法检测
  if (typeof document === 'undefined') return false

  try {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return false

    const testStr = 'abcdefghijklmnopqrstuvwxyz0123456789\u4e2d\u6587\u6d4b\u8bd5'
    const baselines = ['monospace', 'sans-serif'] as const
    let match = false

    for (const baseline of baselines) {
      ctx.font = `72px ${baseline}`
      const baseW = ctx.measureText(testStr).width
      ctx.font = `72px "${family}", ${baseline}`
      if (Math.abs(baseW - ctx.measureText(testStr).width) > 0.5) {
        match = true
        break
      }
    }

    _fontCheckCache.set(family, match)
    return match
  } catch {
    return false
  }
}

/**
 * 清除本地字体缓存。下次调用 queryLocalFonts() 将重新检测。
 */
export function clearLocalFontCache(): void {
  _cachedLocalFonts = null
  _fontCheckCache.clear()
}
