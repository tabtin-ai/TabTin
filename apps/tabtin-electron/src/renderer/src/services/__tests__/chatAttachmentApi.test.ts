/**
 * 场景 B 回归测试：chatAttachmentApi.uploadAllAttachments 上传完成后，
 * `onFileComplete` 必须收到**合并对象**（含 fileId / remoteUrl + 原 attachment
 * 字段），而不是回退到原始 attachment。
 *
 * 业务背景：消费方（chat 消息 metadata 写入、UI 即时预览）依赖 fileId/remoteUrl
 * 立刻执行后续动作；回调里只给原始 att 会让消费方落到"等 outputList 第二轮
 * 渲染才拿得到 fileId"的 race，刷屏闪烁 + 消息 metadata 漏写。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── 依赖 mock：避免触发真实网络 / OSS / 队列存储 ──────────────────

vi.mock('@/i18n', () => ({
  default: { t: (k: string, opts?: Record<string, unknown>) => (opts?.defaultValue as string) || k },
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}))

const directUploadMock = vi.fn()
const UploadAbortedErrorMock = class extends Error {
  constructor() { super('UploadAborted'); this.name = 'UploadAbortedError' }
}

vi.mock('../oss-direct-uploader', () => ({
  directUpload: directUploadMock,
  UploadAbortedError: UploadAbortedErrorMock,
}))

vi.mock('@/constants/upload', () => ({
  validateUploadFile: () => ({ valid: true }),
  isImageMime: (m: string) => m.startsWith('image/'),
  isMediaMime: (m: string) => m.startsWith('video/') || m.startsWith('audio/'),
}))

const compressMock = vi.fn(async (file: File) => ({
  file,
  compressed: false,
  reason: 'below-threshold' as const,
  log: undefined,
}))

vi.mock('../../components/chat/composer/imageCompressor', () => ({
  compressChatImageIfNeeded: compressMock,
}))

const primeAttachmentBufferMock = vi.fn()
vi.mock('../../components/chat/preview/attachmentBlobCache', () => ({
  primeAttachmentBuffer: primeAttachmentBufferMock,
}))

// 必须在 mocks 之后再 import 被测模块
let uploadAllAttachments: typeof import('../chatAttachmentApi').uploadAllAttachments

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()

  // 重新挂 mock（resetModules 会清掉 mock 状态）
  directUploadMock.mockReset()
  compressMock.mockClear()
  primeAttachmentBufferMock.mockReset()

  const mod = await import('../chatAttachmentApi')
  uploadAllAttachments = mod.uploadAllAttachments
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function makeAttachment(name: string, mime = 'image/jpeg'): import('../../components/chat/types').ChatAttachment {
  const file = new File([new Uint8Array(1024)], name, { type: mime })
  return {
    id: `att-${name}`,
    file,
    filename: name,
    mimeType: mime,
    size: 1024,
    type: 'image' as const,
    status: 'pending' as const,
  }
}

describe('uploadAllAttachments → onFileComplete 合并对象契约', () => {
  it('上传成功时 onFileComplete 收到含 fileId + remoteUrl 的合并对象', async () => {
    directUploadMock.mockResolvedValue({
      fileId: 'fid-1',
      fileName: 'screenshot.jpg',
      fileKey: 'chat/2026/04/screenshot.jpg',
      fileSize: 1024,
      accessUrl: 'https://oss.example.com/access/fid-1',
      cdnUrl: 'https://cdn.example.com/fid-1',
    })

    const attachments = [makeAttachment('screenshot.jpg')]
    const completes: Array<{ idx: number; att: import('../../components/chat/types').ChatAttachment; err?: string }> = []

    const result = await uploadAllAttachments(
      attachments,
      undefined,
      undefined,
      {
        onFileComplete: (idx, att, err) => {
          completes.push({ idx, att, err })
        },
      },
    )

    expect(completes).toHaveLength(1)
    const completed = completes[0]
    expect(completed.idx).toBe(0)
    expect(completed.err).toBeUndefined()

    // 关键断言：拿到的是合并后的"已上传完成"对象，
    // **不是**调用方传入的原始 att（那个对象 fileId/remoteUrl 都没有）。
    expect(completed.att.fileId).toBe('fid-1')
    expect(completed.att.remoteUrl).toBe('https://cdn.example.com/fid-1')
    expect(completed.att.status).toBe('ready')
    // 原 attachment 字段（id / type）应保留
    expect(completed.att.id).toBe(attachments[0].id)
    expect(completed.att.type).toBe('image')
    expect(directUploadMock).toHaveBeenCalledWith(
      expect.any(File),
      'screenshot.jpg',
      expect.objectContaining({
        folder: 'chat/attachments',
        module: 'chat',
        isPublic: true,
      }),
    )
    // outputList 与 onFileComplete 收到的是**结构相等的独立副本**（消除 race
    // + 防御 mutation）——回调如果意外 mutate 字段不会污染 outputList[idx]。
    expect(result[0]).toEqual(completed.att)
    expect(result[0]).not.toBe(completed.att)
  })

  it('Wave 3 防御：消费方 mutate onFileComplete 的 attachment 不会污染 outputList', async () => {
    directUploadMock.mockResolvedValue({
      fileId: 'fid-defense',
      fileName: 'defense.png',
      fileKey: 'k',
      fileSize: 1024,
      accessUrl: '',
      cdnUrl: 'https://cdn.example.com/fid-defense',
    })

    const result = await uploadAllAttachments(
      [makeAttachment('defense.png', 'image/png')],
      undefined,
      undefined,
      {
        onFileComplete: (_idx, att) => {
          // 模拟"恶意"消费方在回调中改了 status / 删了 fileId
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(att as any).status = 'pending'
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(att as any).fileId = undefined
        },
      },
    )

    // outputList 应保留正确状态——这是消息列表渲染的来源，被污染后会让用户
    // 看到"上传完成的图片仍显示 pending 转圈"
    expect(result[0].status).toBe('ready')
    expect(result[0].fileId).toBe('fid-defense')
  })

  it('上传完成后 access_url 缺省时回退到 cdn_url（顺序：cdn_url 优先）', async () => {
    directUploadMock.mockResolvedValue({
      fileId: 'fid-2',
      fileName: 'a.png',
      fileKey: 'k',
      fileSize: 1024,
      accessUrl: '',
      cdnUrl: 'https://cdn.example.com/fid-2',
    })

    const captured: import('../../components/chat/types').ChatAttachment[] = []
    await uploadAllAttachments(
      [makeAttachment('a.png', 'image/png')],
      undefined,
      undefined,
      { onFileComplete: (_idx, att) => captured.push(att) },
    )
    expect(captured[0].remoteUrl).toBe('https://cdn.example.com/fid-2')
  })

  it('上传失败时 onFileComplete 携带 errMsg 第三参数（attachment 仍为原始 att，调用方靠 err 判断）', async () => {
    directUploadMock.mockRejectedValue(new Error('OSS rejected: quota exceeded'))

    const completes: Array<{ idx: number; att: import('../../components/chat/types').ChatAttachment; err?: string }> = []
    const inputs = [makeAttachment('b.jpg')]
    const out = await uploadAllAttachments(
      inputs,
      undefined,
      undefined,
      { onFileComplete: (idx, att, err) => completes.push({ idx, att, err }) },
    )

    expect(completes).toHaveLength(1)
    expect(completes[0].err).toContain('quota')
    // 失败路径下 callback 第二参数仍是原始 att（与 668c 既有行为对齐 —— 调用方
    // 应按第三参数 err 决定 UI 错误态）；outputList 同步更新为带 error 的版本，
    // 让 result 渲染消息列表时能看到失败状态。
    expect(completes[0].att.id).toBe(inputs[0].id)
    expect(out[0].status).toBe('error')
    expect(out[0].error).toContain('quota')
  })

  it('多附件并发上传时每个 onFileComplete 都拿到自己的合并对象', async () => {
    directUploadMock.mockImplementation(async (file: File) => ({
      fileId: `fid-${file.name}`,
      fileName: file.name,
      fileKey: `k-${file.name}`,
      fileSize: 1024,
      accessUrl: '',
      cdnUrl: `https://cdn.example.com/${file.name}`,
    }))

    const attachments = [
      makeAttachment('a.jpg'),
      makeAttachment('b.jpg'),
      makeAttachment('c.jpg'),
    ]
    const seen = new Map<number, string | undefined>()

    await uploadAllAttachments(
      attachments,
      undefined,
      undefined,
      {
        onFileComplete: (idx, att) => {
          seen.set(idx, att.fileId)
        },
      },
    )

    expect(seen.get(0)).toBe('fid-a.jpg')
    expect(seen.get(1)).toBe('fid-b.jpg')
    expect(seen.get(2)).toBe('fid-c.jpg')
  })

  it('已 ready 且带 remoteUrl 的附件跳过 directUpload（ file-ref 复用）', async () => {
    const ready: import('../../components/chat/types').ChatAttachment = {
      id: 'att-ready',
      file: new File([], 'reuse.png', { type: 'image/png' }),
      filename: 'reuse.png',
      mimeType: 'image/png',
      size: 0,
      type: 'image',
      status: 'ready',
      fileId: 'fid-reuse',
      remoteUrl: 'https://cdn.example.com/reuse.png',
      previewUrl: 'https://cdn.example.com/reuse.png',
    }

    const completes: Array<{ idx: number; att: import('../../components/chat/types').ChatAttachment }> = []
    const out = await uploadAllAttachments(
      [ready],
      undefined,
      undefined,
      { onFileComplete: (idx, att) => completes.push({ idx, att }) },
    )

    expect(directUploadMock).not.toHaveBeenCalled()
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      status: 'ready',
      fileId: 'fid-reuse',
      remoteUrl: 'https://cdn.example.com/reuse.png',
    })
    expect(completes[0].att.fileId).toBe('fid-reuse')
  })
})
