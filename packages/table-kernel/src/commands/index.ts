export type {
  CommandResult,
  CommandError,
  FieldSchema,
  CreateRecordInput,
  UpdateRecordInput,
  DeleteRecordInput,
  BatchCreateRecordsInput,
  BatchUpdateRecordsInput,
  BatchDeleteRecordsInput,
  OutboxChangeEnvelope,
} from '../ports/index.js'

export type {
  DomainEvent,
  DomainEventBase,
  RecordValueChange,
  RecordCreatedEvent,
  RecordUpdatedEvent,
  RecordDeletedEvent,
  RecordsBatchCreatedEvent,
  RecordsBatchUpdatedEvent,
  RecordsBatchDeletedEvent,
} from '../domain/record/events.js'

export type {
  CellMutation,
  SetCellMutation,
  UnsetCellMutation,
  BatchSetCellMutation,
  RecordMutationSpec,
} from '../domain/record/mutation-spec.js'
export {
  buildSetMutation,
  buildUnsetMutation,
  buildBatchSetMutation,
  buildRecordMutationSpec,
  buildRecordMutationSpecFromChanges,
  buildEmptyRecordMutationSpec,
  recordMutationToData,
} from '../domain/record/mutation-spec.js'

export { generateRecordId, generateChangeId, generateEventId } from '../domain/record/id.js'

export { validateRecord, validateBatch } from '../application/record/validator.js'

export type { ICommandExecutor, ExecutorContext } from './executor.js'
export {
  BaseExecutor,
  EventEmittingExecutor,
  DryRunExecutor,
  RemoteExecutor,
  LocalExecutor,
} from './executor.js'
