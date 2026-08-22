/**
 * Port 接口定义 — 运行时隔离层
 *
 * 内核通过 Port 与外部世界交互。
 * 每个运行时（Electron、Daemon、Browser、Mobile）提供自己的适配器实现。
 *
 * 此文件也定义 CommandResult / CommandError / OutboxChangeEnvelope 等共享类型，
 * 它们是端口契约的一部分，commands 层 re-export 以保持对外 API 不变。
 */

import type { RecordMutationSpec } from '../domain/record/mutation-spec.js'
import type { FieldDefaultValue, FieldMeta, FieldOptions, FieldType } from '../types/field.js'

// ── 运行时适配器契约 ──

export type FieldColumnMap = Map<string, string>

export interface RemoteApiClient {
  basePath?: string
  get?(path: string): Promise<unknown>
  post(path: string, data: unknown): Promise<unknown>
  put?(path: string, data: unknown): Promise<unknown>
  patch(path: string, data: unknown): Promise<unknown>
  delete(path: string): Promise<unknown>
}

export interface ILocalDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
  getDbTableName(tableId: string): string
  getFieldColumnMap?(tableId: string): FieldColumnMap | undefined
}

// ── 共享类型：端口契约的一部分 ──

export interface CommandResult<T = unknown> {
  success: boolean
  data?: T
  errors: CommandError[]
}

export interface CommandError {
  field?: string
  code: string
  message: string
}

export interface OutboxChangeEnvelope {
  changeId: string
  tableId: string
  recordId: string
  action: 'create' | 'update' | 'delete'
  payload: {
    id: string
    action: 'create' | 'update' | 'delete'
    data?: Record<string, unknown>
  }
  mutation: RecordMutationSpec
  status?: 'pending' | 'processing' | 'acked' | 'failed'
  attemptCount?: number
  lastError?: string | null
  ackVersion?: number | null
  createdAt: string
  updatedAt?: string
}

/**
 * 增量同步接口
 */
export interface ITableSyncService {
  pullChanges(tableId: string, sinceVersion: number): Promise<SyncDelta>
  pushChanges(tableId: string, changes: SyncChange[], options?: SyncPushOptions): Promise<{ newVersion: number }>
  getLocalVersion(tableId: string): Promise<number>
  setLocalVersion(tableId: string, version: number): Promise<void>
  fullReconcile?(tableId: string): Promise<number>
}

export interface SyncPushOptions {
  idempotencyKey?: string
}

export interface SyncDelta {
  version: number
  records: SyncRecordChange[]
  fields?: SyncFieldChange[]
}

export interface SyncRecordChange {
  id: string
  action: 'create' | 'update' | 'delete'
  /**
   * fieldId-keyed payload from the remote sync adapter.
   * Storage adapters may translate the keys into dbColumnName before persistence.
   */
  data?: Record<string, unknown>
  version: number
}

export interface SyncFieldChange {
  id: string
  action: 'create' | 'update' | 'delete'
  field?: FieldMeta
}

export interface SyncChange {
  id: string
  action: 'create' | 'update' | 'delete'
  /**
   * fieldId-keyed payload emitted by the write flow.
   * Runtime adapters translate it into transport/storage specific keys when needed.
   */
  data?: Record<string, unknown>
}

/**
 * Schema 定义 — 描述表结构以初始化本地数据库
 */
export interface TableSchema {
  tableId: string
  dbTableName: string
  fields: TableFieldSchema[]
}

export interface TableFieldSchema {
  id: string
  name: string
  fieldType: FieldType
  dbColumnName: string
  isPrimary: boolean
  defaultValue?: FieldDefaultValue | null
  options?: FieldOptions
}

/**
 * 字段元数据解析器
 */
export interface IFieldResolver {
  getFieldById(fieldId: string): FieldMeta | undefined
  getFieldsByTableId(tableId: string): FieldMeta[]
}

export interface RecordPersistInput {
  tableId: string
  recordId: string
  /**
   * Normalized fieldId-keyed payload produced from the mutation spec.
   * Adapters should treat `mutation` as the source of truth and use `data`
   * as the already-folded convenience view when talking to DB / HTTP layers.
   */
  data: Record<string, unknown>
  mutation: RecordMutationSpec
}

export interface BatchRecordPersistInput {
  tableId: string
  records: RecordPersistInput[]
}

export interface BatchRecordDeleteInput {
  tableId: string
  recordIds: string[]
}

export interface ITableRecordRepository {
  createRecord(input: RecordPersistInput): Promise<CommandResult<{ recordId: string }>>
  updateRecord(input: RecordPersistInput): Promise<CommandResult>
  deleteRecord(input: { tableId: string; recordId: string }): Promise<CommandResult>
  batchCreateRecords(input: BatchRecordPersistInput): Promise<CommandResult<{ recordIds: string[]; count: number }>>
  batchUpdateRecords(input: BatchRecordPersistInput): Promise<CommandResult<{ count: number }>>
  batchDeleteRecords(input: BatchRecordDeleteInput): Promise<CommandResult<{ count: number }>>
}

export interface ITableRecordQueryRepository {
  hasRecord(tableId: string, recordId: string): Promise<boolean>
  /**
   * Returns the current fieldId-keyed snapshot for the record body.
   * Implementations should not include transport/storage-only columns such as `id`.
   */
  getRecord(tableId: string, recordId: string): Promise<Record<string, unknown> | null>
}

export interface IUnitOfWork {
  run<T>(fn: () => Promise<T>): Promise<T>
}

export class NoopUnitOfWork implements IUnitOfWork {
  async run<T>(fn: () => Promise<T>): Promise<T> {
    return fn()
  }
}

export interface OutboxStats {
  pending: number
  processing: number
  failed: number
  acked: number
  lastAckVersion?: number | null
  lastError?: string | null
}

export interface IChangeOutbox {
  append(change: OutboxChangeEnvelope): Promise<void>
  appendMany(changes: OutboxChangeEnvelope[]): Promise<void>
  listPending(options?: { tableId?: string; limit?: number }): Promise<OutboxChangeEnvelope[]>
  listFailed(options?: { tableId?: string; limit?: number }): Promise<OutboxChangeEnvelope[]>
  listTableIds(): Promise<string[]>
  recoverProcessing(): Promise<number>
  markProcessing(changeIds: string[]): Promise<void>
  markAcked(changeIds: string[], ackVersion?: number): Promise<void>
  markFailed(changeIds: string[], error: string, options?: { retryable?: boolean }): Promise<void>
  retryFailed(changeIds: string[]): Promise<number>
  purgeAcked(options?: { tableId?: string; olderThanMs?: number }): Promise<number>
  getStats(tableId?: string): Promise<OutboxStats>
}

// ── 事件总线 ──

export interface DomainEventLike {
  type: string
  eventId: string
  occurredAt: string
  tableId: string
}

export interface IEventBus {
  publish(events: DomainEventLike[]): void | Promise<void>
}

export class NoopEventBus implements IEventBus {
  publish(): void {}
}

// ── 写操作输入契约 ──

export interface FieldSchema {
  id: string
  name: string
  fieldType: FieldType
  defaultValue?: FieldDefaultValue | null
  options?: FieldOptions
}

export interface CreateRecordInput {
  tableId: string
  data: Record<string, unknown>
}

export interface UpdateRecordInput {
  tableId: string
  recordId: string
  data: Record<string, unknown>
}

export interface DeleteRecordInput {
  tableId: string
  recordId: string
}

export interface BatchCreateRecordsInput {
  tableId: string
  records: Array<Record<string, unknown>>
}

export interface BatchDeleteRecordsInput {
  tableId: string
  recordIds: string[]
}

export interface BatchUpdateRecordsInput {
  tableId: string
  records: Array<{ id: string; data: Record<string, unknown> }>
}

// ── Field 端口 ──

export interface FieldSnapshot {
  tableId: string
  fieldId: string
  name: string
  fieldType: FieldType
  isPrimary: boolean
  defaultValue?: FieldDefaultValue | null
  options?: FieldOptions
}

export interface CreateFieldInput {
  tableId: string
  name: string
  fieldType: FieldType
  options?: FieldOptions
  defaultValue?: FieldDefaultValue | null
}

export interface UpdateFieldInput {
  tableId: string
  fieldId: string
  changes: Partial<{
    name: string
    options: FieldOptions
    defaultValue: FieldDefaultValue | null
  }>
}

export interface DeleteFieldInput {
  tableId: string
  fieldId: string
}

export interface IFieldRepository {
  createField(input: CreateFieldInput): Promise<CommandResult<{ fieldId: string }>>
  updateField(input: UpdateFieldInput): Promise<CommandResult>
  deleteField(input: DeleteFieldInput): Promise<CommandResult>
  getField(tableId: string, fieldId: string): Promise<FieldSnapshot | null>
  listFieldsByTable?(tableId: string): Promise<FieldSnapshot[]>
}

// ── Table 端口 ──

export interface TableSnapshot {
  tableId: string
  name: string
  description?: string
  icon?: string
  status: 'active' | 'archived'
}

export interface CreateTableInput {
  spaceId: string
  name: string
  description?: string
  icon?: string
}

export interface UpdateTableInput {
  tableId: string
  changes: Partial<{ name: string; description: string; icon: string }>
}

export interface ITableRepository {
  createTable(input: CreateTableInput): Promise<CommandResult<{ tableId: string }>>
  updateTable(input: UpdateTableInput): Promise<CommandResult>
  deleteTable(tableId: string): Promise<CommandResult>
  archiveTable(tableId: string): Promise<CommandResult>
  restoreTable(tableId: string): Promise<CommandResult>
  getTable(tableId: string): Promise<TableSnapshot | null>
}

// ── View 端口 ──

export type ViewType = 'grid' | 'kanban' | 'calendar' | 'gallery' | 'list' | 'flashcard' | 'form'

export interface ViewColumnMeta {
  [fieldId: string]: Record<string, unknown>
}

export interface ViewColumnMetaCarrier {
  column_meta?: ViewColumnMeta
  /** @deprecated 内部请统一使用 column_meta */
  columnMeta?: ViewColumnMeta
}

export function getViewColumnMeta(
  view: ViewColumnMetaCarrier | null | undefined,
): ViewColumnMeta | undefined {
  return view?.column_meta ?? view?.columnMeta
}

export interface ViewSnapshot extends ViewColumnMetaCarrier {
  viewId: string
  tableId: string
  name: string
  viewType: ViewType
  description?: string
  filter?: Record<string, unknown> | null
  sorts?: Array<Record<string, unknown>>
  groups?: Array<Record<string, unknown>>
  visibleFields?: string[]
  fieldOrder?: string[]
  config?: Record<string, unknown>
  isShared?: boolean
  isLocked?: boolean
}

export interface CreateViewInput extends ViewColumnMetaCarrier {
  tableId: string
  name: string
  viewType: ViewType
  description?: string
  filter?: Record<string, unknown> | null
  sorts?: Array<Record<string, unknown>>
  visibleFields?: string[]
  fieldOrder?: string[]
  config?: Record<string, unknown>
}

export type UpdateViewChanges = Partial<{
  name: string
  description: string
  filter: Record<string, unknown> | null
  sorts: Array<Record<string, unknown>>
  groups: Array<Record<string, unknown>>
  visibleFields: string[]
  fieldOrder: string[]
  config: Record<string, unknown>
  isShared: boolean
  isLocked: boolean
}> & ViewColumnMetaCarrier

export interface UpdateViewInput {
  viewId: string
  changes: UpdateViewChanges
}

export interface IViewRepository {
  createView(input: CreateViewInput): Promise<CommandResult<{ viewId: string }>>
  updateView(input: UpdateViewInput): Promise<CommandResult>
  deleteView(viewId: string): Promise<CommandResult>
  getView(viewId: string): Promise<ViewSnapshot | null>
  listViewsByTable(tableId: string): Promise<ViewSnapshot[]>
  batchUpdateViews(updates: UpdateViewInput[]): Promise<CommandResult>
}
