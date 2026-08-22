/**
 * 关联扫描中用户跳过/取消的表，从 preview 结果里剔除（含触及的边）。
 */

export interface RelationScanPreviewTable {
  app_token: string
  table_id: string
  name: string
  selected?: boolean
  auto_included?: boolean
}

export interface RelationScanPreviewEdge {
  app_token: string
  from_table_id: string
  from_table_name: string
  field_name: string
  to_table_id: string
  to_table_name: string
  duplex?: boolean
  same_base?: boolean
}

export interface RelationScanPreviewLike {
  tables: RelationScanPreviewTable[]
  edges: RelationScanPreviewEdge[]
  warnings: string[]
  has_attachments?: boolean
}

function tableKey(appToken: string, tableId: string): string {
  return `${appToken}:${tableId}`
}

/** 去掉 excluded 表及其关联边；若源仍在、目标被排除，边也不再展示（导入时会按集合降级） */
export function filterPreviewByExcludedKeys<T extends RelationScanPreviewLike>(
  preview: T,
  excludedKeys: ReadonlySet<string>,
): T {
  if (excludedKeys.size === 0) return preview

  const tables = preview.tables.filter((row) => (
    !excludedKeys.has(tableKey(row.app_token, row.table_id))
  ))
  const kept = new Set(
    tables.map((row) => tableKey(row.app_token, row.table_id)),
  )
  const edges = preview.edges.filter((edge) => {
    const from = tableKey(edge.app_token, edge.from_table_id)
    const to = tableKey(edge.app_token, edge.to_table_id)
    return kept.has(from) && kept.has(to)
  })

  return {
    ...preview,
    tables,
    edges,
  }
}
