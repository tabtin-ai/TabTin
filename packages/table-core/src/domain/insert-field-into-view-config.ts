import type { ViewColumnMeta, ViewColumnMetaItem } from '../data/types/view'

export type InsertFieldPosition = 'before' | 'after'

const VIEW_TYPES_WITH_HIDDEN_COLUMN_META = new Set(['grid', 'list', 'plugin'])

export interface InsertFieldIntoViewConfigInput {
  fieldId: string
  referenceFieldId: string
  position: InsertFieldPosition
  viewType?: string
  columnMeta: ViewColumnMeta
  visibleFields?: string[]
  fieldOrder?: string[]
  /** 表级字段序（fieldsMeta / fields 的 id 列表），作 fallback */
  activeFieldIdsByOrder: string[]
}

export interface InsertFieldIntoViewConfigResult {
  column_meta: ViewColumnMeta
  /** 仅当原 visible_fields 非空时返回 */
  visible_fields?: string[]
  /** 仅当原 field_order 非空时返回 */
  field_order?: string[]
}

function insertFieldIdByReference(
  currentIds: string[],
  fieldId: string,
  referenceFieldId: string | undefined,
  insertPosition: InsertFieldPosition | undefined,
  fieldOrderMap: Record<string, number>,
  fieldOrder: number,
): string[] {
  if (currentIds.includes(fieldId)) {
    return currentIds
  }

  let insertIndex: number
  if (referenceFieldId && currentIds.includes(referenceFieldId)) {
    const referenceIndex = currentIds.indexOf(referenceFieldId)
    insertIndex =
      insertPosition === 'before' ? referenceIndex : referenceIndex + 1
  } else {
    insertIndex = currentIds.length
    for (let index = 0; index < currentIds.length; index++) {
      const existingFieldId = currentIds[index]
      if ((fieldOrderMap[existingFieldId] ?? Number.POSITIVE_INFINITY) >= fieldOrder) {
        insertIndex = index
        break
      }
    }
  }

  return [
    ...currentIds.slice(0, insertIndex),
    fieldId,
    ...currentIds.slice(insertIndex),
  ]
}

function buildColumnMetaEntry(
  viewType: string,
  order: number,
  isHidden = false,
): ViewColumnMetaItem {
  const entry: ViewColumnMetaItem = { order }
  if (VIEW_TYPES_WITH_HIDDEN_COLUMN_META.has(viewType)) {
    entry.hidden = isHidden
  } else {
    entry.visible = !isHidden
  }
  return entry
}

function insertFieldIntoColumnMeta(
  columnMeta: ViewColumnMeta,
  viewType: string,
  fieldId: string,
  referenceFieldId: string,
  insertPosition: InsertFieldPosition,
  activeFieldIdsByOrder: string[],
  visibleFieldIds: string[],
  viewFieldOrder: string[],
): ViewColumnMeta {
  if (fieldId in columnMeta) {
    return columnMeta
  }

  const hadColumnMeta = Object.keys(columnMeta).length > 0
  let orderedIds: string[]

  if (hadColumnMeta && referenceFieldId in columnMeta) {
    orderedIds = Object.keys(columnMeta).sort((left, right) => {
      const leftMeta = columnMeta[left]
      const rightMeta = columnMeta[right]
      const leftOrder =
        leftMeta && typeof leftMeta.order === 'number'
          ? leftMeta.order
          : Number.POSITIVE_INFINITY
      const rightOrder =
        rightMeta && typeof rightMeta.order === 'number'
          ? rightMeta.order
          : Number.POSITIVE_INFINITY
      return leftOrder - rightOrder
    })
  } else {
    const baseIds =
      viewFieldOrder.length > 0 ? viewFieldOrder : activeFieldIdsByOrder
    orderedIds = baseIds.filter(id => id !== fieldId)
  }

  const fieldOrderMap: Record<string, number> = {}
  activeFieldIdsByOrder.forEach((id, index) => {
    fieldOrderMap[id] = index
  })
  const fieldOrder =
    fieldId in fieldOrderMap
      ? fieldOrderMap[fieldId]
      : Number.POSITIVE_INFINITY

  orderedIds = insertFieldIdByReference(
    orderedIds,
    fieldId,
    referenceFieldId,
    insertPosition,
    fieldOrderMap,
    fieldOrder,
  )

  const visibleFieldSet = new Set(visibleFieldIds)
  const nextMeta: ViewColumnMeta = {}
  orderedIds.forEach((orderedFieldId, order) => {
    const rawEntry = columnMeta[orderedFieldId]
    const entry: ViewColumnMetaItem =
      rawEntry && typeof rawEntry === 'object' ? { ...rawEntry } : {}
    entry.order = order
    if (orderedFieldId === fieldId || !hadColumnMeta) {
      const isHidden =
        orderedFieldId !== fieldId &&
        visibleFieldSet.size > 0 &&
        !visibleFieldSet.has(orderedFieldId)
      Object.assign(entry, buildColumnMetaEntry(viewType, order, isHidden))
    }
    nextMeta[orderedFieldId] = entry
  })
  return nextMeta
}

/**
 * 协作态左/右插入字段时，按参考列更新视图 column_meta / visible_fields / field_order。
 * 语义对齐 Django `_add_field_to_views_at_position`。
 */
export function insertFieldIntoViewConfig(
  input: InsertFieldIntoViewConfigInput,
): InsertFieldIntoViewConfigResult {
  const {
    fieldId,
    referenceFieldId,
    position,
    viewType = '',
    columnMeta,
    visibleFields = [],
    fieldOrder = [],
    activeFieldIdsByOrder,
  } = input

  const fieldOrderMap: Record<string, number> = {}
  activeFieldIdsByOrder.forEach((id, index) => {
    fieldOrderMap[id] = index
  })
  const newFieldOrder =
    fieldId in fieldOrderMap
      ? fieldOrderMap[fieldId]
      : Number.POSITIVE_INFINITY

  const result: InsertFieldIntoViewConfigResult = {
    column_meta: insertFieldIntoColumnMeta(
      columnMeta,
      String(viewType).toLowerCase(),
      fieldId,
      referenceFieldId,
      position,
      activeFieldIdsByOrder,
      visibleFields,
      fieldOrder,
    ),
  }

  if (visibleFields.length > 0 && !visibleFields.includes(fieldId)) {
    result.visible_fields = insertFieldIdByReference(
      visibleFields,
      fieldId,
      referenceFieldId,
      position,
      fieldOrderMap,
      newFieldOrder,
    )
  }

  if (fieldOrder.length > 0 && !fieldOrder.includes(fieldId)) {
    result.field_order = insertFieldIdByReference(
      fieldOrder,
      fieldId,
      referenceFieldId,
      position,
      fieldOrderMap,
      newFieldOrder,
    )
  }

  return result
}
