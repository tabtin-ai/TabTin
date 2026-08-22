import type {
  PaginationExecutionState,
  TaskPauseInfo,
  RecommendationOption,
  RecommendationStats,
  RecommendationMetadata,
  RecommendationSelectionContext,
  PaginationExecutionLog
} from '../types'
import { t } from '../i18n'

const isPlainObject = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null

const normalizeRecommendationOption = (raw: any): RecommendationOption | undefined => {
  if (!isPlainObject(raw)) {
    return undefined
  }
  if (typeof raw.id !== 'string') {
    return undefined
  }
  const title = typeof raw.title === 'string' && raw.title.trim().length > 0 ? raw.title : t('recommendation.defaultTitle')
  const confidence = typeof raw.confidence === 'number' ? raw.confidence : 0
  const option: RecommendationOption = {
    id: raw.id,
    title,
    confidence
  }
  if (raw.target_region && isPlainObject(raw.target_region)) {
    option.target_region = raw.target_region as RecommendationOption['target_region']
  }
  if (typeof raw.region_type === 'string') {
    option.region_type = raw.region_type as RecommendationOption['region_type']
  }
  return option
}

export const normalizeRecommendationMetadata = (raw: any): RecommendationMetadata | undefined => {
  if (!isPlainObject(raw)) {
    return undefined
  }
  const metadata: RecommendationMetadata = {
    generatedAt: typeof raw.generatedAt === 'number' ? raw.generatedAt : undefined,
    recommendations: Array.isArray(raw.recommendations)
      ? (raw.recommendations
          .map(normalizeRecommendationOption)
          .filter((opt): opt is RecommendationOption => opt !== undefined)
          .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)))
      : undefined,
    // stats: normalizeRecommendationStats(raw.stats), // Simplified
    caseType: typeof raw.caseType === 'string' ? raw.caseType as any : undefined,
    pageInfo: isPlainObject(raw.pageInfo) ? raw.pageInfo : undefined,
    blockedReason: typeof raw.blockedReason === 'string' ? raw.blockedReason : undefined,
    diagnosisHint: typeof raw.diagnosisHint === 'string' ? raw.diagnosisHint : undefined,
    selectedId: typeof raw.selectedId === 'string' ? raw.selectedId : undefined,
    selectedInstruction: typeof raw.selectedInstruction === 'string' ? raw.selectedInstruction : undefined,
    selectionType: raw.selectionType,
    selectionSource: raw.selectionSource,
    metadata: isPlainObject(raw.metadata) ? raw.metadata : undefined,
    // selectionContext: normalizeRecommendationSelectionContext(raw.selectionContext)
  }

  return metadata
}

export const normalizePaginationExecution = (raw: any): PaginationExecutionState | undefined => {
  if (!isPlainObject(raw)) {
    return undefined
  }

  const status = raw.status
  if (status !== 'pending' && status !== 'running' && status !== 'completed' && status !== 'failed') {
    return undefined
  }

  const execution: PaginationExecutionState = {
    status,
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : undefined,
    lastUpdatedAt: typeof raw.lastUpdatedAt === 'number' ? raw.lastUpdatedAt : undefined,
    requestedPages: typeof raw.requestedPages === 'number' ? raw.requestedPages : undefined,
    successPages: typeof raw.successPages === 'number' ? raw.successPages : undefined,
    errorMessage: typeof raw.errorMessage === 'string' ? raw.errorMessage : undefined,
    // metrics: normalizePaginationTelemetry(raw.metrics),
    logs: Array.isArray(raw.logs) ? raw.logs : undefined
  }

  return execution
}

export const normalizePauseInfo = (raw: any): TaskPauseInfo | undefined => {
  if (!isPlainObject(raw)) {
    return undefined
  }

  const reason = typeof raw.reason === 'string' ? raw.reason : 'unknown'
  const message = typeof raw.message === 'string' ? raw.message : ''
  const pausedAt = typeof raw.pausedAt === 'number' ? raw.pausedAt : Date.now()
  const allowRetry = raw.allowRetry === undefined ? true : Boolean(raw.allowRetry)

  const pauseInfo: TaskPauseInfo = {
    reason,
    message,
    pausedAt,
    allowRetry,
    paginationInfo: raw.paginationInfo,
    paginationStrategy: raw.paginationStrategy,
  }

  if (Array.isArray(raw.recommendations)) {
    const options = raw.recommendations
      .map(normalizeRecommendationOption)
      .filter((opt): opt is RecommendationOption => opt !== undefined)
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    if (options.length > 0) {
      pauseInfo.recommendations = options
    }
  }

  // Simplified context normalization
  if (isPlainObject(raw.context)) {
    pauseInfo.context = raw.context
  }

  return pauseInfo
}
