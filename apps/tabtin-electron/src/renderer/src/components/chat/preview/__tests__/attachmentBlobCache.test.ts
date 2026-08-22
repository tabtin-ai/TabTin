import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchBufferMock = vi.fn()
const resolveOssFileAccessUrlMock = vi.fn()
const registerResetActionMock = vi.fn()

vi.mock('../resolveOssFileAccessUrl', () => ({
  resolveOssFileAccessUrl: (...args: unknown[]) => resolveOssFileAccessUrlMock(...args),
}))
vi.mock('@/stores/sessionResetRegistry', () => ({
  registerResetAction: (...args: unknown[]) => registerResetActionMock(...args),
}))

const {
  primeAttachmentBuffer,
  getAttachmentBuffer,
  isAttachmentNegativeCached,
  _clearAttachmentBlobCache,
  _detachCachedBufferForTest,
} = await import('../attachmentBlobCache')

beforeEach(() => {
  fetchBufferMock.mockReset()
  resolveOssFileAccessUrlMock.mockReset()
  vi.stubGlobal('window', {
    tabtin: {
      resourceDetection: {
        fetchBuffer: (...args: unknown[]) => fetchBufferMock(...args),
      },
    },
  })
})

afterEach(() => {
  _clearAttachmentBlobCache()
  vi.unstubAllGlobals()
})

function fakeFile(content: string): File {
  const buffer = new TextEncoder().encode(content).buffer
  return {
    arrayBuffer: async () => buffer,
    name: 'test.bin',
    size: buffer.byteLength,
    type: 'application/octet-stream',
  } as unknown as File
}

function okFetch(content: string) {
  const buffer = new TextEncoder().encode(content).buffer
  return {
    success: true as const,
    data: { buffer, mimeType: 'application/octet-stream', size: buffer.byteLength },
  }
}

describe('attachmentBlobCache', () => {
  it('registers cache cleanup with the existing session reset lifecycle', () => {
    expect(registerResetActionMock).toHaveBeenCalledWith(
      'attachment-blob-cache',
      'cleanup',
      _clearAttachmentBlobCache,
    )
  })

  it('primeAttachmentBuffer 后 getAttachmentBuffer 命中本地，不发 fetchBuffer', async () => {
    await primeAttachmentBuffer('fid-1', fakeFile('hello'))
    const buf = await getAttachmentBuffer({ fileId: 'fid-1', url: 'https://x/no-network' })

    expect(new TextDecoder().decode(buf)).toBe('hello')
    expect(fetchBufferMock).not.toHaveBeenCalled()
  })

  it('未 prime 时按需 fetchBuffer，并存入缓存（ 第三方 CDN）', async () => {
    fetchBufferMock.mockResolvedValue(okFetch('world'))

    const buf1 = await getAttachmentBuffer({ fileId: 'fid-2', url: 'https://cdn.example/a.bin' })
    const buf2 = await getAttachmentBuffer({ fileId: 'fid-2', url: 'https://cdn.example/a.bin' })
    expect(new TextDecoder().decode(buf1)).toBe('world')
    expect(new TextDecoder().decode(buf2)).toBe('world')
    expect(buf2).not.toBe(buf1)
    expect(fetchBufferMock).toHaveBeenCalledTimes(1)
    expect(fetchBufferMock).toHaveBeenCalledWith({ url: 'https://cdn.example/a.bin' })
  })

  it('下游 transfer 毒化调用方副本后，缓存仍可再次交出可读 buffer', async () => {
    fetchBufferMock.mockResolvedValue(okFetch('%PDF-fake'))

    const first = await getAttachmentBuffer({
      fileId: 'fid-detach',
      url: 'https://cdn.example/resume.pdf',
    })
    const ch = new MessageChannel()
    ch.port1.postMessage(first, [first])
    expect(first.byteLength).toBe(0)

    const second = await getAttachmentBuffer({
      fileId: 'fid-detach',
      url: 'https://cdn.example/resume.pdf',
    })
    expect(new TextDecoder().decode(second)).toBe('%PDF-fake')
    expect(second.byteLength).toBeGreaterThan(0)
    expect(fetchBufferMock).toHaveBeenCalledTimes(1)
  })

  it('若缓存里的源 buffer 已被 detach，丢弃并重新 fetch', async () => {
    fetchBufferMock
      .mockResolvedValueOnce(okFetch('poison'))
      .mockResolvedValueOnce(okFetch('recovered'))

    await getAttachmentBuffer({
      fileId: 'fid-poison-cache',
      url: 'https://cdn.example/x.pdf',
    })
    expect(_detachCachedBufferForTest('fid-poison-cache')).toBe(true)

    const recovered = await getAttachmentBuffer({
      fileId: 'fid-poison-cache',
      url: 'https://cdn.example/x.pdf',
    })
    expect(new TextDecoder().decode(recovered)).toBe('recovered')
    expect(fetchBufferMock).toHaveBeenCalledTimes(2)
  })

  it('blob: URL 走 renderer 原生 fetch，不走 fetchBuffer', async () => {
    const buffer = new TextEncoder().encode('from-blob').buffer
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(buffer),
    } as Response)

    const buf = await getAttachmentBuffer({ url: 'blob:http://localhost/abc' })
    expect(new TextDecoder().decode(buf)).toBe('from-blob')
    expect(fetchSpy).toHaveBeenCalledWith(
      'blob:http://localhost/abc',
      { signal: expect.any(AbortSignal) },
    )
    expect(fetchBufferMock).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('生产 CDN 通过主进程 fetchBuffer 下载且不走 renderer 网络请求', async () => {
    fetchBufferMock.mockResolvedValue(okFetch('from-production-cdn'))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const result = await getAttachmentBuffer({
      fileId: 'cdn-history-pdf',
      url: 'https://assets.example.com/chat/history.pdf?signature=secret',
    })

    expect(new TextDecoder().decode(result)).toBe('from-production-cdn')
    expect(fetchBufferMock).toHaveBeenCalledWith({
      url: 'https://assets.example.com/chat/history.pdf?signature=secret',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('fetchBuffer 拒绝 CDN 请求后不降级到 renderer 网络请求', async () => {
    fetchBufferMock.mockResolvedValue({ success: false, error: 'Request blocked' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(getAttachmentBuffer({
      url: 'https://assets.example.com/chat/rejected.pdf?signature=secret',
    })).rejects.toThrow('Request blocked')
    expect(fetchBufferMock).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('远程失败且有 fileId 时换新链再拉', async () => {
    fetchBufferMock
      .mockResolvedValueOnce({ success: false, error: 'HTTP 403' })
      .mockResolvedValueOnce(okFetch('fresh'))
    resolveOssFileAccessUrlMock.mockResolvedValue('https://cdn.example/fresh.bin')

    const buf = await getAttachmentBuffer({
      fileId: 'fid-3',
      url: 'https://cdn.example/stale.bin',
    })
    expect(new TextDecoder().decode(buf)).toBe('fresh')
    expect(resolveOssFileAccessUrlMock).toHaveBeenCalledWith('fid-3', { forceRefresh: true })
    expect(fetchBufferMock).toHaveBeenCalledTimes(2)
    expect(fetchBufferMock).toHaveBeenLastCalledWith({ url: 'https://cdn.example/fresh.bin' })
  })

  it('强刷返回相同 URL 时仍重试一次瞬时失败', async () => {
    const url = 'https://cdn.example/same-signed.bin'
    fetchBufferMock
      .mockResolvedValueOnce({ success: false, error: 'HTTP 503' })
      .mockResolvedValueOnce(okFetch('recovered'))
    resolveOssFileAccessUrlMock.mockResolvedValue(url)

    const buf = await getAttachmentBuffer({ fileId: 'fid-same-url', url })

    expect(new TextDecoder().decode(buf)).toBe('recovered')
    expect(fetchBufferMock).toHaveBeenCalledTimes(2)
    expect(fetchBufferMock).toHaveBeenLastCalledWith({ url })
  })

  it('远程失败时优先使用调用方提供的鉴权 URL 刷新器', async () => {
    const resolveFreshUrl = vi.fn().mockResolvedValue('https://assets.example.com/space-fresh.bin')
    fetchBufferMock
      .mockResolvedValueOnce({ success: false, error: 'HTTP 403' })
      .mockResolvedValueOnce(okFetch('space-authorized'))

    const result = await getAttachmentBuffer({
      fileId: 'fid-space',
      url: 'https://assets.example.com/space-stale.bin',
      resolveFreshUrl,
    })

    expect(new TextDecoder().decode(result)).toBe('space-authorized')
    expect(resolveFreshUrl).toHaveBeenCalledTimes(1)
    expect(resolveOssFileAccessUrlMock).not.toHaveBeenCalled()
  })

  it('并发同 key 的 get 只触发一次 fetch（in-flight dedup）', async () => {
    let resolve!: (v: ReturnType<typeof okFetch>) => void
    fetchBufferMock.mockImplementation(() => new Promise(r => { resolve = r }))

    const p1 = getAttachmentBuffer({ url: 'https://x/y.bin' })
    const p2 = getAttachmentBuffer({ url: 'https://x/y.bin' })
    resolve(okFetch('x'))
    await Promise.all([p1, p2])
    expect(fetchBufferMock).toHaveBeenCalledTimes(1)
  })

  it('一个并发消费者取消时不影响仍在等待的消费者', async () => {
    let resolve!: (v: ReturnType<typeof okFetch>) => void
    fetchBufferMock.mockImplementation(() => new Promise(r => { resolve = r }))
    const firstController = new AbortController()
    const secondController = new AbortController()

    const first = getAttachmentBuffer({
      url: 'https://x/shared.bin',
      signal: firstController.signal,
    })
    const second = getAttachmentBuffer({
      url: 'https://x/shared.bin',
      signal: secondController.signal,
    })
    firstController.abort()
    resolve(okFetch('shared'))

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(new TextDecoder().decode(await second)).toBe('shared')
    expect(fetchBufferMock).toHaveBeenCalledTimes(1)
  })

  it('session reset 中止在途下载且旧请求不能回填或删除新代际缓存', async () => {
    let resolveOld!: (v: ReturnType<typeof okFetch>) => void
    fetchBufferMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
      .mockResolvedValue(okFetch('new-session'))

    const oldRequest = getAttachmentBuffer({
      fileId: 'same-file',
      url: 'https://x/old.bin',
    })
    await Promise.resolve()
    _clearAttachmentBlobCache()

    const newRequest = getAttachmentBuffer({
      fileId: 'same-file',
      url: 'https://x/new.bin',
    })
    resolveOld(okFetch('old-session'))

    await expect(oldRequest).rejects.toMatchObject({ name: 'AbortError' })
    expect(new TextDecoder().decode(await newRequest)).toBe('new-session')
    const cached = await getAttachmentBuffer({
      fileId: 'same-file',
      url: 'https://x/new.bin',
    })
    expect(new TextDecoder().decode(cached)).toBe('new-session')
    expect(fetchBufferMock).toHaveBeenCalledTimes(2)
  })

  it('fetch 失败时抛错且不留 in-flight 残留（下次重试可成功）', async () => {
    fetchBufferMock
      .mockResolvedValueOnce({ success: false, error: 'HTTP 500' })
      .mockResolvedValueOnce(okFetch('ok'))

    await expect(getAttachmentBuffer({ url: 'https://x/z.bin' })).rejects.toThrow(/HTTP 500/)
    const retry = await getAttachmentBuffer({ url: 'https://x/z.bin' })
    expect(new TextDecoder().decode(retry)).toBe('ok')
    expect(fetchBufferMock).toHaveBeenCalledTimes(2)
  })

  it('HTTP 404 写入负缓存：同 url 连续两次只触发一次 fetchBuffer', async () => {
    fetchBufferMock.mockResolvedValue({ success: false, error: 'HTTP 404' })

    await expect(
      getAttachmentBuffer({ url: 'https://cdn.example/missing.png' }),
    ).rejects.toThrow(/HTTP 404/)
    expect(isAttachmentNegativeCached({ url: 'https://cdn.example/missing.png' })).toBe(true)

    await expect(
      getAttachmentBuffer({ url: 'https://cdn.example/missing.png' }),
    ).rejects.toThrow(/HTTP 404/)
    expect(fetchBufferMock).toHaveBeenCalledTimes(1)
  })

  it('HTTP 410 同样负缓存；_clear 后可再请求', async () => {
    fetchBufferMock
      .mockResolvedValueOnce({ success: false, error: 'HTTP 410 Gone' })
      .mockResolvedValueOnce(okFetch('back'))

    await expect(
      getAttachmentBuffer({ url: 'https://cdn.example/gone.bin' }),
    ).rejects.toThrow(/HTTP 410/)
    await expect(
      getAttachmentBuffer({ url: 'https://cdn.example/gone.bin' }),
    ).rejects.toThrow(/HTTP 410/)
    expect(fetchBufferMock).toHaveBeenCalledTimes(1)

    _clearAttachmentBlobCache()
    expect(isAttachmentNegativeCached({ url: 'https://cdn.example/gone.bin' })).toBe(false)

    const buf = await getAttachmentBuffer({ url: 'https://cdn.example/gone.bin' })
    expect(new TextDecoder().decode(buf)).toBe('back')
    expect(fetchBufferMock).toHaveBeenCalledTimes(2)
  })

  it('成功 fetch 清除该 key 负缓存', async () => {
    fetchBufferMock
      .mockResolvedValueOnce({ success: false, error: 'HTTP 404' })
      .mockResolvedValueOnce(okFetch('recovered'))

    await expect(
      getAttachmentBuffer({ url: 'https://cdn.example/flaky.bin' }),
    ).rejects.toThrow(/HTTP 404/)
    expect(isAttachmentNegativeCached({ url: 'https://cdn.example/flaky.bin' })).toBe(true)

    _clearAttachmentBlobCache()
    const buf = await getAttachmentBuffer({ url: 'https://cdn.example/flaky.bin' })
    expect(new TextDecoder().decode(buf)).toBe('recovered')
    expect(isAttachmentNegativeCached({ url: 'https://cdn.example/flaky.bin' })).toBe(false)
  })
})
