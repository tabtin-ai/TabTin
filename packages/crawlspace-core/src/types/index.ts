/**
 * Crawlspace Core - Type Definitions
 */

export * from './core'

// ==================== Host Contract ====================
export type { CrawlspaceHost, OrphanReconcileResult } from './host'

// ==================== 任务相关类型 ====================
export type {
  TaskStage,
  TaskStatus,
  TaskPauseInfo,
  TaskState,
  FullTaskConfig
} from './task'

// ==================== 推荐相关类型 ====================
export type {
  RecommendationCaseType,
  TargetRegion,
  RecommendationOption,
  RecommendationStats,
  RecommendationMetadata,
  RecommendationSelectionContext
} from './recommendation'

// ==================== 翻页相关类型 ====================
export type {
  PaginationIntervalConfig,
  PaginationExecutionState,
  PaginationExecutionLog
} from './pagination'

// ==================== 插件相关类型 ====================
export type {
  CrawlspacePluginConfig,
  CrawlspaceContext,
  CrawlspacePluginLifecycle,
  CrawlspacePluginUI,
  CrawlspacePluginExecution,
  CrawlspacePlugin,
  ICrawlspaceRegistry,
  SchemaProviderContext,
  SchemaProviderResult,
  SchemaProvider,
  ViewProfile,
  PauseEvent,
  ViewDisplayMode
} from './plugin'
