/**
 * @tabtin/local-docparse — 业务类型定义
 *
 * 所有"对外"契约类型集中在这里，主入口 `parseLocalAttachment` 与两侧宿主
 * （Electron / Daemon）共享同一份语义。
 *
 * 字段命名统一 camelCase（与 TS 主流约定一致；序列化到 telemetry/IPC 时由宿主
 * 各自决定 snake_case 转换）。
 *
 * **W1（2026-05-13）错误码统一**：旧 `LocalDocParseErrorClass` 自定义 10 类
 * union 整体退役，改为 re-export `@tabtin/file-pipeline-errors` 的全局
 * `FilePipelineErrorCode`。两个原因：
 *
 *   1. **SSoT** —— file pipeline 13 类错误码（含 local-docparse 用的 8 种 +
 *      上游 4 种）由 file-pipeline-errors 包统一定义；local-docparse 是
 *      消费者，不是另起一份。
 *   2. **修复 lossy 映射** —— 旧 adapter 层的压扁映射函数把 6 个本地类全部
 *      压成 `UNSUPPORTED_OPERATION=4`，LLM 拿不到"扫描件 vs 加密 vs 损坏"精确
 *      信号。本次把全局 enum 直接用进 local-docparse，adapter 不再需要做压扁
 *      映射，该函数彻底删除（通过 `formatFilePipelineError` 派发 envelope 取代）。
 *
 * 旧字符串值已全部改名对齐 FilePipelineErrorCode：
 *   - `'oversize'`        → `'file_too_large'`
 *   - `'unsupported'`     → `'unsupported_format'`
 *   - `'scanned'`         → `'scanned_pdf'`
 *   - `'timeout'`         → `'parse_timeout'`
 *   - `'not_found'`       → `'file_not_found'`
 *   - `'unknown'`         → `'upstream_error'`
 *   - `'aborted'` / `'encrypted'` / `'corrupted'` / `'garbled_text_layer'` 保留同名
 */

import type {
  FilePipelineErrorCode,
} from '@tabtin/file-pipeline-errors';

export { FilePipelineErrorCode } from '@tabtin/file-pipeline-errors';

/**
 * Local docparse 错误分类 —— 直接复用 file-pipeline-errors 全局 enum 的字符串值。
 *
 * 实际上 local-docparse 只可能产出其中 8 类（不包括 PERMISSION_DENIED /
 * INVALID_PARAMETER —— 那是上游 adapter 的事），但类型层面用 FilePipelineErrorCode
 * 全集是为了让消费者直接用同一套字面值做 switch / map 不漏 case。
 *
 * **W5 L32 / Wave 3 jsdoc**：
 *
 * 数字 `TabcodeErrorCode` 协议已删除。运行时仅以字符串 `error_kind`
 * （`FilePipelineErrorCode` / ToolErrorKind）标识失败类。
 *
 * 二元视角：
 *   - **file pipeline 视角**（本包）：worker 抛错 → classifyWorkerError → 8 类
 *     之一（FilePipelineErrorCode 子集，本类型完整定义为 FilePipelineErrorCode 全集
 *     供消费者 switch 不漏 case，但运行时只产出子集）。
 *   - **edit_file 视角**（agent-runtime）：envelope 用 string kind
 *     （如 `tool_stale_read` / `old_string_not_found`）+ file pipeline kind。
 *
 * **运行时校验**：`error-classifier.test.ts::W5 L32` 加的契约测试钉死
 * `classifyWorkerError` 返值字面量始终属于 `FILE_PIPELINE_ERROR_KINDS` SSoT
 * 14 类全集（包含约束，不是等价约束）。SSoT 加新 kind 时本测试自动覆盖。
 */
export type LocalDocParseErrorClass = FilePipelineErrorCode;

export interface LocalDocParseSuccess {
  success: true
  /** 拼接后的文本（上层可直接注入 prompt） */
  text: string
  /** PDF 专属：总页数 */
  pages?: number
  /** PDF 专属：是否扫描件（即使返回 success 也可能 true — 极少见的边界保留 hook） */
  isScanned?: boolean
  /** PDF 专属：文本层质量得分（0-1，1 最佳）— 诊断用，上层不依赖 */
  qualityScore?: number
  mimeType: string
  /** 源文件字节大小（解析后已知） */
  fileSizeBytes: number
  /** 本地端到端耗时（ms，含 URL 下载 + worker round-trip） */
  durationMs: number
}

export interface LocalDocParseFailure {
  success: false
  errorClass: LocalDocParseErrorClass
  message: string
  /** 是否建议上层切云端（区别于"提示给用户"） */
  fallbackToCloud: boolean
  /** 可选：被解析的 mime（用于埋点） */
  mimeType?: string
  /** 本地耗到失败前的时长（ms） */
  durationMs: number
}

export type LocalDocParseResult = LocalDocParseSuccess | LocalDocParseFailure

export interface LocalDocParseOptions {
  /**
   * 硬超时（默认值由 `DEFAULT_TIMEOUT_MS` 决定，宿主可覆盖）— 覆盖 "URL 下载 +
   * worker 解析" 的**整体**预算。下载消耗的时间会从 worker 解析预算里扣除（v1.1
   * 修复 v1.0 串行双倍问题）。
   */
  timeoutMs?: number
  /** 最大允许的本地解析文件大小（MB），超过则返回 `FilePipelineErrorCode.FILE_TOO_LARGE`
   *  （W1 起 `'oversize'` 字面值已退役）。 */
  maxFileSizeMb?: number
  /** 扫描件判定阈值：chars/page 低于此值视为扫描件（默认 100，对齐 Django） */
  scannedThresholdCharsPerPage?: number
  /** 质量得分低于此值视为乱码文本层（默认 0.3） */
  qualityMinScore?: number
  /** 最大解析页数（PDF）。默认 2000 */
  maxPages?: number
  /** Excel 单文件最大 sheet 数（默认 20，对齐 XlsxViewer） */
  maxSheets?: number
  /** Excel 单 sheet 最大行数（默认 200） */
  maxRowsPerSheet?: number
  /** 显式指定 mime（默认从 input 推断） */
  mimeType?: string
  /** 显式指定文件名（URL 下载时用于诊断日志） */
  filename?: string
  /**
   * 上游 abort 信号（如用户点"停止生成"）。触发时：
   *   - URL 下载中断
   *   - 已经排队到 worker runner 的任务会被 reject
   *   - 已经开始执行的 worker 任务无法立即中止（由 worker 内部逻辑决定）
   *     但 Runner 会在任务完成时丢弃结果
   */
  signal?: AbortSignal
}

export interface ParseLocalAttachmentInput {
  /** 绝对路径（首选）或 https URL。URL 会被下载到 tmp 再解析。 */
  source: { kind: 'path'; path: string } | { kind: 'url'; url: string }
  mimeType: string
  /** 可选文件名；URL 来源时用于诊断日志 + 后缀推断 */
  filename?: string
  /** 提前已知体积（可选）；不给则 URL 走 content-length 检测 */
  fileSizeBytes?: number
}
