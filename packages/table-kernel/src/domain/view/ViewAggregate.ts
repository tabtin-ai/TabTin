import type {
  ViewCreatedEvent,
  ViewUpdatedEvent,
  ViewDeletedEvent,
  ViewEventBase,
} from './events.js'
import {
  getViewColumnMeta,
  type ViewSnapshot,
  type ViewType,
  type ViewColumnMetaCarrier,
} from '../../ports/index.js'
import { ErrorCodes, type ErrorCode } from '../../errors.js'
import { generateViewId } from './id.js'

export type ViewAggregateSnapshot = ViewSnapshot

export interface ViewAggregateEventMeta {
  eventId: string
  occurredAt: string
}

export interface ViewAggregateDecision<TEvent extends ViewEventBase = ViewEventBase> {
  before: ViewAggregateSnapshot | null
  after: ViewAggregateSnapshot | null
  event: TEvent
}

export class ViewAggregateError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export class ViewAggregate {
  private constructor(
    readonly viewId: string,
    readonly tableId: string,
    private readonly snapshot: ViewAggregateSnapshot | null,
    private readonly exists: boolean,
  ) {}

  static createNew(tableId: string): ViewAggregate {
    return new ViewAggregate(generateViewId(), tableId, null, false)
  }

  static rehydrate(snapshot: ViewAggregateSnapshot): ViewAggregate {
    return new ViewAggregate(snapshot.viewId, snapshot.tableId, snapshot, true)
  }

  create(
    input: {
      name: string
      viewType: ViewType
      description?: string
      filter?: Record<string, unknown> | null
      sorts?: Array<Record<string, unknown>>
      visibleFields?: string[]
      fieldOrder?: string[]
      config?: Record<string, unknown>
    } & ViewColumnMetaCarrier,
    meta: ViewAggregateEventMeta,
  ): ViewAggregateDecision<ViewCreatedEvent> {
    if (this.exists) {
      throw new ViewAggregateError(ErrorCodes.ALREADY_EXISTS, `View "${this.viewId}" already exists`)
    }
    const afterSnapshot: ViewAggregateSnapshot = {
      viewId: this.viewId,
      tableId: this.tableId,
      name: input.name,
      viewType: input.viewType,
      description: input.description,
      filter: input.filter,
      sorts: input.sorts,
      visibleFields: input.visibleFields,
      fieldOrder: input.fieldOrder,
      column_meta: getViewColumnMeta(input),
      config: input.config,
    }
    return {
      before: null,
      after: afterSnapshot,
      event: {
        type: 'view.created',
        eventId: meta.eventId,
        occurredAt: meta.occurredAt,
        tableId: this.tableId,
        viewId: this.viewId,
        name: input.name,
        viewType: input.viewType,
      },
    }
  }

  update(
    changes: Partial<{
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
    }> & ViewColumnMetaCarrier,
    meta: ViewAggregateEventMeta,
  ): ViewAggregateDecision<ViewUpdatedEvent> | null {
    if (!this.exists) {
      throw new ViewAggregateError(ErrorCodes.NOT_FOUND, `View "${this.viewId}" not found`)
    }
    if (this.snapshot?.isLocked) {
      throw new ViewAggregateError(ErrorCodes.VALIDATION_INVALID_TYPE, `View "${this.viewId}" is locked`)
    }

    type ViewChanges = typeof changes
    const effectiveChanges: ViewChanges = {}
    if (changes.name !== undefined && changes.name !== this.snapshot?.name) {
      effectiveChanges.name = changes.name
    }
    if (changes.description !== undefined && changes.description !== this.snapshot?.description) {
      effectiveChanges.description = changes.description
    }
    if (changes.filter !== undefined) effectiveChanges.filter = changes.filter
    if (changes.sorts !== undefined) effectiveChanges.sorts = changes.sorts
    if (changes.groups !== undefined) effectiveChanges.groups = changes.groups
    if (changes.visibleFields !== undefined) effectiveChanges.visibleFields = changes.visibleFields
    if (changes.fieldOrder !== undefined) effectiveChanges.fieldOrder = changes.fieldOrder
    const nextColumnMeta = getViewColumnMeta(changes)
    if (nextColumnMeta !== undefined) effectiveChanges.column_meta = nextColumnMeta
    if (changes.config !== undefined) effectiveChanges.config = changes.config
    if (changes.isShared !== undefined && changes.isShared !== this.snapshot?.isShared) {
      effectiveChanges.isShared = changes.isShared
    }
    if (changes.isLocked !== undefined && changes.isLocked !== this.snapshot?.isLocked) {
      effectiveChanges.isLocked = changes.isLocked
    }

    const changeKeys = Object.keys(effectiveChanges) as (keyof ViewChanges)[]
    if (changeKeys.length === 0) return null

    const before = this.snapshot ? { ...this.snapshot } : null
    const after: ViewAggregateSnapshot = { ...this.snapshot! }
    for (const key of changeKeys) {
      if (effectiveChanges[key] !== undefined) {
        ;(after as unknown as Record<string, unknown>)[key] = effectiveChanges[key]
      }
    }

    return {
      before,
      after,
      event: {
        type: 'view.updated',
        eventId: meta.eventId,
        occurredAt: meta.occurredAt,
        tableId: this.tableId,
        viewId: this.viewId,
        changes: effectiveChanges as Record<string, unknown>,
      },
    }
  }

  delete(meta: ViewAggregateEventMeta): ViewAggregateDecision<ViewDeletedEvent> {
    if (!this.exists) {
      throw new ViewAggregateError(ErrorCodes.NOT_FOUND, `View "${this.viewId}" not found`)
    }
    return {
      before: this.snapshot ? { ...this.snapshot } : null,
      after: null,
      event: {
        type: 'view.deleted',
        eventId: meta.eventId,
        occurredAt: meta.occurredAt,
        tableId: this.tableId,
        viewId: this.viewId,
      },
    }
  }
}
