import type {
  PPTChartElement,
  PPTElement,
  PPTLineElement,
  PPTShapeElement,
  PPTTableElement,
  PPTTextElement,
  SlidePresentation,
} from '../../types/slides'
import { resolveThemeColorByKey } from '../../utils/background'

type PresentationTheme = SlidePresentation['theme']

const resolveColor = (key: unknown, theme: PresentationTheme): string | undefined => (
  typeof key === 'string' ? resolveThemeColorByKey(key, theme) : undefined
)

const applyShapeThemeColors = (shape: PPTShapeElement, theme: PresentationTheme) => {
  const fill = resolveColor(shape.fillThemeKey, theme)
  if (fill) shape.fill = fill

  const outline = resolveColor(shape.outline?.themeKey, theme)
  if (outline && shape.outline) shape.outline.color = outline

  const text = resolveColor(shape.text?.defaultColorThemeKey, theme)
  if (text && shape.text) shape.text.defaultColor = text
}

const applyTextThemeColors = (text: PPTTextElement, theme: PresentationTheme) => {
  const defaultColor = resolveColor(text.defaultColorThemeKey, theme)
  if (defaultColor) text.defaultColor = defaultColor

  const outline = resolveColor(text.outline?.themeKey, theme)
  if (outline && text.outline) text.outline.color = outline
}

const applyLineThemeColors = (line: PPTLineElement, theme: PresentationTheme) => {
  const color = resolveColor(line.colorThemeKey, theme)
  if (color) line.color = color
}

const applyTableCellThemeColors = (cell: PPTTableElement['data'][number][number], theme: PresentationTheme) => {
  const style = cell.style
  if (!style) return

  const color = resolveColor(style.colorThemeKey, theme)
  if (color) style.color = color

  const bgColor = resolveColor(style.bgColorThemeKey, theme)
  if (bgColor) style.bgColor = bgColor
}

const applyTableThemeColors = (table: PPTTableElement, theme: PresentationTheme) => {
  const tableColor = resolveColor(table.theme?.colorThemeKey, theme)
  if (tableColor && table.theme) table.theme.color = tableColor

  const outline = resolveColor(table.outline?.themeKey, theme)
  if (outline && table.outline) table.outline.color = outline

  for (const row of table.data) {
    for (const cell of row) {
      applyTableCellThemeColors(cell, theme)
    }
  }
}

const applyChartThemeColors = (chart: PPTChartElement, theme: PresentationTheme) => {
  if (!Array.isArray(chart.themeColorKeys) || !chart.themeColors) return

  const next = [...chart.themeColors]
  for (let i = 0; i < chart.themeColorKeys.length && i < next.length; i += 1) {
    const resolved = resolveColor(chart.themeColorKeys[i], theme)
    if (resolved) next[i] = resolved
  }
  chart.themeColors = next
}

/**
 * 根据新主题解析 themeKey 引用并更新元素的 hex 快照色值。
 * 用于 updatePresentationMeta 切换主题时保持元素颜色同步。
 */
export function applyThemeColorsToElement(el: PPTElement, theme: PresentationTheme) {
  if (el.type === 'shape') {
    applyShapeThemeColors(el as PPTShapeElement, theme)
  } else if (el.type === 'text') {
    applyTextThemeColors(el as PPTTextElement, theme)
  } else if (el.type === 'line') {
    applyLineThemeColors(el as PPTLineElement, theme)
  } else if (el.type === 'table') {
    applyTableThemeColors(el as PPTTableElement, theme)
  } else if (el.type === 'chart') {
    applyChartThemeColors(el as PPTChartElement, theme)
  }
}
