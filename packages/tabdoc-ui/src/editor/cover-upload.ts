import type { TabDocImageUploadPort } from '../ports'

export type CoverUploadStage = 'upload' | 'save'
export const COVER_POSITION_X_PROPERTY = 'cover_position_x'
export const COVER_SCALE_PROPERTY = 'cover_scale'
export const COVER_FILE_ID_PROPERTY = 'cover_image_file_id'
export const MIN_COVER_SCALE = 1
export const MAX_COVER_SCALE = 3
export const COVER_VIEWPORT_HEIGHT_PX = 200
export const DEFAULT_COVER_VIEWPORT_ASPECT_RATIO = 3

export class CoverUploadFlowError extends Error {
  readonly stage: CoverUploadStage
  readonly cause?: unknown

  constructor(stage: CoverUploadStage, message: string, cause?: unknown) {
    super(message)
    this.name = 'CoverUploadFlowError'
    this.stage = stage
    this.cause = cause
  }
}

export interface UploadAndSaveCoverInput {
  file: File
  documentId: string
  coverPosition?: number
  coverPositionX?: number
  coverScale?: number
  documentProperties: Record<string, unknown>
  imageUpload: TabDocImageUploadPort
  onDocumentPropertyChange: (
    updates: Record<string, unknown>,
    options?: { silentError?: boolean },
  ) => void | Promise<void>
  t: (key: string, options?: Record<string, unknown>) => string
}

export function normalizeCoverPosition(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

export function getCoverPositionX(properties?: Record<string, unknown> | null): number {
  const value = properties?.[COVER_POSITION_X_PROPERTY]
  return normalizeCoverPosition(typeof value === 'number' ? value : undefined)
}

export function normalizeCoverScale(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MIN_COVER_SCALE
  return Math.min(MAX_COVER_SCALE, Math.max(MIN_COVER_SCALE, value))
}

export function getCoverScale(properties?: Record<string, unknown> | null): number {
  const value = properties?.[COVER_SCALE_PROPERTY]
  return normalizeCoverScale(typeof value === 'number' ? value : undefined)
}

export function withoutPrivateCoverFileId(
  properties?: Record<string, unknown> | null,
): Record<string, unknown> {
  const next = { ...(properties ?? {}) }
  delete next[COVER_FILE_ID_PROPERTY]
  return next
}

export function normalizeCoverViewportAspectRatio(
  viewportWidth: number | undefined,
  viewportHeight = COVER_VIEWPORT_HEIGHT_PX,
): number {
  if (
    typeof viewportWidth !== 'number'
    || typeof viewportHeight !== 'number'
    || !Number.isFinite(viewportWidth)
    || !Number.isFinite(viewportHeight)
    || viewportWidth <= 0
    || viewportHeight <= 0
  ) {
    return DEFAULT_COVER_VIEWPORT_ASPECT_RATIO
  }
  return Math.max(1, viewportWidth / viewportHeight)
}

export async function uploadAndSaveCover(input: UploadAndSaveCoverInput): Promise<string> {
  const { file, documentId, imageUpload, onDocumentPropertyChange, t } = input
  const coverPosition = normalizeCoverPosition(input.coverPosition)
  const coverPositionX = normalizeCoverPosition(input.coverPositionX)
  const coverScale = normalizeCoverScale(input.coverScale)

  let uploadedUrl = ''
  let uploadedFileId = ''
  let uploadedFileKey = ''
  try {
    const result = await imageUpload.upload(file, {
      folder: 'tabdoc/covers',
      module: 'tabdoc',
      contextType: 'document',
      contextId: documentId,
    })
    uploadedUrl = result.url
    uploadedFileId = result.fileId
    uploadedFileKey = result.fileKey || ''
  } catch (error) {
    const message = error instanceof Error ? error.message : t('imageUploadFailed')
    throw new CoverUploadFlowError('upload', message, error)
  }

  if (!uploadedUrl) {
    throw new CoverUploadFlowError(
      'upload',
      t('imageUploadReturnedEmptyUrl', { defaultValue: '上传完成但没有返回可用的图片地址' }),
    )
  }

  try {
    await onDocumentPropertyChange({
      cover_image: uploadedFileKey || uploadedUrl,
      cover_position: coverPosition,
      properties: {
        ...input.documentProperties,
        [COVER_POSITION_X_PROPERTY]: coverPositionX,
        [COVER_SCALE_PROPERTY]: coverScale,
        [COVER_FILE_ID_PROPERTY]: uploadedFileId,
      },
    }, { silentError: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : t('coverSaveFailed', { defaultValue: '封面保存失败' })
    throw new CoverUploadFlowError('save', message, error)
  }

  return uploadedUrl
}
