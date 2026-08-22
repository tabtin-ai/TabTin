/**
 * 抓取任务结果解析模块
 *
 * 将 IPC / API 返回的原始数据规范化为类型安全的结构。
 * 从 useCrawlTask.ts 提取，便于独立测试与复用。
 */

import type {
  StrategyState,
  StrategyObservationSnapshot,
  StrategyCommandInfo,
  StrategyExecutionLogEntry,
  StrategyObservationElement,
  StrategyObservationStructure,
  StrategyObservationListInsight,
  StrategyObservationStats,
  StrategyVerificationInfo,
  StrategyStatus,
  TaskPauseInfo,
  RecommendationOption,
  RecommendationStats,
  RecommendationMetadata,
  RecommendationCaseType,
  PaginationExecutionState,
  PaginationExecutionLog,
  RecommendationSelectionContext,
  ExtractionSelectionSource,
} from '../../types'
import i18n from '@/i18n'

const isPlainObject = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null

export type PaginationTelemetry = {
  startedAt: number
  finishedAt: number
  durationMs: number
  requestedPages: number
  attemptedPages: number
  successPages: number
  duplicatePages: number
  noNewDataStops: number
  strategy: 'PURE_SCROLL' | 'PURE_PAGE' | 'HYBRID' | 'LEARNING'
  lastError?: string
}

type SchemaGenerationStats = {
  requestTime: number
  responseTime: number
  totalDuration: number
  fromCache: boolean
  statusCode: number
  retryCount?: number
}

const RECOMMENDATION_CASE_TYPES: readonly RecommendationCaseType[] = [
  'direct_extract', 'auth_required', 'captcha', 'action_required', 'empty_content', 'unsupported',
] as const

const EXTRACTION_SELECTION_SOURCES: readonly ExtractionSelectionSource[] = [
  'history:user_created', 'history:ai_recommended', 'history:similar_pages', 'recommendation',
] as const

const isRecommendationCaseType = (value: unknown): value is RecommendationCaseType =>
  typeof value === 'string' && (RECOMMENDATION_CASE_TYPES as readonly string[]).includes(value)

const isExtractionSelectionSource = (value: unknown): value is ExtractionSelectionSource =>
  typeof value === 'string' && (EXTRACTION_SELECTION_SOURCES as readonly string[]).includes(value)

const isRecommendationOption = (option: RecommendationOption | undefined): option is RecommendationOption =>
  option !== undefined

export const MAX_PAGINATION_LOG_ENTRIES = 50

export const normalizeRecommendationOption = (raw: any): RecommendationOption | undefined => {
  if (!isPlainObject(raw) || typeof raw.id !== 'string') return undefined
  const title = typeof raw.title === 'string' && raw.title.trim().length > 0
    ? raw.title : i18n.t('crawl:recommendation.defaultTitle')
  const option: RecommendationOption = {
    id: raw.id,
    title,
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0,
  }
  if (raw.target_region && isPlainObject(raw.target_region)) {
    option.target_region = raw.target_region as RecommendationOption['target_region']
  }
  if (typeof raw.region_type === 'string') {
    option.region_type = raw.region_type as RecommendationOption['region_type']
  }
  return option
}

export const normalizeRecommendationStats = (raw: any): RecommendationStats | undefined => {
  if (!isPlainObject(raw)) return undefined
  if (typeof raw.requestTime !== 'number' || typeof raw.responseTime !== 'number' ||
      typeof raw.totalDuration !== 'number' || typeof raw.fromCache !== 'boolean' ||
      typeof raw.statusCode !== 'number') return undefined
  const stats: RecommendationStats = {
    requestTime: raw.requestTime, responseTime: raw.responseTime, totalDuration: raw.totalDuration,
    fromCache: raw.fromCache, statusCode: raw.statusCode,
  }
  if (typeof raw.retryCount === 'number') stats.retryCount = raw.retryCount
  return stats
}

const normalizeSchemaGenerationStats = (raw: any): SchemaGenerationStats | Record<string, any> | undefined => {
  if (!isPlainObject(raw)) return undefined
  if (typeof raw.requestTime === 'number' && typeof raw.responseTime === 'number' &&
      typeof raw.totalDuration === 'number' && typeof raw.fromCache === 'boolean' &&
      typeof raw.statusCode === 'number') return raw as SchemaGenerationStats
  return raw
}

export const normalizeRecommendationSelectionContext = (raw: any): RecommendationSelectionContext | undefined => {
  if (!isPlainObject(raw)) return undefined
  const context: RecommendationSelectionContext = {}
  if (raw.type === 'history' || raw.type === 'recommendation') context.type = raw.type
  if (typeof raw.source === 'string') context.source = raw.source
  if (raw.schema !== undefined) context.schema = raw.schema
  if (typeof raw.skeletonHtml === 'string') context.skeletonHtml = raw.skeletonHtml
  if (typeof raw.cleanedHtml === 'string') context.cleanedHtml = raw.cleanedHtml
  if (isPlainObject(raw.preprocessingStats)) context.preprocessingStats = raw.preprocessingStats
  if (isPlainObject(raw.metadata)) context.metadata = raw.metadata
  if (typeof raw.schemaGeneratedAt === 'number') context.schemaGeneratedAt = raw.schemaGeneratedAt
  if (typeof raw.appliedAt === 'number') context.appliedAt = raw.appliedAt
  const schemaStats = normalizeSchemaGenerationStats(raw.schemaStats)
  if (schemaStats) context.schemaStats = schemaStats
  if (isPlainObject(raw.paginationStrategy)) context.paginationStrategy = raw.paginationStrategy
  return context
}

export const normalizeRecommendationMetadata = (raw: any): RecommendationMetadata | undefined => {
  if (!isPlainObject(raw)) return undefined
  const metadata: RecommendationMetadata = {
    generatedAt: typeof raw.generatedAt === 'number' ? raw.generatedAt : undefined,
    recommendations: Array.isArray(raw.recommendations)
      ? (raw.recommendations.map(normalizeRecommendationOption).filter(isRecommendationOption)
          .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)))
      : undefined,
    stats: normalizeRecommendationStats(raw.stats),
    caseType: isRecommendationCaseType(raw.caseType) ? raw.caseType : undefined,
    pageInfo: isPlainObject(raw.pageInfo) ? raw.pageInfo : undefined,
    blockedReason: typeof raw.blockedReason === 'string' ? raw.blockedReason : undefined,
    diagnosisHint: typeof raw.diagnosisHint === 'string' ? raw.diagnosisHint : undefined,
    selectedId: typeof raw.selectedId === 'string' ? raw.selectedId : undefined,
    selectedInstruction: typeof raw.selectedInstruction === 'string' ? raw.selectedInstruction : undefined,
    selectionType: raw.selectionType === 'history' || raw.selectionType === 'recommendation' ? raw.selectionType : undefined,
    selectionSource: isExtractionSelectionSource(raw.selectionSource) ? raw.selectionSource : undefined,
    metadata: isPlainObject(raw.metadata) ? raw.metadata : undefined,
    selectionContext: normalizeRecommendationSelectionContext(raw.selectionContext),
  }
  return metadata
}

const isValidPaginationStatus = (value: any): value is PaginationExecutionState['status'] =>
  value === 'pending' || value === 'running' || value === 'completed' || value === 'failed'

const normalizePaginationTelemetry = (raw: any): PaginationTelemetry | undefined => {
  if (!isPlainObject(raw)) return undefined
  const keys: Array<keyof PaginationTelemetry> = [
    'startedAt', 'finishedAt', 'durationMs', 'requestedPages', 'attemptedPages',
    'successPages', 'duplicatePages', 'noNewDataStops', 'strategy',
  ]
  for (const key of keys) {
    if (key === 'strategy') {
      const s = raw[key]
      if (s !== 'PURE_SCROLL' && s !== 'PURE_PAGE' && s !== 'HYBRID' && s !== 'LEARNING') return undefined
      continue
    }
    if (typeof raw[key] !== 'number') return undefined
  }
  return {
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    durationMs: raw.durationMs,
    requestedPages: raw.requestedPages,
    attemptedPages: raw.attemptedPages,
    successPages: raw.successPages,
    duplicatePages: raw.duplicatePages,
    noNewDataStops: raw.noNewDataStops,
    strategy: raw.strategy,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : undefined,
  }
}

const normalizePaginationLogEntry = (raw: any): PaginationExecutionLog | undefined => {
  if (!isPlainObject(raw) || typeof raw.message !== 'string') return undefined
  const level = raw.level
  if (level !== 'info' && level !== 'warn' && level !== 'error') return undefined
  return {
    timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : Date.now(),
    level,
    message: raw.message,
    params: Array.isArray(raw.params) ? raw.params : undefined,
  }
}

export const normalizePaginationExecution = (raw: any): PaginationExecutionState | undefined => {
  if (!isPlainObject(raw) || !isValidPaginationStatus(raw.status)) return undefined
  const logs = Array.isArray(raw.logs)
    ? (raw.logs.map(normalizePaginationLogEntry).filter(Boolean) as PaginationExecutionLog[])
    : undefined
  return {
    status: raw.status,
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : undefined,
    lastUpdatedAt: typeof raw.lastUpdatedAt === 'number' ? raw.lastUpdatedAt : undefined,
    requestedPages: typeof raw.requestedPages === 'number' ? raw.requestedPages : undefined,
    successPages: typeof raw.successPages === 'number' ? raw.successPages : undefined,
    errorMessage: typeof raw.errorMessage === 'string' ? raw.errorMessage : undefined,
    metrics: normalizePaginationTelemetry(raw.metrics),
    logs,
  }
}

export const normalizePauseInfo = (raw: any): TaskPauseInfo | undefined => {
  if (!isPlainObject(raw)) return undefined
  const pauseInfo: TaskPauseInfo = {
    reason: typeof raw.reason === 'string' ? raw.reason : 'unknown',
    message: typeof raw.message === 'string' ? raw.message : '',
    pausedAt: typeof raw.pausedAt === 'number' ? raw.pausedAt : Date.now(),
    allowRetry: raw.allowRetry === undefined ? true : Boolean(raw.allowRetry),
  }
  if (isPlainObject(raw.context)) pauseInfo.context = raw.context
  if (isPlainObject(raw.paginationInfo)) pauseInfo.paginationInfo = raw.paginationInfo as TaskPauseInfo['paginationInfo']
  if (isPlainObject(raw.paginationStrategy)) pauseInfo.paginationStrategy = raw.paginationStrategy
  if (Array.isArray(raw.recommendations)) {
    const options = raw.recommendations.map(normalizeRecommendationOption).filter(isRecommendationOption)
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    if (options.length > 0) pauseInfo.recommendations = options
  }
  const stats = normalizeRecommendationStats(raw.recommendationStats)
  if (stats) pauseInfo.recommendationStats = stats
  if (isRecommendationCaseType(raw.caseType)) pauseInfo.caseType = raw.caseType
  if (typeof raw.blockedReason === 'string') pauseInfo.blockedReason = raw.blockedReason
  if (typeof raw.diagnosisHint === 'string') pauseInfo.diagnosisHint = raw.diagnosisHint
  if (isPlainObject(raw.selection)) {
    const s = raw.selection
    pauseInfo.selection = {
      selectedId: typeof s.selectedId === 'string' ? s.selectedId : undefined,
      message: typeof s.message === 'string' ? s.message : undefined,
      type: s.type === 'history' || s.type === 'recommendation' ? s.type : undefined,
      source: isExtractionSelectionSource(s.source) ? s.source : undefined,
      schema: s.schema,
      metadata: isPlainObject(s.metadata) ? s.metadata : undefined,
      skeletonHtml: typeof s.skeletonHtml === 'string' ? s.skeletonHtml : undefined,
    }
  }
  return pauseInfo
}

const normalizeObservationElement = (raw: any): StrategyObservationElement | undefined => {
  if (!isPlainObject(raw)) return undefined
  const element: StrategyObservationElement = {}
  if (typeof raw.elementId === 'string') element.elementId = raw.elementId
  if (typeof raw.role === 'string') element.role = raw.role
  if (typeof raw.textOriginal === 'string') element.textOriginal = raw.textOriginal
  if (typeof raw.textNormalized === 'string') element.textNormalized = raw.textNormalized
  if (typeof raw.domPath === 'string') element.domPath = raw.domPath
  if (typeof raw.tagName === 'string') element.tagName = raw.tagName
  return Object.keys(element).length > 0 ? element : undefined
}

const normalizeListInsight = (raw: any): StrategyObservationListInsight | undefined => {
  if (!isPlainObject(raw)) return undefined
  const insight: StrategyObservationListInsight = {}
  if (typeof raw.selector === 'string') insight.selector = raw.selector
  if (typeof raw.size === 'number') insight.size = raw.size
  if (Array.isArray(raw.sampleTexts)) {
    const texts = raw.sampleTexts.filter((t: unknown) => typeof t === 'string')
    if (texts.length > 0) insight.sampleTexts = texts as string[]
  }
  return Object.keys(insight).length > 0 ? insight : undefined
}

const normalizeStructure = (raw: any): StrategyObservationStructure | undefined => {
  if (!isPlainObject(raw)) return undefined
  const structure: StrategyObservationStructure = {}
  if (typeof raw.skeletonHtml === 'string') structure.skeletonHtml = raw.skeletonHtml
  if (typeof raw.cleanedHtmlPreview === 'string') structure.cleanedHtmlPreview = raw.cleanedHtmlPreview
  if (Array.isArray(raw.listInsights)) {
    const insights = raw.listInsights.map(normalizeListInsight).filter(Boolean) as StrategyObservationListInsight[]
    if (insights.length > 0) structure.listInsights = insights
  }
  return Object.keys(structure).length > 0 ? structure : undefined
}

const normalizeStats = (raw: any): StrategyObservationStats | undefined => {
  if (!isPlainObject(raw)) return undefined
  const stats: StrategyObservationStats = {}
  if (typeof raw.interactiveCount === 'number') stats.interactiveCount = raw.interactiveCount
  if (typeof raw.candidateCount === 'number') stats.candidateCount = raw.candidateCount
  if (typeof raw.listItemCount === 'number') stats.listItemCount = raw.listItemCount
  if (typeof raw.scrollHeight === 'number') stats.scrollHeight = raw.scrollHeight
  if (typeof raw.viewportHeight === 'number') stats.viewportHeight = raw.viewportHeight
  return Object.keys(stats).length > 0 ? stats : undefined
}

const normalizeObservation = (raw: any): StrategyObservationSnapshot | undefined => {
  if (!isPlainObject(raw)) return undefined
  const url = typeof raw.url === 'string' && raw.url.length > 0 ? raw.url : 'about:blank'
  const snapshot: StrategyObservationSnapshot = { url }
  if (typeof raw.title === 'string') snapshot.title = raw.title
  if (typeof raw.locale === 'string') snapshot.locale = raw.locale
  if (Array.isArray(raw.candidateElements)) {
    const elements = raw.candidateElements.map(normalizeObservationElement).filter(Boolean) as StrategyObservationElement[]
    if (elements.length > 0) snapshot.candidateElements = elements
  }
  const structure = normalizeStructure(raw.structure)
  if (structure) snapshot.structure = structure
  const stats = normalizeStats(raw.stats)
  if (stats) snapshot.stats = stats
  if (isPlainObject(raw.metadata)) snapshot.metadata = raw.metadata
  return snapshot
}

const normalizeCommand = (raw: any): StrategyCommandInfo | undefined => {
  if (!isPlainObject(raw) || typeof raw.action !== 'string') return undefined
  const command: StrategyCommandInfo = { action: raw.action }
  if (isPlainObject(raw.target)) command.target = raw.target
  if (isPlainObject(raw.expect)) command.expect = raw.expect
  if (typeof raw.reason === 'string') command.reason = raw.reason
  return command
}

const normalizeVerification = (raw: any): StrategyVerificationInfo | undefined => {
  if (!isPlainObject(raw)) return undefined
  const verification: StrategyVerificationInfo = {}
  if (typeof raw.type === 'string') verification.type = raw.type
  if (typeof raw.passed === 'boolean') verification.passed = raw.passed
  if (isPlainObject(raw.details)) verification.details = raw.details
  return Object.keys(verification).length > 0 ? verification : undefined
}

const normalizeLog = (raw: any): StrategyExecutionLogEntry | undefined => {
  if (!isPlainObject(raw)) return undefined
  const command = normalizeCommand(raw.command)
  if (!command) return undefined
  const log: StrategyExecutionLogEntry = {
    command,
    success: typeof raw.success === 'boolean' ? raw.success : false,
  }
  if (typeof raw.error === 'string') log.error = raw.error
  const verification = normalizeVerification(raw.verification)
  if (verification) log.verification = verification
  return log
}

export const normalizeStrategyMetadata = (raw: any): StrategyState | undefined => {
  if (!isPlainObject(raw)) return undefined
  const strategy: StrategyState = {}
  if (typeof raw.status === 'string' && ['completed', 'failed', 'skipped'].includes(raw.status)) {
    strategy.status = raw.status as StrategyStatus
  }
  if (Array.isArray(raw.commands)) {
    const commands = raw.commands.map(normalizeCommand).filter(Boolean) as StrategyCommandInfo[]
    if (commands.length > 0) strategy.commands = commands
  }
  if (Array.isArray(raw.logs)) {
    const logs = raw.logs.map(normalizeLog).filter(Boolean) as StrategyExecutionLogEntry[]
    if (logs.length > 0) strategy.logs = logs
  }
  if (typeof raw.error === 'string') strategy.error = raw.error
  if (typeof raw.actionGraphId === 'string') strategy.actionGraphId = raw.actionGraphId
  if (typeof raw.reusedActionGraphId === 'string') strategy.reusedActionGraphId = raw.reusedActionGraphId
  if (raw.observation === null) strategy.observation = null
  else {
    const obs = normalizeObservation(raw.observation)
    if (obs) strategy.observation = obs
  }
  if (typeof raw.timestamp === 'number') strategy.timestamp = raw.timestamp
  if (typeof raw.instruction === 'string') strategy.instruction = raw.instruction
  if (typeof raw.instructionSource === 'string') strategy.instructionSource = raw.instructionSource
  if (typeof raw.userInstruction === 'string') strategy.userInstruction = raw.userInstruction
  if (isPlainObject(raw.humanRequest)) strategy.humanRequest = raw.humanRequest
  if (isPlainObject(raw.detection)) strategy.detection = raw.detection
  if (isPlainObject(raw.pauseInfo)) {
    const normalized = normalizePauseInfo(raw.pauseInfo)
    if (normalized) strategy.pauseInfo = normalized
  }
  if (typeof raw.plannerPrompt === 'string') strategy.plannerPrompt = raw.plannerPrompt
  return Object.keys(strategy).length > 0 ? strategy : undefined
}
