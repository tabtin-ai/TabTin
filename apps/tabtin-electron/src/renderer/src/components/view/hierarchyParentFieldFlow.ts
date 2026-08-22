/**
 * 层级「创建父记录字段」编排：创建 → 刷新字段 → 激活视图配置。
 * 与 UI 解耦，便于单测覆盖成功 / 激活失败可恢复路径。
 */

export type ParentFieldPayload = {
  id: string
  name: string
  field_type: string
  config: Record<string, unknown>
}

export type CreateAndActivateParentFieldDeps = {
  tableId: string
  createParentField: (tableId: string) => Promise<ParentFieldPayload>
  loadFields: (tableId: string) => Promise<void>
  activateParentField: (fieldId: string) => Promise<boolean>
  /** 创建后等待字段进入本地 fields（协作映射就绪），避免立刻拖入建子记录失败 */
  waitUntilFieldReady?: (tableId: string, fieldId: string) => Promise<boolean>
  /** 可选诊断日志（字段 id / 等待耗时 / 结果） */
  log?: (message: string, meta?: Record<string, unknown>) => void
}

export type CreateAndActivateParentFieldResult =
  | { status: 'activated'; field: ParentFieldPayload }
  | { status: 'created_not_activated'; field: ParentFieldPayload }
  | { status: 'failed'; error: unknown }

export async function createAndActivateParentField(
  deps: CreateAndActivateParentFieldDeps,
): Promise<CreateAndActivateParentFieldResult> {
  let field: ParentFieldPayload | null = null
  try {
    field = await deps.createParentField(deps.tableId)
    if (!field?.id) {
      return { status: 'failed', error: new Error('empty parent field') }
    }
    deps.log?.('parent field created', { tableId: deps.tableId, fieldId: field.id })
  } catch (error) {
    return { status: 'failed', error }
  }

  try {
    await deps.loadFields(deps.tableId)
    if (deps.waitUntilFieldReady) {
      const waitStartedAt = Date.now()
      const ready = await deps.waitUntilFieldReady(deps.tableId, field.id)
      const waitMs = Date.now() - waitStartedAt
      deps.log?.('waitUntilFieldReady finished', {
        tableId: deps.tableId,
        fieldId: field.id,
        ready,
        waitMs,
      })
      if (!ready) {
        // 字段已落库但本地 store 未见到：勿强行激活，交给用户手动选择
        return { status: 'created_not_activated', field }
      }
    }
    const activated = await deps.activateParentField(field.id)
    deps.log?.('activate parent field finished', {
      tableId: deps.tableId,
      fieldId: field.id,
      activated,
    })
    if (activated) {
      return { status: 'activated', field }
    }
    return { status: 'created_not_activated', field }
  } catch {
    // 字段已落库：刷新/激活失败保留字段，提示用户手动选择
    return { status: 'created_not_activated', field }
  }
}
