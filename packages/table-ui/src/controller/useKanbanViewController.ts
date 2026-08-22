import { useCallback, useMemo, useState } from 'react'
import type { Field, RecordFormData, TableRecord, ViewMeta, ViewRecordsResponse } from '../types'
import { formatFieldDisplayValue } from './cellValueUtils'
import { resolveGroupValuePresentation } from './groupValueCodec'
import { getViewVisibilitySnapshot } from '../utils/viewVisibility'
import {
  DEFAULT_UNTITLED_RECORD_TITLE,
  resolveConfiguredCardTitle,
  toTitleText,
} from '../utils/viewCardTitle'

export type KanbanGroup = {
  id: string
  label: string
  value: string | null
  rawValue: unknown
  records: any[]
  count: number
  isFallback: boolean
  hasMore: boolean
  offset: number
}

export interface KanbanViewConfig {
  groupByField?: string
  cardTitleField?: string
  cardCoverField?: string
  visibleFields: string[]
}

export interface UseKanbanViewControllerInput {
  views: ViewMeta[]
  currentViewId: string | null
  currentViewOverride?: ViewMeta | null
  currentViewRecords: ViewRecordsResponse | null
  fields: Field[]
  selectedTableId: string | null
  userDisplayNameById?: ReadonlyMap<string, string>
  t: (key: string, options?: Record<string, unknown>) => string
}

export interface KanbanViewControllerState {
  currentView: ViewMeta | undefined
  kanbanConfig: KanbanViewConfig
  groups: KanbanGroup[]
  fieldIdToNameMap: Map<string, string>
  getRecordFieldValue: (record: any, fieldIdOrName?: string) => unknown
  getRecordTitle: (record: any) => string
  fieldIdToFieldMap: Map<string, Field>
  cardTitleFieldName: string | undefined
  cardCoverFieldName: string | undefined
  visibleFieldIds: string[]
  selectedRecord: TableRecord | null
  dialogMode: 'create' | 'edit'
  isRecordDialogOpen: boolean
  createDefaults: RecordFormData | undefined
  handleCardClick: (record: any) => void
  handleCreateCard: (group: KanbanGroup) => void
  handleDialogOpenChange: (open: boolean) => void
}

const isUnsetGroupValue = (value: unknown): boolean => {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  return false
}

const USER_FIELD_TYPES = new Set(['user', 'created_by', 'last_modified_by'])

const getGroupTransportValue = (value: unknown): string | null =>
  isUnsetGroupValue(value) ? null : String(value)

const parseSerializedMemberGroupValue = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  const serialized = value.trim()
  const looksSerialized =
    (serialized.startsWith('"') && serialized.endsWith('"')) ||
    (serialized.startsWith('[') && serialized.endsWith(']')) ||
    (serialized.startsWith('{') && serialized.endsWith('}'))
  if (!looksSerialized) return value

  try {
    const parsed = JSON.parse(serialized) as unknown
    if (
      typeof parsed === 'string' ||
      Array.isArray(parsed) ||
      (parsed !== null && typeof parsed === 'object')
    ) {
      return parsed
    }
  } catch {
    // 普通成员 ID 不是 JSON，保持原始传输值。
  }
  return value
}

const getGroupPresentation = (
  value: unknown,
  field: Field | undefined,
  emptyLabel: string,
  userDisplayNameById?: ReadonlyMap<string, string>,
): { key: string | null; label: string } => {
  if (isUnsetGroupValue(value)) {
    return { key: null, label: emptyLabel }
  }
  return resolveGroupValuePresentation(
    value,
    field?.field_type,
    emptyLabel,
    userDisplayNameById,
  )
}

const getRecordIdentifier = (record: any): string | undefined => {
  const id = record?.id ?? record?._id ?? record?.__id
  return id === null || id === undefined ? undefined : String(id)
}

const mergeGroupRecords = (current: any[], incoming: any[]): any[] => {
  const merged = [...current]
  const seenIds = new Set(current.map(getRecordIdentifier).filter(Boolean))
  incoming.forEach(record => {
    const id = getRecordIdentifier(record)
    if (id) {
      if (!seenIds.has(id)) {
        seenIds.add(id)
        merged.push(record)
      }
      return
    }
    if (!merged.includes(record)) {
      merged.push(record)
    }
  })
  return merged
}

export const useKanbanViewController = (
  input: UseKanbanViewControllerInput
): KanbanViewControllerState => {
  const {
    views,
    currentViewId,
    currentViewOverride,
    currentViewRecords,
    fields,
    selectedTableId,
    userDisplayNameById,
    t,
  } = input

  const [selectedRecord, setSelectedRecord] = useState<TableRecord | null>(null)
  const [dialogMode, setDialogMode] = useState<'create' | 'edit'>('edit')
  const [isRecordDialogOpen, setIsRecordDialogOpen] = useState(false)
  const [createDefaults, setCreateDefaults] = useState<RecordFormData | undefined>(undefined)

  const currentView = useMemo(
    () => currentViewOverride ?? views.find(view => view.id === currentViewId),
    [currentViewOverride, views, currentViewId]
  )

  const fallbackVisibleFieldIds = useMemo(
    () => getViewVisibilitySnapshot(currentView ?? null, fields).visibleFieldIds,
    [currentView, fields]
  )

  const kanbanConfig = useMemo<KanbanViewConfig>(() => {
    const config = (currentView?.config as Record<string, any>) ?? {}
    // 正常路径下 config.group_by_field 已由 viewResolution 的会话/个人视图草稿
    // 投影完成。这里保留 groups[0] 兜底，防止某个调用方传入未经
    // 投影的 views（如离线/测试场景）时看板仍能读到分组选择。
    const groupByField =
      (config.group_by_field as string | undefined) ??
      (Array.isArray(currentView?.groups)
        ? (currentView?.groups[0] as { field_id?: string } | undefined)?.field_id
        : undefined)
    return {
      groupByField,
      cardTitleField: config.card_title_field as string | undefined,
      cardCoverField: config.card_cover_field as string | undefined,
      visibleFields:
        Array.isArray(config.visible_fields) && config.visible_fields.length > 0
          ? (config.visible_fields as string[])
          : fallbackVisibleFieldIds,
    }
  }, [currentView, fallbackVisibleFieldIds])

  const records = currentViewRecords?.records ?? []

  const fieldIdToNameMap = useMemo(() => {
    const map = new Map<string, string>()
    fields.forEach(field => {
      map.set(field.id, field.name)
    })
    return map
  }, [fields])

  const fieldNameToIdMap = useMemo(() => {
    const map = new Map<string, string>()
    fields.forEach(field => {
      map.set(field.name, field.id)
    })
    return map
  }, [fields])

  const fieldIdToFieldMap = useMemo(() => {
    const map = new Map<string, Field>()
    fields.forEach(field => {
      map.set(field.id, field)
    })
    return map
  }, [fields])

  const cardTitleFieldName = useMemo(
    () => (kanbanConfig.cardTitleField ? fieldIdToNameMap.get(kanbanConfig.cardTitleField) : undefined),
    [kanbanConfig.cardTitleField, fieldIdToNameMap]
  )

  const cardCoverFieldName = useMemo(
    () => (kanbanConfig.cardCoverField ? fieldIdToNameMap.get(kanbanConfig.cardCoverField) : undefined),
    [kanbanConfig.cardCoverField, fieldIdToNameMap]
  )

  const getRecordFieldValue = useCallback(
    (record: any, fieldIdOrName?: string): unknown => {
      if (!fieldIdOrName) {
        return undefined
      }

      const fieldId = fieldIdToNameMap.has(fieldIdOrName)
        ? fieldIdOrName
        : fieldNameToIdMap.get(fieldIdOrName)
      const fieldName = (fieldId ? fieldIdToNameMap.get(fieldId) : undefined) ?? fieldIdOrName

      const recordFields =
        record && typeof record === 'object' && record.fields && typeof record.fields === 'object'
          ? (record.fields as Record<string, unknown>)
          : undefined
      const recordData =
        record && typeof record === 'object' && record.data && typeof record.data === 'object'
          ? (record.data as Record<string, unknown>)
          : (record as Record<string, unknown> | undefined)

      return (
        (fieldId ? recordFields?.[fieldId] : undefined) ??
        recordFields?.[fieldIdOrName] ??
        recordFields?.[fieldName] ??
        (fieldId ? recordData?.[fieldId] : undefined) ??
        recordData?.[fieldIdOrName] ??
        recordData?.[fieldName] ??
        (record && typeof record === 'object'
          ? (fieldId ? (record as Record<string, unknown>)[fieldId] : undefined) ??
            (record as Record<string, unknown>)[fieldIdOrName] ??
            (record as Record<string, unknown>)[fieldName]
          : undefined)
      )
    },
    [fieldIdToNameMap, fieldNameToIdMap]
  )

  const visibleFieldIds = useMemo(() => {
    const ids = (kanbanConfig.visibleFields ?? []).filter(Boolean) as string[]
    return ids.filter(id => id !== kanbanConfig.cardTitleField).slice(0, 6)
  }, [kanbanConfig.visibleFields, kanbanConfig.cardTitleField])

  const getRecordTitle = useCallback(
    (record: any): string => {
      const titleFieldRef = cardTitleFieldName ?? kanbanConfig.cardTitleField
      if (titleFieldRef) {
        const configuredTitleField = kanbanConfig.cardTitleField
        const titleFieldId =
          configuredTitleField && fieldIdToFieldMap.has(configuredTitleField)
            ? configuredTitleField
            : fieldNameToIdMap.get(titleFieldRef)
        const titleField = titleFieldId ? fieldIdToFieldMap.get(titleFieldId) : undefined
        const rawTitle = getRecordFieldValue(record, titleFieldRef)
        const displayTitle = titleField
          ? formatFieldDisplayValue(rawTitle, titleField, {
              emptyLabel: '',
              userDisplayNameById,
            })
          : rawTitle
        return resolveConfiguredCardTitle(displayTitle)
      }

      return (
        toTitleText(getRecordFieldValue(record, 'name')) ??
        toTitleText(getRecordFieldValue(record, 'title')) ??
        DEFAULT_UNTITLED_RECORD_TITLE
      )
    },
    [
      cardTitleFieldName,
      fieldIdToFieldMap,
      fieldNameToIdMap,
      getRecordFieldValue,
      kanbanConfig.cardTitleField,
      userDisplayNameById,
    ]
  )

  const groups = useMemo<KanbanGroup[]>(() => {
    const baseGroups = new Map<
      string | null,
      { label: string; value: string | null; rawValue: unknown; records: any[]; isFallback: boolean }
    >()
    const groupFieldId = kanbanConfig.groupByField
    const groupFieldName = groupFieldId ? fieldIdToNameMap.get(groupFieldId) : undefined
    const groupField = groupFieldId ? fieldIdToFieldMap.get(groupFieldId) : undefined
    const ungroupedLabel = t('labels.ungrouped')

    records.forEach((record: any) => {
      const rawGroupValue = groupFieldId ? getRecordFieldValue(record, groupFieldId) : undefined
      const labelValue = groupFieldName ? getRecordFieldValue(record, groupFieldName) : rawGroupValue
      const hasRealValue = !isUnsetGroupValue(rawGroupValue)
      const presentation = getGroupPresentation(
        rawGroupValue,
        groupField,
        ungroupedLabel,
        userDisplayNameById,
      )
      const key = presentation.key
      const preferResolvedMemberLabel = Boolean(
        groupField && USER_FIELD_TYPES.has(groupField.field_type)
      )
      const label = preferResolvedMemberLabel
        ? presentation.label
        : typeof labelValue === 'string' && labelValue.trim().length > 0
          ? labelValue
          : presentation.label
      const existing = baseGroups.get(key)
      if (existing) {
        existing.records.push(record)
      } else {
        baseGroups.set(key, {
          label,
          // 对后端分页/拖拽继续使用既有传输值；canonical key 只用于前端归桶。
          value: getGroupTransportValue(rawGroupValue),
          rawValue: hasRealValue ? rawGroupValue : undefined,
          records: [record],
          isFallback: !hasRealValue,
        })
      }
    })

    const metadataGroups = currentViewRecords?.metadata?.groups
    if (Array.isArray(metadataGroups) && metadataGroups.length > 0) {
      const ordered: KanbanGroup[] = []
      const orderedByKey = new Map<string | null, KanbanGroup>()

      const appendGroup = (key: string | null, group: KanbanGroup) => {
        const existing = orderedByKey.get(key)
        if (!existing) {
          ordered.push(group)
          orderedByKey.set(key, group)
          return
        }
        existing.records = mergeGroupRecords(existing.records, group.records)
        existing.count = Math.max(existing.count, group.count, existing.records.length)
        existing.rawValue = existing.rawValue ?? group.rawValue
        existing.label = existing.label || group.label
        existing.hasMore = existing.hasMore || group.hasMore
        existing.offset = Math.max(existing.offset, group.offset)
      }

      metadataGroups.forEach((group, index) => {
        const rawValue = group.group_value
        const recordsFromMetadata = Array.isArray(group.records) ? group.records : undefined
        const preferResolvedMemberLabel = Boolean(
          groupField && USER_FIELD_TYPES.has(groupField.field_type)
        )
        const decodedMetadataValue = preferResolvedMemberLabel
          ? parseSerializedMemberGroupValue(rawValue)
          : rawValue
        let recordGroupValue: unknown
        if (preferResolvedMemberLabel && groupFieldId && recordsFromMetadata) {
          for (const record of recordsFromMetadata) {
            const candidate = getRecordFieldValue(record, groupFieldId)
            if (!isUnsetGroupValue(candidate)) {
              recordGroupValue = candidate
              break
            }
          }
        }
        // REST kanban metadata may serialize a JSONB string group as `"member-id"`
        // while the records in that group still carry the canonical member id. Use
        // the record value for presentation and write-back, but keep group_value as
        // the transport value used by group pagination.
        const presentationValue = recordGroupValue ?? decodedMetadataValue
        const hasRealValue = !isUnsetGroupValue(presentationValue)
        const presentation = getGroupPresentation(
          presentationValue,
          groupField,
          ungroupedLabel,
          userDisplayNameById,
        )
        const key = presentation.key
        const base = baseGroups.get(key)
        const label =
          (preferResolvedMemberLabel ? presentation.label : undefined) ??
          (typeof group.group_label === 'string' && group.group_label.trim().length > 0 ? group.group_label : undefined) ??
          base?.label ??
          presentation.label
        const recordsForGroup = recordsFromMetadata ?? base?.records ?? []
        const count =
          group.count ??
          (Array.isArray(recordsFromMetadata) ? recordsFromMetadata.length : recordsForGroup.length)

        appendGroup(key, {
          id: `${key || 'group'}-${index}`,
          label,
          value: base?.value ?? getGroupTransportValue(rawValue),
          rawValue: hasRealValue ? presentationValue : undefined,
          records: recordsForGroup,
          count,
          isFallback: base?.isFallback ?? !hasRealValue,
          hasMore: Boolean(group.has_more),
          offset: typeof group.offset === 'number' ? group.offset : 0,
        })

        if (base) {
          baseGroups.delete(key)
        }
      })

      baseGroups.forEach((base, key) => {
        appendGroup(key, {
          id: `${key || 'group'}-${ordered.length}`,
          label: base.label ?? ungroupedLabel,
          value: base.value,
          rawValue: base.rawValue ?? (base.isFallback ? undefined : key),
          records: base.records,
          count: base.records.length,
          isFallback: base.isFallback,
          hasMore: false,
          offset: 0,
        })
      })

      return ordered
    }

    if (baseGroups.size === 0) {
      return [
        {
          id: 'kanban-empty',
          label: ungroupedLabel,
          value: null,
          rawValue: undefined,
          records: [],
          count: 0,
          isFallback: true,
          hasMore: false,
          offset: 0,
        },
      ]
    }

    const result: KanbanGroup[] = []
    baseGroups.forEach((base, key) => {
      result.push({
        // 列 id 基于分组值（稳定 key），不含序号——避免列重排时 React 重挂、丢失折叠态。
        id: `kbn-group-${key ?? '__ungrouped__'}`,
        label: base.label ?? ungroupedLabel,
        value: base.value,
        rawValue: base.rawValue ?? (base.isFallback ? undefined : key),
        records: base.records,
        count: base.records.length,
        isFallback: base.isFallback,
        hasMore: false,
        offset: 0,
      })
    })

    // ：列序按分组字段「选项顺序」固定，与记录顺序/拖拽无关（拖卡换组时列不重排）；
    // unset 列置末；无选项的字段（如文本分组）按值稳定排序兜底。
    const choiceOrder = new Map<string, number>()
    const choices =
      (groupField?.options as { choices?: unknown[] } | undefined)?.choices ?? []
    choices.forEach((choice, i) => {
      const value =
        typeof choice === 'string'
          ? choice
          : String(
              (choice as Record<string, unknown>)?.value ??
                (choice as Record<string, unknown>)?.name ??
                '',
            )
      if (value) choiceOrder.set(value, i)
    })
    const orderIndexOf = (group: KanbanGroup): number =>
      group.value != null && choiceOrder.has(group.value)
        ? (choiceOrder.get(group.value) as number)
        : Number.MAX_SAFE_INTEGER
    result.sort((a, b) => {
      if (a.isFallback !== b.isFallback) return a.isFallback ? 1 : -1
      const ai = orderIndexOf(a)
      const bi = orderIndexOf(b)
      if (ai !== bi) return ai - bi
      return String(a.value ?? '').localeCompare(String(b.value ?? ''))
    })

    return result
  }, [
    currentViewRecords,
    fieldIdToFieldMap,
    fieldIdToNameMap,
    getRecordFieldValue,
    kanbanConfig.groupByField,
    records,
    t,
    userDisplayNameById,
  ])

  const handleCardClick = useCallback(
    (record: any) => {
      // 记录抽屉表单按「字段名」读取 record.data（与 grid 直接透传原始记录一致）。
      // 不能取 record.fields（按字段 id 键），否则表单匹配不到字段、回填为空。
      const tableRecord: TableRecord = {
        id: record.id ?? record._id ?? record.__id,
        table_id: record.table_id ?? selectedTableId ?? '',
        data:
          record && typeof record === 'object' && record.data && typeof record.data === 'object'
            ? (record.data as Record<string, unknown>)
            : {},
        fields:
          record && typeof record === 'object' && record.fields && typeof record.fields === 'object'
            ? (record.fields as Record<string, unknown>)
            : undefined,
        created_at: record.created_at ?? '',
        updated_at: record.updated_at ?? '',
        created_by_id: record.created_by_id ?? '',
      }
      setSelectedRecord(tableRecord)
      setDialogMode('edit')
      setCreateDefaults(undefined)
      setIsRecordDialogOpen(true)
    },
    [selectedTableId]
  )

  const handleCreateCard = useCallback(
    (group: KanbanGroup) => {
      setSelectedRecord(null)
      setDialogMode('create')

      if (kanbanConfig.groupByField) {
        const groupFieldName = fieldIdToNameMap.get(kanbanConfig.groupByField)
        if (groupFieldName && !group.isFallback && group.rawValue !== undefined) {
          setCreateDefaults({ [groupFieldName]: group.rawValue } as RecordFormData)
        } else {
          setCreateDefaults(undefined)
        }
      } else {
        setCreateDefaults(undefined)
      }

      setIsRecordDialogOpen(true)
    },
    [fieldIdToNameMap, kanbanConfig.groupByField]
  )

  const handleDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setIsRecordDialogOpen(false)
      setSelectedRecord(null)
      setCreateDefaults(undefined)
      setDialogMode('edit')
    } else {
      setIsRecordDialogOpen(true)
    }
  }, [])

  return {
    currentView,
    kanbanConfig,
    groups,
    fieldIdToNameMap,
    getRecordFieldValue,
    getRecordTitle,
    fieldIdToFieldMap,
    cardTitleFieldName,
    cardCoverFieldName,
    visibleFieldIds,
    selectedRecord,
    dialogMode,
    isRecordDialogOpen,
    createDefaults,
    handleCardClick,
    handleCreateCard,
    handleDialogOpenChange,
  }
}
