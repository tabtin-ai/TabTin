import type { DomainEvent } from '../record/events.js'
import type { FieldDomainEvent } from '../field/events.js'
import type { TableDomainEvent } from '../table/events.js'
import type { ViewDomainEvent } from '../view/events.js'

export type AllDomainEvent = DomainEvent | FieldDomainEvent | TableDomainEvent | ViewDomainEvent
