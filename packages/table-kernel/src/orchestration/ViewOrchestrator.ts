import type {
  CommandResult,
  IViewRepository,
  IFieldRepository,
  IUnitOfWork,
  IEventBus,
  CreateViewInput,
} from '../ports/index.js'
import { getViewColumnMeta } from '../ports/index.js'
import { ViewWriteFlow } from '../application/view/ViewWriteFlow.js'

export interface ViewOrchestrationDeps {
  viewRepository: IViewRepository
  fieldRepository?: IFieldRepository
  unitOfWork: IUnitOfWork
  eventBus?: IEventBus
  eventIdFactory?: () => string
  now?: () => Date
  viewWriteFlow?: ViewWriteFlow
}

export interface ViewOrchestrationResult<T = unknown> {
  result: CommandResult<T>
  autoPopulated: boolean
}

/**
 * Orchestrates View creation with cross-domain auto-population.
 *
 * Mirrors Django view_service.py create_view behavior:
 * - If visibleFields is not provided, auto-populate from table's field list
 * - If fieldOrder is not provided, auto-populate from table's field list
 */
export class ViewOrchestrator {
  private readonly viewFlow: ViewWriteFlow

  constructor(private readonly deps: ViewOrchestrationDeps) {
    this.viewFlow = deps.viewWriteFlow ?? new ViewWriteFlow({
      viewRepository: deps.viewRepository,
      unitOfWork: deps.unitOfWork,
      eventBus: deps.eventBus,
      eventIdFactory: deps.eventIdFactory,
      now: deps.now,
    })
  }

  async createViewWithAutoPopulate(
    input: CreateViewInput,
  ): Promise<ViewOrchestrationResult<{ viewId: string }>> {
    let autoPopulated = false
    const populatedInput = { ...input }

    const needsVisibleFields = !input.visibleFields || input.visibleFields.length === 0
    const needsFieldOrder = !input.fieldOrder || input.fieldOrder.length === 0
    const currentColumnMeta = getViewColumnMeta(input)
    const needsColumnMeta = !currentColumnMeta || Object.keys(currentColumnMeta).length === 0

    if ((needsVisibleFields || needsFieldOrder || needsColumnMeta) && this.deps.fieldRepository?.listFieldsByTable) {
      try {
        const fields = await this.deps.fieldRepository.listFieldsByTable(input.tableId)
        const fieldIds = fields.map((f) => f.fieldId)
        if (fieldIds.length > 0) {
          if (needsVisibleFields) {
            populatedInput.visibleFields = fieldIds
            autoPopulated = true
          }
          if (needsFieldOrder) {
            populatedInput.fieldOrder = fieldIds
            autoPopulated = true
          }
          if (needsColumnMeta) {
            populatedInput.column_meta = buildDefaultColumnMeta(fieldIds)
            autoPopulated = true
          }
        }
      } catch { /* proceed without auto-population */ }
    }

    const viewOut = await this.viewFlow.createView(populatedInput)
    return { result: viewOut.result, autoPopulated }
  }
}

function buildDefaultColumnMeta(
  fieldIds: string[],
): Record<string, Record<string, unknown>> {
  const meta: Record<string, Record<string, unknown>> = {}
  for (let i = 0; i < fieldIds.length; i++) {
    meta[fieldIds[i]] = { order: i }
  }
  return meta
}
