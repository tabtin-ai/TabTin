// ── Error Codes ──
export type { ErrorCode } from './errors.js'
export { ErrorCodes } from './errors.js'

// ── Types ──
export type {
  FieldType,
  CellValueType,
  FieldDefaultValue,
  LinkRelationship,
  LinkFieldOptions,
  LinkFilterConfig,
  LinkFilterItem,
  LinkCellValue,
  FieldOptions,
  FieldMeta,
} from './types/field.js'

export {
  FIELD_CELL_VALUE_TYPE,
  FIELD_IS_MULTIPLE_CELL_VALUE,
  OUT_OF_BAND_MANAGED_FIELD_TYPES,
  isOutOfBandManagedField,
  ALL_FIELD_TYPES,
  FIELD_TYPE_ALIASES,
  isMultiValueLink,
  isValidFieldType,
  getCellValueType,
  getIsMultipleCellValue,
  normalizeFieldType,
  normalizeSelectChoices,
} from './types/field.js'

export type { SelectChoice } from './types/field.js'

export * from './types/constants.js'

// ── Field Type Validation ──
export type { FieldTypeHandler } from './field-types/index.js'
export {
  FIELD_TYPE_HANDLERS,
  validateFieldValue,
  formatFieldValue,
  parsePercentInputToRatio,
} from './field-types/index.js'

// ── Filter ──
export type { FilterItem, FilterSet, RecordData, FieldResolver } from './filter/index.js'
export {
  isFilterSet,
  evaluateOperator,
  recordMatchesFilter,
  filterRecords,
} from './filter/index.js'

// ── Sort ──
export type { SortConfig } from './sort/index.js'
export { sortRecords } from './sort/index.js'

// ── Aggregation ──
export type { AggregationFunction } from './aggregation/index.js'
export {
  aggregate,
  SUPPORTED_AGGREGATION_FUNCTIONS,
} from './aggregation/index.js'

// ── Specification ──
export type { ISpecification, ISpecVisitor } from './specs/base.js'
export {
  AbstractSpec,
  AndSpec,
  OrSpec,
  NotSpec,
  TrueSpec,
  FalseSpec,
} from './specs/base.js'

export type { IRecordSpecVisitor } from './specs/record/record-specs.js'
export {
  FieldEqualsSpec,
  FieldNotEqualsSpec,
  FieldContainsSpec,
  FieldNotContainsSpec,
  FieldStartsWithSpec,
  FieldEndsWithSpec,
  FieldIsEmptySpec,
  FieldIsNotEmptySpec,
  FieldGreaterThanSpec,
  FieldLessThanSpec,
  FieldGteSpec,
  FieldLteSpec,
  FieldInSpec,
  FieldNotInSpec,
  FieldHasAnyOfSpec,
  FieldHasAllOfSpec,
  FieldHasNoneOfSpec,
  FieldIsExactlySpec,
} from './specs/record/record-specs.js'

export { buildRecordSpec } from './specs/record/builder.js'

export { memoryFilter } from './specs/visitors/memory-filter.js'
export type { WhereNode } from './specs/visitors/kysely-where.js'
export { specToWhereNode } from './specs/visitors/kysely-where.js'
export type { DjangoQNode } from './specs/visitors/django-q.js'
export { specToDjangoQ } from './specs/visitors/django-q.js'

// ── Ports ──
export type {
  CommandResult,
  CommandError,
  OutboxChangeEnvelope,
  ITableSyncService,
  ITableRecordRepository,
  ITableRecordQueryRepository,
  IUnitOfWork,
  IChangeOutbox,
  IFieldResolver,
  SyncDelta,
  SyncRecordChange,
  SyncFieldChange,
  SyncChange,
  SyncPushOptions,
  RecordPersistInput,
  BatchRecordPersistInput,
  BatchRecordDeleteInput,
  OutboxStats,
  TableSchema,
  TableFieldSchema,
  FieldColumnMap,
  RemoteApiClient,
  ILocalDb,
  FieldSchema,
  CreateRecordInput,
  UpdateRecordInput,
  DeleteRecordInput,
  BatchCreateRecordsInput,
  BatchUpdateRecordsInput,
  BatchDeleteRecordsInput,
  CreateTableInput,
  UpdateTableInput,
  ITableRepository,
  TableSnapshot,
  FieldSnapshot,
  CreateFieldInput,
  UpdateFieldInput,
  DeleteFieldInput,
  IFieldRepository,
  IEventBus,
  DomainEventLike,
  ViewType,
  ViewColumnMeta,
  ViewColumnMetaCarrier,
  ViewSnapshot,
  CreateViewInput,
  UpdateViewInput,
  IViewRepository,
} from './ports/index.js'
export { NoopUnitOfWork, NoopEventBus, getViewColumnMeta } from './ports/index.js'

// ── Commands ──
export type {
  DomainEvent,
  CellMutation,
  SetCellMutation,
  UnsetCellMutation,
  BatchSetCellMutation,
  RecordMutationSpec,
  ICommandExecutor,
  ExecutorContext,
} from './commands/index.js'
export {
  generateRecordId,
  generateChangeId,
  generateEventId,
  buildSetMutation,
  buildUnsetMutation,
  buildBatchSetMutation,
  buildRecordMutationSpec,
  buildRecordMutationSpecFromChanges,
  buildEmptyRecordMutationSpec,
  recordMutationToData,
  validateRecord,
  validateBatch,
  BaseExecutor,
  EventEmittingExecutor,
  DryRunExecutor,
  RemoteExecutor,
  LocalExecutor,
} from './commands/index.js'

// ── Domain ──
export type {
  DomainEventBase,
  RecordValueChange,
  RecordAggregateSnapshot,
  RecordAggregateEventMeta,
  RecordAggregateDecision,
  TableEventBase,
  TableStatus,
  TableCreatedEvent,
  TableUpdatedEvent,
  TableDeletedEvent,
  TableArchivedEvent,
  TableRestoredEvent,
  TableDomainEvent,
  TableAggregateSnapshot,
  TableAggregateEventMeta,
  TableAggregateDecision,
  FieldEventBase,
  FieldCreatedEvent,
  FieldUpdatedEvent,
  FieldDeletedEvent,
  FieldDomainEvent,
  FieldAggregateSnapshot,
  FieldAggregateEventMeta,
  FieldAggregateDecision,
  AllDomainEvent,
  ViewEventBase,
  ViewCreatedEvent,
  ViewUpdatedEvent,
  ViewDeletedEvent,
  ViewDomainEvent,
  ViewAggregateSnapshot,
  ViewAggregateEventMeta,
  ViewAggregateDecision,
} from './domain/index.js'
export {
  RecordAggregate,
  RecordAggregateError,
  diffRecordData,
  createRecordCreatedEvent,
  createRecordUpdatedEvent,
  createRecordDeletedEvent,
  createRecordsBatchCreatedEvent,
  createRecordsBatchUpdatedEvent,
  createRecordsBatchDeletedEvent,
  TableAggregate,
  TableAggregateError,
  generateTableId,
  FieldAggregate,
  FieldAggregateError,
  generateFieldId,
  ViewAggregate,
  ViewAggregateError,
  generateViewId,
} from './domain/index.js'

// ── Application ──
export type { RecordWriteFlowDeps, RecordWriteFlowOutput } from './application/index.js'
export { RecordWriteFlow } from './application/index.js'
export type { FieldWriteFlowDeps, FieldWriteFlowOutput } from './application/index.js'
export { FieldWriteFlow } from './application/index.js'
export type { TableWriteFlowDeps, TableWriteFlowOutput } from './application/index.js'
export { TableWriteFlow } from './application/index.js'
export type { ViewWriteFlowDeps, ViewWriteFlowOutput } from './application/index.js'
export { ViewWriteFlow } from './application/index.js'

// ── Adapters ──
export type { ExternalFilterItem, ExternalFilterSet, ExternalViewSort } from './adapters/index.js'
export {
  snakeToCamelKey,
  camelToSnakeKey,
  snakeToCamelObject,
  camelToSnakeObject,
  externalFilterToKernel,
  kernelFilterToExternal,
  externalSortToKernel,
  externalSortsToKernel,
  kernelSortToExternal,
  kernelSortsToExternal,
  buildFieldColumnMap,
  invertFieldColumnMap,
  translateColumnName,
  translateFieldId,
} from './adapters/index.js'

export {
  LocalRecordRepository,
  RemoteRecordRepository,
} from './adapters/record/index.js'

export {
  RemoteFieldRepository,
} from './adapters/field/index.js'

export {
  RemoteTableRepository,
} from './adapters/table/index.js'

export {
  RemoteViewRepository,
} from './adapters/view/index.js'

// ── Orchestration ──
export type {
  FieldOrchestrationDeps,
  FieldOrchestrationResult,
  TableOrchestrationDeps,
  TableOrchestrationResult,
  ViewOrchestrationDeps,
  ViewOrchestrationResult,
} from './orchestration/index.js'
export {
  FieldOrchestrator,
  TableOrchestrator,
  ViewOrchestrator,
} from './orchestration/index.js'
