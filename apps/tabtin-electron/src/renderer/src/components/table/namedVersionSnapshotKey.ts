/**
 * 命名版本预览/还原锚点：始终用 VH 自己的 id。
 * 旧逻辑 `history_id || id` 会让共用 legacy RecordHistory 锚点的多条命名版本
 * 预览成同一份内容。
 */
export function resolveNamedVersionSnapshotKey(version: {
  id: string
  history_id?: string | null
}): string {
  return version.id
}
