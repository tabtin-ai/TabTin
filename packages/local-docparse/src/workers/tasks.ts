/**
 * doc-parser-tasks — Worker 任务协议定义
 *
 * 主线程（parseLocalAttachment）与 worker_threads 之间仅传递**纯数据**（文件路径 +
 * 选项），返回**纯结果**（text / pages / metadata）。所有副作用（fs
 * I/O、pdfjs 初始化、mammoth 加载、xlsx 解析）都在 worker 侧完成，避免阻塞
 * 主进程事件循环。
 *
 * 错误处理策略：worker 捕获异常后，把原生 Error `name` / `message` 序列化
 * 经 worker-task-protocol 透传给主线程；主线程 `parseLocalAttachment` 侧做
 * classification（encrypted / corrupted / ...）。保持 worker 零业务知识。
 */

export type DocParserTaskType = 'parse-pdf' | 'parse-docx' | 'parse-xlsx'

// ── 参数类型 ────────────────────────────────────────────────────

export interface ParsePdfPayload {
  /** 待解析文件的绝对路径（worker 内 readFile） */
  filePath: string
  /** 最大解析页数（对齐 Django：2000 页硬截断） */
  maxPages: number
  /** chars/page 低于此值 → is_scanned=true（对齐 Django：100） */
  scannedThresholdCharsPerPage: number
}

export interface ParsePdfResult {
  /** 拼接后的文本（每页以 \n\n 分隔） */
  text: string
  /** 总页数（maxPages 截断后） */
  pages: number
  /** 总字符数（统计用） */
  charCount: number
  /** 每页平均字符数（保留一位小数） */
  charsPerPageAvg: number
  /** 空页数（text.trim() === ''） */
  emptyPages: number
  /** 是否识别为扫描件（chars/page < 阈值） */
  isScanned: boolean
  /**
   * 文本层质量得分（0-1，1 最佳，对齐 Django `_is_text_layer_reliable`）。
   *
   * Verifier-B 必修 2 修复：v1.0 把 quality 计算放在主进程，对 500 页 PDF
   * 拼接出的 50-500KB 字符串做 O(n) 遍历 + freq Map，慢机器上可能阻塞事件
   * 循环 10-50ms。v1.1 改为 worker 内部计算后透传（CPU 放 worker，主进程
   * 只读值），彻底消除主进程长字符串扫描。
   *
   * 实现位置：`handlers.ts handleParsePdf` 末尾调
   * `computeTextLayerQuality(textBuffer.join(...))`。
   */
  qualityScore: number
  /** 因坐标重叠被识别为 OCR/原始文本层副本的 item 数 */
  duplicateItemsRemoved?: number
  /** duplicateItemsRemoved / 有效文本 item 数（0-1） */
  duplicateRatio?: number
  /** 文件字节大小 */
  fileSizeBytes: number
  /** worker 内解析耗时（毫秒，含 readFile + pdfjs） */
  parseDurationMs: number
  /** 首页解析耗时（用于冷启动监控） */
  firstPageDurationMs: number
}

export interface ParseDocxPayload {
  filePath: string
}

export interface ParseDocxResult {
  /** mammoth extractRawText 结果 */
  text: string
  /** 文件字节大小 */
  fileSizeBytes: number
  /** 解析耗时（毫秒） */
  parseDurationMs: number
  /** mammoth 返回的消息数（警告 / 错误计数，用于监控质量） */
  messageCount: number
}

export interface ParseXlsxPayload {
  filePath: string
  /** 最大解析 sheet 数（对齐 XlsxViewer：20；超出截断） */
  maxSheets: number
  /** 每个 sheet 的最大行数（防止大表格打爆文本预算） */
  maxRowsPerSheet: number
}

export interface ParseXlsxResult {
  /** 拼接后的文本（按 sheet 分段，每段带 `## <sheet_name>` 标题 + Markdown 表格） */
  text: string
  /** 实际解析的 sheet 数 */
  sheetCount: number
  /** 被截断的 sheet 数（超过 maxSheets） */
  sheetsTruncated: number
  /** 单 sheet 最大行数被截断的次数 */
  rowsTruncatedCount: number
  /** 总非空单元格数（统计用） */
  cellCount: number
  fileSizeBytes: number
  parseDurationMs: number
}

// ── 类型映射 ────────────────────────────────────────────────────

export interface DocParserPayloadMap {
  'parse-pdf': ParsePdfPayload
  'parse-docx': ParseDocxPayload
  'parse-xlsx': ParseXlsxPayload
}

export interface DocParserResultMap {
  'parse-pdf': ParsePdfResult
  'parse-docx': ParseDocxResult
  'parse-xlsx': ParseXlsxResult
}
