/**
 * 抓取工作区类型定义
 */

import type {
  PaginationTelemetry,
  PaginationLogEntry,
  TaskPaginationExecutionMetadata
} from '@tabtin/crawl-contracts/task'
import type { SchemaGenerationStats } from '@tabtin/crawl-contracts/recommendation'
import type {
  PaginationDetectionResult as PaginationInfo,
  PaginationType,
  PageNumberInfo,
  ScrollDetectionResult
} from '@tabtin/crawl-contracts/pagination'
import type { ResourceRecord } from '@tabtin/action-tools/types'
import type { UserAgentConfig } from '@/types/userAgent'

/**
 * 任务阶段
 */
export type TaskStage = 'config' | 'executing' | 'mapping' | 'completed'

export type RecommendationCaseType =
  | 'direct_extract'
  | 'auth_required'
  | 'captcha'
  | 'action_required'
  | 'empty_content'
  | 'unsupported'

export type ExtractionSelectionType = 'history' | 'recommendation'
export type ExtractionSelectionSource =
  | 'history:user_created'
  | 'history:ai_recommended'
  | 'history:similar_pages'
  | 'recommendation'

export interface TargetRegion {
  container_selector: string
  item_selector: string
  description?: string
  skeleton_path?: string | null
}

export interface RecommendationOption {
  id: string
  title: string
  confidence: number
  target_region?: TargetRegion
  region_type?: 'list' | 'table' | 'detail' | 'form'
}

export interface PaginationIntervalConfig {
  type: 'fixed' | 'random'
  fixedMillis?: number
  minMillis?: number
  maxMillis?: number
}

export interface RecommendationStats {
  requestTime: number
  responseTime: number
  totalDuration: number
  fromCache: boolean
  statusCode: number
  retryCount?: number
}

export interface RecommendationSelectionContext {
  type?: ExtractionSelectionType
  source?: ExtractionSelectionSource | string
  schema?: any
  skeletonHtml?: string
  cleanedHtml?: string
  preprocessingStats?: Record<string, any>
  schemaStats?: SchemaGenerationStats | Record<string, any>
  schemaGeneratedAt?: number
  appliedAt?: number
  metadata?: Record<string, any>
  /** 🆕 滚动探测结果（v3.0 新增） */
  scrollProbe?: ScrollDetectionResult
  /** 🆕 后端返回的翻页策略（v3.0 新增） */
  paginationStrategy?: any  // 实际类型为 PaginationStrategy，避免循环导入
}

export interface ExtractionSelection {
  id: string
  type: ExtractionSelectionType
  source: ExtractionSelectionSource
  title: string
  confidence?: number
  schema?: any
  instruction?: string
  caseType?: RecommendationCaseType
  blockedReason?: string
  diagnosisHint?: string
  metadata?: Record<string, any>
}

/**
 * 简化的任务配置
 */
export interface SimpleTaskConfig {
  url: string
  instruction: string
  detectPagination: boolean
  presetSchema?: any  // ✨ 预设 Schema（从历史记录选择时使用，跳过 AI 生成）
  historySchemaId?: string  // ✨ 历史 Schema ID（如果是复用历史记录，避免重复保存）
  selection?: ExtractionSelection
  userAgent?: UserAgentConfig  // 🆕 User-Agent 配置
  pageTitle?: string  // 🆕 页面标题（从 ConfigPanelV2 传递，避免重复调用 getProcessedContent）
  fieldConfigs?: FieldConfig[]  // 🆕 字段配置（用于图片保存开关）
}

/**
 * 完整的任务配置（发送给后端）
 */
export interface FullTaskConfig {
  url: string
  engine: 'webcontents'
  workflow?: string
  viewId?: string  // ✅ 新增：视图 ID
  runId?: string   // ✅ 新增：运行 ID
  extract?: {
    enabled: boolean
    instruction: string
    coreContentSelector?: string
    detectPagination?: boolean
    currentUrl?: string
    presetSchema?: any
    paginationInfo?: any
    fieldConfigs?: FieldConfig[]
  }
  crawl?: {
    webcontents?: {
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'
      waitForDynamic?: boolean
      dynamicWaitTime?: number
      screenshot?: boolean
      useEmbeddedTab?: boolean    // 使用嵌入式标签
      showTab?: boolean            // 显示标签
      existingTabId?: string      // 复用已有的 embedded tab
      runId?: string              // ✅ 新增：运行 ID
      userAgent?: string          // 🆕 User-Agent 字符串
    }
  }
  advanced?: {
    priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
    timeout?: number
    retry?: number
  }
  metadata?: {
    recommendation?: RecommendationMetadata & {
      selectionType?: ExtractionSelectionType
      selectionSource?: ExtractionSelectionSource
    }
    [key: string]: any
  }
}

/**
 * 任务状态
 */
export interface TaskState {
  taskId: string | null
  status: 'pending' | 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  progress: number
  currentStep?: string
  extractedData: any[]
  schema: any
  accessResult?: any
  paginationInfo?: PaginationInfo
  paginationExecution?: PaginationExecutionState
  pauseInfo?: TaskPauseInfo  // 🆕 暂停信息
  recommendationMetadata?: RecommendationMetadata | null
  error?: string
  strategy?: StrategyState
  startedAt?: number | null
  completedAt?: number | null
  url?: string  // ✅ 数据源 URL
  historySchemaId?: string  // ✅ Schema History ID（用于定时刷新）
  fieldConfigs?: FieldConfig[]  // 🆕 字段配置（用户在 Schema 确认阶段的配置）
  networkResponses?: NetworkResponse[]  // 🆕 网络响应缓存（包含图片 base64）
  resourceRecords?: ResourceRecord[]  // 🆕 统一资源对象（支持 blob / 流媒体 / 页面内捕获）
}

/**
 * 网络响应（从 Main Process 传递）
 */
export interface NetworkResponse {
  resourceId?: string
  viewId?: string
  url: string
  status: number
  statusText: string
  headers?: Record<string, string>
  size?: number
  mimeType?: string
  category?: string
  captureStatus?: string
  contentKind?: 'data_url' | 'text' | 'file_path'
  timing?: any
  body?: string           // 响应体（base64 data URL 格式）
  bodyPreview?: string    // 响应体预览
}

export interface PaginationExecutionState {
  status: TaskPaginationExecutionMetadata['status']
  startedAt?: number
  lastUpdatedAt?: number
  requestedPages?: number
  successPages?: number
  errorMessage?: string
  metrics?: PaginationTelemetry
  logs?: PaginationLogEntry[]
}

export type PaginationExecutionLog = PaginationLogEntry

/**
 * 拖拽状态
 */
export interface DragState {
  isDragging: boolean
  startY: number
  startRatio: number
}

/**
 * 面板配置
 */
export interface PanelConfig {
  isCollapsed: boolean
  isMaximized: boolean
}

/**
 * 任务 API 接口
 */
export interface TaskAPI {
  create: (config: FullTaskConfig) => Promise<{ success: boolean; task?: any; error?: string }>
  enqueue: (taskId: string) => Promise<{ success: boolean; error?: string }>
  get: (taskId: string) => Promise<{ success: boolean; task?: any; error?: string }>
  cancel: (taskId: string) => Promise<{ success: boolean; error?: string }>
  resume?: (taskId: string) => Promise<{ success: boolean; task?: any; error?: string }>
  resumeWithPagination?: (params: {
    taskId: string
    pages: number
    method: 'click' | 'scroll' | 'both'
    interval?: PaginationIntervalConfig
  }) => Promise<{ success: boolean; task?: any; error?: string }>
  selectRecommendation?: (params: {
    taskId: string
    recommendationId: string
    instruction: string
    selectionType?: ExtractionSelectionType
    selectionSource?: ExtractionSelectionSource | string
    schema?: any
    metadata?: Record<string, any>
    skeletonHtml?: string
  }) => Promise<{ success: boolean; task?: any; error?: string }>
  on: (event: string, callback: (data: any) => void) => void
  off: (event: string, callback: (data: any) => void) => void
}

/**
 * 字段映射
 */
export interface FieldMapping {
  source: string    // 提取的字段名
  target: string    // 目标字段名
  type?: string     // 数据类型
  required?: boolean
}

/**
 * 🆕 字段配置（用于 Schema 确认阶段的字段编辑）
 */
export interface FieldConfig {
  sourceField: string      // 原始字段名（英文）
  displayName: string      // 显示名称（中文/可编辑）
  fieldType: string        // 字段类型 (text, number, date, datetime, url, email, attachment)
  enabled: boolean         // 是否启用该字段
  selector?: string        // CSS 选择器
  attribute?: string       // 属性名称
  description?: string     // 字段描述
  sampleValue?: string     // 示例数据

  // ⭐ v2.0 新增：多值字段标识
  isMultiple?: boolean     // 是否为多值字段（multiple: true）

  // 🆕 图片/文件相关配置
  isMediaField?: boolean           // 是否为媒体字段（图片/文件）
  mediaType?: 'image' | 'file'     // 媒体类型
  saveToServer?: boolean           // 是否保存到平台（默认false，仅保存URL）
  attachmentFieldName?: string     // 附件字段名称（保存到平台时使用）
  originalUrlFieldName?: string    // 原始URL字段名称（保存到平台时使用）
}

/**
 * 翻页检测结果 - 直接使用 crawl-base 的类型定义
 */
export type {
  PaginationInfo,
  PaginationType,
  PageNumberInfo,
  ScrollDetectionResult
}

/**
 * 任务暂停信息
 */
export interface TaskPauseInfo {
  reason: string
  message: string
  pausedAt: number
  allowRetry: boolean
  paginationInfo?: PaginationInfo  // v2.0 格式
  /** 🆕 后端推荐的翻页策略（v3.0 新增） */
  paginationStrategy?: any  // 实际类型为 PaginationStrategy，避免循环导入
  recommendations?: RecommendationOption[]
  recommendationStats?: RecommendationStats
  caseType?: RecommendationCaseType
  blockedReason?: string
  diagnosisHint?: string
  context?: {
    stepIndex?: number
    url?: string
    [key: string]: any
  }
  selection?: {
    selectedId?: string
    message?: string
    type?: ExtractionSelectionType
    source?: ExtractionSelectionSource | string
    schema?: any
    metadata?: Record<string, any>
    skeletonHtml?: string
  }
}

export interface RecommendationMetadata {
  generatedAt?: number
  recommendations?: RecommendationOption[]
  stats?: RecommendationStats
  caseType?: RecommendationCaseType
  pageInfo?: Record<string, any>
  blockedReason?: string
  diagnosisHint?: string
  selectedId?: string
  selectedInstruction?: string
  selectionType?: ExtractionSelectionType
  selectionSource?: ExtractionSelectionSource
  metadata?: Record<string, any>
  selectionContext?: RecommendationSelectionContext
}

/**
 * 智能策略相关类型
 */
export type StrategyStatus = 'completed' | 'failed' | 'skipped'

export interface StrategyObservationElement {
  elementId?: string
  role?: string
  textOriginal?: string
  textNormalized?: string
  domPath?: string
  tagName?: string
}

export interface StrategyObservationListInsight {
  selector?: string
  size?: number
  sampleTexts?: string[]
}

export interface StrategyObservationStructure {
  skeletonHtml?: string
  cleanedHtmlPreview?: string
  listInsights?: StrategyObservationListInsight[]
}

export interface StrategyObservationStats {
  interactiveCount?: number
  candidateCount?: number
  listItemCount?: number
  scrollHeight?: number
  viewportHeight?: number
}

export interface StrategyObservationSnapshot {
  url: string
  title?: string
  locale?: string
  candidateElements?: StrategyObservationElement[]
  structure?: StrategyObservationStructure
  stats?: StrategyObservationStats
  metadata?: Record<string, unknown>
}

export interface StrategyCommandInfo {
  action: string
  target?: Record<string, unknown>
  expect?: Record<string, unknown>
  reason?: string
}

export interface StrategyVerificationInfo {
  type?: string
  passed?: boolean
  details?: Record<string, unknown>
}

export interface StrategyExecutionLogEntry {
  command: StrategyCommandInfo
  success: boolean
  error?: string
  verification?: StrategyVerificationInfo
}

export interface StrategyState {
  status?: StrategyStatus
  commands?: StrategyCommandInfo[]
  logs?: StrategyExecutionLogEntry[]
  error?: string
  actionGraphId?: string
  reusedActionGraphId?: string
  observation?: StrategyObservationSnapshot | null
  timestamp?: number
  instruction?: string
  instructionSource?: string
  userInstruction?: string
  humanRequest?: any
  detection?: any
  pauseInfo?: any
  plannerPrompt?: string
}
