import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Field, ViewMeta, ViewRecordsResponse } from '../types'
import {
  resolveGalleryCardSize,
  type GalleryCardSize,
} from '../utils/galleryCardLayout'
import { getViewVisibilitySnapshot } from '../utils/viewVisibility'
import {
  DEFAULT_UNTITLED_RECORD_TITLE,
  resolveConfiguredCardTitle,
  toTitleText,
} from '../utils/viewCardTitle'

export { DEFAULT_UNTITLED_RECORD_TITLE } from '../utils/viewCardTitle'

export interface UseGalleryViewControllerInput {
  views: ViewMeta[]
  currentViewId: string | null
  currentViewRecords: ViewRecordsResponse | null
  fields: Field[]
}

export interface GalleryViewControllerState {
  currentView: ViewMeta | undefined
  records: any[]
  galleryVisibleFieldIds: string[]
  fieldMap: Map<string, Field>
  imageErrors: Set<string>
  cardSize: GalleryCardSize
  titleField: string | undefined
  coverField: string | undefined
  descriptionField: string | undefined
  titleFieldName: string | undefined
  coverFieldName: string | undefined
  descriptionFieldName: string | undefined
  getRecordFieldValue: (record: any, fieldIdOrName?: string) => unknown
  getRecordTitle: (record: any) => string
  getRecordTitleFieldId: (record: any) => string | undefined
  getRecordDescription: (record: any) => string | undefined
  getGalleryCardFieldIds: (record: any) => string[]
  handleImageError: (recordId: string) => void
}

export const useGalleryViewController = (
  input: UseGalleryViewControllerInput
): GalleryViewControllerState => {
  const { views, currentViewId, currentViewRecords, fields } = input

  const [imageErrors, setImageErrors] = useState<Set<string>>(new Set())

  const currentView = useMemo(
    () => views.find(view => view.id === currentViewId),
    [views, currentViewId]
  )

  const { visibleFieldIds: fallbackVisibleFieldIds } = useMemo(
    () => getViewVisibilitySnapshot(currentView ?? null, fields),
    [currentView, fields]
  )

  const galleryConfig = useMemo(() => {
    const config = (currentView?.config as Record<string, unknown> | undefined) ?? {}
    const configVisibleFields = config.visible_fields
    return {
      cardSize: resolveGalleryCardSize(config.card_size),
      titleField: typeof config.title_field === 'string' ? config.title_field : undefined,
      coverField: typeof config.cover_field === 'string' ? config.cover_field : undefined,
      descriptionField:
        typeof config.description_field === 'string' ? config.description_field : undefined,
      visibleFields:
        Array.isArray(configVisibleFields) && configVisibleFields.length > 0
          ? configVisibleFields.filter((fieldRef): fieldRef is string => typeof fieldRef === 'string')
          : fallbackVisibleFieldIds,
    }
  }, [currentView, fallbackVisibleFieldIds])

  const cardSize = galleryConfig.cardSize
  const titleField = galleryConfig.titleField
  const coverField = galleryConfig.coverField
  const descriptionField = galleryConfig.descriptionField

  const fieldMap = useMemo(() => {
    const map = new Map<string, Field>()
    fields.forEach(field => {
      map.set(field.id, field)
    })
    return map
  }, [fields])

  const fieldIdByName = useMemo(() => {
    const map = new Map<string, string>()
    fields.forEach(field => {
      map.set(field.name, field.id)
    })
    return map
  }, [fields])

  const titleFieldName = titleField ? fieldMap.get(titleField)?.name ?? titleField : undefined
  const coverFieldName = coverField ? fieldMap.get(coverField)?.name ?? coverField : undefined
  const descriptionFieldName = descriptionField
    ? fieldMap.get(descriptionField)?.name ?? descriptionField
    : undefined

  const fallbackTitleFieldIds = useMemo(() => {
    const ids: string[] = []
    const add = (fieldRef: string | undefined) => {
      if (!fieldRef) return
      const fieldId = fieldMap.has(fieldRef) ? fieldRef : fieldIdByName.get(fieldRef)
      if (fieldId && !ids.includes(fieldId)) ids.push(fieldId)
    }

    // 已显式配置 title_field：只用该字段（空值走「未命名记录」），禁止静默回退主字段
    if (titleField) {
      add(titleField)
      return ids
    }

    add(fields.find(field => field.is_primary)?.id)
    add(fields.find(field => field.field_type === 'text')?.id)
    return ids
  }, [fields, titleField, fieldMap, fieldIdByName])

  const resolveFieldId = useCallback(
    (fieldRef: string | undefined): string | undefined => {
      if (!fieldRef) return undefined
      if (fieldMap.has(fieldRef)) return fieldRef
      return fieldIdByName.get(fieldRef)
    },
    [fieldMap, fieldIdByName],
  )

  /** 画廊卡片可展示的字段列表（来源与 Kanban 一致：优先 config.visible_fields）。 */
  const galleryVisibleFieldIds = useMemo(() => {
    const excluded = new Set<string>()

    const addExcluded = (fieldRef: string | undefined) => {
      const fieldId = resolveFieldId(fieldRef)
      if (fieldId) excluded.add(fieldId)
      if (fieldRef) excluded.add(fieldRef)
    }

    addExcluded(coverField)
    addExcluded(descriptionField)
    for (const fieldId of fallbackTitleFieldIds) {
      excluded.add(fieldId)
    }

    return galleryConfig.visibleFields
      .map(fieldRef => resolveFieldId(fieldRef) ?? fieldRef)
      .filter((fieldId, index, list) => fieldId && list.indexOf(fieldId) === index)
      .filter(fieldId => !excluded.has(fieldId))
  }, [
    galleryConfig.visibleFields,
    coverField,
    descriptionField,
    fallbackTitleFieldIds,
    resolveFieldId,
  ])

  const records = currentViewRecords?.records ?? []

  const prevRecordsRef = useRef(records)
  useEffect(() => {
    if (records !== prevRecordsRef.current) {
      prevRecordsRef.current = records
      setImageErrors(new Set())
    }
  }, [records])

  const getRecordFieldValue = useCallback(
    (record: any, fieldIdOrName?: string): unknown => {
      if (!fieldIdOrName) {
        return undefined
      }

      const data =
        record && typeof record === 'object' && record.data && typeof record.data === 'object'
          ? (record.data as Record<string, unknown>)
          : (record as Record<string, unknown> | undefined)

      const recordFields =
        record && typeof record === 'object' && record.fields && typeof record.fields === 'object'
          ? (record.fields as Record<string, unknown>)
          : undefined

      const fieldId = fieldMap.has(fieldIdOrName) ? fieldIdOrName : fieldIdByName.get(fieldIdOrName)
      const fieldName = (fieldId ? fieldMap.get(fieldId)?.name : undefined) ?? fieldMap.get(fieldIdOrName)?.name ?? fieldIdOrName

      return (
        (fieldId ? recordFields?.[fieldId] : undefined) ??
        recordFields?.[fieldIdOrName] ??
        recordFields?.[fieldName] ??
        data?.[fieldName] ??
        data?.[fieldIdOrName] ??
        (fieldId ? data?.[fieldId] : undefined) ??
        (record && typeof record === 'object'
          ? (record as Record<string, unknown>)[fieldName] ??
            (record as Record<string, unknown>)[fieldIdOrName] ??
            (fieldId ? (record as Record<string, unknown>)[fieldId] : undefined)
          : undefined)
      )
    },
    [fieldMap, fieldIdByName]
  )

  const getRecordTitle = useCallback(
    (record: any): string => {
      // 显式配置了标题字段：空值固定「未命名记录」，不回退主字段 / legacy / id
      if (titleField) {
        const configuredId = fallbackTitleFieldIds[0]
        const raw = getRecordFieldValue(record, configuredId ?? titleFieldName ?? titleField)
        return resolveConfiguredCardTitle(raw)
      }

      const fieldTitle = fallbackTitleFieldIds
        .map(fieldId => toTitleText(getRecordFieldValue(record, fieldId)))
        .find((value): value is string => Boolean(value))

      if (fieldTitle) return fieldTitle

      const legacyTitle =
        toTitleText(getRecordFieldValue(record, 'name')) ??
        toTitleText(getRecordFieldValue(record, 'title'))
      if (legacyTitle) return legacyTitle

      const recordId = record && typeof record === 'object'
        ? toTitleText((record as { id?: unknown }).id)
        : undefined
      return recordId ?? DEFAULT_UNTITLED_RECORD_TITLE
    },
    [fallbackTitleFieldIds, getRecordFieldValue, titleField, titleFieldName]
  )

  const getRecordTitleFieldId = useCallback(
    (record: any): string | undefined => {
      // 显式配置时始终排除该字段（即使值为空），避免卡片正文区再展示一遍
      if (titleField) {
        return fallbackTitleFieldIds[0]
      }
      for (const fieldId of fallbackTitleFieldIds) {
        if (toTitleText(getRecordFieldValue(record, fieldId))) {
          return fieldId
        }
      }
      return undefined
    },
    [fallbackTitleFieldIds, getRecordFieldValue, titleField]
  )

  const getGalleryCardFieldIds = useCallback(
    (record: any): string[] => {
      const titleFieldIdForRecord = getRecordTitleFieldId(record)
      if (!titleFieldIdForRecord) return galleryVisibleFieldIds
      return galleryVisibleFieldIds.filter(fieldId => fieldId !== titleFieldIdForRecord)
    },
    [galleryVisibleFieldIds, getRecordTitleFieldId]
  )

  const getRecordDescription = useCallback(
    (record: any): string | undefined => {
      const descFieldRef = descriptionFieldName ?? descriptionField
      if (!descFieldRef) return undefined
      return toTitleText(getRecordFieldValue(record, descFieldRef))
    },
    [descriptionField, descriptionFieldName, getRecordFieldValue]
  )

  const handleImageError = useCallback((recordId: string) => {
    setImageErrors(prev => new Set(prev).add(recordId))
  }, [])

  return {
    currentView,
    records,
    galleryVisibleFieldIds,
    fieldMap,
    imageErrors,
    cardSize,
    titleField,
    coverField,
    descriptionField,
    titleFieldName,
    coverFieldName,
    descriptionFieldName,
    getRecordFieldValue,
    getRecordTitle,
    getRecordTitleFieldId,
    getRecordDescription,
    getGalleryCardFieldIds,
    handleImageError,
  }
}
