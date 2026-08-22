/**
 * doc-parser-tasks — Worker 任务协议类型
 *
 * **H2-E 重构后**：类型已迁到 `@tabtin/local-docparse/workers`，本文件再导出
 * 保持向后兼容（原 import 路径继续可用）。
 */

export type {
  DocParserPayloadMap,
  DocParserResultMap,
  DocParserTaskType,
  ParseDocxPayload,
  ParseDocxResult,
  ParsePdfPayload,
  ParsePdfResult,
  ParseXlsxPayload,
  ParseXlsxResult,
} from '@tabtin/local-docparse/workers'
