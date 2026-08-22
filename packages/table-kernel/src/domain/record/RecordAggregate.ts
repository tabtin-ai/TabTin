import {
  buildEmptyRecordMutationSpec,
  buildRecordMutationSpec,
  buildRecordMutationSpecFromChanges,
  type RecordMutationSpec,
} from './mutation-spec.js'
import {
  createRecordCreatedEvent,
  createRecordDeletedEvent,
  createRecordUpdatedEvent,
  type DomainEvent,
  type RecordCreatedEvent,
  type RecordDeletedEvent,
  type RecordUpdatedEvent,
  type RecordValueChange,
} from './events.js'
import { ErrorCodes, type ErrorCode } from '../../errors.js'

export interface RecordAggregateEventMeta {
  eventId: string
  occurredAt: string
}

export interface RecordAggregateSnapshot {
  tableId: string
  recordId: string
  data?: Record<string, unknown> | null
  exists?: boolean
  version?: number
}

export interface RecordAggregateDecision<TEvent extends DomainEvent = DomainEvent> {
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  mutation: RecordMutationSpec
  event: TEvent
}

export class RecordAggregateError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export class RecordAggregate {
  private version: number

  private constructor(
    readonly tableId: string,
    readonly recordId: string,
    private readonly exists: boolean,
    private readonly snapshotData: Record<string, unknown> | null,
    version: number,
  ) {
    this.version = version
  }

  get currentVersion(): number {
    return this.version
  }

  static createNew(tableId: string, recordId: string): RecordAggregate {
    return new RecordAggregate(tableId, recordId, false, null, 0)
  }

  static rehydrate(snapshot: RecordAggregateSnapshot): RecordAggregate {
    return new RecordAggregate(
      snapshot.tableId,
      snapshot.recordId,
      snapshot.exists ?? snapshot.data != null,
      snapshot.data ? cloneRecordData(snapshot.data) : null,
      snapshot.version ?? 0,
    )
  }

  static assumeExists(
    tableId: string,
    recordId: string,
    data: Record<string, unknown> = {},
  ): RecordAggregate {
    return new RecordAggregate(tableId, recordId, true, cloneRecordData(data), 0)
  }

  create(
    data: Record<string, unknown>,
    meta: RecordAggregateEventMeta,
  ): RecordAggregateDecision<RecordCreatedEvent> {
    if (this.exists) {
      throw new RecordAggregateError(
        ErrorCodes.ALREADY_EXISTS,
        `Record "${this.recordId}" already exists`,
      )
    }
    this.version++
    const after = cloneRecordData(data)
    return {
      before: null,
      after,
      mutation: buildRecordMutationSpec(this.tableId, this.recordId, after),
      event: createRecordCreatedEvent({
        eventId: meta.eventId,
        occurredAt: meta.occurredAt,
        tableId: this.tableId,
        aggregateVersion: this.version,
        recordId: this.recordId,
        after,
      }),
    }
  }

  update(
    patch: Record<string, unknown>,
    meta: RecordAggregateEventMeta,
  ): RecordAggregateDecision<RecordUpdatedEvent> | null {
    if (!this.exists) {
      throw new RecordAggregateError(
        ErrorCodes.NOT_FOUND,
        `Record "${this.recordId}" not found`,
      )
    }
    const before = cloneRecordData(this.snapshotData ?? {})
    const after = applyPatch(before, patch)
    const changes = diffRecordData(before, after)
    if (Object.keys(changes).length === 0) {
      return null
    }
    this.version++
    return {
      before,
      after,
      mutation: buildRecordMutationSpecFromChanges(this.tableId, this.recordId, changes),
      event: createRecordUpdatedEvent({
        eventId: meta.eventId,
        occurredAt: meta.occurredAt,
        tableId: this.tableId,
        aggregateVersion: this.version,
        recordId: this.recordId,
        before,
        after,
        changes,
      }),
    }
  }

  delete(
    meta: RecordAggregateEventMeta,
  ): RecordAggregateDecision<RecordDeletedEvent> {
    if (!this.exists) {
      throw new RecordAggregateError(
        ErrorCodes.NOT_FOUND,
        `Record "${this.recordId}" not found`,
      )
    }
    this.version++
    const before = this.snapshotData ? cloneRecordData(this.snapshotData) : null
    return {
      before,
      after: null,
      mutation: buildEmptyRecordMutationSpec(this.tableId, this.recordId),
      event: createRecordDeletedEvent({
        eventId: meta.eventId,
        occurredAt: meta.occurredAt,
        tableId: this.tableId,
        aggregateVersion: this.version,
        recordId: this.recordId,
        before,
      }),
    }
  }
}

export function diffRecordData(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, RecordValueChange> {
  const changes: Record<string, RecordValueChange> = {}
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    const oldValue = before[key]
    const newValue = after[key]
    if (isSameValue(oldValue, newValue)) continue
    changes[key] = { old: oldValue, new: newValue }
  }
  return changes
}

function applyPatch(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const after = cloneRecordData(before)
  for (const [fieldId, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete after[fieldId]
      continue
    }
    after[fieldId] = value
  }
  return after
}

function cloneRecordData(data: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(data)
}

function isSameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime()
  }
  if (isObjectLike(left) && isObjectLike(right)) {
    return safeStringify(left) === safeStringify(right)
  }
  return false
}

function isObjectLike(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
