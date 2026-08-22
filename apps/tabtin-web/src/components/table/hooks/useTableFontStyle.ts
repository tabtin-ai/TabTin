import { useCallback, useEffect, useState } from 'react'

export type TableFontStyle = 'system' | 'serif' | 'mono' | 'rounded'
export type TableFontWeight = 'thin' | 'regular' | 'medium' | 'semibold'

const FONT_MAP: Record<string, string> = {
  system: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: '"Songti SC", "STSong", Georgia, "Times New Roman", serif',
  mono: '"JetBrains Mono", "SFMono-Regular", Menlo, Monaco, Consolas, monospace',
  rounded: '"SF Pro Rounded", "Nunito", "Helvetica Neue", Arial, "PingFang SC", sans-serif',
}
const WEIGHT_MAP: Record<string, number> = { thin: 300, regular: 400, medium: 500, semibold: 600 }

const DEFAULT_FONT_STYLE = 'system'
const DEFAULT_FONT_WEIGHT = 'regular'
const DEFAULT_FONT_SIZE = 13

// per-table localStorage key 前缀：旧版无 tableId 后缀的全局 key
// 仍作为升级 fallback——表没设过时回落到旧全局值，不丢风格。
const STYLE_KEY = 'tabtin:table:fontStyle'
const WEIGHT_KEY = 'tabtin:table:fontWeight'
const SIZE_KEY = 'tabtin:table:fontSize'

const scopedKey = (base: string, tableId?: string | null) =>
  tableId ? `${base}:${tableId}` : base

// 读优先级：本表 key → 旧全局 key（升级种子）→ 默认。
const readPref = (base: string, tableId?: string | null): string | null => {
  if (typeof localStorage === 'undefined') return null
  if (tableId) {
    const scoped = localStorage.getItem(scopedKey(base, tableId))
    if (scoped != null) return scoped
  }
  return localStorage.getItem(base)
}

const writePref = (base: string, tableId: string | null | undefined, value: string) => {
  if (typeof localStorage === 'undefined') return
  // 有 tableId 写本表 key；无 tableId（理论上不该发生）退回旧全局 key。
  localStorage.setItem(scopedKey(base, tableId), value)
}

export function useTableFontStyle(tableId?: string | null) {
  const [tableFontStyle, setTableFontStyleRaw] = useState(
    () => readPref(STYLE_KEY, tableId) ?? DEFAULT_FONT_STYLE,
  )
  const [tableFontWeight, setTableFontWeightRaw] = useState(
    () => readPref(WEIGHT_KEY, tableId) ?? DEFAULT_FONT_WEIGHT,
  )
  const [tableFontSize, setTableFontSizeRaw] = useState(() => {
    const stored = readPref(SIZE_KEY, tableId)
    return stored ? Number(stored) : DEFAULT_FONT_SIZE
  })

  // 切表时（tableId 变化但组件未卸载）重新载入该表的偏好。
  useEffect(() => {
    setTableFontStyleRaw(readPref(STYLE_KEY, tableId) ?? DEFAULT_FONT_STYLE)
    setTableFontWeightRaw(readPref(WEIGHT_KEY, tableId) ?? DEFAULT_FONT_WEIGHT)
    const storedSize = readPref(SIZE_KEY, tableId)
    setTableFontSizeRaw(storedSize ? Number(storedSize) : DEFAULT_FONT_SIZE)
  }, [tableId])

  const setTableFontStyle = useCallback((v: string) => {
    setTableFontStyleRaw(v)
    writePref(STYLE_KEY, tableId, v)
  }, [tableId])

  const setTableFontWeight = useCallback((v: string) => {
    setTableFontWeightRaw(v)
    writePref(WEIGHT_KEY, tableId, v)
  }, [tableId])

  const setTableFontSize = useCallback((v: number) => {
    const clamped = Math.max(10, Math.min(24, Math.round(v)))
    setTableFontSizeRaw(clamped)
    writePref(SIZE_KEY, tableId, String(clamped))
  }, [tableId])

  useEffect(() => {
    const root = document.documentElement
    const family = FONT_MAP[tableFontStyle] ?? FONT_MAP.system
    const numericWeight = WEIGHT_MAP[tableFontWeight] ?? 400
    root.style.setProperty('--table-font-family', family)
    root.style.setProperty('--table-font-weight', String(numericWeight))
    root.style.setProperty('--table-header-font-weight', String(Math.min(numericWeight + 200, 700)))
    root.style.setProperty('--table-font-size', `${tableFontSize}px`)
    return () => {
      root.style.removeProperty('--table-font-family')
      root.style.removeProperty('--table-font-weight')
      root.style.removeProperty('--table-header-font-weight')
      root.style.removeProperty('--table-font-size')
    }
  }, [tableFontStyle, tableFontWeight, tableFontSize])

  return {
    tableFontStyle, setTableFontStyle,
    tableFontWeight, setTableFontWeight,
    tableFontSize, setTableFontSize,
  }
}
