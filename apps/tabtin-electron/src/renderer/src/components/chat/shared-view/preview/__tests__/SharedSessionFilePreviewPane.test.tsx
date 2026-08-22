import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sharedFilePreview = vi.fn()
const fetchPreview = vi.fn()
const loadSessionShare = vi.fn()
const denySessionShareAccess = vi.fn()
const imStoreState = {
  sessionShares: {} as Record<string, {
    detail: { id: string; status: 'active' | 'revoked' } | null
    accessDenied: boolean
  }>,
  sessionShareDetailVersions: {} as Record<string, number>,
  loadSessionShare,
  denySessionShareAccess,
}
const translate = vi.hoisted(() => (
  (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key
))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translate,
  }),
}))

vi.mock('@/services/sessionShareApi', () => ({
  ShareApiError: class ShareApiError extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  },
  sharedFilePreview: (...args: unknown[]) => sharedFilePreview(...args),
}))

vi.mock('@/stores/useIMStore', () => ({
  useIMStore: Object.assign(
    (selector: (state: typeof imStoreState) => unknown) => selector(imStoreState),
    { getState: () => imStoreState },
  ),
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@components/shared/file-preview/PdfViewer', () => ({
  PdfViewer: ({ data, filename }: { data: ArrayBuffer; filename: string }) => (
    <div data-testid="pdf-viewer" data-byte-length={data.byteLength} data-filename={filename} />
  ),
}))

import { SharedSessionFilePreviewPane } from '../SharedSessionFilePreviewPane'

describe('SharedSessionFilePreviewPane ', () => {
  beforeEach(() => {
    sharedFilePreview.mockReset()
    fetchPreview.mockReset()
    loadSessionShare.mockReset()
    denySessionShareAccess.mockReset()
    imStoreState.sessionShares = {
      'share-1': {
        detail: { id: 'share-1', status: 'active' },
        accessDenied: false,
      },
    }
    imStoreState.sessionShareDetailVersions = {}
    vi.stubGlobal('fetch', fetchPreview)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('loads an inline text preview through the shared-session permission endpoint', async () => {
    sharedFilePreview.mockResolvedValue({
      filename: 'notes.txt',
      size_bytes: 12,
      preview_kind: 'text',
      transport: {
        mode: 'inline',
        data: { kind: 'text', content: 'hello from shared file', truncated: false },
      },
    })

    render(<SharedSessionFilePreviewPane target={{
      sessionId: 'shared-session-1',
      shareId: 'share-1',
      relativePath: 'artifacts/notes.txt',
      title: 'notes.txt',
    }} />)

    expect(await screen.findByText('hello from shared file')).toBeTruthy()
    expect(sharedFilePreview).toHaveBeenCalledWith(
      'shared-session-1',
      'artifacts/notes.txt',
      'share-1',
    )
    const pane = screen.getByTestId('shared-session-file-preview-pane')
    expect(pane).toBeTruthy()
    // ：absolute 宿主下必须有 h-full，否则 PDF/Office/Xlsx 滚轮失效
    expect(pane.className).toContain('h-full')
    expect(pane.className).toContain('w-full')
  })

  it('keeps permission failures inside the file tab', async () => {
    sharedFilePreview.mockRejectedValue(new Error('无权预览该文件'))

    render(<SharedSessionFilePreviewPane target={{
      sessionId: 'shared-session-1',
      shareId: 'share-1',
      relativePath: 'artifacts/private.txt',
    }} />)

    expect(await screen.findByText('无权预览该文件')).toBeTruthy()
  })

  it('403/404 后保持拒绝态，不立即重载 active 授权形成预览循环', async () => {
    const { ShareApiError } = await import('@/services/sessionShareApi')
    sharedFilePreview.mockRejectedValue(new ShareApiError('会话不存在', 404))

    render(<SharedSessionFilePreviewPane target={{
      sessionId: 'missing-session',
      shareId: 'share-1',
      relativePath: 'artifacts/missing.txt',
    }} />)

    expect(await screen.findByText('会话不存在')).toBeTruthy()
    expect(denySessionShareAccess).toHaveBeenCalledTimes(1)
    expect(loadSessionShare).toHaveBeenCalledTimes(1)
    expect(sharedFilePreview).toHaveBeenCalledTimes(1)
  })

  it('hides an already loaded preview as soon as the exact share is revoked', async () => {
    sharedFilePreview.mockResolvedValue({
      filename: 'notes.txt',
      preview_kind: 'text',
      transport: {
        mode: 'inline',
        data: { kind: 'text', content: 'sensitive content', truncated: false },
      },
    })

    const { rerender } = render(<SharedSessionFilePreviewPane target={{
      sessionId: 'shared-session-1',
      shareId: 'share-1',
      relativePath: 'artifacts/notes.txt',
    }} />)
    expect(await screen.findByText('sensitive content')).toBeTruthy()

    imStoreState.sessionShares['share-1'] = {
      detail: { id: 'share-1', status: 'revoked' },
      accessDenied: false,
    }
    rerender(<SharedSessionFilePreviewPane target={{
      sessionId: 'shared-session-1',
      shareId: 'share-1',
      relativePath: 'artifacts/notes.txt',
    }} />)

    expect(await screen.findByText('共享已停止或无权查看')).toBeTruthy()
    expect(screen.queryByText('sensitive content')).toBeNull()
  })

  it('reloads the current file when the user refreshes the preview', async () => {
    sharedFilePreview
      .mockResolvedValueOnce({
        filename: 'notes.txt',
        preview_kind: 'text',
        transport: {
          mode: 'inline',
          data: { kind: 'text', content: 'old content', truncated: false },
        },
      })
      .mockResolvedValueOnce({
        filename: 'notes.txt',
        preview_kind: 'text',
        transport: {
          mode: 'inline',
          data: { kind: 'text', content: 'new content', truncated: false },
        },
      })

    render(<SharedSessionFilePreviewPane target={{
      sessionId: 'shared-session-1',
      shareId: 'share-1',
      relativePath: 'artifacts/notes.txt',
      title: 'notes.txt',
    }} />)

    expect(await screen.findByText('old content')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))

    expect(await screen.findByText('new content')).toBeTruthy()
    expect(sharedFilePreview).toHaveBeenCalledTimes(2)
  })

  it('renders a direct signed image URL without downloading it first', async () => {
    sharedFilePreview.mockResolvedValue({
      filename: 'diagram.png',
      preview_kind: 'image',
      transport: { mode: 'signed_url', url: 'https://preview.test/diagram.png' },
    })

    render(<SharedSessionFilePreviewPane target={{
      sessionId: 'shared-session-1',
      shareId: 'share-1',
      relativePath: 'artifacts/diagram.png',
      title: 'diagram.png',
    }} />)

    expect((await screen.findByRole('img', { name: 'diagram.png' })).getAttribute('src'))
      .toBe('https://preview.test/diagram.png')
    expect(fetchPreview).not.toHaveBeenCalled()
  })

  it('downloads a signed PDF before rendering the binary preview', async () => {
    const data = new ArrayBuffer(8)
    fetchPreview.mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': '8' }),
      arrayBuffer: async () => data,
    })
    sharedFilePreview.mockResolvedValue({
      filename: 'report.pdf',
      preview_kind: 'pdf',
      transport: { mode: 'signed_url', url: 'https://preview.test/report.pdf' },
    })

    render(<SharedSessionFilePreviewPane target={{
      sessionId: 'shared-session-1',
      shareId: 'share-1',
      relativePath: 'artifacts/report.pdf',
      title: 'report.pdf',
    }} />)

    const viewer = await screen.findByTestId('pdf-viewer')
    expect(viewer.getAttribute('data-byte-length')).toBe('8')
    expect(viewer.getAttribute('data-filename')).toBe('report.pdf')
    expect(fetchPreview).toHaveBeenCalledWith('https://preview.test/report.pdf')
  })

  it('recovers when a signed binary download succeeds on retry', async () => {
    fetchPreview
      .mockResolvedValueOnce({ ok: false, status: 503, headers: new Headers() })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-length': '4' }),
        arrayBuffer: async () => new ArrayBuffer(4),
      })
    sharedFilePreview.mockResolvedValue({
      filename: 'report.pdf',
      preview_kind: 'pdf',
      transport: { mode: 'signed_url', url: 'https://preview.test/report.pdf' },
    })

    render(<SharedSessionFilePreviewPane target={{
      sessionId: 'shared-session-1',
      shareId: 'share-1',
      relativePath: 'artifacts/report.pdf',
      title: 'report.pdf',
    }} />)

    expect(await screen.findByText('download failed: 503')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    expect((await screen.findByTestId('pdf-viewer')).getAttribute('data-byte-length')).toBe('4')
    expect(fetchPreview).toHaveBeenCalledTimes(2)
  })
})
