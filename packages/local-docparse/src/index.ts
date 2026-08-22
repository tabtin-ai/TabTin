/**
 * @tabtin/local-docparse — 本地附件解析共享包
 *
 * 业务背景：FR-18 Phase 1（H1-D-MAIN，Electron 已交付）+ FR-18 Phase 2（H2-E，
 * Daemon 对齐）。两端宿主共用一套解析逻辑，避免行为漂移。
 *
 * **导出层次**：
 *   - 主入口（本文件）：业务 API（parseLocalAttachment）+ 类型 + 错误分类 +
 *     文本质量评估
 *   - `./workers` 子路径：worker entry 脚本需要的 handlers + 协议 + 通用 Runner
 *     （主线程**不**应导入 handlers，否则会拖入 pdfjs/mammoth/xlsx 的冷启动开销）
 *
 * **宿主集成模板**：
 *   ```ts
 *   // 1. 创建 worker entry 脚本（apps/<host>/src/workers/doc-parser-worker.ts）
 *   import { parentPort } from 'node:worker_threads'
 *   import { handleParsePdf, handleParseDocx, handleParseXlsx, serializeWorkerError }
 *     from '@tabtin/local-docparse/workers'
 *   parentPort!.on('message', async (msg) => { ... })
 *
 *   // 2. 创建 worker pool runner（apps/<host>/src/workers/doc-parser-runner.ts）
 *   import { WorkerTaskRunner } from '@tabtin/local-docparse/workers'
 *   const runner = new WorkerTaskRunner({
 *     workerScriptPath: '<host-specific bundle path>',
 *     concurrency: 2,
 *     idleTimeoutMs: 30 * 60 * 1000,
 *   })
 *
 *   // 3. 业务调用 parseLocalAttachment 注入 runner
 *   import { parseLocalAttachment } from '@tabtin/local-docparse'
 *   const result = await parseLocalAttachment(
 *     { source: { kind: 'url', url: a.url }, mimeType: a.mime_type, fileSizeBytes: a.size },
 *     { signal, maxFileSizeMb: 20 }, // Daemon 默认 20MB；Electron 走默认 50MB
 *     { runDocParserTask: (t, p, o) => runner.runTask(t, p, o), logger },
 *   )
 *   ```
 */

export {
  parseLocalAttachment,
  DEFAULT_MAX_LOCAL_FILE_SIZE_MB,
  DEFAULT_SCANNED_THRESHOLD_CHARS_PER_PAGE,
  DEFAULT_TIMEOUT_MS,
  __forTesting,
} from './parseLocalAttachment.js'

export type {
  ParseLocalAttachmentDeps,
  ParseLocalAttachmentLogger,
  RunDocParserTask,
  RunDocParserTaskOptions,
} from './parseLocalAttachment.js'

export type {
  LocalDocParseErrorClass,
  LocalDocParseFailure,
  LocalDocParseOptions,
  LocalDocParseResult,
  LocalDocParseSuccess,
  ParseLocalAttachmentInput,
} from './types.js'

// W1（2026-05-13）：暴露全局 FilePipelineErrorCode 枚举常量给宿主使用，避免
// 各处 import 路径分裂（宿主 import '@tabtin/local-docparse' 即可拿到 enum，
// 不必专门依赖 '@tabtin/file-pipeline-errors'）。
export { FilePipelineErrorCode } from './types.js'

// W1.3 第 3 轮 Review 2 S1（2026-05-13）：持久通道 main agent prompt 注入路径
// 需要的两个工具——type guard + 中文转述派发器。沿用同款"宿主 import 一个包"
// 哲学。SSoT 仍在 `@tabtin/file-pipeline-errors`。
// **Review 3 M-5**：`FILE_PIPELINE_ERROR_KINDS` re-export 让前端 catalog 完整性
// 测试能直接遍历 SSoT 8 类专属字面值（不再硬编码列表 → 减少 SSoT 加 1 类时的
// 同步漂移点）。
export {
  formatFilePipelineErrorChinesePrompt,
  isFilePipelineErrorCode,
  FILE_PIPELINE_ERROR_KINDS,
} from '@tabtin/file-pipeline-errors'

export {
  DownloadHttpError,
  classifyWorkerError,
  errorClassToFallback,
} from './error-classifier.js'

export { computeTextLayerQuality } from './text-layer-quality.js'

export {
  assessCloudSummaryQuality,
} from './cloud-summary-quality.js'

export type {
  CloudSummaryQualityVerdict,
} from './cloud-summary-quality.js'
