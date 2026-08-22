/**
 * Crawl 模块类型定义统一导出
 */

// AccessResult 相关类型
export type {
  AccessResult,
  EngineInfo,
  MainPayload,
  SamplePayload,
  Cookie,
  NetworkRequest,
  Resource,
  PerformanceTiming,
  Screenshot,
  AccessError
} from './access-result.js';

export {
  DEFAULT_LIMITS,
  ERROR_CATEGORIES
} from './access-result.js';

// 选项相关类型
export type {
  ScrapeOptions,
  CommonScrapeOptions,
  HttpScrapeOptions,
  ProxyConfig,
  RenderHints,
  BrowserConfig,
  CacheConfig,
  SecurityConfig,
  LimitsConfig,
  Action,
  EngineType,
  TaskPriority,
  TaskStatus,
  NetworkCaptureLevel,
  WaitStrategy,
  EngineSelectionStrategy
} from './options.js';

// 错误相关类型
export {
  ErrorCode,
  ErrorCategory,
  HumanCheckType,
  ERROR_CODE_TO_CATEGORY,
  ERROR_CODE_TO_HUMAN_CHECK,
  createCrawlError
} from './errors.js';

export type {
  ErrorDetails,
  CrawlError
} from './errors.js';

// 策略相关类型
export {
  WebsiteType,
  CDNProvider,
  AntiBotLevel
} from './strategy.js';

export type {
  WebsiteFeatures,
  EngineSuccessRate,
  WebsiteProfile,
  StrategyConditions,
  ScrapeStrategy,
  StrategyMatch,
  StrategySelectionOptions,
  StrategyEvaluation,
  StrategyManagerConfig,
  StrategyUpdateEvent,
  StrategyTemplate,
  StrategyMetrics,
  StrategyMode
} from './strategy.js';

// 引擎相关类型
export {
  EngineStatus
} from './engine.js';

export type {
  EngineCapabilities,
  EngineHealth,
  EngineInitOptions,
  ScrapeContext,
  ScrapeProgressEvent,
  EngineEventListener,
  ScrapeEngine,
  IEngineFactory,
  EngineBenchmark,
  EngineComparison
} from './engine.js';
