import type {
  BatchCreateRecordsInput,
  BatchDeleteRecordsInput,
  BatchUpdateRecordsInput,
  CommandResult,
  CreateFieldInput,
  CreateRecordInput,
  CreateTableInput,
  CreateViewInput,
  DeleteFieldInput,
  DeleteRecordInput,
  FilterSet,
  SortConfig,
  UpdateFieldInput,
  UpdateRecordInput,
  UpdateTableInput,
  UpdateViewInput,
} from '@tabtin/table-kernel';

export interface TableSyncStatusView {
  tableId: string;
  backlog: number;
  pending: number;
  processing: number;
  failed: number;
  acked: number;
  lastAckVersion: number | null;
  lastFlushError: string | null;
  lastSyncedVersion: number;
}

/** Semantic table operations exposed to local transports. */
export interface TableApplicationPort {
  readonly isReady: boolean;
  listSyncStatus(): Promise<TableSyncStatusView[]>;
  getCachedTableIds(): string[];
  getRecoveredProcessingCount(): number;
  getSyncStatus(tableId: string): Promise<TableSyncStatusView>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  queryWithFilter(tableId: string, filter?: FilterSet | null, sorts?: SortConfig[], limit?: number, offset?: number): Promise<Record<string, unknown>[]>;
  createRecord(input: CreateRecordInput): Promise<CommandResult<{ recordId: string }>>;
  updateRecord(input: UpdateRecordInput): Promise<CommandResult>;
  deleteRecord(input: DeleteRecordInput): Promise<CommandResult>;
  batchCreateRecords(input: BatchCreateRecordsInput): Promise<CommandResult<{ recordIds: string[]; count: number }>>;
  batchUpdateRecords(input: BatchUpdateRecordsInput): Promise<CommandResult<{ count: number }>>;
  batchDeleteRecords(input: BatchDeleteRecordsInput): Promise<CommandResult<{ count: number }>>;
  createField(input: CreateFieldInput): Promise<CommandResult<{ fieldId: string }>>;
  updateField(input: UpdateFieldInput): Promise<CommandResult>;
  deleteField(input: DeleteFieldInput): Promise<CommandResult>;
  createTable(input: CreateTableInput): Promise<CommandResult<{ tableId: string }>>;
  updateTable(input: UpdateTableInput): Promise<CommandResult>;
  deleteTable(tableId: string): Promise<CommandResult>;
  archiveTable(tableId: string): Promise<CommandResult>;
  restoreTable(tableId: string): Promise<CommandResult>;
  createView(input: CreateViewInput): Promise<CommandResult<{ viewId: string }>>;
  updateView(input: UpdateViewInput): Promise<CommandResult>;
  deleteView(viewId: string): Promise<CommandResult>;
}
