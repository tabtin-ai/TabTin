import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TabFilesPaneRenderer } from './TabFilesPaneRenderer'
import type { ContextItem } from '../../types'
import { LOCAL_TEXT_PREVIEW_BYTES, MAX_OFFICE_FILE_BYTES } from '@components/shared/file-utils'
import { OSS_PRESIGNED_DOWNLOAD_MAX_BYTES } from '@shared/oss-presigned-upload-ipc'

const openResourceTab = vi.fn()
const addSpaceFolder = vi.fn(() => ({ folderId: 'folder-agent', isNew: false }))
const remoteState = vi.hoisted(() => ({
  isRemote: false,
}))
const resolveOssFileDetail = vi.hoisted(() => vi.fn())
const getAttachmentBuffer = vi.hoisted(() => vi.fn())
const getSpaceFileDownloadUrl = vi.hoisted(() => vi.fn())
const getOrganizationFileDownloadUrl = vi.hoisted(() => vi.fn())
const downloadPreviewResource = vi.hoisted(() => vi.fn())

vi.mock('@/components/chat/preview/resolveOssFileAccessUrl', async () => {
  const actual = await vi.importActual<typeof import('@/components/chat/preview/resolveOssFileAccessUrl')>(
    '@/components/chat/preview/resolveOssFileAccessUrl',
  )
  return {
    ...actual,
    resolveOssFileDetail: (...args: unknown[]) => resolveOssFileDetail(...args),
  }
})

vi.mock('@/components/chat/preview/attachmentBlobCache', () => ({
  getAttachmentBuffer: (...args: unknown[]) => getAttachmentBuffer(...args),
}))

vi.mock('@/components/chat/preview/downloadPreviewResource', () => ({
  downloadPreviewResource: (...args: unknown[]) => downloadPreviewResource(...args),
}))

vi.mock('@/services/spaceApi', () => ({
  SpaceApiService: {
    getSpaceFileDownloadUrl: (...args: unknown[]) => getSpaceFileDownloadUrl(...args),
    getOrganizationFileDownloadUrl: (...args: unknown[]) => getOrganizationFileDownloadUrl(...args),
  },
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode
    onSelect?: () => void
  }) => <button type="button" onClick={onSelect}>{children}</button>,
  DropdownMenuSeparator: () => <hr />,
  toast: vi.fn(),
  resolveChoiceTagColors: () => ({ backgroundColor: '#eee', color: '#111' }),
}))

vi.mock('@components/shared/file-preview/XlsxViewer', () => ({
  XlsxViewer: ({ filePath, data }: { filePath?: string; data?: ArrayBuffer }) => (
    <div data-testid="xlsx-viewer" data-file-path={filePath} data-byte-length={data?.byteLength} />
  ),
}))
vi.mock('@components/shared/file-preview/DocxViewer', () => ({
  DocxViewer: ({ filePath, data }: { filePath?: string; data?: ArrayBuffer }) => (
    <div data-testid="docx-viewer" data-file-path={filePath} data-byte-length={data?.byteLength} />
  ),
}))
vi.mock('@components/shared/file-preview/PptxViewer', () => ({
  PptxViewer: ({ filePath, data }: { filePath?: string; data?: ArrayBuffer }) => (
    <div data-testid="pptx-viewer" data-file-path={filePath} data-byte-length={data?.byteLength} />
  ),
}))
vi.mock('@components/shared/file-preview/PdfViewer', () => ({
  PdfViewer: ({ fileUrl, data }: { fileUrl?: string; data?: ArrayBuffer }) => (
    <div data-testid="pdf-viewer" data-file-url={fileUrl} data-byte-length={data?.byteLength} />
  ),
}))
vi.mock('@components/shared/file-preview/TextFileEditor', () => ({
  TextFileEditor: ({
    filePath,
    fileName,
    content,
    readOnly,
    truncated,
  }: {
    filePath?: string
    fileName?: string
    content: string
    readOnly?: boolean
    truncated?: boolean
  }) => (
    <pre
      data-testid="text-file-editor"
      data-file-path={filePath}
      data-file-name={fileName}
      data-read-only={String(readOnly)}
      data-truncated={String(truncated)}
    >
      {content}
    </pre>
  ),
}))
vi.mock('@components/shared/file-preview/MarkdownViewer', () => ({
  MarkdownViewer: ({ content }: { content: string }) => (
    <article data-testid="markdown-viewer">{content}</article>
  ),
}))
vi.mock('@components/shared/file-preview/CsvViewer', () => ({
  CsvViewer: ({
    filePath,
    fileName,
    content,
  }: {
    filePath?: string
    fileName?: string
    content?: string
  }) => (
    <div
      data-testid="csv-viewer"
      data-file-path={filePath}
      data-file-name={fileName}
    >
      {content}
    </div>
  ),
}))

vi.mock('@components/context-space/hooks/useIsRemoteViewer', () => ({
  useIsRemoteViewer: () => ({
    isRemoteViewer: remoteState.isRemote,
    isResolving: false,
    controlDeviceName: 'Office Mac',
    controlDeviceId: remoteState.isRemote ? 'dev-B' : 'dev-A',
    workingDir: '/Users/me/space',
  }),
}))

vi.mock('@components/context-space/folder/RemoteAgentBanner', () => ({
  RemoteAgentBanner: ({
    workingDir,
  }: {
    workingDir?: string
  }) => (
    <div>
      <div>workingDir.remoteAppTitle</div>
      <div>{workingDir}</div>
    </div>
  ),
}))

vi.mock('@components/context-space/SpaceContextAreaContext', () => ({
  useSpaceContextState: () => ({
    spaceId: 'space-1',
    tabScopeKey: 'space-1',
  }),
}))

vi.mock('@/stores/useSpaceStore', () => {
  const state = {
    spaces: [{ id: 'space-1', working_dir: '/Users/me/space' }],
    selectedSpace: { id: 'space-1', working_dir: '/Users/me/space' },
  }
  const useSpaceStore = Object.assign(
    (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
    { getState: () => state },
  )
  return { useSpaceStore }
})

vi.mock('@/stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({ openResourceTab }),
  },
}))

vi.mock('@components/context-space/folder/useFolderStore', () => ({
  useFolderContextStore: {
    getState: () => ({ addSpaceFolder }),
  },
}))

function makeItem(meta: Record<string, unknown>): ContextItem {
  return {
    type: 'file',
    id: 'artifacts/demo.xlsx',
    tabKey: 'file:artifacts/demo.xlsx',
    title: 'demo.xlsx',
    meta,
  }
}

describe('TabFilesPaneRenderer', () => {
  const pathExists = vi.fn()
  const readFilePreview = vi.fn()
  const openPath = vi.fn()
  const showItemInFolder = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    remoteState.isRemote = false
    resolveOssFileDetail.mockReset()
    getAttachmentBuffer.mockReset()
    getSpaceFileDownloadUrl.mockReset()
    getOrganizationFileDownloadUrl.mockReset()
    downloadPreviewResource.mockReset()
    downloadPreviewResource.mockResolvedValue('saved')
    ;(window as unknown as { tabtin: Partial<Window['tabtin']> }).tabtin = {
      openPath,
      showItemInFolder,
      fileSystem: {
        pathExists,
        readFilePreview,
      } as Partial<Window['tabtin']['fileSystem']> as Window['tabtin']['fileSystem'],
    }
  })

  it('remote viewer shows the remote device placeholder instead of reading local preview paths', async () => {
    remoteState.isRemote = true
    pathExists.mockResolvedValue({ success: true, exists: true, isFile: true, isDirectory: false })

    render(<TabFilesPaneRenderer item={makeItem({
      artifact_kind: 'local_file',
      file_type: 'xlsx',
      relative_path: 'artifacts/demo.xlsx',
      absolute_path: '/Users/me/space/artifacts/demo.xlsx',
      working_dir: '/Users/me/space',
      filename: 'demo.xlsx',
    })} />)

    expect(screen.getByText('workingDir.remoteAppTitle')).toBeTruthy()
    expect(screen.getByText('/Users/me/space')).toBeTruthy()
    await waitFor(() => {
      expect(pathExists).not.toHaveBeenCalled()
    })
    expect(screen.queryByTestId('xlsx-viewer')).toBeNull()
  })

  it('renders xlsx local_file artifacts with the shared workbook preview', async () => {
    pathExists.mockResolvedValue({ success: true, exists: true, isFile: true, isDirectory: false })

    render(<TabFilesPaneRenderer item={makeItem({
      artifact_kind: 'local_file',
      file_type: 'xlsx',
      relative_path: 'artifacts/demo.xlsx',
      absolute_path: '/Users/me/space/artifacts/demo.xlsx',
      working_dir: '/Users/me/space',
      filename: 'demo.xlsx',
    })} />)

    expect(screen.getByText('demo.xlsx')).toBeTruthy()
    expect(screen.getByText(/card\.openFile\.format\.xlsx/)).toBeTruthy()

    const preview = await screen.findByTestId('xlsx-viewer')
    expect(preview.getAttribute('data-file-path')).toBe('/Users/me/space/artifacts/demo.xlsx')
    expect(pathExists).toHaveBeenCalledWith('/Users/me/space/artifacts/demo.xlsx')

    screen.getByText('card.openFile.openInWorkspace').click()
    expect(addSpaceFolder).toHaveBeenCalledWith('space-1', {
      rootPath: '/Users/me/space',
      kind: 'sandbox',
      title: 'context:folder.labels.agentTitle',
    })
    expect(openResourceTab).toHaveBeenCalledWith('space-1', {
      type: 'tabfolder',
      id: 'folder-agent',
      title: 'context:folder.labels.agentTitle',
      meta: {
        path: '/Users/me/space',
        kind: 'sandbox',
        reveal_path: '/Users/me/space/artifacts/demo.xlsx',
      },
    })
    screen.getByText('card.openFile.systemApp').click()
    expect(openPath).toHaveBeenCalledWith('/Users/me/space/artifacts/demo.xlsx')
    screen.getByText(/^card\.openFile\.revealIn(?:Finder|Explorer|Os)$/).click()
    expect(showItemInFolder).toHaveBeenCalledWith('/Users/me/space/artifacts/demo.xlsx')
  })

  it('renders json local_file artifacts with the shared text preview', async () => {
    pathExists.mockResolvedValue({ success: true, exists: true, isFile: true, isDirectory: false })
    readFilePreview.mockResolvedValue({
      success: true,
      data: {
        kind: 'text',
        content: '{\n  "ok": true\n}',
        size: 16,
        truncated: false,
      },
    })

    render(<TabFilesPaneRenderer item={{
      ...makeItem({
        artifact_kind: 'local_file',
        file_type: 'json',
        relative_path: 'artifacts/data.json',
        absolute_path: '/Users/me/space/artifacts/data.json',
        working_dir: '/Users/me/space',
        filename: 'data.json',
      }),
      id: 'artifacts/data.json',
      title: 'data.json',
    }} />)

    expect(screen.getByText('data.json')).toBeTruthy()
    expect(screen.getByText(/card\.openFile\.format\.json/)).toBeTruthy()

    const preview = await screen.findByTestId('text-file-editor')
    expect(preview.getAttribute('data-file-path')).toBe('/Users/me/space/artifacts/data.json')
    expect(preview.getAttribute('data-file-name')).toBe('data.json')
    expect(preview.getAttribute('data-read-only')).toBe('true')
    expect(preview.getAttribute('data-truncated')).toBe('false')
    expect(preview.textContent).toContain('"ok": true')
    expect(readFilePreview).toHaveBeenCalledWith('/Users/me/space/artifacts/data.json', { maxBytes: 512 * 1024 })
  })

  it('renders txt local_file artifacts with the shared text preview', async () => {
    pathExists.mockResolvedValue({ success: true, exists: true, isFile: true, isDirectory: false })
    readFilePreview.mockResolvedValue({
      success: true,
      data: {
        kind: 'text',
        content: 'hello from notes.txt',
        size: 20,
        truncated: false,
      },
    })

    render(<TabFilesPaneRenderer item={{
      ...makeItem({
        artifact_kind: 'local_file',
        file_type: 'txt',
        relative_path: 'artifacts/notes.txt',
        absolute_path: '/Users/me/space/artifacts/notes.txt',
        working_dir: '/Users/me/space',
        filename: 'notes.txt',
      }),
      id: 'artifacts/notes.txt',
      title: 'notes.txt',
    }} />)

    expect(screen.getByText('notes.txt')).toBeTruthy()
    expect(screen.getByText(/card\.openFile\.format\.txt/)).toBeTruthy()

    const preview = await screen.findByTestId('text-file-editor')
    expect(preview.getAttribute('data-file-path')).toBe('/Users/me/space/artifacts/notes.txt')
    expect(preview.getAttribute('data-file-name')).toBe('notes.txt')
    expect(preview.getAttribute('data-read-only')).toBe('true')
    expect(preview.textContent).toContain('hello from notes.txt')
    expect(readFilePreview).toHaveBeenCalledWith('/Users/me/space/artifacts/notes.txt', { maxBytes: 512 * 1024 })
  })

  it('passes truncated json previews through to the text preview', async () => {
    pathExists.mockResolvedValue({ success: true, exists: true, isFile: true, isDirectory: false })
    readFilePreview.mockResolvedValue({
      success: true,
      data: {
        kind: 'text',
        content: '{"large":',
        size: 800 * 1024,
        truncated: true,
      },
    })

    render(<TabFilesPaneRenderer item={{
      ...makeItem({
        artifact_kind: 'local_file',
        file_type: 'json',
        relative_path: 'artifacts/large.json',
        absolute_path: '/Users/me/space/artifacts/large.json',
        filename: 'large.json',
      }),
      id: 'artifacts/large.json',
      title: 'large.json',
    }} />)

    const preview = await screen.findByTestId('text-file-editor')
    expect(preview.getAttribute('data-truncated')).toBe('true')
  })

  it('shows a json read error when the text preview IPC fails', async () => {
    pathExists.mockResolvedValue({ success: true, exists: true, isFile: true, isDirectory: false })
    readFilePreview.mockResolvedValue({
      success: false,
      error: 'access denied',
    })

    render(<TabFilesPaneRenderer item={{
      ...makeItem({
        artifact_kind: 'local_file',
        file_type: 'json',
        relative_path: 'artifacts/private.json',
        absolute_path: '/Users/me/space/artifacts/private.json',
        filename: 'private.json',
      }),
      id: 'artifacts/private.json',
      title: 'private.json',
    }} />)

    await waitFor(() => {
      expect(screen.getByText('access denied')).toBeTruthy()
    })
    expect(screen.queryByTestId('text-file-editor')).toBeNull()
  })

  it('shows the deleted or unavailable state when the file no longer exists', async () => {
    pathExists.mockResolvedValue({ success: true, exists: false, isFile: false })

    render(<TabFilesPaneRenderer item={makeItem({
      artifact_kind: 'local_file',
      file_type: 'xlsx',
      relative_path: 'artifacts/missing.xlsx',
      absolute_path: '/Users/me/space/artifacts/missing.xlsx',
      filename: 'missing.xlsx',
    })} />)

    await waitFor(() => {
      expect(screen.getByText('card.openFile.unavailable')).toBeTruthy()
    })
    expect(screen.queryByTestId('xlsx-viewer')).toBeNull()
  })

  it('renders docx and pdf local_file artifacts with the shared preview', async () => {
    pathExists.mockResolvedValue({ success: true, exists: true, isFile: true, isDirectory: false })

    render(<TabFilesPaneRenderer item={{
      ...makeItem({
        artifact_kind: 'local_file',
        file_type: 'docx',
        relative_path: 'artifacts/demo.docx',
        absolute_path: '/Users/me/space/artifacts/demo.docx',
        working_dir: '/Users/me/space',
        filename: 'demo.docx',
      }),
      id: 'artifacts/demo.docx',
      title: 'demo.docx',
    }} />)

    expect(screen.getByText('demo.docx')).toBeTruthy()
    expect(screen.getByText(/card\.openFile\.format\.docx/)).toBeTruthy()
    const docxPreview = await screen.findByTestId('docx-viewer')
    expect(docxPreview.getAttribute('data-file-path')).toBe('/Users/me/space/artifacts/demo.docx')
  })

  it('renders pptx local_file artifacts with the shared preview', async () => {
    pathExists.mockResolvedValue({ success: true, exists: true, isFile: true, isDirectory: false })

    render(<TabFilesPaneRenderer item={{
      ...makeItem({
        artifact_kind: 'local_file',
        file_type: 'pptx',
        relative_path: 'artifacts/deck.pptx',
        absolute_path: '/Users/me/space/artifacts/deck.pptx',
        working_dir: '/Users/me/space',
        filename: 'deck.pptx',
      }),
      id: 'artifacts/deck.pptx',
      title: 'deck.pptx',
    }} />)

    expect(screen.getByText('deck.pptx')).toBeTruthy()
    expect(screen.getByText(/card\.openFile\.format\.pptx/)).toBeTruthy()
    const pptxPreview = await screen.findByTestId('pptx-viewer')
    expect(pptxPreview.getAttribute('data-file-path')).toBe('/Users/me/space/artifacts/deck.pptx')
  })

  it('renders csv local_file artifacts with the shared table preview', async () => {
    pathExists.mockResolvedValue({ success: true, exists: true, isFile: true, isDirectory: false })

    render(<TabFilesPaneRenderer item={{
      ...makeItem({
        artifact_kind: 'local_file',
        file_type: 'csv',
        relative_path: 'artifacts/demo.csv',
        absolute_path: '/Users/me/space/artifacts/demo.csv',
        filename: 'demo.csv',
      }),
      id: 'artifacts/demo.csv',
      title: 'demo.csv',
    }} />)

    expect(screen.getByText('demo.csv')).toBeTruthy()
    expect(screen.getByText(/card\.openFile\.format\.csv/)).toBeTruthy()
    const csvPreview = await screen.findByTestId('csv-viewer')
    expect(csvPreview.getAttribute('data-file-path')).toBe('/Users/me/space/artifacts/demo.csv')
    expect(pathExists).toHaveBeenCalledWith('/Users/me/space/artifacts/demo.csv')
  })

  it('renders audio local_file artifacts with the native audio preview ', async () => {
    pathExists.mockResolvedValue({ success: true, exists: true, isFile: true, isDirectory: false })

    const { container } = render(<TabFilesPaneRenderer item={{
      ...makeItem({
        artifact_kind: 'local_file',
        file_type: 'audio',
        relative_path: 'artifacts/clip.m4a',
        absolute_path: '/Users/me/space/artifacts/clip.m4a',
        working_dir: '/Users/me/space',
        filename: 'clip.m4a',
      }),
      id: 'artifacts/clip.m4a',
      title: 'clip.m4a',
    }} />)

    expect(screen.getByText('clip.m4a')).toBeTruthy()
    expect(screen.getByText(/card\.openFile\.format\.audio/)).toBeTruthy()
    await waitFor(() => {
      const audio = container.querySelector('audio')
      expect(audio).toBeTruthy()
      expect(audio?.getAttribute('src')).toContain('clip.m4a')
    })
  })

  it('renders yaml local_file artifacts with the shared text preview ', async () => {
    pathExists.mockResolvedValue({ success: true, exists: true, isFile: true, isDirectory: false })
    readFilePreview.mockResolvedValue({
      success: true,
      data: {
        kind: 'text',
        content: 'name: demo\n',
        size: 11,
        truncated: false,
      },
    })

    render(<TabFilesPaneRenderer item={{
      ...makeItem({
        artifact_kind: 'local_file',
        file_type: 'text',
        relative_path: 'artifacts/config.yaml',
        absolute_path: '/Users/me/space/artifacts/config.yaml',
        working_dir: '/Users/me/space',
        filename: 'config.yaml',
      }),
      id: 'artifacts/config.yaml',
      title: 'config.yaml',
    }} />)

    expect(screen.getByText('config.yaml')).toBeTruthy()
    expect(screen.getByText(/card\.openFile\.format\.text/)).toBeTruthy()
    const preview = await screen.findByTestId('text-file-editor')
    expect(preview.textContent).toContain('name: demo')
  })

  it('空 meta 的 FileRecord UUID 自愈查 OSS 并预览 mp4', async () => {
    const accessUrl = 'http://127.0.0.1:6060/api/services/oss/local-object?object_key=chat%2Fattachments%2Fx.mp4'
    resolveOssFileDetail.mockResolvedValue({
      fileId: '084aa15a-d224-4764-9c2f-f45c92026f05',
      fileName: '1fe4450ed80dee0fd9b54c4110ff41.mp4',
      url: accessUrl,
      mimeType: 'video/mp4',
      fileType: 'video',
    })

    render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      tabKey: 'file:084aa15a-d224-4764-9c2f-f45c92026f05',
      title: '084aa15a-d224-4764-9c2f-f45c92026f05',
      meta: {},
    }} />)

    const video = await screen.findByTestId('oss-video-preview')
    expect(video.getAttribute('src')).toBe(accessUrl)
    expect(screen.getByText('1fe4450ed80dee0fd9b54c4110ff41.mp4')).toBeTruthy()
    expect(screen.getByText(/card\.openFile\.format\.video/)).toBeTruthy()
    expect(pathExists).not.toHaveBeenCalled()
    expect(screen.queryByText(/card\.openFile\.unsupportedPreview/)).toBeNull()
  })

  it.each([
    ['xlsx', 'report.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx-viewer'],
    ['xlsx', 'legacy.xls', 'application/vnd.ms-excel', 'xlsx-viewer'],
    ['docx', 'report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx-viewer'],
    ['pptx', 'deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx-viewer'],
    ['pdf', 'report.pdf', 'application/pdf', 'pdf-viewer'],
  ])('空 meta 的云端 %s 通过共享只读 viewer 预览二进制', async (
    fileType,
    fileName,
    mimeType,
    viewerTestId,
  ) => {
    const accessUrl = `https://oss.example.test/${fileName}?signature=secret`
    resolveOssFileDetail.mockResolvedValue({
      fileId: '084aa15a-d224-4764-9c2f-f45c92026f05',
      fileName,
      url: accessUrl,
      mimeType,
      fileType,
    })
    getAttachmentBuffer.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer)

    render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      tabKey: 'file:084aa15a-d224-4764-9c2f-f45c92026f05',
      title: fileName,
      meta: {},
    }} />)

    const preview = await screen.findByTestId(viewerTestId)
    expect(preview.getAttribute('data-byte-length')).toBe('3')
    expect(getAttachmentBuffer).toHaveBeenCalledWith(expect.objectContaining({
      fileId: '084aa15a-d224-4764-9c2f-f45c92026f05',
      url: accessUrl,
      signal: expect.any(AbortSignal),
    }))
    expect(screen.getByTestId('oss-file-download')).toBeTruthy()
    expect(pathExists).not.toHaveBeenCalled()
  })

  it('云端 Office 二进制获取失败时保留打开下载兜底', async () => {
    const accessUrl = 'https://oss.example.test/report.xlsx?signature=secret'
    resolveOssFileDetail.mockResolvedValue({
      fileId: '084aa15a-d224-4764-9c2f-f45c92026f05',
      fileName: 'report.xlsx',
      url: accessUrl,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileType: 'xlsx',
    })
    getAttachmentBuffer.mockRejectedValue(new Error('network failed'))

    render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      tabKey: 'file:084aa15a-d224-4764-9c2f-f45c92026f05',
      title: 'report.xlsx',
      meta: {},
    }} />)

    expect(await screen.findByTestId('oss-binary-preview-error')).toBeTruthy()
    fireEvent.click(screen.getByTestId('oss-file-download'))
    await waitFor(() => {
      expect(downloadPreviewResource).toHaveBeenCalledWith(expect.objectContaining({
        url: accessUrl,
        fileName: 'report.xlsx',
      }))
    })
    expect(screen.queryByTestId('xlsx-viewer')).toBeNull()
  })

  it('artifact_kind=oss_file 直接用 access_url 预览，不查盘', async () => {
    const accessUrl = 'http://127.0.0.1:6060/oss/demo.mp4'
    render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      tabKey: 'file:084aa15a-d224-4764-9c2f-f45c92026f05',
      title: 'demo.mp4',
      meta: {
        artifact_kind: 'oss_file',
        file_type: 'video',
        filename: 'demo.mp4',
        mime_type: 'video/mp4',
        access_url: accessUrl,
        source: 'oss_file_record',
      },
    }} />)

    const video = await screen.findByTestId('oss-video-preview')
    expect(video.getAttribute('src')).toBe(accessUrl)
    expect(video.getAttribute('controlsList')).toBe('nodownload')
    expect(screen.getByTestId('oss-file-download')).toBeTruthy()
    fireEvent.click(screen.getByTestId('oss-file-download'))
    await waitFor(() => {
      expect(downloadPreviewResource).toHaveBeenCalledWith(expect.objectContaining({
        url: accessUrl,
        fileName: 'demo.mp4',
      }))
    })
    expect(resolveOssFileDetail).not.toHaveBeenCalled()
    expect(pathExists).not.toHaveBeenCalled()
  })

  it('已补全 access_url 的云端 DOCX 使用后端 file_name 进入共享 viewer', async () => {
    const accessUrl = 'https://oss.example.test/report.docx?signature=secret'
    getAttachmentBuffer.mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer)

    render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: 'context-item-1',
      tabKey: 'file:context-item-1',
      title: 'fallback-title',
      meta: {
        artifact_kind: 'oss_file',
        file_id: '084aa15a-d224-4764-9c2f-f45c92026f05',
        file_type: 'docx',
        file_name: 'report.docx',
        mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        access_url: accessUrl,
        source: 'oss_file_record',
      },
    }} />)

    const preview = await screen.findByTestId('docx-viewer')
    expect(preview.getAttribute('data-byte-length')).toBe('4')
    expect(screen.getByText('report.docx')).toBeTruthy()
    expect(getAttachmentBuffer).toHaveBeenCalledWith(expect.objectContaining({
      fileId: '084aa15a-d224-4764-9c2f-f45c92026f05',
      url: accessUrl,
      signal: expect.any(AbortSignal),
    }))
    expect(resolveOssFileDetail).not.toHaveBeenCalled()
    expect(pathExists).not.toHaveBeenCalled()
  })

  it('云盘 ContextItem 通过 Space 鉴权 URL 进入共享 DOCX viewer', async () => {
    const accessUrl = 'https://tabtin-assets.oss-cn-shanghai.aliyuncs.com/report.docx?signature=secret'
    getSpaceFileDownloadUrl.mockResolvedValue({
      url: accessUrl,
      file_name: 'report.docx',
      mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    getAttachmentBuffer.mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer)

    render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      tabKey: 'file:084aa15a-d224-4764-9c2f-f45c92026f05',
      title: 'report.docx',
      meta: {
        context_item_id: 'context-item-1',
        spaceId: 'space-1',
        file_host_space_id: 'space-1',
        file_name: 'report.docx',
        file_type: 'docx',
      },
    }} />)

    const preview = await screen.findByTestId('docx-viewer')
    expect(preview.getAttribute('data-byte-length')).toBe('4')
    expect(getSpaceFileDownloadUrl).toHaveBeenCalledWith(
      'space-1',
      'context-item-1',
      { previewMaxBytes: MAX_OFFICE_FILE_BYTES },
    )
    expect(getAttachmentBuffer).toHaveBeenCalledWith(expect.objectContaining({
      fileId: '084aa15a-d224-4764-9c2f-f45c92026f05',
      url: accessUrl,
      resolveFreshUrl: expect.any(Function),
    }))
    const resolveFreshUrl = getAttachmentBuffer.mock.calls[0]?.[0]?.resolveFreshUrl as
      | (() => Promise<string>)
      | undefined
    expect(await resolveFreshUrl?.()).toBe(accessUrl)
    expect(getSpaceFileDownloadUrl).toHaveBeenCalledTimes(2)
    expect(resolveOssFileDetail).not.toHaveBeenCalled()
  })

  it('org-only 云盘 CSV走 Organization 换链预览，不误用浏览面 Space', async () => {
    const accessUrl = 'https://assets.example.com/tabfiles/uploads/demo.csv?signature=secret'
    const csvBody = 'title,company\nA,B\n'
    getOrganizationFileDownloadUrl.mockResolvedValue({
      url: accessUrl,
      file_name: '36氪融资动态.csv',
      mime_type: 'text/csv',
      file_size: csvBody.length,
      preview_eligible: true,
    })
    getAttachmentBuffer.mockResolvedValue(new TextEncoder().encode(csvBody).buffer)

    render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: '086ba4f7-d9b0-4dc5-ae42-39acf86fa0bf',
      tabKey: 'file:086ba4f7-d9b0-4dc5-ae42-39acf86fa0bf',
      title: '36氪融资动态.csv',
      meta: {
        context_item_id: '23035a82-0396-4f65-ac77-9eeebe5a3b19',
        // 浏览面 Space ≠ 资源宿主；org-only 不应带 file_host_space_id
        spaceId: 'space-1',
        organizationId: 'dbc86b3c-5840-4494-83c1-4877a64d96b8',
        file_name: '36氪融资动态.csv',
        // 后端 FileRecord.file_type 对 csv 是 other，靠扩展名命中 CsvViewer
        file_type: 'other',
      },
    }} />)

    const preview = await screen.findByTestId('csv-viewer')
    expect(preview.getAttribute('data-file-name')).toBe('36氪融资动态.csv')
    expect(preview.textContent).toContain('title,company')
    expect(getOrganizationFileDownloadUrl).toHaveBeenCalledWith(
      'dbc86b3c-5840-4494-83c1-4877a64d96b8',
      '23035a82-0396-4f65-ac77-9eeebe5a3b19',
      { previewMaxBytes: LOCAL_TEXT_PREVIEW_BYTES },
    )
    expect(getSpaceFileDownloadUrl).not.toHaveBeenCalled()
    expect(getAttachmentBuffer).toHaveBeenCalledWith(expect.objectContaining({
      fileId: '086ba4f7-d9b0-4dc5-ae42-39acf86fa0bf',
      url: accessUrl,
      resolveFreshUrl: expect.any(Function),
    }))
  })

  it('Space 换链失败时只请求一次并展示加载失败', async () => {
    getSpaceFileDownloadUrl.mockRejectedValue(new Error('temporary auth failure'))

    render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      tabKey: 'file:084aa15a-d224-4764-9c2f-f45c92026f05',
      title: 'report.docx',
      meta: {
        context_item_id: 'context-item-load-failed',
        spaceId: 'space-1',
        file_name: 'report.docx',
        file_type: 'docx',
      },
    }} />)

    expect(await screen.findByText('card.openFile.loadFailed')).toBeTruthy()
    expect(getSpaceFileDownloadUrl).toHaveBeenCalledTimes(1)
    expect(getAttachmentBuffer).not.toHaveBeenCalled()
  })

  it('Space 换链返回 404 时才展示文件不存在且不重试', async () => {
    getSpaceFileDownloadUrl.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }))

    render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      tabKey: 'file:084aa15a-d224-4764-9c2f-f45c92026f05',
      title: 'missing.docx',
      meta: {
        context_item_id: 'context-item-missing',
        spaceId: 'space-1',
        file_name: 'missing.docx',
        file_type: 'docx',
      },
    }} />)

    expect(await screen.findByText('card.openFile.unavailable')).toBeTruthy()
    expect(getSpaceFileDownloadUrl).toHaveBeenCalledTimes(1)
  })

  it('Space 换链返回 403 时展示权限不足且不重试', async () => {
    getSpaceFileDownloadUrl.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }))

    render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      tabKey: 'file:084aa15a-d224-4764-9c2f-f45c92026f05',
      title: 'private.docx',
      meta: {
        context_item_id: 'context-item-private',
        spaceId: 'space-1',
        file_name: 'private.docx',
        file_type: 'docx',
      },
    }} />)

    expect(await screen.findByText('card.openFile.accessDenied')).toBeTruthy()
    expect(getSpaceFileDownloadUrl).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('card.openFile.unavailable')).toBeNull()
  })

  it('系统拒绝打开重新鉴权 URL 时显示可重试错误', async () => {
    getSpaceFileDownloadUrl.mockResolvedValue({
      url: 'https://tabtin-assets.oss-cn-shanghai.aliyuncs.com/archive.zip?signature=fresh',
      file_name: 'archive.zip',
      mime_type: 'application/zip',
      file_size: 1024,
    })
    downloadPreviewResource.mockResolvedValue('failed')

    render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      tabKey: 'file:084aa15a-d224-4764-9c2f-f45c92026f05',
      title: 'archive.zip',
      meta: {
        context_item_id: 'context-item-open-failure',
        spaceId: 'space-1',
        file_name: 'archive.zip',
      },
    }} />)

    fireEvent.click(await screen.findByTestId('oss-file-download'))
    expect(await screen.findByText('card.openFile.downloadFailed')).toBeTruthy()
    expect(getSpaceFileDownloadUrl).toHaveBeenCalledTimes(2)
  })

  it('云盘不支持预览的格式保留打开下载兜底', async () => {
    const accessUrl = 'https://tabtin-assets.oss-cn-shanghai.aliyuncs.com/archive.zip?signature=secret'
    getSpaceFileDownloadUrl.mockResolvedValue({
      url: accessUrl,
      file_name: 'archive.zip',
      mime_type: 'application/zip',
    })

    render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      tabKey: 'file:084aa15a-d224-4764-9c2f-f45c92026f05',
      title: 'archive.zip',
      meta: {
        context_item_id: 'context-item-1',
        spaceId: 'space-1',
        file_name: 'archive.zip',
      },
    }} />)

    const download = await screen.findByTestId('oss-file-download')
    fireEvent.click(download)
    await waitFor(() => {
      expect(getSpaceFileDownloadUrl).toHaveBeenCalledTimes(2)
      expect(downloadPreviewResource).toHaveBeenCalledWith(expect.objectContaining({
        url: accessUrl,
        fileName: 'archive.zip',
      }))
    })
    expect(getAttachmentBuffer).not.toHaveBeenCalled()
    expect(screen.queryByTestId('oss-binary-preview-error')).toBeNull()
    expect(screen.getByText('card.openFile.unsupportedRemotePreview')).toBeTruthy()
  })

  it('50–100MB Office 文件下载前直接进入重新鉴权兜底', async () => {
    const accessUrl = 'https://tabtin-assets.oss-cn-shanghai.aliyuncs.com/report.xlsx?signature=secret'
    getSpaceFileDownloadUrl
      .mockResolvedValueOnce({
        url: '',
        file_name: 'report.xlsx',
        mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        file_size: 60 * 1024 * 1024,
        preview_eligible: false,
      })
      .mockResolvedValueOnce({
        url: accessUrl,
        file_name: 'report.xlsx',
        mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        file_size: 60 * 1024 * 1024,
      })

    render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      tabKey: 'file:084aa15a-d224-4764-9c2f-f45c92026f05',
      title: 'report.xlsx',
      meta: {
        context_item_id: 'context-item-large-xlsx',
        spaceId: 'space-1',
        file_name: 'report.xlsx',
        file_type: 'xlsx',
      },
    }} />)

    expect(await screen.findByText('card.openFile.previewTooLarge')).toBeTruthy()
    expect(screen.queryByTestId('xlsx-viewer')).toBeNull()
    expect(getAttachmentBuffer).not.toHaveBeenCalled()
    expect(getSpaceFileDownloadUrl).toHaveBeenNthCalledWith(
      1,
      'space-1',
      'context-item-large-xlsx',
      { previewMaxBytes: MAX_OFFICE_FILE_BYTES },
    )
    fireEvent.click(screen.getByTestId('oss-file-download'))
    await waitFor(() => {
      expect(getSpaceFileDownloadUrl).toHaveBeenCalledTimes(2)
      expect(downloadPreviewResource).toHaveBeenCalledWith(expect.objectContaining({
        url: accessUrl,
        fileName: 'report.xlsx',
      }))
    })
  })

  it('PDF 按实际 100MB 下载通道上限继续进入共享 viewer', async () => {
    const accessUrl = 'https://tabtin-assets.oss-cn-shanghai.aliyuncs.com/report.pdf?signature=secret'
    getSpaceFileDownloadUrl.mockResolvedValue({
      url: accessUrl,
      file_name: 'report.pdf',
      mime_type: 'application/pdf',
      file_size: 60 * 1024 * 1024,
    })
    getAttachmentBuffer.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer)

    render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      tabKey: 'file:084aa15a-d224-4764-9c2f-f45c92026f05',
      title: 'report.pdf',
      meta: {
        context_item_id: 'context-item-pdf',
        spaceId: 'space-1',
        file_name: 'report.pdf',
        file_type: 'pdf',
      },
    }} />)

    expect(await screen.findByTestId('pdf-viewer')).toBeTruthy()
    expect(getAttachmentBuffer).toHaveBeenCalledTimes(1)
    expect(getSpaceFileDownloadUrl).toHaveBeenCalledWith(
      'space-1',
      'context-item-pdf',
      { previewMaxBytes: OSS_PRESIGNED_DOWNLOAD_MAX_BYTES },
    )
    expect(screen.queryByText('card.openFile.previewTooLarge')).toBeNull()
  })

  it('云盘 .mark 即使后端只标记为普通文件也复用 MarkdownViewer', async () => {
    getSpaceFileDownloadUrl.mockResolvedValue({
      url: 'https://tabtin-assets.oss-cn-shanghai.aliyuncs.com/readme.mark?signature=secret',
      file_name: 'readme.mark',
      mime_type: 'text/markdown',
      file_size: 64,
      preview_eligible: true,
    })
    getAttachmentBuffer.mockResolvedValue(
      new TextEncoder().encode('---\ntitle: Plan\n---\n# Cloud Markdown').buffer,
    )

    render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      tabKey: 'file:084aa15a-d224-4764-9c2f-f45c92026f05',
      title: 'readme.mark',
      meta: {
        context_item_id: 'context-item-md',
        spaceId: 'space-1',
        file_name: 'readme.mark',
        file_type: 'other',
      },
    }} />)

    const preview = await screen.findByTestId('markdown-viewer')
    expect(preview.textContent).toBe('# Cloud Markdown')
    expect(screen.getByText(/card\.openFile\.format\.file/)).toBeTruthy()
    expect(screen.queryByText(/card\.openFile\.format\.markdown/)).toBeNull()
    expect(screen.getByTestId('oss-file-download')).toBeTruthy()
  })

  it('后端因 MIME 拒绝 Markdown 预览时不误报为文件过大', async () => {
    getSpaceFileDownloadUrl.mockResolvedValue({
      url: '',
      file_name: 'readme.md',
      mime_type: 'application/octet-stream',
      file_size: 345,
      preview_eligible: false,
      mime_preview_safe: false,
    })

    render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      tabKey: 'file:084aa15a-d224-4764-9c2f-f45c92026f05',
      title: 'readme.md',
      meta: {
        context_item_id: 'context-item-unsafe-mime',
        spaceId: 'space-1',
        file_name: 'readme.md',
        file_type: 'md',
      },
    }} />)

    expect(await screen.findByText('card.openFile.unsupportedRemotePreview')).toBeTruthy()
    expect(screen.queryByText('card.openFile.previewTooLarge')).toBeNull()
    expect(getAttachmentBuffer).not.toHaveBeenCalled()
    expect(screen.getByTestId('oss-file-download')).toBeTruthy()
  })

  it('云盘无扩展名 Makefile 按共享文件名契约进入只读文本预览', async () => {
    getSpaceFileDownloadUrl.mockResolvedValue({
      url: 'https://tabtin-assets.oss-cn-shanghai.aliyuncs.com/Makefile?signature=secret',
      file_name: 'Makefile',
      mime_type: 'text/plain',
      file_size: 12,
      preview_eligible: true,
    })
    getAttachmentBuffer.mockResolvedValue(new TextEncoder().encode('build:\n\techo ok').buffer)

    render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      tabKey: 'file:084aa15a-d224-4764-9c2f-f45c92026f05',
      title: 'Makefile',
      meta: {
        context_item_id: 'context-item-makefile',
        spaceId: 'space-1',
        file_name: 'Makefile',
      },
    }} />)

    const preview = await screen.findByTestId('text-file-editor')
    expect(preview.getAttribute('data-read-only')).toBe('true')
    expect(getSpaceFileDownloadUrl).toHaveBeenCalledWith(
      'space-1',
      'context-item-makefile',
      { previewMaxBytes: LOCAL_TEXT_PREVIEW_BYTES },
    )
  })

  it.each([
    ['notes.txt', 'txt', 'plain text'],
    ['config.json', 'json', '{"enabled":true}'],
    ['safe.html', 'text', '<script>alert("never execute")</script>'],
  ])('云盘文本 %s 复用只读 TextFileEditor', async (fileName, fileType, content) => {
    getSpaceFileDownloadUrl.mockResolvedValue({
      url: `https://tabtin-assets.oss-cn-shanghai.aliyuncs.com/${fileName}?signature=secret`,
      file_name: fileName,
      mime_type: 'text/plain',
      file_size: content.length,
      preview_eligible: true,
    })
    getAttachmentBuffer.mockResolvedValue(new TextEncoder().encode(content).buffer)

    render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      tabKey: 'file:084aa15a-d224-4764-9c2f-f45c92026f05',
      title: fileName,
      meta: {
        context_item_id: `context-item-${fileType}`,
        spaceId: 'space-1',
        file_name: fileName,
        file_type: fileType,
      },
    }} />)

    const preview = await screen.findByTestId('text-file-editor')
    expect(preview.textContent).toBe(content)
    expect(preview.getAttribute('data-read-only')).toBe('true')
    expect(screen.getByTestId('oss-file-download')).toBeTruthy()
  })

  it.each([
    [LOCAL_TEXT_PREVIEW_BYTES, true],
    [LOCAL_TEXT_PREVIEW_BYTES + 1, false],
  ])('云盘文本在 %s 字节时下载前 eligibility=%s', async (fileSize, eligible) => {
    const freshUrl = 'https://tabtin-assets.oss-cn-shanghai.aliyuncs.com/boundary.txt?signature=fresh'
    getSpaceFileDownloadUrl
      .mockResolvedValueOnce({
        url: eligible ? freshUrl : '',
        file_name: 'boundary.txt',
        mime_type: 'text/plain',
        file_size: fileSize,
        preview_eligible: eligible,
      })
      .mockResolvedValueOnce({
        url: freshUrl,
        file_name: 'boundary.txt',
        mime_type: 'text/plain',
        file_size: fileSize,
      })
    getAttachmentBuffer.mockResolvedValue(new TextEncoder().encode('boundary').buffer)

    render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      tabKey: 'file:084aa15a-d224-4764-9c2f-f45c92026f05',
      title: 'boundary.txt',
      meta: {
        context_item_id: 'context-item-text-boundary',
        spaceId: 'space-1',
        file_name: 'boundary.txt',
        file_type: 'txt',
      },
    }} />)

    expect(getSpaceFileDownloadUrl).toHaveBeenNthCalledWith(
      1,
      'space-1',
      'context-item-text-boundary',
      { previewMaxBytes: LOCAL_TEXT_PREVIEW_BYTES },
    )
    if (eligible) {
      expect(await screen.findByTestId('text-file-editor')).toBeTruthy()
      expect(getAttachmentBuffer).toHaveBeenCalledTimes(1)
      return
    }

    expect(await screen.findByText('card.openFile.previewTooLarge')).toBeTruthy()
    expect(getAttachmentBuffer).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('oss-file-download'))
    await waitFor(() => {
      expect(getSpaceFileDownloadUrl).toHaveBeenNthCalledWith(
        2,
        'space-1',
        'context-item-text-boundary',
      )
      expect(downloadPreviewResource).toHaveBeenCalledWith(expect.objectContaining({
        url: freshUrl,
        fileName: 'boundary.txt',
      }))
    })
  })

  it('非法 UTF-8 文本拒绝替换字符并保留重新鉴权下载', async () => {
    getSpaceFileDownloadUrl.mockResolvedValue({
      url: 'https://tabtin-assets.oss-cn-shanghai.aliyuncs.com/invalid.txt?signature=secret',
      file_name: 'invalid.txt',
      mime_type: 'text/plain',
      file_size: 2,
      preview_eligible: true,
    })
    getAttachmentBuffer.mockResolvedValue(new Uint8Array([0xc3, 0x28]).buffer)

    render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      tabKey: 'file:084aa15a-d224-4764-9c2f-f45c92026f05',
      title: 'invalid.txt',
      meta: {
        context_item_id: 'context-item-invalid-text',
        spaceId: 'space-1',
        file_name: 'invalid.txt',
        file_type: 'txt',
      },
    }} />)

    expect(await screen.findByTestId('oss-binary-preview-error')).toBeTruthy()
    expect(screen.queryByTestId('text-file-editor')).toBeNull()
    expect(screen.getByTestId('oss-file-download')).toBeTruthy()
  })

  it.each([
    ['data.csv', 'a,b\n1,2'],
    ['data.tsv', 'a\tb\n1\t2'],
  ])('云盘表格文本 %s 复用 CsvViewer', async (fileName, content) => {
    getSpaceFileDownloadUrl.mockResolvedValue({
      url: `https://tabtin-assets.oss-cn-shanghai.aliyuncs.com/${fileName}?signature=secret`,
      file_name: fileName,
      mime_type: 'text/csv',
      file_size: content.length,
      preview_eligible: true,
    })
    getAttachmentBuffer.mockResolvedValue(new TextEncoder().encode(content).buffer)

    render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      tabKey: 'file:084aa15a-d224-4764-9c2f-f45c92026f05',
      title: fileName,
      meta: {
        context_item_id: 'context-item-csv',
        spaceId: 'space-1',
        file_name: fileName,
        file_type: 'csv',
      },
    }} />)

    const preview = await screen.findByTestId('csv-viewer')
    expect(preview.textContent).toBe(content)
    expect(preview.getAttribute('data-file-name')).toBe(fileName)
    expect(screen.getByTestId('oss-file-download')).toBeTruthy()
  })

  it.each([
    [OSS_PRESIGNED_DOWNLOAD_MAX_BYTES, true],
    [OSS_PRESIGNED_DOWNLOAD_MAX_BYTES + 1, false],
  ])('PDF 在 %s 字节时下载前 eligibility=%s', async (fileSize, eligible) => {
    const accessUrl = 'https://tabtin-assets.oss-cn-shanghai.aliyuncs.com/boundary.pdf?signature=fresh'
    getSpaceFileDownloadUrl
      .mockResolvedValueOnce({
        url: eligible ? accessUrl : '',
        file_name: 'boundary.pdf',
        mime_type: 'application/pdf',
        file_size: fileSize,
        preview_eligible: eligible,
      })
      .mockResolvedValueOnce({
        url: accessUrl,
        file_name: 'boundary.pdf',
        mime_type: 'application/pdf',
        file_size: fileSize,
      })
    getAttachmentBuffer.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer)

    render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      tabKey: 'file:084aa15a-d224-4764-9c2f-f45c92026f05',
      title: 'boundary.pdf',
      meta: {
        context_item_id: 'context-item-pdf-boundary',
        spaceId: 'space-1',
        file_name: 'boundary.pdf',
        file_type: 'pdf',
      },
    }} />)

    expect(getSpaceFileDownloadUrl).toHaveBeenCalledWith(
      'space-1',
      'context-item-pdf-boundary',
      { previewMaxBytes: OSS_PRESIGNED_DOWNLOAD_MAX_BYTES },
    )
    if (eligible) {
      expect(await screen.findByTestId('pdf-viewer')).toBeTruthy()
      expect(getAttachmentBuffer).toHaveBeenCalledTimes(1)
      return
    }

    expect(await screen.findByText('card.openFile.previewTooLarge')).toBeTruthy()
    expect(getAttachmentBuffer).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('oss-file-download'))
    await waitFor(() => {
      expect(getSpaceFileDownloadUrl).toHaveBeenNthCalledWith(
        2,
        'space-1',
        'context-item-pdf-boundary',
      )
      expect(downloadPreviewResource).toHaveBeenCalledWith(expect.objectContaining({
        url: accessUrl,
        fileName: 'boundary.pdf',
      }))
    })
  })

  it('卸载远端 viewer 时中止正在进行的二进制下载', async () => {
    const accessUrl = 'https://tabtin-assets.oss-cn-shanghai.aliyuncs.com/report.docx?signature=secret'
    getSpaceFileDownloadUrl.mockResolvedValue({
      url: accessUrl,
      file_name: 'report.docx',
      mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      file_size: 1024,
    })
    getAttachmentBuffer.mockReturnValue(new Promise(() => {}))

    const { unmount } = render(<TabFilesPaneRenderer item={{
      type: 'file',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      tabKey: 'file:084aa15a-d224-4764-9c2f-f45c92026f05',
      title: 'report.docx',
      meta: {
        context_item_id: 'context-item-cancel',
        spaceId: 'space-1',
        file_name: 'report.docx',
        file_type: 'docx',
      },
    }} />)

    await waitFor(() => expect(getAttachmentBuffer).toHaveBeenCalledTimes(1))
    const signal = getAttachmentBuffer.mock.calls[0]?.[0]?.signal as AbortSignal
    expect(signal.aborted).toBe(false)
    unmount()
    expect(signal.aborted).toBe(true)
  })
})
