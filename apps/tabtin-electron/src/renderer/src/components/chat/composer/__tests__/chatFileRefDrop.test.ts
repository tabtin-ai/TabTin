import { afterEach, describe, expect, it, vi } from 'vitest'

import { DRAG_TYPE_FILE_REF } from '@/utils/split-coordinator'
import { writeFileRefDragPayload } from '@/utils/fileRefDrag'
import {
  createReusableChatAttachment,
  isAgentReachableMediaUrl,
  isChatFileRefDropAcceptable,
  resolveChatFileRefDrop,
} from '../chatFileRefDrop'

const getAttachmentBufferMock = vi.fn()
const resolveOssFileDetailMock = vi.fn()

vi.mock('../../preview/attachmentBlobCache', () => ({
  getAttachmentBuffer: (...args: unknown[]) => getAttachmentBufferMock(...args),
}))

vi.mock('../../preview/resolveOssFileAccessUrl', () => ({
  resolveOssFileDetail: (...args: unknown[]) => resolveOssFileDetailMock(...args),
}))

function createDataTransfer(extra?: { files?: File[] }) {
  const store = new Map<string, string>()
  const files = extra?.files ?? []
  const dt = {
    types: [] as string[],
    files: files as unknown as FileList,
    effectAllowed: 'none' as string,
    items: {
      add(file: File) {
        files.push(file)
        if (!dt.types.includes('Files')) dt.types.push('Files')
      },
    },
    setData(type: string, value: string) {
      store.set(type, value)
      if (!dt.types.includes(type)) dt.types.push(type)
    },
    getData(type: string) {
      return store.get(type) ?? ''
    },
  }
  return dt
}

describe('chatFileRefDrop', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    getAttachmentBufferMock.mockReset()
    resolveOssFileDetailMock.mockReset()
  })

  it('isAgentReachableMediaUrl 拒绝本机 / 私网', () => {
    expect(isAgentReachableMediaUrl('https://cdn.example/a.png')).toBe(true)
    expect(isAgentReachableMediaUrl('https://ark.tos-cn-beijing.volces.com/x.jpg')).toBe(true)
    expect(isAgentReachableMediaUrl('http://127.0.0.1:9000/a.png')).toBe(false)
    expect(isAgentReachableMediaUrl('http://localhost/a.png')).toBe(false)
    expect(isAgentReachableMediaUrl('http://192.168.1.2/a.png')).toBe(false)
  })

  it('isChatFileRefDropAcceptable 仅认 file-ref MIME', () => {
    const withRef = createDataTransfer()
    writeFileRefDragPayload(withRef as unknown as DataTransfer, {
      url: 'https://cdn.example/a.png',
      name: 'a.png',
    })
    expect(isChatFileRefDropAcceptable(withRef as unknown as DataTransfer)).toBe(true)

    const filesOnly = createDataTransfer()
    filesOnly.types.push('Files')
    expect(isChatFileRefDropAcceptable(filesOnly as unknown as DataTransfer)).toBe(false)
  })

  it('优先使用 dataTransfer.files（Widget SVG items.add）', async () => {
    const svg = new File(['<svg/>'], 'chart.svg', { type: 'image/svg+xml' })
    const dt = createDataTransfer()
    writeFileRefDragPayload(dt as unknown as DataTransfer, {
      url: 'data:image/svg+xml;base64,abc',
      name: 'chart.svg',
      mimeType: 'image/svg+xml',
      file: svg,
    })

    const result = await resolveChatFileRefDrop(dt as unknown as DataTransfer)
    expect(result.kind).toBe('files')
    if (result.kind !== 'files') return
    expect(result.files[0].name).toBe('chart.svg')
    expect(getAttachmentBufferMock).not.toHaveBeenCalled()
  })

  it('公网 url：下载真 File + ready 保留原 CDN（不二次上传到本机 OSS）', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer
    getAttachmentBufferMock.mockResolvedValue(bytes)

    const dt = createDataTransfer()
    writeFileRefDragPayload(dt as unknown as DataTransfer, {
      url: 'https://ark.tos-cn-beijing.volces.com/pic.png',
      name: 'pic.png',
      mimeType: 'image/png',
      fileId: 'fid-pic',
    })

    const result = await resolveChatFileRefDrop(dt as unknown as DataTransfer)
    expect(result.kind).toBe('attachments')
    if (result.kind !== 'attachments') return
    const att = result.attachments[0]
    expect(att.status).toBe('ready')
    expect(att.remoteUrl).toBe('https://ark.tos-cn-beijing.volces.com/pic.png')
    expect(att.fileId).toBe('fid-pic')
    expect(att.file.size).toBe(4)
    expect(att.size).toBe(4)
  })

  it('createReusableChatAttachment 带真实 size', () => {
    const file = new File([new Uint8Array(8)], 'x.png', { type: 'image/png' })
    const att = createReusableChatAttachment({
      file,
      remoteUrl: 'https://cdn.example/x.png',
      fileId: 'fid-x',
    })
    expect(att).toMatchObject({
      status: 'ready',
      remoteUrl: 'https://cdn.example/x.png',
      fileId: 'fid-x',
      size: 8,
      type: 'image',
    })
  })

  it('仅本机 url 的图片：ready + data: 兜底（不交给 127.0.0.1）', async () => {
    const bytes = new Uint8Array([9, 8, 7]).buffer
    getAttachmentBufferMock.mockResolvedValue(bytes)
    resolveOssFileDetailMock.mockResolvedValue({
      fileId: 'file-local',
      fileName: 'local.png',
      url: 'http://127.0.0.1:9000/local.png',
      mimeType: 'image/png',
    })

    const dt = createDataTransfer()
    writeFileRefDragPayload(dt as unknown as DataTransfer, {
      fileId: 'file-local',
      name: 'local.png',
      mimeType: 'image/png',
    })

    const result = await resolveChatFileRefDrop(dt as unknown as DataTransfer)
    expect(result.kind).toBe('attachments')
    if (result.kind !== 'attachments') return
    const att = result.attachments[0]
    expect(att.status).toBe('ready')
    expect(att.file.size).toBe(3)
    expect(att.remoteUrl?.startsWith('data:image/png;base64,')).toBe(true)
    expect(att.remoteUrl).not.toContain('127.0.0.1')
  })

  it('本机 url 图片超过 5MB → error', async () => {
    getAttachmentBufferMock.mockResolvedValue(new Uint8Array(5 * 1024 * 1024 + 1).buffer)
    const dt = createDataTransfer()
    writeFileRefDragPayload(dt as unknown as DataTransfer, {
      url: 'http://127.0.0.1:9000/huge.png',
      name: 'huge.png',
      mimeType: 'image/png',
    })

    const result = await resolveChatFileRefDrop(dt as unknown as DataTransfer)
    expect(result.kind).toBe('error')
  })

  it('拖源公网 url + OSS detail 本机 url：仍保留拖源公网给模型', async () => {
    getAttachmentBufferMock.mockResolvedValue(new Uint8Array([1, 2]).buffer)
    resolveOssFileDetailMock.mockResolvedValue({
      fileId: 'fid-1',
      fileName: 'a.png',
      url: 'http://127.0.0.1:9000/a.png',
      mimeType: 'image/png',
    })

    const dt = createDataTransfer()
    writeFileRefDragPayload(dt as unknown as DataTransfer, {
      fileId: 'fid-1',
      url: 'https://cdn.volces.com/a.png',
      name: 'image',
      mimeType: 'image/png',
    })

    const result = await resolveChatFileRefDrop(dt as unknown as DataTransfer)
    expect(result.kind).toBe('attachments')
    if (result.kind !== 'attachments') return
    expect(result.attachments[0].remoteUrl).toBe('https://cdn.volces.com/a.png')
  })

  it('下载失败 → error', async () => {
    getAttachmentBufferMock.mockRejectedValue(new Error('proxy failed'))
    const dt = createDataTransfer()
    writeFileRefDragPayload(dt as unknown as DataTransfer, {
      url: 'https://cdn.example/gone.png',
      name: 'gone.png',
    })

    const result = await resolveChatFileRefDrop(dt as unknown as DataTransfer)
    expect(result.kind).toBe('error')
  })

  it('无 file-ref → none', async () => {
    const dt = createDataTransfer()
    dt.types.push('Files')
    const result = await resolveChatFileRefDrop(dt as unknown as DataTransfer)
    expect(result).toEqual({ kind: 'none' })
  })
})
