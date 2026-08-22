/**
 * @tabtin/cli-routes — Electron / Daemon cli-server 共享路由实现。
 *
 * 用法：宿主在启动 cli-server 前调一次 `configureCLIRoutes({...})` 注入
 * djangoRequest / getSpaceId / actionExecutor 等宿主特有能力，然后引用
 * 各路由 handler 即可。
 */

export {
  configureCLIRoutes,
  type CLIRoutesHostBindings,
  type DjangoRequestFn,
  type DjangoRequestOptions,
  type ActionExecutorFn,
  type ActionExecutionResult,
  type CodeWorktreeAgentContext,
  type CodeWorktreeController,
  type CodeWorktreeControllerResult,
} from './host-bindings.js';

export { handleFetchRoute } from './routes/fetch.js';
export { handleCapabilitiesRoute } from './routes/capabilities.js';
export { handleExtensionsRoute } from './routes/extensions.js';
export { handleSpaceRoute } from './routes/space.js';
export { handleWorkspaceRoute } from './routes/workspace.js';
export { handleCodeRoute } from './routes/code.js';
export { handleDriveRoute } from './routes/drive.js';
export { handleOSSRoute } from './routes/oss.js';
export { handleSearchRoute } from './routes/search.js';
export { handleTableRoute } from './routes/table/index.js';
export {
  buildBulkImportResultPayload,
  type BulkImportResultPayload,
  type BulkImportOperationStatus,
} from './routes/table/bulk-import-result.js';
