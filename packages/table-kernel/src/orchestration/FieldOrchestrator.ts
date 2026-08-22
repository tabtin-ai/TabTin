import type {
  CommandResult,
  IFieldRepository,
  IViewRepository,
  IUnitOfWork,
  IEventBus,
  CreateFieldInput,
  DeleteFieldInput,
  UpdateViewInput,
  ViewSnapshot,
} from '../ports/index.js'
import { getViewColumnMeta } from '../ports/index.js'
import { FieldWriteFlow } from '../application/field/FieldWriteFlow.js'

export interface FieldOrchestrationDeps {
  fieldRepository: IFieldRepository
  viewRepository: IViewRepository
  unitOfWork: IUnitOfWork
  eventBus?: IEventBus
  eventIdFactory?: () => string
  now?: () => Date
  fieldWriteFlow?: FieldWriteFlow
}

export interface FieldOrchestrationResult<T = unknown> {
  result: CommandResult<T>
  viewsUpdated: number
}

/**
 * Orchestrates Field operations with cross-domain side effects on Views.
 *
 * - createField  → append fieldId to all Views' visibleFields/fieldOrder
 * - deleteField  → remove  fieldId from all Views' visibleFields/fieldOrder
 */
export class FieldOrchestrator {
  private readonly fieldFlow: FieldWriteFlow

  constructor(private readonly deps: FieldOrchestrationDeps) {
    this.fieldFlow = deps.fieldWriteFlow ?? new FieldWriteFlow({
      fieldRepository: deps.fieldRepository,
      unitOfWork: deps.unitOfWork,
      eventBus: deps.eventBus,
      eventIdFactory: deps.eventIdFactory,
      now: deps.now,
    })
  }

  async createFieldAndSyncViews(
    input: CreateFieldInput,
  ): Promise<FieldOrchestrationResult<{ fieldId: string }>> {
    const fieldOut = await this.fieldFlow.createField(input)
    if (!fieldOut.result.success) {
      return { result: fieldOut.result, viewsUpdated: 0 }
    }

    const fieldId = fieldOut.result.data?.fieldId
    if (!fieldId) {
      return { result: fieldOut.result, viewsUpdated: 0 }
    }

    const viewsUpdated = await this.addFieldToViews(input.tableId, fieldId)
    return { result: fieldOut.result, viewsUpdated }
  }

  async deleteFieldAndCleanViews(
    input: DeleteFieldInput,
  ): Promise<FieldOrchestrationResult> {
    const viewsUpdated = await this.removeFieldFromViews(input.tableId, input.fieldId)

    const fieldOut = await this.fieldFlow.deleteField(input)
    return { result: fieldOut.result, viewsUpdated }
  }

  private async addFieldToViews(tableId: string, fieldId: string): Promise<number> {
    try {
      const views = await this.deps.viewRepository.listViewsByTable(tableId)
      const updates = this.buildAddFieldUpdates(views, fieldId)
      if (updates.length === 0) return 0
      await this.deps.viewRepository.batchUpdateViews(updates)
      return updates.length
    } catch {
      return 0
    }
  }

  private async removeFieldFromViews(tableId: string, fieldId: string): Promise<number> {
    try {
      const views = await this.deps.viewRepository.listViewsByTable(tableId)
      const updates = this.buildRemoveFieldUpdates(views, fieldId)
      if (updates.length === 0) return 0
      await this.deps.viewRepository.batchUpdateViews(updates)
      return updates.length
    } catch {
      return 0
    }
  }

  /** Mirrors Django _batch_add_fields_to_views */
  private buildAddFieldUpdates(views: ViewSnapshot[], fieldId: string): UpdateViewInput[] {
    const updates: UpdateViewInput[] = []
    for (const view of views) {
      const vf = view.visibleFields ?? []
      const fo = view.fieldOrder ?? []
      if (vf.length === 0) continue

      const changes: UpdateViewInput['changes'] = {}
      let changed = false

      if (!vf.includes(fieldId)) {
        changes.visibleFields = [...vf, fieldId]
        changed = true
      }
      if (fo.length > 0 && !fo.includes(fieldId)) {
        changes.fieldOrder = [...fo, fieldId]
        changed = true
      }

      const cm = getViewColumnMeta(view) ?? {}
      if (!cm[fieldId]) {
        const maxOrder = Object.keys(cm).length > 0
          ? Math.max(0, ...Object.values(cm).map((m) => {
              const o = (m as Record<string, unknown>)?.order
              return typeof o === 'number' ? o : 0
            }))
          : -1
        const viewType = String(view.viewType ?? '').toLowerCase()
        const useHidden = viewType === 'grid' || viewType === 'list' || viewType === 'plugin'
        const entry: Record<string, unknown> = { order: maxOrder + 1 }
        if (useHidden) {
          entry.hidden = false
        } else {
          entry.visible = true
        }
        changes.column_meta = { ...cm, [fieldId]: entry }
        changed = true
      }

      if (changed) {
        updates.push({ viewId: view.viewId, changes })
      }
    }
    return updates
  }

  /** Mirrors Django _remove_field_from_views */
  private buildRemoveFieldUpdates(views: ViewSnapshot[], fieldId: string): UpdateViewInput[] {
    const updates: UpdateViewInput[] = []
    for (const view of views) {
      const vf = view.visibleFields ?? []
      const fo = view.fieldOrder ?? []
      const cm = getViewColumnMeta(view) ?? {}
      const newVf = vf.filter((id) => id !== fieldId)
      const newFo = fo.filter((id) => id !== fieldId)
      const hasCmEntry = fieldId in cm

      if (newVf.length !== vf.length || newFo.length !== fo.length || hasCmEntry) {
        const changes: UpdateViewInput['changes'] = {
          visibleFields: newVf,
          fieldOrder: newFo,
        }
        if (hasCmEntry) {
          const { [fieldId]: _, ...restCm } = cm
          changes.column_meta = restCm
        }
        updates.push({ viewId: view.viewId, changes })
      }
    }
    return updates
  }
}
