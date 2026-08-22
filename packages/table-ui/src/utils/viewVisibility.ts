import type { Field, ViewMeta, ViewUpdateRequest } from '../types'
import { getViewColumnMeta, type ViewColumnMetaItem } from '@tabtin/table-core'

type ViewVisibilitySnapshot = {
  allFieldIds: string[]
  visibleFieldIds: string[]
}

export type ViewFieldOrderSnapshot = {
  allFieldIds: string[]
  orderedFieldIds: string[]
}

type ViewVisibilityMode = 'visible' | 'hidden' | 'auto'

const PRIMARY_VISIBLE_VIEW_TYPES = new Set(['grid', 'kanban', 'gallery', 'list'])

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

export const resolveViewColumnMeta = (
  view: ViewMeta | null
): Record<string, ViewColumnMetaItem> | null => {
  return getViewColumnMeta(view) ?? null
}

export const resolveViewVisibilityMode = (view: ViewMeta | null): ViewVisibilityMode => {
  const viewType = String(view?.view_type ?? '').toLowerCase()
  if (viewType === 'kanban' || viewType === 'gallery' || viewType === 'calendar' || viewType === 'form') {
    return 'visible'
  }
  if (viewType === 'grid' || viewType === 'list' || viewType === 'plugin') {
    return 'hidden'
  }
  return 'auto'
}

/**
 * Return ALL fields (including hidden) sorted by column_meta order.
 * Falls back to the original field array order when no column_meta exists.
 */
export const getViewOrderedAllFields = (
  currentView: ViewMeta | null,
  fields: Field[]
): Field[] => {
  if (!fields || fields.length === 0) return fields ?? []

  const columnMeta = resolveViewColumnMeta(currentView)
  if (!columnMeta || Object.keys(columnMeta).length === 0) return fields

  const fieldIdSet = new Set(fields.map(f => f.id))
  const fieldIdByName = new Map(fields.map(f => [f.name, f.id]))
  const defaultOrderMap = new Map(fields.map((f, index) => [f.id, index]))

  // Build a lookup: fieldId → order from column_meta
  const orderMap = new Map<string, number>()
  Object.entries(columnMeta).forEach(([rawKey, rawMeta]) => {
    if (!rawMeta || typeof rawMeta !== 'object') return
    const fieldId = fieldIdSet.has(rawKey) ? rawKey : fieldIdByName.get(rawKey)
    if (!fieldId) return
    if (isFiniteNumber(rawMeta.order)) {
      orderMap.set(fieldId, rawMeta.order)
    }
  })

  return [...fields].sort((a, b) => {
    const aOrder = orderMap.has(a.id)
      ? orderMap.get(a.id)!
      : (defaultOrderMap.get(a.id) ?? Number.POSITIVE_INFINITY)
    const bOrder = orderMap.has(b.id)
      ? orderMap.get(b.id)!
      : (defaultOrderMap.get(b.id) ?? Number.POSITIVE_INFINITY)
    if (aOrder === bOrder) {
      return (defaultOrderMap.get(a.id) ?? 0) - (defaultOrderMap.get(b.id) ?? 0)
    }
    return aOrder - bOrder
  })
}

type ViewColumnMetaItemFull = ViewColumnMetaItem & { width?: number }

/**
 * Build a column_meta update payload from visible field IDs.
 * column_meta is the single source of truth for visibility.
 * Grid/List/Plugin views use `hidden`, Kanban/Gallery/Calendar/Form views use `visible`.
 */
export const buildColumnMetaVisibilityUpdate = (
  currentView: ViewMeta,
  fields: Field[],
  nextVisibleFieldIds: string[]
): Record<string, ViewColumnMetaItemFull> => {
  const allFieldIds = fields.map(f => f.id)
  const allFieldIdSet = new Set(allFieldIds)
  const fieldIdByName = new Map(fields.map(f => [f.name, f.id]))
  const visibleSet = new Set(nextVisibleFieldIds.filter(id => allFieldIdSet.has(id)))

  const existingMeta = resolveViewColumnMeta(currentView) ?? {}
  const normalizedMeta = new Map<string, ViewColumnMetaItemFull>()
  Object.entries(existingMeta).forEach(([rawKey, rawMeta]) => {
    if (!rawMeta || typeof rawMeta !== 'object') return
    const fieldId = allFieldIdSet.has(rawKey) ? rawKey : fieldIdByName.get(rawKey)
    if (fieldId) normalizedMeta.set(fieldId, rawMeta as ViewColumnMetaItemFull)
  })

  const defaultOrderMap = new Map(allFieldIds.map((id, idx) => [id, idx]))
  const visibilityMode = resolveViewVisibilityMode(currentView)
  const result: Record<string, ViewColumnMetaItemFull> = {}

  allFieldIds.forEach(fieldId => {
    const existing = normalizedMeta.get(fieldId) ?? {}
    const order = isFiniteNumber(existing.order) ? existing.order : (defaultOrderMap.get(fieldId) ?? 0)
    const entry: ViewColumnMetaItemFull = { ...existing, order }
    const isVisible = visibleSet.has(fieldId)

    if (visibilityMode === 'visible') {
      entry.visible = isVisible
      delete entry.hidden
    } else if (visibilityMode === 'hidden') {
      entry.hidden = !isVisible
      delete entry.visible
    } else {
      entry.hidden = !isVisible
      delete entry.visible
    }

    result[fieldId] = entry
  })

  return result
}

export const isPrimaryVisibilityLocked = (viewType: string | undefined): boolean =>
  PRIMARY_VISIBLE_VIEW_TYPES.has(String(viewType ?? '').toLowerCase())

export const ensurePrimaryVisibleFieldIds = (
  viewType: string | undefined,
  fields: Field[],
  visibleFieldIds: string[]
): string[] => {
  if (!isPrimaryVisibilityLocked(viewType)) {
    return visibleFieldIds
  }
  if (!Array.isArray(visibleFieldIds) || visibleFieldIds.length === 0) {
    return visibleFieldIds
  }

  const validFieldIdSet = new Set(fields.map(field => field.id))
  const normalized: string[] = []
  const seen = new Set<string>()

  visibleFieldIds.forEach(fieldId => {
    if (!validFieldIdSet.has(fieldId) || seen.has(fieldId)) return
    seen.add(fieldId)
    normalized.push(fieldId)
  })

  fields.forEach(field => {
    if (!field.is_primary || seen.has(field.id)) return
    seen.add(field.id)
    normalized.push(field.id)
  })

  return normalized
}

const resolveViewColumnMetaByFieldId = (
  view: ViewMeta | null,
  allFieldIdSet: Set<string>,
  fieldIdByName: Map<string, string>
): Map<string, ViewColumnMetaItem> => {
  const raw = resolveViewColumnMeta(view)
  const normalized = new Map<string, ViewColumnMetaItem>()
  if (!raw) return normalized

  Object.entries(raw).forEach(([rawKey, rawMeta]) => {
    if (!rawMeta || typeof rawMeta !== 'object') return
    const fieldId = allFieldIdSet.has(rawKey) ? rawKey : fieldIdByName.get(rawKey)
    if (!fieldId) return
    normalized.set(fieldId, rawMeta)
  })

  return normalized
}

const normalizeFieldIds = (
  values: string[] | undefined,
  allFieldIdSet: Set<string>,
  fieldIdByName: Map<string, string>
): string[] => {
  if (!Array.isArray(values)) return []

  const normalized: string[] = []
  const seen = new Set<string>()

  values.forEach(rawValue => {
    const key = String(rawValue)
    const fieldId = allFieldIdSet.has(key) ? key : fieldIdByName.get(key)
    if (!fieldId || seen.has(fieldId)) return
    seen.add(fieldId)
    normalized.push(fieldId)
  })

  return normalized
}

const resolveFieldOrder = (
  currentView: ViewMeta,
  allFieldIds: string[],
  allFieldIdSet: Set<string>,
  fieldIdByName: Map<string, string>
): string[] => {
  const currentColumnMeta = resolveViewColumnMetaByFieldId(currentView, allFieldIdSet, fieldIdByName)
  const defaultOrderMap = new Map(allFieldIds.map((fieldId, index) => [fieldId, index]))

  if (currentColumnMeta.size > 0) {
    const orderedByMeta = [...allFieldIds].sort((leftId, rightId) => {
      const leftMeta = currentColumnMeta.get(leftId)
      const rightMeta = currentColumnMeta.get(rightId)
      const leftOrder = isFiniteNumber(leftMeta?.order) ? leftMeta.order! : defaultOrderMap.get(leftId) ?? 0
      const rightOrder = isFiniteNumber(rightMeta?.order) ? rightMeta.order! : defaultOrderMap.get(rightId) ?? 0
      if (leftOrder === rightOrder) {
        return (defaultOrderMap.get(leftId) ?? 0) - (defaultOrderMap.get(rightId) ?? 0)
      }
      return leftOrder - rightOrder
    })
    return orderedByMeta
  }

  const normalizedFromFieldOrder = normalizeFieldIds(currentView.field_order, allFieldIdSet, fieldIdByName)
  if (normalizedFromFieldOrder.length > 0) {
    const missing = allFieldIds.filter(fieldId => !normalizedFromFieldOrder.includes(fieldId))
    return [...normalizedFromFieldOrder, ...missing]
  }

  return allFieldIds
}

export const getViewFieldOrderSnapshot = (
  currentView: ViewMeta | null,
  fields: Field[]
): ViewFieldOrderSnapshot => {
  const allFieldIds = fields.map(field => field.id)
  const allFieldIdSet = new Set(allFieldIds)
  const fieldIdByName = new Map(fields.map(field => [field.name, field.id]))

  if (!currentView) {
    return { allFieldIds, orderedFieldIds: allFieldIds }
  }

  return {
    allFieldIds,
    orderedFieldIds: resolveFieldOrder(currentView, allFieldIds, allFieldIdSet, fieldIdByName),
  }
}

export const mergeReorderedSubsetIntoFieldOrder = (
  currentFieldOrder: string[],
  nextSubsetOrder: string[]
): string[] => {
  const currentOrderSet = new Set(currentFieldOrder)
  const normalizedSubsetOrder: string[] = []
  const subsetSeen = new Set<string>()

  nextSubsetOrder.forEach(fieldId => {
    if (!currentOrderSet.has(fieldId) || subsetSeen.has(fieldId)) return
    subsetSeen.add(fieldId)
    normalizedSubsetOrder.push(fieldId)
  })

  if (normalizedSubsetOrder.length <= 1) return currentFieldOrder

  let queueIndex = 0

  return currentFieldOrder.map(fieldId => {
    if (!subsetSeen.has(fieldId)) return fieldId
    const nextFieldId = normalizedSubsetOrder[queueIndex]
    queueIndex += 1
    return nextFieldId ?? fieldId
  })
}

const resolveColumnWidthFromConfig = (
  currentView: ViewMeta,
  fieldId: string,
  fieldName: string | undefined
): number | undefined => {
  const rawWidths = (currentView.config as any)?.column_widths
  if (!rawWidths || typeof rawWidths !== 'object') return undefined

  const byId = rawWidths[fieldId]
  if (isFiniteNumber(byId)) return Math.round(byId)

  if (fieldName) {
    const byName = rawWidths[fieldName]
    if (isFiniteNumber(byName)) return Math.round(byName)
  }

  return undefined
}

export const buildViewColumnMetaUpdate = (
  currentView: ViewMeta,
  fields: Field[],
  options: { visibleFieldIds: string[]; fieldOrder: string[] }
): Record<string, ViewColumnMetaItem> => {
  const allFieldIds = fields.map(field => field.id)
  const allFieldIdSet = new Set(allFieldIds)
  const fieldIdByName = new Map(fields.map(field => [field.name, field.id]))
  const fieldNameById = new Map(fields.map(field => [field.id, field.name]))
  const normalizedFieldOrder = normalizeFieldIds(options.fieldOrder, allFieldIdSet, fieldIdByName)
  const orderWithFallback = normalizedFieldOrder.length > 0
    ? [...normalizedFieldOrder, ...allFieldIds.filter(fieldId => !normalizedFieldOrder.includes(fieldId))]
    : allFieldIds

  const normalizedVisible = normalizeFieldIds(options.visibleFieldIds, allFieldIdSet, fieldIdByName)
  const visibleSet = new Set(normalizedVisible)
  const currentColumnMeta = resolveViewColumnMetaByFieldId(currentView, allFieldIdSet, fieldIdByName)
  const visibilityMode = resolveViewVisibilityMode(currentView)

  const nextColumnMeta: Record<string, ViewColumnMetaItem> = {}

  orderWithFallback.forEach((fieldId, index) => {
    const existing = currentColumnMeta.get(fieldId) ?? {}
    const nextMeta: ViewColumnMetaItem = { ...existing, order: index }

    const fieldName = fieldNameById.get(fieldId)
    const configWidth = resolveColumnWidthFromConfig(currentView, fieldId, fieldName)
    if (isFiniteNumber(existing.width)) {
      nextMeta.width = Math.round(existing.width!)
    } else if (configWidth !== undefined) {
      nextMeta.width = configWidth
    }

    const isVisible = visibleSet.has(fieldId)
    if (visibilityMode === 'visible') {
      nextMeta.visible = isVisible
      delete nextMeta.hidden
    } else if (visibilityMode === 'hidden') {
      nextMeta.hidden = !isVisible
      delete nextMeta.visible
    } else if (isVisible) {
      nextMeta.visible = true
      delete nextMeta.hidden
    } else {
      nextMeta.hidden = true
      delete nextMeta.visible
    }

    nextColumnMeta[fieldId] = nextMeta
  })

  return nextColumnMeta
}

export const buildViewVisibilityUpdate = (
  currentView: ViewMeta,
  fields: Field[],
  nextVisibleFieldIds: string[]
): ViewUpdateRequest => {
  const allFieldIds = fields.map(field => field.id)
  const allFieldIdSet = new Set(allFieldIds)
  const fieldIdByName = new Map(fields.map(field => [field.name, field.id]))
  const nextVisibleNormalized: string[] = []
  const visibleSeen = new Set<string>()

  nextVisibleFieldIds.forEach(fieldId => {
    if (!allFieldIdSet.has(fieldId) || visibleSeen.has(fieldId)) return
    nextVisibleNormalized.push(fieldId)
    visibleSeen.add(fieldId)
  })
  const nextVisibleNormalizedWithPrimary = ensurePrimaryVisibleFieldIds(
    currentView.view_type,
    fields,
    nextVisibleNormalized,
  )

  const baseOrder = resolveFieldOrder(currentView, allFieldIds, allFieldIdSet, fieldIdByName)

  const nextFieldOrder: string[] = []
  const orderSeen = new Set<string>()

  baseOrder.forEach(fieldId => {
    if (!allFieldIdSet.has(fieldId) || orderSeen.has(fieldId)) return
    nextFieldOrder.push(fieldId)
    orderSeen.add(fieldId)
  })

  allFieldIds.forEach(fieldId => {
    if (orderSeen.has(fieldId)) return
    nextFieldOrder.push(fieldId)
    orderSeen.add(fieldId)
  })

  const showAll = nextVisibleNormalizedWithPrimary.length === allFieldIds.length
  const visible_fields = showAll ? [] : nextVisibleNormalizedWithPrimary
  const normalizedVisibleForMeta = showAll ? allFieldIds : nextVisibleNormalizedWithPrimary

  const nextConfig =
    currentView.config && typeof currentView.config === 'object'
      ? { ...(currentView.config as Record<string, unknown>) }
      : null

  if (nextConfig && ('visible_fields' in nextConfig || currentView.view_type !== 'calendar')) {
    nextConfig.visible_fields = visible_fields
  }

  const nextColumnMeta = buildViewColumnMetaUpdate(currentView, fields, {
    visibleFieldIds: normalizedVisibleForMeta,
    fieldOrder: nextFieldOrder,
  })

  return {
    visible_fields,
    field_order: nextFieldOrder,
    column_meta: nextColumnMeta,
    ...(nextConfig ? { config: nextConfig } : {}),
  }
}

export const buildViewVisibilityColumnMetaOnlyUpdate = (
  currentView: ViewMeta,
  fields: Field[],
  nextVisibleFieldIds: string[]
): ViewUpdateRequest => {
  const payload = buildViewVisibilityUpdate(currentView, fields, nextVisibleFieldIds)
  if (!payload.column_meta) return payload
  return {
    column_meta: payload.column_meta,
  }
}

export const getViewVisibilitySnapshot = (
  currentView: ViewMeta | null,
  fields: Field[]
): ViewVisibilitySnapshot => {
  const allFieldIds = fields.map(field => field.id)
  const allFieldIdSet = new Set(allFieldIds)
  const fieldIdByName = new Map(fields.map(field => [field.name, field.id]))

  const columnMeta = resolveViewColumnMeta(currentView)
  if (columnMeta && Object.keys(columnMeta).length > 0) {
    const metaMap = new Map<string, ViewColumnMetaItem>()
    Object.entries(columnMeta).forEach(([rawKey, rawMeta]) => {
      if (!rawMeta || typeof rawMeta !== 'object') return
      const fieldId = allFieldIdSet.has(rawKey) ? rawKey : fieldIdByName.get(rawKey)
      if (!fieldId) return
      metaMap.set(fieldId, rawMeta)
    })

    if (metaMap.size > 0) {
      const visibilityMode = resolveViewVisibilityMode(currentView)
      const useVisible =
        visibilityMode === 'visible' ||
        (visibilityMode === 'auto' &&
          Array.from(metaMap.values()).some(meta => typeof meta.visible === 'boolean'))
      const useHidden =
        visibilityMode === 'hidden' ||
        (visibilityMode === 'auto' &&
          Array.from(metaMap.values()).some(meta => typeof meta.hidden === 'boolean') &&
          !useVisible)
      const defaultOrderMap = new Map(allFieldIds.map((fieldId, index) => [fieldId, index]))

      const orderedFieldIds = [...allFieldIds].sort((leftId, rightId) => {
        const leftMeta = metaMap.get(leftId)
        const rightMeta = metaMap.get(rightId)
        const leftOrder = isFiniteNumber(leftMeta?.order) ? leftMeta!.order! : defaultOrderMap.get(leftId) ?? 0
        const rightOrder = isFiniteNumber(rightMeta?.order) ? rightMeta!.order! : defaultOrderMap.get(rightId) ?? 0
        if (leftOrder === rightOrder) {
          return (defaultOrderMap.get(leftId) ?? 0) - (defaultOrderMap.get(rightId) ?? 0)
        }
        return leftOrder - rightOrder
      })

      const visibleFieldIds = orderedFieldIds.filter(fieldId => {
        const meta = metaMap.get(fieldId)
        if (useVisible) {
          if (typeof meta?.visible === 'boolean') {
            return meta.visible === true
          }
          if (typeof meta?.hidden === 'boolean') {
            return meta.hidden !== true
          }
          return true
        }
        if (useHidden) {
          if (typeof meta?.hidden === 'boolean') {
            return meta.hidden !== true
          }
          if (typeof meta?.visible === 'boolean') {
            return meta.visible === true
          }
          return true
        }
        return true
      })

      return { allFieldIds, visibleFieldIds }
    }
  }

  const visibleFieldIds =
    currentView?.visible_fields && currentView.visible_fields.length > 0
      ? currentView.visible_fields.filter(fieldId => allFieldIds.includes(fieldId))
      : allFieldIds

  return { allFieldIds, visibleFieldIds }
}
