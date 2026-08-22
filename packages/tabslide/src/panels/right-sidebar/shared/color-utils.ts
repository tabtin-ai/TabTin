export interface RGB { r: number; g: number; b: number }
export interface HSV { h: number; s: number; v: number }

export function rgbToHex(rgb: RGB): string {
  const r = Math.round(Math.max(0, Math.min(255, rgb.r)))
  const g = Math.round(Math.max(0, Math.min(255, rgb.g)))
  const b = Math.round(Math.max(0, Math.min(255, rgb.b)))
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

export function hexToRgb(hex: string): RGB {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  if (h.length !== 6) return { r: 0, g: 0, b: 0 }
  const num = parseInt(h, 16)
  return { r: (num >> 16) & 0xff, g: (num >> 8) & 0xff, b: num & 0xff }
}

export function rgbToHsv(rgb: RGB): HSV {
  const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  let hue = 0
  const s = max === 0 ? 0 : (d / max) * 100
  const v = max * 100
  if (d !== 0) {
    if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) * 60
    else if (max === g) hue = ((b - r) / d + 2) * 60
    else hue = ((r - g) / d + 4) * 60
  }
  return { h: Math.round(hue), s: Math.round(s), v: Math.round(v) }
}

export function hsvToRgb(hsv: HSV): RGB {
  const h = hsv.h / 360, s = hsv.s / 100, v = hsv.v / 100
  let r = 0, g = 0, b = 0
  const i = Math.floor(h * 6), f = h * 6 - i
  const p = v * (1 - s), q = v * (1 - f * s), tt = v * (1 - (1 - f) * s)
  switch (i % 6) {
    case 0: r = v; g = tt; b = p; break
    case 1: r = q; g = v; b = p; break
    case 2: r = p; g = v; b = tt; break
    case 3: r = p; g = q; b = v; break
    case 4: r = tt; g = p; b = v; break
    case 5: r = v; g = p; b = q; break
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) }
}

export function hexToHsv(hex: string): HSV { return rgbToHsv(hexToRgb(hex)) }
export function hsvToHex(hsv: HSV): string { return rgbToHex(hsvToRgb(hsv)) }

export function isValidHex(hex: string): boolean {
  return /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)
}

export function normalizeHex(hex: string): string {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  return `#${h.toLowerCase()}`
}

export function colorWithOpacity(hex: string, opacity: number): string {
  const rgb = hexToRgb(hex)
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`
}

export const CHECKERBOARD_BG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='8' height='8' fill='%23fff'/%3E%3Crect x='8' y='8' width='8' height='8' fill='%23fff'/%3E%3Crect x='8' width='8' height='8' fill='%23e5e5e5'/%3E%3Crect y='8' width='8' height='8' fill='%23e5e5e5'/%3E%3C/svg%3E")`

/**
 * Parse any CSS color string to a hex string, returns null for unparseable.
 * Handles: #rgb, #rrggbb, rgb(), rgba(), named colors via canvas.
 */
export function parseColorToHex(raw: string): string | null {
  if (!raw) return null
  const trimmed = raw.trim().toLowerCase()
  if (isValidHex(trimmed)) return normalizeHex(trimmed)

  const rgbMatch = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (rgbMatch) {
    return rgbToHex({ r: +rgbMatch[1], g: +rgbMatch[2], b: +rgbMatch[3] })
  }

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d')
    if (ctx) {
      const sentinel = '#02fe01'
      ctx.fillStyle = sentinel
      ctx.fillStyle = trimmed
      if (ctx.fillStyle !== sentinel) {
        const hex = ctx.fillStyle
        if (typeof hex === 'string' && hex.startsWith('#')) return normalizeHex(hex)
      } else {
        const sentinel2 = '#01fd02'
        ctx.fillStyle = sentinel2
        ctx.fillStyle = trimmed
        if (ctx.fillStyle !== sentinel2) {
          const hex = ctx.fillStyle
          if (typeof hex === 'string' && hex.startsWith('#')) return normalizeHex(hex)
        }
      }
    }
  }
  return null
}

/**
 * Extract opacity from rgba() string, returns 1 for non-rgba.
 */
export function parseOpacity(raw: string): number {
  const match = raw.trim().match(/^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*([\d.]+)\s*)?\)/)
  if (match && match[1] != null) return Math.max(0, Math.min(1, parseFloat(match[1])))
  return 1
}
