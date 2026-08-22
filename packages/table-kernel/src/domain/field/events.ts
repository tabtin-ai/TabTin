import type { FieldDefaultValue, FieldType, FieldOptions } from '../../types/field.js'

export interface FieldEventBase {
  eventId: string
  occurredAt: string
  tableId: string
}

export interface FieldCreatedEvent extends FieldEventBase {
  type: 'field.created'
  fieldId: string
  name: string
  fieldType: FieldType
  defaultValue: FieldDefaultValue | null
  options?: FieldOptions
}

export interface FieldUpdatedEvent extends FieldEventBase {
  type: 'field.updated'
  fieldId: string
  changes: Partial<{
    name: string
    options: FieldOptions
    defaultValue: FieldDefaultValue | null
  }>
}

export interface FieldDeletedEvent extends FieldEventBase {
  type: 'field.deleted'
  fieldId: string
}

export type FieldDomainEvent =
  | FieldCreatedEvent
  | FieldUpdatedEvent
  | FieldDeletedEvent
