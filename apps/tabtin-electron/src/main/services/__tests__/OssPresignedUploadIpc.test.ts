import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OSS_CANCEL_PRESIGNED_DOWNLOAD_CHANNEL,
  OSS_GET_PRESIGNED_OBJECT_CHANNEL,
} from '../../../shared/oss-presigned-upload-ipc'

vi.mock('../../utils/guarded-handle', () => ({
  guardedHandle: vi.fn(),
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

import {
  formatOssUploadLog,
  getOssNetworkCauseCode,
  readResponseBodyWithLimit,
  registerOssPresignedUploadIpc,
  validatePresignedDownloadUrl,
  validatePresignedUrl,
} from '../OssPresignedUploadIpc'
import { guardedHandle } from '../../utils/guarded-handle'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('validatePresignedUrl', () => {
  it('accepts the exact configured LAN API local-upload endpoint in packaged builds', () => {
    const url = validatePresignedUrl(
      'http://192.168.8.10:8080/api/services/oss/local-upload?object_key=demo.png&method=PUT&expires=300&signature=abc',
      { isPackaged: true, apiBaseUrl: 'http://192.168.8.10:8080/api' },
    )
    expect(url?.hostname).toBe('192.168.8.10')
    expect(url?.pathname).toBe('/api/services/oss/local-upload')
  })

  it('accepts the exact configured cloud HTTPS API local-upload endpoint', () => {
    expect(validatePresignedUrl(
      'https://tabtin.example.com/api/services/oss/local-upload?signature=abc',
      { isPackaged: true, apiBaseUrl: 'https://tabtin.example.com/api' },
    )).not.toBeNull()
  })

  it('accepts Aliyun OSS HTTPS bucket URLs', () => {
    const url = validatePresignedUrl('https://example-assets.oss-cn-shanghai.aliyuncs.com/chat/demo.png?sig=abc')
    expect(url?.hostname).toBe('example-assets.oss-cn-shanghai.aliyuncs.com')
  })

  it.each([
    'http://evil.example.com/api/services/oss/local-upload?signature=abc',
    'http://user:pass@192.168.8.10:8080/api/services/oss/local-upload?signature=abc',
    'http://192.168.8.10:8080/api/other?signature=abc',
    'http://192.168.8.10:8081/api/services/oss/local-upload?signature=abc',
    'https://example-assets.oss-cn-shanghai.aliyuncs.com:8443/chat/demo.png?sig=abc',
    'https://user:pass@example-assets.oss-cn-shanghai.aliyuncs.com/chat/demo.png?sig=abc',
    'http://example-assets.oss-cn-shanghai.aliyuncs.com/chat/demo.png?sig=abc',
  ])('rejects untrusted upload URL %s', (rawUrl) => {
    expect(validatePresignedUrl(rawUrl, {
      isPackaged: true,
      apiBaseUrl: 'http://192.168.8.10:8080/api',
    })).toBeNull()
  })
})

describe('validatePresignedDownloadUrl', () => {
  it('accepts standard-port Aliyun OSS in packaged builds', () => {
    expect(validatePresignedDownloadUrl(
      'https://example-assets.oss-cn-shanghai.aliyuncs.com/chat/demo.docx?signature=secret',
      { isPackaged: true, apiBaseUrl: 'https://api-preprod.example.com/api' },
    )).not.toBeNull()
  })

  it('accepts only the exact production asset CDN host over standard HTTPS', () => {
    expect(validatePresignedDownloadUrl(
      'https://assets.example.com/chat/history.pdf?signature=secret',
      { isPackaged: true, apiBaseUrl: 'https://api-preprod.example.com/api' },
    )?.hostname).toBe('assets.example.com')
  })

  it('accepts the configured LAN API origin on local-object in packaged builds', () => {
    expect(validatePresignedDownloadUrl(
      'http://192.168.8.10:8080/api/services/oss/local-object?object_key=chat%2Fdemo.xlsx',
      { isPackaged: true, apiBaseUrl: 'http://192.168.8.10:8080/api' },
    )).not.toBeNull()
  })

  it('accepts the configured cloud HTTPS API origin on local-object', () => {
    expect(validatePresignedDownloadUrl(
      'https://tabtin.example.com/api/services/oss/local-object?object_key=chat%2Fdemo.xlsx',
      { isPackaged: true, apiBaseUrl: 'https://tabtin.example.com/api' },
    )).not.toBeNull()
  })

  it.each([
    'https://evil.example.com/demo.docx?signature=secret',
    'https://user:pass@example-assets.oss-cn-shanghai.aliyuncs.com/demo.pdf',
    'https://example-assets.oss-cn-shanghai.aliyuncs.com:8443/demo.pdf',
    'https://assets.example.com.evil.test/demo.pdf',
    'https://evil.assets.example.com/demo.pdf',
    'https://user:pass@assets.example.com/demo.pdf',
    'https://assets.example.com:8443/demo.pdf',
    'http://127.0.0.1:6061/api/services/oss/local-object?object_key=demo.xlsx',
    'http://[::1]:6060/api/services/oss/local-object?object_key=demo.xlsx',
    'http://127.0.0.1:6060/api/services/oss/local-upload?object_key=demo.xlsx',
  ])('rejects untrusted object URL %s', (rawUrl) => {
    expect(validatePresignedDownloadUrl(rawUrl, {
      isPackaged: false,
      apiBaseUrl: 'http://127.0.0.1:6060/api',
    })).toBeNull()
  })

  it('rejects a LAN local-object when packaged API config points to another origin', () => {
    expect(validatePresignedDownloadUrl(
      'http://192.168.8.10:8080/api/services/oss/local-object?object_key=demo.xlsx',
      { isPackaged: true, apiBaseUrl: 'https://api.example.com/api' },
    )).toBeNull()
  })
})

describe('readResponseBodyWithLimit', () => {
  it('accepts a response exactly at the byte limit', async () => {
    const data = await readResponseBodyWithLimit(
      new Response(new Uint8Array([1, 2, 3])),
      3,
    )
    expect(Array.from(new Uint8Array(data))).toEqual([1, 2, 3])
  })

  it('stops reading once a response exceeds the byte limit', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const onLimitExceeded = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]))
      },
      cancel,
    })
    await expect(readResponseBodyWithLimit(
      new Response(stream),
      3,
      onLimitExceeded,
    )).rejects.toThrow('OSS object exceeds preview limit')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(onLimitExceeded).toHaveBeenCalledTimes(1)
  })
})

describe('OSS presigned download handler', () => {
  function registeredHandler(channel: string) {
    return vi.mocked(guardedHandle).mock.calls.find(([registered]) => registered === channel)?.[1]
  }

  it('does not automatically follow redirects', async () => {
    vi.mocked(guardedHandle).mockClear()
    registerOssPresignedUploadIpc()
    const handler = registeredHandler(OSS_GET_PRESIGNED_OBJECT_CHANNEL)
    expect(handler).toBeTypeOf('function')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example.com/file' },
      }),
    )

    const result = await handler?.(
      {} as Parameters<NonNullable<typeof handler>>[0],
      {
        requestId: 'redirect-test',
        presignedUrl: 'https://assets.example.com/file.docx?signature=secret',
      },
    )

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: 'manual' }),
    )
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'HTTP_ERROR' },
    })
  })

  it('times out and aborts a stalled download', async () => {
    vi.useFakeTimers()
    vi.mocked(guardedHandle).mockClear()
    registerOssPresignedUploadIpc()
    const handler = registeredHandler(OSS_GET_PRESIGNED_OBJECT_CHANNEL)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => (
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    ))

    const pending = handler?.({} as never, {
      requestId: 'timeout-test',
      presignedUrl: 'https://example-assets.oss-cn-shanghai.aliyuncs.com/file.docx?signature=secret',
    })
    await vi.advanceTimersByTimeAsync(60_000)

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'TIMEOUT' },
    })
    expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })

  it('cancels an active download by requestId', async () => {
    vi.mocked(guardedHandle).mockClear()
    registerOssPresignedUploadIpc()
    const handler = registeredHandler(OSS_GET_PRESIGNED_OBJECT_CHANNEL)
    const cancelHandler = registeredHandler(OSS_CANCEL_PRESIGNED_DOWNLOAD_CHANNEL)
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => (
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    ))

    const pending = handler?.({} as never, {
      requestId: 'cancel-test',
      presignedUrl: 'https://example-assets.oss-cn-shanghai.aliyuncs.com/file.docx?signature=secret',
    })
    await Promise.resolve()
    const cancelled = await cancelHandler?.({} as never, 'cancel-test')

    expect(cancelled).toMatchObject({ ok: true, data: { cancelled: true } })
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'ABORTED' },
    })
  })

  it('cancels the response body and aborts when Content-Length is over limit', async () => {
    vi.mocked(guardedHandle).mockClear()
    registerOssPresignedUploadIpc()
    const handler = registeredHandler(OSS_GET_PRESIGNED_OBJECT_CHANNEL)
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const response = new Response(new ReadableStream({ cancel }), {
      status: 200,
      headers: { 'content-length': String(100 * 1024 * 1024 + 1) },
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)

    const result = await handler?.({} as never, {
      requestId: 'content-length-test',
      presignedUrl: 'https://example-assets.oss-cn-shanghai.aliyuncs.com/file.docx?signature=secret',
    })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'PAYLOAD_TOO_LARGE' },
    })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })
})

describe('OSS upload diagnostic redaction', () => {
  it('keeps only a normalized undici cause code', () => {
    const error = new Error('fetch failed') as Error & {
      cause?: { code: string; errno: number; syscall: string }
    }
    error.cause = {
      code: 'ENOTFOUND',
      errno: -3008,
      syscall: 'getaddrinfo',
    }

    expect(getOssNetworkCauseCode(error)).toBe('ENOTFOUND')
  })

  it('rejects an untrusted cause code instead of copying arbitrary error text', () => {
    const error = new Error('https://bucket.example/secret-key?signature=secret') as Error & {
      cause?: { code: string }
    }
    error.cause = { code: 'ENOTFOUND\nsecret-path' }

    expect(getOssNetworkCauseCode(error)).toBe('UNKNOWN')
  })

  it('formats HTTP failures without URL, object key, signed query, or response body', () => {
    const message = formatOssUploadLog({
      uploadId: 'upload-safe-1',
      stage: 'http_failed',
      status: 403,
      durationMs: 123.9,
    })

    expect(message).toBe(
      'oss-put stage=http_failed uploadId=upload-safe-1 status=403 durationMs=123',
    )
    expect(message).not.toMatch(/url|path|key|signature|body/i)
  })

  it('sanitizes uploadId and network cause before logging', () => {
    const message = formatOssUploadLog({
      uploadId: 'upload-1\nhttps://secret.example/path',
      stage: 'network_failed',
      durationMs: 12,
      causeCode: 'ECONNRESET\nsecret',
    })

    expect(message).toBe(
      'oss-put stage=network_failed uploadId=invalid durationMs=12 causeCode=UNKNOWN',
    )
  })

  it('source never sends response text or URL fields to the logger', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/main/services/OssPresignedUploadIpc.ts'),
      'utf8',
    )

    expect(source).not.toContain('response.text(')
    expect(source).not.toMatch(/log\.(?:debug|info|warn|error)\([^)]*(?:url\.|bodyText)/s)
  })
})
