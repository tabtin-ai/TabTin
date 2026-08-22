/**
 * @tabtin/os-errors — Public API
 *
 * 三类调用方：
 *   1. safe-fs / 文件操作 wrapper —— `classifyFsError` 把原始 errno 归一
 *   2. Tool 层 —— `toToolError` 序列化给 Agent / IPC
 *   3. CLI / 测试 —— `renderForAgent` 直接拿到给 LLM / 用户看的文案
 */

export type {
  OSError,
  OSToolError,
  OSErrorCode,
  OSErrorCategory,
  RecoveryAction,
  RecoveryActionType,
} from './types.js';

export { isOSError } from './types.js';

export {
  classifyFsError,
  buildAVTimeoutError,
  OS_ACCESS_ERRNO_CODES,
} from './classify.js';
export type { OSAccessErrno } from './classify.js';

export { inferCategoryFromPath } from './paths.js';

export { renderForAgent, toToolError, fromToolError } from './serialize.js';

export { renderTemplate } from './templates.js';

export { renderForCLI } from './cli-render.js';
