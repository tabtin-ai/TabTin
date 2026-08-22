import type { FieldDefaultValue, FieldType, FieldOptions } from '../../types/field.js'
import type { FieldSnapshot } from '../../ports/index.js'
import type { FieldCreatedEvent, FieldUpdatedEvent, FieldDeletedEvent, FieldEventBase } from './events.js'
import { ErrorCodes, type ErrorCode } from '../../errors.js'
import { generateFieldId } from './id.js'

export type FieldAggregateSnapshot = FieldSnapshot

export interface FieldAggregateEventMeta {
  eventId: string
  occurredAt: string
}

export interface FieldAggregateDecision<TEvent extends FieldEventBase = FieldEventBase> {
  before: FieldAggregateSnapshot | null
  after: FieldAggregateSnapshot | null
  event: TEvent
}

export class FieldAggregateError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export class FieldAggregate {
  private constructor(
    readonly tableId: string,
    readonly fieldId: string,
    private readonly snapshot: FieldAggregateSnapshot | null,
    private readonly exists: boolean,
  ) {}

  static createNew(tableId: string): FieldAggregate {
    return new FieldAggregate(tableId, generateFieldId(), null, false)
  }

  static rehydrate(snapshot: FieldAggregateSnapshot): FieldAggregate {
    return new FieldAggregate(snapshot.tableId, snapshot.fieldId, snapshot, true)
  }

  create(
    input: {
      name: string
      fieldType: FieldType
      isPrimary?: boolean
      defaultValue?: FieldDefaultValue | null
      options?: FieldOptions
    },
    meta: FieldAggregateEventMeta,
  ): FieldAggregateDecision<FieldCreatedEvent> {
    if (this.exists) {
      throw new FieldAggregateError(ErrorCodes.ALREADY_EXISTS, `Field "${this.fieldId}" already exists`)
    }
    const afterSnapshot: FieldAggregateSnapshot = {
      tableId: this.tableId,
      fieldId: this.fieldId,
      name: input.name,
      fieldType: input.fieldType,
      isPrimary: input.isPrimary ?? false,
      defaultValue: input.defaultValue ?? null,
      options: input.options,
    }
    return {
      before: null,
      after: afterSnapshot,
      event: {
        type: 'field.created',
        eventId: meta.eventId,
        occurredAt: meta.occurredAt,
        tableId: this.tableId,
        fieldId: this.fieldId,
        name: input.name,
        fieldType: input.fieldType,
        defaultValue: input.defaultValue ?? null,
        options: input.options,
      },
    }
  }

  update(
    changes: Partial<{
      name: string
      options: FieldOptions
      defaultValue: FieldDefaultValue | null
    }>,
    meta: FieldAggregateEventMeta,
  ): FieldAggregateDecision<FieldUpdatedEvent> | null {
    if (!this.exists) {
      throw new FieldAggregateError(ErrorCodes.NOT_FOUND, `Field "${this.fieldId}" not found`)
    }
    const effectiveChanges: typeof changes = {}
    if (changes.name !== undefined && changes.name !== this.snapshot?.name) {
      effectiveChanges.name = changes.name
    }
    if (changes.options !== undefined) {
      effectiveChanges.options = changes.options
    }
    if (changes.defaultValue !== undefined && changes.defaultValue !== this.snapshot?.defaultValue) {
      effectiveChanges.defaultValue = changes.defaultValue
    }
    if (Object.keys(effectiveChanges).length === 0) return null
    const before = this.snapshot ? { ...this.snapshot } : null
    const after: FieldAggregateSnapshot = {
      ...this.snapshot!,
      ...(effectiveChanges.name !== undefined ? { name: effectiveChanges.name } : {}),
      ...(effectiveChanges.options !== undefined ? { options: effectiveChanges.options } : {}),
      ...(effectiveChanges.defaultValue !== undefined ? { defaultValue: effectiveChanges.defaultValue } : {}),
    }
    return {
      before,
      after,
      event: {
        type: 'field.updated',
        eventId: meta.eventId,
        occurredAt: meta.occurredAt,
        tableId: this.tableId,
        fieldId: this.fieldId,
        changes: effectiveChanges,
      },
    }
  }

  delete(meta: FieldAggregateEventMeta): FieldAggregateDecision<FieldDeletedEvent> {
    if (!this.exists) {
      throw new FieldAggregateError(ErrorCodes.NOT_FOUND, `Field "${this.fieldId}" not found`)
    }
    if (this.snapshot?.isPrimary) {
      throw new FieldAggregateError(ErrorCodes.VALIDATION_INVALID_TYPE, 'Cannot delete primary field')
    }
    return {
      before: this.snapshot ? { ...this.snapshot } : null,
      after: null,
      event: {
        type: 'field.deleted',
        eventId: meta.eventId,
        occurredAt: meta.occurredAt,
        tableId: this.tableId,
        fieldId: this.fieldId,
      },
    }
  }
}
