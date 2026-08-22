/**
 * 表格主题样式计算 — 公共工具函数
 *
 * 供编辑器、放映、图片导出、PPTX 导出共享同一套 theme 逻辑，
 * 避免各环节实现不一致。
 */

import type {
  TableTheme,
  TableCell,
  TableCellStyle,
  TableBorders,
  TableBorderSide,
  TableBorderSpec,
  PPTElementOutline,
} from '../types/slides'

/** 将 #RRGGBB 转为 #RRGGBBAA 格式 */
function hexWithAlpha(color: string, alphaHex: string): string | null {
  return color.startsWith('#') && color.length >= 7 ? `${color.slice(0, 7)}${alphaHex}` : null
}

export interface TableThemeColors {
  /** 主题色 */
  themeColor: string
  /** 单元格分隔线颜色（主题色 + 20% 不透明度） */
  borderBottomColor: string
  /** 列分隔线颜色（主题色 + 13% 不透明度） */
  borderRightColor: string
  /** 条纹行/列背景色（主题色 + 5% 不透明度） */
  stripedColor: string
}

const DEFAULT_THEME_COLOR = '#4472C4'
const DEFAULT_TABLE_OUTLINE: PPTElementOutline = { style: 'solid', width: 1, color: '#d0d0d0' }
export const TABLE_BORDER_SIDES: TableBorderSide[] = ['top', 'right', 'bottom', 'left', 'insideH', 'insideV']

export function normalizeTableBorderSpec(
  raw: unknown,
  fallback?: TableBorderSpec,
): TableBorderSpec | undefined {
  if (!raw || typeof raw !== 'object') {
    return fallback ? { ...fallback } : undefined
  }
  const src = raw as Record<string, unknown>
  const styleRaw = typeof src.style === 'string' ? src.style.trim().toLowerCase() : ''
  const _validStyles: TableBorderSpec['style'][] = ['solid', 'dashed', 'dotted', 'dashDot', 'longDash', 'longDashDot']
  const style: TableBorderSpec['style'] = _validStyles.includes(styleRaw as TableBorderSpec['style'])
    ? (styleRaw as TableBorderSpec['style'])
    : (fallback?.style || 'solid')

  const widthRaw = typeof src.width === 'number' ? src.width : Number(src.width)
  const width = Number.isFinite(widthRaw) ? Math.max(0, Number(widthRaw)) : (fallback?.width ?? 1)

  const colorRaw = typeof src.color === 'string' ? src.color.trim() : ''
  const color = colorRaw || fallback?.color || '#d0d0d0'
  const themeKeyRaw = typeof src.themeKey === 'string' ? src.themeKey.trim() : ''
  const themeKey = themeKeyRaw || fallback?.themeKey

  return {
    style,
    width: Number(width.toFixed(3)),
    color,
    ...(themeKey ? { themeKey } : {}),
  }
}

export function normalizeTableBorders(
  raw: unknown,
  fallbackOutline?: PPTElementOutline,
): TableBorders | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const src = raw as Record<string, unknown>
  const fallback = fallbackOutline || DEFAULT_TABLE_OUTLINE
  const out: TableBorders = {}
  TABLE_BORDER_SIDES.forEach((side) => {
    if (!(side in src)) return
    const spec = normalizeTableBorderSpec(src[side], fallback)
    if (spec) out[side] = spec
  })
  return Object.keys(out).length > 0 ? out : undefined
}

export function tableBorderSpecToCss(spec: TableBorderSpec | undefined): string {
  if (!spec || spec.width <= 0) return 'none'
  return `${spec.width}px ${spec.style} ${spec.color}`
}

export function resolveTableOuterBorderSpecs(
  outline: PPTElementOutline | undefined,
  borders: TableBorders | undefined,
): { top: TableBorderSpec; right: TableBorderSpec; bottom: TableBorderSpec; left: TableBorderSpec } {
  const fallback = normalizeTableBorderSpec(outline, DEFAULT_TABLE_OUTLINE) || DEFAULT_TABLE_OUTLINE
  return {
    top: normalizeTableBorderSpec(borders?.top, fallback) || fallback,
    right: normalizeTableBorderSpec(borders?.right, fallback) || fallback,
    bottom: normalizeTableBorderSpec(borders?.bottom, fallback) || fallback,
    left: normalizeTableBorderSpec(borders?.left, fallback) || fallback,
  }
}

export function resolveTableCellBorderSpecs(
  args: {
    rowIdx: number
    colIdx: number
    totalRows: number
    totalCols: number
    cell: { colspan?: number; rowspan?: number }
    outline: PPTElementOutline | undefined
    borders?: TableBorders
    fallbackInsideHColor: string
    fallbackInsideVColor: string
  },
): { top?: TableBorderSpec; right: TableBorderSpec; bottom: TableBorderSpec; left?: TableBorderSpec } {
  const { rowIdx, colIdx, totalRows, totalCols, cell, outline, borders, fallbackInsideHColor, fallbackInsideVColor } = args
  const cs = cell.colspan ?? 1
  const rs = cell.rowspan ?? 1
  const isFirstRow = rowIdx === 0
  const isFirstCol = colIdx === 0
  const isLastRow = rowIdx + rs >= totalRows
  const isLastCol = colIdx + cs >= totalCols

  const outerFallback = normalizeTableBorderSpec(outline, DEFAULT_TABLE_OUTLINE) || DEFAULT_TABLE_OUTLINE
  const insideHFallback: TableBorderSpec = {
    style: outerFallback.style,
    width: outerFallback.width,
    color: fallbackInsideHColor,
  }
  const insideVFallback: TableBorderSpec = {
    style: outerFallback.style,
    width: outerFallback.width,
    color: fallbackInsideVColor,
  }

  return {
    top: isFirstRow ? (normalizeTableBorderSpec(borders?.top, outerFallback) || outerFallback) : undefined,
    left: isFirstCol ? (normalizeTableBorderSpec(borders?.left, outerFallback) || outerFallback) : undefined,
    bottom: isLastRow
      ? (normalizeTableBorderSpec(borders?.bottom, outerFallback) || outerFallback)
      : (normalizeTableBorderSpec(borders?.insideH, insideHFallback) || insideHFallback),
    right: isLastCol
      ? (normalizeTableBorderSpec(borders?.right, outerFallback) || outerFallback)
      : (normalizeTableBorderSpec(borders?.insideV, insideVFallback) || insideVFallback),
  }
}

/**
 * 将列宽数组归一化为 totalCols 长度，且总和为 1。
 * - 过长时截断
 * - 过短时补 0
 * - 全 0/非法时回退平均分配
 */
export function normalizeTableColWidths(
  colWidths: number[] | undefined,
  totalCols: number,
): number[] | undefined {
  if (!Number.isFinite(totalCols) || totalCols <= 0) return undefined
  if (!colWidths || colWidths.length === 0) {
    return Array.from({ length: totalCols }, () => 1 / totalCols)
  }

  const raw = Array.from({ length: totalCols }, (_, i) => {
    const v = i < colWidths.length ? colWidths[i] : 1
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
  })

  const sum = raw.reduce((acc, v) => acc + v, 0)
  if (sum <= 0) {
    return Array.from({ length: totalCols }, () => 1 / totalCols)
  }

  const normalized = raw.map((v) => Number((v / sum).toFixed(6)))
  const drift = Number((1 - normalized.reduce((acc, v) => acc + v, 0)).toFixed(6))
  normalized[normalized.length - 1] = Number((normalized[normalized.length - 1] + drift).toFixed(6))
  return normalized
}

/**
 * 规范化行高数组：
 * - 长度对齐 totalRows（缺失项用有效均值补齐）
 * - 非法值回退
 * - 可选按 totalHeight 缩放，保证总和等于目标高度
 */
export function normalizeTableRowHeights(
  rowHeights: number[] | undefined,
  totalRows: number,
  options?: { totalHeight?: number; minHeight?: number },
): number[] | undefined {
  if (!Number.isFinite(totalRows) || totalRows <= 0) return undefined

  const minHeight = Number.isFinite(options?.minHeight) && (options?.minHeight ?? 0) > 0
    ? (options?.minHeight as number)
    : 0
  const targetTotal = Number.isFinite(options?.totalHeight) && (options?.totalHeight ?? 0) > 0
    ? (options?.totalHeight as number)
    : undefined

  const safeInput = Array.isArray(rowHeights)
    ? rowHeights.map((v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0))
    : []

  const valid = safeInput.filter((v) => v > 0)
  const fallback = targetTotal
    ? targetTotal / totalRows
    : (minHeight > 0 ? minHeight : 36)
  const avgValid = valid.length ? (valid.reduce((acc, v) => acc + v, 0) / valid.length) : fallback

  let normalized = Array.from({ length: totalRows }, (_, i) => {
    const v = i < safeInput.length ? safeInput[i] : 0
    return v > 0 ? v : avgValid
  })

  if (targetTotal) {
    const sum = normalized.reduce((acc, v) => acc + v, 0)
    if (sum > 0) {
      normalized = normalized.map((v) => Number((v * targetTotal / sum).toFixed(3)))
      const drift = Number((targetTotal - normalized.reduce((acc, v) => acc + v, 0)).toFixed(3))
      normalized[normalized.length - 1] = Number((normalized[normalized.length - 1] + drift).toFixed(3))
    }
  }

  if (!targetTotal && minHeight > 0) {
    normalized = normalized.map((v) => (v > 0 ? Math.max(v, minHeight) : minHeight))
  }

  return normalized
}

/**
 * 兼容旧数据：历史表格单元格样式可能扁平在 cell 顶层（bold/color/...），
 * 新数据规范为 cell.style。这里统一读取口径，避免链路各环节表现不一致。
 */
export function resolveTableCellStyle(cell: TableCell): TableCellStyle {
  const legacy = cell as TableCell & Partial<TableCellStyle>
  return {
    bold: cell.style?.bold ?? legacy.bold,
    italic: cell.style?.italic ?? legacy.italic,
    underline: cell.style?.underline ?? legacy.underline,
    color: cell.style?.color ?? legacy.color,
    colorThemeKey: cell.style?.colorThemeKey ?? legacy.colorThemeKey,
    bgColor: cell.style?.bgColor ?? legacy.bgColor,
    bgColorThemeKey: cell.style?.bgColorThemeKey ?? legacy.bgColorThemeKey,
    fontSize: cell.style?.fontSize ?? legacy.fontSize,
    fontName: cell.style?.fontName ?? cell.style?.fontFamily ?? legacy.fontName ?? legacy.fontFamily,
    align: cell.style?.align ?? legacy.align,
    verticalAlign: cell.style?.verticalAlign ?? legacy.verticalAlign,
    padding: cell.style?.padding ?? legacy.padding,
    cellBorders: cell.style?.cellBorders ?? legacy.cellBorders,
  }
}

/** 表格总列数（取各行最大列数，避免首行异常导致主题/导出错位） */
export function getTableColumnCount(data: TableCell[][]): number {
  return data.reduce((max, row) => Math.max(max, row?.length || 0), 0)
}

/**
 * 计算表格主题派生颜色
 */
export function getTableThemeColors(
  theme?: TableTheme,
  fallbackThemeColor?: string,
  innerBorderVisible: boolean = true,
): TableThemeColors {
  const themeColor = theme?.color || fallbackThemeColor || DEFAULT_THEME_COLOR
  return {
    themeColor,
    borderBottomColor: innerBorderVisible ? (hexWithAlpha(themeColor, '33') || '#e5e7eb') : 'transparent',
    borderRightColor: innerBorderVisible ? (hexWithAlpha(themeColor, '22') || '#e5e7eb') : 'transparent',
    stripedColor: hexWithAlpha(themeColor, '0d') || '#f8f9fa',
  }
}

export interface CellThemeStyle {
  /** 计算后的背景色 */
  bgColor: string
  /** 计算后的文字颜色 */
  textColor: string
  /** 是否加粗 */
  bold: boolean
  /** 底部边框 */
  borderBottom: string
  /** 右侧边框 */
  borderRight: string
}

/**
 * 根据 theme 配置和单元格位置计算最终的单元格样式
 *
 * 与编辑器 TableElement.tsx 中 cellStyle 函数完全一致。
 */
export function getCellThemeStyle(
  cell: TableCell,
  rowIdx: number,
  colIdx: number,
  totalRows: number,
  totalCols: number,
  theme: TableTheme | undefined,
  themeColors: TableThemeColors,
): CellThemeStyle {
  const style = resolveTableCellStyle(cell)
  const isHeaderRow = theme?.headerRow && rowIdx === 0
  const isFooterRow = theme?.footerRow && rowIdx === totalRows - 1
  const isHeaderCol = theme?.headerCol && colIdx === 0
  const isLastColThemed = theme?.lastCol && colIdx + (cell.colspan ?? 1) >= totalCols
  const isStripedRow = theme?.stripedRows && rowIdx % 2 === 1 && !isHeaderRow && !isFooterRow
  const isStripedCol = theme?.stripedCols && colIdx % 2 === 1 && !isHeaderCol && !isLastColThemed
  const isLastRow = rowIdx === totalRows - 1
  const isLastCol = colIdx + (cell.colspan ?? 1) >= totalCols

  // 背景色优先级：单元格自定义 > 首行/末行 > 条纹行 > 条纹列 > 透明
  let bgColor: string
  if (style.bgColor) {
    bgColor = style.bgColor
  } else if (isHeaderRow || isFooterRow) {
    bgColor = themeColors.themeColor
  } else if (isStripedRow) {
    bgColor = themeColors.stripedColor
  } else if (isStripedCol) {
    bgColor = themeColors.stripedColor
  } else {
    bgColor = 'transparent'
  }

  // 文字颜色：首行/末行使用白色
  const textColor = (isHeaderRow || isFooterRow) ? '#FFFFFF' : (style.color || '')

  // 加粗：首行/末行/首列/末列
  const bold = !!(isHeaderRow || isFooterRow || isHeaderCol || isLastColThemed || style.bold)

  return {
    bgColor,
    textColor,
    bold,
    borderBottom: isLastRow ? 'none' : `1px solid ${themeColors.borderBottomColor}`,
    borderRight: isLastCol ? 'none' : `1px solid ${themeColors.borderRightColor}`,
  }
}
