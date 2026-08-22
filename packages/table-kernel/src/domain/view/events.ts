import type { ViewType } from '../../ports/index.js'

export interface ViewEventBase {
  type: string
  eventId: string
  occurredAt: string
  tableId: string
  viewId: string
}

export interface ViewCreatedEvent extends ViewEventBase {
  type: 'view.created'
  name: string
  viewType: ViewType
}

export interface ViewUpdatedEvent extends ViewEventBase {
  type: 'view.updated'
  changes: Record<string, unknown>
}

export interface ViewDeletedEvent extends ViewEventBase {
  type: 'view.deleted'
}

export type ViewDomainEvent =
  | ViewCreatedEvent
  | ViewUpdatedEvent
  | ViewDeletedEvent
