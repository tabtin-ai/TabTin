import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createCollection: vi.fn(),
  createDocument: vi.fn(),
  createTable: vi.fn(),
  deleteCollection: vi.fn(),
  directUpload: vi.fn(),
  directUploadBatch: vi.fn(),
  importDocumentFileDraft: vi.fn(),
  importMarkdown: vi.fn(),
  importTable: vi.fn(),
  onImported: vi.fn(),
  primeAttachmentBuffer: vi.fn(),
  request: vi.fn(),
  uploadOrganizationFile: vi.fn(),
  uploadSpaceFile: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { resolvedLanguage: 'zh-CN' },
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))
vi.mock('@tabtin/table-core', () => ({
  ImportExportApiService: { import: mocks.importTable },
}))
vi.mock('@tabtin/tabdoc-ui/api-client', () => ({
  createDocument: mocks.createDocument,
  importDocumentFileDraft: mocks.importDocumentFileDraft,
  importMarkdown: mocks.importMarkdown,
}))
vi.mock('@/adapters/sharedAppHostClient', () => ({
  getSharedAppHostClient: vi.fn(() => ({})),
}))
vi.mock('@/services/api', () => ({
  apiService: { request: mocks.request },
}))
vi.mock('@/services/spaceApi', () => ({
  SpaceApiService: {
    uploadOrganizationFile: mocks.uploadOrganizationFile,
    uploadSpaceFile: mocks.uploadSpaceFile,
  },
}))
vi.mock('@/services/oss-direct-uploader', () => ({
  directUpload: mocks.directUpload,
  directUploadBatch: mocks.directUploadBatch,
}))
vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}))
vi.mock('@stores/useTableStore', () => ({
  createTable: mocks.createTable,
  tableStore: { getState: () => ({ loadTables: vi.fn() }) },
}))
vi.mock('@/stores/useCollections', () => ({
  useCollections: {
    getState: () => ({
      createCollection: mocks.createCollection,
      createOrganizationCollection: mocks.createCollection,
      deleteCollection: mocks.deleteCollection,
    }),
  },
}))
vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      openResourceTab: vi.fn(),
      openTableTab: vi.fn(),
    }),
  },
}))
vi.mock('@components/ui', () => ({
  toast: vi.fn(),
}))
vi.mock('@components/chat/preview/attachmentBlobCache', () => ({
  primeAttachmentBuffer: mocks.primeAttachmentBuffer,
}))
vi.mock('../restore/resourceMembershipPending', () => ({
  markResourceMembershipPending: vi.fn(() => ({})),
}))

import { useResourceFileImport } from '../useResourceFileImport'
import { TABFILES_IMPORT_MAX_SIZE_BYTES } from '../resourceFileImportRouting'

function fileWithSize(name: string, size: number): File {
  const file = new File(['content'], name)
  Object.defineProperty(file, 'size', { value: size })
  return file
}

function folderFile(relativePath: string, size = 16): File {
  const name = relativePath.split('/').pop() || relativePath
  const file = new File(['x'.repeat(Math.max(1, size))], name)
  Object.defineProperty(file, 'size', { value: size })
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath })
  return file
}

describe('useResourceFileImport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.directUpload.mockResolvedValue({ fileId: 'file-record-1' })
    mocks.uploadOrganizationFile.mockResolvedValue({ id: 'context-item-1' })
    mocks.uploadSpaceFile.mockResolvedValue({ id: 'context-item-1' })
    mocks.createCollection.mockResolvedValue({ id: 'new-folder-1', name: 'Docs' })
    mocks.deleteCollection.mockResolvedValue(undefined)
    mocks.directUploadBatch.mockImplementation(async (
      files: Array<{ fileName: string }>,
    ) => ({
      total: files.length,
      successCount: files.length,
      failedCount: 0,
      results: files.map((item, index) => ({
        fileId: `file-record-${index + 1}`,
        fileName: item.fileName,
        fileKey: '',
        fileSize: 1,
        accessUrl: '',
        cdnUrl: '',
        success: true,
      })),
    }))
  })

  it.each([
    ['report.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['report.pdf', 'application/pdf'],
    ['archive.zip', 'application/zip'],
    ['notes.mark', 'text/markdown'],
    ['notes.markdown', 'text/markdown'],
    ['notes.mardown', 'text/plain'],
    ['installer.exe', 'application/x-msdownload'],
    ['archive.tar.gz', 'application/gzip'],
    ['README', 'text/plain'],
    ['Makefile', 'text/plain'],
    ['.env', 'text/plain'],
  ])('uploads cloud-drive file %s as tabfiles without invoking content parsers', async (
    fileName,
    mimeType,
  ) => {
    const { result } = renderHook(() => useResourceFileImport({
      spaceId: 'space-1',
      organizationId: 'organization-1',
      collectionId: null,
      tabScopeKey: 'scope-1',
      onImported: mocks.onImported,
    }))
    const file = new File(['file-bytes'], fileName, { type: mimeType })

    await act(async () => {
      expect(await result.current.importFile(file)).toBe(true)
    })

    expect(mocks.directUpload).toHaveBeenCalledWith(file, fileName, {
      folder: 'tabfiles/uploads',
      module: 'tabfiles',
      contextType: 'organization',
      contextId: 'organization-1',
      organizationId: 'organization-1',
      enableInstantUpload: false,
    })
    expect(mocks.uploadOrganizationFile).toHaveBeenCalledWith('organization-1', {
      file_record_id: 'file-record-1',
      title: fileName,
    })
    expect(mocks.primeAttachmentBuffer).toHaveBeenCalledWith('file-record-1', file)
    expect(mocks.primeAttachmentBuffer.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.uploadOrganizationFile.mock.invocationCallOrder[0],
    )
    expect(mocks.uploadSpaceFile).not.toHaveBeenCalled()
    expect(mocks.importTable).not.toHaveBeenCalled()
    expect(mocks.importDocumentFileDraft).not.toHaveBeenCalled()
    expect(mocks.importMarkdown).not.toHaveBeenCalled()
    expect(mocks.createDocument).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.onImported).toHaveBeenCalledWith('tabfiles')
  })

  it('mounts into organization collection when uploading into a folder ', async () => {
    const { result } = renderHook(() => useResourceFileImport({
      spaceId: 'space-1',
      organizationId: 'organization-1',
      collectionId: 'collection-1',
      tabScopeKey: 'scope-1',
      onImported: mocks.onImported,
    }))
    const file = new File(['file-bytes'], 'notes.txt', { type: 'text/plain' })

    await act(async () => {
      expect(await result.current.importFile(file)).toBe(true)
    })

    expect(mocks.directUpload).toHaveBeenCalledWith(file, 'notes.txt', expect.objectContaining({
      contextType: 'organization',
      contextId: 'organization-1',
    }))
    expect(mocks.uploadOrganizationFile).toHaveBeenCalledWith('organization-1', {
      file_record_id: 'file-record-1',
      collection_id: 'collection-1',
      title: 'notes.txt',
    })
    expect(mocks.uploadSpaceFile).not.toHaveBeenCalled()
  })

  it('rejects empty cloud-drive files before upload', async () => {
    const { result } = renderHook(() => useResourceFileImport({
      spaceId: 'space-1',
      organizationId: 'organization-1',
      collectionId: null,
      tabScopeKey: 'scope-1',
      onImported: mocks.onImported,
    }))

    await act(async () => {
      expect(await result.current.importFile(new File([], 'empty.bin'))).toBe(false)
    })

    expect(mocks.directUpload).not.toHaveBeenCalled()
    expect(mocks.uploadOrganizationFile).not.toHaveBeenCalled()
    expect(mocks.uploadSpaceFile).not.toHaveBeenCalled()
    expect(mocks.onImported).not.toHaveBeenCalled()
  })

  it.each([
    [TABFILES_IMPORT_MAX_SIZE_BYTES, true],
    [TABFILES_IMPORT_MAX_SIZE_BYTES + 1, false],
  ])('applies the tabfiles size limit at %s bytes', async (size, expected) => {
    const { result } = renderHook(() => useResourceFileImport({
      spaceId: 'space-1',
      organizationId: 'organization-1',
      collectionId: null,
      tabScopeKey: 'scope-1',
      onImported: mocks.onImported,
    }))

    await act(async () => {
      expect(await result.current.importFile(fileWithSize('payload.bin', size))).toBe(expected)
    })

    expect(mocks.directUpload).toHaveBeenCalledTimes(expected ? 1 : 0)
    expect(mocks.uploadOrganizationFile).toHaveBeenCalledTimes(expected ? 1 : 0)
    if (expected) expect(mocks.onImported).toHaveBeenCalledWith('tabfiles')
    else expect(mocks.onImported).not.toHaveBeenCalled()
  })

  it.each([
    ['upload', () => mocks.directUpload.mockRejectedValue(new Error('upload failed'))],
    ['mount', () => mocks.uploadOrganizationFile.mockRejectedValue(new Error('mount failed'))],
  ])('does not refresh resources when generic file %s fails', async (_stage, arrangeFailure) => {
    arrangeFailure()
    const { result } = renderHook(() => useResourceFileImport({
      spaceId: 'space-1',
      organizationId: 'organization-1',
      collectionId: null,
      tabScopeKey: 'scope-1',
      onImported: mocks.onImported,
    }))

    await act(async () => {
      expect(await result.current.importFile(new File(['content'], 'payload.bin'))).toBe(false)
    })

    expect(mocks.onImported).not.toHaveBeenCalled()
  })

  it('creates a same-named folder and mounts only first-level whitelist files', async () => {
    const { result } = renderHook(() => useResourceFileImport({
      spaceId: 'space-1',
      organizationId: 'organization-1',
      collectionId: 'parent-folder',
      tabScopeKey: 'scope-1',
      onImported: mocks.onImported,
    }))

    await act(async () => {
      expect(await result.current.importFolder([
        folderFile('Docs/readme.md'),
        folderFile('Docs/nested/deep.txt'),
        folderFile('Docs/sheet.xlsx'),
        folderFile('Docs/clip.mp4'),
      ])).toBe(true)
    })

    expect(mocks.createCollection).toHaveBeenCalledWith(
      'organization-1',
      'Docs',
      '📁',
      'parent-folder',
    )
    expect(mocks.directUploadBatch).toHaveBeenCalledTimes(1)
    const batchFiles = mocks.directUploadBatch.mock.calls[0][0] as Array<{
      file: File
      fileName: string
    }>
    expect(batchFiles.map(item => item.fileName)).toEqual(['readme.md', 'sheet.xlsx'])
    expect(mocks.directUploadBatch.mock.calls[0][1]).toEqual(expect.objectContaining({
      contextType: 'organization',
      contextId: 'organization-1',
      organizationId: 'organization-1',
    }))
    expect(mocks.uploadOrganizationFile).toHaveBeenCalledTimes(2)
    expect(mocks.uploadOrganizationFile).toHaveBeenCalledWith('organization-1', {
      file_record_id: 'file-record-1',
      collection_id: 'new-folder-1',
      title: 'readme.md',
    })
    expect(mocks.uploadOrganizationFile).toHaveBeenCalledWith('organization-1', {
      file_record_id: 'file-record-2',
      collection_id: 'new-folder-1',
      title: 'sheet.xlsx',
    })
    expect(mocks.primeAttachmentBuffer).toHaveBeenNthCalledWith(
      1,
      'file-record-1',
      batchFiles[0].file,
    )
    expect(mocks.primeAttachmentBuffer).toHaveBeenNthCalledWith(
      2,
      'file-record-2',
      batchFiles[1].file,
    )
    expect(mocks.uploadSpaceFile).not.toHaveBeenCalled()
    expect(mocks.onImported).not.toHaveBeenCalled()
    expect(mocks.deleteCollection).not.toHaveBeenCalled()
  })

  it('does not create a folder when no first-level whitelist files remain', async () => {
    const { result } = renderHook(() => useResourceFileImport({
      spaceId: 'space-1',
      organizationId: 'organization-1',
      collectionId: null,
      tabScopeKey: 'scope-1',
      onImported: mocks.onImported,
    }))

    await act(async () => {
      expect(await result.current.importFolder([
        folderFile('Empty/nested/a.md'),
        folderFile('Empty/skip.zip'),
      ])).toBe(false)
    })

    expect(mocks.createCollection).not.toHaveBeenCalled()
    expect(mocks.directUploadBatch).not.toHaveBeenCalled()
    expect(mocks.onImported).not.toHaveBeenCalled()
  })

  it('deletes the created folder when every upload fails', async () => {
    mocks.directUploadBatch.mockResolvedValue({
      total: 1,
      successCount: 0,
      failedCount: 1,
      results: [{
        fileId: '',
        fileName: 'readme.md',
        fileKey: '',
        fileSize: 0,
        accessUrl: '',
        cdnUrl: '',
        success: false,
        error: 'upload failed',
      }],
    })

    const { result } = renderHook(() => useResourceFileImport({
      spaceId: 'space-1',
      organizationId: 'organization-1',
      collectionId: null,
      tabScopeKey: 'scope-1',
      onImported: mocks.onImported,
    }))

    await act(async () => {
      expect(await result.current.importFolder([
        folderFile('Docs/readme.md'),
      ])).toBe(false)
    })

    expect(mocks.createCollection).toHaveBeenCalledTimes(1)
    expect(mocks.deleteCollection).toHaveBeenCalledWith('new-folder-1')
    expect(mocks.onImported).not.toHaveBeenCalled()
  })
})
