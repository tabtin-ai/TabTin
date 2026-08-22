/**
 * ScreenshotService — Electron 原生截屏能力
 *
 * 支持三种截屏模式：
 * - window: 捕获主窗口渲染内容（整个 App UI）
 * - view:   捕获指定 BrowserView/WebContentsView 的网页内容
 * - screen: 通过 desktopCapturer 捕获整块屏幕（含窗口装饰）
 *
 * 输出：保存为文件并返回路径 + 元信息
 */

import { desktopCapturer, screen } from 'electron'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { getMainWindow } from '../window-manager'
import { getViewFactory } from '../view-factory'
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths'

export interface ScreenshotOptions {
  /** 截屏目标: window=主窗口, view=指定视图, screen=整块屏幕 */
  target?: 'window' | 'view' | 'screen'
  /** 指定视图 ID（target=view 时必填） */
  viewId?: string
  /** 指定屏幕 ID（target=screen 时可选，默认主屏幕） */
  displayId?: string | number
  /** 图片格式 */
  format?: 'png' | 'jpeg'
  /** JPEG 质量 (1-100) */
  quality?: number
  /**
   * 保存路径（BT-034）：
   * - 带图片扩展名（.png/.jpg/.jpeg）→ 视为完整文件路径，直接写入
   * - 无扩展名或以 / 结尾 → 视为目录，系统自动生成带时间戳的文件名
   * - 不传 → 默认目录 ~/.tabtin/screenshots/
   */
  savePath?: string
  /** 是否返回 base64 数据（默认 false，只返回文件路径） */
  includeBase64?: boolean
}

export interface ScreenshotResult {
  success: boolean
  path?: string
  width?: number
  height?: number
  format?: string
  sizeBytes?: number
  scaleFactor?: number
  base64?: string
  error?: string
}

// SS-23: 惰性求值，避免模块 import 时过早固化运行时根。
let _screenshotDir: string | null = null
function getScreenshotDir(): string {
  if (!_screenshotDir) {
    _screenshotDir = getHomeTabtinPath('screenshots')
  }
  return _screenshotDir
}

function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
  } catch { /* already exists */ }
}

function buildFilename(prefix: string, format: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  return `${prefix}-${ts}.${format}`
}

export async function captureScreenshot(options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
  const {
    target = 'window',
    viewId,
    displayId,
    format = 'png',
    quality = 90,
    savePath,
    includeBase64 = false,
  } = options

  try {
    let image: Electron.NativeImage
    let display: Electron.Display | undefined

    if (target === 'screen') {
      display = displayId != null
        ? screen.getAllDisplays().find((item) => String(item.id) === String(displayId))
        : screen.getPrimaryDisplay()

      if (!display) {
        return {
          success: false,
          error: displayId != null ? `屏幕 ${displayId} 不存在` : '无法获取主显示器',
        }
      }

      const activeDisplay = display
      const MAX_CAPTURE_DIMENSION = 3840
      const scale = activeDisplay.scaleFactor
      const physicalW = Math.round(activeDisplay.size.width * scale)
      const physicalH = Math.round(activeDisplay.size.height * scale)
      const ratio = Math.min(1, MAX_CAPTURE_DIMENSION / Math.max(physicalW, physicalH))

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(physicalW * ratio),
          height: Math.round(physicalH * ratio),
        },
      })
      const source = sources.find((item) => item.display_id === String(activeDisplay.id)) || sources[0]

      if (!source) {
        return { success: false, error: '未找到可用的屏幕捕获源' }
      }

      image = source.thumbnail
    } else if (target === 'view' && viewId) {
      const viewFactory = getViewFactory()
      const webContents = viewFactory.getWebContents(viewId)
      if (!webContents || webContents.isDestroyed()) {
        return { success: false, error: `视图 ${viewId} 不存在或已销毁` }
      }
      image = await webContents.capturePage()
    } else {
      const mainWindow = getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { success: false, error: '主窗口不可用' }
      }
      image = await mainWindow.webContents.capturePage()
    }

    if (image.isEmpty()) {
      if (target === 'screen' && process.platform === 'darwin') {
        const { systemPreferences } = await import('electron')
        const status = systemPreferences.getMediaAccessStatus('screen')
        if (status !== 'granted') {
          return {
            success: false,
            error: `屏幕录制权限未授予（当前状态: ${status}）。请在系统偏好设置 > 隐私与安全 > 屏幕录制中允许 TabTin。`,
          }
        }
      }
      return { success: false, error: '截屏结果为空（窗口可能被最小化或不可见）' }
    }

    const buffer = format === 'jpeg' ? image.toJPEG(quality) : image.toPNG()
    const size = image.getSize()

    // BT-034: 区分"完整文件路径"与"目录路径"两种语义
    // 用户传 --save /tmp/out.png → 直接写入该文件，不再追加时间戳文件名
    const isFilePath = savePath != null && /\.(png|jpe?g)$/i.test(savePath)
    let fullPath: string
    if (isFilePath) {
      const { dirname } = await import('node:path')
      ensureDir(dirname(savePath!))
      fullPath = savePath!
    } else {
      const dir = savePath || getScreenshotDir()
      ensureDir(dir)
      const filename = buildFilename(
        target === 'view' ? 'view' : target === 'screen' ? 'screen' : 'window',
        format,
      )
      fullPath = join(dir, filename)
    }
    writeFileSync(fullPath, buffer)

    const result: ScreenshotResult = {
      success: true,
      path: fullPath,
      width: size.width,
      height: size.height,
      format,
      sizeBytes: buffer.length,
      scaleFactor: target === 'screen' ? display?.scaleFactor : undefined,
    }

    if (includeBase64) {
      result.base64 = buffer.toString('base64')
    }

    return result
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
