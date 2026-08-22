/**
 * @tabtin/crawl-integration
 * 浏览器控制与引擎集成层
 */

// ==================== Browser ====================
// Browser/V3Context/understudy 已架空（Phase 2 引入 BrowserContext 统一接口后不再使用）。
// Browser 类不再从入口导出。如需浏览器操作，请使用 @tabtin/browser-core 的 BrowserContext 接口。
// 源文件保留在 src/browser/ 下但不通过入口暴露，后续可安全删除整个目录。

// ==================== Engines ====================
export * from './engines/index.js';

// ==================== Types (Crawl Base Types) ====================
// Note: Avoid re-exporting to prevent conflicts with V3 types
export type {
  AccessResult,
  AccessError,
  Payload,
  Cookie,
  PerformanceTiming,
  NetworkRequest,
  Resource,
  Screenshot
} from './types/access-result.js';

export { EngineStatus } from './types/engine.js';

export type {
  ScrapeEngine,
  EngineCapabilities,
  EngineHealth,
  EngineInitOptions,
  ScrapeContext,
  ScrapeProgressEvent,
  EngineEventListener
} from './types/engine.js';

export type {
  CrawlError as CrawlErrorType,
  ErrorCategory
} from './types/errors.js';

export type {
  HttpScrapeOptions,
  WebContentsScrapeOptions,
  EngineType,
  CommonScrapeOptions,
  ProxyConfig
} from './types/options.js';

export type {
  ScrapeStrategy,
  StrategyMode,
  StrategyConditions
} from './types/strategy.js';

// ==================== Core ====================
export { PayloadUtils } from './core/PayloadUtils.js';
export { CacheKeyGenerator } from './core/CacheKeyGenerator.js';
export { PrivacyMasker } from './core/PrivacyMasker.js';
export { RobotsChecker } from './core/RobotsChecker.js';

// ==================== Errors ====================
export { CrawlError } from './errors/CrawlError.js';

// ==================== Logger ====================
export * from './logger.js';
export type { LogLine, LogLevel, Logger } from './types/logs.js';

// ==================== Utils ====================
// TabTin 工具集（URL、编码、重试、system-ua 等）
export * from './utils/index.js';

// ==================== Config ====================
export { ConfigProcessor } from './config/config-processor.js';
export { DEFAULT_CONFIG } from './config/default.js';
export type * from './config/extended-options.js';

// ==================== Validation ====================
export {
  validateTimingConsistency,
  validateTransferSizeConsistency,
  validateRobotsConsistency,
  validatePayloadStructure,
  validateHeaderConsistency,
  validateTlsConsistency,
  validateAccessResult
} from './utils/validation.js';

// ==================== i18n ====================
export { setCrawlIntegrationLocale, setCrawlIntegrationTranslator, t } from './i18n.js';
