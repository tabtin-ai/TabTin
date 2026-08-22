/**
 * W3 收尾：Electron `runTempPptxParse` 端到端单测
 *
 * 测试策略：
 *   - mock fetch 三段（presign / OSS PUT / parse-sync），断言 host 串接
 *     正确（请求 URL / body / headers / signal 透传）
 *   - mock TokenManager + API_BASE_URL（与 cloud-summary 测试同款）
 *   - 用真临时文件 + fs.stat 让 host 真读 buffer + size
 *   - 13 类 failure_code 自动遍历 SSoT 钉死 envelope 派发对得上
 *
 * 必须钉死的链路：
 *   1. presign 成功 → PUT 成功 → parse-sync 成功 → 返 chunks
 *   2. presign 失败（HTTP / business） → NETWORK_ERROR / SSoT failure_code
 *   3. PUT 失败（HTTP 5xx / fetch reject）→ NETWORK_ERROR
 *   4. parse-sync 失败（HTTP / business）→ NETWORK_ERROR / SSoT failure_code
 *   5. token 缺失 → NETWORK_ERROR + 不调 fetch
 *   6. fs 失败（不存在文件）→ FILE_NOT_FOUND
 *   7. abortSignal abort → USER_ABORTED
 *   8. 超时（AbortSignal.timeout）→ PARSE_TIMEOUT
 */

import { promises as fsPromises, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron-log', () => {
  const noop = () => {}
  const logObj = {
    info: noop, warn: noop, error: noop, debug: noop,
    log: noop, verbose: noop, silly: noop,
  }
  return {
    default: {
      transports: { file: { level: 'info' }, console: { level: 'info' } },
      create: () => logObj,
      scope: () => logObj,
      ...logObj,
    },
  }
})

vi.mock('../../auth', () => ({
  TokenManager: {
    getAccessToken: vi.fn().mockResolvedValue('test-token'),
  },
}))

vi.mock('../../config/api', () => ({
  API_BASE_URL: 'https://api.test.local',
}))

const { runTempPptxParse } = await import('../tempPptxParse')
const { TokenManager } = await import('../../auth')
const { FILE_PIPELINE_ERROR_KINDS, FilePipelineErrorCode } = await import(
  '@tabtin/local-docparse'
)

const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'

let tmpDir: string
let pptxPath: string

beforeEach(async () => {
  vi.unstubAllGlobals()
  ;(TokenManager.getAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue('test-token')

  const raw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'temp-pptx-test-'))
  tmpDir = await fsPromises.realpath(raw)
  pptxPath = path.join(tmpDir, 'sample.pptx')
  // 写一个最小"伪 PPTX"：4 字节 ZIP 头 + padding（host 读 size + buffer 即可，
  // 不调真 parser；后端真实校验由后端单测覆盖）
  writeFileSync(pptxPath, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2048, 0)]))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  await fsPromises.rm(tmpDir, { recursive: true, force: true })
})

function setupFetchMock(responses: Array<{ ok: boolean; status?: number; body: unknown }>) {
  const fetchMock = vi.fn()
  for (const r of responses) {
    fetchMock.mockResolvedValueOnce({
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    })
  }
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('runTempPptxParse — happy path', () => {
  it('chains presign → PUT → parse-sync; returns success with chunks', async () => {
    const fetchMock = setupFetchMock([
      // 1. presign
      {
        ok: true,
        body: {
          success: true,
          presigned_url: 'https://oss.test/signed-put',
          temp_object_key: 'temp-parse/testuser/abcdef.pptx',
          expires_in: 3600,
        },
      },
      // 2. OSS PUT
      { ok: true, body: {} },
      // 3. parse-sync
      {
        ok: true,
        body: {
          success: true,
          chunks: [
            { type: 'heading', content: 'Hello', page: 1, heading_level: 1 },
            { type: 'paragraph', content: 'World', page: 1 },
          ],
          duration_ms: 432,
          pages: 1,
          title: 'Hello',
        },
      },
    ])

    const result = await runTempPptxParse(pptxPath, PPTX_MIME, {
      timeoutMs: 30_000,
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error('unreachable')

    expect(result.chunks).toHaveLength(2)
    expect(result.pages).toBe(1)
    expect(result.title).toBe('Hello')
    expect(result.fileSizeBytes).toBeGreaterThan(0)

    // 三次 fetch 都被调
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // 第 1 次：presign 调 backend，body 含 file_name + size + mime
    const presignCall = fetchMock.mock.calls[0]!
    expect(presignCall[0]).toBe('https://api.test.local/services/oss/temp-parse-presign')
    const presignBody = JSON.parse(presignCall[1].body)
    expect(presignBody.file_name).toBe('sample.pptx')
    expect(presignBody.mime_type).toBe(PPTX_MIME)
    expect(presignBody.file_size_bytes).toBeGreaterThan(0)
    expect(presignCall[1].headers.Authorization).toBe('Bearer test-token')

    // 第 2 次：OSS PUT 走 presigned URL，无 Authorization（presigned 自带签名）
    const putCall = fetchMock.mock.calls[1]!
    expect(putCall[0]).toBe('https://oss.test/signed-put')
    expect(putCall[1].method).toBe('PUT')
    expect(putCall[1].headers['Content-Type']).toBe(PPTX_MIME)
    expect(putCall[1].headers['Authorization']).toBeUndefined()

    // 第 3 次：parse-sync
    const parseCall = fetchMock.mock.calls[2]!
    expect(parseCall[0]).toBe('https://api.test.local/services/docparse/parse-sync-temp')
    const parseBody = JSON.parse(parseCall[1].body)
    expect(parseBody.temp_object_key).toBe('temp-parse/testuser/abcdef.pptx')
    expect(parseBody.mime_type).toBe(PPTX_MIME)
  })
})

describe('runTempPptxParse — failure paths', () => {
  it('no token → NETWORK_ERROR + does not call fetch', async () => {
    ;(TokenManager.getAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await runTempPptxParse(pptxPath, PPTX_MIME, { timeoutMs: 30_000 })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('unreachable')
    expect(result.errorClass).toBe(FilePipelineErrorCode.NETWORK_ERROR)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('file does not exist → FILE_NOT_FOUND', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await runTempPptxParse(
      path.join(tmpDir, 'nonexistent.pptx'),
      PPTX_MIME,
      { timeoutMs: 30_000 },
    )
    expect(result.success).toBe(false)
    if (result.success) throw new Error('unreachable')
    expect(result.errorClass).toBe(FilePipelineErrorCode.FILE_NOT_FOUND)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('presign HTTP 500 → NETWORK_ERROR', async () => {
    setupFetchMock([{ ok: false, status: 500, body: { error: 'oss-down' } }])
    const result = await runTempPptxParse(pptxPath, PPTX_MIME, { timeoutMs: 30_000 })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('unreachable')
    expect(result.errorClass).toBe(FilePipelineErrorCode.NETWORK_ERROR)
  })

  it('presign success=false business error → SSoT failure code from error_code', async () => {
    setupFetchMock([
      {
        ok: true,
        body: {
          success: false,
          message: 'mime not in whitelist',
          error_code: FilePipelineErrorCode.UNSUPPORTED_FORMAT,
        },
      },
    ])
    const result = await runTempPptxParse(pptxPath, PPTX_MIME, { timeoutMs: 30_000 })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('unreachable')
    expect(result.errorClass).toBe(FilePipelineErrorCode.UNSUPPORTED_FORMAT)
  })

  it('OSS PUT HTTP 503 → NETWORK_ERROR', async () => {
    setupFetchMock([
      {
        ok: true,
        body: {
          success: true,
          presigned_url: 'https://oss.test/x',
          temp_object_key: 'temp-parse/u/y.pptx',
          expires_in: 3600,
        },
      },
      { ok: false, status: 503, body: { error: 'service-unavailable' } },
    ])
    const result = await runTempPptxParse(pptxPath, PPTX_MIME, { timeoutMs: 30_000 })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('unreachable')
    expect(result.errorClass).toBe(FilePipelineErrorCode.NETWORK_ERROR)
  })

  it.each(FILE_PIPELINE_ERROR_KINDS)(
    'parse-sync returns failure_code=%s → adapter envelope errorClass = %s (SSoT 13 类自动遍历)',
    async (failureCode) => {
      setupFetchMock([
        {
          ok: true,
          body: {
            success: true,
            presigned_url: 'https://oss.test/x',
            temp_object_key: 'temp-parse/u/y.pptx',
            expires_in: 3600,
          },
        },
        { ok: true, body: {} },
        {
          ok: true,
          body: {
            success: false,
            message: `representative msg for ${failureCode}`,
            failure_code: failureCode,
          },
        },
      ])
      const result = await runTempPptxParse(pptxPath, PPTX_MIME, { timeoutMs: 30_000 })
      expect(result.success).toBe(false)
      if (result.success) throw new Error('unreachable')
      expect(result.errorClass).toBe(failureCode)
    },
  )
})

describe('runTempPptxParse — abort + timeout', () => {
  it('caller aborts → USER_ABORTED', async () => {
    const ac = new AbortController()
    // presign 在 host 调 fetch 时立刻 abort
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      ac.abort()
      const sig: AbortSignal = init.signal
      // mimic real fetch: throw AbortError when signal aborted
      if (sig.aborted) {
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        throw err
      }
      return { ok: true, json: async () => ({}), text: async () => '' }
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await runTempPptxParse(pptxPath, PPTX_MIME, {
      timeoutMs: 30_000,
      signal: ac.signal,
    })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('unreachable')
    expect(result.errorClass).toBe(FilePipelineErrorCode.USER_ABORTED)
  })

  it('fetch raises TimeoutError → PARSE_TIMEOUT', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      const err = new Error('The operation timed out')
      err.name = 'TimeoutError'
      throw err
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await runTempPptxParse(pptxPath, PPTX_MIME, { timeoutMs: 30_000 })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('unreachable')
    expect(result.errorClass).toBe(FilePipelineErrorCode.PARSE_TIMEOUT)
  })
})

// W4 (2026-05-13) L51 + L52 钉死（反思 §八 #14 修了不补测试 + #15 教训不对称应用）。
// Daemon 端已有同款测试钉死；本组让 Electron 端对称。
describe('runTempPptxParse — W4 L51 per-fetch token rotation', () => {
  it('re-awaits TokenManager.getAccessToken before parse-sync (not just presign) — covers long-flow token rotation', async () => {
    // 让 TokenManager 返序列化 token 列表：第 1 次 'tk-presign'，第 2 次 'tk-parse-sync'。
    const tokens = ['tk-presign', 'tk-parse-sync']
    let i = 0
    ;(TokenManager.getAccessToken as ReturnType<typeof vi.fn>).mockImplementation(
      async () => tokens[i++ % tokens.length],
    )

    const presignBody = {
      success: true,
      presigned_url: 'https://oss.test/p',
      temp_object_key: 'temp-parse/u/x.pptx',
      expires_in: 3600,
    }
    const parseSyncBody = {
      success: true,
      chunks: [],
      duration_ms: 1,
      pages: 0,
      title: '',
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => presignBody, text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}), text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => parseSyncBody, text: async () => '' })
    vi.stubGlobal('fetch', fetchMock)

    await runTempPptxParse(pptxPath, PPTX_MIME, { timeoutMs: 30_000 })

    const calls = fetchMock.mock.calls
    const presignHeaders = (calls[0]![1] as RequestInit).headers as Record<string, string>
    const parseSyncHeaders = (calls[2]![1] as RequestInit).headers as Record<string, string>
    expect(presignHeaders.Authorization).toBe('Bearer tk-presign')
    expect(parseSyncHeaders.Authorization).toBe('Bearer tk-parse-sync')
    // OSS PUT (calls[1]) 不带 Authorization（presigned URL 自签名）
  })
})

describe('runTempPptxParse — W4 L52 fetch 5xx one-shot retry', () => {
  it('presign 503 then 200 → 2 fetch calls + success (5xx auto retry once with backoff)', async () => {
    const presignBody = {
      success: true,
      presigned_url: 'https://oss.test/p',
      temp_object_key: 'temp-parse/u/x.pptx',
      expires_in: 3600,
    }
    const parseSyncBody = {
      success: true,
      chunks: [],
      duration_ms: 1,
      pages: 0,
      title: '',
    }
    const fetchMock = vi.fn()
      // presign: 503 first → retry 200
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}), text: async () => 'busy' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => presignBody, text: async () => '' })
      // PUT
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}), text: async () => '' })
      // parse-sync
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => parseSyncBody, text: async () => '' })
    vi.stubGlobal('fetch', fetchMock)

    const result = await runTempPptxParse(pptxPath, PPTX_MIME, { timeoutMs: 30_000 })
    expect(result.success).toBe(true)
    // 4 total fetch calls: presign-503 + presign-200 + PUT + parse-sync
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('OSS PUT 502 then 200 → 4 fetch calls + success (5xx auto retry once on PUT)', async () => {
    const presignBody = {
      success: true,
      presigned_url: 'https://oss.test/p',
      temp_object_key: 'temp-parse/u/x.pptx',
      expires_in: 3600,
    }
    const parseSyncBody = {
      success: true,
      chunks: [],
      duration_ms: 1,
      pages: 0,
      title: '',
    }
    const fetchMock = vi.fn()
      // presign 200
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => presignBody, text: async () => '' })
      // OSS PUT: 502 first → retry 200
      .mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}), text: async () => 'bad gateway' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}), text: async () => '' })
      // parse-sync
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => parseSyncBody, text: async () => '' })
    vi.stubGlobal('fetch', fetchMock)

    const result = await runTempPptxParse(pptxPath, PPTX_MIME, { timeoutMs: 30_000 })
    expect(result.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(4) // presign + PUT-fail + PUT-retry + parse-sync
  })

  it('presign 4xx (not 5xx) → NO retry (immediate fail)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}), text: async () => 'bad request' })
    vi.stubGlobal('fetch', fetchMock)

    const result = await runTempPptxParse(pptxPath, PPTX_MIME, { timeoutMs: 30_000 })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('unreachable')
    expect(result.errorClass).toBe(FilePipelineErrorCode.NETWORK_ERROR)
    // 4xx 不 retry：1 次 fetch
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// W5 L60：流式 PUT 消 OOM 风险。
// 旧实现 readFile 全文 buffer + fetch BodyInit copy → 50MB 文件内存 ~100MB。
// 新实现 createReadStream + Readable.toWeb → 内存峰值 < 1MB（与文件大小解耦）。
//
// 这组测试钉死实现：
//   1. PUT body 是 ReadableStream（不是 Buffer / Uint8Array）
//   2. PUT init 含 duplex='half'（Undici 流式 body 硬要求）
//   3. Content-Length 正确（来自 fs.stat，不是 buffer.length）
//   4. host 不再 fsPromises.readFile 全文（用 spy 钉死调用次数 = 0）
//   5. PUT 5xx retry 不复用 stream（必须重新 createReadStream，否则消耗后再读 = 0 字节）
describe('runTempPptxParse — W5 L60 streaming PUT body (OOM 防御)', () => {
  it('PUT body 是 ReadableStream，含 duplex=half；Content-Length 取 fs.stat size 不取 buffer.length', async () => {
    const presignBody = {
      success: true,
      presigned_url: 'https://oss.test/p',
      temp_object_key: 'temp-parse/u/x.pptx',
      expires_in: 3600,
    }
    const parseSyncBody = {
      success: true,
      chunks: [],
      duration_ms: 1,
      pages: 0,
      title: '',
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => presignBody, text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}), text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => parseSyncBody, text: async () => '' })
    vi.stubGlobal('fetch', fetchMock)

    const result = await runTempPptxParse(pptxPath, PPTX_MIME, { timeoutMs: 30_000 })
    expect(result.success).toBe(true)

    const putCall = fetchMock.mock.calls[1]!
    const putInit = putCall[1] as RequestInit & { duplex?: string }

    // 钉死流式 body：是 ReadableStream，不是 Buffer
    expect(putInit.body).toBeDefined()
    expect(putInit.body).toBeInstanceOf(ReadableStream)
    expect(Buffer.isBuffer(putInit.body)).toBe(false)

    // 钉死 duplex='half'（Undici 流式 body 硬要求；漏掉这个 fetch 会立即 throw）
    expect(putInit.duplex).toBe('half')

    // Content-Length 正确（来自 fs.stat 非 buffer.length；fixture 是 4 字节 ZIP 头 + 2048 字节 padding = 2052）
    const headers = putInit.headers as Record<string, string>
    expect(headers['Content-Length']).toBe('2052')
    expect(headers['Content-Type']).toBe(PPTX_MIME)
  })

  it('host 不再 fsPromises.readFile 全文加载（spy 钉死 readFile 调用次数 = 0）', async () => {
    // spy fsPromises.readFile —— 旧实现一定会调，新实现绝不能调
    const readFileSpy = vi.spyOn(fsPromises, 'readFile')

    const presignBody = {
      success: true,
      presigned_url: 'https://oss.test/p',
      temp_object_key: 'temp-parse/u/x.pptx',
      expires_in: 3600,
    }
    const parseSyncBody = {
      success: true, chunks: [], duration_ms: 1, pages: 0, title: '',
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => presignBody, text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}), text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => parseSyncBody, text: async () => '' })
    vi.stubGlobal('fetch', fetchMock)

    await runTempPptxParse(pptxPath, PPTX_MIME, { timeoutMs: 30_000 })

    // 关键钉死：host 0 次 readFile（buf 完全消失）
    expect(readFileSpy).not.toHaveBeenCalled()
    readFileSpy.mockRestore()
  })

  it('PUT 5xx retry 重新 createReadStream（不能复用消耗后的 stream）', async () => {
    const presignBody = {
      success: true,
      presigned_url: 'https://oss.test/p',
      temp_object_key: 'temp-parse/u/x.pptx',
      expires_in: 3600,
    }
    const parseSyncBody = {
      success: true, chunks: [], duration_ms: 1, pages: 0, title: '',
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => presignBody, text: async () => '' })
      // PUT: 502 first → retry 200
      .mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}), text: async () => 'bad gateway' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}), text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => parseSyncBody, text: async () => '' })
    vi.stubGlobal('fetch', fetchMock)

    const result = await runTempPptxParse(pptxPath, PPTX_MIME, { timeoutMs: 30_000 })
    expect(result.success).toBe(true)

    // 钉死：两次 PUT call 各自有自己的 ReadableStream（identity 不同）
    const put1 = fetchMock.mock.calls[1]![1] as RequestInit
    const put2 = fetchMock.mock.calls[2]![1] as RequestInit
    expect(put1.body).toBeInstanceOf(ReadableStream)
    expect(put2.body).toBeInstanceOf(ReadableStream)
    expect(put1.body).not.toBe(put2.body) // identity 不同 → 真重新开了 stream
  })
})
