import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommentAttachment } from '@tabtin/tabdoc-ui/api-client'
import { useResourcePreviewStore } from '@components/chat/preview/useResourcePreviewStore'
import { openDocumentCommentImagePreview } from './openDocumentCommentImagePreview'

const previewStoreMock = vi.hoisted(() => {
  const open = vi.fn((resources, currentIndex, options) => {
    previewStoreMock.state = {
      ...previewStoreMock.state,
      isOpen: true,
      resources,
      currentIndex,
      showNavMeta: Boolean(options?.showNavMeta),
    }
    return true
  })
  const initialState = {
    isOpen: false,
    resources: [],
    currentIndex: 0,
    showNavMeta: true,
    open,
  }
  return {
    state: initialState,
    open,
    getState: vi.fn(() => previewStoreMock.state),
    setState: vi.fn((next) => {
      previewStoreMock.state = {
        ...previewStoreMock.state,
        ...next,
        open,
      }
    }),
  }
})

vi.mock('@components/chat/preview/useResourcePreviewStore', () => ({
  useResourcePreviewStore: {
    getState: previewStoreMock.getState,
    setState: previewStoreMock.setState,
  },
}))

function imageAttachment(id: string, url: string): CommentAttachment {
  return {
    id: `attachment-${id}`,
    file_id: `file-${id}`,
    type: 'image',
    metadata: {
      file_name: `${id}.png`,
      file_size: 128,
      mime_type: 'image/png',
    },
    preview_url: url,
  }
}

describe('openDocumentCommentImagePreview', () => {
  beforeEach(() => {
    useResourcePreviewStore.setState({
      isOpen: false,
      resources: [],
      currentIndex: 0,
      showNavMeta: true,
    })
  })

  it('刷新同消息邻图并在 Lightbox 中定位点击图片', async () => {
    const first = imageAttachment('first', 'https://oss.example/first-expired')
    const second = imageAttachment('second', 'https://oss.example/second-expired')
    const file: CommentAttachment = {
      id: 'attachment-file',
      file_id: 'file-file',
      type: 'file',
      metadata: { file_name: 'notes.txt' },
      preview_url: 'https://oss.example/notes',
    }
    const resolvePreviewUrl = vi.fn(async (fileId: string) => `https://oss.example/${fileId}-fresh`)

    const opened = await openDocumentCommentImagePreview({
      attachment: second,
      attachments: [first, second, file],
      previewUrl: 'https://oss.example/second-fresh',
    }, resolvePreviewUrl)

    expect(opened).toBe(true)
    expect(resolvePreviewUrl).toHaveBeenCalledTimes(1)
    expect(resolvePreviewUrl).toHaveBeenCalledWith('file-first')
    expect(useResourcePreviewStore.getState()).toMatchObject({
      isOpen: true,
      currentIndex: 1,
      showNavMeta: true,
      resources: [
        {
          kind: 'image',
          url: 'https://oss.example/file-first-fresh',
          name: 'first.png',
        },
        {
          kind: 'image',
          url: 'https://oss.example/second-fresh',
          name: 'second.png',
        },
      ],
    })
  })

  it('邻图换签失败时保留已有地址，不阻断点击图片预览', async () => {
    const first = imageAttachment('first', 'https://oss.example/first-existing')
    const second = imageAttachment('second', 'https://oss.example/second-existing')

    const opened = await openDocumentCommentImagePreview({
      attachment: first,
      attachments: [first, second],
      previewUrl: 'https://oss.example/first-fresh',
    }, vi.fn(async () => { throw new Error('refresh failed') }))

    expect(opened).toBe(true)
    expect(useResourcePreviewStore.getState().resources.map((resource) => resource.url)).toEqual([
      'https://oss.example/first-fresh',
      'https://oss.example/second-existing',
    ])
  })
})
