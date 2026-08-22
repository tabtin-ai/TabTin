import { useMemo, useRef } from 'react'
import type { TableGridRow } from '@tabtin/table-engine'
import {
  compareCanonicalGroupValues,
  RECORD_IDENTITY_KEY,
  resolveRecordId,
} from '@tabtin/table-engine'
import type { Field, TableRecord, ViewMeta, ViewRecordsResponse, LooseViewGroup } from '../types'
import { resolveViewColumnMeta, resolveViewVisibilityMode } from '../utils/viewVisibility'
import { resolveGroupValuePresentation } from './groupValueCodec'

type GroupMeta = {
  fields?: Array<{ field?: string; field_id?: string; direction?: string }>
  nodes?: Array<{
    group_value?: unknown
    group_label?: string
    count?: number
    children?: GroupMeta['nodes']
  }>
}

type GroupMetaNode = NonNullable<GroupMeta['nodes']>[number]

/**
 * 对齐后端 view_group_sort_service.build_nodes 的分组顺序。
 *
 * 增量更新会先带来新记录值，完整 metadata 稍后才到；临时节点也必须使用同一排序
 * 口径插入，否则它会先追加到末尾、再在 metadata 刷新后跳回正式位置。
 */
const compareGroupValues = (
  left: unknown,
  right: unknown,
  field: Field | undefined,
  direction: string | undefined,
  userDisplayNameById?: ReadonlyMap<string, string>,
): number => {
  return compareCanonicalGroupValues(
    left,
    right,
    {
      fieldType: field?.field_type,
      choices: Array.isArray(field?.options?.choices) ? field.options.choices : undefined,
      userDisplayNameById,
    },
    direction,
  )
}

type FieldResolver = {
  name: string
  extract: (record: any) => unknown
}

type ViewColumnMetaItem = {
  order?: number
  hidden?: boolean
  visible?: boolean
  width?: number
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const normalizeFieldIds = (
  rawValues: string[] | undefined,
  options: {
    fieldMap: Map<string, Field>
    fieldIdByName: Map<string, string>
  }
): string[] => {
  const { fieldMap, fieldIdByName } = options

  if (!Array.isArray(rawValues)) {
    return []
  }

  const normalized: string[] = []
  const seen = new Set<string>()

  rawValues.forEach(raw => {
    const key = String(raw)
    const fieldId = fieldMap.has(key) ? key : fieldIdByName.get(key)
    if (!fieldId || seen.has(fieldId)) {
      return
    }
    seen.add(fieldId)
    normalized.push(fieldId)
  })

  return normalized
}

type SubRecordTreeMetaEntry = {
  depth?: number
  has_children?: boolean
  parent_id?: string | null
}

type SubRecordTreeMetadata = Record<string, SubRecordTreeMetaEntry>

type ComputedTreeMeta = {
  depth: number
  parentId: string | null
  hasChildren: boolean
}

/** 从父 link 单元格值里抽出父记录 id，兼容 string / {id} / [{id}] 等形态。 */
const extractParentLinkId = (value: unknown): string | null => {
  if (!value) return null
  if (typeof value === 'string') return value || null
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = extractParentLinkId(item)
      if (id) return id
    }
    return null
  }
  if (typeof value === 'object') {
    const raw =
      (value as { id?: unknown }).id ?? (value as { record_id?: unknown }).record_id
    return typeof raw === 'string' && raw.length > 0 ? raw : null
  }
  return null
}

/**
 * 客户端 DFS 树聚类（镜像后端 ``SubRecordService.build_tree_ordered_records``）。
 *
 * 渲染顺序的权威是 ``records`` 数组顺序，而前端 dataset 只附加缩进、从不重排——
 * 这要求上游始终把数组排成 DFS。但增量同步 / 协作合并会把新子记录按 flat ``__order``
 * 或追加塞进数组，且 ``__order`` 存在大量并列（导入遗留），导致子记录脱离父记录、
 * 在「父下方」与「并列组之后 / 末尾」之间反复跳。
 *
 * 这里在 dataset 层统一按「父子关系」重做 DFS：父子来源 = ``tree_data`` 的 ``parent_id``
 * （已落库记录，和后端 LinkRecord 一致），新建子记录 ``tree_data`` 还没覆盖时回退到记录
 * 自身的父 link 字段值。深度由遍历推导（新记录也能拿到正确缩进）。这样无论上游数组
 * 顺序如何、``__order`` 是否并列，渲染顺序恒为 DFS，与初次加载的后端口径一致。
 */
export const computeSubRecordTreeOrder = (
  records: ReadonlyArray<TableRecord>,
  treeMetadata: SubRecordTreeMetadata,
  parentFieldId: string | null,
): { orderIds: string[]; metaById: Map<string, ComputedTreeMeta> } => {
  const idSet = new Set(records.map(record => String(record.id)))

  const resolveParentId = (record: TableRecord): string | null => {
    const id = String(record.id)
    // 父字段 cell 显式存在时优先于 tree_data（Yjs-first 语义）。
    //
    // tree_data 是上次 REST 读取派生的快照；协作在线拖拽 / 移动只改 Y.Doc 的父字段
    // cell，不会即时刷新 tree_data。若仍以 tree_data 为准，移动后的记录会被旧
    // parent_id 拽回原父记录下（回弹）。而父字段 cell 在各路径都保持新鲜：REST 读取
    // 由 backfill 从 LinkRecord 写回（cell==tree_data）、协作经 Y.Doc cell 实时同步、
    // 删除父记录时  会把 cell 主动清成 null。因此「cell 显式带 key」即视为权威。
    //
    // 删除父记录的安全性：被删父记录会从已加载集合移除，下方 ``!idSet.has`` 守卫会把
    // 残留指向它的子记录归为根；叠加  的 cell 清空，不会复活已删父子关系。
    //
    // 只有当记录根本没有父字段 key（未请求该列、或新建子记录经 collab observer 合入
    // 但 metadata 尚未到达）时，才回退 tree_data；都没有则视为根。
    if (parentFieldId) {
      const recordFields = (record as { fields?: Record<string, unknown> }).fields
      const recordData = (record as { data?: Record<string, unknown> }).data
      const hasCellKey = Boolean(
        (recordFields && parentFieldId in recordFields) ||
        (recordData && parentFieldId in recordData),
      )
      if (hasCellKey) {
        const raw = recordFields?.[parentFieldId] ?? recordData?.[parentFieldId]
        return extractParentLinkId(raw)
      }
    }
    const meta = treeMetadata[id]
    // 无显式 cell 时，tree_data 条目存在即权威（parent_id 为 null 表示根）。
    if (meta) {
      return meta.parent_id ? String(meta.parent_id) : null
    }
    return null
  }

  const parentById = new Map<string, string | null>()
  const childrenById = new Map<string, string[]>()
  for (const record of records) {
    const id = String(record.id)
    let parentId = resolveParentId(record)
    // 父记录不在当前已加载集合里 → 视为根（与后端 ``parent_id in record_id_set`` 一致）
    if (parentId && !idSet.has(parentId)) parentId = null
    parentById.set(id, parentId)
    if (parentId) {
      const siblings = childrenById.get(parentId)
      if (siblings) siblings.push(id)
      else childrenById.set(parentId, [id])
    }
  }

  const orderIds: string[] = []
  const metaById = new Map<string, ComputedTreeMeta>()
  const visited = new Set<string>()

  const visit = (id: string, depth: number): void => {
    if (visited.has(id)) return
    visited.add(id)
    const children = childrenById.get(id) ?? []
    const hasChildren = children.length > 0 || treeMetadata[id]?.has_children === true
    metaById.set(id, { depth, parentId: parentById.get(id) ?? null, hasChildren })
    orderIds.push(id)
    for (const childId of children) visit(childId, depth + 1)
  }

  for (const record of records) {
    const id = String(record.id)
    if ((parentById.get(id) ?? null) === null) visit(id, 0)
  }

  // 循环引用等导致未被遍历到的孤立节点：兜底追加，保证不丢行
  for (const record of records) {
    const id = String(record.id)
    if (visited.has(id)) continue
    const children = childrenById.get(id) ?? []
    metaById.set(id, {
      depth: 0,
      parentId: parentById.get(id) ?? null,
      hasChildren: children.length > 0 || treeMetadata[id]?.has_children === true,
    })
    orderIds.push(id)
    visited.add(id)
  }

  return { orderIds, metaById }
}

export interface UseDataGridDatasetInput {
  fields: Field[]
  currentView: ViewMeta | null
  currentViewRecords: ViewRecordsResponse | null
  records: TableRecord[]
  userDisplayNameById?: ReadonlyMap<string, string>
  useViewData: boolean
  collapsedGroupIds: string[]
  /** Sub-record tree: set of expanded record IDs for current view */
  treeExpandedRecords?: Set<string>
  isRecordsLoading: boolean
  isRecordLoading: boolean
  recordsQueryPage: number
  recordsQueryPageSize: number
  page: number
  pageSize: number
  total: number
  t: (key: string) => string
  locale: string
}

export interface DataGridDataset {
  fieldIdByName: Map<string, string>
  fieldNameById: Map<string, string>
  orderedFields: Field[]
  requestedFieldNames: string[]
  requestedFieldIds: string[]
  hasGrouping: boolean
  /** Whether the dataset has sub-record tree metadata active */
  hasSubRecordTree: boolean
  rowsData: TableGridRow[]
  /** Records eligible for search before group-collapse projection. */
  searchableRows: TableGridRow[]
  /** Canonical leaf-group path for every searchable record. */
  groupPathByRecordId: Map<string, string>
  groupedRows: TableGridRow[]
  gridLoading: boolean
  currentPage: number
  currentPageSize: number
  totalCount: number
}

export const useDataGridDataset = (input: UseDataGridDatasetInput): DataGridDataset => {
  const {
    fields,
    currentView,
    currentViewRecords,
    records,
    userDisplayNameById,
    useViewData,
    collapsedGroupIds,
    treeExpandedRecords,
    isRecordsLoading,
    isRecordLoading,
    recordsQueryPage,
    recordsQueryPageSize,
    page,
    pageSize,
    total,
    t,
    locale,
  } = input

  const tRef = useRef(t)
  tRef.current = t

  const collapsedGroupSet = useMemo(() => new Set(collapsedGroupIds), [collapsedGroupIds])

  const fieldIdByName = useMemo(() => {
    const map = new Map<string, string>()
    fields.forEach(field => {
      map.set(field.name, field.id)
    })
    return map
  }, [fields])

  const fieldNameById = useMemo(() => {
    const map = new Map<string, string>()
    fields.forEach(field => {
      map.set(field.id, field.name)
    })
    return map
  }, [fields])

  const fieldTypeByName = useMemo(() => {
    const map = new Map<string, string>()
    fields.forEach(field => {
      map.set(field.name, field.field_type)
    })
    return map
  }, [fields])

  const fieldByName = useMemo(() => {
    const map = new Map<string, Field>()
    fields.forEach(field => {
      map.set(field.name, field)
    })
    return map
  }, [fields])

  const orderedFields = useMemo(() => {
    if (!fields || fields.length === 0) {
      return []
    }

    const fieldMap = new Map(fields.map(field => [field.id, field]))
    const allFieldIds = fields.map(field => field.id)
    const columnMeta = resolveViewColumnMeta(currentView)

    if (columnMeta && Object.keys(columnMeta).length > 0) {
      const normalizedEntries = Object.entries(columnMeta)
        .map(([rawKey, meta]) => {
          const fieldId = fieldMap.has(rawKey) ? rawKey : fieldIdByName.get(rawKey)
          if (!fieldId || !meta || typeof meta !== 'object') {
            return null
          }
          return { fieldId, meta: meta as ViewColumnMetaItem }
        })
        .filter((entry): entry is { fieldId: string; meta: ViewColumnMetaItem } => Boolean(entry))

      const visibilityMode = resolveViewVisibilityMode(currentView)
      const useVisible =
        visibilityMode === 'visible' ||
        (visibilityMode === 'auto' &&
          normalizedEntries.some(entry => typeof entry.meta.visible === 'boolean'))
      const useHidden =
        visibilityMode === 'hidden' ||
        (visibilityMode === 'auto' &&
          normalizedEntries.some(entry => typeof entry.meta.hidden === 'boolean') &&
          !useVisible)

      const metaFieldIdSet = new Set(normalizedEntries.map(e => e.fieldId))

      const visibleFieldIds = normalizedEntries
        .filter(entry => {
          if (useVisible) {
            if (typeof entry.meta.visible === 'boolean') {
              return entry.meta.visible === true
            }
            if (typeof entry.meta.hidden === 'boolean') {
              return entry.meta.hidden !== true
            }
            return true
          }
          if (useHidden) {
            if (typeof entry.meta.hidden === 'boolean') {
              return entry.meta.hidden !== true
            }
            if (typeof entry.meta.visible === 'boolean') {
              return entry.meta.visible === true
            }
            return true
          }
          return true
        })
        .map(entry => entry.fieldId)

      // 新创建的字段可能不在 column_meta 中，默认视为可见
      const fieldsNotInMeta = allFieldIds.filter(id => !metaFieldIdSet.has(id))

      const visibleSet = new Set(
        visibleFieldIds.length > 0
          ? [...visibleFieldIds, ...fieldsNotInMeta]
          : allFieldIds
      )
      const defaultOrderMap = new Map(allFieldIds.map((id, idx) => [id, idx]))
      const orderedVisible = normalizedEntries
        .filter(entry => visibleSet.has(entry.fieldId))
        .sort((a, b) => {
          const left = isFiniteNumber(a.meta.order) ? a.meta.order : (defaultOrderMap.get(a.fieldId) ?? Number.POSITIVE_INFINITY)
          const right = isFiniteNumber(b.meta.order) ? b.meta.order : (defaultOrderMap.get(b.fieldId) ?? Number.POSITIVE_INFINITY)
          if (left === right) {
            return (defaultOrderMap.get(a.fieldId) ?? 0) - (defaultOrderMap.get(b.fieldId) ?? 0)
          }
          return left - right
        })
        .map(entry => entry.fieldId)

      const ordered: Field[] = []
      const appended = new Set<string>()
      orderedVisible.forEach(fieldId => {
        if (appended.has(fieldId)) return
        const field = fieldMap.get(fieldId)
        if (!field) return
        ordered.push(field)
        appended.add(fieldId)
      })

      // 补齐不在 column_meta 中的新字段（追加到末尾）
      fieldsNotInMeta.forEach(fieldId => {
        if (appended.has(fieldId)) return
        const field = fieldMap.get(fieldId)
        if (!field) return
        ordered.push(field)
        appended.add(fieldId)
      })

      Array.from(visibleSet).forEach(fieldId => {
        if (appended.has(fieldId)) return
        const field = fieldMap.get(fieldId)
        if (!field) return
        ordered.push(field)
        appended.add(fieldId)
      })

      // Safety fallback: if column_meta resolved to 0 visible fields, show all
      if (ordered.length === 0 && fields.length > 0) {
        return [...fields]
      }
      return ordered
    }

    const visibleFieldIds = normalizeFieldIds(currentView?.visible_fields, {
      fieldMap,
      fieldIdByName,
    })
    const resolvedVisibleFieldIds = visibleFieldIds.length > 0 ? visibleFieldIds : allFieldIds

    const orderSource = normalizeFieldIds(currentView?.field_order, {
      fieldMap,
      fieldIdByName,
    })
    const resolvedOrderSource = orderSource.length > 0 ? orderSource : resolvedVisibleFieldIds

    const visibleFieldIdSet = new Set(resolvedVisibleFieldIds)
    const ordered: Field[] = []
    const appended = new Set<string>()

    // 优先遵循 field_order，但仅保留当前可见字段
    resolvedOrderSource.forEach(fieldId => {
      if (!visibleFieldIdSet.has(fieldId) || appended.has(fieldId)) {
        return
      }
      const field = fieldMap.get(fieldId)
      if (!field) {
        return
      }
      ordered.push(field)
      appended.add(fieldId)
    })

    // 补齐在 visible_fields 中但缺失于 field_order 的字段
    resolvedVisibleFieldIds.forEach(fieldId => {
      if (appended.has(fieldId)) {
        return
      }
      const field = fieldMap.get(fieldId)
      if (!field) {
        return
      }
      ordered.push(field)
      appended.add(fieldId)
    })

    // Safety fallback: if visible_fields resolved to 0, show all
    if (ordered.length === 0 && fields.length > 0) {
      return [...fields]
    }
    return ordered
  }, [fields, currentView, fieldIdByName])

  const requestedFieldNames = useMemo(() => {
    if (orderedFields.length > 0) {
      return orderedFields.map(field => field.name)
    }
    return fields.map(field => field.name)
  }, [orderedFields, fields])

  const requestedFieldIds = useMemo(() => {
    if (orderedFields.length > 0) {
      return orderedFields.map(field => field.id)
    }
    return fields.map(field => field.id)
  }, [orderedFields, fields])

  const metadataGroups = currentViewRecords?.metadata?.groups as GroupMeta | undefined

  // 切视图竞态下 currentViewRecords 可能仍是上一视图（看板）投影，其 metadata.groups
  // 的 fields / nodes 都不能驱动当前表格行分组。仅响应视图 id 匹配时采信。
  const activeMetadataGroups = useMemo(() => {
    // metadata 是视图分组配置的执行结果，不能反过来启用分组。清空分组后，旧的
    // 同视图 records 投影可能短暂滞留；此时必须以 currentView.groups 为权威，
    // 否则工具栏显示“无分组”而画布仍渲染分组头。
    if (!currentView?.groups?.length || !metadataGroups) return undefined
    const recordsViewId = currentViewRecords?.view?.id
    const recordsBelongToCurrent =
      !recordsViewId || String(recordsViewId) === String(currentView.id)
    return recordsBelongToCurrent ? metadataGroups : undefined
  }, [currentView, currentViewRecords?.view?.id, metadataGroups])

  const groupFieldNames = useMemo(() => {
    if (!currentView) return []

    const fromViewConfig = (currentView.groups ?? [])
      .map(group => {
        const g = group as unknown as LooseViewGroup
        const fieldId = g.field_id ?? g.field ?? ''
        return fieldNameById.get(fieldId) ?? fieldId
      })
      .filter((value): value is string => Boolean(value))

    if (activeMetadataGroups?.fields?.length) {
      return activeMetadataGroups.fields
        .map(field => field.field ?? (field.field_id ? fieldNameById.get(field.field_id) ?? field.field_id : ''))
        .filter((value): value is string => Boolean(value))
    }

    return fromViewConfig
  }, [currentView, activeMetadataGroups, fieldNameById])

  const hasGrouping = groupFieldNames.length > 0

  const fieldResolvers = useMemo(() => {
    // Root-level identity keys must not be treated as business cell values when a
    // column is literally named `id` / `row_id` (common in CSV imports). Prefer
    // fields/data bags first; only then fall back to non-identity root keys.
    const recordRootIdentityKeys = new Set([
      'id',
      'row_id',
      'record_id',
      '_id',
      '__id',
      RECORD_IDENTITY_KEY,
    ])
    const baseResolvers: FieldResolver[] = orderedFields.map(field => {
      // 兼容历史/导入写入的无连字符 field id（如 7c7a22003a22...）
      const compactFieldId = typeof field.id === 'string' ? field.id.replace(/-/g, '') : ''
      return {
        name: field.name,
        extract: (record: any) => {
          const candidates: Array<[unknown, string]> = [
            [record?.fields, field.id],
            [record?.fields, field.name],
            [record?.fields, compactFieldId],
            [record?.data, field.id],
            [record?.data, field.name],
            [record?.data, compactFieldId],
            [record, field.id],
            [record, compactFieldId],
          ]
          if (!recordRootIdentityKeys.has(field.name)) {
            candidates.push([record, field.name])
          }

          for (const [source, key] of candidates) {
            if (
              key &&
              source &&
              typeof source === 'object' &&
              Object.prototype.hasOwnProperty.call(source, key)
            ) {
              const value = (source as Record<string, unknown>)[key]
              if (value !== undefined) return value
            }
          }
          return null
        },
      }
    })

    const extraResolvers: FieldResolver[] = groupFieldNames
      .filter(fieldName => !orderedFields.some(field => field.name === fieldName))
      .map(fieldName => ({
        name: fieldName,
        extract: (record: any) => {
          const source = record?.data ?? record?.fields ?? record
          if (!source || typeof source !== 'object') return null
          return fieldName.split('.').reduce((acc: any, key: string) => {
            if (acc && typeof acc === 'object') {
              return acc[key]
            }
            return null
          }, source)
        },
      }))

    return [...baseResolvers, ...extraResolvers]
  }, [orderedFields, groupFieldNames])

  const sourceRecords = useMemo(() => {
    if (useViewData) {
      return currentViewRecords?.records ?? []
    }
    return records
  }, [useViewData, currentViewRecords, records])

  const rowsData = useMemo<TableGridRow[]>(() => {
    const t0 = performance.now()
    let nextRows: TableGridRow[] = []

    if (sourceRecords && sourceRecords.length > 0) {
      nextRows = sourceRecords.map((record: any, index: number) => {
        const stableRowKey = record?.row_id ?? record?.rowId ?? record?.__row_id ?? record?.record_id
        const recordIdSource = record?.id ?? record?._id ?? record?.__id ?? stableRowKey ?? `row_${index}`
        const recordId = String(recordIdSource)
        const rowKey = stableRowKey ? String(stableRowKey) : recordId

        const rowData: TableGridRow = { [RECORD_IDENTITY_KEY]: recordId }
        fieldResolvers.forEach(({ name, extract }) => {
          rowData[name] = extract(record)
        })

        // Mirror legacy identity keys for callers that haven't migrated to
        // __recordId yet — but only when no business field already owns that name,
        // otherwise the mirrored id would clobber the business cell value.
        const businessFieldNames = new Set(fieldResolvers.map(({ name }) => name))
        if (!businessFieldNames.has('id')) {
          rowData.id = recordId
        }
        if (!businessFieldNames.has('row_id') && rowKey) {
          rowData.row_id = rowKey
        }

        return rowData
      })
    }

    const elapsed = Math.round(performance.now() - t0)
    if (elapsed > 10) {
      console.warn(`[useDataGridDataset] rowsData 计算 ${elapsed}ms (${nextRows.length} rows, ${fieldResolvers.length} fields)`)
    }
    return nextRows
  }, [sourceRecords, fieldResolvers])

  // ── Sub-record tree metadata enrichment ──
  const treeMetadata = useMemo(() => {
    if (!useViewData || !currentViewRecords) return null
    const metadata = (currentViewRecords as any)?.metadata
    return metadata?.sub_records?.tree_data ?? null
  }, [useViewData, currentViewRecords])

  const subRecordParentFieldId = useMemo<string | null>(() => {
    const config = (currentView?.config ?? null) as
      | { subRecordParentFieldId?: unknown }
      | null
    const value = config?.subRecordParentFieldId
    return typeof value === 'string' && value.length > 0 ? value : null
  }, [currentView])

  // 客户端 DFS 树序：以记录的父子关系为权威，免疫 flat `__order` 并列与
  // 增量/协作合并打乱数组顺序导致的「子记录上下跳」。
  const treeOrder = useMemo(() => {
    if (!treeMetadata) return null
    const source = sourceRecords as TableRecord[]
    if (!source || source.length === 0) return null
    return computeSubRecordTreeOrder(
      source,
      treeMetadata as SubRecordTreeMetadata,
      subRecordParentFieldId,
    )
  }, [treeMetadata, sourceRecords, subRecordParentFieldId])

  const treeEnrichedRows = useMemo<TableGridRow[]>(() => {
    if (!treeMetadata || !rowsData.length) return rowsData

    const annotate = (row: TableGridRow, meta: ComputedTreeMeta): TableGridRow => {
      const recordId = resolveRecordId(row) ?? ''
      const isExpanded = treeExpandedRecords
        ? treeExpandedRecords.has(recordId)
        : meta.depth === 0 // default: expand root level
      return {
        ...row,
        __treeDepth: meta.depth,
        __treeHasChildren: meta.hasChildren,
        __treeExpanded: isExpanded,
        __treeParentId: meta.parentId,
      }
    }

    if (treeOrder) {
      const rowById = new Map<string, TableGridRow>()
      for (const row of rowsData) {
        const recordId = resolveRecordId(row) ?? ''
        if (recordId) rowById.set(recordId, row)
      }
      const ordered: TableGridRow[] = []
      for (const recordId of treeOrder.orderIds) {
        const row = rowById.get(recordId)
        if (!row) continue
        rowById.delete(recordId)
        const meta = treeOrder.metaById.get(recordId)
        ordered.push(meta ? annotate(row, meta) : row)
      }
      // 兜底：treeOrder 未覆盖的行（理论上不会发生）保持原序追加，避免丢行
      if (rowById.size > 0) {
        for (const row of rowsData) {
          const recordId = resolveRecordId(row) ?? ''
          if (recordId && rowById.has(recordId)) {
            rowById.delete(recordId)
            ordered.push(row)
          }
        }
      }
      return ordered
    }

    // 兜底：无法计算树序时，仅按 tree_data 附加缩进（不重排）
    return rowsData.map(row => {
      const recordId = resolveRecordId(row)
      if (!recordId) return row
      const treeMeta = treeMetadata[recordId]
      if (!treeMeta) return row
      return annotate(row, {
        depth: treeMeta.depth ?? 0,
        parentId: treeMeta.parent_id ?? null,
        hasChildren: treeMeta.has_children ?? false,
      })
    })
  }, [rowsData, treeMetadata, treeExpandedRecords, treeOrder])

  // Filter out collapsed tree children
  const treeFilteredRows = useMemo<TableGridRow[]>(() => {
    if (!treeMetadata) return treeEnrichedRows

    // Build a set of record IDs whose ancestors are all expanded
    const visibleRows: TableGridRow[] = []
    const collapsedAncestors = new Set<string>()

    for (const row of treeEnrichedRows) {
      const recordId = resolveRecordId(row)
      const parentId = row.__treeParentId

      // Check if any ancestor is collapsed
      if (parentId && collapsedAncestors.has(parentId)) {
        // This row is hidden due to collapsed ancestor
        if (recordId) collapsedAncestors.add(recordId)
        continue
      }

      visibleRows.push(row)

      // If this row has children and is NOT expanded, mark it as collapsed ancestor
      if (row.__treeHasChildren && !row.__treeExpanded && recordId) {
        collapsedAncestors.add(recordId)
      }
    }

    return visibleRows
  }, [treeEnrichedRows, treeMetadata])

  const groupedDataset = useMemo<{
    groupedRows: TableGridRow[]
    searchableRows: TableGridRow[]
    groupPathByRecordId: Map<string, string>
  }>(() => {
    // Use tree-filtered rows when sub-record tree is active
    const effectiveRows = treeMetadata ? treeFilteredRows : rowsData
    const groupPathByRecordId = new Map<string, string>()

    let rawRows: TableGridRow[]

    if (!groupFieldNames.length) {
      rawRows = [
        ...effectiveRows,
        {
          id: '__add_row__',
          row_id: '__add_row__',
          __rowType: 'add',
        },
      ]
    } else {
      const resolveGroupValue = (value: unknown, fieldName: string | undefined) =>
        resolveGroupValuePresentation(
          value,
          fieldName ? fieldTypeByName.get(fieldName) : undefined,
          tRef.current('table:group.ungrouped'),
          userDisplayNameById,
        )

      const recordIdentity = (row: TableGridRow): string =>
        String(resolveRecordId(row) ?? row.id ?? '')

      const recordMap = new Map<string, TableGridRow[]>()
      effectiveRows.forEach(row => {
        let path = ''
        groupFieldNames.forEach(field => {
          const value = (row as any)[field]
          const key = resolveGroupValue(value, field).key
          path = path ? `${path}||${key}` : key
          const existing = recordMap.get(path)
          if (existing) {
            existing.push(row)
          } else {
            recordMap.set(path, [row])
          }
        })
        const rowId = recordIdentity(row)
        if (rowId) {
          groupPathByRecordId.set(rowId, path)
        }
      })

      const headerByPath = new Map<string, TableGridRow>()
      const consumedRecordIds = new Set<string>()

      const metadataFields = activeMetadataGroups?.fields ?? []
      const viewGroups = currentView?.groups ?? []
      const groupDirectionAt = (level: number): string =>
        metadataFields[level]?.direction ??
        (viewGroups[level] as LooseViewGroup | undefined)?.direction ??
        'asc'

      // 先把 metadata 深拷贝成当前渲染快照，再把实时增量产生的新 path 补进同一棵树。
      // 旧实现会在 buildFromMetadata 之后把 orphan 作为扁平组 append 到末尾，等完整
      // metadata 到达时又跳回正式位置；这里让临时态与重新拉取态共享相同层级和排序。
      const reconcileMetadataNodes = (sourceNodes: GroupMetaNode[]): GroupMetaNode[] => {
        const pageNumber = Number(currentViewRecords?.page ?? 1)
        const totalCount = Number(currentViewRecords?.total ?? effectiveRows.length)
        const hasCompleteDataset =
          pageNumber <= 1 && Number.isFinite(totalCount) && totalCount <= effectiveRows.length
        const cloneNodes = (input: GroupMetaNode[]): GroupMetaNode[] =>
          input.map(source => {
            const node: GroupMetaNode = {
              ...source,
              children: Array.isArray(source.children) ? cloneNodes(source.children) : [],
            }
            return node
          })
        const nodes = cloneNodes(sourceNodes)
        const syntheticNodes = new WeakSet<GroupMetaNode>()
        const currentNodes = new WeakSet<GroupMetaNode>()
        const currentCount = new WeakMap<GroupMetaNode, number>()

        effectiveRows.forEach(row => {
          let siblings = nodes
          groupFieldNames.forEach((fieldName, level) => {
            const rawValue = (row as any)[fieldName]
            const presentation = resolveGroupValue(rawValue, fieldName)
            let node = siblings.find(candidate =>
              resolveGroupValue(candidate?.group_value, fieldName).key === presentation.key
            )
            if (!node) {
              node = {
                group_value: rawValue,
                group_label: presentation.label,
                count: 0,
                children: [],
              }
              siblings.push(node)
              syntheticNodes.add(node)
            }
            currentNodes.add(node)
            currentCount.set(node, (currentCount.get(node) ?? 0) + 1)
            if (syntheticNodes.has(node)) node.count = currentCount.get(node)
            if (!Array.isArray(node.children)) node.children = []
            siblings = node.children
          })
        })

        const reconcileLevel = (siblings: GroupMetaNode[], level: number): GroupMetaNode[] => {
          const fieldName = groupFieldNames[level]
          const field = fieldName ? fieldByName.get(fieldName) : undefined
          const direction = groupDirectionAt(level)

          const retained = hasCompleteDataset
            ? siblings.filter(node => currentNodes.has(node))
            : [...siblings]
          if (hasCompleteDataset) {
            retained.forEach(node => {
              node.count = currentCount.get(node) ?? 0
            })
          }

          // REST、协作投影和增量节点可能以不同顺序到达；渲染前统一按 canonical
          // contract 重排，避免数据源切换时沿用各自的偶然顺序。
          const ordered = [...retained].sort((left, right) =>
            compareGroupValues(
              left.group_value,
              right.group_value,
              field,
              direction,
              userDisplayNameById,
            )
          )

          if (level + 1 < groupFieldNames.length) {
            ordered.forEach(node => {
              if (Array.isArray(node.children)) {
                node.children = reconcileLevel(node.children, level + 1)
              }
            })
          }
          return ordered
        }
        return reconcileLevel(nodes, 0)
      }

      const markConsumed = (rows: TableGridRow[]) => {
        rows.forEach(row => {
          const id = recordIdentity(row)
          if (id) consumedRecordIds.add(id)
        })
      }

      const buildFromMetadata = (
        nodes: Array<any>,
        level: number,
        parentPath: string,
        parentGroupValues: Record<string, unknown>
      ): TableGridRow[] => {
        const result: TableGridRow[] = []
        nodes.forEach(node => {
          const fieldName = groupFieldNames[level]
          const presentation = resolveGroupValue(node?.group_value, fieldName)
          const key = presentation.key
          const path = parentPath ? `${parentPath}||${key}` : key
          const currentGroupValues = {
            ...parentGroupValues,
            ...(fieldName ? { [fieldName]: node?.group_value } : {}),
          }
          const recordList = recordMap.get(path) ?? []
          const count = typeof node?.count === 'number' ? node.count : recordList.length
          if (count === 0 && recordList.length === 0) {
            return
          }

          const collapsed = collapsedGroupSet.has(path)
          const isLeafLevel = level >= groupFieldNames.length - 1
          const existingHeader = headerByPath.get(path)
          if (existingHeader) {
            const prevCount =
              typeof existingHeader.__groupCount === 'number' ? existingHeader.__groupCount : 0
            existingHeader.__groupCount = prevCount + count
            if (collapsed || existingHeader.__groupCollapsed) {
              markConsumed(recordList)
              return
            }
            if (Array.isArray(node?.children) && node.children.length > 0) {
              result.push(...buildFromMetadata(node.children, level + 1, path, currentGroupValues))
            } else {
              const fresh = recordList.filter(row => {
                const id = recordIdentity(row)
                return !id || !consumedRecordIds.has(id)
              })
              markConsumed(fresh)
              // 插到同 path 的 group_add 之前；若尚未发出过 leaf 行，追加 add 行
              const addIdx = result.findIndex(
                row => row.__rowType === 'group_add' && row.__groupPath === path
              )
              if (addIdx >= 0) {
                result.splice(addIdx, 0, ...fresh)
              } else {
                result.push(...fresh)
                result.push({
                  id: `__group_add__${path}`,
                  row_id: `__group_add__${path}`,
                  __rowType: 'group_add',
                  __groupLevel: level,
                  __groupPath: path,
                  __groupValues: currentGroupValues,
                })
              }
            }
            return
          }

          const headerRow: TableGridRow = {
            id: `__group__${path}`,
            __rowType: 'group_header',
            __groupLevel: level,
            __groupLabel: Object.prototype.hasOwnProperty.call(node ?? {}, 'group_value')
              ? presentation.label
              : node?.group_label ?? presentation.label,
            __groupValue: node?.group_value,
            __groupCount: count,
            __groupLoadedCount: 0,
            __groupPath: path,
            __groupCollapsed: collapsed,
            __groupIsLeaf: isLeafLevel,
            __groupValues: currentGroupValues,
          }
          headerByPath.set(path, headerRow)
          result.push(headerRow)

          if (collapsed) {
            markConsumed(recordList)
            return
          }

          if (Array.isArray(node?.children) && node.children.length > 0) {
            result.push(...buildFromMetadata(node.children, level + 1, path, currentGroupValues))
          } else {
            markConsumed(recordList)
            result.push(...recordList)
            result.push({
              id: `__group_add__${path}`,
              row_id: `__group_add__${path}`,
              __rowType: 'group_add',
              __groupLevel: level,
              __groupPath: path,
              __groupValues: currentGroupValues,
            })
          }
        })
        return result
      }

      const attachRowsBeforeGroupAdd = (
        rows: TableGridRow[],
        path: string,
        level: number,
        groupValues: Record<string, unknown>,
        toInsert: TableGridRow[]
      ) => {
        if (toInsert.length === 0) return
        markConsumed(toInsert)
        const addIdx = rows.findIndex(
          row => row.__rowType === 'group_add' && row.__groupPath === path
        )
        if (addIdx >= 0) {
          rows.splice(addIdx, 0, ...toInsert)
          return
        }
        const headerIdx = rows.findIndex(
          row => row.__rowType === 'group_header' && row.__groupPath === path
        )
        if (headerIdx >= 0) {
          rows.splice(headerIdx + 1, 0, ...toInsert, {
            id: `__group_add__${path}`,
            row_id: `__group_add__${path}`,
            __rowType: 'group_add',
            __groupLevel: level,
            __groupPath: path,
            __groupValues: groupValues,
          })
          return
        }
        rows.push(...toInsert)
      }

      const assignLoadedCounts = (rows: TableGridRow[]) => {
        for (let i = 0; i < rows.length; i++) {
          const header = rows[i]
          if (header.__rowType !== 'group_header') continue
          const path = typeof header.__groupPath === 'string' ? header.__groupPath : ''
          // recordMap 在每一层 path 都挂了该行，折叠时子行不在画布里也能反映「已加载」
          const fromMap = path && path !== '__unclassified__' ? recordMap.get(path)?.length : undefined
          if (typeof fromMap === 'number') {
            header.__groupLoadedCount = fromMap
            continue
          }
          const level = typeof header.__groupLevel === 'number' ? header.__groupLevel : 0
          let loaded = 0
          for (let j = i + 1; j < rows.length; j++) {
            const next = rows[j]
            if (next.__rowType === 'group_header') {
              const nextLevel = typeof next.__groupLevel === 'number' ? next.__groupLevel : 0
              if (nextLevel <= level) break
              continue
            }
            if (next.__rowType === 'group_add' || next.__rowType === 'add') continue
            loaded += 1
          }
          header.__groupLoadedCount = loaded
        }
      }

      if (activeMetadataGroups?.nodes?.length) {
        rawRows = buildFromMetadata(
          reconcileMetadataNodes(activeMetadataGroups.nodes),
          0,
          '',
          {},
        )

        // orphan 回收：metadata path 对不上的已加载行，按自身 codec path 挂回
        const orphansByPath = new Map<string, TableGridRow[]>()
        effectiveRows.forEach(row => {
          const id = recordIdentity(row)
          if (!id || consumedRecordIds.has(id)) return
          const path = groupPathByRecordId.get(id)
          if (!path) return
          const bucket = orphansByPath.get(path)
          if (bucket) bucket.push(row)
          else orphansByPath.set(path, [row])
        })

        orphansByPath.forEach((orphanRows, path) => {
          const header = headerByPath.get(path)
          if (header && !header.__groupCollapsed) {
            const level = typeof header.__groupLevel === 'number' ? header.__groupLevel : 0
            attachRowsBeforeGroupAdd(
              rawRows,
              path,
              level,
              (header.__groupValues as Record<string, unknown>) ?? {},
              orphanRows
            )
            return
          }
          if (header?.__groupCollapsed) {
            // 折叠组不展示行，但仍计为已消费
            markConsumed(orphanRows)
            return
          }

          // 防御性兜底：正常情况下 reconcileMetadataNodes 已把实时新 path 补齐；
          // 若仍有不可解析数据，至少保持  的“不丢行”契约。
          const sample = orphanRows[0]
          const level = Math.max(0, path.split('||').length - 1)
          const leafField = groupFieldNames[Math.min(level, groupFieldNames.length - 1)]
          const leafValue = leafField ? (sample as any)?.[leafField] : undefined
          const presentation = resolveGroupValue(leafValue, leafField)
          const groupValues: Record<string, unknown> = {}
          groupFieldNames.forEach(fieldName => {
            groupValues[fieldName] = (sample as any)?.[fieldName]
          })
          const syntheticHeader: TableGridRow = {
            id: `__group__${path}`,
            __rowType: 'group_header',
            __groupLevel: level,
            __groupLabel: presentation.label,
            __groupValue: leafValue,
            __groupCount: orphanRows.length,
            __groupLoadedCount: orphanRows.length,
            __groupPath: path,
            __groupCollapsed: false,
            __groupIsLeaf: level >= groupFieldNames.length - 1,
            __groupValues: groupValues,
          }
          headerByPath.set(path, syntheticHeader)
          rawRows.push(syntheticHeader)
          markConsumed(orphanRows)
          rawRows.push(...orphanRows)
          rawRows.push({
            id: `__group_add__${path}`,
            row_id: `__group_add__${path}`,
            __rowType: 'group_add',
            __groupLevel: level,
            __groupPath: path,
            __groupValues: groupValues,
          })
        })

        assignLoadedCounts(rawRows)
      } else {
        rawRows = [
          ...effectiveRows,
          {
            id: '__add_row__',
            row_id: '__add_row__',
            __rowType: 'add',
          },
        ]
      }
    }

    // Assign __treeRootIndex per-group section (resets at each group_header).
    // Shallow-copy rows that get a new property to avoid mutating upstream objects.
    const groupedRows = treeMetadata
      ? (() => {
          let rootCounter = 0
          return rawRows.map(row => {
            if (row.__rowType === 'group_header') {
              rootCounter = 0
              return row
            }
            if (row.__rowType === 'add' || row.__rowType === 'group_add') return row
            if ((row.__treeDepth ?? 0) === 0) {
              rootCounter++
              return { ...row, __treeRootIndex: rootCounter }
            }
            return row
          })
        })()
      : rawRows

    return {
      groupedRows,
      searchableRows: effectiveRows,
      groupPathByRecordId,
    }
  }, [
    rowsData,
    treeFilteredRows,
    treeMetadata,
    groupFieldNames,
    fieldTypeByName,
    fieldByName,
    userDisplayNameById,
    activeMetadataGroups,
    currentView,
    currentViewRecords?.page,
    currentViewRecords?.total,
    collapsedGroupSet,
  ])

  const { groupedRows, searchableRows, groupPathByRecordId } = groupedDataset

  const gridLoading = useMemo(() => {
    if (useViewData) {
      const viewRecordCount = currentViewRecords?.records?.length ?? 0
      return isRecordsLoading && viewRecordCount === 0
    }

    return isRecordLoading && records.length === 0
  }, [useViewData, isRecordsLoading, currentViewRecords, isRecordLoading, records.length])

  const currentPage = useViewData ? recordsQueryPage : page
  const currentPageSize = useViewData ? recordsQueryPageSize : pageSize
  const totalCount = useViewData
    ? currentViewRecords?.total ?? rowsData.length
    : total ?? records.length

  return {
    fieldIdByName,
    fieldNameById,
    orderedFields,
    requestedFieldNames,
    requestedFieldIds,
    hasGrouping,
    hasSubRecordTree: !!treeMetadata,
    rowsData,
    searchableRows,
    groupPathByRecordId,
    groupedRows,
    gridLoading,
    currentPage,
    currentPageSize,
    totalCount,
  }
}
