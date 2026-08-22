export interface TableEventBase {
  eventId: string
  occurredAt: string
  tableId: string
}

export type TableStatus = 'active' | 'archived'

export interface TableCreatedEvent extends TableEventBase {
  type: 'table.created'
  name: string
}

export interface TableUpdatedEvent extends TableEventBase {
  type: 'table.updated'
  changes: Partial<{ name: string; description: string }>
}

export interface TableDeletedEvent extends TableEventBase {
  type: 'table.deleted'
}

export interface TableArchivedEvent extends TableEventBase {
  type: 'table.archived'
}

export interface TableRestoredEvent extends TableEventBase {
  type: 'table.restored'
}

export type TableDomainEvent =
  | TableCreatedEvent
  | TableUpdatedEvent
  | TableDeletedEvent
  | TableArchivedEvent
  | TableRestoredEvent
