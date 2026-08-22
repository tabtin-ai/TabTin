import type {
  CommandResult,
  ITableRepository,
  IFieldRepository,
  IViewRepository,
  ITableRecordRepository,
  IUnitOfWork,
  IEventBus,
} from '../ports/index.js'
import { TableWriteFlow } from '../application/table/TableWriteFlow.js'

export interface TableOrchestrationDeps {
  tableRepository: ITableRepository
  fieldRepository?: IFieldRepository
  viewRepository?: IViewRepository
  recordRepository?: ITableRecordRepository
  unitOfWork: IUnitOfWork
  eventBus?: IEventBus
  eventIdFactory?: () => string
  now?: () => Date
  tableWriteFlow?: TableWriteFlow
}

export interface TableOrchestrationResult<T = unknown> {
  result: CommandResult<T>
  cascadeStats: {
    viewsDeleted: number
    fieldsDeleted: number
  }
}

/**
 * Orchestrates Table lifecycle with cross-domain cascading.
 *
 * In remote mode (Django backend), CASCADE is handled by ORM — this orchestrator
 * collects post-delete stats for event reporting.
 *
 * In local mode (PGlite), CASCADE may not be automatic — this orchestrator
 * explicitly deletes Views and Fields before deleting the Table.
 */
export class TableOrchestrator {
  private readonly tableFlow: TableWriteFlow

  constructor(private readonly deps: TableOrchestrationDeps) {
    this.tableFlow = deps.tableWriteFlow ?? new TableWriteFlow({
      tableRepository: deps.tableRepository,
      unitOfWork: deps.unitOfWork,
      eventBus: deps.eventBus,
      eventIdFactory: deps.eventIdFactory,
      now: deps.now,
    })
  }

  async deleteTableWithCascade(
    tableId: string,
    opts?: { localMode?: boolean },
  ): Promise<TableOrchestrationResult> {
    const stats = { viewsDeleted: 0, fieldsDeleted: 0 }

    if (opts?.localMode) {
      if (this.deps.viewRepository) {
        try {
          const views = await this.deps.viewRepository.listViewsByTable(tableId)
          for (const view of views) {
            const r = await this.deps.viewRepository.deleteView(view.viewId)
            if (r.success) stats.viewsDeleted++
          }
        } catch { /* best-effort */ }
      }

      if (this.deps.fieldRepository?.listFieldsByTable) {
        try {
          const fields = await this.deps.fieldRepository.listFieldsByTable(tableId)
          for (const field of fields) {
            const r = await this.deps.fieldRepository.deleteField({
              tableId,
              fieldId: field.fieldId,
            })
            if (r.success) stats.fieldsDeleted++
          }
        } catch { /* best-effort */ }
      }
    }

    const tableOut = await this.tableFlow.deleteTable(tableId)
    return { result: tableOut.result, cascadeStats: stats }
  }
}
