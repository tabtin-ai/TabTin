import { describe, expect, it } from 'vitest'

import {
  blitCenteredBgra,
  convertAppIconBitmapToInvertedTrayTemplate,
  convertAppIconBitmapToTrayTemplate,
  MACOS_TRAY_ICON_GLYPH_RATIO,
  MACOS_TRAY_ICON_LOGICAL_EDGE,
  MACOS_TRAY_ICON_OFFSET_Y,
  padPixelBounds,
  resolveTrayIconScaleFactor,
  TRAY_ICON_GLYPH_RATIO,
  TRAY_ICON_LOGICAL_EDGE,
} from '../tray-icon'

function makeBgra(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): Buffer {
  const buf = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [b, g, r, a] = fill(x, y)
      const o = (y * width + x) * 4
      buf[o] = b
      buf[o + 1] = g
      buf[o + 2] = r
      buf[o + 3] = a
    }
  }
  return buf
}

describe('convertAppIconBitmapToTrayTemplate', () => {
  it('白底变透明，深色笔触变黑墨+alpha，并给出包围盒', () => {
    const width = 8
    const height = 8
    const bitmap = makeBgra(width, height, (x, y) => {
      if (x >= 3 && x <= 4 && y >= 3 && y <= 4) return [0, 0, 0, 255]
      return [255, 255, 255, 255]
    })

    const bounds = convertAppIconBitmapToTrayTemplate(bitmap, width, height)
    expect(bounds).toEqual({ minX: 3, minY: 3, maxX: 4, maxY: 4 })

    expect(bitmap[0]).toBe(0)
    expect(bitmap[3]).toBe(0)

    const ink = ((3 * width + 3) * 4)
    expect(bitmap[ink]).toBe(0)
    expect(bitmap[ink + 1]).toBe(0)
    expect(bitmap[ink + 2]).toBe(0)
    expect(bitmap[ink + 3]).toBe(255)
  })

  it('整图近白时返回 null', () => {
    const bitmap = makeBgra(4, 4, () => [250, 250, 250, 255])
    expect(convertAppIconBitmapToTrayTemplate(bitmap, 4, 4)).toBeNull()
  })
})

describe('convertAppIconBitmapToInvertedTrayTemplate', () => {
  it('白色底形变成模板前景，黑色图案变成透明镂空', () => {
    const bitmap = makeBgra(4, 4, (x, y) => {
      if (x === 1 && y === 1) return [0, 0, 0, 255]
      return [255, 255, 255, 255]
    })

    const bounds = convertAppIconBitmapToInvertedTrayTemplate(bitmap, 4, 4)
    expect(bounds).toEqual({ minX: 0, minY: 0, maxX: 3, maxY: 3 })
    expect(bitmap[3]).toBe(255)
    expect(bitmap[((1 * 4 + 1) * 4) + 3]).toBe(0)
  })

  it('整图透明时返回 null', () => {
    const bitmap = makeBgra(4, 4, () => [255, 255, 255, 0])
    expect(convertAppIconBitmapToInvertedTrayTemplate(bitmap, 4, 4)).toBeNull()
  })
})

describe('padPixelBounds', () => {
  it('向外扩边并夹紧画布', () => {
    expect(padPixelBounds({ minX: 2, minY: 2, maxX: 5, maxY: 5 }, 10, 10, 2))
      .toEqual({ minX: 0, minY: 0, maxX: 7, maxY: 7 })
  })
})

describe('blitCenteredBgra', () => {
  it('把小图居中贴进透明画布', () => {
    const canvas = Buffer.alloc(4 * 4 * 4, 0)
    const src = makeBgra(2, 2, () => [0, 0, 0, 255])
    blitCenteredBgra(canvas, 4, src, 2)
    const center = ((1 * 4 + 1) * 4)
    expect(canvas[center + 3]).toBe(255)
    expect(canvas[3]).toBe(0)
  })

  it('支持向上偏移，并安全裁掉画布外像素', () => {
    const canvas = Buffer.alloc(4 * 4 * 4, 0)
    const src = makeBgra(2, 2, () => [0, 0, 0, 255])
    blitCenteredBgra(canvas, 4, src, 2, 0, -1)
    expect(canvas[((0 * 4 + 1) * 4) + 3]).toBe(255)
    expect(canvas[((2 * 4 + 1) * 4) + 3]).toBe(0)
  })
})

describe('tray icon sizing constants', () => {
  it('默认逻辑 20pt，笔触略小于画布以留边', () => {
    expect(TRAY_ICON_LOGICAL_EDGE).toBe(20)
    expect(TRAY_ICON_GLYPH_RATIO).toBeLessThan(1)
    expect(TRAY_ICON_GLYPH_RATIO).toBeGreaterThan(0.85)
  })

  it('macOS 菜单栏使用略大的 21pt 满画布图标', () => {
    expect(MACOS_TRAY_ICON_LOGICAL_EDGE).toBe(21)
    expect(MACOS_TRAY_ICON_GLYPH_RATIO).toBe(1)
    expect(MACOS_TRAY_ICON_OFFSET_Y).toBe(0)
  })

  it('scaleFactor 夹紧到 1–3', () => {
    expect(resolveTrayIconScaleFactor(2)).toBe(2)
    expect(resolveTrayIconScaleFactor(0)).toBe(1)
    expect(resolveTrayIconScaleFactor(8)).toBe(3)
  })
})
