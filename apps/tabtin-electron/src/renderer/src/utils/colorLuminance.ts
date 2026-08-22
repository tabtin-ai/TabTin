import type React from 'react'

/**
 * 计算颜色的相对亮度 (WCAG 2.0)
 * 支持 hex6 (#rrggbb)、hex3 (#rgb)、rgb()/rgba() 格式
 * CSS 变量 (var(...)) 返回 null
 */
export function colorLuminance(color: string): number | null {
  if (color.includes('var(')) return null

  const toLinear = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const luminance = (r: number, g: number, b: number) =>
    0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)

  const hex6 = color.match(/^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i)
  if (hex6) return luminance(parseInt(hex6[1], 16), parseInt(hex6[2], 16), parseInt(hex6[3], 16))

  const hex3 = color.match(/^#?([\da-f])([\da-f])([\da-f])$/i)
  if (hex3) return luminance(parseInt(hex3[1] + hex3[1], 16), parseInt(hex3[2] + hex3[2], 16), parseInt(hex3[3] + hex3[3], 16))

  const rgb = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/)
  if (rgb) return luminance(parseFloat(rgb[1]), parseFloat(rgb[2]), parseFloat(rgb[3]))

  return null
}

export interface TabColorInfo {
  tabColor: string | null
  tabLuminance: number | null
  tabColorDark: boolean
}

export function resolveTabColor(
  isActive: boolean,
  themeColor: unknown,
  canvasColor: string | null | undefined,
): TabColorInfo {
  if (!isActive) return { tabColor: null, tabLuminance: null, tabColorDark: false }
  const tabColor = (typeof themeColor === 'string' ? themeColor : null) ?? canvasColor ?? null
  const tabLuminance = tabColor ? colorLuminance(tabColor) : null
  const tabColorDark = tabLuminance !== null && tabLuminance < 0.5
  return { tabColor, tabLuminance, tabColorDark }
}

export function tabColorStyle(info: TabColorInfo): React.CSSProperties | undefined {
  const { tabColor, tabLuminance, tabColorDark } = info
  if (!tabColor) return undefined
  return {
    backgroundColor: tabColor,
    ...(tabLuminance !== null ? { color: tabColorDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.8)' } : {}),
  }
}

export function tabCloseButtonClass(
  info: TabColorInfo,
  isActive: boolean,
  variant: 'horizontal' | 'sidebar',
): string {
  const { tabColor, tabLuminance, tabColorDark } = info
  if (tabColor) {
    if (tabLuminance === null) {
      return variant === 'horizontal'
        ? 'bg-background text-muted-foreground hover:text-foreground hover:bg-muted'
        : 'text-muted-foreground hover:text-foreground hover:bg-muted'
    }
    return tabColorDark
      ? 'text-white/70 hover:text-white hover:bg-white/15'
      : 'text-black/50 hover:text-black/80 hover:bg-black/10'
  }
  if (isActive) {
    return variant === 'horizontal'
      ? 'bg-background text-muted-foreground hover:text-foreground hover:bg-muted'
      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
  }
  return variant === 'horizontal'
    ? 'bg-transparent text-muted-foreground hover:text-foreground hover:bg-background/80'
    : 'text-muted-foreground/60 hover:text-foreground hover:bg-muted/60'
}
