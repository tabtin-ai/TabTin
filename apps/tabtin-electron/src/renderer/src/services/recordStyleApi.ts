import { createJsonApiClient } from '@/services/jsonApiClient'

const RECORD_STYLE_API_BASE = '/tabmemo'
const RECORD_STYLE_PATH = '/record-style/'
const AGENT_STATS_PATH = '/stats/'

export type RecordStyleKind = 'faithful' | 'minimal' | 'companion' | 'custom'
export type RecordDensity = 'concise' | 'moderate' | 'detailed'
export type RecordDepth = 'facts_only' | 'with_judgment'
export type RecordTone = 'objective' | 'natural' | 'warm'
export type RecordFocus = 'outcome' | 'method' | 'about_user' | 'emotion'

export interface RecordStyleCustomConfig {
  density?: RecordDensity
  depth?: RecordDepth
  tone?: RecordTone
  focus?: RecordFocus[]
}

export interface RecordStyleConfig {
  enabled: boolean
  style: RecordStyleKind
  custom_config: RecordStyleCustomConfig
  extra_preference: string
}

export interface RecordStyleUpdate {
  enabled?: boolean
  style?: RecordStyleKind
  custom_config?: RecordStyleCustomConfig
  extra_preference?: string
}

export interface AgentMemoStats {
  about_you: number
  insight: number
  task_summary: number
  total: number
}

class RecordStyleApiError extends Error {
  readonly statusCode: number
  readonly errorCode?: string

  constructor(message: string, statusCode: number, errorCode?: string) {
    super(message)
    this.name = 'RecordStyleApiError'
    this.statusCode = statusCode
    this.errorCode = errorCode
  }
}

const client = createJsonApiClient({
  base: RECORD_STYLE_API_BASE,
  loggerName: 'RecordStyleApi',
  requireData: true,
  makeError: (message, statusCode, errorCode) =>
    new RecordStyleApiError(message, statusCode, errorCode),
})

export class RecordStyleApi {
  static getRecordStyle(organizationId: string): Promise<RecordStyleConfig> {
    return client.request<RecordStyleConfig>({
      path: RECORD_STYLE_PATH,
      method: 'GET',
      params: { organization_id: organizationId },
    })
  }

  static updateRecordStyle(
    organizationId: string,
    patch: RecordStyleUpdate,
  ): Promise<RecordStyleConfig> {
    return client.request<RecordStyleConfig>({
      path: RECORD_STYLE_PATH,
      method: 'PATCH',
      params: { organization_id: organizationId },
      body: patch,
    })
  }

  static getAgentStats(params: {
    organization_id: string
    space_id: string
  }): Promise<AgentMemoStats> {
    return client.request<AgentMemoStats>({
      path: AGENT_STATS_PATH,
      method: 'GET',
      params,
    })
  }
}
