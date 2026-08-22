import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetResourceByUrl = vi.fn()
const mockGetResources = vi.fn()
const mockLegacyGetResources = vi.fn()

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
  },
  net: {
    request: vi.fn(),
  },
}))

vi.mock('../ResourceHubService', () => ({
  getResourceHubService: () => ({
    getResourceByUrl: mockGetResourceByUrl,
    getResources: mockGetResources,
  }),
}))

vi.mock('../ResourceDetectionService', () => ({
  getResourceDetectionService: () => ({
    getResources: mockLegacyGetResources,
  }),
}))

vi.mock('../resourceRequestContext', () => ({
  buildNetRequestOptions: vi.fn(),
  resolveResourceRequestSession: vi.fn(),
}))

vi.mock('../M3U8Parser', () => ({
  M3U8ParseError: class M3U8ParseError extends Error {},
  getM3U8Parser: vi.fn(),
}))

vi.mock('../../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../utils/file-path', () => ({
  getUniquePath: vi.fn((input: string) => input),
  formatBytes: vi.fn((input: number) => `${input}`),
}))

vi.mock('../../download-security', () => ({
  normalizeDownloadFilename: vi.fn((_: string, fallback: string) => fallback),
}))

describe('StreamDownloadService resolveHeaders', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetResourceByUrl.mockReturnValue(undefined)
    mockGetResources.mockReturnValue([])
    mockLegacyGetResources.mockReturnValue([])
  })

  it('优先继承 ResourceHub 中匹配资源的请求头', async () => {
    mockGetResourceByUrl.mockReturnValue({
      requestHeaders: {
        Referer: 'https://app.example/player',
        Cookie: 'sid=abc',
        Origin: 'https://app.example',
      },
    })

    const { StreamDownloadService } = await import('../StreamDownloadService')
    const service = new StreamDownloadService()

    const headers = await (service as any).resolveHeaders({
      url: 'https://cdn.example/master.m3u8',
      viewId: 'view-1',
    })

    expect(headers).toEqual({
      Referer: 'https://app.example/player',
      Cookie: 'sid=abc',
      Origin: 'https://app.example',
    })
    expect(mockLegacyGetResources).not.toHaveBeenCalled()
  })

  it('无继承头时会回退到资源 origin，并允许显式 headers 覆盖', async () => {
    const { StreamDownloadService } = await import('../StreamDownloadService')
    const service = new StreamDownloadService()

    const headers = await (service as any).resolveHeaders({
      url: 'https://cdn.example/master.m3u8',
      headers: {
        Referer: 'https://override.example/ref',
        Authorization: 'Bearer demo',
      },
    })

    expect(headers).toEqual({
      Referer: 'https://override.example/ref',
      Authorization: 'Bearer demo',
    })
  })
})

describe('StreamDownloadService AbortSignal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetResourceByUrl.mockReturnValue(undefined)
    mockGetResources.mockReturnValue([])
    mockLegacyGetResources.mockReturnValue([])
  })

  it('外部 signal 已取消时不解析 manifest，直接返回 DOWNLOAD_ABORTED', async () => {
    const { getM3U8Parser } = await import('../M3U8Parser')
    const parser = { fetchAndParse: vi.fn() }
    vi.mocked(getM3U8Parser).mockReturnValue(parser as any)

    const { StreamDownloadService } = await import('../StreamDownloadService')
    const service = new StreamDownloadService()
    const ctrl = new AbortController()
    ctrl.abort()

    const result = await service.download({
      url: 'https://cdn.example/master.m3u8',
      signal: ctrl.signal,
    })

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('DOWNLOAD_ABORTED')
    expect(parser.fetchAndParse).not.toHaveBeenCalled()
  })
})
