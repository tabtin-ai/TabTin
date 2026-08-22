/**
 * 将表格右键「发送到对话」的选区整理成 ContextInject payload。
 * 索引口径：table_id + record_ids +（可选）field_ids；会话撤销时靠同构 block 回填 chip。
 */

export interface TableSelectionInjectField {
  id: string
  name: string
}

export interface BuildTableSelectionInjectPayloadParams {
  tableId: string
  tableName?: string
  spaceId?: string
  recordIds: string[]
  /** 选中单元格对应字段；空表示整行/多行记录引用（不钉死 field_ids） */
  selectedFields: TableSelectionInjectField[]
  primaryRow: Record<string, unknown>
  resolveRowLabel: (row: Record<string, unknown>) => string
  selectedRecordCountLabel: string
}

export interface TableSelectionInjectPayload {
  type: 'table_selection'
  resourceId: string
  label: string
  spaceId?: string
  preview: string
  meta: {
    record_ids: string[]
    field_ids?: string[]
  }
}

const toReadableCellValue = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function buildTableSelectionInjectPayload(
  params: BuildTableSelectionInjectPayloadParams,
): TableSelectionInjectPayload | null {
  const {
    tableId,
    tableName,
    spaceId,
    recordIds,
    selectedFields,
    primaryRow,
    resolveRowLabel,
    selectedRecordCountLabel,
  } = params

  if (!tableId || recordIds.length === 0) return null

  const displayName = tableName?.trim() || tableId
  const previewFields =
    selectedFields.length > 0 ? selectedFields : []

  let label: string
  let preview: string

  if (recordIds.length === 1) {
    if (previewFields.length === 1) {
      const field = previewFields[0]
      const value = toReadableCellValue(primaryRow[field.name] ?? primaryRow[field.id]).trim()
      preview = value || `${field.name}: (empty)`
      label = `${displayName} · ${field.name}${value ? ` · ${value}` : ''}`
    } else if (previewFields.length > 1) {
      const previewLines = previewFields.map((field) => {
        const value = primaryRow[field.name] ?? primaryRow[field.id]
        return `${field.name}: ${value ?? ''}`
      })
      preview = previewLines.join('\n')
      label = `${displayName} · ${resolveRowLabel(primaryRow) || recordIds[0]}`
    } else {
      // 整行：预览取主字段文案，不写入 field_ids（后端按表字段兜底）
      preview = resolveRowLabel(primaryRow) || recordIds[0]
      label = `${displayName} · ${preview}`
    }
  } else {
    const firstRowLabel = resolveRowLabel(primaryRow)
    preview = `${firstRowLabel} (+${recordIds.length - 1})`
    label = `${displayName} · ${selectedRecordCountLabel}`
  }

  return {
    type: 'table_selection',
    resourceId: tableId,
    label,
    spaceId,
    preview,
    meta: {
      record_ids: recordIds,
      ...(previewFields.length > 0
        ? { field_ids: previewFields.map((field) => field.id) }
        : {}),
    },
  }
}
