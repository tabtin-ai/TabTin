export type {
  CellMutation,
  SetCellMutation,
  UnsetCellMutation,
  BatchSetCellMutation,
  RecordMutationSpec,
} from './mutation-spec.js'
export {
  buildSetMutation,
  buildUnsetMutation,
  buildBatchSetMutation,
  buildRecordMutationSpec,
  buildRecordMutationSpecFromChanges,
  buildEmptyRecordMutationSpec,
  recordMutationToData,
} from './mutation-spec.js'

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
} from './events.js'
export {
  createRecordCreatedEvent,
  createRecordUpdatedEvent,
  createRecordDeletedEvent,
  createRecordsBatchCreatedEvent,
  createRecordsBatchUpdatedEvent,
  createRecordsBatchDeletedEvent,
} from './events.js'

export type {
  RecordAggregateSnapshot,
  RecordAggregateEventMeta,
  RecordAggregateDecision,
} from './RecordAggregate.js'
export {
  RecordAggregate,
  RecordAggregateError,
  diffRecordData,
} from './RecordAggregate.js'

export {
  generateRecordId,
} from './id.js'
