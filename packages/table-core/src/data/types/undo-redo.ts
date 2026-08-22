// ── Undo/Redo & Record History Types ──
// Mirrors backend schemas from apps/tabtin_django/apps/tabdata/schemas.py

export interface HistoryOperationUser {
  id: number | null
  name: string
}

export type HistoryAction = 'create' | 'update' | 'delete' | 'restore'

export interface FieldChange {
  old: unknown
  new: unknown
}

export interface HistoryOperationItem {
  field_key: string
  field_name?: string | null
  field_type?: string | null
  before: unknown
  after: unknown
}

export interface HistoryOperationOut {
  id: string
  record_id: string
  action: HistoryAction
  action_display: string
  field_changes: Record<string, FieldChange>
  items?: HistoryOperationItem[]
  user: HistoryOperationUser | null
  created_at: string
  is_undone: boolean
  undone_at: string | null
  undone_by: HistoryOperationUser | null
  operation_group_id: string | null
  editor_type?: 'user' | 'human' | 'agent' | 'system'
  agent_run_id?: string | null
}

// ── Request Types ──

export interface UndoRedoRequest {
  only_my_operations?: boolean
}

export interface RecordHistoryQuery {
  cursor?: string | null
  startDate?: string
  endDate?: string
  include_undone?: boolean
  limit?: number
}

export interface TableHistoryQuery {
  cursor?: string | null
  startDate?: string
  endDate?: string
  include_undone?: boolean
  only_my_operations?: boolean
  limit?: number
}

// ── Response Types ──

export interface UndoRedoResponse {
  success: boolean
  message: string | null
  operation: HistoryOperationOut | null
}

export interface BatchUndoRedoResponse {
  success: boolean
  message: string | null
  operations: HistoryOperationOut[]
  count: number
}

export interface UndoStackResponse {
  operations: HistoryOperationOut[]
  total: number
}

export interface RedoStackResponse {
  operations: HistoryOperationOut[]
  total: number
}

export interface RecordHistoryResponse {
  operations: HistoryOperationOut[]
  history_list?: HistoryOperationOut[]
  user_map?: Record<string, HistoryOperationUser>
  total: number
  next_cursor?: string | null
}

export interface TableHistoryResponse {
  operations: HistoryOperationOut[]
  history_list?: HistoryOperationOut[]
  user_map?: Record<string, HistoryOperationUser>
  total: number
  next_cursor?: string | null
}

// ── Snapshot & Restore ──

export interface RecordSnapshotResponse {
  record_id: string
  history_id: string
  snapshot: Record<string, unknown>
}

export interface TableSnapshotRecord {
  record_id: string
  row_id: string
  order: number
  is_deleted?: boolean
  data: Record<string, unknown>
}

export interface TableSnapshotResponse {
  table_id: string
  history_id: string
  snapshot: TableSnapshotRecord[]
  total: number
  is_truncated?: boolean
}

export interface RestoreRecordRequest {
  history_id: string
}

export interface RestoreRecordResponse {
  record_id: string
  data: Record<string, unknown>
  changed_fields: number
}

export interface RestoreTableRequest {
  history_id: string
}

export interface RestoreTableResponse {
  table_id: string
  history_id: string
  changed_records: number
  changed_histories: number
  changed_fields?: number
  operation_group_id?: string | null
  sync_mode?: 'resync' | 'force_close' | 'failed' | 'none'
}

// ── 命名版本 ──

export interface TableNamedVersion {
  id: string
  table_id: string
  history_id: string | null
  snapshot_at: string | null
  name: string
  created_by: string | null
  created_at: string | null
}

export interface CreateTableNamedVersionRequest {
  name?: string
  /** ：传入时保存该历史快照；缺省保存当前表 */
  history_id?: string | null
}

export interface RenameTableNamedVersionRequest {
  name: string
}
