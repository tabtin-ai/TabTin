export interface DomainEventBase {
  eventId: string
  occurredAt: string
  tableId: string
  aggregateVersion: number
}

export interface RecordValueChange {
  old: unknown
  new: unknown
}

export interface RecordCreatedEvent extends DomainEventBase {
  type: 'record.created'
  recordId: string
  data: Record<string, unknown>
  after: Record<string, unknown>
}

export interface RecordUpdatedEvent extends DomainEventBase {
  type: 'record.updated'
  recordId: string
  before: Record<string, unknown>
  after: Record<string, unknown>
  changes: Record<string, RecordValueChange>
}

export interface RecordDeletedEvent extends DomainEventBase {
  type: 'record.deleted'
  recordId: string
  before: Record<string, unknown> | null
}

export interface RecordsBatchCreatedEvent extends DomainEventBase {
  type: 'records.batch_created'
  recordIds: string[]
  recordsData: Array<Record<string, unknown>>
  records: Array<{ recordId: string; after: Record<string, unknown> }>
  count: number
}

export interface RecordsBatchUpdatedEvent extends DomainEventBase {
  type: 'records.batch_updated'
  recordIds: string[]
  recordsData: Array<{ id: string; data: Record<string, unknown> }>
  records: Array<{
    recordId: string
    before: Record<string, unknown>
    after: Record<string, unknown>
    changes: Record<string, RecordValueChange>
  }>
  count: number
}

export interface RecordsBatchDeletedEvent extends DomainEventBase {
  type: 'records.batch_deleted'
  recordIds: string[]
  records: Array<{ recordId: string; before: Record<string, unknown> | null }>
  count: number
}

export type DomainEvent =
  | RecordCreatedEvent
  | RecordUpdatedEvent
  | RecordDeletedEvent
  | RecordsBatchCreatedEvent
  | RecordsBatchUpdatedEvent
  | RecordsBatchDeletedEvent

interface EventMetaInput {
  eventId: string
  occurredAt: string
  tableId: string
  aggregateVersion: number
}

export function createRecordCreatedEvent(
  input: EventMetaInput & {
    recordId: string
    after: Record<string, unknown>
  },
): RecordCreatedEvent {
  const after = cloneRecordData(input.after)
  return {
    type: 'record.created',
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    tableId: input.tableId,
    aggregateVersion: input.aggregateVersion,
    recordId: input.recordId,
    data: after,
    after,
  }
}

export function createRecordUpdatedEvent(
  input: EventMetaInput & {
    recordId: string
    before: Record<string, unknown>
    after: Record<string, unknown>
    changes: Record<string, RecordValueChange>
  },
): RecordUpdatedEvent {
  return {
    type: 'record.updated',
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    tableId: input.tableId,
    aggregateVersion: input.aggregateVersion,
    recordId: input.recordId,
    before: cloneRecordData(input.before),
    after: cloneRecordData(input.after),
    changes: cloneChanges(input.changes),
  }
}

export function createRecordDeletedEvent(
  input: EventMetaInput & {
    recordId: string
    before: Record<string, unknown> | null
  },
): RecordDeletedEvent {
  return {
    type: 'record.deleted',
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    tableId: input.tableId,
    aggregateVersion: input.aggregateVersion,
    recordId: input.recordId,
    before: input.before ? cloneRecordData(input.before) : null,
  }
}

export function createRecordsBatchCreatedEvent(
  input: EventMetaInput & {
    records: Array<{ recordId: string; after: Record<string, unknown> }>
  },
): RecordsBatchCreatedEvent {
  const records = input.records.map((record) => ({
    recordId: record.recordId,
    after: cloneRecordData(record.after),
  }))
  return {
    type: 'records.batch_created',
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    tableId: input.tableId,
    aggregateVersion: input.aggregateVersion,
    recordIds: records.map((record) => record.recordId),
    recordsData: records.map((record) => cloneRecordData(record.after)),
    records,
    count: records.length,
  }
}

export function createRecordsBatchUpdatedEvent(
  input: EventMetaInput & {
    records: Array<{
      recordId: string
      before: Record<string, unknown>
      after: Record<string, unknown>
      changes: Record<string, RecordValueChange>
    }>
  },
): RecordsBatchUpdatedEvent {
  const records = input.records.map((record) => ({
    recordId: record.recordId,
    before: cloneRecordData(record.before),
    after: cloneRecordData(record.after),
    changes: cloneChanges(record.changes),
  }))
  return {
    type: 'records.batch_updated',
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    tableId: input.tableId,
    aggregateVersion: input.aggregateVersion,
    recordIds: records.map((record) => record.recordId),
    recordsData: records.map((record) => ({
      id: record.recordId,
      data: cloneRecordData(record.after),
    })),
    records,
    count: records.length,
  }
}

export function createRecordsBatchDeletedEvent(
  input: EventMetaInput & {
    records: Array<{ recordId: string; before: Record<string, unknown> | null }>
  },
): RecordsBatchDeletedEvent {
  const records = input.records.map((record) => ({
    recordId: record.recordId,
    before: record.before ? cloneRecordData(record.before) : null,
  }))
  return {
    type: 'records.batch_deleted',
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    tableId: input.tableId,
    aggregateVersion: input.aggregateVersion,
    recordIds: records.map((record) => record.recordId),
    records,
    count: records.length,
  }
}

function cloneRecordData(data: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(data)
}

function cloneChanges(
  changes: Record<string, RecordValueChange>,
): Record<string, RecordValueChange> {
  return structuredClone(changes)
}
