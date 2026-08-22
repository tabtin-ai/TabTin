/**
 * 跨应用文件引用 DnD 协议（对话 → 文档 / 多维表格 / 对话 Composer）。
 *
 * MIME: application/x-tabtin-file-ref（见 DRAG_TYPE_FILE_REF）
 * 落点：TabDoc handleDrop、GridAttachmentEditor / AttachmentField、
 * ChatInput / ChatContent（ chatFileRefDrop）。
 */

import { useCallback, useMemo, type DragEvent } from 'react'
import { DRAG_TYPE_FILE_REF } from '@/utils/split-coordinator'

export const FILE_REF_DRAG_VERSION = 1 as const

export type FileRefDragSource = 'chat'

export interface FileRefDragPayload {
  version: typeof FILE_REF_DRAG_VERSION
  source: FileRefDragSource
  name: string
  file_id?: string
  url?: string
  mime_type?: string
  size?: number
  width?: number
  height?: number
}

export type FileRefDragInput = {
  name?: string | null
  fileId?: string | null
  url?: string | null
  mimeType?: string | null
  size?: number | null
  /** 同步附带的 File（如 Widget SVG）；表格可走现有 Files 上传 */
  file?: File | null
  /** 文档展示用建议宽度（px）；不传 height，交给 CSS height:auto */
  width?: number | null
  height?: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 是否具备可拖出的最小引用（file_id 或可访问 url；blob: 不稳，排除）。 */
export function canWriteFileRefDrag(input: FileRefDragInput): boolean {
  const fileId = typeof input.fileId === 'string' ? input.fileId.trim() : ''
  if (fileId) return true
  const url = typeof input.url === 'string' ? input.url.trim() : ''
  if (!url) return false
  if (url.startsWith('blob:')) return false
  return url.startsWith('http://')
    || url.startsWith('https://')
    || url.startsWith('data:')
}

export function buildFileRefDragPayload(input: FileRefDragInput): FileRefDragPayload | null {
  if (!canWriteFileRefDrag(input)) return null

  const fileId = typeof input.fileId === 'string' ? input.fileId.trim() : ''
  const url = typeof input.url === 'string' ? input.url.trim() : ''
  const name = (typeof input.name === 'string' && input.name.trim())
    ? input.name.trim()
    : 'image'
  const mimeType = typeof input.mimeType === 'string' ? input.mimeType.trim() : ''
  const size = typeof input.size === 'number' && Number.isFinite(input.size) && input.size >= 0
    ? input.size
    : undefined
  const width = typeof input.width === 'number' && Number.isFinite(input.width) && input.width > 0
    ? Math.round(input.width)
    : undefined
  const height = typeof input.height === 'number' && Number.isFinite(input.height) && input.height > 0
    ? Math.round(input.height)
    : undefined

  const payload: FileRefDragPayload = {
    version: FILE_REF_DRAG_VERSION,
    source: 'chat',
    name,
  }
  if (fileId) payload.file_id = fileId
  if (url && !url.startsWith('blob:')) payload.url = url
  if (mimeType) payload.mime_type = mimeType
  if (size !== undefined) payload.size = size
  if (width !== undefined) payload.width = width
  if (height !== undefined) payload.height = height
  return payload
}

export function writeFileRefDragPayload(
  dataTransfer: DataTransfer,
  input: FileRefDragInput,
): boolean {
  const payload = buildFileRefDragPayload(input)
  if (!payload) return false

  try {
    dataTransfer.setData(DRAG_TYPE_FILE_REF, JSON.stringify(payload))
    dataTransfer.effectAllowed = 'copy'
    const url = payload.url
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      dataTransfer.setData('text/uri-list', url)
      dataTransfer.setData('text/plain', url)
    }
    if (input.file instanceof File) {
      try {
        dataTransfer.items.add(input.file)
      } catch {
        // 部分环境禁止 items.add；file-ref / URL 仍可用
      }
    }
    return true
  } catch {
    return false
  }
}

export function readFileRefDragPayload(
  dataTransfer: Pick<DataTransfer, 'getData' | 'types'>,
  mimeType: string = DRAG_TYPE_FILE_REF,
): FileRefDragPayload | null {
  const types = Array.from(dataTransfer.types ?? [])
  if (types.length > 0 && !types.includes(mimeType)) return null

  const raw = dataTransfer.getData(mimeType)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    if (parsed.version !== FILE_REF_DRAG_VERSION) return null
    if (parsed.source !== 'chat') return null
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) return null

    const fileId = typeof parsed.file_id === 'string' ? parsed.file_id.trim() : ''
    const url = typeof parsed.url === 'string' ? parsed.url.trim() : ''
    if (!fileId && !url) return null

    const payload: FileRefDragPayload = {
      version: FILE_REF_DRAG_VERSION,
      source: 'chat',
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

export function hasFileRefDragType(
  dataTransfer: Pick<DataTransfer, 'types'>,
  mimeType: string = DRAG_TYPE_FILE_REF,
): boolean {
  return Array.from(dataTransfer.types ?? []).includes(mimeType)
}

/**
 * 对话缩略图拖源：可拖时写 file-ref MIME，不拦截点击预览。
 */
export function useChatImageDragSource(input: FileRefDragInput) {
  const fileId = input.fileId ?? null
  const url = input.url ?? null
  const name = input.name ?? null
  const mimeType = input.mimeType ?? null
  const size = input.size ?? null
  const file = input.file ?? null
  const width = input.width ?? null
  const height = input.height ?? null

  const canDrag = useMemo(
    () => canWriteFileRefDrag({ fileId, url, name, mimeType, size }),
    [fileId, url, name, mimeType, size],
  )

  const onDragStart = useCallback(
    (event: DragEvent) => {
      if (!canDrag) {
        event.preventDefault()
        return
      }
      const ok = writeFileRefDragPayload(event.dataTransfer, {
        fileId,
        url,
        name,
        mimeType,
        size,
        file,
        width,
        height,
      })
      if (!ok) {
        event.preventDefault()
      }
    },
    [canDrag, fileId, url, name, mimeType, size, file, width, height],
  )

  return {
    draggable: canDrag,
    onDragStart,
  }
}
