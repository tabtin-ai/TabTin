import type {
  RecommendationCaseType,
  RecommendationItem,
  RecommendationPageInfo,
  RecommendationStats
} from './recommendation';
import type { AccessResult, Cookie } from './access-result';
import type { AntiDetectConfig } from './anti-detect';
import type { PreprocessingStats, ContentIdentificationResult, StaticScrollDetectionResult } from './preprocess';
import type {
  PaginationIntervalConfig,
  PaginationMethod,
  PaginationTelemetry,
  PaginationType,
  PageNumberInfo,
  ScrollDetectionResult,
  PaginationDetectionResult
} from './pagination';

/**
 * 任务状态枚举
 */
export enum TaskStatus {
  PENDING = 'pending',
  QUEUED = 'queued',
  RUNNING = 'running',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled'
}

/**
 * 执行步骤枚举（仅在 RUNNING 状态时有效）
 */
export enum ExecutionStep {
  CRAWL_STARTING = 'crawl:starting',
  CRAWL_FETCHING = 'crawl:fetching',
  CRAWL_COMPLETED = 'crawl:completed',
  PREPROCESS_CLEANING = 'preprocess:cleaning',
  PREPROCESS_COMPLETED = 'preprocess:completed',
  AI_GENERATING = 'ai:generating',
  AI_COMPLETED = 'ai:completed',
  EXTRACT_EXTRACTING = 'extract:extracting',
  EXTRACT_COMPLETED = 'extract:completed',
  FINALIZE_PROCESSING = 'finalize:processing',
  FINALIZE_COMPLETED = 'finalize:completed'
}

export type TaskPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type EngineType = 'http' | 'webcontents';

// Cookie 统一使用 access-result.ts 中的定义
export type { Cookie };

/**
 * 任务专用代理配置（与 crawl-integration 的 ProxyConfig 不同）
 */
export interface TaskProxyConfig {
  server: string;
  username?: string;
  password?: string;
  bypass?: string[];
}

/**
 * Session 模式：控制 WebContentsView 的 Session 隔离策略
 * - inherit: 使用共享 session（默认行为，forEmbedded）
 * - isolated: 使用独立持久化 session（persist:task-{taskId}）
 * - temporary: 使用临时 session（任务结束后销毁）
 */
export type SessionMode = 'inherit' | 'isolated' | 'temporary';

export interface TaskConfig {
  runId?: string;
  viewId?: string;
  url: string | string[];
  engine?: EngineType | 'auto';
  enginePriority?: EngineType[];
  workflow?: string;
  crawl?: {
    timeout?: number;
    screenshot?: boolean;
    cookies?: Cookie[];
    proxy?: TaskProxyConfig;
    headers?: Record<string, string>;
    keepEngineAlive?: boolean;
    sessionMode?: SessionMode;
    http?: Record<string, any>;
    webcontents?: Record<string, any>;
  };
  extract?: {
    enabled: boolean;
    instruction: string;
    coreContentSelector?: string;
    presetSchema?: any;
    schema?: any;
    detectPagination?: boolean;
    currentUrl?: string;
    paginationInfo?: any;
  };
  store?: {
    enabled: boolean;
    type: 'file' | 'postgres';
    options?: any;
  };
  advanced?: {
    priority?: TaskPriority;
    retry?: number;
    retryDelay?: number;
    timeout?: number;
  };
  antiDetect?: AntiDetectConfig;
  metadata?: Partial<TaskMetadata>;
  callbacks?: {
    onProgress?: (progress: TaskProgress) => void;
    onComplete?: (result: TaskResult) => void;
    onError?: (error: TaskError) => void;
  };
}

export interface StatusTransition {
  from: TaskStatus;
  to: TaskStatus;
  timestamp: number;
  reason?: string;
}

export interface TaskProgress {
  taskId: string;
  progress: number;
  currentStep?: ExecutionStep;
  message?: string;
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  crawl?: {
    url: string;
    finalUrl: string;
    html: string;
    title: string;
    statusCode: number;
    screenshots?: any[];
    cookies?: any[];
  };
  accessResult?: AccessResult;
  extract?: {
    data: any[];
    schema?: any;
    confidence?: number;
  };
  store?: {
    location: string;
    size: number;
  };
  performance: {
    totalDuration: number;
    stepDurations: Record<string, number>;
  };
  raw?: {
    accessResult?: AccessResult;
    extractionResult?: any;
    extractError?: {
      message: string;
      stack?: string;
    };
  };
}

export interface TaskError {
  taskId: string;
  code: string;
  message: string;
  step?: string;
  stack?: string;
  recoverable: boolean;
  timestamp: number;
}

export interface TaskPauseInfo {
  reason: string;
  message?: string;
  snapshot?: any;
  allowRetry: boolean;
  pausedAt: number;
  context?: any;
  paginationInfo?: any;
  paginationStrategy?: any;
  recommendations?: RecommendationItem[];
  recommendationStats?: RecommendationStats;
  caseType?: RecommendationCaseType;
  blockedReason?: string;
  diagnosisHint?: string;
  selection?: {
    selectedId?: string;
    message?: string;
  };
}

export interface RecommendationSelectionContext {
  type?: 'history' | 'recommendation';
  source?: string;
  schema?: any;
  skeletonHtml?: string;
  cleanedHtml?: string;
  preprocessingStats?: PreprocessingStats;
  schemaGeneratedAt?: number;
  schemaStats?: any;
  appliedAt?: number;
  selectedId?: string;
  scrollProbe?: ScrollDetectionResult;
  paginationStrategy?: any;
}

export interface TaskRecommendationMetadata {
  generatedAt?: number;
  recommendations?: RecommendationItem[];
  stats?: RecommendationStats;
  caseType?: RecommendationCaseType;
  pageInfo?: RecommendationPageInfo;
  blockedReason?: string;
  diagnosisHint?: string;
  selectedId?: string;
  selectedInstruction?: string;
  selectionMessage?: string;
  selectionContext?: RecommendationSelectionContext;
  selectionType?: 'history' | 'recommendation';
  selectionSource?: string;
  metadata?: Record<string, any>;
}

// 分页相关类型统一使用 pagination.ts 中的定义
export type { PaginationIntervalConfig, PaginationMethod, PaginationTelemetry, PaginationType, PageNumberInfo, ScrollDetectionResult, PaginationDetectionResult };

export interface TaskPaginationUserConfig {
  pages?: number;
  method?: PaginationMethod;
  startedAt?: number;
  interval?: PaginationIntervalConfig;
}


export interface PaginationLogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  params?: unknown[];
}

export interface TaskPaginationExecutionMetadata {
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt?: number;
  lastUpdatedAt?: number;
  requestedPages?: number;
  successPages?: number;
  errorMessage?: string;
  metrics?: PaginationTelemetry;
  logs?: PaginationLogEntry[];
}

export interface TaskPaginationMetadata {
  detectionResult?: PaginationDetectionResult;
  userConfig?: TaskPaginationUserConfig;
  execution?: TaskPaginationExecutionMetadata;
}

export interface TaskPreprocessMetadata {
  generatedAt?: number;
  stats?: PreprocessingStats;
  content?: ContentIdentificationResult;
  scroll?: StaticScrollDetectionResult;
}

export interface StrategyMetadata {
  status?: string;
  commands?: unknown[];
  logs?: unknown[];
  error?: string;
  actionGraphId?: string;
  reusedActionGraphId?: string;
  observation?: unknown;
  humanRequest?: unknown;
  detection?: unknown;
  pauseInfo?: unknown;
  timestamp?: number;
  instruction?: string;
  userInstruction?: string;
  instructionSource?: string;
  plannerPrompt?: string;
}

export interface TaskMetadata {
  engine?: string;
  duration?: number;
  pauseInfo?: TaskPauseInfo;
  recommendation?: TaskRecommendationMetadata;
  pagination?: TaskPaginationMetadata;
  engineContext?: {
    windowId?: string | number;
    windowKind?: 'webcontents-view' | 'browser-window';
    connectionId?: string;
    url?: string;
    [key: string]: any;
  };
  preprocess?: TaskPreprocessMetadata;
  strategy?: StrategyMetadata;
  userInstruction?: string;
  effectiveInstruction?: string;
  instructionSource?: string;
  plannerPrompt?: string;
  [key: string]: any;
}


export interface Task {
  id: string;
  runId?: string;
  viewId?: string;
  status: TaskStatus;
  statusHistory: StatusTransition[];
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  config: TaskConfig;
  currentStep?: ExecutionStep;
  progress: number;
  retryCount: number;
  maxRetries: number;
  result?: TaskResult;
  error?: TaskError;
  metadata: TaskMetadata;
}

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  priority?: TaskPriority;
  createdAfter?: number;
  createdBefore?: number;
  engine?: string;
}

export interface TaskStatistics {
  total: number;
  byStatus: Record<TaskStatus, number>;
  byPriority: Record<TaskPriority, number>;
  avgDuration: number;
  successRate: number;
}
