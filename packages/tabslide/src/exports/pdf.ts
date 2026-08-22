/**
 * PDF 导出 — 基于图片导出 + jsPDF
 *
 * 流程：
 * 1. 使用 image.ts 的 exportPageToImage 逐页截图
 * 2. 使用 jsPDF 将图片拼接为 PDF
 * 3. 支持自定义页面尺寸、方向、间距
 */

import { jsPDF } from 'jspdf'
import type { SlidePresentation } from '../types/slides'
import { exportPageToImage } from './image'
import type { ImageExportOptions } from './image'

// ═══════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════

export interface PDFExportOptions {
  /** PDF 页面方向 */
  orientation?: 'landscape' | 'portrait'
  /** 图片截图选项 */
  imageOptions?: ImageExportOptions
  /** PDF 元信息 */
  title?: string
  author?: string
  subject?: string
  /** 页面间距 (mm) */
  margin?: number
}

// ═══════════════════════════════════════════════
// 导出
// ═══════════════════════════════════════════════

/**
 * 导出演示文稿为 PDF Blob
 */
export async function exportToPDFBlob(
  presentation: SlidePresentation,
  options: PDFExportOptions = {},
  onProgress?: (current: number, total: number) => void,
): Promise<Blob> {
  const {
    orientation = 'landscape',
    imageOptions = {},
    margin = 0,
  } = options

  const cw = presentation.canvasWidth
  const ch = presentation.canvasHeight
  const ratio = ch / cw

  // PDF 尺寸（mm）— 按幻灯片宽高比计算
  const pageWidthMm = orientation === 'landscape' ? 297 : 210 // A4
  const contentHeightMm = pageWidthMm * ratio
  // portrait 模式下确保 height >= width，否则 jsPDF 的 custom format 会覆盖 orientation
  const pageHeightMm = orientation === 'portrait'
    ? Math.max(contentHeightMm, pageWidthMm)
    : contentHeightMm

  const doc = new jsPDF({
    orientation,
    unit: 'mm',
    format: [pageWidthMm + margin * 2, pageHeightMm + margin * 2],
  })

  // 设置元信息
  if (options.title || presentation.name) {
    doc.setProperties({
      title: options.title || presentation.name,
      author: options.author || 'TabSlide',
      subject: options.subject || '',
    })
  }

  const total = presentation.pages.length
  const imgOpts: ImageExportOptions = {
    format: 'jpeg',
    quality: 0.95,
    scale: 2,
    ...imageOptions,
  }

  for (let i = 0; i < total; i++) {
    onProgress?.(i, total)

    // 第 2 页开始需要新建页
    if (i > 0) {
      doc.addPage([pageWidthMm + margin * 2, pageHeightMm + margin * 2], orientation)
    }

    const result = await exportPageToImage(presentation, i, imgOpts)
    doc.addImage(
      result.dataUrl,
      imgOpts.format === 'png' ? 'PNG' : 'JPEG',
      margin,
      margin,
      pageWidthMm,
      contentHeightMm,
    )
  }

  onProgress?.(total, total)
  return doc.output('blob')
}

/**
 * 导出 PDF 并下载
 */
export async function downloadAsPDF(
  presentation: SlidePresentation,
  options: PDFExportOptions = {},
  filename?: string,
  onProgress?: (current: number, total: number) => void,
): Promise<void> {
  const blob = await exportToPDFBlob(presentation, options, onProgress)
  const name = filename || `${presentation.name || '演示文稿'}.pdf`

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * 带内置进度覆盖层的 PDF 下载。
 * 自动在 document.body 上展示居中进度条，导出完成后移除。
 * 适用于宿主层无法提供自定义进度 UI 的场景。
 */
export async function downloadAsPDFWithProgress(
  presentation: SlidePresentation,
  options: PDFExportOptions = {},
  filename?: string,
): Promise<void> {
  const overlay = createProgressOverlay()
  document.body.appendChild(overlay.root)

  try {
    await downloadAsPDF(presentation, options, filename, (current, total) => {
      overlay.update(current, total)
    })
  } catch (err) {
    overlay.showError(err instanceof Error ? err.message : String(err))
    await new Promise((r) => setTimeout(r, 2000))
    throw err
  } finally {
    overlay.root.remove()
  }
}

const PDF_OVERLAY_Z_INDEX = 'var(--z-modal, 10000)'

function createProgressOverlay() {
  const root = document.createElement('div')
  root.style.cssText = `position:fixed;inset:0;z-index:${PDF_OVERLAY_Z_INDEX};display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.35);`
  const card = document.createElement('div')
  card.style.cssText = 'background:#fff;border-radius:12px;padding:24px 32px;min-width:280px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.18);'
  const label = document.createElement('div')
  label.style.cssText = 'font-size:14px;color:;margin-bottom:12px;'
  label.textContent = '正在导出 PDF…'
  const barOuter = document.createElement('div')
  barOuter.style.cssText = 'height:6px;background:#e5e5e5;border-radius:3px;overflow:hidden;'
  const barInner = document.createElement('div')
  barInner.style.cssText = 'height:100%;background:#5b9bd5;border-radius:3px;width:0%;transition:width 0.3s ease;'
  barOuter.appendChild(barInner)
  const pct = document.createElement('div')
  pct.style.cssText = 'font-size:12px;color:;margin-top:8px;'
  pct.textContent = '0%'
  card.appendChild(label)
  card.appendChild(barOuter)
  card.appendChild(pct)
  root.appendChild(card)

  return {
    root,
    update(current: number, total: number) {
      const percent = total > 0 ? Math.round((current / total) * 100) : 0
      barInner.style.width = `${percent}%`
      pct.textContent = `${current} / ${total} (${percent}%)`
      if (current >= total) {
        label.textContent = '导出完成，正在下载…'
      }
    },
    showError(message: string) {
      label.textContent = '导出失败'
      label.style.color = '#e53e3e'
      barInner.style.background = '#e53e3e'
      barInner.style.width = '100%'
      pct.textContent = message
      pct.style.color = '#e53e3e'
    },
  }
}
