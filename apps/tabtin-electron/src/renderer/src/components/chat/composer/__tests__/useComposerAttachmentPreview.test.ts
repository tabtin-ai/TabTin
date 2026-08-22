import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '../../types'
import type { PreviewResourceKind } from '../../preview/types'

const openPreview = vi.fn()
const toast = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: (...args: unknown[]) => toast(...args),
  resolveChoiceTagColors: vi.fn(() => ({ background: '#ffffff', text: '#000000' })),
}))

vi.mock('../../preview/useResourcePreviewStore', () => ({
  useResourcePreviewStore: (selector: (s: { open: typeof openPreview }) => unknown) =>
    selector({ open: openPreview }),
}))

vi.mock('../AttachmentCard', () => ({
  inferPreviewableKind: (mime?: string, filename?: string): PreviewResourceKind | null => {
    const m = (mime || '').toLowerCase()
    if (m.startsWith('image/')) return 'image'
    if (m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx'
    if (m === 'application/pdf') return 'pdf'
    if (m === 'text/plain') return 'txt'
    if (m === 'text/markdown' || m === 'text/x-markdown') return 'md'
    if (m === 'application/json' || m === 'text/json') return 'json'
    const name = (filename || '').toLowerCase()
    if (name.endsWith('.xlsx')) return 'xlsx'
    if (name.endsWith('.txt')) return 'txt'
    if (name.endsWith('.md') || name.endsWith('.markdown')) return 'md'
    if (name.endsWith('.json')) return 'json'
    return null
  },
}))

import { useComposerAttachmentPreview } from '../useComposerAttachmentPreview'

function makeAttachment(overrides: Partial<ChatAttachment> = {}): ChatAttachment {
  const filename = overrides.filename ?? 'notes.txt'
  const mimeType = overrides.mimeType ?? 'text/plain'
  const content = overrides.file instanceof File
    ? overrides.file
    : new File(['hello'], filename, { type: mimeType })
  return {
    id: 'att-1',
    file: content,
    filename,
    mimeType,
    size: content.size,
    type: 'file',
    status: 'pending',
    ...overrides,
  }
}

describe('useComposerAttachmentPreview text kinds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:mock://local'),
      configurable: true,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: vi.fn(),
      configurable: true,
    })
  })

  it.each([
    { filename: 'notes.txt', mimeType: 'text/plain', kind: 'txt' },
    { filename: 'readme.md', mimeType: 'text/markdown', kind: 'md' },
    { filename: 'data.json', mimeType: 'application/json', kind: 'json' },
  ] as const)('打开 $filename 预览 lightbox（kind=$kind）', ({ filename, mimeType, kind }) => {
    const { result } = renderHook(() =>
      useComposerAttachmentPreview(makeAttachment({ filename, mimeType })),
    )
    expect(result.current.canPreview).toBe(true)
    expect(result.current.previewKind).toBe(kind)
    act(() => {
      result.current.handlePreview()
    })
    expect(openPreview).toHaveBeenCalledWith([
      expect.objectContaining({
        kind,
        name: filename,
        mimeType,
        url: 'blob:mock://local',
      }),
    ])
    expect(toast).not.toHaveBeenCalled()
  })

  it('不可预览类型可点击，toast 提示暂不支持预览', () => {
    const { result } = renderHook(() =>
      useComposerAttachmentPreview(makeAttachment({
        filename: 'archive.zip',
        mimeType: 'application/zip',
        file: new File(['x'], 'archive.zip', { type: 'application/zip' }),
      })),
    )
    expect(result.current.canPreview).toBe(true)
    act(() => {
      result.current.handlePreview()
    })
    expect(openPreview).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: '暂不支持预览此类型文件',
    }))
  })

  it('xlsx 仍打开 Lightbox', () => {
    const { result } = renderHook(() => useComposerAttachmentPreview(makeAttachment({
      filename: 'demo.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      file: new File(['x'], 'demo.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      remoteUrl: 'https://assets.example.com/demo.xlsx',
    })))
    act(() => {
      result.current.handlePreview()
    })
    expect(openPreview).toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
  })
})
