/**
 * Widget（show_widget SVG 图示）→ file-ref 拖源物料。
 *
 * SVG / Mermaid 优先用 final SVG code 规范化后生成 File + data URL；源码缺失时
 * 才用 image_url（烤图 PNG）。这样文档侧与对话 iframe 使用同一 SVG，尺寸一致。
 * HTML widget 第一期不拖（无稳定位图）；流式未完成也不拖。
 */

import type { FileRefDragInput } from '@/utils/fileRefDrag'
import { capDisplayWidth, normalizeSvgForImgSrc } from './normalizeSvgForImgSrc'

export type WidgetDragFormat = 'svg' | 'html' | 'mermaid'

export type WidgetFileRefDragArtifacts = {
  input: FileRefDragInput
  file?: File
}

function sanitizeFileBaseName(raw: string): string {
  const cleaned = raw.replace(/[\s\\/:*?"<>|]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return (cleaned || 'widget').slice(0, 40)
}

function looksLikeSvg(code: string): boolean {
  const trimmed = code.trimStart()
  return trimmed.startsWith('<svg') || /<svg[\s>]/i.test(trimmed)
}

/**
 * 从 widget 状态构造可拖物料；不可拖返回 null。
 */
export function buildWidgetFileRefDragArtifacts(opts: {
  imageUrl?: string | null
  finalCode?: string | null
  format: WidgetDragFormat
  title?: string | null
  summary?: string | null
}): WidgetFileRefDragArtifacts | null {
  const baseName = sanitizeFileBaseName(
    (opts.title || opts.summary || 'widget').trim() || 'widget',
  )

  // HTML 无稳定图片落点；第一期不拖
  if (opts.format === 'html') return null

  const code = typeof opts.finalCode === 'string' ? opts.finalCode.trim() : ''
  if (code && looksLikeSvg(code)) {
    const normalized = normalizeSvgForImgSrc(code)
    if (!normalized) return null

    const display = capDisplayWidth(normalized.width, normalized.height)
    const file = new File([normalized.code], `${baseName}.svg`, { type: 'image/svg+xml' })
    const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(normalized.code)}`
    return {
      input: {
        url: dataUrl,
        name: `${baseName}.svg`,
        mimeType: 'image/svg+xml',
        size: file.size,
        file,
        width: display.width,
        // 故意不传 height：文档侧只钉宽度，height:auto 保比例
      },
      file,
    }
  }

  const imageUrl = typeof opts.imageUrl === 'string' ? opts.imageUrl.trim() : ''
  if (
    imageUrl
    && (imageUrl.startsWith('http://')
      || imageUrl.startsWith('https://')
      || imageUrl.startsWith('data:'))
  ) {
    const mimeType = imageUrl.startsWith('data:image/svg')
      ? 'image/svg+xml'
      : 'image/png'
    const ext = mimeType === 'image/svg+xml' ? 'svg' : 'png'
    return {
      input: {
        url: imageUrl,
        name: `${baseName}.${ext}`,
        mimeType,
      },
    }
  }

  return null
}
