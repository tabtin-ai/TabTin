export { okResponse } from '@tabtin/agent-wire'
export { SlidingWindowRateLimiter } from './rate-limiter.js'
export { parseBody, sendJSON, MAX_BODY_SIZE, BODY_READ_TIMEOUT_MS } from './http-utils.js'
export { validateCSRFHeaders, validateTokenAuth } from './guards.js'
export {
  type ErrorCode,
  type CliServerOnlyCode,
  type SendJSON,
  type DjangoProxyResult,
  type DjangoRequestOptions,
  type DjangoRequestFn,
  errorResponse,
  isRetryable,
  sendDjangoResult,
  COMMON_SUGGESTIONS,
} from './errors.js'
export {
  type DjangoBinaryEnvelope,
  type DjangoPassthroughEnvelope,
  type DjangoRawTextEnvelope,
  type DjangoProxyBody,
  decodeDjangoProxyBody,
} from './django-proxy-body.js'
export {
  type CLIServerInfo,
  type CLIServerOptions,
  type RouteHandler,
  createCLIHttpServer,
  resolveSocketPath,
  discoveryFilePath,
  writeDiscoveryFile,
  writeDiscoveryFileDetailed,
  cleanupSocketFile,
  cleanupDiscoveryFile,
} from './server.js'
export type { DiscoveryWriteResult } from './server.js'

// ─── PlatformSurface 框架（Wave 3）───────────────────────────────────
export { definePlatformSurface } from './surface/define-platform-surface.js'
export { createSurfaceHttpHandler } from './surface/create-surface-http-handler.js'
export { configureSurfaceRuntime, getSurfaceContext } from './surface/configure-surface-runtime.js'
export { getAllSurfaces, getSurface, getSurfaceByHttpPath } from './surface/registry.js'
export { createSurfacesEndpoint, type SurfaceDescriptor } from './surface/create-surfaces-endpoint.js'
export {
  SurfaceError,
  type SurfaceContext,
  type SurfaceKind,
  type SurfaceBindings,
  type PlatformSurfaceDef,
  type RegisteredSurface,
} from './surface/types.js'

// ─── Surface 审计（Wave 5）──────────────────────────────────────────
export {
  writeSurfaceAuditLog,
  _computeInputHash,
  _createAuditDir,
  type SurfaceAuditEntry,
} from './surface/surface-audit.js'

// ─── Marketplace App 命令扫描（Wave 7）──────────────────────────────
export {
  scanMarketplaceManifests,
  type MarketplaceCliCommand,
} from './marketplace-scanner.js'

// ─── 外部 Agent 导入 surface（Layer B 宿主编排）─────────────────────
export {
  createImportSurfaces,
  IMPORT_SOURCE_IDS,
  IMPORT_PROGRESS_CHANNEL,
  type AgentImportRunner,
  type ImportSourceId,
  type ImportContentLayer,
  type ImportDetectResult,
  type ImportSessionRef,
  type ImportScanWorkspace,
  type ImportScanResult,
  type ImportDetectOutput,
  type ImportScanInput,
  type ImportRunInput,
  type ImportRunOutput,
  type ImportJobState,
  type ImportRunReport,
  type ImportStatusInput,
  type ImportStatusOutput,
  type ImportCancelInput,
  type ImportCancelOutput,
  type ImportRollbackInput,
  type ImportRollbackOutput,
  type ImportProgressEvent,
} from './surfaces/import.js'
