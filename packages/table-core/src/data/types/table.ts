export type TableUserRole = 'owner' | 'admin' | 'editor' | 'viewer'

export interface Table {
  id: string
  /** 归属 Organization（org-only 建表后的主归属） */
  organization_id?: string
  /** 遗留可选上下文：历史 Space 挂载；新表可不填 */
  space_id?: string
  /** 遗留：organization 级列表中带回的历史 Space 名称 */
  space_name?: string
  name: string
  description?: string
  icon?: string
  created_by_id: string
  is_archived: boolean
  created_at: string
  updated_at: string
  row_count?: number
  field_count?: number
  schema_version?: number
  schema_history_id?: string
  default_source_url?: string
  default_view_id?: string
  /** 表格可见性：normal（普通）| system（Agent 系统表）| hidden */
  visibility?: 'normal' | 'system' | 'hidden'
  /** 当前用户对该表格的角色（后端根据权限链计算） */
  current_user_role?: TableUserRole | null
}

export interface TableListResponse {
  tables: Table[]
  total: number
  page?: number
  page_size?: number
}

type TableSpaceCompatible = Pick<Table, 'space_id'>

export const getTableSpaceId = (table: TableSpaceCompatible | null | undefined): string | null => {
  const raw = table?.space_id
  if (typeof raw !== 'string') return null
  const normalized = raw.trim()
  return normalized || null
}

export const normalizeTable = <T extends Table>(table: T): T => {
  const spaceId = getTableSpaceId(table)
  if (!spaceId) return table
  if (table.space_id === spaceId) return table
  return { ...table, space_id: spaceId }
}

export const normalizeTableListResponse = (response: TableListResponse): TableListResponse => ({
  ...response,
  tables: response.tables.map((table) => normalizeTable(table)),
})

export interface CreateTableRequest {
  /**
   * 所属 Organization（org-only 建表时必填）。
   * 与 space_id 至少提供一个；优先 organization_id。
   */
  organization_id?: string
  /** 遗留可选上下文；不传则表直属 Organization */
  space_id?: string
  name: string
  description?: string
  icon?: string
  use_default_fields?: boolean
  schema_history_id?: string
  default_source_url?: string
  collection_id?: string | null
  /**  知识库树父 ContextItem */
  parent_item_id?: string | null
}

export interface UpdateTableRequest {
  name?: string
  description?: string
  icon?: string
}

export interface TableStats {
  table_id: string
  record_count: number
}

export type TableSearchIndexIssue = 'missing' | 'redundant' | 'definition_mismatch'

export interface TableSearchIndexAbnormalItem {
  index_name: string
  issue: TableSearchIndexIssue
  field_id?: string
  field_name?: string
}

export interface TableSearchIndexFieldStatus {
  field_id: string
  field_name: string
  field_type: string
  indexed: boolean
}

export interface TableSearchIndexStatus {
  type: 'search'
  supported: boolean
  database_vendor: string
  enabled: boolean
  index_count: number
  expected_count: number
  abnormal_count: number
  abnormal_indexes: TableSearchIndexAbnormalItem[]
  fields: TableSearchIndexFieldStatus[]
  reason?: string
}

export interface TableQueryParams {
  search?: string
  is_archived?: boolean
  include_system?: boolean
  page?: number
  page_size?: number
  current_space_id?: string
}

// ==================== Search Query Types ====================

/**
 */
export interface SearchIndexQueryParams {
  /** 搜索关键词（必填） */
  search: string
  /** 字段 ID（逗号分隔或 'all_fields'，默认全字段） */
  field_id?: string
  /** 是否隐藏不匹配行（影响 index 计算） */
  hide_not_match_row?: boolean
  /** 视图 ID（用于排序） */
  view_id?: string
  /** 分页偏移（默认 0） */
  skip?: number
  /** 每页数量（默认 100，最大 1000） */
  take?: number
}

/**
 */
export interface SearchIndexHit {
  /** 记录在视图中的索引（从 1 开始） */
  index: number
  /** 匹配的字段 ID */
  fieldId: string
  /** 记录 ID */
  recordId: string
}

/**
 * 搜索命中结果（数组或 null）
 */
export type SearchIndexResult = SearchIndexHit[] | null

/**
 * 搜索计数请求参数
 */
export interface SearchCountParams {
  /** 搜索关键词 */
  search: string
  /** 字段 ID */
  field_id?: string
  /** 视图 ID */
  view_id?: string
}

/**
 * 搜索计数结果
 */
export interface SearchCountResult {
  count: number
}
