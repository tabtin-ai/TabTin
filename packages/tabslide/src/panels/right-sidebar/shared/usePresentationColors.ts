import { useMemo } from 'react'
import { useSlideStore } from '../../../store/slide'
import type { PPTElement, SlideTheme } from '../../../types/slides'
import { normalizeHex, isValidHex, parseColorToHex } from './color-utils'
import { BG_THEME_KEYS } from './constants'
import { resolveBackgroundColor } from '../../../utils/background'

function pushColor(set: Set<string>, raw: string | undefined | null) {
  if (!raw) return
  const hex = parseColorToHex(raw)
  if (hex) set.add(hex)
}

export function collectElementColors(el: PPTElement, set: Set<string>) {
  if (el.type === 'text') {
    pushColor(set, el.defaultColor)
    pushColor(set, el.fill)
  } else if (el.type === 'image') {
    pushColor(set, el.colorMask)
  } else if (el.type === 'shape') {
    if (el.fill) {
      if (typeof el.fill === 'string') pushColor(set, el.fill)
      else if (typeof el.fill === 'object' && 'color' in el.fill) pushColor(set, (el.fill as { color?: string }).color)
    }
    if (el.text) {
      pushColor(set, el.text.defaultColor)
    }
  } else if (el.type === 'line') {
    pushColor(set, el.color)
  } else if (el.type === 'chart') {
    el.themeColors?.forEach((c) => pushColor(set, c))
    pushColor(set, el.fill)
    pushColor(set, el.textColor)
    pushColor(set, el.gridColor)
  } else if (el.type === 'table') {
    el.data?.forEach((row) => row?.forEach((cell) => {
      if (cell.style?.bgColor) pushColor(set, cell.style.bgColor)
    }))
    if (el.theme) pushColor(set, el.theme.color)
  } else if (el.type === 'latex') {
    pushColor(set, el.color)
  } else if (el.type === 'audio') {
    pushColor(set, el.color)
  }

  if ('outline' in el && (el as unknown as { outline?: { color?: string } }).outline) {
    pushColor(set, (el as unknown as { outline: { color?: string } }).outline.color)
  }
  if ('shadow' in el && (el as unknown as { shadow?: { color?: string } }).shadow) {
    pushColor(set, (el as unknown as { shadow: { color?: string } }).shadow.color)
  }
}

export interface PresentationColorSet {
  themeColors: string[]
  documentColors: string[]
  themeColorKeyMap: Map<string, string>
}

/**
 * Extract all unique colors from the current presentation.
 * Returns theme colors and document-level colors (from all pages/elements).
 */
export function usePresentationColors(): PresentationColorSet {
  const presentation = useSlideStore((s) => s.presentation)

  return useMemo(() => {
    const theme = presentation?.theme
    const themeSet = new Set<string>()
    const docSet = new Set<string>()

    if (theme) {
      pushColor(themeSet, theme.backgroundColor)
      pushColor(themeSet, theme.fontColor)
      pushColor(themeSet, theme.bg2Color)
      pushColor(themeSet, theme.tx2Color)
      pushColor(themeSet, theme.hlinkColor)
      pushColor(themeSet, theme.folHlinkColor)
      theme.themeColors?.forEach((c) => pushColor(themeSet, c))
      if (theme.outline) pushColor(themeSet, theme.outline.color)
      if (theme.shadow) pushColor(themeSet, theme.shadow.color)
    }

    presentation?.pages?.forEach((page) => {
      if (page.background) {
        pushColor(docSet, page.background.color)
        if (page.background.theme) pushColor(docSet, page.background.theme.color)
      }
      page.elements?.forEach((el) => collectElementColors(el, docSet))
    })

    themeSet.forEach((c) => docSet.delete(c))

    const themeColorKeyMap = new Map<string, string>()
    if (theme) {
      for (const item of BG_THEME_KEYS) {
        const resolved = resolveBackgroundColor(
          { type: 'theme', theme: { key: item.key } },
          theme,
        )
        const hex = parseColorToHex(resolved)
        if (hex && !themeColorKeyMap.has(hex)) {
          themeColorKeyMap.set(hex, item.key)
        }
      }
    }

    return {
      themeColors: Array.from(themeSet),
      documentColors: Array.from(docSet),
      themeColorKeyMap,
    }
  }, [presentation])
}
