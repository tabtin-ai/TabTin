/**
 * localDocParse — 本地附件解析（FR-18 Phase 1）
 *
 * **H2-E 重构后**：本文件已变薄壳——核心逻辑（pdfjs / mammoth / xlsx 解析、
 * 错误分类、文本质量评估、worker 池）抽到 `@tabtin/local-docparse` 共享包，
 * Electron 与 Daemon 同一份实现。本壳只负责：
 *   1. 注入 Electron 端的 worker pool（`./workers/doc-parser-runner` 用 Vite 产物路径）
 *   2. 注入 Electron 端的 logger（`createLogger('LocalDocParse')`）
 *   3. 重导出共享包的 API + 类型，**保持向后兼容**（现有调用方 / 测试 / 脚本无需改）
 *
 * 历史决策与变更原因都在共享包源代码里（`packages/local-docparse/src/`）。
 */

import {
  parseLocalAttachment as parseLocalAttachmentShared,
  type LocalDocParseOptions,
  type LocalDocParseResult,
  type ParseLocalAttachmentInput,
} from '@tabtin/local-docparse'
import { createLogger } from '../logger.js'
import { runDocParserTask } from '../workers/doc-parser-runner.js'

const log = createLogger('LocalDocParse')

/**
 * 本地解析附件（与 H1-D-MAIN 签名完全兼容）。
 *
 * 共享包接收 deps 注入；本壳负责把 Electron 的 worker 池 + logger 接进去。
 */
export function parseLocalAttachment(
  input: ParseLocalAttachmentInput,
  options: LocalDocParseOptions = {},
): Promise<LocalDocParseResult> {
  return parseLocalAttachmentShared(input, options, {
    runDocParserTask,
    logger: { debug: log.debug },
  })
}

// ─── 重导出以保持向后兼容 ─────────────────────────────────────────

export {
  DEFAULT_MAX_LOCAL_FILE_SIZE_MB,
  DEFAULT_SCANNED_THRESHOLD_CHARS_PER_PAGE,
  DEFAULT_TIMEOUT_MS,
  DownloadHttpError,
  __forTesting,
  classifyWorkerError,
  assessCloudSummaryQuality,
  computeTextLayerQuality,
  FilePipelineErrorCode,
  // W1.3 第 3 轮 Review 2 S1：持久通道 main agent 注入中文转述路径
  formatFilePipelineErrorChinesePrompt,
  isFilePipelineErrorCode,
} from '@tabtin/local-docparse'

export type {
  LocalDocParseErrorClass,
  LocalDocParseFailure,
  LocalDocParseOptions,
  LocalDocParseResult,
  LocalDocParseSuccess,
  ParseLocalAttachmentInput,
} from '@tabtin/local-docparse'
