import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

const mockImportJSON = vi.fn()
const mockDirectUploadBatch = vi.fn()
const mockLoadFromNetworkResponses = vi.fn()
const mockHas = vi.fn(() => false)
const mockRemoveBatch = vi.fn()
const mockDownloadBatch = vi.fn()
const mockClearCache = vi.fn()

vi.mock('@/hooks/useResolvedOrganizationId', () => ({
  useResolvedOrganizationId: () => 'ws-test',
}))

vi.mock('@tabtin/table-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tabtin/table-core')>()
  return {
    ...actual,
    TableApiService: {},
    FieldApiService: {},
    ImportExportApiService: {
      importJSON: mockImportJSON,
    },
  }
})

vi.mock('@/services/oss-direct-uploader', () => ({
  directUploadBatch: mockDirectUploadBatch,
}))

vi.mock('@/services/resources/resource-cache', () => ({
  resourceCache: {
    loadFromNetworkResponses: mockLoadFromNetworkResponses,
    has: mockHas,
    removeBatch: mockRemoveBatch,
  },
}))

vi.mock('@/services/resources/downloader', () => {
  class MockResourceDownloader {
    async downloadBatch(tasks: any[]) {
      return mockDownloadBatch(tasks)
    }

    clearCache() {
      mockClearCache()
    }
  }

  return {
    ResourceDownloader: MockResourceDownloader,
  }
})

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key
      return `${key}:${JSON.stringify(params)}`
    },
  },
}))

const mediaFieldConfigs = [
  {
    sourceField: 'title',
    displayName: '标题',
    fieldType: 'text',
    enabled: true,
  },
  {
    sourceField: 'media',
    displayName: '媒体',
    fieldType: 'attachment',
    enabled: true,
    isMediaField: true,
    saveToServer: true,
    attachmentFieldName: '媒体附件',
    originalUrlFieldName: '媒体原链',
  },
]

const mediaFieldMappings = new Map([
  ['media', { originalUrlField: '媒体原链', attachmentField: '媒体附件' }],
])

const fieldDisplayNames = {
  title: '标题',
  media: '媒体',
}

function getImportedRecords() {
  expect(mockImportJSON).toHaveBeenCalledTimes(1)
  return JSON.parse(mockImportJSON.mock.calls[0][1])
}

describe('useDataImport processAndImportData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadFromNetworkResponses.mockResolvedValue(undefined)
    mockDirectUploadBatch.mockResolvedValue({
      results: [
        {
          success: true,
          fileId: 'file-1',
          accessUrl: 'https://oss.local/file-1',
          fileName: 'media.txt',
          fileSize: 12,
        },
      ],
    })
    mockImportJSON.mockResolvedValue({
      created_count: 1,
      updated_count: 0,
      errors: [],
    })
  })

  it('会把 page_bound_blob 资源按 resourceId/viewId 下发给下载器并导入附件', async () => {
    mockDownloadBatch.mockResolvedValue([
      {
        success: true,
        url: 'blob:https://fixture.local/blob-1',
        fieldName: 'media',
        recordIndex: 0,
        resourceId: 'res-blob-1',
        viewId: 'view-blob-1',
        category: 'video',
        captureStatus: 'content_cached',
        blob: new Blob(['blob-content'], { type: 'text/plain' }),
        fileName: 'media.txt',
        mimeType: 'text/plain',
      },
    ])

    const { useDataImport } = await import('./useDataImport')
    const { result } = renderHook(() => useDataImport())

    let importResult: any
    await act(async () => {
      importResult = await result.current.processAndImportData(
        'table-1',
        '资源表',
        [{ title: 'Blob 记录', media: 'blob:https://fixture.local/blob-1' }],
        mediaFieldConfigs as any,
        mediaFieldMappings,
        fieldDisplayNames,
        [],
        [
          {
            resourceId: 'res-blob-1',
            viewId: 'view-blob-1',
            url: 'blob:https://fixture.local/blob-1',
            captureStatus: 'page_bound_blob',
            category: 'video',
          },
        ] as any,
      )
    })

    expect(importResult).toEqual({
      success: true,
      successCount: 1,
      totalRecords: 1,
    })
    expect(mockDownloadBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        url: 'blob:https://fixture.local/blob-1',
        resourceId: 'res-blob-1',
        viewId: 'view-blob-1',
        captureStatus: 'page_bound_blob',
      }),
    ])
    expect(mockDirectUploadBatch).toHaveBeenCalledTimes(1)

    const importedRecords = getImportedRecords()
    expect(importedRecords).toEqual([
      {
        标题: 'Blob 记录',
        媒体原链: 'blob:https://fixture.local/blob-1',
        媒体附件: [
          {
            file_id: 'file-1',
            url: 'https://oss.local/file-1',
            name: 'media.txt',
            size: 12,
          },
        ],
      },
    ])
  })

  it('遇到 HLS manifest 时不会上传附件，而是保留原链接并写空附件', async () => {
    mockDownloadBatch.mockResolvedValue([
      {
        success: true,
        url: 'https://fixture.local/master.m3u8',
        fieldName: 'media',
        recordIndex: 0,
        resourceId: 'res-hls-1',
        viewId: 'view-hls-1',
        category: 'hls',
        captureStatus: 'content_cached',
        blob: new Blob(['#EXTM3U'], { type: 'application/vnd.apple.mpegurl' }),
        fileName: 'master.m3u8',
        mimeType: 'application/vnd.apple.mpegurl',
      },
    ])

    const { useDataImport } = await import('./useDataImport')
    const { result } = renderHook(() => useDataImport())

    await act(async () => {
      await result.current.processAndImportData(
        'table-1',
        '资源表',
        [{ title: 'HLS 记录', media: 'https://fixture.local/master.m3u8' }],
        mediaFieldConfigs as any,
        mediaFieldMappings,
        fieldDisplayNames,
        [],
        [
          {
            resourceId: 'res-hls-1',
            viewId: 'view-hls-1',
            url: 'https://fixture.local/master.m3u8',
            captureStatus: 'content_cached',
            category: 'hls',
          },
        ] as any,
      )
    })

    expect(mockDirectUploadBatch).not.toHaveBeenCalled()

    const importedRecords = getImportedRecords()
    expect(importedRecords).toEqual([
      {
        标题: 'HLS 记录',
        媒体原链: 'https://fixture.local/master.m3u8',
        媒体附件: [],
      },
    ])
  })

  it('blob 下载失败时会降级保留原链接，避免整批导入中断', async () => {
    mockDownloadBatch.mockResolvedValue([
      {
        success: false,
        url: 'blob:https://fixture.local/blob-fail',
        fieldName: 'media',
        recordIndex: 0,
        resourceId: 'res-blob-fail',
        viewId: 'view-blob-fail',
        category: 'video',
        captureStatus: 'page_bound_blob',
        error: '页面内 blob 已失效',
      },
    ])

    const { useDataImport } = await import('./useDataImport')
    const { result } = renderHook(() => useDataImport())

    let importResult: any
    await act(async () => {
      importResult = await result.current.processAndImportData(
        'table-1',
        '资源表',
        [{ title: '失败记录', media: 'blob:https://fixture.local/blob-fail' }],
        mediaFieldConfigs as any,
        mediaFieldMappings,
        fieldDisplayNames,
        [],
        [
          {
            resourceId: 'res-blob-fail',
            viewId: 'view-blob-fail',
            url: 'blob:https://fixture.local/blob-fail',
            captureStatus: 'page_bound_blob',
            category: 'video',
          },
        ] as any,
      )
    })

    expect(importResult).toEqual({
      success: true,
      successCount: 1,
      totalRecords: 1,
    })
    expect(mockDirectUploadBatch).not.toHaveBeenCalled()

    const importedRecords = getImportedRecords()
    expect(importedRecords).toEqual([
      {
        标题: '失败记录',
        媒体原链: 'blob:https://fixture.local/blob-fail',
        媒体附件: [],
      },
    ])
  })
})
