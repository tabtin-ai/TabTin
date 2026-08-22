import { describe, expect, it, vi } from 'vitest'
import {
  COVER_POSITION_X_PROPERTY,
  COVER_SCALE_PROPERTY,
  COVER_FILE_ID_PROPERTY,
  DEFAULT_COVER_VIEWPORT_ASPECT_RATIO,
  CoverUploadFlowError,
  getCoverPositionX,
  getCoverScale,
  normalizeCoverViewportAspectRatio,
  normalizeCoverPosition,
  normalizeCoverScale,
  uploadAndSaveCover,
  withoutPrivateCoverFileId,
} from './cover-upload'
import type { TabDocImageUploadPort } from '../ports'

const t = (key: string, options?: Record<string, unknown>) => String(options?.defaultValue ?? key)

function makeFile(): File {
  return new File(['cover'], 'cover.png', { type: 'image/png' })
}

describe('uploadAndSaveCover', () => {
  it('drops the private file identity when the cover is replaced or removed', () => {
    expect(withoutPrivateCoverFileId({
      [COVER_FILE_ID_PROPERTY]: 'cover-1',
      [COVER_POSITION_X_PROPERTY]: 0.25,
    })).toEqual({ [COVER_POSITION_X_PROPERTY]: 0.25 })
  })

  it('uploads cover and saves returned url and crop position into document properties', async () => {
    const imageUpload: TabDocImageUploadPort = {
      upload: vi.fn(async () => ({
        url: 'https://cdn.example.com/cover.png?sig=short',
        fileId: 'cover-1',
        fileKey: 'tabdoc/covers/cover.png',
      })),
    }
    const onDocumentPropertyChange = vi.fn()

    await expect(uploadAndSaveCover({
      file: makeFile(),
      documentId: 'doc-1',
      coverPosition: 0.25,
      coverPositionX: 0.75,
      coverScale: 1.8,
      documentProperties: { plan: { status: 'draft' } },
      imageUpload,
      onDocumentPropertyChange,
      t,
    })).resolves.toBe('https://cdn.example.com/cover.png?sig=short')

    expect(imageUpload.upload).toHaveBeenCalledWith(
      expect.any(File),
      {
        folder: 'tabdoc/covers',
        module: 'tabdoc',
        contextType: 'document',
        contextId: 'doc-1',
      },
    )
    expect(onDocumentPropertyChange).toHaveBeenCalledWith(
      {
        cover_image: 'tabdoc/covers/cover.png',
        cover_position: 0.25,
        properties: {
          plan: { status: 'draft' },
          [COVER_POSITION_X_PROPERTY]: 0.75,
          [COVER_SCALE_PROPERTY]: 1.8,
          [COVER_FILE_ID_PROPERTY]: 'cover-1',
        },
      },
      { silentError: true },
    )
  })

  it('defaults cover crop position when caller does not provide one', async () => {
    const imageUpload: TabDocImageUploadPort = {
      upload: vi.fn(async () => ({
        url: 'https://cdn.example.com/cover.png?sig=short',
        fileId: 'cover-1',
        fileKey: 'tabdoc/covers/cover.png',
      })),
    }
    const onDocumentPropertyChange = vi.fn()

    await uploadAndSaveCover({
      file: makeFile(),
      documentId: 'doc-1',
      imageUpload,
      documentProperties: {},
      onDocumentPropertyChange,
      t,
    })

    expect(onDocumentPropertyChange).toHaveBeenCalledWith(
      {
        cover_image: 'tabdoc/covers/cover.png',
        cover_position: 0.5,
        properties: {
          [COVER_POSITION_X_PROPERTY]: 0.5,
          [COVER_SCALE_PROPERTY]: 1,
          [COVER_FILE_ID_PROPERTY]: 'cover-1',
        },
      },
      { silentError: true },
    )
  })

  it('keeps crop position within the backend accepted range', () => {
    expect(normalizeCoverPosition(-0.25)).toBe(0)
    expect(normalizeCoverPosition(0.75)).toBe(0.75)
    expect(normalizeCoverPosition(1.25)).toBe(1)
    expect(normalizeCoverPosition(Number.NaN)).toBe(0.5)
    expect(getCoverPositionX({ [COVER_POSITION_X_PROPERTY]: 0.2 })).toBe(0.2)
    expect(getCoverPositionX({ [COVER_POSITION_X_PROPERTY]: 2 })).toBe(1)
    expect(getCoverPositionX({})).toBe(0.5)
    expect(normalizeCoverScale(0.5)).toBe(1)
    expect(normalizeCoverScale(1.6)).toBe(1.6)
    expect(normalizeCoverScale(4)).toBe(3)
    expect(normalizeCoverScale(Number.NaN)).toBe(1)
    expect(getCoverScale({ [COVER_SCALE_PROPERTY]: 2.2 })).toBe(2.2)
    expect(getCoverScale({ [COVER_SCALE_PROPERTY]: '2' })).toBe(1)
    expect(getCoverScale({})).toBe(1)
  })

  it('derives the crop preview aspect ratio from the real cover viewport', () => {
    expect(normalizeCoverViewportAspectRatio(1000, 200)).toBe(5)
    expect(normalizeCoverViewportAspectRatio(120, 200)).toBe(1)
    expect(normalizeCoverViewportAspectRatio(undefined)).toBe(DEFAULT_COVER_VIEWPORT_ASPECT_RATIO)
    expect(normalizeCoverViewportAspectRatio(Number.NaN)).toBe(DEFAULT_COVER_VIEWPORT_ASPECT_RATIO)
  })

  it('reports upload stage when upload returns empty url', async () => {
    const imageUpload: TabDocImageUploadPort = {
      upload: vi.fn(async () => ({ url: '', fileId: '' })),
    }

    await expect(uploadAndSaveCover({
      file: makeFile(),
      documentId: 'doc-1',
      imageUpload,
      documentProperties: {},
      onDocumentPropertyChange: vi.fn(),
      t,
    })).rejects.toMatchObject({
      stage: 'upload',
      message: '上传完成但没有返回可用的图片地址',
    } satisfies Partial<CoverUploadFlowError>)
  })

  it('reports save stage when cover property save fails', async () => {
    const imageUpload: TabDocImageUploadPort = {
      upload: vi.fn(async () => ({ url: 'https://cdn.example.com/cover.png', fileId: 'cover-1' })),
    }

    await expect(uploadAndSaveCover({
      file: makeFile(),
      documentId: 'doc-1',
      imageUpload,
      documentProperties: {},
      onDocumentPropertyChange: vi.fn(async () => {
        throw new Error('PATCH failed')
      }),
      t,
    })).rejects.toMatchObject({
      stage: 'save',
      message: 'PATCH failed',
    } satisfies Partial<CoverUploadFlowError>)
  })
})
