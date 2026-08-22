import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '../../types'

const { warning } = vi.hoisted(() => ({ warning: vi.fn() }))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: { warning },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}))

vi.mock('../../types', () => ({
  FILE_LIMITS: { MAX_ATTACHMENTS: 10 },
  createAttachment: (file: File) => ({
    id: `attachment-${file.name}`,
    file,
    filename: file.name,
    mimeType: file.type,
    size: file.size,
    type: file.type.startsWith('image/') ? 'image' : 'file',
    status: 'pending',
  }),
  revokeAttachmentPreview: vi.fn(),
  isImageType: (mime: string) => mime.startsWith('image/'),
  getAcceptedImageTypes: () => ['image/png'],
  getAcceptedFileTypes: () => [],
  getAcceptedMediaTypes: () => [],
}))

vi.mock('@/constants/upload', () => ({
  ZIP_ARCHIVE_ACCEPT_TYPES: ['application/zip', 'application/x-zip-compressed', '.zip'],
  validateUploadFile: () => ({ valid: true }),
  isImageMime: (mime: string) => mime.startsWith('image/'),
  isMediaMime: () => false,
}))

vi.mock('../useComposerAttachmentUploads', () => ({
  useComposerAttachmentUploads: () => ({
    attachmentsUploading: false,
    cancelUpload: vi.fn(),
    cancelAllUploads: vi.fn(),
  }),
}))

import { useChatInputAttachments } from '../useChatInputAttachments'

describe('useChatInputAttachments', () => {
  beforeEach(() => {
    warning.mockClear()
  })

  const existingImage = (index: number): ChatAttachment => ({
    id: `existing-${index}`,
    file: new File(['image'], `existing-${index}.png`, { type: 'image/png' }),
    filename: `existing-${index}.png`,
    mimeType: 'image/png',
    size: 5,
    type: 'image',
    status: 'ready',
  })

  it('模型不支持视觉时，图片仍可作为对话资源加入', async () => {
    let attachments: ChatAttachment[] = []
    const setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>> = (next) => {
      attachments = typeof next === 'function' ? next(attachments) : next
    }
    const { result } = renderHook(() =>
      useChatInputAttachments(attachments, setAttachments)
    )

    act(() => {
      result.current.addFiles([new File(['image'], 'image.png', { type: 'image/png' })])
    })
    await act(async () => {
      await new Promise<void>((resolve) => queueMicrotask(resolve))
    })

    expect(attachments).toHaveLength(1)
    expect(warning).not.toHaveBeenCalled()
  })

  it('React 开发模式重复执行 state updater 时也只提示一次', async () => {
    let attachments: ChatAttachment[] = []
    const setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>> = (next) => {
      if (typeof next === 'function') {
        // React Strict Mode 会在开发环境重复执行 updater 来检查纯度。
        next(attachments)
        attachments = next(attachments)
      } else {
        attachments = next
      }
    }
    const { result } = renderHook(() =>
      useChatInputAttachments(attachments, setAttachments)
    )

    act(() => {
      result.current.addFiles([new File(['image'], 'image.png', { type: 'image/png' })])
    })
    await act(async () => {
      await new Promise<void>((resolve) => queueMicrotask(resolve))
    })

    expect(attachments).toHaveLength(1)
    expect(warning).not.toHaveBeenCalled()
  })

  it('模型不支持文档直传时，文档仍可作为对话资源加入', async () => {
    let attachments: ChatAttachment[] = []
    const setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>> = (next) => {
      attachments = typeof next === 'function' ? next(attachments) : next
    }
    const { result } = renderHook(() =>
      useChatInputAttachments(attachments, setAttachments)
    )

    act(() => {
      result.current.addFiles([new File(['document'], 'notes.txt', { type: 'text/plain' })])
    })
    await act(async () => {
      await new Promise<void>((resolve) => queueMicrotask(resolve))
    })

    expect(attachments).toHaveLength(1)
    expect(attachments[0]?.filename).toBe('notes.txt')
    expect(warning).not.toHaveBeenCalled()
  })

  it('ZIP 不依赖后台模型能力即可添加', async () => {
    let attachments: ChatAttachment[] = []
    const setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>> = (next) => {
      attachments = typeof next === 'function' ? next(attachments) : next
    }
    const { result } = renderHook(() =>
      useChatInputAttachments(attachments, setAttachments)
    )

    act(() => {
      result.current.addFiles([new File(['PK'], 'materials.zip', { type: 'application/zip' })])
    })
    await act(async () => {
      await new Promise<void>((resolve) => queueMicrotask(resolve))
    })

    expect(attachments).toHaveLength(1)
    expect(warning).not.toHaveBeenCalled()
  })

  it('普通文件不依赖模型类型即可添加', async () => {
    let attachments: ChatAttachment[] = []
    const setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>> = (next) => {
      attachments = typeof next === 'function' ? next(attachments) : next
    }
    const { result } = renderHook(() =>
      useChatInputAttachments(attachments, setAttachments)
    )

    act(() => {
      result.current.addFiles([new File(['log'], 'diagnostics.txt', { type: 'text/plain' })])
    })
    await act(async () => {
      await new Promise<void>((resolve) => queueMicrotask(resolve))
    })

    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({ filename: 'diagnostics.txt', type: 'file' })
    expect(warning).not.toHaveBeenCalled()
  })

  it('已有 10 张图片时继续添加图片会提示上限且不新增附件', async () => {
    let attachments = Array.from({ length: 10 }, (_, index) => existingImage(index))
    const setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>> = (next) => {
      attachments = typeof next === 'function' ? next(attachments) : next
    }
    const { result } = renderHook(() =>
      useChatInputAttachments(attachments, setAttachments)
    )

    act(() => {
      result.current.addFiles([new File(['image'], 'overflow.png', { type: 'image/png' })])
    })
    await act(async () => {
      await new Promise<void>((resolve) => queueMicrotask(resolve))
    })

    expect(attachments).toHaveLength(10)
    expect(warning).toHaveBeenCalledTimes(1)
    expect(warning).toHaveBeenCalledWith('最多添加10张图片')
  })

  it('批量图片超过剩余名额时只添加可用数量并提示上限', async () => {
    let attachments = Array.from({ length: 9 }, (_, index) => existingImage(index))
    const setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>> = (next) => {
      attachments = typeof next === 'function' ? next(attachments) : next
    }
    const { result } = renderHook(() =>
      useChatInputAttachments(attachments, setAttachments)
    )

    act(() => {
      result.current.addFiles([
        new File(['image'], 'accepted.png', { type: 'image/png' }),
        new File(['image'], 'overflow.png', { type: 'image/png' }),
      ])
    })
    await act(async () => {
      await new Promise<void>((resolve) => queueMicrotask(resolve))
    })

    expect(attachments).toHaveLength(10)
    expect(attachments.at(-1)?.filename).toBe('accepted.png')
    expect(warning).toHaveBeenCalledTimes(1)
    expect(warning).toHaveBeenCalledWith('最多添加10张图片')
  })
})
