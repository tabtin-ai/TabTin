/**
 * parseLocalAttachment — 本地附件解析主入口（FR-18 Phase 1/2 共享主路径）
 *
 * 业务目标：在宿主主进程对 PDF / Word / Excel 做**本地文本提取**，让 80%
 * 的附件场景不依赖云端 DocParse。20% 场景（扫描件 / PPT / 超大文件 / 乱码文本
 * 层 / 加密 / 损坏）通过 `LocalDocParseError` 告知上层"是否建议切云端"。
 *
 * 输入来源两类：
 *   1. 本地绝对路径（新 app 内部场景、单测）
 *   2. HTTPS URL（OSS 预签名，attachment.url 最常见）→ 内部下载到 tmp 再解析
 *
 * 架构：
 *   - 所有 CPU 密集解析都丢给宿主注入的 `runDocParserTask`（worker pool）
 *   - 主线程负责：mime 识别、大小校验、超时控制、URL 下载、错误分类
 *
 * 设计决策：
 *   - 错误**两类消费路径**：
 *     * `fallbackToCloud: true` → 切云端 VLM（scanned_pdf / garbled_text_layer / parse_timeout / unsupported_format / upstream_error）
 *     * `fallbackToCloud: false` → 直接给用户明确错误提示（encrypted / corrupted / file_too_large / aborted）
 *   - 质量得分在 worker 内计算（避免主进程对 50-500KB 字符串扫描阻塞事件循环）
 *
 * 与宿主的关系（H2-E 抽包后）：
 *   - 此函数完全宿主无关：通过 `deps.runDocParserTask` 注入 worker 调度
 *   - 宿主负责：worker entry 脚本路径、logger 风格、telemetry sink、attachmentStrategy 配置
 */

import { createWriteStream } from 'node:fs'
import { stat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import {
  DownloadHttpError,
  OversizeDownloadError,
  classifyWorkerError,
  errorClassToFallback,
} from './error-classifier.js'
import {
  FilePipelineErrorCode,
  type LocalDocParseErrorClass,
  type LocalDocParseFailure,
  type LocalDocParseOptions,
  type LocalDocParseResult,
  type ParseLocalAttachmentInput,
} from './types.js'
import type {
  DocParserPayloadMap,
  DocParserResultMap,
  DocParserTaskType,
  ParsePdfResult,
} from './workers/tasks.js'

// ─── 阈值常量（对齐 Django pdf_parser.py） ────────────────────────

/**
 * 扫描件文档级分类阈值 —— 对齐 Django `_build_document_profile` L653。
 * chars/page < 100 → doc_type='scan' → 切云端 VLM。
 */
export const DEFAULT_SCANNED_THRESHOLD_CHARS_PER_PAGE = 100

/**
 * 最大单文件本地解析体积（MB）。Electron 默认 50MB；Daemon 跑在 NAS / 服务器
 * 后台，CPU/内存可能弱于桌面，宿主默认 20MB（见 H2-E 决策 D1）。**包内默认沿用
 * Electron 50MB**——宿主必须显式覆盖才能差异化（避免悄悄回落到 50 让低配机崩）。
 */
export const DEFAULT_MAX_LOCAL_FILE_SIZE_MB = 50

/**
 * 本地解析硬超时（毫秒，对齐 PRD FR-18）。
 *
 * **3s 是整体预算**：URL 下载 + worker 解析串行扣减，worker 最少保 500ms。
 *
 * Verifier-B 矛盾 #1 修复（H1-D-MAIN 二次）：v1.0 曾定 5s（理由：真实中文 PDF
 * 2-5× 劣化），二次复审确认 3s 更优：
 *   - POC warm 数据：10p=5ms / 100p=38ms / 500p=196ms
 *   - 真实中文 PDF worst-case：500p×5×=1000ms + 冷启动 400ms ≈ 1.4s，3s 预留 2×
 *   - **用户体感**：本地失败切云端（文本层路径通常 1-3s）后总等待 4-6s；5s 超时会让
 *     用户多干等 2s 才得到云端兜底回复，违背"本地优先 = 响应快" 叙事
 *   - 产品取向：宁可"少量边界 PDF 切云端" 也不"让用户等 5s 本地徒劳"
 *
 * 可通过 `options.timeoutMs` 覆盖（例如批量后台解析场景可放宽）。
 */
export const DEFAULT_TIMEOUT_MS = 3000

/** 最大解析页数（对齐 Django 2000 页硬截断） */
const DEFAULT_MAX_PAGES = 2000

/** Excel 单文件最大 sheet 数（对齐 XlsxViewer：20） */
const DEFAULT_MAX_SHEETS = 20

/** 单 sheet 最大行数（防止 LLM 输入暴涨） */
const DEFAULT_MAX_ROWS_PER_SHEET = 200

/**
 * 质量得分最低分（对齐 Django `_is_text_layer_reliable`）。
 * < 此分视为乱码文本层（OCR 伪文本），切云端 VLM。
 */
const DEFAULT_QUALITY_MIN_SCORE = 0.3

// ─── Deps 注入（宿主无关化） ─────────────────────────────────────

export interface ParseLocalAttachmentLogger {
  debug?: (...args: unknown[]) => void
}

export interface RunDocParserTaskOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * 宿主注入的 worker 调度器。两端 thin wrapper 都用 `WorkerTaskRunner.runTask`
 * 实现，但 worker entry 脚本路径不同（Electron `out/main/...mjs` /
 * Daemon `dist/workers/...js`），所以包不能直接持有 runner 实例。
 */
export type RunDocParserTask = <T extends DocParserTaskType>(
  taskType: T,
  payload: DocParserPayloadMap[T],
  options: RunDocParserTaskOptions,
) => Promise<DocParserResultMap[T]>

export interface ParseLocalAttachmentDeps {
  runDocParserTask: RunDocParserTask
  /** 用于 tmp 清理失败等非致命路径的 debug 日志；省略则 no-op。 */
  logger?: ParseLocalAttachmentLogger
}

// ─── mime 分类 ────────────────────────────────────────────────────

const PDF_MIMES = new Set([
  'application/pdf',
  'application/x-pdf',
])

const DOCX_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

const XLSX_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // xls（老 office）结构不同，不走本地：SheetJS 能读但 Agent 对老 office 场景稀少，统一走云端
])

/**
 * PPT / 老 Office / 其他文档 → 本地不支持，切云端。
 * `application/vnd.openxmlformats-officedocument.presentationml.presentation`
 * `application/vnd.ms-powerpoint`
 * `application/msword`（老 .doc）
 * `application/vnd.ms-excel`（老 .xls）
 */
type LocalParseKind = 'pdf' | 'docx' | 'xlsx' | 'unsupported'

function classifyMimeForLocal(mime: string, filename?: string): LocalParseKind {
  const m = mime.toLowerCase()
  if (PDF_MIMES.has(m)) return 'pdf'
  if (DOCX_MIMES.has(m)) return 'docx'
  if (XLSX_MIMES.has(m)) return 'xlsx'

  // mime 偶尔缺失（如 iOS 上传），退回看后缀
  if (filename) {
    const ext = filename.toLowerCase().split('.').pop() ?? ''
    if (ext === 'pdf') return 'pdf'
    if (ext === 'docx') return 'docx'
    if (ext === 'xlsx') return 'xlsx'
  }

  return 'unsupported'
}

/**
 * 统一的"错误 → LocalDocParseFailure"工厂（技术 Review P1-4 去重）。
 * 三处 parse*ThroughWorker 的 catch 块原本各写一遍相同代码，抽走后只保留必要的 mime/t0 上下文。
 */
function classifyFailureResult(
  err: unknown,
  mime: string,
  t0: number,
): LocalDocParseFailure {
  const msg = err instanceof Error ? err.message : String(err)
  const cls = classifyWorkerError(err)
  return {
    success: false,
    errorClass: cls,
    message: msg,
    fallbackToCloud: errorClassToFallback(cls),
    mimeType: mime,
    durationMs: Math.round(performance.now() - t0),
  }
}

// ─── 临时文件下载（URL → tmp path） ───────────────────────────────

interface DownloadedTmp {
  path: string
  /** 清理临时文件（异步，不阻塞上层） */
  dispose: () => Promise<void>
}

/**
 * 下载远程 URL 到本地临时文件。
 *
 * - 走 fetch(AbortSignal)，遵循给定的整体超时；上层 AbortSignal 可透传
 * - 最大下载体积 = maxFileSizeMb，content-length 预检查 + stream 累加字节双保险
 * - 下载失败（非 2xx / 网络中断 / pipeline 中途失败）→ 清理 tmpDir 后抛原生 Error
 *
 * H1-D-MAIN Review fix3：v1.0 在 pipeline 失败时只清理 tmpPath，不清 tmpDir →
 * 长期运行会在系统 tmp 堆积 `tabtin-docparse-XXXXXX/` 空目录；v1.1 统一整目录清理。
 */
async function downloadToTmp(
  url: string,
  options: {
    timeoutMs: number
    maxBytes: number
    filename?: string
    signal?: AbortSignal
  },
): Promise<DownloadedTmp> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), options.timeoutMs)
  // 上层 abort（用户点停止）时也中断 fetch
  const abortHandler = (): void => ac.abort()
  if (options.signal) {
    if (options.signal.aborted) ac.abort()
    else options.signal.addEventListener('abort', abortHandler, { once: true })
  }

  let tmpDir: string | null = null
  try {
    const resp = await fetch(url, { signal: ac.signal })
    if (!resp.ok) {
      // Verifier-B 必修 3：抛带 status 的专用错误，供 classifyWorkerError 区分
      // 404/403/410（not_found）vs 其他 HTTP 错误（unknown，切云端兜底）。
      throw new DownloadHttpError(resp.status, resp.statusText)
    }

    const contentLength = resp.headers.get('content-length')
    if (contentLength) {
      const declaredBytes = Number(contentLength)
      if (!Number.isNaN(declaredBytes) && declaredBytes > options.maxBytes) {
        throw new OversizeDownloadError(declaredBytes, options.maxBytes)
      }
    }

    tmpDir = await mkdtemp(join(tmpdir(), 'tabtin-docparse-'))
    const ext = options.filename?.split('.').pop()?.toLowerCase() ?? 'bin'
    const tmpPath = join(tmpDir, `${randomUUID()}.${ext}`)

    let received = 0
    const body = resp.body
    if (!body) throw new Error('Download failed: empty response body')

    // 流式拷贝到磁盘，边写边查体积。
    // Node 18+ fetch 返回的是 Web ReadableStream，Readable.fromWeb 接受该类型；
    // @types/node 18.x 在某些版本里把 fetch.body 标成 lib.dom 的 ReadableStream，
    // 与 node:stream/web 的 ReadableStream 字面不同名但 runtime 等价；
    // 用 unknown 中继避免给 @ts-expect-error 留隐患（不同 @types/node 版本会让
    // 注释时灵时不灵）。
    const nodeStream = Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0])
    const fileStream = createWriteStream(tmpPath)

    nodeStream.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > options.maxBytes) {
        nodeStream.destroy(new OversizeDownloadError(received, options.maxBytes))
      }
    })

    await pipeline(nodeStream, fileStream)

    const capturedDir = tmpDir
    return {
      path: tmpPath,
      dispose: async () => {
        try {
          await rm(capturedDir, { recursive: true, force: true })
        } catch {
          /* 已被清理 — 忽略 */
        }
      },
    }
  } catch (err) {
    // pipeline / fetch 失败：清理已创建的 tmpDir，避免长期泄漏
    if (tmpDir) {
      try {
        await rm(tmpDir, { recursive: true, force: true })
      } catch {
        /* 忽略清理失败 */
      }
    }
    throw err
  } finally {
    clearTimeout(timer)
    if (options.signal) {
      options.signal.removeEventListener('abort', abortHandler)
    }
  }
}

// ─── 主入口：parseLocalAttachment ─────────────────────────────────

/**
 * 本地解析附件。API 在 `LocalDocParseResult` 上屏蔽 PDF / Word / Excel 的差异，
 * 调用方只关心 `success: boolean` + `text` / `errorClass`。
 *
 * 与 H1-D-MAIN 的 Electron 实现签名差异：
 *   - 多了 `deps` 参数（runDocParserTask + 可选 logger）—— 共享包不能持有
 *     宿主 worker pool 的具体实例（Electron 用 `out/main/doc-parser-worker.mjs`，
 *     Daemon 用 `dist/workers/doc-parser-worker.js`），由宿主注入决议
 */
export async function parseLocalAttachment(
  input: ParseLocalAttachmentInput,
  options: LocalDocParseOptions,
  deps: ParseLocalAttachmentDeps,
): Promise<LocalDocParseResult> {
  const t0 = performance.now()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = (options.maxFileSizeMb ?? DEFAULT_MAX_LOCAL_FILE_SIZE_MB) * 1024 * 1024
  const scannedThreshold = options.scannedThresholdCharsPerPage ?? DEFAULT_SCANNED_THRESHOLD_CHARS_PER_PAGE
  const qualityMin = options.qualityMinScore ?? DEFAULT_QUALITY_MIN_SCORE
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  const maxSheets = options.maxSheets ?? DEFAULT_MAX_SHEETS
  const maxRowsPerSheet = options.maxRowsPerSheet ?? DEFAULT_MAX_ROWS_PER_SHEET
  const mime = (options.mimeType ?? input.mimeType).toLowerCase()
  const filename = options.filename ?? input.filename
    ?? (input.source.kind === 'path' ? basename(input.source.path) : undefined)

  // ── step 1: mime 分类 ──
  const kind = classifyMimeForLocal(mime, filename)
  if (kind === 'unsupported') {
    return {
      success: false,
      errorClass: FilePipelineErrorCode.UNSUPPORTED_FORMAT,
      message: `Local parsing not supported for mime="${mime}"${filename ? ` (file="${filename}")` : ''}`,
      fallbackToCloud: true,
      mimeType: mime,
      durationMs: Math.round(performance.now() - t0),
    }
  }

  // ── step 2: 尺寸预检查（path 来源直接 stat；URL 来源有 content-length 走下载侧检测） ──
  let preknownSize = input.fileSizeBytes
  if (input.source.kind === 'path' && preknownSize == null) {
    try {
      const s = await stat(input.source.path)
      preknownSize = s.size
    } catch (err) {
      const cls = classifyWorkerError(err)
      const resolvedCls =
        cls === FilePipelineErrorCode.FILE_NOT_FOUND
          ? FilePipelineErrorCode.FILE_NOT_FOUND
          : FilePipelineErrorCode.UNKNOWN_ERROR
      return {
        success: false,
        errorClass: resolvedCls,
        message: err instanceof Error ? err.message : String(err),
        fallbackToCloud: errorClassToFallback(resolvedCls),
        mimeType: mime,
        durationMs: Math.round(performance.now() - t0),
      }
    }
  }

  if (preknownSize != null && preknownSize > maxBytes) {
    return {
      success: false,
      errorClass: FilePipelineErrorCode.FILE_TOO_LARGE,
      message: `File size ${preknownSize} bytes exceeds local limit ${maxBytes} bytes`,
      fallbackToCloud: false, // FILE_TOO_LARGE 不切云端，由宿主给用户明确提示
      mimeType: mime,
      durationMs: Math.round(performance.now() - t0),
    }
  }

  // ── step 3: 获取本地路径（path 直接用；URL 下载到 tmp） ──
  let localPath: string
  let tmp: DownloadedTmp | null = null
  let downloadMs = 0
  try {
    if (input.source.kind === 'path') {
      localPath = input.source.path
    } else {
      const downloadStarted = performance.now()
      tmp = await downloadToTmp(input.source.url, {
        timeoutMs,
        maxBytes,
        filename,
        signal: options.signal,
      })
      downloadMs = Math.round(performance.now() - downloadStarted)
      localPath = tmp.path
      deps.logger?.debug?.('[docparse] download_done', {
        mime,
        filename,
        download_ms: downloadMs,
        timeout_budget_ms: timeoutMs,
      })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    let cls: LocalDocParseErrorClass
    if (err instanceof OversizeDownloadError) {
      cls = FilePipelineErrorCode.FILE_TOO_LARGE
    } else if (err instanceof Error && err.name === 'AbortError') {
      // 用户主动取消（abortSignal 触发）和"超时被内部 ac.abort()"在 fetch 层都
      // 表现为 AbortError name。优先看 options.signal.aborted —— 上游 abort 是
      // 用户行为，应映射为 USER_ABORTED（不切云端）；否则才是内部超时
      // （PARSE_TIMEOUT，切云端兜底）。Verifier-B Review 必修项：手机端用户
      // 点"停止"后不应继续打云端 DocParse 浪费流量。
      cls = options.signal?.aborted
        ? FilePipelineErrorCode.USER_ABORTED
        : FilePipelineErrorCode.PARSE_TIMEOUT
    } else {
      cls = classifyWorkerError(err)
    }
    deps.logger?.debug?.('[docparse] download_or_resolve_failed', {
      mime,
      filename,
      error_class: cls,
      download_ms: downloadMs,
      duration_ms: Math.round(performance.now() - t0),
      message: msg.slice(0, 200),
    })
    return {
      success: false,
      errorClass: cls,
      message: msg,
      fallbackToCloud: errorClassToFallback(cls),
      mimeType: mime,
      durationMs: Math.round(performance.now() - t0),
    }
  }

  // ── step 4: 调 worker 解析（剩余超时预算 = 整体 - step 3 下载耗时） ──
  // 保留最少 500ms，避免下载耗尽预算后 worker 立即超时
  const elapsed = performance.now() - t0
  const remainingTimeoutMs = Math.max(500, Math.round(timeoutMs - elapsed))
  deps.logger?.debug?.('[docparse] worker_start', {
    mime,
    filename,
    kind,
    download_ms: downloadMs,
    remaining_timeout_ms: remainingTimeoutMs,
    timeout_budget_ms: timeoutMs,
  })
  try {
    if (kind === 'pdf') {
      return await parsePdfThroughWorker({
        localPath,
        mime,
        timeoutMs: remainingTimeoutMs,
        maxPages,
        scannedThreshold,
        qualityMin,
        signal: options.signal,
        runDocParserTask: deps.runDocParserTask,
        t0,
        downloadMs,
        logger: deps.logger,
      })
    }
    if (kind === 'docx') {
      return await parseDocxThroughWorker({
        localPath,
        mime,
        timeoutMs: remainingTimeoutMs,
        signal: options.signal,
        runDocParserTask: deps.runDocParserTask,
        t0,
      })
    }
    // xlsx
    return await parseXlsxThroughWorker({
      localPath,
      mime,
      timeoutMs: remainingTimeoutMs,
      maxSheets,
      maxRowsPerSheet,
      signal: options.signal,
      runDocParserTask: deps.runDocParserTask,
      t0,
    })
  } finally {
    // tmp 文件由 Node 最终清理；这里主动清理可以让大文件不占磁盘
    if (tmp) {
      void tmp.dispose().catch((err) => {
        deps.logger?.debug?.('tmp cleanup failed', err)
      })
    }
  }
}

// ─── PDF worker 调用 + 扫描件/乱码判定 ────────────────────────────

interface PdfWorkerCtx {
  localPath: string
  mime: string
  timeoutMs: number
  maxPages: number
  scannedThreshold: number
  qualityMin: number
  signal?: AbortSignal
  runDocParserTask: RunDocParserTask
  t0: number
  downloadMs?: number
  logger?: ParseLocalAttachmentLogger
}

async function parsePdfThroughWorker(ctx: PdfWorkerCtx): Promise<LocalDocParseResult> {
  let result: ParsePdfResult
  const workerStarted = performance.now()
  try {
    result = await ctx.runDocParserTask(
      'parse-pdf',
      {
        filePath: ctx.localPath,
        maxPages: ctx.maxPages,
        scannedThresholdCharsPerPage: ctx.scannedThreshold,
      },
      { timeoutMs: ctx.timeoutMs, signal: ctx.signal },
    )
  } catch (err) {
    const failure = classifyFailureResult(err, ctx.mime, ctx.t0)
    ctx.logger?.debug?.('[docparse] worker_failed', {
      mime: ctx.mime,
      error_class: failure.errorClass,
      download_ms: ctx.downloadMs ?? 0,
      worker_ms: Math.round(performance.now() - workerStarted),
      worker_timeout_ms: ctx.timeoutMs,
      duration_ms: failure.durationMs,
      message: failure.message.slice(0, 200),
    })
    return failure
  }

  ctx.logger?.debug?.('[docparse] worker_done', {
    mime: ctx.mime,
    download_ms: ctx.downloadMs ?? 0,
    worker_ms: Math.round(performance.now() - workerStarted),
    pages: result.pages,
    is_scanned: result.isScanned,
    quality_score: result.qualityScore,
    duplicate_ratio: result.duplicateRatio,
    duplicate_items_removed: result.duplicateItemsRemoved,
  })

  // 扫描件 → 切云端
  if (result.isScanned) {
    return {
      success: false,
      errorClass: FilePipelineErrorCode.SCANNED_PDF,
      message: `Detected as scanned PDF (chars/page=${result.charsPerPageAvg} < threshold=${ctx.scannedThreshold})`,
      fallbackToCloud: true,
      mimeType: ctx.mime,
      durationMs: Math.round(performance.now() - ctx.t0),
    }
  }

  // 文本层质量校验（quality 由 worker 预算好并透传到 result，主进程不再对 50-500KB
  // 文本做 O(n) 扫描，避免事件循环阻塞）。
  if (result.qualityScore < ctx.qualityMin) {
    return {
      success: false,
      errorClass: FilePipelineErrorCode.GARBLED_TEXT_LAYER,
      message: `Text layer quality ${result.qualityScore.toFixed(2)} < minimum ${ctx.qualityMin} — possible OCR garbled_text_layer PDF`,
      fallbackToCloud: true,
      mimeType: ctx.mime,
      durationMs: Math.round(performance.now() - ctx.t0),
    }
  }

  return {
    success: true,
    text: result.text,
    pages: result.pages,
    isScanned: false,
    qualityScore: result.qualityScore,
    mimeType: ctx.mime,
    fileSizeBytes: result.fileSizeBytes,
    durationMs: Math.round(performance.now() - ctx.t0),
  }
}

interface DocxWorkerCtx {
  localPath: string
  mime: string
  timeoutMs: number
  signal?: AbortSignal
  runDocParserTask: RunDocParserTask
  t0: number
}

async function parseDocxThroughWorker(ctx: DocxWorkerCtx): Promise<LocalDocParseResult> {
  try {
    const result = await ctx.runDocParserTask(
      'parse-docx',
      { filePath: ctx.localPath },
      { timeoutMs: ctx.timeoutMs, signal: ctx.signal },
    )

    // mammoth 对非法文档（不是真正的 docx）会抛；正常解析不会给空 text，
    // 但用户偶尔上传空白模板 → 空 text + 无错误，视为成功（Agent 自己会说"文档为空"）。
    return {
      success: true,
      text: result.text,
      mimeType: ctx.mime,
      fileSizeBytes: result.fileSizeBytes,
      durationMs: Math.round(performance.now() - ctx.t0),
    }
  } catch (err) {
    return classifyFailureResult(err, ctx.mime, ctx.t0)
  }
}

interface XlsxWorkerCtx {
  localPath: string
  mime: string
  timeoutMs: number
  maxSheets: number
  maxRowsPerSheet: number
  signal?: AbortSignal
  runDocParserTask: RunDocParserTask
  t0: number
}

async function parseXlsxThroughWorker(ctx: XlsxWorkerCtx): Promise<LocalDocParseResult> {
  try {
    const result = await ctx.runDocParserTask(
      'parse-xlsx',
      {
        filePath: ctx.localPath,
        maxSheets: ctx.maxSheets,
        maxRowsPerSheet: ctx.maxRowsPerSheet,
      },
      { timeoutMs: ctx.timeoutMs, signal: ctx.signal },
    )

    return {
      success: true,
      text: result.text,
      mimeType: ctx.mime,
      fileSizeBytes: result.fileSizeBytes,
      durationMs: Math.round(performance.now() - ctx.t0),
    }
  } catch (err) {
    return classifyFailureResult(err, ctx.mime, ctx.t0)
  }
}

// ─── 测试辅助（内部纯函数，仅被单测使用）───
export const __forTesting = {
  classifyMimeForLocal,
  errorClassToFallback,
}
