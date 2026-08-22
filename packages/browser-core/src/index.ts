// ========== 类型 & 错误 ==========
export {
  ToolErrorCode,
  ToolErrorFactory,
  isRetriableError,
  isFatalError,
} from './types/errors';
export type { ToolError, StandardToolOutput } from './types/errors';

export type {
  BlockSignal,
  BlockType,
  EnhancedBlockSignal,
  ActActionType,
  ActAction,
  ExecuteActInput,
  ExecuteActOutput,
  ExecuteObserveInput,
  ExecuteObserveOutput,
  RequestSnapshotInput,
  RequestSnapshotOutput,
} from './types/browser';

export { mapToToolErrorCode } from './utils/error-mapping';

// ========== i18n ==========
export { t, setBrowserCoreLocale, setBrowserCoreTranslator } from './i18n';

// ========== Adapters ==========
export { WebContentsPageAdapter } from './adapters/WebContentsPageAdapter';
export type { Page } from './adapters/WebContentsPageAdapter';

// ========== L2 BrowserContext 抽象 ==========
export type { BrowserContext, ScreenshotOptions } from './context/BrowserContext';
export { LegacyWebContentsBrowserContext } from './context/LegacyWebContentsBrowserContext';

// ========== Bridge 注入 ==========
export { setBrowserCoreBridge, resolveCDPScreenshotAPI, resolveViewFactoryAPI, resolveHtmlCleanerAPI } from './bridge';
export type { BrowserCoreBridge, CDPScreenshotAPI, ViewFactoryAPI, HtmlCleanerAPI } from './bridge';

// ========== BrowserToolImpl 编排器 ==========
export { BrowserToolImpl, getSharedBrowserToolImpl, resetSharedBrowserToolImpl } from './BrowserToolImpl';
export type { CaptchaUserInterventionCallback } from './BrowserToolImpl';

// ========== CDP 连接管理 ==========
export {
  CDPConnectionManager,
  CDPConnectionProfile,
  getCDPConnectionManager,
  destroyCDPConnectionManager,
} from './cdp/CDPConnectionManager';
export type {
  CDPConnectionStrategy,
  CDPConnectionConfig,
  TaskLifecycleEvent,
} from './cdp/CDPConnectionManager';

// ========== 页面脚本（shadow DOM 穿透，）==========
export {
  DEEP_SELECTOR_SEPARATOR,
  isDeepSelector,
  SHADOW_DOM_HELPERS_SNIPPET,
  DEEP_SERIALIZE_HTML_SNIPPET,
  buildDeepOuterHTMLExpression,
} from './page-scripts/shadow-dom';

// ========== 操作层 ==========
export { CDPOperationHelper, getSharedCDPOperationHelper, isCDPAction, isCoordinateClick } from './operations/CDPOperationHelper';
export type { CDPActionType, CDPActionOptions, CDPOperationResult } from './operations/CDPOperationHelper';
export { DOMOperationHelper, DOM_ACTION_TYPES } from './operations/DOMOperationHelper';
export type { DOMOperationOptions, DOMOperationResult } from './operations/DOMOperationHelper';
export { runSingleAction, runActionSequence, buildFailureEntry } from './operations/ActionRunner';
export { animateCursorTo, pulseCursor, glideCursorTo, hideCursor, buildHideCursorScript } from './operations/AgentCursor';
export type {
  ActionEntry,
  ActionSequenceOptions,
  ActionSequenceResult,
  ActSelectorSource,
} from './operations/ActionRunner';
export { splitKeyCombo, normalizeModifier, buildKeyDescriptor } from './operations/keyboard-utils';
export type { KeyDescriptor } from './operations/keyboard-utils';

// ========== 快照 ==========
export { SnapshotService, getSharedSnapshotService } from './snapshot/SnapshotService';
export type { SnapshotData } from './snapshot/SnapshotService';
export { SoMService, getSharedSoMService } from './snapshot/SoMService';
export type { SoMElement, SoMResult } from './snapshot/SoMService';
export { AccessibilityTreeBuilder, getSharedAccessibilityTreeBuilder } from './snapshot/AccessibilityTreeBuilder';
export { serializeToDomIndex } from './snapshot/DomIndexSerializer';
export type { DomIndexResult } from './snapshot/DomIndexSerializer';
// Compact snapshot（BR-16：electron-free 纯字符串逻辑，原 Electron/Daemon 两份副本收编于此）。
export { buildCompactSnapshot, formatCompactSnapshot, buildRefMap, buildRefEntries, buildBackendRefEntries } from './snapshot/compact-snapshot';
export type { CompactElement, CompactSnapshot } from './snapshot/compact-snapshot';

// ========== Guards ==========
export {
  CaptchaGuard,
  getSharedCaptchaGuard,
  captchaNeedsUserIntervention,
  CAPTCHA_DETECT_FAST_TIMEOUT_MS,
} from './guards/CaptchaGuard';
export { BlockDetector, getSharedBlockDetector } from './guards/BlockDetector';
export { ActionLoopDetector } from './guards/ActionLoopDetector';
export type { LoopDetectionResult } from './guards/ActionLoopDetector';

// ========== Captcha ==========
export {
  buildDetectionScript,
  analyzeDetectionResult,
  analyzeCaptchaFromPageMeta,
  projectCaptchaRequired,
  CAPTCHA_REQUIRED_HINT,
} from './captcha/CaptchaDetector';
export type {
  CaptchaInfo,
  CaptchaType,
  CaptchaSuggestedAction,
  CaptchaDetectionRaw,
  CaptchaRequiredWire,
} from './captcha/CaptchaDetector';
export { NoOpCaptchaSolver } from './captcha/CaptchaSolver';
export type { CaptchaSolver, CaptchaSolveParams, CaptchaSolveResult } from './captcha/CaptchaSolver';

// ========== Tab ==========
export { TabResolver, getSharedTabResolver } from './tab/TabResolver';

// ========== Access Strategy ==========
export { AccessLevel, buildAntiDetectConfig, DEFAULT_ACCESS_LEVEL } from './access/AccessLevel';
export { SiteAccessMemory } from './access/SiteAccessMemory';
export {
  AccessStrategyService,
  getSharedAccessStrategyService,
  setSharedAccessStrategyService,
} from './access/AccessStrategyService';
export type { StrategyDecision, StrategyResult } from './access/AccessStrategyService';

// ========== Utils ==========
export {
  buildToolError,
  safeSerialize,
  buildStopOnErrorResult,
  buildTabMissingResult,
  buildTopLevelErrorResult,
} from './utils/response-builder';

// ========== Capability Matrix（双端 action 支持矩阵，零依赖纯数据）==========
// 留了将来 `git mv` 拆独立 `@tabtin/browser-contract` 的缝：矩阵自成一文件，
// 这里只做干净 re-export，调用方只依赖 `@tabtin/browser-core` 这层稳定门面。
export {
  BROWSER_CAPABILITY_MATRIX,
  CAPABILITY_MATRIX_VERSION,
  projectCapabilitiesForRuntime,
  getBrowserActionIds,
  getBrowserCapability,
} from './capability-matrix';
export type {
  BrowserRuntime,
  SupportLevel,
  ActionSupport,
  BrowserActionCapability,
  CapabilityProjectionEntry,
  CapabilityProjection,
} from './capability-matrix';

// ========== Resources（BR-4：smart-download 选目标纯逻辑，electron-free）==========
// 双端共用同一份「优先级挑选 + 下载策略判定」，各端只映射候选 + 按 strategy 走自己的下载实现。
export {
  selectSmartDownloadTarget,
  classifyMediaResource,
} from './resources/smart-download-selector'
export type {
  MediaCategory,
  SmartDownloadCandidate,
  SmartDownloadStrategy,
  SmartDownloadSelection,
  SelectSmartDownloadOptions,
} from './resources/smart-download-selector'

// BR-30：媒体下载护栏纯判定（临时签名 URL / 跨站 / 大文件 / 需会话 → 是否需确认 / 建议异步）。
// 接 BR-9 安全闸门做「风险信号 → confirm 升级」；未命中信号的普通下载仍 read→allow，零行为变更。
export {
  evaluateMediaDownloadGuardrail,
  isEphemeralSignedUrl,
  DEFAULT_DOWNLOAD_SIZE_THRESHOLD_BYTES,
} from './resources/media-download-guardrail'
export type {
  MediaDownloadSignal,
  MediaDownloadRequest,
  MediaDownloadGuardrailOptions,
  MediaDownloadGuardrailResult,
} from './resources/media-download-guardrail'

// ========== Orchestration（BR-8 WS-A：契约驱动的 action 编排，electron-free）==========
// 两端 route 都调 handleBrowserAction、各传自己的 hostHooks——响应形状定义一次、永不漂移。
// P3c：act/observe 也收编进来（exec hooks 注入最后一公里执行引擎）。
// 同样留了将来 `git mv` 拆独立包的缝：自成一目录，这里只做干净 re-export。
export { handleBrowserAction, BrowserActionError } from './orchestration';
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
} from './orchestration';
export {
  wrapEvalCode,
  isParsableExpression,
  resolveObserveStatus,
  mergeActEmbedObserve,
  ACT_OBSERVE_OK_HINT,
  ACT_OBSERVE_RETRY_HINT,
} from './orchestration';
export type { ObserveStatus } from './orchestration';

// BR-9 P0：browser action 安全策略纯判定（electron-free）。P1 接 Orchestrator 闸门。
export {
  evaluateBrowserActionPolicy,
  evaluateBrowserRoutePolicy,
  collectBrowserActionIdsForPolicy,
  getBrowserCommandRisk,
  resolveBrowserActionIdForPolicy,
} from './orchestration/browser-policy';
export type {
  BrowserPolicyDecision,
  BrowserPolicyHostHooks,
} from './orchestration/browser-policy';

// BW-5：信任边界 / 域名白名单纯判定。Host 用它接入导航、子资源、WebSocket 拦截点。
export {
  evaluateBrowserDomainAllowlist,
  evaluateBrowserResolvedResourceUrlAllowlist,
  markBrowserContentUntrusted,
} from './orchestration/browser-trust-boundary';
export type {
  BrowserDomainAllowlistDecision,
  BrowserDomainAllowlistInput,
  BrowserResolvedResourceUrlAllowlistInput,
  BrowserTrustBoundary,
  BrowserTrustRequestKind,
  BrowserUntrustedContentSource,
} from './orchestration/browser-trust-boundary';

// BW-3：browser network → OpenAPI 3.1 离线分析器（纯函数，未来 trace.network 可复用）。
export {
  analyzeBrowserNetworkToOpenApi,
  normalizeBrowserNetworkEntries,
} from './browser-to-api';
export type {
  BrowserToApiOptions,
  BrowserToApiResult,
  JsonSchema,
  OpenApiOperation,
  OpenApiParameter,
} from './browser-to-api';

// ATE-3：browser network/list → TabData-ready dataset + conservative field inference.
export {
  collectBrowserTableDataset,
  inferBrowserToTableFields,
} from './browser-to-table';
export type {
  BrowserToTableCaptureScope,
  BrowserToTableDataset,
  BrowserToTableField,
  BrowserToTableFieldType,
  BrowserToTableInput,
} from './browser-to-table';

// ========== Runtime State（BR-8 WS-B：常驻状态收编进 runtime，electron-free）==========
// network/console 历史缓冲（P2）：两端 BrowserContext.onCDPEvent 都喂进共享单例 →
// network/console 返回历史日志而非窗口快照。
// RefCache（P3a）：compact snapshot 的 eN→selector 映射，两端 route 填同一份、act 查同一份。
// 同样自成一目录，这里只做干净 re-export。
export {
  NetworkLog,
  ConsoleLog,
  RefCache,
  RecordingRegistry,
  getSharedNetworkLog,
  getSharedConsoleLog,
  getSharedRefCache,
  resetSharedRefCache,
  getSharedRecordingRegistry,
  resetSharedRecordingRegistry,
  resetSharedRuntimeLogs,
  attachRuntimeLogCapture,
  BrowserJobManager,
  getSharedBrowserJobManager,
  resetSharedBrowserJobManager,
  shutdownSharedBrowserJobManager,
} from './runtime';
export type {
  NetworkLogEntry,
  NetworkLogQuery,
  NetworkResponseBodyPatch,
  ConsoleLogEntry,
  ConsoleLogQuery,
  RefEntry,
  ActiveRecordingEntry,
  RuntimeLogCaptureOptions,
  CDPLogEvent,
  RuntimeLogContext,
  BrowserJobProgress,
  BrowserJobStatus,
  BrowserJobRecord,
  BrowserJobHandle,
  BrowserJobManagerOptions,
} from './runtime';
