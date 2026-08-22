/**
 * doc-parser-handlers — PDF/docx/xlsx 解析纯函数（不含 worker 协议层）
 *
 * 设计意图：
 *   - 让解析逻辑与 worker_threads 协议解耦，便于单测直接调用
 *   - worker 脚本（宿主侧 doc-parser-worker.ts）import 本文件，只负责协议分发
 *   - 本文件在 Node/Electron/Vitest 任意环境都可跑（无 parentPort 依赖）
 *
 * 所有副作用（fs I/O、pdfjs/mammoth/xlsx 模块加载）都在此处完成；
 * 调用方只需传"纯数据 payload"即得到"纯结果"。
 *
 * pdfjs-dist 路径解析：通过 `createRequire(import.meta.url)` + 优雅退化路径，
 * 兼容：
 *   1. 直接安装 pdfjs-dist 的宿主（如 Daemon）
 *   2. 通过 react-pdf 间接依赖 pdfjs-dist 的宿主（如 Electron renderer 复用）
 *   3. monorepo workspace symlink + hoisted node_modules
 */

import { readFile, stat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { computeTextLayerQuality } from '../text-layer-quality.js'
import type {
  ParseDocxPayload,
  ParseDocxResult,
  ParsePdfPayload,
  ParsePdfResult,
  ParseXlsxPayload,
  ParseXlsxResult,
} from './tasks.js'

// ── 懒加载 pdfjs-dist ──────────────────────────────────────────

type PdfjsModule = typeof import('pdfjs-dist')

let pdfjsPromise: Promise<PdfjsModule> | null = null
let standardFontDataUrl: string | null = null

function resolvePdfjsPaths(): { pdfjsUrl: string; fontDir: string } {
  const req = createRequire(import.meta.url)

  const tryPath = (pkgPath: string): { pdfjsUrl: string; fontDir: string } | null => {
    const root = dirname(pkgPath)
    const candidate = resolve(root, 'legacy', 'build', 'pdf.mjs')
    if (!existsSync(candidate)) return null
    return {
      pdfjsUrl: pathToFileURL(candidate).href,
      fontDir: pathToFileURL(resolve(root, 'standard_fonts') + '/').href,
    }
  }

  try {
    const direct = req.resolve('pdfjs-dist/package.json')
    const resolved = tryPath(direct)
    if (resolved) return resolved
  } catch {
    /* 回退到下一级 */
  }

  try {
    const reactPdfPkg = req.resolve('react-pdf/package.json')
    const sibling = resolve(dirname(reactPdfPkg), '..', 'pdfjs-dist', 'package.json')
    if (existsSync(sibling)) {
      const resolved = tryPath(sibling)
      if (resolved) return resolved
    }
  } catch {
    /* 回退到下一级 */
  }

  throw new Error(
    'pdfjs-dist 未能解析：请确保宿主 package.json 声明 pdfjs-dist 依赖（或通过 react-pdf 间接依赖）。',
  )
}

function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    const paths = resolvePdfjsPaths()
    standardFontDataUrl = paths.fontDir
    pdfjsPromise = import(paths.pdfjsUrl).then((mod: PdfjsModule) => {
      // POC §5 R9：损坏 PDF 会触发 pdfjs 往 stderr 打 `Warning: Indexing all PDF objects`，
      // 生产环境污染日志。显式关闭 verbosity（0 = ERRORS 级）。
      // 类型上 GlobalWorkerOptions 没有 verbosity 字段（pdfjs 5.x 公开 API 漂移），runtime 保留
      const globalOpts = (mod as unknown as { GlobalWorkerOptions?: Record<string, unknown> }).GlobalWorkerOptions
      if (globalOpts) globalOpts.verbosity = 0
      return mod
    }) as Promise<PdfjsModule>
  }
  return pdfjsPromise
}

interface PdfTextItemLike {
  str?: string
  transform?: number[]
  width?: number
  height?: number
}

interface PositionedPdfTextItem {
  text: string
  normalized: string
  x0: number
  x1: number
  y: number
  height: number
}

function normalizePdfText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function horizontalOverlapRatio(a: PositionedPdfTextItem, b: PositionedPdfTextItem): number {
  const overlap = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0))
  const smallerWidth = Math.max(1, Math.min(a.x1 - a.x0, b.x1 - b.x0))
  return overlap / smallerWidth
}

function isOverlappingTextDuplicate(
  candidate: PositionedPdfTextItem,
  kept: PositionedPdfTextItem,
): boolean {
  if (horizontalOverlapRatio(candidate, kept) < 0.65) return false
  return (
    candidate.normalized === kept.normalized
    || candidate.normalized.includes(kept.normalized)
    || kept.normalized.includes(candidate.normalized)
  )
}

function joinPdfLine(items: PositionedPdfTextItem[]): { text: string; duplicateItemsRemoved: number } {
  const deduplicated: PositionedPdfTextItem[] = []
  const widestFirst = [...items].sort((a, b) => {
    const widthDelta = (b.x1 - b.x0) - (a.x1 - a.x0)
    return widthDelta !== 0 ? widthDelta : b.text.length - a.text.length
  })
  for (const item of widestFirst) {
    if (!deduplicated.some((kept) => isOverlappingTextDuplicate(item, kept))) {
      deduplicated.push(item)
    }
  }

  deduplicated.sort((a, b) => a.x0 - b.x0)
  let line = ''
  let previous: PositionedPdfTextItem | undefined
  for (const item of deduplicated) {
    if (previous && line && !/\s$/.test(line) && !/^\s/.test(item.text)) {
      const gap = item.x0 - previous.x1
      const spaceThreshold = Math.max(1, Math.min(previous.height, item.height) * 0.12)
      if (gap > spaceThreshold) line += ' '
    }
    line += item.text
    previous = item
  }
  return {
    text: line.replace(/\s+/g, ' ').trim(),
    duplicateItemsRemoved: items.length - deduplicated.length,
  }
}

function reconstructPdfPage(items: PdfTextItemLike[]): {
  text: string
  sourceItems: number
  duplicateItemsRemoved: number
} {
  const sourceItems = items.filter((item) => typeof item.str === 'string' && item.str.trim()).length
  let duplicateItemsRemoved = 0
  const positioned = items.flatMap((item): PositionedPdfTextItem[] => {
    const text = typeof item.str === 'string' ? item.str.trim() : ''
    const transform = item.transform
    if (!text || !transform || transform.length < 6) return []
    const x0 = Number(transform[4])
    const y = Number(transform[5])
    const width = Math.max(0, Number(item.width ?? 0))
    if (!Number.isFinite(x0) || !Number.isFinite(y)) return []
    return [{
      text,
      normalized: normalizePdfText(text),
      x0,
      x1: x0 + width,
      y,
      height: Math.max(1, Number(item.height ?? 0)),
    }]
  })

  positioned.sort((a, b) => b.y - a.y || a.x0 - b.x0)
  const lines: Array<{ y: number; items: PositionedPdfTextItem[] }> = []
  for (const item of positioned) {
    const line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= 2)
    if (line) line.items.push(item)
    else lines.push({ y: item.y, items: [item] })
  }
  const text = lines
    .map((line) => {
      const reconstructed = joinPdfLine(line.items)
      duplicateItemsRemoved += reconstructed.duplicateItemsRemoved
      return reconstructed.text
    })
    .filter(Boolean)
    .join('\n')
  return { text, sourceItems, duplicateItemsRemoved }
}

/**
 * Paper Capture PDF 常同时包含原始文本层与 OCR 层。按基线分组后保留同坐标下
 * 最完整的文本表示，再依据横向间距恢复词边界。
 */
export function reconstructPdfPageText(items: PdfTextItemLike[]): string {
  return reconstructPdfPage(items).text
}

export async function handleParsePdf(payload: ParsePdfPayload): Promise<ParsePdfResult> {
  const t0 = performance.now()
  const pdfjs = await loadPdfjs()
  const stats = await stat(payload.filePath)
  const data = new Uint8Array(await readFile(payload.filePath))

  const loadingTask = pdfjs.getDocument({
    data,
    // Node 无 DOM Worker，显式关闭避免 pdfjs 试图 spawn web worker。
    // pdfjs 5.x 从 DocumentInitParameters 公开类型里移除了 `disableWorker` 字段
    // 但 runtime 仍解析该选项（参见 src/display/api.js），POC 实测有效。
    // @ts-expect-error — pdfjs 5.x public type 漂移，runtime 仍保留
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
    ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
  })

  const pdf = await loadingTask.promise
  const totalPages = Math.min(pdf.numPages, payload.maxPages)
  let totalCharCount = 0
  let emptyPages = 0
  let firstPageDurationMs = 0
  let sourceTextItems = 0
  let duplicateItemsRemoved = 0
  const textBuffer: string[] = []

  try {
    for (let i = 1; i <= totalPages; i++) {
      const pageT0 = performance.now()
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()

      const reconstructed = reconstructPdfPage(content.items as PdfTextItemLike[])
      const pageText = reconstructed.text
      sourceTextItems += reconstructed.sourceItems
      duplicateItemsRemoved += reconstructed.duplicateItemsRemoved

      textBuffer.push(pageText)
      totalCharCount += pageText.length
      if (pageText.trim().length === 0) emptyPages += 1

      if (i === 1) firstPageDurationMs = performance.now() - pageT0

      page.cleanup()
    }
  } finally {
    await pdf.destroy()
  }

  const text = textBuffer.join('\n\n')
  const charsPerPageAvg = totalPages > 0 ? totalCharCount / totalPages : 0
  const isScanned = totalPages > 0 && charsPerPageAvg < payload.scannedThresholdCharsPerPage

  // Verifier-B 必修 2：quality 计算搬到 worker 内部（原来在主进程对整份文本做 O(n)
  // 遍历 + freq Map 可能短时阻塞事件循环，对 500 页 PDF 拼接的 50-500KB 字符串
  // 特别明显）。worker 已经 loaded text，计算顺手完成，主进程只读值。
  const qualityScore = computeTextLayerQuality(text)

  const parseDurationMs = performance.now() - t0

  return {
    text,
    pages: totalPages,
    charCount: totalCharCount,
    charsPerPageAvg: Math.round(charsPerPageAvg * 10) / 10,
    emptyPages,
    isScanned,
    qualityScore,
    duplicateItemsRemoved,
    duplicateRatio: sourceTextItems > 0
      ? Math.round((duplicateItemsRemoved / sourceTextItems) * 10_000) / 10_000
      : 0,
    fileSizeBytes: stats.size,
    parseDurationMs: Math.round(parseDurationMs),
    firstPageDurationMs: Math.round(firstPageDurationMs),
  }
}

// ── 懒加载 mammoth ─────────────────────────────────────────────

type MammothModule = {
  extractRawText: (input: { buffer: Buffer }) => Promise<{
    value: string
    messages: Array<{ type: string; message: string }>
  }>
}

let mammothPromise: Promise<MammothModule> | null = null

function loadMammoth(): Promise<MammothModule> {
  if (!mammothPromise) {
    mammothPromise = import('mammoth').then((m) => {
      const mod = (m as unknown as { default?: MammothModule }).default ?? (m as unknown as MammothModule)
      return mod
    })
  }
  return mammothPromise
}

export async function handleParseDocx(payload: ParseDocxPayload): Promise<ParseDocxResult> {
  const t0 = performance.now()
  const mammoth = await loadMammoth()
  const stats = await stat(payload.filePath)
  const buffer = await readFile(payload.filePath)

  const result = await mammoth.extractRawText({ buffer })
  const parseDurationMs = performance.now() - t0

  return {
    text: result.value,
    fileSizeBytes: stats.size,
    parseDurationMs: Math.round(parseDurationMs),
    messageCount: result.messages.length,
  }
}

// ── 懒加载 xlsx（SheetJS） ─────────────────────────────────────

type XlsxModule = {
  read: (buffer: Uint8Array, options: { type: 'array'; cellDates?: boolean }) => {
    SheetNames: string[]
    Sheets: Record<string, unknown>
  }
  utils: {
    sheet_to_json: <T>(worksheet: unknown, options: { header: 1; defval: string; raw: boolean }) => T[]
    encode_col: (col: number) => string
  }
}

let xlsxPromise: Promise<XlsxModule> | null = null

function loadXlsx(): Promise<XlsxModule> {
  if (!xlsxPromise) {
    xlsxPromise = import('xlsx').then((m) => {
      const mod = (m as unknown as { default?: XlsxModule }).default ?? (m as unknown as XlsxModule)
      return mod
    })
  }
  return xlsxPromise
}

function renderSheetAsMarkdown(
  rows: unknown[][],
  sheetName: string,
  maxRowsPerSheet: number,
): { markdown: string; rowsTruncated: boolean; cellCount: number } {
  const truncated = rows.length > maxRowsPerSheet
  const limited = truncated ? rows.slice(0, maxRowsPerSheet) : rows
  //  顺带修：空 sheet 时 sheet_to_json 可能返回 [[]]（1 行 0 列）而非 []，
  // 只查 length===0 会漏掉，渲染出 `| |\n||` 退化 1×1 空表。补查"所有行都是空行"。
  if (limited.length === 0 || limited.every((r) => r.length === 0)) {
    return { markdown: `## ${sheetName}\n\n（该工作表为空）`, rowsTruncated: false, cellCount: 0 }
  }

  let cellCount = 0
  const maxCols = limited.reduce((m, r) => Math.max(m, r.length), 0)

  // 用户视角 Review：把「只读了前 N 行」前置在 Sheet 标题下，Agent 更容易转述给用户，
  // 避免用户以为"全表都看过"。消息用中文、Agent 转述时自然。
  const lines: string[] = [`## ${sheetName}`]
  if (truncated) {
    lines.push(
      '',
      `（注：该工作表共 ${rows.length} 行，仅读取了前 ${maxRowsPerSheet} 行。`
      + `如需分析剩余 ${rows.length - maxRowsPerSheet} 行内容，请告诉用户缩小数据范围或分段上传。）`,
    )
  }
  lines.push('')

  const formatCell = (v: unknown): string => {
    if (v == null || v === '') return ''
    cellCount += 1
    if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10)
    const s = String(v).replace(/\n/g, ' ').replace(/\|/g, '\\|')
    return s.length > 200 ? s.slice(0, 200) + '…' : s
  }

  const headerCells = (limited[0] ?? []).map(formatCell)
  while (headerCells.length < maxCols) headerCells.push('')
  const header = `| ${headerCells.join(' | ')} |`
  const separator = `|${headerCells.map(() => '---').join('|')}|`
  lines.push(header, separator)

  for (let i = 1; i < limited.length; i++) {
    const row = limited[i] ?? []
    const cells = row.map(formatCell)
    while (cells.length < maxCols) cells.push('')
    lines.push(`| ${cells.join(' | ')} |`)
  }

  return { markdown: lines.join('\n'), rowsTruncated: truncated, cellCount }
}

export async function handleParseXlsx(payload: ParseXlsxPayload): Promise<ParseXlsxResult> {
  const t0 = performance.now()
  const xlsx = await loadXlsx()
  const stats = await stat(payload.filePath)
  const buffer = new Uint8Array(await readFile(payload.filePath))

  const workbook = xlsx.read(buffer, { type: 'array', cellDates: true })

  const sheetNames = workbook.SheetNames
  const sheetsTruncated = Math.max(0, sheetNames.length - payload.maxSheets)
  const visibleSheets = sheetNames.slice(0, payload.maxSheets)

  let rowsTruncatedCount = 0
  let cellCount = 0
  const sections: string[] = []

  for (const name of visibleSheets) {
    const ws = workbook.Sheets[name]
    if (!ws) continue
    const rows = xlsx.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      defval: '',
      raw: false,
    })
    const rendered = renderSheetAsMarkdown(rows, name, payload.maxRowsPerSheet)
    if (rendered.rowsTruncated) rowsTruncatedCount += 1
    cellCount += rendered.cellCount
    sections.push(rendered.markdown)
  }

  if (sheetsTruncated > 0) {
    // 用户视角 Review：前置整体摘要，让 Agent 优先转述"N 个工作表里只读了 M 个"，
    // 避免用户误以为所有 sheet 都被分析了。
    sections.unshift(
      `（注：该 Excel 文件共 ${sheetNames.length} 个工作表，仅读取了前 ${payload.maxSheets} 个。`
      + `如需分析后 ${sheetsTruncated} 个工作表，请让用户指定具体 sheet 名。）`,
    )
  }

  const parseDurationMs = performance.now() - t0
  return {
    text: sections.join('\n\n'),
    sheetCount: visibleSheets.length,
    sheetsTruncated,
    rowsTruncatedCount,
    cellCount,
    fileSizeBytes: stats.size,
    parseDurationMs: Math.round(parseDurationMs),
  }
}
