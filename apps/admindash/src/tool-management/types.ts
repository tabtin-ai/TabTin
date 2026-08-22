export type ToolRiskLevel = 'safe' | 'review' | 'strict'
export type ToolStatus = 'active' | 'deprecated' | 'disabled'
export type ToolSource = 'builtin' | 'manifest' | 'extension' | 'custom'
export type ToolCategory = 'app' | 'runtime' | 'service' | 'extension' | 'platform' | 'custom'

export interface ToolBrief {
  id: string
  name: string
  display_name: string
  description: string
  category: ToolCategory
  provider_id: string
  domain: string
  tags: string[]
  interface_type: string
  execution_target: string
  risk_level: ToolRiskLevel
  optional: boolean
  source: ToolSource
  status: ToolStatus
}

export interface ToolDetail extends ToolBrief {
  parameters_schema: Record<string, unknown>
  return_schema: Record<string, unknown>
  permissions: string[]
  source_ref: string
  version: string
  documentation: string
  examples: unknown[]
  created_at: string
  updated_at: string
  linked_skills: { skill_key: string; relation_type: string }[]
}

export interface ToolListQuery {
  category?: string
  provider_id?: string
  domain?: string
  source?: string
  status?: string
  tags?: string
  q?: string
  page?: number
  page_size?: number
}

export interface ToolListResponse {
  items: ToolBrief[]
  total: number
  page: number
  page_size: number
}

export interface AuditCheckResult {
  status: string
  message: string
  category?: string
  dimension?: string
}

export interface AuditToolResult {
  name: string
  domain: string
  source: string
  risk_level: string
  description: string
  has_skill: boolean
  skill_key: string
  checks: AuditCheckResult[]
  pass_count: number
  fail_count: number
  warn_count: number
}

export interface AuditDomainStat {
  domain: string
  source: string
  count: number
  covered: number
}

export interface AuditToolsSummary {
  total_tools: number
  backend_count: number
  frontend_count: number
  skill_count: number
  covered_count: number
  total_pass: number
  total_fail: number
  total_warn: number
  global_fail: number
  global_warn: number
}

export interface AuditToolsResponse {
  summary: AuditToolsSummary
  global_checks: AuditCheckResult[]
  domains: AuditDomainStat[]
  tools: AuditToolResult[]
}

export interface AuditAppResult {
  app_id: string
  app_name: string
  context_type: string
  checks: AuditCheckResult[]
  pass_count: number
  fail_count: number
  warn_count: number
  total: number
}

export interface AuditAppsSummary {
  total_apps: number
  total_pass: number
  total_fail: number
  total_warn: number
}

export interface AuditAppsResponse {
  summary: AuditAppsSummary
  apps: AuditAppResult[]
}

export interface CategoryStat {
  category: string
  tool_count: number
}

export interface ProviderStat {
  provider_id: string
  category: string
  tool_count: number
  domains: string[]
}

export interface SyncResult {
  created: number
  updated: number
  deprecated: number
  unchanged: number
  total: number
}
