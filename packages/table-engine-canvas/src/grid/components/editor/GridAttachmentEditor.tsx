import type {
  TableGridAttachmentDownloadAllHandler,
  TableGridAttachmentDownloadHandler,
  TableGridAttachmentDownloadItem,
  TableGridAttachmentAccessContext,
  TableGridAttachmentFileRef,
  TableGridAttachmentFileRefHandler,
  TableGridAttachmentUploadHandler,
  TableGridAttachmentUploadProgressItem,
  TableGridCanvasEditorLabels,
  TableGridRow,
} from '@tabtin/table-engine'
import { resolveRecordId } from '@tabtin/table-engine'
import type {
  ComponentType,
  ForwardRefExoticComponent,
  ForwardRefRenderFunction,
  ReactNode,
  RefAttributes,
} from 'react'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useGridPopupPosition } from '../../hooks'
import type { IInnerCell } from '../../renderers'
import type { IEditorProps, IEditorRef } from './EditorContainer'
import { CloseIcon, DownloadIcon, FileIcon, PlusIcon } from './editorIcons'

interface AttachmentDisplayItem {
  key: string
  name: string
  url: string
  previewUrl: string
  mimetype: string
  fileId?: string
  uploadItemId?: string
  uploadStatus?: TableGridAttachmentUploadProgressItem['status']
  uploadProgress?: number
  isUploading?: boolean
  raw: unknown
}

function buildAttachmentAccessContext(
  item: AttachmentDisplayItem,
  rowData: TableGridRow,
  fieldId?: string,
): TableGridAttachmentAccessContext {
  const raw = item.raw && typeof item.raw === 'object'
    ? item.raw as Record<string, unknown>
    : {}
  return {
    referenceId: pickString(raw, ['reference_id', 'referenceId']),
    fieldId: fieldId || pickString(raw, ['field_id', 'fieldId']),
    recordId: resolveRecordId(rowData) ?? pickString(raw, ['record_id', 'recordId']),
  }
}

function toDownloadItem(
  item: AttachmentDisplayItem,
  rowData: TableGridRow,
  fieldId?: string,
): TableGridAttachmentDownloadItem | null {
  const url = item.url || item.previewUrl
  if (!url && !item.fileId) return null
  return {
    url,
    name: item.name,
    fileId: item.fileId,
    accessContext: buildAttachmentAccessContext(item, rowData, fieldId),
  }
}

interface UploadingDisplayItem {
  uploadItemId: string
  file?: File
  fileName: string
  status: TableGridAttachmentUploadProgressItem['status']
  progress: number
  previewUrl?: string
  error?: string
}

interface AttachmentEditorLabels {
  upload: string
  uploading: string
  uploadHint: string
  empty: string
  downloadAll: string
  remove: string
  fileTypeNotAllowed: string
}

export interface AttachmentPreviewFile {
  fileId: string
  src: string
  name: string
  mimetype: string
  thumb?: string
  downloadUrl?: string
  /** OSS / 平台文件 id，供宿主预览栈换链或缓存 */
  assetFileId?: string
  accessContext?: TableGridAttachmentAccessContext
}

export interface AttachmentPreviewDialogRef {
  openPreview: (fileId: string) => void
}

export type AttachmentPreviewDialogComponent = ForwardRefExoticComponent<
  { files: AttachmentPreviewFile[] } & RefAttributes<AttachmentPreviewDialogRef>
>

export interface AttachmentPreviewUi {
  Dialog: AttachmentPreviewDialogComponent
  Provider: ComponentType<{ children?: ReactNode }>
  resolveThumbnailUrl?: (file: AttachmentPreviewFile) => Promise<string>
}

const loadDefaultAttachmentPreviewUi = async (): Promise<AttachmentPreviewUi> => {
  const module = await import('@teable/ui-lib')
  return {
    Dialog: module.FilePreviewDialog as AttachmentPreviewDialogComponent,
    Provider: module.FilePreviewProvider as ComponentType<{ children?: ReactNode }>,
  }
}

interface IGridAttachmentEditorProps extends IEditorProps {
  rowData: TableGridRow
  field: string
  fieldId?: string
  rawValue: unknown
  onAttachmentUpload?: TableGridAttachmentUploadHandler<TableGridRow>
  onAttachmentFileRef?: TableGridAttachmentFileRefHandler<TableGridRow>
  onDownloadAttachment?: TableGridAttachmentDownloadHandler
  onDownloadAllAttachments?: TableGridAttachmentDownloadAllHandler
  loadPreviewUi?: () => Promise<AttachmentPreviewUi>
  accept?: string
  isFileAccepted?: (file: File) => boolean
  fileTypeErrorMessage?: string
  inline?: boolean
  className?: string
  disabled?: boolean
  disableRemove?: boolean
  labels?: Pick<
    TableGridCanvasEditorLabels,
    | 'attachmentUpload'
    | 'attachmentUploading'
    | 'attachmentUploadHint'
    | 'attachmentEmpty'
    | 'attachmentDownloadAll'
    | 'attachmentRemove'
    | 'attachmentFileTypeNotAllowed'
  >
}

export interface GridAttachmentInlineEditorProps {
  rowData: TableGridRow
  field: string
  fieldId?: string
  rawValue: unknown
  onChange?: (value: unknown) => void
  onAttachmentUpload?: TableGridAttachmentUploadHandler<TableGridRow>
  onAttachmentFileRef?: TableGridAttachmentFileRefHandler<TableGridRow>
  onDownloadAttachment?: TableGridAttachmentDownloadHandler
  onDownloadAllAttachments?: TableGridAttachmentDownloadAllHandler
  loadPreviewUi?: () => Promise<AttachmentPreviewUi>
  labels?: IGridAttachmentEditorProps['labels']
  accept?: string
  isFileAccepted?: (file: File) => boolean
  fileTypeErrorMessage?: string
  disabled?: boolean
  disableRemove?: boolean
  className?: string
}

const DEFAULT_LABELS: AttachmentEditorLabels = {
  upload: 'Upload',
  uploading: 'Uploading...',
  uploadHint: 'Click, paste, or drag files here',
  empty: 'No attachments',
  downloadAll: 'Download all',
  remove: 'Remove',
  fileTypeNotAllowed: 'Some files are not supported',
}

/** 与 Electron DRAG_TYPE_FILE_REF / 对话拖源对齐 */
const FILE_REF_DRAG_MIME = 'application/x-tabtin-file-ref'
const FILE_REF_DRAG_VERSION = 1

function readFileRefFromDataTransfer(
  dataTransfer: DataTransfer,
): TableGridAttachmentFileRef | null {
  const types = Array.from(dataTransfer.types ?? [])
  if (!types.includes(FILE_REF_DRAG_MIME)) return null
  const raw = dataTransfer.getData(FILE_REF_DRAG_MIME)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed.version !== FILE_REF_DRAG_VERSION) return null
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) return null
    const fileId = typeof parsed.file_id === 'string' ? parsed.file_id.trim() : ''
    const url = typeof parsed.url === 'string' ? parsed.url.trim() : ''
    if (!fileId && !url) return null
    const ref: TableGridAttachmentFileRef = { name: parsed.name.trim() }
    if (fileId) ref.file_id = fileId
    if (url) ref.url = url
    if (typeof parsed.mime_type === 'string' && parsed.mime_type.trim()) {
      ref.mime_type = parsed.mime_type.trim()
    }
    if (typeof parsed.size === 'number' && Number.isFinite(parsed.size) && parsed.size >= 0) {
      ref.size = parsed.size
    }
    return ref
  } catch {
    return null
  }
}

const IMAGE_EXT_PATTERN = /\.(png|jpe?g|gif|bmp|webp|svg|ico)(\?.*)?$/i
const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value)

const pickString = (record: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) {
        return trimmed
      }
    }
  }
  return undefined
}

const FILE_RECORD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FEISHU_IMPORT_OBJECT_PATTERN = /feishu_import(?:\/|%2f)/i

const resolveAttachmentFileId = (record: Record<string, unknown>): string | undefined => {
  const fileId = pickString(record, ['file_id', 'fileId'])
  if (fileId) {
    return fileId
  }

  // Older clients could persist the thumbnail DTO instead of the attachment value.
  // Its `id` is the FileRecord id, but only trust it for recognisable Feishu import objects.
  const legacyId = pickString(record, ['id'])
  if (!legacyId || !FILE_RECORD_ID_PATTERN.test(legacyId)) {
    return undefined
  }
  const objectLocations = [
    pickString(record, [
      'url',
      'access_url',
      'accessUrl',
      'download_url',
      'downloadUrl',
      'path',
    ]),
    pickString(record, ['key', 'file_key', 'fileKey']),
  ]
  return objectLocations.some(
    (location) => location != null && FEISHU_IMPORT_OBJECT_PATTERN.test(location)
  )
    ? legacyId
    : undefined
}

const stripLocalUploadOverlayProvenance = (raw: unknown): unknown => {
  if (
    !isRecordValue(raw) ||
    (!Object.prototype.hasOwnProperty.call(raw, '__local_upload_overlay') &&
      !Object.prototype.hasOwnProperty.call(raw, 'localUploadOverlay'))
  ) {
    return raw
  }

  const sanitized = { ...raw }
  delete sanitized.__local_upload_overlay
  delete sanitized.localUploadOverlay
  return sanitized
}

const canonicalizeAttachmentFileIds = (attachments: unknown[]): unknown[] =>
  attachments.map((raw) => {
    if (!isRecordValue(raw)) {
      return raw
    }
    const existingFileId = pickString(raw, ['file_id'])
    const fileId = existingFileId ?? resolveAttachmentFileId(raw)
    const canonical = fileId && !existingFileId ? { ...raw, file_id: fileId } : raw
    // Upload overlay provenance is display-only and must never enter the record value.
    return stripLocalUploadOverlayProvenance(canonical)
  })

const toAttachmentArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value
  }
  if (value == null) {
    return []
  }
  return [value]
}

const getFileNameFromUrl = (url: string): string => {
  if (!url) return ''
  const path = url.split('?')[0]?.split('#')[0] ?? ''
  const segment = path.split('/').filter(Boolean).pop()
  if (!segment) return ''
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

const inferMimeTypeFromUrl = (url: string): string => {
  const fileName = getFileNameFromUrl(url).toLowerCase()
  const dotIndex = fileName.lastIndexOf('.')
  if (dotIndex < 0) {
    return ''
  }
  return MIME_BY_EXTENSION[fileName.slice(dotIndex + 1)] ?? ''
}

const isUploadingRecord = (record: Record<string, unknown>): boolean => {
  if (record.__uploading === true) {
    return true
  }
  const status = pickString(record, ['upload_status'])
  return status === 'pending' || status === 'uploading'
}

const isImageAttachment = (mimetype: string, url: string, name = ''): boolean => {
  if (mimetype.toLowerCase().startsWith('image/')) {
    return true
  }
  return IMAGE_EXT_PATTERN.test(name) || IMAGE_EXT_PATTERN.test(url)
}

const normalizeAttachmentItems = (attachments: unknown[]): AttachmentDisplayItem[] => {
  const items: AttachmentDisplayItem[] = []
  attachments.forEach((raw, index) => {
    if (typeof raw === 'string') {
      const url = raw.trim()
      const name = getFileNameFromUrl(url) || `Attachment ${index + 1}`
      const key = url || `attachment-${index}`
      items.push({
        key,
        name,
        url,
        previewUrl: url,
        mimetype: '',
        raw,
      })
      return
    }

    if (isRecordValue(raw)) {
      if (isUploadingRecord(raw)) {
        return
      }
      const url =
        pickString(raw, [
          'url',
          'presignedUrl',
          'access_url',
          'accessUrl',
          'download_url',
          'downloadUrl',
          'path',
        ]) ?? ''
      const previewUrl =
        pickString(raw, [
          'smThumbnailUrl',
          'lgThumbnailUrl',
          'thumbnail_url',
          'thumbnailUrl',
          'preview_url',
          'previewUrl',
        ]) ?? url
      const mimetype = pickString(raw, ['mimetype', 'mime_type', 'mimeType', 'type']) ?? ''
      const fileId = resolveAttachmentFileId(raw)
      const key =
        pickString(raw, ['reference_id', 'id', 'file_id', 'token']) ||
        url ||
        `attachment-${index}`
      const name =
        pickString(raw, ['name', 'file_name', 'filename', 'title']) ||
        getFileNameFromUrl(url) ||
        `Attachment ${index + 1}`

      items.push({
        key,
        name,
        url,
        previewUrl,
        mimetype,
        fileId,
        raw,
      })
      return
    }

    const fallback = String(raw)
    items.push({
      key: fallback || `attachment-${index}`,
      name: fallback || `Attachment ${index + 1}`,
      url: '',
      previewUrl: '',
      mimetype: '',
      raw,
    })
  })
  return items
}

const reorderItems = <T,>(items: T[], from: number, to: number): T[] => {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return items
  }
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

const clampProgress = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(1, Math.max(0, value))
}

const normalizeUploadingItems = (
  items: TableGridAttachmentUploadProgressItem[]
): UploadingDisplayItem[] => {
  return items.map((item) => ({
    uploadItemId: item.uploadItemId,
    file: item.file,
    fileName: item.fileName,
    status: item.status,
    progress: clampProgress(item.progress),
    error: item.error,
  }))
}

const normalizeValueUploadingItems = (attachments: unknown[]): UploadingDisplayItem[] => {
  return attachments.flatMap((raw, index) => {
    if (!isRecordValue(raw) || !isUploadingRecord(raw)) {
      return []
    }
    const uploadItemId =
      pickString(raw, ['upload_item_id', 'uploadItemId']) ||
      `upload-${index}`
    const fileName =
      pickString(raw, ['name', 'file_name', 'filename', 'title']) || 'Uploading file'
    const status =
      (pickString(raw, ['upload_status']) as TableGridAttachmentUploadProgressItem['status']) ||
      'uploading'
    const progressValue = raw.upload_progress
    const progress =
      typeof progressValue === 'number' && Number.isFinite(progressValue)
        ? clampProgress(progressValue)
        : 0
    const previewUrl =
      pickString(raw, ['preview_url', 'previewUrl', 'thumbnail_url', 'thumbnailUrl']) ||
      pickString(raw, ['url', 'download_url', 'downloadUrl', 'access_url', 'accessUrl']) ||
      undefined

    return [{
      uploadItemId,
      fileName,
      status,
      progress,
      previewUrl,
      error: pickString(raw, ['error']),
    }]
  })
}

const mergeUploadingItems = (...groups: UploadingDisplayItem[][]): UploadingDisplayItem[] => {
  const merged = new Map<string, UploadingDisplayItem>()
  groups.forEach((items) => {
    items.forEach((item) => {
      const previous = merged.get(item.uploadItemId)
      merged.set(item.uploadItemId, {
        ...previous,
        ...item,
        file: item.file ?? previous?.file,
        previewUrl: item.previewUrl ?? previous?.previewUrl,
        error: item.error ?? previous?.error,
      })
    })
  })
  return Array.from(merged.values())
}

const isImageUploadItem = (item: UploadingDisplayItem): boolean => {
  if (item.previewUrl && IMAGE_EXT_PATTERN.test(item.previewUrl)) {
    return true
  }
  if (!item.file) {
    return false
  }
  return item.file.type.toLowerCase().startsWith('image/') || IMAGE_EXT_PATTERN.test(item.file.name)
}

const UploadingAttachmentItem = ({ item }: { item: UploadingDisplayItem }) => {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)

  useEffect(() => {
    let blobUrl: string | null = null

    if (item.previewUrl) {
      setObjectUrl(item.previewUrl)
    } else if (item.file && isImageUploadItem(item)) {
      blobUrl = URL.createObjectURL(item.file)
      setObjectUrl(blobUrl)
    } else {
      setObjectUrl(null)
    }

    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl)
      }
    }
  }, [item.file, item.previewUrl])

  const percent = Math.round(clampProgress(item.progress) * 100)
  const progressWidth = `${percent}%`

  return (
    <li className="flex h-[132px] w-[104px] flex-col gap-1 rounded-lg p-1">
      <div className="relative flex flex-1 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/30">
        {objectUrl ? (
          <img className="size-full object-cover" src={objectUrl} alt={item.fileName} />
        ) : (
          <FileIcon className="size-5 text-muted-foreground" />
        )}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/55 px-2 text-caption text-white">
          <div className="h-1.5 w-full rounded-full bg-white/35">
            <div
              className="h-full rounded-full bg-white transition-all"
              style={{ width: progressWidth }}
            />
          </div>
          <span>{percent}%</span>
        </div>
      </div>
      <div className="truncate text-caption text-muted-foreground" title={item.fileName}>
        {item.fileName}
      </div>
    </li>
  )
}

const AttachmentThumbnail = ({
  file,
  resolveUrl,
}: {
  file: AttachmentPreviewFile
  resolveUrl?: AttachmentPreviewUi['resolveThumbnailUrl']
}) => {
  const [sourceUrl, setSourceUrl] = useState(file.src)

  useEffect(() => {
    let cancelled = false
    setSourceUrl(resolveUrl && file.assetFileId ? '' : file.src)
    if (!resolveUrl || !file.assetFileId) {
      return () => {
        cancelled = true
      }
    }
    void resolveUrl(file)
      .then((resolvedUrl) => {
        if (!cancelled && resolvedUrl) {
          setSourceUrl(resolvedUrl)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSourceUrl(file.src)
        }
      })
    return () => {
      cancelled = true
    }
  }, [file.assetFileId, file.mimetype, file.name, file.src, resolveUrl])

  if (!sourceUrl) {
    return <FileIcon className="size-5 text-muted-foreground" />
  }
  return (
    <img
      className="size-full object-cover"
      src={sourceUrl}
      alt={file.name}
      onError={() => setSourceUrl('')}
    />
  )
}

const GridAttachmentEditorBase: ForwardRefRenderFunction<
  IEditorRef,
  IGridAttachmentEditorProps
> = (props, ref) => {
  const {
    cell,
    rect,
    style,
    isEditing,
    setEditing,
    onChange,
    rowData,
    field,
    fieldId,
    rawValue,
    onAttachmentUpload,
    onAttachmentFileRef,
    onDownloadAttachment,
    onDownloadAllAttachments,
    loadPreviewUi,
    accept,
    isFileAccepted,
    fileTypeErrorMessage,
    inline = false,
    className,
    disabled = false,
    disableRemove,
    labels,
  } = props
  const popupStyle = useGridPopupPosition(rect, 340)
  const [attachments, setAttachments] = useState<unknown[]>(() => toAttachmentArray(rawValue))
  const [uploadingItems, setUploadingItems] = useState<UploadingDisplayItem[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null)
  const [previewUi, setPreviewUi] = useState<AttachmentPreviewUi | null>(null)
  const [pendingPreviewKey, setPendingPreviewKey] = useState<string | null>(null)
  const rawValueRef = useRef(rawValue)
  rawValueRef.current = rawValue
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const previewDialogRef = useRef<AttachmentPreviewDialogRef | null>(null)
  const previewUiPromiseRef = useRef<Promise<AttachmentPreviewUi> | null>(null)
  const uploadZoneRef = useRef<HTMLDivElement | null>(null)
  const canEdit = !disabled && cell.readonly !== true
  const removeExplicitlyEnabled = disableRemove === false
  const removeExplicitlyDisabled = disableRemove === true
  const canRemove =
    !removeExplicitlyDisabled &&
    typeof onChange === 'function' &&
    (canEdit || (inline && removeExplicitlyEnabled))

  const resolvedLabels = useMemo<AttachmentEditorLabels>(
    () => ({
      upload:
        typeof labels?.attachmentUpload === 'string' && labels.attachmentUpload.trim()
          ? labels.attachmentUpload.trim()
          : DEFAULT_LABELS.upload,
      uploading:
        typeof labels?.attachmentUploading === 'string' && labels.attachmentUploading.trim()
          ? labels.attachmentUploading.trim()
          : DEFAULT_LABELS.uploading,
      uploadHint:
        typeof labels?.attachmentUploadHint === 'string' && labels.attachmentUploadHint.trim()
          ? labels.attachmentUploadHint.trim()
          : DEFAULT_LABELS.uploadHint,
      empty:
        typeof labels?.attachmentEmpty === 'string' && labels.attachmentEmpty.trim()
          ? labels.attachmentEmpty.trim()
          : DEFAULT_LABELS.empty,
      downloadAll:
        typeof labels?.attachmentDownloadAll === 'string' && labels.attachmentDownloadAll.trim()
          ? labels.attachmentDownloadAll.trim()
          : DEFAULT_LABELS.downloadAll,
      remove:
        typeof labels?.attachmentRemove === 'string' && labels.attachmentRemove.trim()
          ? labels.attachmentRemove.trim()
          : DEFAULT_LABELS.remove,
      fileTypeNotAllowed:
        typeof labels?.attachmentFileTypeNotAllowed === 'string' && labels.attachmentFileTypeNotAllowed.trim()
          ? labels.attachmentFileTypeNotAllowed.trim()
          : DEFAULT_LABELS.fileTypeNotAllowed,
    }),
    [labels]
  )

  useEffect(() => {
    setAttachments(toAttachmentArray(rawValue))
  }, [rawValue])

  const attachmentItems = useMemo(
    () => normalizeAttachmentItems(attachments),
    [attachments]
  )
  const valueUploadingItems = useMemo(
    () => normalizeValueUploadingItems(attachments),
    [attachments]
  )
  const displayUploadingItems = useMemo(
    () => mergeUploadingItems(uploadingItems, valueUploadingItems),
    [uploadingItems, valueUploadingItems]
  )
  const previewFiles = useMemo(
    () =>
      attachmentItems
        .filter((item) => Boolean(item.url || item.previewUrl || item.fileId))
        .map((item) => ({
          fileId: item.key,
          src: item.url || item.previewUrl,
          name: item.name,
          mimetype:
            item.mimetype ||
            inferMimeTypeFromUrl(item.url) ||
            inferMimeTypeFromUrl(item.previewUrl) ||
            'application/octet-stream',
          thumb: item.previewUrl || item.url,
          downloadUrl: item.url || item.previewUrl,
          assetFileId: item.fileId,
          accessContext: buildAttachmentAccessContext(item, rowData, fieldId),
        })),
    [attachmentItems, fieldId, rowData]
  )

  const ensurePreviewUiLoaded = useCallback(async () => {
    if (previewUi) {
      return previewUi
    }
    if (!previewUiPromiseRef.current) {
      previewUiPromiseRef.current = (loadPreviewUi ?? loadDefaultAttachmentPreviewUi)().then(
        (nextPreviewUi) => {
          setPreviewUi(nextPreviewUi)
          return nextPreviewUi
        }
      )
    }
    return previewUiPromiseRef.current
  }, [loadPreviewUi, previewUi])

  useEffect(() => {
    if (
      !loadPreviewUi ||
      previewUi ||
      !attachmentItems.some(
        (item) =>
          Boolean(item.fileId) &&
          isImageAttachment(item.mimetype, item.previewUrl || item.url, item.name)
      )
    ) {
      return
    }
    void ensurePreviewUiLoaded().catch(() => undefined)
  }, [attachmentItems, ensurePreviewUiLoaded, loadPreviewUi, previewUi])

  const emitChange = useCallback(
    (nextAttachments: unknown[]) => {
      const canonicalAttachments = canonicalizeAttachmentFileIds(nextAttachments)
      setAttachments(canonicalAttachments)
      onChange?.(canonicalAttachments)
    },
    [onChange]
  )

  const openUrl = useCallback((url: string, downloadName?: string) => {
    if (!url || typeof window === 'undefined' || typeof document === 'undefined') {
      return
    }
    const link = document.createElement('a')
    link.href = url
    // 无宿主回调时的兼容回退：始终新开标签，避免跨域忽略 download 后同页导航离开应用。
    // Electron 应注入 onDownloadAttachment / onDownloadAllAttachments，不会走到这里。
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    if (downloadName) {
      link.download = downloadName
    }
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }, [])

  const downloadOne = useCallback(
    (item: AttachmentDisplayItem) => {
      const downloadItem = toDownloadItem(item, rowData, fieldId)
      if (!downloadItem) return
      if (onDownloadAttachment) {
        void onDownloadAttachment(downloadItem)
        return
      }
      openUrl(downloadItem.url, downloadItem.name)
    },
    [fieldId, onDownloadAttachment, openUrl, rowData],
  )

  const handleUploadFiles = useCallback(
    async (files: File[]) => {
      if (!canEdit || files.length === 0) return
      if (!onAttachmentUpload) {
        return
      }
      setErrorMessage(null)
      const acceptedFiles = isFileAccepted
        ? files.filter((file) => isFileAccepted(file))
        : files
      if (acceptedFiles.length !== files.length) {
        setErrorMessage(fileTypeErrorMessage || resolvedLabels.fileTypeNotAllowed)
      }
      if (acceptedFiles.length === 0) {
        return
      }
      const optimisticUploadingItems: UploadingDisplayItem[] = acceptedFiles.map((file, index) => ({
        uploadItemId: `${file.name}-${Date.now()}-${index}`,
        file,
        fileName: file.name,
        status: 'uploading',
        progress: 0,
      }))
      setUploadingItems(optimisticUploadingItems)
      setIsUploading(true)
      let receivedProgress = false
      try {
        const uploaded = await onAttachmentUpload({
          rowData,
          field,
          fieldId,
          files: acceptedFiles,
          currentValue: attachments,
          onProgress: (progressItems: TableGridAttachmentUploadProgressItem[]) => {
            receivedProgress = true
            const normalized = normalizeUploadingItems(progressItems)
            setUploadingItems(normalized)
            const hasRunningTask = normalized.some(
              (item) => item.status === 'pending' || item.status === 'uploading'
            )
            setIsUploading(hasRunningTask)
          },
        })
        const uploadedItems = Array.isArray(uploaded) ? uploaded.filter((item) => item != null) : []
        if (uploadedItems.length > 0) {
          emitChange([...attachments, ...uploadedItems])
        }
        if (!receivedProgress) {
          setUploadingItems([])
        } else {
          setUploadingItems((current) =>
            current.filter((item) => item.status !== 'completed' && item.status !== 'cancelled')
          )
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Upload failed')
        if (!receivedProgress) {
          setUploadingItems([])
        } else {
          setUploadingItems((current) =>
            current.map((item) =>
              item.status === 'pending' || item.status === 'uploading'
                ? { ...item, status: 'error' }
                : item
            )
          )
        }
      } finally {
        setIsUploading(false)
      }
    },
    [attachments, canEdit, emitChange, field, fieldId, fileTypeErrorMessage, isFileAccepted, onAttachmentUpload, resolvedLabels.fileTypeNotAllowed, rowData]
  )

  const handleFileRefs = useCallback(
    async (fileRefs: TableGridAttachmentFileRef[]) => {
      if (!canEdit || fileRefs.length === 0) return
      if (!onAttachmentFileRef) {
        setErrorMessage(resolvedLabels.fileTypeNotAllowed)
        return
      }
      setErrorMessage(null)
      setIsUploading(true)
      try {
        const uploaded = await onAttachmentFileRef({
          rowData,
          field,
          fieldId,
          fileRefs,
          currentValue: attachments,
        })
        const uploadedItems = Array.isArray(uploaded) ? uploaded.filter((item) => item != null) : []
        if (uploadedItems.length > 0) {
          emitChange([...attachments, ...uploadedItems])
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Upload failed')
      } finally {
        setIsUploading(false)
      }
    },
    [attachments, canEdit, emitChange, field, fieldId, onAttachmentFileRef, resolvedLabels.fileTypeNotAllowed, rowData],
  )

  const onFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files ? Array.from(event.target.files) : []
      if (files.length > 0) {
        void handleUploadFiles(files)
      }
      event.target.value = ''
    },
    [handleUploadFiles]
  )

  const onDropUpload = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!canEdit) return
      event.preventDefault()
      const files = Array.from(event.dataTransfer.files ?? [])
      if (files.length > 0) {
        void handleUploadFiles(files)
        return
      }
      const fileRef = readFileRefFromDataTransfer(event.dataTransfer)
      if (fileRef) {
        void handleFileRefs([fileRef])
      }
    },
    [canEdit, handleFileRefs, handleUploadFiles]
  )

  const onPasteUpload = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      if (!canEdit) return
      const files = Array.from(event.clipboardData?.files ?? [])
      if (files.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      void handleUploadFiles(files)
    },
    [canEdit, handleUploadFiles]
  )

  const removeAttachmentAt = useCallback(
    (index: number) => {
      if (!canRemove) return
      if (index < 0 || index >= attachments.length) return
      emitChange(attachments.filter((_, itemIndex) => itemIndex !== index))
    },
    [attachments, canRemove, emitChange]
  )

  const onDragStartItem = useCallback(
    (event: React.DragEvent<HTMLLIElement>, index: number) => {
      if (!canEdit) return
      event.dataTransfer.setData('text/plain', String(index))
      event.dataTransfer.effectAllowed = 'move'
      setDraggingIndex(index)
    },
    [canEdit]
  )

  const onDragOverUpload = useCallback(
    (event: React.DragEvent<HTMLElement>, effect: 'copy' | 'move' = 'copy') => {
      if (!canEdit) return
      // Windows / Electron：必须 preventDefault + 声明 dropEffect，否则整区显示禁止光标
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = effect
      }
    },
    [canEdit],
  )

  const onDropItem = useCallback(
    (event: React.DragEvent<HTMLLIElement>, targetIndex: number) => {
      if (!canEdit) return
      event.preventDefault()
      event.stopPropagation()

      // 系统文件 / 对话 file-ref 落在缩略图上时按上传处理，避免仅窄条可拖入
      const files = Array.from(event.dataTransfer.files ?? [])
      if (files.length > 0) {
        setDraggingIndex(null)
        void handleUploadFiles(files)
        return
      }
      const fileRef = readFileRefFromDataTransfer(event.dataTransfer)
      if (fileRef) {
        setDraggingIndex(null)
        void handleFileRefs([fileRef])
        return
      }

      const fromText = event.dataTransfer.getData('text/plain')
      const fromIndex = Number(fromText)
      if (!Number.isInteger(fromIndex)) {
        setDraggingIndex(null)
        return
      }
      const next = reorderItems(attachments, fromIndex, targetIndex)
      setDraggingIndex(null)
      emitChange(next)
    },
    [attachments, canEdit, emitChange, handleFileRefs, handleUploadFiles],
  )

  const onDragEndItem = useCallback(() => {
    setDraggingIndex(null)
  }, [])

  const downloadAll = useCallback(() => {
    const items = attachmentItems
      .map((item) => toDownloadItem(item, rowData, fieldId))
      .filter((item): item is TableGridAttachmentDownloadItem => Boolean(item))
    if (items.length === 0) return
    if (onDownloadAllAttachments) {
      void onDownloadAllAttachments(items)
      return
    }
    if (onDownloadAttachment) {
      void Promise.all(items.map((item) => onDownloadAttachment(item)))
      return
    }
    let index = 0
    const downloadNext = () => {
      if (index >= items.length) return
      openUrl(items[index].url, items[index].name)
      index++
      if (index < items.length) {
        setTimeout(downloadNext, 800)
      }
    }
    downloadNext()
  }, [attachmentItems, fieldId, onDownloadAllAttachments, onDownloadAttachment, openUrl, rowData])

  const openAttachmentPreview = useCallback(
    async (item: AttachmentDisplayItem) => {
      const previewTarget = item.previewUrl || item.url
      if (!previewTarget && !item.fileId) {
        return
      }
      if (previewDialogRef.current) {
        previewDialogRef.current.openPreview(item.key)
        return
      }
      try {
        await ensurePreviewUiLoaded()
        setPendingPreviewKey(item.key)
      } catch {
        downloadOne(item)
      }
    },
    [downloadOne, ensurePreviewUiLoaded],
  )

  useEffect(() => {
    if (!pendingPreviewKey || !previewDialogRef.current) {
      return
    }
    previewDialogRef.current.openPreview(pendingPreviewKey)
    setPendingPreviewKey(null)
  }, [pendingPreviewKey, previewUi])

  useImperativeHandle(ref, () => ({
    focus: () => uploadZoneRef.current?.focus(),
    setValue: () => {
      // EditorContainer passes cell.data here, but attachment cell.data is only a
      // thumbnail DTO and intentionally omits business fields such as file_id.
      setAttachments(toAttachmentArray(rawValueRef.current))
    },
    saveValue: () => undefined,
  }))

  if (!inline && !isEditing) {
    return null
  }

  const PreviewProvider = previewUi?.Provider
  const PreviewDialog = previewUi?.Dialog

  const rootClassName = inline
    ? `flex w-full flex-col overflow-hidden rounded-md border border-border-high bg-popover ${className ?? ''}`
    : 'click-outside-ignore absolute z-floating flex w-full flex-col overflow-hidden rounded-md border border-border-high bg-popover shadow-md dark:shadow-lg'
  const rootStyle = inline
    ? style
    : {
        ...style,
        ...popupStyle,
        maxHeight: '320px',
      }

  return (
    <div
      // Inline path has no EditorContainer id host; non-inline already sets
      // id={editorId} on EditorContainer — avoid duplicate DOM ids.
      id={inline ? rect.editorId : undefined}
      style={rootStyle}
      className={rootClassName}
    >
      {!inline && <div className="fixed inset-0 cursor-default" onClick={() => setEditing?.(false)} />}
      <div className="relative flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!canEdit || isUploading || !onAttachmentUpload}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-body disabled:cursor-not-allowed disabled:opacity-50"
            >
              <PlusIcon className="size-3" />
              {isUploading ? resolvedLabels.uploading : resolvedLabels.upload}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              multiple
              accept={accept}
              onChange={onFileInputChange}
            />
            {attachmentItems.length > 0 && (
              <button
                type="button"
                className="inline-flex items-center rounded border border-border px-2 py-1 text-body"
                onClick={downloadAll}
              >
                {resolvedLabels.downloadAll}
              </button>
            )}
          </div>
        </div>

        <div
          ref={uploadZoneRef}
          tabIndex={0}
          role="button"
          onClick={(event) => {
            // 点击缩略图/按钮时不抢文件选择
            if ((event.target as HTMLElement).closest('button, a, input, li')) {
              return
            }
            if (canEdit && onAttachmentUpload) {
              fileInputRef.current?.click()
            }
          }}
          onPaste={onPasteUpload}
          onDragEnter={(event) => onDragOverUpload(event, 'copy')}
          onDragOver={(event) => onDragOverUpload(event, 'copy')}
          onDrop={onDropUpload}
          className="flex min-h-[164px] min-w-0 flex-1 flex-col gap-2 overflow-hidden rounded-md border border-dashed border-border-high bg-secondary px-3 py-2 text-body text-foreground/70 focus:outline-none"
        >
          <div className="shrink-0">{resolvedLabels.uploadHint}</div>
          <div className="min-h-0 flex-1 overflow-auto">
            {displayUploadingItems.length > 0 && (
              <ul className="mb-2 flex flex-wrap gap-2">
                {displayUploadingItems.map((item) => (
                  <UploadingAttachmentItem key={item.uploadItemId} item={item} />
                ))}
              </ul>
            )}
            {attachmentItems.length === 0 && displayUploadingItems.length === 0 ? (
              <div className="flex h-full min-h-[120px] items-center justify-center text-body text-muted-foreground">
                {resolvedLabels.empty}
              </div>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {attachmentItems.map((item, index) => {
                  const isImage = isImageAttachment(
                    item.mimetype,
                    item.previewUrl || item.url,
                    item.name
                  )
                  return (
                    <li
                      key={item.key}
                      draggable={canEdit}
                      onDragStart={(event) => onDragStartItem(event, index)}
                      onDragOver={(event) =>
                        onDragOverUpload(
                          event,
                          draggingIndex != null ? 'move' : 'copy',
                        )
                      }
                      onDrop={(event) => onDropItem(event, index)}
                      onDragEnd={onDragEndItem}
                      className={`group flex h-[132px] w-[104px] flex-col rounded-lg p-1 ${
                        draggingIndex === index ? 'opacity-50' : ''
                      }`}
                    >
                      <button
                        type="button"
                        aria-label={item.name}
                        className="relative flex flex-1 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/30"
                        onClick={() => void openAttachmentPreview(item)}
                      >
                        {isImage ? (
                          <AttachmentThumbnail
                            file={{
                              fileId: item.key,
                              src: item.previewUrl || item.url,
                              name: item.name,
                              mimetype:
                                item.mimetype ||
                                inferMimeTypeFromUrl(item.previewUrl || item.url) ||
                                'application/octet-stream',
                              assetFileId: item.fileId,
                              accessContext: buildAttachmentAccessContext(item, rowData, fieldId),
                            }}
                            resolveUrl={previewUi?.resolveThumbnailUrl}
                          />
                        ) : (
                          <FileIcon className="size-5 text-muted-foreground" />
                        )}
                      </button>
                      <div className="mt-1 flex items-center justify-between gap-1">
                        <button
                          type="button"
                          aria-label={`download-${item.name}`}
                          className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent"
                          onClick={() => downloadOne(item)}
                        >
                          <DownloadIcon className="size-3" />
                        </button>
                        {canRemove && (
                          <button
                            type="button"
                            className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent"
                            onClick={() => removeAttachmentAt(index)}
                            aria-label={resolvedLabels.remove}
                          >
                            <CloseIcon className="size-3" />
                          </button>
                        )}
                      </div>
                      <div className="truncate text-caption text-muted-foreground" title={item.name}>
                        {item.name}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>

        {errorMessage && (
          <div className="rounded border border-destructive/40 bg-destructive/5 px-2 py-1 text-body text-destructive">
            {errorMessage}
          </div>
        )}
      </div>
      {PreviewProvider && PreviewDialog ? (
        <PreviewProvider>
          <PreviewDialog ref={previewDialogRef} files={previewFiles} />
        </PreviewProvider>
      ) : null}
    </div>
  )
}

export const GridAttachmentEditor = forwardRef(GridAttachmentEditorBase)

export const GridAttachmentInlineEditor = ({
  rowData,
  field,
  fieldId,
  rawValue,
  onChange,
  onAttachmentUpload,
  onAttachmentFileRef,
  onDownloadAttachment,
  onDownloadAllAttachments,
  loadPreviewUi,
  labels,
  accept,
  isFileAccepted,
  fileTypeErrorMessage,
  disabled,
  disableRemove,
  className,
}: GridAttachmentInlineEditorProps) => {
  const editorKey = fieldId || field || 'field'
  const editorId = `inline-attachment-editor-${editorKey}`
  return (
    <GridAttachmentEditor
      cell={{ id: `${rowData?.id ?? rowData?.row_id ?? 'record'}-${editorKey}`, data: [], readonly: disabled } as unknown as IInnerCell}
      rect={{ x: 0, y: 0, width: 0, height: 0, editorId }}
      theme={{} as IGridAttachmentEditorProps['theme']}
      isEditing
      inline
      rowData={rowData}
      field={field}
      fieldId={fieldId}
      rawValue={rawValue}
      onChange={onChange}
      onAttachmentUpload={onAttachmentUpload}
      onAttachmentFileRef={onAttachmentFileRef}
      onDownloadAttachment={onDownloadAttachment}
      onDownloadAllAttachments={onDownloadAllAttachments}
      loadPreviewUi={loadPreviewUi}
      labels={labels}
      accept={accept}
      isFileAccepted={isFileAccepted}
      fileTypeErrorMessage={fileTypeErrorMessage}
      disabled={disabled}
      disableRemove={disableRemove}
      className={className}
    />
  )
}
