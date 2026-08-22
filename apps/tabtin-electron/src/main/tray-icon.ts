/**
 * 托盘 / 菜单栏图标处理。
 *
 * Dock 用的是带白底圆角的 1024 App 图标；菜单栏若原样缩小，会像一颗「大 App 磁贴」。
 * Windows 等平台：抠白底 → 裁笔触。
 * macOS：保留白色底形、把黑色机器人镂空，生成视觉重心稳定的负形 Template。
 * 最终都画进托盘画布，并用 scaleFactor 标明 @1x/@2x。
 *
 * 踩坑：resize 到 32px 却不标 scaleFactor=2 时，macOS 会当成 32**pt**，比旁边 ChatGPT 等大约一倍。
 */

import { nativeImage, screen, type NativeImage } from 'electron'

/**
 * 默认托盘逻辑边长（pt）。
 * Windows 等平台维持原有 20pt；macOS 菜单栏略放大一档。
 */
export const TRAY_ICON_LOGICAL_EDGE = 20
/** 笔触占画布比例：略留边，不顶满。 */
export const TRAY_ICON_GLYPH_RATIO = 0.94
export const MACOS_TRAY_ICON_LOGICAL_EDGE = 21
export const MACOS_TRAY_ICON_GLYPH_RATIO = 1
export const MACOS_TRAY_ICON_OFFSET_Y = 0

/** 工作分辨率：够保留笔触，又不必扫整张 1024。 */
const WORK_EDGE = 256
/** 近白视为底板（含轻微抗锯齿） */
const WHITE_LUMA_CUTOFF = 235
/** alpha 低于此视为已透明 */
const ALPHA_CUTOFF = 8

export interface PixelBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * 就地把 BGRA App 图标变成「黑墨 + alpha」模板：白底变透明，深色笔触保留。
 * 返回非透明像素包围盒；若整图空则返回 null。
 */
export function convertAppIconBitmapToTrayTemplate(
  bitmap: Buffer,
  width: number,
  height: number,
): PixelBounds | null {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const b = bitmap[o]!
      const g = bitmap[o + 1]!
      const r = bitmap[o + 2]!
      const a = bitmap[o + 3]!
      const luma = r * 0.299 + g * 0.587 + b * 0.114

      if (a < ALPHA_CUTOFF || luma > WHITE_LUMA_CUTOFF) {
        bitmap[o] = 0
        bitmap[o + 1] = 0
        bitmap[o + 2] = 0
        bitmap[o + 3] = 0
        continue
      }

      const ink = Math.min(255, Math.max(0, Math.round((255 - luma) * (a / 255))))
      bitmap[o] = 0
      bitmap[o + 1] = 0
      bitmap[o + 2] = 0
      bitmap[o + 3] = ink

      if (ink > ALPHA_CUTOFF) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }

  if (maxX < minX || maxY < minY) return null
  return { minX, minY, maxX, maxY }
}

/**
 * 把 BGRA App 图标变成 macOS 负形 Template：
 * 原图白色底形成为模板前景，黑色机器人变成透明镂空。
 */
export function convertAppIconBitmapToInvertedTrayTemplate(
  bitmap: Buffer,
  width: number,
  height: number,
): PixelBounds | null {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const b = bitmap[o]!
      const g = bitmap[o + 1]!
      const r = bitmap[o + 2]!
      const a = bitmap[o + 3]!
      const luma = r * 0.299 + g * 0.587 + b * 0.114
      const mask = a < ALPHA_CUTOFF
        ? 0
        : Math.min(255, Math.max(0, Math.round(luma * (a / 255))))

      bitmap[o] = 0
      bitmap[o + 1] = 0
      bitmap[o + 2] = 0
      bitmap[o + 3] = mask

      if (mask > ALPHA_CUTOFF) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }

  if (maxX < minX || maxY < minY) return null
  return { minX, minY, maxX, maxY }
}

/** 在包围盒外留一点边，避免裁切笔触。 */
export function padPixelBounds(
  bounds: PixelBounds,
  width: number,
  height: number,
  pad: number,
): PixelBounds {
  return {
    minX: Math.max(0, bounds.minX - pad),
    minY: Math.max(0, bounds.minY - pad),
    maxX: Math.min(width - 1, bounds.maxX + pad),
    maxY: Math.min(height - 1, bounds.maxY + pad),
  }
}

/** 把 src 居中贴进透明画布（均为正方形 BGRA）。 */
export function blitCenteredBgra(
  canvas: Buffer,
  canvasEdge: number,
  src: Buffer,
  srcEdge: number,
  offsetX = 0,
  offsetY = 0,
): void {
  const centeredOffset = Math.floor((canvasEdge - srcEdge) / 2)
  for (let y = 0; y < srcEdge; y++) {
    for (let x = 0; x < srcEdge; x++) {
      const si = (y * srcEdge + x) * 4
      const targetX = x + centeredOffset + offsetX
      const targetY = y + centeredOffset + offsetY
      if (targetX < 0 || targetY < 0 || targetX >= canvasEdge || targetY >= canvasEdge) {
        continue
      }
      const di = (targetY * canvasEdge + targetX) * 4
      canvas[di] = src[si]!
      canvas[di + 1] = src[si + 1]!
      canvas[di + 2] = src[si + 2]!
      canvas[di + 3] = src[si + 3]!
    }
  }
}

export function resolveTrayIconScaleFactor(scaleFactor = 1): number {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return 1
  return Math.min(3, Math.max(1, Math.round(scaleFactor)))
}

function readDisplayScaleFactor(): number {
  try {
    return screen.getPrimaryDisplay().scaleFactor
  } catch {
    return process.platform === 'darwin' ? 2 : 1
  }
}

function buildPaddedRepresentation(
  cropped: NativeImage,
  scale: number,
): { scaleFactor: number; width: number; height: number; buffer: Buffer } {
  const logicalEdge = process.platform === 'darwin'
    ? MACOS_TRAY_ICON_LOGICAL_EDGE
    : TRAY_ICON_LOGICAL_EDGE
  const glyphRatio = process.platform === 'darwin'
    ? MACOS_TRAY_ICON_GLYPH_RATIO
    : TRAY_ICON_GLYPH_RATIO
  const physical = logicalEdge * scale
  const glyphEdge = Math.max(1, Math.round(physical * glyphRatio))
  const glyph = cropped.resize({
    width: glyphEdge,
    height: glyphEdge,
    quality: 'best',
  })
  const canvas = Buffer.alloc(physical * physical * 4, 0)
  const offsetY = process.platform === 'darwin'
    ? MACOS_TRAY_ICON_OFFSET_Y * scale
    : 0
  blitCenteredBgra(canvas, physical, Buffer.from(glyph.toBitmap()), glyphEdge, 0, offsetY)
  const buffer = nativeImage
    .createFromBitmap(canvas, { width: physical, height: physical })
    .toPNG()
  return { scaleFactor: scale, width: physical, height: physical, buffer }
}

/**
 * 从 Dock 级 App 图标生成菜单栏托盘图。
 * 同时挂 @1x / @2x（必要时 @3x）表示，避免 Retina 把物理像素当成 point。
 */
export function createTrayNativeImage(iconPath: string): NativeImage {
  const source = nativeImage.createFromPath(iconPath)
  if (source.isEmpty()) return source

  const working = source.resize({
    width: WORK_EDGE,
    height: WORK_EDGE,
    quality: 'best',
  })
  const { width, height } = working.getSize()
  const bitmap = Buffer.from(working.toBitmap())
  const bounds = process.platform === 'darwin'
    ? convertAppIconBitmapToInvertedTrayTemplate(bitmap, width, height)
    : convertAppIconBitmapToTrayTemplate(bitmap, width, height)

  const scale = resolveTrayIconScaleFactor(readDisplayScaleFactor())
  if (!bounds) {
    // 抠图失败：仍按正确 scaleFactor 缩，避免 32px≈32pt
    return nativeImage.createFromBuffer(
      source.resize({
        width: TRAY_ICON_LOGICAL_EDGE * scale,
        height: TRAY_ICON_LOGICAL_EDGE * scale,
        quality: 'best',
      }).toPNG(),
      { scaleFactor: scale },
    )
  }

  const padded = padPixelBounds(bounds, width, height, 4)
  let cropped = nativeImage.createFromBitmap(bitmap, { width, height })
  cropped = cropped.crop({
    x: padded.minX,
    y: padded.minY,
    width: padded.maxX - padded.minX + 1,
    height: padded.maxY - padded.minY + 1,
  })

  const image = nativeImage.createEmpty()
  const scales = new Set<number>([1, 2, scale])
  for (const s of scales) {
    image.addRepresentation(buildPaddedRepresentation(cropped, s))
  }

  if (process.platform === 'darwin') {
    image.setTemplateImage(true)
  }
  return image
}
