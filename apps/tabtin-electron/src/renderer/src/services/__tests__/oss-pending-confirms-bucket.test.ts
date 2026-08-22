/**
 * W2.2 G3 · renderer 守护测试：oss-direct-uploader 模块加载时注册
 * `oss:pending-confirms` bucket 并满足 RFC §五要求。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const ossClientMock = vi.hoisted(() => ({
  presign: vi.fn(),
  confirm: vi.fn(),
  retryPendingConfirms: vi.fn(),
}))

const storageManagerMock = vi.hoisted(() => {
  const buckets = new Map<string, any>()
  return {
    __resetForTesting: vi.fn(() => buckets.clear()),
    getBucket: vi.fn((id: string) => buckets.get(id)),
    registerStorageBucket: vi.fn((bucket: any) => buckets.set(bucket.id, bucket)),
  }
})

// oss-direct-uploader import 链涉及很多业务，打点 mock
vi.mock('@/config/api', () => ({ API_CONFIG: { baseURL: 'http://test' } }))
vi.mock('@/stores/useOrganizationStore', () => ({
  useOrganizationStore: { getState: () => ({ getEffectiveOrganizationId: () => undefined }) },
}))
vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ accessToken: '' }) },
}))
vi.mock('@/i18n', () => ({
  default: { t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key },
}))
vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}))
vi.mock('@tabtin/storage-manager', () => storageManagerMock)
vi.mock('@tabtin/oss-client', async () => {
  return {
    createOSSClient: vi.fn(() => ossClientMock),
    computeFileHash: vi.fn(async () => 'hash'),
    withRetry: vi.fn(async (fn: any) => fn()),
    UploadAbortedError: class extends Error {},
    StorageQuotaExceededError: class extends Error {},
    BillingBlockedError: class extends Error {},
    AuthExpiredError: class extends Error {},
    PermissionDeniedError: class extends Error {},
    RateLimitError: class extends Error {},
  }
})

describe('oss:pending-confirms bucket registration', () => {
  beforeEach(async () => {
    localStorage.clear()
    vi.unstubAllGlobals()
    vi.resetModules()
    vi.clearAllMocks()
    const sm = await import('@tabtin/storage-manager')
    sm.__resetForTesting()
  })

  it('oss-direct-uploader 加载后注册 oss:pending-confirms；category=data / group=system / hard', async () => {
    await import('../oss-direct-uploader')
    const sm = await import('@tabtin/storage-manager')

    const bucket = sm.getBucket('oss:pending-confirms')
    expect(bucket).toBeDefined()
    expect(bucket?.category).toBe('data')
    expect(bucket?.group).toBe('system')
    expect(bucket?.requiresConfirmation).toBe('hard')
    expect(bucket?.warnings?.length ?? 0).toBeGreaterThan(0)
  })

  it('sizeFn 用 TextEncoder 统计真实 UTF-8 字节（中文文件名不偏小）', async () => {
    await import('../oss-direct-uploader')
    const sm = await import('@tabtin/storage-manager')

    const confirms = [
      { objectKey: 'key-1', fileName: '测试文件-中文名称.mp4', size: 1024 },
      { objectKey: 'key-2', fileName: '另一个中文.pdf', size: 2048 },
    ]
    localStorage.setItem('oss_pending_confirms', JSON.stringify(confirms))

    const bucket = sm.getBucket('oss:pending-confirms')!
    const size = await bucket.sizeFn()
    expect(size.itemCount).toBe(2)
    // 真实 UTF-8 字节数应 ≥ String.length（中文一字 3 字节）
    const raw = localStorage.getItem('oss_pending_confirms')!
    expect(size.bytes).toBeGreaterThanOrEqual(raw.length)
  })

  it('clearFn 清空 localStorage', async () => {
    await import('../oss-direct-uploader')
    const sm = await import('@tabtin/storage-manager')

    localStorage.setItem(
      'oss_pending_confirms',
      JSON.stringify([{ objectKey: 'a', fileName: 'a.jpg', size: 100 }]),
    )
    const bucket = sm.getBucket('oss:pending-confirms')!
    const r = await bucket.clearFn!()
    expect(r.clearedItemCount).toBe(1)
    expect(localStorage.getItem('oss_pending_confirms')).toBeNull()
  })

  it('空状态 sizeFn 返回 0', async () => {
    await import('../oss-direct-uploader')
    const sm = await import('@tabtin/storage-manager')
    const bucket = sm.getBucket('oss:pending-confirms')!
    const size = await bucket.sizeFn()
    expect(size.itemCount).toBe(0)
  })

  it('directUpload presign 带上业务上下文，支持封面秒传正确归属', async () => {
    ossClientMock.presign.mockResolvedValueOnce({
      instant: true,
      instantResult: {
        fileId: 'file-1',
        fileName: 'cover.png',
        fileKey: 'tabdoc/covers/cover.png',
        fileSize: 12,
        accessUrl: 'https://cdn.example.com/cover.png',
        cdnUrl: '',
        instant: true,
      },
      quotaWarning: null,
    })
    const { directUpload } = await import('../oss-direct-uploader')
    const uploadPayload = 'x'.repeat(120 * 1024)
    const file = new File([uploadPayload], 'cover.png', { type: 'image/png' })

    const result = await directUpload(file, file.name, {
      folder: 'tabdoc/covers',
      module: 'tabdoc',
      contextType: 'document',
      contextId: 'doc-1',
    })

    expect(result.fileId).toBe('file-1')
    expect(ossClientMock.presign).toHaveBeenCalledWith(
      'cover.png',
      file.size,
      'image/png',
      expect.objectContaining({
        folder: 'tabdoc/covers',
        module: 'tabdoc',
        contextType: 'document',
        contextId: 'doc-1',
        fileHash: 'hash',
        hashAlgorithm: 'sha256',
      }),
    )
    expect(ossClientMock.confirm).not.toHaveBeenCalled()
  })

  it('directUpload confirm 沉淀 hash，后续上传才能真实秒传', async () => {
    ossClientMock.presign.mockResolvedValueOnce({
      instant: false,
      objectKey: 'tabdoc/covers/object.png',
      presignedUrl: 'https://oss.example.com/put',
      contentType: 'image/png',
      expiresIn: 300,
      quotaWarning: null,
    })
    ossClientMock.confirm.mockResolvedValueOnce({
      fileId: 'file-2',
      fileName: 'cover.png',
      fileKey: 'tabdoc/covers/object.png',
      fileSize: 12,
      accessUrl: 'https://cdn.example.com/object.png',
      cdnUrl: '',
    })
    class MockXHR {
      status = 200
      timeout = 0
      upload = { addEventListener: vi.fn() }
      private listeners = new Map<string, () => void>()
      open = vi.fn()
      setRequestHeader = vi.fn()
      addEventListener = vi.fn((event: string, cb: () => void) => {
        this.listeners.set(event, cb)
      })
      send = vi.fn(() => {
        this.listeners.get('load')?.()
      })
      abort = vi.fn()
    }
    vi.stubGlobal('XMLHttpRequest', MockXHR)

    const { directUpload } = await import('../oss-direct-uploader')
    const uploadPayload = 'x'.repeat(120 * 1024)
    const file = new File([uploadPayload], 'cover.png', { type: 'image/png' })

    await directUpload(file, file.name, {
      folder: 'tabdoc/covers',
      module: 'tabdoc',
      contextType: 'document',
      contextId: 'doc-1',
    })

    expect(ossClientMock.confirm).toHaveBeenCalledWith(
      'tabdoc/covers/object.png',
      'cover.png',
      file.size,
      'image/png',
      expect.objectContaining({
        fileHash: 'hash',
        hashAlgorithm: 'sha256',
        contextId: 'doc-1',
      }),
    )
    expect(localStorage.getItem('oss_pending_confirms')).toBeNull()
  })

  it('directUpload 在 PUT 成功但 confirm 失败时保留 pending confirm 供启动后重试', async () => {
    ossClientMock.presign.mockResolvedValueOnce({
      instant: false,
      objectKey: 'tabdoc/covers/orphan.png',
      presignedUrl: 'https://oss.example.com/put',
      contentType: 'image/png',
      expiresIn: 300,
      quotaWarning: null,
    })
    ossClientMock.confirm.mockRejectedValueOnce(new Error('confirm failed'))
    class MockXHR {
      status = 200
      timeout = 0
      upload = { addEventListener: vi.fn() }
      private listeners = new Map<string, () => void>()
      open = vi.fn()
      setRequestHeader = vi.fn()
      addEventListener = vi.fn((event: string, cb: () => void) => {
        this.listeners.set(event, cb)
      })
      send = vi.fn(() => {
        this.listeners.get('load')?.()
      })
      abort = vi.fn()
    }
    vi.stubGlobal('XMLHttpRequest', MockXHR)

    const { directUpload } = await import('../oss-direct-uploader')
    const uploadPayload = 'x'.repeat(120 * 1024)
    const file = new File([uploadPayload], 'cover.png', { type: 'image/png' })

    await expect(directUpload(file, file.name, {
      folder: 'tabdoc/covers',
      module: 'tabdoc',
      contextType: 'document',
      contextId: 'doc-1',
    })).rejects.toThrow('confirm failed')

    const pending = JSON.parse(localStorage.getItem('oss_pending_confirms') || '[]')
    expect(pending).toHaveLength(1)
    expect(pending[0]).toEqual(expect.objectContaining({
      objectKey: 'tabdoc/covers/orphan.png',
      fileName: 'cover.png',
      contextId: 'doc-1',
      fileHash: 'hash',
      hashAlgorithm: 'sha256',
    }))
  })
})
