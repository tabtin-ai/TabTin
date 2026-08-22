export interface PaginationIntervalConfig {
  type: 'fixed' | 'random';
  fixedMillis?: number;
  minMillis?: number;
  maxMillis?: number;
}

export interface PaginationTelemetry {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  requestedPages: number;
  attemptedPages: number;
  successPages: number;
  duplicatePages: number;
  noNewDataStops: number;
  strategy: 'PURE_SCROLL' | 'PURE_PAGE' | 'HYBRID' | 'LEARNING';
  lastError?: string;
}

export type PaginationType = 'pagination' | 'load_more' | 'infinite_scroll';

export interface PageNumberInfo {
  current: number;
  total?: number;
  has_previous?: boolean;
  has_next?: boolean;
  url_pattern?: string;
}

export interface ScrollDetectionResult {
  tested: boolean;
  hasMoreContent: boolean;
  attempts: number;
  selector?: string;
  initialItemCount: number;
  finalItemCount: number;
  newItemCount: number;
  initialScrollHeight?: number;
  finalScrollHeight?: number;
  scrollHeight?: number;
}

export interface PaginationDetectionResult {
  detected: boolean;
  aiDetection: {
    detected: boolean;
    type?: PaginationType;
    selector?: string;
    confidence?: number;
    contentSelector?: string;
    listSelector?: string;
    elements?: Array<{
      type: string;
      method: string;
      selector: string;
      description?: string;
      confidence?: number;
      attributes?: {
        text?: string;
        href?: string;
        enabled?: boolean;
      };
    }>;
    pageNumbers?: PageNumberInfo;
  };
  scrollDetection?: ScrollDetectionResult;
  recommendation: {
    method: 'click' | 'scroll' | 'url_pattern' | 'both' | 'none';
    estimatedPages?: number;
    confidence: number;
  };
}

export type DynamicScrollDetectionResult = ScrollDetectionResult;

export type PaginationMethod = 'click' | 'scroll' | 'url_pattern' | 'both';

export interface PaginationEngineContext {
  windowId?: string | number;
  windowKind?: string;
  connectionId?: string;
  url?: string;
  [key: string]: unknown;
}

export interface PaginationExecutionContext {
  taskId: string;
  engineContext?: PaginationEngineContext;
  paginationInfo?: PaginationDetectionResult;
  firstPageSchema?: any;
  metadata?: Record<string, unknown>;
}

export interface PaginationExecutionResources<
  TPage = unknown,
  TSurface = unknown,
  TExtra = Record<string, unknown>
> {
  page?: TPage;
  surface?: TSurface;
  extra?: TExtra;
}

export interface ContentStateSnapshot {
  count: number;
  fingerprints: string[];
  metadata?: Record<string, unknown>;
}

export interface ContentChangeResult {
  totalCount: number;
  newCount: number;
  state: ContentStateSnapshot;
  newHtml?: string;
  error?: string;
}

export interface SerializedExtractedData {
  html?: string;
  data?: PaginationDataset;
  metadata?: Record<string, unknown>;
}

export type PaginationDataset = unknown[];

export interface PaginationExecutorConfig {
  waitInterval?: number;
  maxWaitTime?: number;
  scrollHeightThreshold?: number;
  domStableCount?: number;
}

export interface DynamicScrollDetectionOptions {
  selector?: string;
  candidates?: string[];
  attempts?: number;
  attemptInterval?: number;
  heightThreshold?: number;
  waitForPageLoad?: number;
}

export type PaginationStrategy = 'PURE_SCROLL' | 'PURE_PAGE' | 'HYBRID' | 'LEARNING';

export interface PaginationLearningState {
  urlChanges: boolean[];
  dataGrowths: number[];
  previousUrls: string[];
  hasOverlap: boolean;
  strategy: PaginationStrategy;
}

export interface PaginationStrategySummary {
  strategy: PaginationStrategy;
  urlAlwaysChanges: boolean;
  urlNeverChanges: boolean;
  urlSometimesChanges: boolean;
  hasOverlap: boolean;
  avgGrowth: number;
  variance: number;
}

export interface PaginationLogger {
  info?(message?: unknown, ...optionalParams: unknown[]): void;
  warn?(message?: unknown, ...optionalParams: unknown[]): void;
  error?(message?: unknown, ...optionalParams: unknown[]): void;
}

export type PaginationLogLevel = 'info' | 'warn' | 'error';

export interface PaginationLogEvent {
  type: 'log';
  level: PaginationLogLevel;
  message: string;
  params?: unknown[];
}

export interface PaginationTelemetryEvent {
  type: 'telemetry';
  telemetry: PaginationTelemetry;
}

export type PaginationOrchestratorEvent = PaginationLogEvent | PaginationTelemetryEvent;

export interface PaginationOptions {
  taskId: string;
  method: PaginationMethod;
  pages: number;
  requestedPages?: number;
  engineContext: PaginationEngineContext;
  paginationInfo?: PaginationDetectionResult;
  firstPageData: PaginationDataset;
  firstPageSchema?: any;
  interval?: PaginationIntervalConfig;
}

export interface PaginationResult {
  success: boolean;
  totalPages: number;
  successPages: number;
  allData: PaginationDataset;
  error?: Error;
  metrics: PaginationTelemetry;
}

export interface CorePaginationOptions {
  method: PaginationMethod;
  requestedPages: number;
  firstPageData: PaginationDataset;
  context: PaginationExecutionContext;
}

export type CorePaginationResult = PaginationResult;
