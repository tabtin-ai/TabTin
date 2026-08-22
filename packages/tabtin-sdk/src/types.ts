// ── Client Options ─────────────────────────────────────

export interface TabTinClientOptions {
  /** API base URL, e.g. 'https://api.example.com' */
  baseURL: string
  /** API Token, e.g. 'ttn_xxx_yyy' */
  token: string
  /** Space ID — required for table operations via Open API */
  spaceId?: string
  /** Request timeout in ms (default: 30000) */
  timeout?: number
}

// ── API Response ───────────────────────────────────────

export interface ApiResponse<T> {
  data: T | null
  error: TabTinError | null
}

export class TabTinError extends Error {
  status: number
  code: string
  detail?: string

  constructor(message: string, status: number, code: string, detail?: string) {
    super(message)
    this.name = 'TabTinError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

// ── Filter / Sort ──────────────────────────────────────

export type FilterOperator =
  | 'equals' | 'not_equals'
  | 'contains' | 'not_contains'
  | 'like' | 'ilike'
  | 'greater_than' | 'less_than'
  | 'greater_than_or_equals' | 'less_than_or_equals'
  | 'is_empty' | 'is_not_empty'
  | 'in' | 'not_in'
  | 'has_any_of' | 'has_all_of' | 'has_none_of'
  | 'is_exactly'

export interface FilterCondition {
  field: string
  operator: FilterOperator
  value?: unknown
}

export interface FilterSet {
  conjunction: 'and' | 'or'
  filterSet: (FilterCondition | FilterSet)[]
}

export interface SortItem {
  field: string
  order: 'asc' | 'desc'
}

// ── Record Types ───────────────────────────────────────

export type RecordFields = Record<string, unknown>

export interface RecordRow {
  id: string
  fields: RecordFields
  created_at?: string
  updated_at?: string
}

export interface RecordListResult {
  records: RecordRow[]
  total: number
  page: number
  page_size: number
  has_more: boolean
  latest_version?: number
}

// ── Query Options ──────────────────────────────────────

export interface QueryOptions {
  filter?: FilterSet
  sort?: SortItem[]
  fields?: string[]
  page?: number
  pageSize?: number
  search?: string
}

// ── Field Map ──────────────────────────────────────────

export interface FieldMapResult {
  field_map: Record<string, string>
  schema_version: number
}

// ── Aggregation ────────────────────────────────────────

export type AggregationFunction =
  | 'count' | 'sum' | 'avg' | 'min' | 'max'
  | 'count_distinct' | 'count_empty' | 'count_not_empty'
  | 'percent_empty' | 'percent_not_empty' | 'percent_unique'

export interface AggregationItem {
  field: string
  function: AggregationFunction
}

// ── RLS (Row Level Security) ──────────────────────────

export type RLSOperation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL'
export type RLSPolicyType = 'PERMISSIVE' | 'RESTRICTIVE'

export interface RLSPolicy {
  id: string
  name: string
  operation: RLSOperation
  policy_type: RLSPolicyType
  condition: Record<string, unknown>
  apply_to_tokens: boolean
  apply_to_jwt: boolean
  is_active: boolean
  created_at?: string
  updated_at?: string
}

export interface RLSPolicyCreateInput {
  name: string
  operation?: RLSOperation
  policy_type?: RLSPolicyType
  condition: Record<string, unknown>
  apply_to_tokens?: boolean
  apply_to_jwt?: boolean
  is_active?: boolean
}

export interface RLSPolicyUpdateInput {
  name?: string
  operation?: RLSOperation
  policy_type?: RLSPolicyType
  condition?: Record<string, unknown>
  apply_to_tokens?: boolean
  apply_to_jwt?: boolean
  is_active?: boolean
}

export interface RLSStatus {
  rls_enabled: boolean
  rls_force: boolean
  policies: RLSPolicy[]
}

// ── Storage ─────────────────────────────────────────────

export interface FileInfo {
  file_id: string
  file_name: string
  file_size: number
  mime_type: string
  access_url: string
  is_public?: boolean
  created_at?: string
  updated_at?: string
}

export interface PresignedUploadResult {
  upload_url: string
  object_key: string
  upload_item_id: string
  expires_in: number
  /** 分片上传：后端 upload_id（阿里云 OSS multipart upload ID） */
  upload_id?: string
  /** 分片上传：总分片数 */
  total_parts?: number
  /** 分片上传：各分片的预签名 PUT URL 列表 */
  part_presigned_urls?: string[]
  /** 上传任务 ID（后端返回） */
  task_id?: string
}

export interface StorageListItem {
  reference_id: string
  file_id: string
  table_id?: string
  field_id?: string
  record_id?: string
  file_name: string
  file_size: number
  mime_type: string
  access_url: string
  is_public?: boolean
  is_deleted?: boolean
  created_at?: string
  updated_at?: string
}

export interface StorageListResult {
  files: StorageListItem[]
  total: number
  page: number
  page_size: number
}

export interface DownloadUrlResult {
  download_url: string
  /** 签名 URL 有效期（秒）。公开文件为 null（永不过期） */
  expires_in: number | null
  file_name?: string
  file_size?: number
  mime_type?: string
}

export interface DeleteResult {
  file_id: string
  deleted_references: string[]
  count: number
}

export interface UploadOptions {
  record_id?: string
  is_public?: boolean
}

export interface StorageListOptions {
  field_id?: string
  record_id?: string
  page?: number
  page_size?: number
}

// ── SQL ────────────────────────────────────────────────

export interface SqlQueryResult {
  columns: string[]
  rows: unknown[][]
  row_count: number
}
