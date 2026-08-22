/**
 * 统一错误类型定义
 *
 * 从 @tabtin/browser-core re-export，避免两套定义不一致。
 */
export {
  ToolErrorCode,
  ToolErrorFactory,
  isRetriableError,
  isFatalError,
} from '@tabtin/browser-core';
export type { ToolError, StandardToolOutput } from '@tabtin/browser-core';
