/**
 * @tabtin/action-tools — Public SDK Surface
 *
 * Keep this entry intentionally tiny.
 * Internal consumers should use subpath imports:
 *   @tabtin/action-tools/types      — Type definitions
 *   @tabtin/action-tools/tools      — Tool instances and groups
 *   @tabtin/action-tools/runtime    — Runtime bridge injection (internal)
 *   @tabtin/action-tools/impl       — Implementation classes (internal)
 *   @tabtin/action-tools/adapters   — Adapter classes (internal)
 *   @tabtin/action-tools/cdp        — CDP connection management (internal)
 *   @tabtin/action-tools/manifest   — Tool manifest queries
 *   @tabtin/action-tools/errors     — Error codes and factories
 */

// ===== Types =====
export type {
  ToolResult,
  AgentTool,
  ToolExecutorConfig,
} from './types';
export type {
  ToolExecutionTarget,
  ToolParameters,
  ToolManifest,
} from './types/manifest';

// ===== Errors =====
export {
  ToolErrorCode,
  ToolErrorFactory,
  isRetriableError,
  isFatalError,
  type ToolError,
  type StandardToolOutput,
} from './types/errors';
export { mapToToolErrorCode } from './utils/error';

// ===== Manifest =====
export {
  toolManifests,
  getToolManifests,
  getToolCapabilityMap,
} from './manifest';
