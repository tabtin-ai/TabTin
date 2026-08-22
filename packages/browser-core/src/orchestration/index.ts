/**
 * Orchestration 子模块门面（BR-8 WS-A）。
 *
 * 自成一体（入口 + 类型都在 `BrowserOrchestrator.ts`），从这里干净 re-export，
 * 与 `capability-matrix` 同样留了将来 `git mv` 拆独立包的缝。
 */
export {
  handleBrowserAction,
  BrowserActionError,
} from './BrowserOrchestrator'
export type {
  BrowserActiveTab,
  BrowserContextInfo,
  BrowserContextResponse,
  BrowserOrchestratorHostHooks,
  BrowserActionResult,
  BrowserActionErrorInfo,
  BrowserExecHooks,
  BrowserExecOutcome,
  BrowserObserveParams,
  BrowserSnapshotRequestParams,
  BrowserResourceStreamHooks,
  BrowserSessionData,
  BrowserSessionHooks,
  BrowserJobHooks,
} from './BrowserOrchestrator'
export { wrapEvalCode, isParsableExpression } from './wrapEvalCode'
export {
  resolveObserveStatus,
  mergeActEmbedObserve,
  ACT_OBSERVE_OK_HINT,
  ACT_OBSERVE_RETRY_HINT,
} from './observe-status'
export type { ObserveStatus } from './observe-status'

// BR-9 P0：browser action 安全策略纯判定（electron-free）。P1 接 Orchestrator 闸门。
export {
  evaluateBrowserActionPolicy,
  evaluateBrowserRoutePolicy,
  collectBrowserActionIdsForPolicy,
  getBrowserCommandRisk,
  resolveBrowserActionIdForPolicy,
} from './browser-policy'
export type {
  BrowserPolicyDecision,
  BrowserPolicyHostHooks,
} from './browser-policy'

// BW-5：信任边界 / 域名白名单纯判定。Host 按需接入导航、子资源、WebSocket 拦截点。
export {
  evaluateBrowserDomainAllowlist,
  evaluateBrowserResolvedResourceUrlAllowlist,
  markBrowserContentUntrusted,
} from './browser-trust-boundary'
export type {
  BrowserDomainAllowlistDecision,
  BrowserDomainAllowlistInput,
  BrowserResolvedResourceUrlAllowlistInput,
  BrowserTrustBoundary,
  BrowserTrustRequestKind,
  BrowserUntrustedContentSource,
} from './browser-trust-boundary'
