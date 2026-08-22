import type { TableRecord, ViewMeta, ViewRecordsResponse } from '@tabtin/table-core'

export type LocalCreateOverlayScopeInput = {
  useViewData: boolean
  currentViewId: string | null
  currentView: ViewMeta | null
  currentViewRecords: ViewRecordsResponse | null
  searchQuery: string
  searchHideNotMatchRows: boolean
  useServerSearch: boolean
  overlayEntries?: LocalCreateOverlayEntry[]
}

type LocalCreateOverlayScopeKeyInput = {
  currentViewId: string | null
  currentViewRecords: ViewRecordsResponse | null
}

export type LocalCreateOverlayOrderContext = {
  anchor_record_id?: string
  position?: 'before' | 'after' | 'end'
  group_values?: Record<string, unknown>
}

export type LocalCreateOverlayTreeMeta = {
  depth?: number
  has_children?: boolean
  parent_id?: string | null
}

export type LocalCreateOverlayTreePatch = Record<string, LocalCreateOverlayTreeMeta>

type LocalCreateOverlaySubRecordMetadata = {
  sub_records?: Record<string, unknown> & {
    tree_data?: LocalCreateOverlayTreePatch
  }
}

export type LocalCreateOverlayEntry = {
  record: TableRecord
  anchorRecordId?: string
  position: 'before' | 'after' | 'end'
  subRecordTreePatch?: LocalCreateOverlayTreePatch
  /**
   * Marks an overlay entry as an explicit local create that must remain visible
   * (projected at the end of the current page) even after the page it was
   * created on stops being the last page, until the server reconciles it by id.
   * Overlays without this flag keep the original stale-snapshot drop behavior.
   */
  retention?: 'until_reconciled'
}

const hasItems = (value: unknown[] | null | undefined): boolean =>
  Array.isArray(value) && value.length > 0

const normalizeOverlayPosition = (
  value: unknown
): 'before' | 'after' | 'end' => {
  if (value === 'before' || value === 'after' || value === 'end') {
    return value
  }
  return 'end'
}

const isLastPage = (currentViewRecords: ViewRecordsResponse | null): boolean => {
  if (!currentViewRecords) {
    return false
  }

  const pageSize = Number(currentViewRecords.page_size ?? 0)
  const page = Number(currentViewRecords.page ?? 1)
  const total = Math.max(0, Number(currentViewRecords.total ?? 0))

  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    return false
  }

  const lastPage = Math.max(1, Math.ceil(Math.max(total, 1) / pageSize))
  return page === lastPage
}

export const isCollabOptimisticCreateRecord = (
  record: TableRecord | null | undefined
): boolean =>
  Boolean(
    record &&
      (record as Record<string, unknown>).__optimistic === true &&
      (record as Record<string, unknown>).__optimisticSource === 'collab'
  )

export const canDisplayLocalCreateOverlayScope = ({
  useViewData,
  currentViewId,
  currentView,
  currentViewRecords,
  searchQuery,
  searchHideNotMatchRows,
  useServerSearch,
}: LocalCreateOverlayScopeInput): boolean => {
  if (!useViewData || !currentViewId || !currentView || !currentViewRecords) {
    return false
  }

  if (currentView.view_type !== 'grid') {
    return false
  }

  if (hasItems(currentView.filters) || hasItems(currentView.sorts)) {
    return false
  }

  if (hasItems(currentView.groups)) {
    return searchQuery.trim().length === 0
  }

  if (searchQuery.trim().length > 0 && (searchHideNotMatchRows || useServerSearch)) {
    return false
  }

  return true
}

export const canApplyLocalCreateOverlay = (
  scope: LocalCreateOverlayScopeInput,
  orderContext?: LocalCreateOverlayOrderContext | null
): boolean => {
  if (!canDisplayLocalCreateOverlayScope(scope)) {
    return false
  }

  const hasGroups = hasItems(scope.currentView?.groups)
  if (hasGroups) {
    const groupValues = orderContext?.group_values
    if (!groupValues || Object.keys(groupValues).length === 0) {
      return false
    }
  }

  const position = normalizeOverlayPosition(orderContext?.position)
  const anchorRecordId =
    typeof orderContext?.anchor_record_id === 'string' &&
    orderContext.anchor_record_id.length > 0
      ? orderContext.anchor_record_id
      : undefined

  if ((position === 'before' || position === 'after') && anchorRecordId) {
    const currentIds = new Set(
      (scope.currentViewRecords?.records ?? []).map(record => String(record.id))
    )
    ;(scope.overlayEntries ?? []).forEach(entry => {
      currentIds.add(String(entry.record.id))
    })
    return currentIds.has(anchorRecordId)
  }

  if (hasGroups) {
    return false
  }

  return isLastPage(scope.currentViewRecords)
}

export const buildLocalCreateOverlayScopeKey = ({
  currentViewId,
  currentViewRecords,
}: LocalCreateOverlayScopeKeyInput): string | null => {
  if (!currentViewId || !currentViewRecords) {
    return null
  }

  const page = Number(currentViewRecords.page ?? 1)
  const pageSize = Number(currentViewRecords.page_size ?? 0)

  if (!Number.isFinite(page) || page < 1 || !Number.isFinite(pageSize) || pageSize <= 0) {
    return null
  }

  return `${currentViewId}:${page}:${pageSize}`
}

export const buildLocalCreateOverlayEntries = (
  createdRecords: TableRecord[],
  orderContext?: LocalCreateOverlayOrderContext | null,
  options?: { subRecordTreePatch?: LocalCreateOverlayTreePatch }
): LocalCreateOverlayEntry[] => {
  const nextEntries: LocalCreateOverlayEntry[] = []
  let previousCreatedId: string | undefined

  createdRecords.forEach((record, index) => {
    const recordId =
      typeof record?.id === 'string' && record.id.length > 0 ? record.id : null
    if (!recordId) {
      return
    }

    if (index === 0) {
      const position = normalizeOverlayPosition(orderContext?.position)
      const anchorRecordId =
        typeof orderContext?.anchor_record_id === 'string' &&
        orderContext.anchor_record_id.length > 0
          ? orderContext.anchor_record_id
          : undefined

      nextEntries.push({
        record,
        position:
          (position === 'before' || position === 'after') && anchorRecordId
            ? position
            : 'end',
        retention: 'until_reconciled',
        ...(anchorRecordId ? { anchorRecordId } : {}),
        ...(options?.subRecordTreePatch
          ? { subRecordTreePatch: options.subRecordTreePatch }
          : {}),
      })
    } else {
      nextEntries.push({
        record,
        position: previousCreatedId ? 'after' : 'end',
        retention: 'until_reconciled',
        ...(previousCreatedId ? { anchorRecordId: previousCreatedId } : {}),
        ...(options?.subRecordTreePatch
          ? { subRecordTreePatch: options.subRecordTreePatch }
          : {}),
      })
    }

    previousCreatedId = recordId
  })

  return nextEntries
}

export const upsertLocalCreateOverlayEntries = (
  overlayEntries: LocalCreateOverlayEntry[],
  nextEntry: LocalCreateOverlayEntry
): LocalCreateOverlayEntry[] => {
  const nextId = String(nextEntry.record.id)
  const deduped = overlayEntries.filter(
    entry => String(entry.record.id) !== nextId
  )
  return [...deduped, nextEntry]
}

export const reconcileLocalCreateOverlayEntries = (
  overlayEntries: LocalCreateOverlayEntry[],
  serverRecords: TableRecord[]
): LocalCreateOverlayEntry[] => {
  if (overlayEntries.length === 0 || serverRecords.length === 0) {
    return overlayEntries
  }

  const serverIds = new Set(serverRecords.map(record => String(record.id)))
  return overlayEntries.filter(
    entry => !serverIds.has(String(entry.record.id))
  )
}

export const patchLocalCreateOverlayEntryRecord = (
  entry: LocalCreateOverlayEntry,
  recordId: string | number,
  updatedRecord: TableRecord
): LocalCreateOverlayEntry => {
  if (String(entry.record.id) !== String(recordId)) {
    return entry
  }

  const record = entry.record
  const recordFields =
    (record as Record<string, unknown>).fields as
      | Record<string, unknown>
      | undefined
  const updatedFields =
    (updatedRecord as Record<string, unknown>).fields as
      | Record<string, unknown>
      | undefined
  const updatedId = updatedRecord.id ? String(updatedRecord.id) : String(recordId)
  const treePatch = entry.subRecordTreePatch
  let nextTreePatch = treePatch
  if (treePatch && updatedId !== String(recordId) && treePatch[String(recordId)]) {
    const { [String(recordId)]: patchedMeta, ...restTreePatch } = treePatch
    nextTreePatch = {
      ...restTreePatch,
      [updatedId]: patchedMeta,
    }
  }

  return {
    ...entry,
    ...(nextTreePatch ? { subRecordTreePatch: nextTreePatch } : {}),
    record: {
      ...record,
      ...updatedRecord,
      data: {
        ...(record.data ?? {}),
        ...(updatedRecord.data ?? {}),
      },
      fields: {
        ...(recordFields ?? {}),
        ...(updatedFields ?? {}),
      },
    },
  } as LocalCreateOverlayEntry
}

export const mergeViewRecordsWithLocalCreateOverlays = (
  currentViewRecords: ViewRecordsResponse | null,
  overlayEntries: LocalCreateOverlayEntry[]
): ViewRecordsResponse | null => {
  if (!currentViewRecords || overlayEntries.length === 0) {
    return currentViewRecords
  }

  const serverRecords = currentViewRecords.records ?? []
  const reconciledOverlays = reconcileLocalCreateOverlayEntries(
    overlayEntries,
    serverRecords
  )

  if (reconciledOverlays.length === 0) {
    return currentViewRecords
  }

  const mergedRecords = [...serverRecords]
  const currentMetadata = currentViewRecords.metadata as
    | (Record<string, unknown> & LocalCreateOverlaySubRecordMetadata)
    | undefined
  const mergedTreeData: LocalCreateOverlayTreePatch = {
    ...(currentMetadata?.sub_records?.tree_data ?? {}),
  }
  let hasTreePatch = false

  reconciledOverlays.forEach(entry => {
    const nextId = String(entry.record.id)
    if (mergedRecords.some(record => String(record.id) === nextId)) {
      return
    }

    if (entry.position === 'end' && !isLastPage(currentViewRecords)) {
      if (entry.retention !== 'until_reconciled') {
        return
      }
      // Retained overlay: the page it was created on is no longer the last
      // page (e.g. total grew past a full page), but the server hasn't
      // reconciled this id into the page yet. Keep it projected at the end
      // of the current page rather than dropping it, so it doesn't
      // disappear from the grid until the server catches up.
    }

    if (
      (entry.position === 'before' || entry.position === 'after') &&
      entry.anchorRecordId
    ) {
      const anchorIndex = mergedRecords.findIndex(
        record => String(record.id) === entry.anchorRecordId
      )
      if (anchorIndex >= 0) {
        const insertIndex =
          entry.position === 'before' ? anchorIndex : anchorIndex + 1
        mergedRecords.splice(insertIndex, 0, entry.record)
        if (entry.subRecordTreePatch) {
          Object.assign(mergedTreeData, entry.subRecordTreePatch)
          hasTreePatch = true
        }
        return
      }
    }

    mergedRecords.push(entry.record)
    if (entry.subRecordTreePatch) {
      Object.assign(mergedTreeData, entry.subRecordTreePatch)
      hasTreePatch = true
    }
  })

  const metadata = hasTreePatch
    ? {
        ...(currentViewRecords.metadata ?? {}),
        sub_records: {
          ...(currentMetadata?.sub_records ?? {}),
          tree_data: mergedTreeData,
        },
      }
    : currentViewRecords.metadata

  return {
    ...currentViewRecords,
    records: mergedRecords,
    metadata,
  }
}
