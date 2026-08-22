/**
 * poc-local-pdf-parse — 本地 PDF 解析可行性 POC
 *
 * 业务目标：
 *   验证 pdfjs-dist 能否在 Electron 主进程（Node 运行时）提取 PDF 文本内容，
 *   并识别无文本层的扫描件，为 FR-18「本地优先附件解析」主路径提供实证依据。
 *
 *   1. pdfjs-dist 5.4.296 主入口 `pdfjs-dist/build/pdf.mjs` 在 Node ≥20.16 可直接 import
 *   2. disableWorker=true：主线程模式（fake worker），Node 无 DOM Worker，避免
 *      pdfjs 试图 spawn web worker 失败；Node 层面阻塞风险由上层 worker_threads
 *      策略承担（见 --worker 参数）
 *   3. 扫描件识别：`page.getTextContent().items` 为空或整卷 chars/page < 阈值
 *      → `isScanned = true`，交回云端 VLM
 *   4. 内存峰值：通过 setInterval 采样 process.memoryUsage().rss 做峰值追踪
 *      （rss 比 heapUsed 更准确反映 V8+native 总占用）
 *   5. 支持三种执行模式：
 *        --mode=direct      主进程直接调用（默认）
 *        --mode=worker      通过 Node worker_threads 隔离
 *        --mode=both        两种都跑，用于对比
 *
 * 执行：
 *   # 首选（常规开发机）
 *   pnpm exec tsx apps/tabtin-electron/src/main/scripts/poc-local-pdf-parse.ts <pdf-path>
 *   pnpm exec tsx apps/tabtin-electron/src/main/scripts/poc-local-pdf-parse.ts --all
 *
 *   # 备选（受限环境，tsx IPC 端口不可用时，如 sandbox/CI）
 *   cd apps/tabtin-electron
 *   node --import tsx/esm src/main/scripts/poc-local-pdf-parse.ts <pdf-path>
 */

import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, basename, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = resolve(__dirname, '../../../fixtures/poc-pdfs')

/**
 * 解析 pdfjs-dist 模块的绝对位置（POC 专用）。
 *
 * POC 阶段 apps/tabtin-electron/package.json 未直接声明 pdfjs-dist 依赖（本
 * 次只是验证，主路径 localDocParse.ts 落地时才会显式添加）。当前 pdfjs-dist
 * 通过 react-pdf 传递依赖存在于 workspace 的 pnpm store 里，这里做三级回退：
 *
 *   1. 直接 import 'pdfjs-dist'（若宿主已声明依赖，最佳路径）
 *   2. 通过 react-pdf peer-dep 宿主节点反查 sibling（当前 POC 用这个）
 *   3. 扫描 workspace root node_modules/.pnpm（最后兜底）
 *
 * 返回 pdf.mjs 的绝对 URL；具体入口用 `legacy/build/pdf.mjs`，对 Node 20.x 更
 * 稳健（modern build 依赖 Promise.withResolvers 等 Node 22+ 特性）。
 */
async function resolvePdfjsUrl(): Promise<string> {
  const require = createRequire(import.meta.url)

  // 尝试 1：bare specifier 直接解析（宿主已声明依赖时最佳）
  try {
    const pkgPath = require.resolve('pdfjs-dist/package.json')
    const candidate = resolve(dirname(pkgPath), 'legacy', 'build', 'pdf.mjs')
    if (existsSync(candidate)) return pathToFileURL(candidate).href
  } catch {
    /* fall through */
  }

  // 尝试 2：通过 react-pdf peer-dep 宿主反查 sibling（POC 阶段当前路径）
  try {
    const reactPdfPkg = require.resolve('react-pdf/package.json')
    const candidate = resolve(
      dirname(reactPdfPkg),
      '..',
      'pdfjs-dist',
      'legacy',
      'build',
      'pdf.mjs',
    )
    if (existsSync(candidate)) return pathToFileURL(candidate).href
  } catch {
    /* fall through */
  }

  // 尝试 3：扫 workspace root node_modules/.pnpm 兜底
  const workspaceRoot = resolve(__dirname, '../../../../..')
  const pnpmDir = resolve(workspaceRoot, 'node_modules/.pnpm')
  if (existsSync(pnpmDir)) {
    const { readdirSync } = await import('node:fs')
    const match = readdirSync(pnpmDir).find(n => /^pdfjs-dist@/.test(n))
    if (match) {
      const candidate = resolve(
        pnpmDir,
        match,
        'node_modules/pdfjs-dist/legacy/build/pdf.mjs',
      )
      if (existsSync(candidate)) return pathToFileURL(candidate).href
    }
  }

  throw new Error(
    '无法定位 pdfjs-dist。请在 apps/tabtin-electron/package.json 声明依赖或检查 workspace 安装状态。',
  )
}

async function resolvePdfjsLib(): Promise<typeof import('pdfjs-dist')> {
  const url = await resolvePdfjsUrl()
  return (await import(url)) as unknown as typeof import('pdfjs-dist')
}

// ── 类型 ────────────────────────────────────────────────────────────

export interface LocalPdfParseResult {
  path: string
  file_size_bytes: number
  pages: number
  text: string
  char_count: number
  chars_per_page_avg: number
  empty_pages: number
  is_scanned: boolean
  parse_duration_ms: number
  first_page_duration_ms: number
  memory_peak_rss_mb: number
  memory_delta_rss_mb: number
  strategy: 'direct' | 'worker_threads'
  worker_boot_ms?: number
  error?: string
}

interface ParseOptions {
  scannedThresholdCharsPerPage: number
  maxPages: number
}

/**
 * 阈值对齐 Django 生产端 `apps/tabtin_django/apps/services/docparse/parsers/pdf_parser.py`
 * 的 `_build_document_profile`（文档级扫描分类）：`chars_per_page < 100` → `doc_type = 'scan'`。
 *
 * 注：Django 端另有 `_compute_adaptive_thresholds` 的 `text_layer_threshold=50`，那是**单页
 * 级**（已判定扫描文档后每页是否尝试 text-layer 抽取）的另一语义，**不能用于文档级判定**。
 * POC v1.0 曾误用 50，v1.1 已在报告 §2.Q3 出决策表，v1.1+ 在此统一修正代码默认值。
 */
const DEFAULT_OPTIONS: ParseOptions = {
  scannedThresholdCharsPerPage: 100,
  maxPages: 2000,
}

// ── 核心解析：主进程直接调用 ─────────────────────────────────────────

/**
 * 直接在当前线程（主进程/脚本进程）用 pdfjs-dist 解析 PDF。
 *
 * 注意：pdfjs 在 Node 下默认尝试加载 worker 文件，找不到 worker 入口会
 * 降级到 fakeWorker（主线程执行）。我们显式用 `disableWorker: true`
 * 明确走主线程模式，避免 CPU 密集工作阻塞主进程 —— 阻塞风险由上层
 * `parsePdfInWorkerThread` 的 worker_threads 包装解决。
 */
async function parsePdfDirect(
  filePath: string,
  options: ParseOptions = DEFAULT_OPTIONS,
): Promise<LocalPdfParseResult> {
  const absPath = resolve(filePath)
  const stats = await stat(absPath)

  const memBefore = process.memoryUsage().rss
  let memPeak = memBefore
  const memSampler = setInterval(() => {
    const cur = process.memoryUsage().rss
    if (cur > memPeak) memPeak = cur
  }, 25)

  let parsedPages = 0
  let totalCharCount = 0
  let emptyPages = 0
  let firstPageDurationMs = 0
  const textBuffer: string[] = []

  const t0 = performance.now()

  try {
    const pdfjs = await resolvePdfjsLib()

    const data = new Uint8Array(await readFile(absPath))

    const loadingTask = pdfjs.getDocument({
      data,
      // @ts-expect-error — pdfjs 5.x public 类型从 DocumentInitParameters 移除
      // `disableWorker`，但 runtime 仍解析该选项（src/display/api.js）。Node 无
      // DOM Worker，不显式关闭会试图 spawn web worker 并告警。MAIN 阶段统一
      // 在 doc-parser-handlers.ts 也加了同样的 ts-expect-error。
      disableWorker: true,
      isEvalSupported: false,
      useSystemFonts: true,
      standardFontDataUrl: resolveStandardFontDataUrl(),
    })

    const pdf = await loadingTask.promise
    const totalPages = Math.min(pdf.numPages, options.maxPages)

    for (let i = 1; i <= totalPages; i++) {
      const pageT0 = performance.now()
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()

      const items = content.items as Array<{ str?: string }>
      const pageText = items
        .map(it => (typeof it.str === 'string' ? it.str : ''))
        .join('')

      textBuffer.push(pageText)
      totalCharCount += pageText.length
      if (pageText.trim().length === 0) emptyPages += 1
      parsedPages += 1

      if (i === 1) firstPageDurationMs = performance.now() - pageT0

      page.cleanup()
    }

    await pdf.destroy()
  } finally {
    clearInterval(memSampler)
  }

  const parseDurationMs = performance.now() - t0
  const charsPerPageAvg = parsedPages > 0 ? totalCharCount / parsedPages : 0
  const isScanned =
    parsedPages > 0 && charsPerPageAvg < options.scannedThresholdCharsPerPage

  return {
    path: absPath,
    file_size_bytes: stats.size,
    pages: parsedPages,
    text: textBuffer.join('\n\n'),
    char_count: totalCharCount,
    chars_per_page_avg: Math.round(charsPerPageAvg * 10) / 10,
    empty_pages: emptyPages,
    is_scanned: isScanned,
    parse_duration_ms: Math.round(parseDurationMs),
    first_page_duration_ms: Math.round(firstPageDurationMs),
    memory_peak_rss_mb: Math.round((memPeak - memBefore) / 1024 / 1024 * 10) / 10 + Math.round(memBefore / 1024 / 1024 * 10) / 10,
    memory_delta_rss_mb: Math.round((memPeak - memBefore) / 1024 / 1024 * 10) / 10,
    strategy: 'direct',
  }
}

/**
 * pdfjs 渲染内置字体（Courier/Helvetica/Times 等）时需要 standard font
 * 目录。Node 场景下 pdfjs 随包提供 `standard_fonts/`。同样用多级回退
 * 找 pdfjs-dist 的安装目录。
 */
function resolveStandardFontDataUrl(): string {
  const require = createRequire(import.meta.url)

  const candidates: Array<() => string | null> = [
    () => {
      try {
        return dirname(require.resolve('pdfjs-dist/package.json'))
      } catch {
        return null
      }
    },
    () => {
      try {
        const reactPdfPkg = require.resolve('react-pdf/package.json')
        const sibling = resolve(dirname(reactPdfPkg), '..', 'pdfjs-dist')
        return existsSync(resolve(sibling, 'package.json')) ? sibling : null
      } catch {
        return null
      }
    },
  ]

  for (const fn of candidates) {
    const dir = fn()
    if (dir) return pathToFileURL(resolve(dir, 'standard_fonts') + '/').href
  }

  return pathToFileURL(resolve(__dirname, 'standard_fonts') + '/').href
}

// ── Worker 模式 ────────────────────────────────────────────────────
//
// 本 POC 提供两种 worker 模式供对比：
//   A. parsePdfInWorkerThread —— 每次请求 new Worker + terminate（cold-worker）
//   B. WarmWorkerPool        —— 启动期一次性创建长驻 worker，后续任务复用
//      （模拟生产里的 WorkerTaskRunner 复用模式）
// 两种模式的性能差距，直接决定 H1-D-MAIN 架构选型。

// Worker 脚本正文（以字符串形式传给 Worker，配合 { eval: true } 内联执行，
// 避免依赖额外 worker 脚本文件 / ts→js 构建产物）。
// pdfjs-dist 的模块 URL + 字体目录 URL 由主线程预先解析后通过 workerData 注入，
// 避免 worker 自己二次处理 peer-dep 回退。
const WORKER_SCRIPT = `
const { parentPort, workerData } = require('node:worker_threads')
const { performance } = require('node:perf_hooks')
const { readFile, stat } = require('node:fs/promises')

;(async () => {
  try {
    const { filePath, options, pdfjsUrl, standardFontDataUrl } = workerData
    const t0 = performance.now()
    const pdfjs = await import(pdfjsUrl)

    const stats = await stat(filePath)
    const data = new Uint8Array(await readFile(filePath))

    const loadingTask = pdfjs.getDocument({
      data,
      disableWorker: true,
      isEvalSupported: false,
      useSystemFonts: true,
      standardFontDataUrl,
    })

    const pdf = await loadingTask.promise
    const totalPages = Math.min(pdf.numPages, options.maxPages)
    let totalCharCount = 0
    let emptyPages = 0
    let firstPageDurationMs = 0
    const textBuffer = []

    for (let i = 1; i <= totalPages; i++) {
      const pageT0 = performance.now()
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      const pageText = (content.items || []).map(it => (it && it.str) || '').join('')
      textBuffer.push(pageText)
      totalCharCount += pageText.length
      if (pageText.trim().length === 0) emptyPages += 1
      if (i === 1) firstPageDurationMs = performance.now() - pageT0
      page.cleanup()
    }

    await pdf.destroy()

    const parseDurationMs = performance.now() - t0
    const charsPerPageAvg = totalPages > 0 ? totalCharCount / totalPages : 0

    parentPort.postMessage({
      file_size_bytes: stats.size,
      pages: totalPages,
      text: textBuffer.join('\\n\\n'),
      char_count: totalCharCount,
      chars_per_page_avg: Math.round(charsPerPageAvg * 10) / 10,
      empty_pages: emptyPages,
      is_scanned: totalPages > 0 && charsPerPageAvg < options.scannedThresholdCharsPerPage,
      parse_duration_ms: Math.round(parseDurationMs),
      first_page_duration_ms: Math.round(firstPageDurationMs),
    })
  } catch (err) {
    parentPort.postMessage({
      __error: err && err.message ? err.message : String(err),
    })
  }
})()
`

async function parsePdfInWorkerThread(
  filePath: string,
  options: ParseOptions = DEFAULT_OPTIONS,
): Promise<LocalPdfParseResult> {
  const absPath = resolve(filePath)
  const memBefore = process.memoryUsage().rss
  let memPeak = memBefore
  const memSampler = setInterval(() => {
    const cur = process.memoryUsage().rss
    if (cur > memPeak) memPeak = cur
  }, 25)

  const pdfjsUrl = await resolvePdfjsUrl()
  const standardFontDataUrl = resolveStandardFontDataUrl()

  const bootStart = performance.now()
  let workerBootMs = 0

  try {
    const result = await new Promise<{
      file_size_bytes: number
      pages: number
      text: string
      char_count: number
      chars_per_page_avg: number
      empty_pages: number
      is_scanned: boolean
      parse_duration_ms: number
      first_page_duration_ms: number
      __error?: string
    }>((resolvePromise, reject) => {
      const worker = new Worker(WORKER_SCRIPT, {
        eval: true,
        workerData: {
          filePath: absPath,
          options,
          pdfjsUrl,
          standardFontDataUrl,
        },
      })
      worker.on('online', () => {
        workerBootMs = performance.now() - bootStart
      })
      worker.on('message', msg => {
        worker.terminate()
        resolvePromise(msg)
      })
      worker.on('error', err => {
        worker.terminate()
        reject(err)
      })
      worker.on('exit', code => {
        if (code !== 0 && code !== null) {
          reject(new Error(`Worker exited with code ${code}`))
        }
      })
    })

    if (result.__error) throw new Error(result.__error)

    return {
      path: absPath,
      file_size_bytes: result.file_size_bytes,
      pages: result.pages,
      text: result.text,
      char_count: result.char_count,
      chars_per_page_avg: result.chars_per_page_avg,
      empty_pages: result.empty_pages,
      is_scanned: result.is_scanned,
      parse_duration_ms: result.parse_duration_ms,
      first_page_duration_ms: result.first_page_duration_ms,
      memory_peak_rss_mb: Math.round(memPeak / 1024 / 1024 * 10) / 10,
      memory_delta_rss_mb: Math.round((memPeak - memBefore) / 1024 / 1024 * 10) / 10,
      strategy: 'worker_threads',
      worker_boot_ms: Math.round(workerBootMs),
    }
  } finally {
    clearInterval(memSampler)
  }
}

// ── Warm Worker Pool（对齐生产 WorkerTaskRunner 复用模式） ─────────

/**
 * WARM_WORKER_SCRIPT —— 常驻 worker 脚本。
 *
 * 启动时一次性加载 pdfjs 模块；之后每条 message 携带 `{ reqId, filePath, options }`，
 * worker 处理完毕后回 `{ reqId, result }` 或 `{ reqId, error }`。terminate 由主线程
 * 显式触发（`worker.terminate()`）。
 */
const WARM_WORKER_SCRIPT = `
const { parentPort, workerData } = require('node:worker_threads')
const { performance } = require('node:perf_hooks')
const { readFile, stat } = require('node:fs/promises')

let pdfjsPromise

function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import(workerData.pdfjsUrl)
  return pdfjsPromise
}

async function handle({ reqId, filePath, options }) {
  try {
    const t0 = performance.now()
    const pdfjs = await loadPdfjs()
    const stats = await stat(filePath)
    const data = new Uint8Array(await readFile(filePath))

    const loadingTask = pdfjs.getDocument({
      data,
      disableWorker: true,
      isEvalSupported: false,
      useSystemFonts: true,
      standardFontDataUrl: workerData.standardFontDataUrl,
    })
    const pdf = await loadingTask.promise
    const totalPages = Math.min(pdf.numPages, options.maxPages)
    let totalCharCount = 0
    let emptyPages = 0
    const textBuffer = []

    for (let i = 1; i <= totalPages; i++) {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      const pageText = (content.items || []).map(it => (it && it.str) || '').join('')
      textBuffer.push(pageText)
      totalCharCount += pageText.length
      if (pageText.trim().length === 0) emptyPages += 1
      page.cleanup()
    }
    await pdf.destroy()

    const parseDurationMs = performance.now() - t0
    const charsPerPageAvg = totalPages > 0 ? totalCharCount / totalPages : 0

    parentPort.postMessage({
      reqId,
      result: {
        file_size_bytes: stats.size,
        pages: totalPages,
        char_count: totalCharCount,
        chars_per_page_avg: Math.round(charsPerPageAvg * 10) / 10,
        empty_pages: emptyPages,
        is_scanned: totalPages > 0 && charsPerPageAvg < options.scannedThresholdCharsPerPage,
        parse_duration_ms: Math.round(parseDurationMs),
      },
    })
  } catch (err) {
    parentPort.postMessage({ reqId, error: err && err.message ? err.message : String(err) })
  }
}

parentPort.on('message', handle)
`

interface WarmBenchEntry {
  iteration: number
  parse_duration_ms: number
  round_trip_ms: number
  is_scanned: boolean
  char_count: number
}

interface WarmBenchSummary {
  file: string
  pages: number
  iterations: number
  cold_ms: number
  warm_median_ms: number
  warm_p95_ms: number
  warm_avg_ms: number
  per_iteration: WarmBenchEntry[]
}

class WarmPdfWorker {
  private worker: Worker
  private nextReqId = 1
  private pending = new Map<
    number,
    { resolve: (r: unknown) => void; reject: (e: Error) => void }
  >()

  constructor(pdfjsUrl: string, standardFontDataUrl: string) {
    this.worker = new Worker(WARM_WORKER_SCRIPT, {
      eval: true,
      workerData: { pdfjsUrl, standardFontDataUrl },
    })
    this.worker.on('message', (msg: { reqId: number; result?: unknown; error?: string }) => {
      const pending = this.pending.get(msg.reqId)
      if (!pending) return
      this.pending.delete(msg.reqId)
      if (msg.error) pending.reject(new Error(msg.error))
      else pending.resolve(msg.result)
    })
    this.worker.on('error', err => {
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    })
  }

  parse(
    filePath: string,
    options: ParseOptions = DEFAULT_OPTIONS,
  ): Promise<{
    file_size_bytes: number
    pages: number
    char_count: number
    chars_per_page_avg: number
    empty_pages: number
    is_scanned: boolean
    parse_duration_ms: number
  }> {
    const reqId = this.nextReqId++
    return new Promise((resolvePromise, reject) => {
      this.pending.set(reqId, {
        resolve: r => resolvePromise(r as never),
        reject,
      })
      this.worker.postMessage({ reqId, filePath, options })
    })
  }

  async terminate(): Promise<void> {
    await this.worker.terminate()
  }
}

async function benchmarkWarmWorker(
  filePath: string,
  iterations: number,
): Promise<WarmBenchSummary> {
  const absPath = resolve(filePath)
  const pdfjsUrl = await resolvePdfjsUrl()
  const standardFontDataUrl = resolveStandardFontDataUrl()
  const pool = new WarmPdfWorker(pdfjsUrl, standardFontDataUrl)

  const per_iteration: WarmBenchEntry[] = []
  let pages = 0
  try {
    for (let i = 1; i <= iterations; i++) {
      const t0 = performance.now()
      const r = await pool.parse(absPath)
      const roundTrip = performance.now() - t0
      pages = r.pages
      per_iteration.push({
        iteration: i,
        parse_duration_ms: r.parse_duration_ms,
        round_trip_ms: Math.round(roundTrip * 10) / 10,
        is_scanned: r.is_scanned,
        char_count: r.char_count,
      })
    }
  } finally {
    await pool.terminate()
  }

  const cold_ms = per_iteration[0]?.round_trip_ms ?? 0
  const warmBody = per_iteration.slice(1)
  const sortedWarm = [...warmBody].map(e => e.round_trip_ms).sort((a, b) => a - b)
  const warm_median_ms =
    sortedWarm.length > 0
      ? sortedWarm[Math.floor(sortedWarm.length / 2)]
      : 0
  const warm_p95_ms =
    sortedWarm.length > 0
      ? sortedWarm[Math.min(sortedWarm.length - 1, Math.floor(sortedWarm.length * 0.95))]
      : 0
  const warm_avg_ms =
    sortedWarm.length > 0
      ? Math.round((sortedWarm.reduce((a, b) => a + b, 0) / sortedWarm.length) * 10) / 10
      : 0

  return {
    file: basename(absPath),
    pages,
    iterations,
    cold_ms,
    warm_median_ms: Math.round(warm_median_ms * 10) / 10,
    warm_p95_ms: Math.round(warm_p95_ms * 10) / 10,
    warm_avg_ms,
    per_iteration,
  }
}

// ── CLI ─────────────────────────────────────────────────────────────

interface CliArgs {
  mode: 'direct' | 'worker' | 'both'
  runAll: boolean
  targets: string[]
  textPreviewChars: number
  skipWarmup: boolean
  rawJson: boolean
  benchWarm: number
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    mode: 'direct',
    runAll: false,
    targets: [],
    textPreviewChars: 160,
    skipWarmup: false,
    rawJson: false,
    benchWarm: 0,
  }
  for (const a of argv) {
    if (a === '--all') args.runAll = true
    else if (a === '--no-warmup') args.skipWarmup = true
    else if (a === '--json') args.rawJson = true
    else if (a.startsWith('--mode=')) {
      const v = a.slice('--mode='.length)
      if (v === 'direct' || v === 'worker' || v === 'both') args.mode = v
    } else if (a.startsWith('--preview=')) {
      args.textPreviewChars = Math.max(0, parseInt(a.slice('--preview='.length), 10) || 160)
    } else if (a.startsWith('--bench-warm=')) {
      args.benchWarm = Math.max(1, parseInt(a.slice('--bench-warm='.length), 10) || 10)
    } else if (!a.startsWith('--')) {
      args.targets.push(a)
    }
  }
  return args
}

function formatResult(r: LocalPdfParseResult, preview: number): Record<string, unknown> {
  const pageRate =
    r.parse_duration_ms > 0 && r.pages > 0
      ? Math.round((r.pages / r.parse_duration_ms) * 1000)
      : 0
  return {
    path: basename(r.path),
    file_size_kb: Math.round(r.file_size_bytes / 1024 * 10) / 10,
    pages: r.pages,
    char_count: r.char_count,
    chars_per_page_avg: r.chars_per_page_avg,
    empty_pages: r.empty_pages,
    is_scanned: r.is_scanned,
    parse_duration_ms: r.parse_duration_ms,
    pages_per_sec: pageRate,
    first_page_duration_ms: r.first_page_duration_ms,
    memory_peak_rss_mb: r.memory_peak_rss_mb,
    memory_delta_rss_mb: r.memory_delta_rss_mb,
    strategy: r.strategy,
    worker_boot_ms: r.worker_boot_ms,
    text_preview:
      preview > 0
        ? r.text.slice(0, preview).replace(/\s+/g, ' ').trim() +
          (r.text.length > preview ? '…' : '')
        : undefined,
  }
}

/**
 * 将 pdfjs 的错误信息分类为"业务可消费"的 error_class，供上层策略决策。
 * 分类参考 pdfjs 5.x 的 public error 类型（PasswordException / InvalidPDFException /
 * MissingPDFException / UnexpectedResponseException / UnknownErrorException）。
 */
function classifyError(err: unknown): { error_class: string; message: string } {
  const name = (err as Error)?.name ?? ''
  const message = (err as Error)?.message ?? String(err)
  if (/Password/i.test(name) || /password/i.test(message)) {
    return { error_class: 'encrypted', message }
  }
  if (/InvalidPDF|InvalidRange/i.test(name) || /PDF header|invalid/i.test(message)) {
    return { error_class: 'corrupted', message }
  }
  if (/MissingPDF/i.test(name)) {
    return { error_class: 'not_found', message }
  }
  return { error_class: 'unknown', message }
}

async function runOnce(
  file: string,
  mode: CliArgs['mode'],
  preview: number,
): Promise<void> {
  const abs = resolve(file)
  const exists = await stat(abs).then(() => true).catch(() => false)
  if (!exists) {
    console.error(`[poc] 文件不存在: ${abs}`)
    process.exitCode = 1
    return
  }

  console.log(`\n━━━ ${basename(abs)} ━━━`)

  if (mode === 'direct' || mode === 'both') {
    try {
      const r = await parsePdfDirect(abs)
      console.log('[direct]')
      console.log(JSON.stringify(formatResult(r, preview), null, 2))
    } catch (err) {
      const info = classifyError(err)
      console.log('[direct] 解析异常（按设计应切云端）')
      console.log(JSON.stringify({ path: basename(abs), strategy: 'direct', ...info }, null, 2))
    }
  }

  if (mode === 'worker' || mode === 'both') {
    try {
      const r = await parsePdfInWorkerThread(abs)
      console.log('[worker_threads]')
      console.log(JSON.stringify(formatResult(r, preview), null, 2))
    } catch (err) {
      const info = classifyError(err)
      console.log('[worker_threads] 解析异常（按设计应切云端）')
      console.log(JSON.stringify({ path: basename(abs), strategy: 'worker_threads', ...info }, null, 2))
    }
  }
}

/**
 * 预热主进程 pdfjs 模块 + 解析流水线。
 *
 * Electron 主进程生命周期里 pdfjs-dist 仅被 require 一次，之后所有解析都是
 * "warm" 态。POC 脚本里我们也要对齐这一语义：启动期先跑一次（结果丢弃），
 * 后续 benchmark 才有代表性。如果想看"首次加载成本"（包括 JIT、模块解析、
 * standard fonts 首次拉取等），用 `--no-warmup` 保留裸数据。
 */
async function warmupDirect(): Promise<{ coldMs: number }> {
  const sample = resolve(FIXTURES_DIR, 'text-only.pdf')
  const t0 = performance.now()
  await parsePdfDirect(sample)
  return { coldMs: Math.round(performance.now() - t0) }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  let targets = args.targets
  if (args.runAll) {
    targets = [
      'text-only.pdf',
      'scanned-fake.pdf',
      'mixed.pdf',
      'mostly-scanned.pdf',
      'encrypted.pdf',
      'corrupted.pdf',
      'text-only-100p.pdf',
      'text-only-500p.pdf',
    ].map(f => resolve(FIXTURES_DIR, f))
  }

  // 模式 3：warm worker micro-benchmark
  if (args.benchWarm > 0) {
    if (targets.length === 0) {
      targets = [resolve(FIXTURES_DIR, 'text-only-100p.pdf')]
    }
    for (const t of targets) {
      console.log(`\n━━━ warm-worker benchmark: ${basename(t)} × ${args.benchWarm} ━━━`)
      const summary = await benchmarkWarmWorker(t, args.benchWarm)
      console.log(JSON.stringify(summary, null, 2))
    }
    return
  }

  if (targets.length === 0) {
    console.error('用法: poc-local-pdf-parse <pdf-path> [--mode=direct|worker|both] [--preview=N] [--no-warmup]')
    console.error('     poc-local-pdf-parse --all')
    console.error('     poc-local-pdf-parse <pdf-path> --bench-warm=20   # 长驻 worker 稳态压测')
    process.exit(1)
  }

  if (!args.skipWarmup && (args.mode === 'direct' || args.mode === 'both')) {
    const { coldMs } = await warmupDirect()
    if (!args.rawJson) {
      console.log(`[warmup] direct 冷启动（10 页样本）耗时 ${coldMs}ms；后续测量均为 warm 稳态。\n`)
    }
  }

  for (const t of targets) {
    await runOnce(t, args.mode, args.textPreviewChars)
  }
}

void main()
