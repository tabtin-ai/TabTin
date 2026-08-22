/**
 * tempPptxParse — Electron host 端 W3 PPTX 临时通道实现
 *
 * 把 `tabcode-adapter` 的 `RunTempPptxParse` 接口适配到 Electron 主进程：
 *
 *   1. fs.stat 拿 size（**W5 L60 流式化**：不再 readFile 整入内存）
 *   2. POST `/services/oss/temp-parse-presign` → 拿 presigned PUT URL +
 *      temp_object_key
 *   3. PUT presigned_url **流式上传**（createReadStream + Readable.toWeb +
 *      duplex: 'half'）—— 50MB 文件内存峰值 < 70MB（含 V8 GC headroom），
 *      取代历史 `body: buf as BodyInit` 一次性 100MB 峰值（buffer 拷贝 +
 *      base64 中间表示在 Node fetch 内部）
 *   4. POST `/services/docparse/parse-sync-temp` → 同步拿 chunks
 *
 * 整条链路接 `signal` 透传 abort —— 用户停止生成时立即 cancel pending
 * presign / put / parse-sync 三个 fetch（与 `fetchCloudSummary` 同款
 * AbortSignal 组合模式）。流式 PUT retry 时每次重新 createReadStream（流不可
 * rewind），保证 retry 行为与原版本等价。
 *
 * 失败时返结构化 `TempPptxParseFailure`（13 类全局 SSoT 字面值），让
 * adapter 一行 `formatFilePipelineError` 派发 envelope。
 */
import { promises as fsPromises, createReadStream } from 'node:fs'
import { Readable } from 'node:stream'

// 用 `@tabtin/local-docparse` re-exported SSoT（与 ElectronAgentHost
// `fetchCloudSummary` 同源）—— Electron package.json 已声明 local-docparse
// dependency，不需要新增 `@tabtin/file-pipeline-errors` 直接依赖。
import {
  FilePipelineErrorCode,
  isFilePipelineErrorCode,
} from '@tabtin/local-docparse'
import type {
  RunTempPptxParse,
  TempPptxParseChunk,
  TempPptxParseResult,
} from '@tabtin/agent-host/tools'

import { API_BASE_URL } from '../config/api.js'
import { joinApiPath } from '@tabtin/config'
import { TokenManager } from '../auth.js'
import { createLogger } from '../logger.js'

const log = createLogger('TempPptxParse')

interface PresignResponseBody {
  success: boolean
  message?: string
  presigned_url?: string
  temp_object_key?: string
  expires_in?: number
  error_code?: string
}

interface ParseSyncResponseBody {
  success: boolean
  message?: string
  failure_code?: string
  chunks?: TempPptxParseChunk[]
  duration_ms?: number
  pages?: number
  title?: string
}

/**
 * 创建 Electron 端的 `runTempPptxParse` 实现（host injection point）。
 *
 * **设计取舍**：
 *   - 用 closure 而不是 class —— 与 `runDocParserTask` 同款 stateless 函数
 *   - token 通过 `TokenManager.getAccessToken()` 实时拿（不持久化引用，
 *     避免 token 旋转后 stale）
 *   - 三段超时分配：presign 5s + PUT 整体超时计算（剩余预算）+ parse-sync
 *     wider 余量。整体上限由 caller 传 `options.timeoutMs`（adapter 默认 30s）
 */
export const runTempPptxParse: RunTempPptxParse = async (
  filePath,
  mimeType,
  options,
): Promise<TempPptxParseResult> => {
  const startedAt = Date.now()
  const elapsedMs = () => Date.now() - startedAt
  const remainingMs = () => Math.max(1_000, options.timeoutMs - elapsedMs())

  // ── 0. fs.stat（W5 L60：不再 readFile 全文到内存——OOM 防御）───────
  //
  // 历史：旧实现 `await fsPromises.readFile(filePath)` 把整个 PPTX (≤50MB)
  // 全文 read 到 Node Buffer，PUT 时 fetch 又把 Buffer 复制进 BodyInit
  // （一份 readFile + 一份 fetch internal body）—— 内存峰值 ~100MB / 50MB
  // 文件，长 session 多次 PPTX read 容易触发 V8 heap 抖动。
  //
  // **W5 L60 修复**：改走 `createReadStream(filePath)` + `Readable.toWeb()`
  // 流式 PUT body，Node fetch 直接消费 stream chunks。内存峰值预期 < 1MB
  // （single chunk size），与文件大小解耦。
  //
  // Node fetch 流式 body 需要：
  //   - Body 是 ReadableStream（Web 标准）；用 `Readable.toWeb` 把 fs ReadStream 转 ReadableStream
  //   - HTTP/1.1 host 需要 `duplex: 'half'` 标记（Undici 要求）
  //   - 必须显式 `Content-Length`，避免 Undici 走 chunked encoding（OSS 个别
  //     servers 拒绝 chunked PUT）
  let fileSize: number
  let filename: string
  try {
    const stat = await fsPromises.stat(filePath)
    fileSize = stat.size
    if (fileSize <= 0) {
      return {
        success: false,
        errorClass: FilePipelineErrorCode.FILE_NOT_FOUND,
        message: `Empty file: ${filePath}`,
        durationMs: elapsedMs(),
      }
    }
    filename = filePath.split(/[\\/]/).pop() ?? 'file.pptx'
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      errorClass: FilePipelineErrorCode.FILE_NOT_FOUND,
      message: `Failed to read local file: ${msg}`,
      durationMs: elapsedMs(),
    }
  }

  // ── 1. 拿 token（L51 收：per-fetch re-await，token rotation 不被闭包锁死）──
  const tokenForPresign = await TokenManager.getAccessToken()
  if (!tokenForPresign) {
    return {
      success: false,
      errorClass: FilePipelineErrorCode.NETWORK_ERROR,
      message: 'No access token available — user not signed in to backend.',
      durationMs: elapsedMs(),
    }
  }

  // ── 2. POST presign（L52：5xx 一次 retry 100ms backoff）──────────
  const presignUrl = joinApiPath(API_BASE_URL, '/services/oss/temp-parse-presign')
  const doPresign = async (): Promise<Response> => {
    const presignSignal = composeSignal(options.signal, Math.min(8_000, remainingMs()))
    return await fetch(presignUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenForPresign}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        file_name: filename,
        file_size_bytes: fileSize,
        mime_type: mimeType,
      }),
      signal: presignSignal,
    })
  }
  let presign: PresignResponseBody
  try {
    let resp = await doPresign()
    if (resp.status >= 500 && resp.status < 600 && remainingMs() > 1_500) {
      await new Promise((r) => setTimeout(r, 100))
      resp = await doPresign()
    }
    if (!resp.ok) {
      return {
        success: false,
        errorClass: FilePipelineErrorCode.NETWORK_ERROR,
        message: `presign HTTP ${resp.status}: ${await safeReadText(resp)}`,
        durationMs: elapsedMs(),
      }
    }
    presign = (await resp.json()) as PresignResponseBody
  } catch (err) {
    return classifyFetchError(err, elapsedMs(), 'presign')
  }

  if (!presign.success || !presign.presigned_url || !presign.temp_object_key) {
    const code = (isFilePipelineErrorCode(presign.error_code)
      ? presign.error_code
      : FilePipelineErrorCode.UNKNOWN_ERROR) as FilePipelineErrorCode
    return {
      success: false,
      errorClass: code,
      message: presign.message ?? 'presign failed (empty response)',
      durationMs: elapsedMs(),
    }
  }

  const presignedUrl = presign.presigned_url
  const tempObjectKey = presign.temp_object_key

  // ── 3. PUT to OSS（L52：5xx 一次 retry；W5 L60：流式 body 消 OOM）──
  //
  // 每次 retry 重新 createReadStream（stream 是消耗型，第一次 PUT 已经把
  // chunks 流过，重试必须新开一个 stream）。
  const doOssPut = async (): Promise<Response> => {
    const putSignal = composeSignal(options.signal, remainingMs())
    const fileStream = createReadStream(filePath)
    const webStream = Readable.toWeb(fileStream) as unknown as ReadableStream
    return await fetch(presignedUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(fileSize),
      },
      body: webStream as unknown as BodyInit,
      // Undici 要求流式 body 显式 set duplex='half'（仅请求体流式，无服务端
      // streaming push）；TS DOM lib 还没声明该字段，cast 让 TS 放行
      duplex: 'half',
      signal: putSignal,
    } as RequestInit & { duplex: 'half' })
  }
  try {
    let resp = await doOssPut()
    if (resp.status >= 500 && resp.status < 600 && remainingMs() > 1_500) {
      await new Promise((r) => setTimeout(r, 100))
      resp = await doOssPut()
    }
    if (!resp.ok) {
      return {
        success: false,
        errorClass: FilePipelineErrorCode.NETWORK_ERROR,
        message: `OSS PUT HTTP ${resp.status}: ${await safeReadText(resp)}`,
        durationMs: elapsedMs(),
      }
    }
  } catch (err) {
    return classifyFetchError(err, elapsedMs(), 'oss-put')
  }

  // ── 4. POST parse-sync（L51：再 re-await token，长流程内 token 可能过期）─
  const tokenForParseSync = await TokenManager.getAccessToken()
  if (!tokenForParseSync) {
    return {
      success: false,
      errorClass: FilePipelineErrorCode.NETWORK_ERROR,
      message: 'Access token expired mid-flow (between OSS PUT and parse-sync).',
      durationMs: elapsedMs(),
    }
  }
  const parseSyncUrl = joinApiPath(API_BASE_URL, '/services/docparse/parse-sync-temp')
  const parseSyncSignal = composeSignal(options.signal, remainingMs())
  let parseSync: ParseSyncResponseBody
  try {
    const resp = await fetch(parseSyncUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenForParseSync}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        temp_object_key: tempObjectKey,
        mime_type: mimeType,
      }),
      signal: parseSyncSignal,
    })
    if (!resp.ok) {
      return {
        success: false,
        errorClass: FilePipelineErrorCode.NETWORK_ERROR,
        message: `parse-sync HTTP ${resp.status}: ${await safeReadText(resp)}`,
        durationMs: elapsedMs(),
      }
    }
    parseSync = (await resp.json()) as ParseSyncResponseBody
  } catch (err) {
    return classifyFetchError(err, elapsedMs(), 'parse-sync')
  }

  if (!parseSync.success || !parseSync.chunks) {
    const code = (isFilePipelineErrorCode(parseSync.failure_code)
      ? parseSync.failure_code
      : FilePipelineErrorCode.UNKNOWN_ERROR) as FilePipelineErrorCode
    return {
      success: false,
      errorClass: code,
      message: parseSync.message ?? 'parse-sync failed (empty response)',
      durationMs: elapsedMs(),
    }
  }

  log.debug(
    'temp pptx parse OK: file=%s size=%d pages=%d chunks=%d duration=%dms',
    filename,
    fileSize,
    parseSync.pages ?? 0,
    parseSync.chunks.length,
    elapsedMs(),
  )

  return {
    success: true,
    chunks: parseSync.chunks,
    durationMs: parseSync.duration_ms ?? elapsedMs(),
    pages: parseSync.pages ?? 0,
    title: parseSync.title ?? '',
    fileSizeBytes: fileSize,
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

/**
 * 把 caller 传的 abortSignal 与本地 timeout signal 用 `AbortSignal.any`
 * 组合——任一触发即 cancel 当前 fetch。Node 20.3+ 标准 API（与
 * `fetchCloudSummary` 同款依赖）。
 */
function composeSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const localTimeout = AbortSignal.timeout(Math.max(1_000, timeoutMs))
  if (!callerSignal) return localTimeout
  return AbortSignal.any([localTimeout, callerSignal])
}

async function safeReadText(resp: Response): Promise<string> {
  try {
    const text = await resp.text()
    return text.slice(0, 500)
  } catch {
    return '<unreadable body>'
  }
}

function classifyFetchError(
  err: unknown,
  durationMs: number,
  stage: string,
): TempPptxParseResult {
  const msg = err instanceof Error ? err.message : String(err)
  const name = err instanceof Error ? err.name : ''
  const isAbort = name === 'AbortError' || /abort/i.test(msg)
  const isTimeout = name === 'TimeoutError' || /time(d? ?out|out)/i.test(msg)
  if (isAbort && !isTimeout) {
    return {
      success: false,
      errorClass: FilePipelineErrorCode.USER_ABORTED,
      message: `${stage}: aborted by user`,
      durationMs,
    }
  }
  if (isTimeout) {
    return {
      success: false,
      errorClass: FilePipelineErrorCode.PARSE_TIMEOUT,
      message: `${stage}: ${msg}`,
      durationMs,
    }
  }
  return {
    success: false,
    errorClass: FilePipelineErrorCode.NETWORK_ERROR,
    message: `${stage}: ${msg}`,
    durationMs,
  }
}
