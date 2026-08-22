export type {
  ExtractionSchema,
  SchemaPaginationStrategy
} from './extraction-schema';
export type {
  StandardSchema,
  FieldConfig,
  PaginationConfig,
  FieldType,
  RawSchema
} from './standard-schema';
export type {
  RecommendationCaseType,
  RecommendationRequest,
  RecommendationResponse,
  RecommendationItem,
  RecommendationStats,
  RecommendationGeneratorResult,
  RecommendationPageInfo,
  RecommendationPageMeta,
  RecommendationHistorySchema,
  RecommendationHistorySource,
  RecommendationHistoryVisibility,
  HistoryRecommendationRequest,
  HistoryRecommendationResponse,
  RecommendationServiceStatus
} from './recommendation';

export type {
  SchemaGenerationStats,
  SchemaGenerationResult,
  SchemaGeneratorConfig
} from './recommendation';

export type {
  AntiDetectConfig,
  AntiDetectInfo,
  SessionProfile,
  AppliedAntiDetect
} from './anti-detect';

export type { ProxyConfig as IntegrationProxyConfig } from './network';

export type {
  AccessResult,
  Payload,
  MainPayload,
  SamplePayload,
  Metadata,
  AccessError,
  NetworkRequest,
  PerformanceTiming,
  Screenshot,
  Resource
} from './access-result';

export * from './pagination';
export * from './preprocess';
export type {
  TaskStatus,
  ExecutionStep,
  TaskPriority,
  EngineType,
  Cookie,
  TaskProxyConfig,
  SessionMode,
  TaskConfig,
  StatusTransition,
  TaskProgress,
  TaskResult,
  TaskError,
  TaskPauseInfo,
  RecommendationSelectionContext,
  TaskRecommendationMetadata,
  TaskPaginationUserConfig,
  PaginationLogEntry,
  TaskPaginationExecutionMetadata,
  TaskPaginationMetadata,
  TaskPreprocessMetadata,
  StrategyMetadata,
  TaskMetadata,
  Task,
  TaskFilter,
  TaskStatistics
} from './task';
