/**
 * 对话 file-ref 拖入 TabDoc：解析自定义 MIME，插入 image 节点。
 * MIME 字符串由宿主注入（与 Electron DRAG_TYPE_FILE_REF 对齐）。
 *
 * SVG data URI 会先栅格化为 PNG 再插入（Word 导出不支持 SVG）；
 * 栅格化失败时回退为原始 SVG src（编辑器仍可显示）。
 */

import { toast } from '@tabtin/smartsheet-ui'
import { insertUploadedImage } from './image-insert'
import { isSvgDataUrl, rasterizeSvgDataUrlToPngDataUrl } from './svg-rasterize'

const FILE_REF_DRAG_VERSION = 1

export interface TabDocFileRefPayload {
  version: number
  source: string
  name: string
  file_id?: string
  url?: string
  mime_type?: string
  size?: number
  width?: number
  height?: number
}

export type FileRefDropRasterize = (src: string) => Promise<string | null>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readTabDocFileRefPayload(
  dataTransfer: DataTransfer,
  mimeType: string,
): TabDocFileRefPayload | null {
  const types = Array.from(dataTransfer.types ?? [])
  if (!types.includes(mimeType)) return null

  const raw = dataTransfer.getData(mimeType)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    if (parsed.version !== FILE_REF_DRAG_VERSION) return null
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) return null

    const fileId = typeof parsed.file_id === 'string' ? parsed.file_id.trim() : ''
    const url = typeof parsed.url === 'string' ? parsed.url.trim() : ''
    if (!fileId && !url) return null

    const payload: TabDocFileRefPayload = {
      version: FILE_REF_DRAG_VERSION,
      source: typeof parsed.source === 'string' ? parsed.source : 'chat',
      name: parsed.name.trim(),
    }
    if (fileId) payload.file_id = fileId
    if (url) payload.url = url
    if (typeof parsed.mime_type === 'string' && parsed.mime_type.trim()) {
      payload.mime_type = parsed.mime_type.trim()
    }
    if (typeof parsed.size === 'number' && Number.isFinite(parsed.size) && parsed.size >= 0) {
      payload.size = parsed.size
    }
    if (typeof parsed.width === 'number' && Number.isFinite(parsed.width) && parsed.width > 0) {
      payload.width = Math.round(parsed.width)
    }
    if (typeof parsed.height === 'number' && Number.isFinite(parsed.height) && parsed.height > 0) {
      payload.height = Math.round(parsed.height)
    }
    return payload
  } catch {
    return null
  }
}

type FileRefDropView = {
  state: {
    schema: { nodes: { image?: unknown } }
    doc: { content: { size: number }; resolve: (pos: number) => { parent: { inlineContent: boolean } } }
    tr: { insert: (pos: number, content: any) => { scrollIntoView: () => any } }
  }
  posAtCoords: (coords: { left: number; top: number }) => { pos: number } | null
  dispatch: (tr: any) => void
}

function insertImageAtDrop(
  view: FileRefDropView,
  pos: number,
  src: string,
  payload: TabDocFileRefPayload,
  t: (key: string, opts?: Record<string, unknown>) => string,
): void {
  if (!view.state.schema.nodes.image) {
    toast({
      title: t('imageInsertUnsupported', {
        defaultValue: '当前文档不支持插入图片',
      }),
      variant: 'destructive',
    })
    return
  }

  try {
    // 与粘贴/工具栏共用 insertUploadedImage；只钉 width，避免写死 height
    insertUploadedImage(view as unknown as Parameters<typeof insertUploadedImage>[0], pos, {
      src,
      alt: payload.name || null,
      width: typeof payload.width === 'number' && payload.width > 0 ? payload.width : undefined,
    })
  } catch {
    toast({
      title: t('imageInsertFailed', {
        defaultValue: '插入图片失败',
      }),
      variant: 'destructive',
    })
  }
}

/**
 * 若 dataTransfer 含 file-ref 且能解析出可插入 src，则插入 image 并返回 true。
 * 仅有 file_id、无可访问 url 时 toast 失败并吞掉 drop（避免再走 Novel Files 路径）。
 *
 * SVG data URI：异步栅格化为 PNG 再插入；失败则回退原 SVG。
 *
 * view 用宽松结构类型，避免与 ProseMirror EditorView 参数逆变冲突。
 */
export function tryHandleFileRefImageDrop(
  view: FileRefDropView,
  event: DragEvent,
  moved: boolean,
  fileRefDragType: string | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
  rasterizeSvg: FileRefDropRasterize = rasterizeSvgDataUrlToPngDataUrl,
): boolean {
  if (moved || !fileRefDragType || !event.dataTransfer) return false

  const payload = readTabDocFileRefPayload(event.dataTransfer, fileRefDragType)
  if (!payload) return false

  event.preventDefault()
  event.stopPropagation()

  const src = payload.url?.trim()
  if (!src) {
    toast({
      title: t('imageFileRefMissingUrl', {
        defaultValue: '无法插入图片：缺少可访问地址',
      }),
      variant: 'destructive',
    })
    return true
  }

  if (!view.state.schema.nodes.image) {
    toast({
      title: t('imageInsertUnsupported', {
        defaultValue: '当前文档不支持插入图片',
      }),
      variant: 'destructive',
    })
    return true
  }

  const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
  if (!coords) return true

  const shouldRasterize =
    isSvgDataUrl(src) || payload.mime_type === 'image/svg+xml'

  if (shouldRasterize && isSvgDataUrl(src)) {
    void rasterizeSvg(src).then((pngSrc) => {
      insertImageAtDrop(view, coords.pos, pngSrc || src, payload, t)
    })
    return true
  }

  insertImageAtDrop(view, coords.pos, src, payload, t)
  return true
}
