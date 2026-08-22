import type {
  TableCreatedEvent,
  TableUpdatedEvent,
  TableDeletedEvent,
  TableArchivedEvent,
  TableRestoredEvent,
  TableEventBase,
} from './events.js'
import type { TableSnapshot } from '../../ports/index.js'
import { ErrorCodes, type ErrorCode } from '../../errors.js'
import { generateTableId } from './id.js'

export type TableAggregateSnapshot = TableSnapshot

export interface TableAggregateEventMeta {
  eventId: string
  occurredAt: string
}

export interface TableAggregateDecision<TEvent extends TableEventBase = TableEventBase> {
  before: TableAggregateSnapshot | null
  after: TableAggregateSnapshot | null
  event: TEvent
}

export class TableAggregateError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export class TableAggregate {
  private constructor(
    readonly tableId: string,
    private readonly snapshot: TableAggregateSnapshot | null,
    private readonly exists: boolean,
  ) {}

  static createNew(): TableAggregate {
    return new TableAggregate(generateTableId(), null, false)
  }

  static rehydrate(snapshot: TableAggregateSnapshot): TableAggregate {
    return new TableAggregate(snapshot.tableId, snapshot, true)
  }

  create(
    input: { name: string; description?: string; icon?: string },
    meta: TableAggregateEventMeta,
  ): TableAggregateDecision<TableCreatedEvent> {
    if (this.exists) {
      throw new TableAggregateError(ErrorCodes.ALREADY_EXISTS, `Table "${this.tableId}" already exists`)
    }
    const afterSnapshot: TableAggregateSnapshot = {
      tableId: this.tableId,
      name: input.name,
      description: input.description,
      icon: input.icon,
      status: 'active',
    }
    return {
      before: null,
      after: afterSnapshot,
      event: {
        type: 'table.created',
        eventId: meta.eventId,
        occurredAt: meta.occurredAt,
        tableId: this.tableId,
        name: input.name,
      },
    }
  }

  update(
    changes: Partial<{ name: string; description: string; icon: string }>,
    meta: TableAggregateEventMeta,
  ): TableAggregateDecision<TableUpdatedEvent> | null {
    if (!this.exists) {
      throw new TableAggregateError(ErrorCodes.NOT_FOUND, `Table "${this.tableId}" not found`)
    }
    const effectiveChanges: typeof changes = {}
    if (changes.name !== undefined && changes.name !== this.snapshot?.name) {
      effectiveChanges.name = changes.name
    }
    if (changes.description !== undefined && changes.description !== this.snapshot?.description) {
      effectiveChanges.description = changes.description
    }
    if (changes.icon !== undefined && changes.icon !== this.snapshot?.icon) {
      effectiveChanges.icon = changes.icon
    }
    if (Object.keys(effectiveChanges).length === 0) return null
    const before = this.snapshot ? { ...this.snapshot } : null
    const after: TableAggregateSnapshot = {
      ...this.snapshot!,
      ...(effectiveChanges.name !== undefined ? { name: effectiveChanges.name } : {}),
      ...(effectiveChanges.description !== undefined ? { description: effectiveChanges.description } : {}),
      ...(effectiveChanges.icon !== undefined ? { icon: effectiveChanges.icon } : {}),
    }
    return {
      before,
      after,
      event: {
        type: 'table.updated',
        eventId: meta.eventId,
        occurredAt: meta.occurredAt,
        tableId: this.tableId,
        changes: effectiveChanges,
      },
    }
  }

  delete(meta: TableAggregateEventMeta): TableAggregateDecision<TableDeletedEvent> {
    if (!this.exists) {
      throw new TableAggregateError(ErrorCodes.NOT_FOUND, `Table "${this.tableId}" not found`)
    }
    return {
      before: this.snapshot ? { ...this.snapshot } : null,
      after: null,
      event: {
        type: 'table.deleted',
        eventId: meta.eventId,
        occurredAt: meta.occurredAt,
        tableId: this.tableId,
      },
    }
  }

  archive(meta: TableAggregateEventMeta): TableAggregateDecision<TableArchivedEvent> {
    if (!this.exists) {
      throw new TableAggregateError(ErrorCodes.NOT_FOUND, `Table "${this.tableId}" not found`)
    }
    if (this.snapshot?.status === 'archived') {
      throw new TableAggregateError(ErrorCodes.VALIDATION_INVALID_TYPE, `Table "${this.tableId}" is already archived`)
    }
    const before = this.snapshot ? { ...this.snapshot } : null
    const after: TableAggregateSnapshot = { ...this.snapshot!, status: 'archived' }
    return {
      before,
      after,
      event: {
        type: 'table.archived',
        eventId: meta.eventId,
        occurredAt: meta.occurredAt,
        tableId: this.tableId,
      },
    }
  }

  restore(meta: TableAggregateEventMeta): TableAggregateDecision<TableRestoredEvent> {
    if (!this.exists) {
      throw new TableAggregateError(ErrorCodes.NOT_FOUND, `Table "${this.tableId}" not found`)
    }
    if (this.snapshot?.status !== 'archived') {
      throw new TableAggregateError(ErrorCodes.VALIDATION_INVALID_TYPE, `Table "${this.tableId}" is not archived`)
    }
    const before = this.snapshot ? { ...this.snapshot } : null
    const after: TableAggregateSnapshot = { ...this.snapshot!, status: 'active' }
    return {
      before,
      after,
      event: {
        type: 'table.restored',
        eventId: meta.eventId,
        occurredAt: meta.occurredAt,
        tableId: this.tableId,
      },
    }
  }
}
