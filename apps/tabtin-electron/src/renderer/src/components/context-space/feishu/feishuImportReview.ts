/**
 * 飞书导入审查步纯函数：合并 preview 闭包、切换依赖表勾选。
 */

export interface FeishuPreviewTable {
  app_token: string
  table_id: string
  name: string
  selected?: boolean
  auto_included?: boolean
}

export interface FeishuPreviewEdge {
  app_token: string
  from_table_id: string
  from_table_name: string
  field_name: string
  to_table_id: string
  to_table_name: string
  duplex?: boolean
  same_base?: boolean
}

export interface FeishuImportPreview {
  tables: FeishuPreviewTable[]
  edges: FeishuPreviewEdge[]
  warnings: string[]
  has_attachments?: boolean
}

export function tableKeyOf(appToken: string, tableId: string): string {
  return `${appToken}:${tableId}`
}

/** 从 preview 生成默认勾选集合（主选 + 自动纳入的依赖表） */
export function defaultCheckedFromPreview(preview: FeishuImportPreview): Set<string> {
  const next = new Set<string>()
  for (const row of preview.tables) {
    next.add(tableKeyOf(row.app_token, row.table_id))
  }
  return next
}

/** 关闭「检索关联」时：仅保留已选表，无边、无自动纳入 */
export function buildPreviewWithoutRelations(
  tables: Array<{ app_token: string; table_id: string; name: string }>,
): FeishuImportPreview {
  return {
    tables: tables.map((row) => ({
      app_token: row.app_token,
      table_id: row.table_id,
      name: row.name,
      selected: true,
      auto_included: false,
    })),
    edges: [],
    warnings: [],
  }
}

/**
 * 取消某张依赖表后，顺带去掉「仅因该表才需要」的边提示用集合不变；
 * 这里只更新 checked keys。主选表取消则直接移除。
 */
export function toggleReviewTable(
  checked: Set<string>,
  appToken: string,
  tableId: string,
  nextChecked: boolean,
): Set<string> {
  const key = tableKeyOf(appToken, tableId)
  const out = new Set(checked)
  if (nextChecked) out.add(key)
  else out.delete(key)
  return out
}

/** 过滤出最终要导入的表（保留 preview 顺序与名称） */
export function resolveFinalImportTables(
  preview: FeishuImportPreview,
  checked: Set<string>,
): Array<{ app_token: string; table_id: string; name: string }> {
  return preview.tables
    .filter((row) => checked.has(tableKeyOf(row.app_token, row.table_id)))
    .map((row) => ({
      app_token: row.app_token,
      table_id: row.table_id,
      name: row.name,
    }))
}

/** 边列表文案：仅展示两端都仍勾选的边 */
export function filterVisibleEdges(
  edges: FeishuPreviewEdge[],
  checked: Set<string>,
): FeishuPreviewEdge[] {
  return edges.filter((edge) => {
    const from = tableKeyOf(edge.app_token, edge.from_table_id)
    const to = tableKeyOf(edge.app_token, edge.to_table_id)
    return checked.has(from) && checked.has(to)
  })
}

/** 因取消依赖表而将降级的关联边（源仍勾选、目标已取消） */
export function filterDegradedEdges(
  edges: FeishuPreviewEdge[],
  checked: Set<string>,
): FeishuPreviewEdge[] {
  return edges.filter((edge) => {
    const from = tableKeyOf(edge.app_token, edge.from_table_id)
    const to = tableKeyOf(edge.app_token, edge.to_table_id)
    return checked.has(from) && !checked.has(to)
  })
}
