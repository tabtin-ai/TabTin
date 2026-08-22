import { useCallback, useMemo } from 'react'
import type { Field, ViewMeta, ViewRecordsResponse, TableRecord } from '../types'
import { formatFieldDisplayValue } from './cellValueUtils'
import { getViewVisibilitySnapshot } from '../utils/viewVisibility'

/**
 * 单个 occurrence 的可视化信息（一个事件可能含多个 occurrence）。
 */
export interface CalendarEventOccurrence {
  /** 该 occurrence 落在哪一天，'YYYY-MM-DD'（按 settings.TIME_ZONE 的本地日） */
  date: string
  /** 是否事件起始日（条带左端） */
  is_start: boolean
  /** 是否事件结束日（条带右端） */
  is_end: boolean
  /** 该 occurrence 在事件中的全局序号（从 0 起，相对查询窗口裁剪前的起点） */
  occurrence_index: number
}

/**
 * 后端 calendar 响应里 records[*] 的形状契约（与
 * `apps/tabtin_django/apps/tabdata/services/view_calendar_service.py` 顶部 docstring 严格对齐）。
 *
 * 每个 wrapper 表示「某条 TableRecord 在某一天上的一个 occurrence」。同一事件
 * 跨多日时，后端会展开成多个 wrapper，前端按 record.id 聚合成一个
 * `CalendarEventItem`。
 */
export interface CalendarOccurrenceWrapper {
  date: string
  record: TableRecord
  is_start: boolean
  is_end: boolean
  span_total_days: number
  occurrence_index: number
  dirty: boolean
  truncated: boolean
}

/**
 * 一个日历事件 = 一条 TableRecord 在查询窗口内的全部 occurrence 聚合。
 *
 * Wave 3 条带渲染会消费 `occurrences` + `span_total_days` + `dirty` / `truncated`。
 * Wave 2 月格列表渲染只看 `id` / `title` / `data` / `raw`，但通过 controller 的
 * `groupedByDate` 让多日事件在每一天都出现一次（不做条带）。
 */
export interface CalendarEventItem {
  /** 与 record.id 一致 */
  id: string
  /** 事件起始日（即第一个 occurrence 的 date）。多日事件渲染条带时改用 occurrences[0].date 等价 */
  date: string
  /** 事件展示标题 */
  title: string
  /** record.data（反序列化后的字段值字典，按字段 ID/名兼容查找） */
  data: Record<string, unknown>
  /** 完整 TableRecord（点击事件打开详情时使用） */
  raw: TableRecord
  /** 该事件在查询窗口内的所有 occurrence，按 occurrence_index 升序 */
  occurrences: CalendarEventOccurrence[]
  /** 事件总跨度（含起止日）。单点事件为 1。已被 _MAX_OCCURRENCE_SPAN_DAYS 截断时为截断后的值 */
  span_total_days: number
  /** 是否多日事件（>1 天） */
  is_multi_day: boolean
  /** 是否脏数据：end<start，按单点处理；UI 可显示 warning icon */
  dirty: boolean
  /** 是否被 _MAX_OCCURRENCE_SPAN_DAYS=366 截断；UI 可提示"事件实际更长" */
  truncated: boolean
}

export interface UseCalendarViewControllerInput {
  views: ViewMeta[]
  currentViewId: string | null
  currentViewOverride?: ViewMeta | null
  currentViewRecords: ViewRecordsResponse | null
  fields: Field[]
  t: (key: string, options?: Record<string, unknown>) => string
}

export interface CalendarViewControllerState {
  currentView: ViewMeta | undefined
  /** 按 record.id 聚合后的事件列表，每个事件一个对象 */
  events: CalendarEventItem[]
  /**
   * 按 occurrence 日期分组：多日事件会在它跨越的每一天里都出现一次。
   * Wave 2 月格列表用这个；Wave 3 条带渲染会基于 `events` + `occurrences` 自己布局。
   */
  groupedByDate: Array<[string, CalendarEventItem[]]>
  /** 后端返回的查询窗口（来自 metadata.date_range，或 undefined） */
  dateRange: { start?: string; end?: string } | undefined
  /** 后端是否已配置 end_date_field（来自 metadata.end_date_field） */
  endDateField: string | undefined
  /** 当前页 occurrence 总数（来自 metadata.occurrence_count） */
  occurrenceCount: number | undefined
  calendarVisibleFieldIds: string[]
  calendarFieldNameMap: Map<string, string>
  getEventFieldValue: (event: CalendarEventItem, fieldId: string) => unknown
}

/**
 * 解析后端 wrapper：宽容地确认 wrapper 形状，并 narrow 出 record。
 * 字段缺失/类型异常都返回 null（防御后端契约漂移，但不写"先扁平 fail 再 wrapper"那种 fallback）。
 */
function readWrapper(raw: unknown): CalendarOccurrenceWrapper | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>
  const record = w.record
  if (!record || typeof record !== 'object') return null
  const date = typeof w.date === 'string' ? w.date : ''
  if (!date) return null
  return {
    date,
    record: record as TableRecord,
    is_start: w.is_start === true,
    is_end: w.is_end === true,
    span_total_days:
      typeof w.span_total_days === 'number' && Number.isFinite(w.span_total_days)
        ? w.span_total_days
        : 1,
    occurrence_index:
      typeof w.occurrence_index === 'number' && Number.isFinite(w.occurrence_index)
        ? w.occurrence_index
        : 0,
    dirty: w.dirty === true,
    truncated: w.truncated === true,
  }
}

/** 防御性 record 取数据字典（兼容 .data / .fields / 顶层字段三种结构）。 */
function pickRecordData(record: TableRecord): Record<string, unknown> {
  const data = (record as { data?: unknown }).data
  if (data && typeof data === 'object') return data as Record<string, unknown>
  const fields = (record as { fields?: unknown }).fields
  if (fields && typeof fields === 'object') return fields as Record<string, unknown>
  return record as unknown as Record<string, unknown>
}

function resolveTitleText(value: unknown, field?: Field): string | undefined {
  if (value == null) return undefined
  if (field) {
    const formatted = formatFieldDisplayValue(value, field, { emptyLabel: '' }).trim()
    if (formatted) return formatted
  }
  const text = String(value).trim()
  return text ? text : undefined
}

export const useCalendarViewController = (
  input: UseCalendarViewControllerInput
): CalendarViewControllerState => {
  const { views, currentViewId, currentViewOverride, currentViewRecords, fields, t } = input

  const currentView = useMemo(
    () => currentViewOverride ?? views.find(view => view.id === currentViewId),
    [currentViewOverride, views, currentViewId]
  )

  const calendarFieldNameMap = useMemo(() => {
    const map = new Map<string, string>()
    fields.forEach(field => {
      map.set(field.id, field.name)
    })
    return map
  }, [fields])

  const calendarFieldIdMap = useMemo(() => {
    const map = new Map<string, string>()
    fields.forEach(field => {
      map.set(field.name, field.id)
    })
    return map
  }, [fields])

  const fieldById = useMemo(() => {
    const map = new Map<string, Field>()
    fields.forEach(field => {
      map.set(field.id, field)
    })
    return map
  }, [fields])

  const resolveTitleField = useCallback(
    (fieldIdOrName?: string): Field | undefined => {
      if (!fieldIdOrName) return undefined
      if (fieldById.has(fieldIdOrName)) return fieldById.get(fieldIdOrName)
      const fieldId = calendarFieldIdMap.get(fieldIdOrName)
      if (fieldId) return fieldById.get(fieldId)
      return fields.find(field => field.name === fieldIdOrName)
    },
    [calendarFieldIdMap, fieldById, fields],
  )

  /**
   * 兼容字段 ID/字段名 + record.data / record.fields / 顶层平铺三种存放形式取值。
   * 这是字段维度兼容（与"是否 wrapper"无关），纯 record 内部数据访问。
   */
  const resolveRecordFieldValue = useCallback(
    (record: TableRecord | undefined, fieldIdOrName?: string): unknown => {
      if (!fieldIdOrName || !record) return undefined

      const data = pickRecordData(record)
      const recordFields = (record as { fields?: unknown }).fields
      const fieldsObj =
        recordFields && typeof recordFields === 'object'
          ? (recordFields as Record<string, unknown>)
          : undefined

      const fieldId = calendarFieldNameMap.has(fieldIdOrName)
        ? fieldIdOrName
        : calendarFieldIdMap.get(fieldIdOrName)
      const fieldName = (fieldId ? calendarFieldNameMap.get(fieldId) : undefined) ?? fieldIdOrName

      return (
        (fieldId ? fieldsObj?.[fieldId] : undefined) ??
        fieldsObj?.[fieldIdOrName] ??
        fieldsObj?.[fieldName] ??
        data?.[fieldName] ??
        data?.[fieldIdOrName] ??
        (fieldId ? data?.[fieldId] : undefined) ??
        (record as Record<string, unknown>)[fieldName] ??
        (record as Record<string, unknown>)[fieldIdOrName] ??
        (fieldId ? (record as Record<string, unknown>)[fieldId] : undefined)
      )
    },
    [calendarFieldIdMap, calendarFieldNameMap]
  )

  const dateField = (currentView?.config as Record<string, unknown> | undefined)?.date_field as
    | string
    | undefined
  const titleField = (currentView?.config as Record<string, unknown> | undefined)?.title_field as
    | string
    | undefined

  const fallbackTitleFieldIds = useMemo(() => {
    const ids: string[] = []
    const add = (fieldId: string | undefined) => {
      if (fieldId && !ids.includes(fieldId)) ids.push(fieldId)
    }

    add(titleField)
    add(fields.find(field => field.is_primary)?.id)
    add(fields.find(field => field.field_type === 'text')?.id)
    return ids
  }, [fields, titleField])

  /**
   * 把 wrapper 列表 → 按 record.id 聚合的事件列表。
   *
   * 设计原则（Wave 2 ≪薄一层≫）：
   * - 不做布局/lane 分配/跨周断条（那些归 Wave 3 渲染层）
   * - 同 record 的 occurrence 按 occurrence_index 升序排列，与后端展开序保持一致；
   *   不重新分配序号、不做合并去重——这些都是 Wave 3 渲染层的活
   * - 不在前端再算 is_start / is_end / span_total_days（直接透传后端）
   * - 防御 wrapper 缺字段，但不写"先扁平 fail 再 wrapper"那种 fallback：
   *   契约就是 wrapper，任何不是 wrapper 的元素跳过
   */
  const events = useMemo<CalendarEventItem[]>(() => {
    if (!currentViewRecords || !dateField) return []
    const rawList = (currentViewRecords as { records?: unknown }).records
    if (!Array.isArray(rawList) || rawList.length === 0) return []

    const byId = new Map<string, { event: CalendarEventItem; recordRef: TableRecord }>()
    const orderedIds: string[] = []
    let anonymousCounter = 0

    for (const rawItem of rawList) {
      const wrapper = readWrapper(rawItem)
      if (!wrapper) continue

      const record = wrapper.record
      const rawId = (record as { id?: unknown }).id
      const recordId =
        typeof rawId === 'string' && rawId.length > 0
          ? rawId
          : `__anonymous_${anonymousCounter++}`

      const existing = byId.get(recordId)
      const occurrence: CalendarEventOccurrence = {
        date: wrapper.date,
        is_start: wrapper.is_start,
        is_end: wrapper.is_end,
        occurrence_index: wrapper.occurrence_index,
      }

      if (existing) {
        existing.event.occurrences.push(occurrence)
        // 同 record 多 occurrence 共享 span_total_days / dirty / truncated（后端契约保证一致）
        // 但保险起见取最大跨度，避免上游契约漂移导致的不一致
        if (wrapper.span_total_days > existing.event.span_total_days) {
          existing.event.span_total_days = wrapper.span_total_days
        }
        existing.event.dirty = existing.event.dirty || wrapper.dirty
        existing.event.truncated = existing.event.truncated || wrapper.truncated
      } else {
        const data = pickRecordData(record)
        const configuredTitle = fallbackTitleFieldIds
          .map(fieldId =>
            resolveTitleText(
              resolveRecordFieldValue(record, fieldId),
              resolveTitleField(fieldId),
            ),
          )
          .find((value): value is string => Boolean(value))
        const fallbackTitle =
          configuredTitle ||
          resolveTitleText(resolveRecordFieldValue(record, 'name')) ||
          resolveTitleText(resolveRecordFieldValue(record, 'title')) ||
          t('calendar.untitledEvent')

        byId.set(recordId, {
          event: {
            id: recordId,
            date: wrapper.date,
            title: fallbackTitle,
            data,
            raw: record,
            occurrences: [occurrence],
            span_total_days: wrapper.span_total_days,
            is_multi_day: wrapper.span_total_days > 1,
            dirty: wrapper.dirty,
            truncated: wrapper.truncated,
          },
          recordRef: record,
        })
        orderedIds.push(recordId)
      }
    }

    return orderedIds.map(id => {
      const entry = byId.get(id)!
      const occs = entry.event.occurrences.slice().sort(
        (a, b) => a.occurrence_index - b.occurrence_index
      )
      const firstDate = occs[0]?.date ?? entry.event.date
      return {
        ...entry.event,
        occurrences: occs,
        date: firstDate,
        is_multi_day: entry.event.span_total_days > 1 || occs.length > 1,
      }
    })
  }, [currentViewRecords, dateField, fallbackTitleFieldIds, resolveRecordFieldValue, resolveTitleField, t])

  /**
   * 按 occurrence 日期分组：跨天事件会在它覆盖到的每一天都出现一次。
   *
   * key 是后端给的本地日字符串（'YYYY-MM-DD'）。`readWrapper` 已经把缺日期的 wrapper
   * 过滤掉，所以这里所有 key 都是合法日期，**调用方可以直接 `map.get('2026-04-09')`**
   * 不需要再做正则裁剪或兜底。
   *
   * Wave 2 月格视图直接消费这个；Wave 3 改条带渲染时改成基于 `events` + `occurrences`
   * 计算 lane，这个 map 仍可用于次要场景（如 agenda-style 列表，虽然产品已决定不做
   * agenda 视图）。
   */
  const groupedByDate = useMemo(() => {
    const map = new Map<string, CalendarEventItem[]>()
    for (const event of events) {
      for (const occ of event.occurrences) {
        if (!occ.date) continue
        if (!map.has(occ.date)) map.set(occ.date, [])
        map.get(occ.date)!.push(event)
      }
    }
    return Array.from(map.entries()).sort(([a], [b]) => (a > b ? 1 : -1))
  }, [events])

  const metadata = (currentViewRecords?.metadata ?? {}) as Record<string, unknown>

  const dateRange = useMemo<{ start?: string; end?: string } | undefined>(() => {
    const raw = metadata.date_range
    if (typeof raw === 'string' && raw.length > 0) {
      const [start, end] = raw.split(',')
      return { start: start?.trim() || undefined, end: end?.trim() || undefined }
    }
    if (raw && typeof raw === 'object') {
      const obj = raw as { start?: unknown; end?: unknown }
      return {
        start: typeof obj.start === 'string' ? obj.start : undefined,
        end: typeof obj.end === 'string' ? obj.end : undefined,
      }
    }
    return undefined
  }, [metadata])

  const endDateField =
    typeof metadata.end_date_field === 'string' ? (metadata.end_date_field as string) : undefined
  const occurrenceCount =
    typeof metadata.occurrence_count === 'number'
      ? (metadata.occurrence_count as number)
      : undefined

  const { visibleFieldIds: calendarVisibleFieldIds } = useMemo(
    () => getViewVisibilitySnapshot(currentView ?? null, fields),
    [currentView, fields]
  )

  const getEventFieldValue = useCallback(
    (event: CalendarEventItem, fieldId: string): unknown => {
      return resolveRecordFieldValue(event.raw, fieldId)
    },
    [resolveRecordFieldValue]
  )

  return {
    currentView,
    events,
    groupedByDate,
    dateRange,
    endDateField,
    occurrenceCount,
    calendarVisibleFieldIds,
    calendarFieldNameMap,
    getEventFieldValue,
  }
}
