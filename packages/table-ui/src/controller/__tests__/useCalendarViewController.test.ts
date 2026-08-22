import { renderHook } from '@testing-library/react'
import {
  useCalendarViewController,
  type CalendarOccurrenceWrapper,
} from '../useCalendarViewController'
import type { Field, ViewMeta, ViewRecordsResponse, TableRecord } from '../../types'

/**
 * 测试 mock 严格按 Wave 1 后端契约（view_calendar_service.py 顶部 docstring）造数据：
 *
 *   { date, record, is_start, is_end, span_total_days, occurrence_index, dirty, truncated }
 *
 * 不再造旧扁平形状（产品未上线，不留兼容）。
 */

const createField = (
  id: string,
  name: string,
  fieldType: string = 'text',
  overrides: Partial<Field> = {}
): Field => ({
  id,
  table_id: 'table-1',
  name,
  field_type: fieldType,
  is_primary: false,
  is_hidden: false,
  sort_order: 0,
  created_at: '',
  updated_at: '',
  ...overrides,
})

const createView = (config: Record<string, unknown>): ViewMeta => ({
  id: 'view-1',
  table_id: 'table-1',
  name: 'Calendar',
  view_type: 'calendar',
  filters: [],
  sorts: [],
  groups: [],
  visible_fields: [],
  field_order: [],
  config,
  is_shared: false,
  is_locked: false,
  order: 0,
  created_at: '',
})

const createRecord = (
  id: string,
  data: Record<string, unknown>,
  overrides: Partial<TableRecord> = {}
): TableRecord => ({
  id,
  table_id: 'table-1',
  created_by_id: 'u1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  data,
  ...overrides,
})

const wrap = (
  date: string,
  record: TableRecord,
  overrides: Partial<CalendarOccurrenceWrapper> = {}
): CalendarOccurrenceWrapper => ({
  date,
  record,
  is_start: true,
  is_end: true,
  span_total_days: 1,
  occurrence_index: 0,
  dirty: false,
  truncated: false,
  ...overrides,
})

const buildResponse = (
  view: ViewMeta,
  wrappers: CalendarOccurrenceWrapper[],
  metadata: Record<string, unknown> = {}
): ViewRecordsResponse =>
  ({
    view: {
      id: view.id,
      name: view.name,
      view_type: view.view_type,
      config: view.config,
    },
    total: new Set(wrappers.map(w => w.record.id)).size,
    matched_total: new Set(wrappers.map(w => w.record.id)).size,
    page: 1,
    page_size: 50,
    metadata: {
      view_type: 'calendar',
      pagination_unit: 'record',
      occurrence_count: wrappers.length,
      ...metadata,
    },
    records: wrappers as unknown as TableRecord[],
  }) as ViewRecordsResponse

describe('useCalendarViewController', () => {
  it('优先使用协作态传入的有效视图配置', () => {
    const fields: Field[] = [createField('f_date', '日期', 'date')]
    const staleView = createView({})
    const effectiveView = {
      ...staleView,
      config: { date_field: 'f_date' },
    }

    const { result } = renderHook(() =>
      useCalendarViewController({
        views: [staleView],
        currentViewId: staleView.id,
        currentViewOverride: effectiveView,
        currentViewRecords: buildResponse(effectiveView, []),
        fields,
        t: (key: string) => key,
      }),
    )

    expect(result.current.currentView).toBe(effectiveView)
  })

  it('单点事件：每个 record 1 个 wrapper → 1 个 event with 1 occurrence', () => {
    const fields: Field[] = [
      createField('f_date', 'Due Date', 'date'),
      createField('f_title', 'Task Title'),
    ]
    const view = createView({ date_field: 'f_date', title_field: 'f_title' })

    const r1 = createRecord('row-1', { 'Due Date': '2026-04-09', 'Task Title': '阿里 A 轮' })
    const r2 = createRecord('row-2', { 'Due Date': '2026-04-09', 'Task Title': '腾讯 B 轮' })
    const r3 = createRecord('row-3', { 'Due Date': '2026-04-09', 'Task Title': '字节 C 轮' })

    const response = buildResponse(view, [
      wrap('2026-04-09', r1),
      wrap('2026-04-09', r2),
      wrap('2026-04-09', r3),
    ])

    const { result } = renderHook(() =>
      useCalendarViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: response,
        fields,
        t: (key: string) => key,
      })
    )

    expect(result.current.events).toHaveLength(3)
    expect(result.current.events.map(e => e.id)).toEqual(['row-1', 'row-2', 'row-3'])
    expect(result.current.events.map(e => e.title)).toEqual(['阿里 A 轮', '腾讯 B 轮', '字节 C 轮'])
    expect(result.current.events.every(e => e.span_total_days === 1)).toBe(true)
    expect(result.current.events.every(e => !e.is_multi_day)).toBe(true)
    expect(result.current.events.every(e => e.occurrences.length === 1)).toBe(true)
    expect(result.current.events[0].occurrences[0]).toEqual({
      date: '2026-04-09',
      is_start: true,
      is_end: true,
      occurrence_index: 0,
    })

    // groupedByDate：4/9 那格有 3 条事件（北极星）
    const grouped = new Map(result.current.groupedByDate)
    expect(grouped.get('2026-04-09')).toHaveLength(3)
    expect(grouped.get('2026-04-09')?.map(e => e.id)).toEqual(['row-1', 'row-2', 'row-3'])
  })

  it('跨天事件：1 个 record 4 个 wrapper → 1 个 event with 4 occurrences，每天都出现在 groupedByDate 里', () => {
    const fields: Field[] = [
      createField('f_start', '开始', 'date'),
      createField('f_end', '结束', 'date'),
      createField('f_title', '项目'),
    ]
    const view = createView({
      date_field: 'f_start',
      title_field: 'f_title',
      end_date_field: 'f_end',
    })

    const r = createRecord('proj-A', {
      开始: '2026-04-09',
      结束: '2026-04-12',
      项目: '产品迭代',
    })

    const response = buildResponse(
      view,
      [
        wrap('2026-04-09', r, {
          is_start: true, is_end: false,
          span_total_days: 4, occurrence_index: 0,
        }),
        wrap('2026-04-10', r, {
          is_start: false, is_end: false,
          span_total_days: 4, occurrence_index: 1,
        }),
        wrap('2026-04-11', r, {
          is_start: false, is_end: false,
          span_total_days: 4, occurrence_index: 2,
        }),
        wrap('2026-04-12', r, {
          is_start: false, is_end: true,
          span_total_days: 4, occurrence_index: 3,
        }),
      ],
      { end_date_field: 'f_end', date_range: '2026-04-01,2026-04-30' }
    )

    const { result } = renderHook(() =>
      useCalendarViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: response,
        fields,
        t: (key: string) => key,
      })
    )

    expect(result.current.events).toHaveLength(1)
    const ev = result.current.events[0]
    expect(ev.id).toBe('proj-A')
    expect(ev.title).toBe('产品迭代')
    expect(ev.span_total_days).toBe(4)
    expect(ev.is_multi_day).toBe(true)
    expect(ev.occurrences.map(o => o.date)).toEqual([
      '2026-04-09', '2026-04-10', '2026-04-11', '2026-04-12',
    ])
    expect(ev.occurrences.map(o => o.is_start)).toEqual([true, false, false, false])
    expect(ev.occurrences.map(o => o.is_end)).toEqual([false, false, false, true])
    expect(ev.occurrences.map(o => o.occurrence_index)).toEqual([0, 1, 2, 3])
    expect(ev.date).toBe('2026-04-09')
    expect(ev.dirty).toBe(false)
    expect(ev.truncated).toBe(false)

    // groupedByDate：4 天每天都能找到这一个事件
    const grouped = new Map(result.current.groupedByDate)
    expect(grouped.get('2026-04-09')).toEqual([ev])
    expect(grouped.get('2026-04-10')).toEqual([ev])
    expect(grouped.get('2026-04-11')).toEqual([ev])
    expect(grouped.get('2026-04-12')).toEqual([ev])

    expect(result.current.endDateField).toBe('f_end')
    expect(result.current.dateRange).toEqual({ start: '2026-04-01', end: '2026-04-30' })
    expect(result.current.occurrenceCount).toBe(4)
  })

  it('同窗口内多 record 各自独立：跨天事件 + 单点事件可共存', () => {
    const fields: Field[] = [
      createField('f_start', '开始', 'date'),
      createField('f_end', '结束', 'date'),
      createField('f_title', '名称'),
    ]
    const view = createView({
      date_field: 'f_start',
      title_field: 'f_title',
      end_date_field: 'f_end',
    })

    const project = createRecord('proj', { 开始: '2026-04-09', 结束: '2026-04-10', 名称: '迭代' })
    const meeting = createRecord('meeting', { 开始: '2026-04-09', 名称: '周会' })

    const response = buildResponse(view, [
      wrap('2026-04-09', project, {
        is_start: true, is_end: false, span_total_days: 2, occurrence_index: 0,
      }),
      wrap('2026-04-10', project, {
        is_start: false, is_end: true, span_total_days: 2, occurrence_index: 1,
      }),
      wrap('2026-04-09', meeting),
    ])

    const { result } = renderHook(() =>
      useCalendarViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: response,
        fields,
        t: (key: string) => key,
      })
    )

    expect(result.current.events.map(e => e.id)).toEqual(['proj', 'meeting'])
    const projEvent = result.current.events[0]
    expect(projEvent.is_multi_day).toBe(true)
    expect(projEvent.occurrences).toHaveLength(2)
    const meetingEvent = result.current.events[1]
    expect(meetingEvent.is_multi_day).toBe(false)
    expect(meetingEvent.occurrences).toHaveLength(1)

    const grouped = new Map(result.current.groupedByDate)
    expect(grouped.get('2026-04-09')?.map(e => e.id)).toEqual(['proj', 'meeting'])
    expect(grouped.get('2026-04-10')?.map(e => e.id)).toEqual(['proj'])
  })

  it('脏数据 + 截断元信息：dirty / truncated 透传到 event 上', () => {
    const fields: Field[] = [
      createField('f_start', '开始', 'date'),
      createField('f_end', '结束', 'date'),
      createField('f_title', '项目'),
    ]
    const view = createView({
      date_field: 'f_start',
      title_field: 'f_title',
      end_date_field: 'f_end',
    })

    const dirtyRec = createRecord('dirty', {
      开始: '2026-04-12', 结束: '2026-04-09', 项目: '脏数据',
    })
    const truncatedRec = createRecord('truncated', {
      开始: '2026-04-09', 结束: '9999-12-31', 项目: '超长截断',
    })

    const response = buildResponse(view, [
      wrap('2026-04-12', dirtyRec, { dirty: true }),
      wrap('2026-04-09', truncatedRec, {
        is_start: true, is_end: false,
        span_total_days: 366, occurrence_index: 0, truncated: true,
      }),
    ])

    const { result } = renderHook(() =>
      useCalendarViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: response,
        fields,
        t: (key: string) => key,
      })
    )

    expect(result.current.events.find(e => e.id === 'dirty')?.dirty).toBe(true)
    expect(result.current.events.find(e => e.id === 'truncated')?.truncated).toBe(true)
    expect(result.current.events.find(e => e.id === 'truncated')?.span_total_days).toBe(366)
  })

  it('字段名 / 字段 ID / record.fields 多种取值方式都能解析 title', () => {
    const fields: Field[] = [
      createField('f_date', 'Due Date', 'date'),
      createField('f_title', 'Task Title'),
    ]
    const view = createView({ date_field: 'f_date', title_field: 'f_title' })

    const byName = createRecord('row-name', { 'Due Date': '2026-02-06', 'Task Title': 'From data' })
    const byId = createRecord(
      'row-id',
      {},
      { fields: { f_date: '2026-02-07', f_title: 'From fields-by-id' } } as Partial<TableRecord>
    )

    const response = buildResponse(view, [wrap('2026-02-06', byName), wrap('2026-02-07', byId)])

    const { result } = renderHook(() =>
      useCalendarViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: response,
        fields,
        t: (key: string) => key,
      })
    )

    expect(result.current.events.map(e => e.title)).toEqual(['From data', 'From fields-by-id'])
  })

  it('缺 title_field 时按 primary 字段生成标题', () => {
    const fields: Field[] = [
      createField('f_date', 'Due Date', 'date'),
      createField('f_primary', 'Primary Title', 'text', { is_primary: true }),
      createField('f_text', 'Description'),
    ]
    const view = createView({ date_field: 'f_date' })
    const record = createRecord('row-primary', {
      'Due Date': '2026-02-06',
      'Primary Title': 'Primary fallback',
      Description: 'Text fallback',
    })
    const response = buildResponse(view, [wrap('2026-02-06', record)])

    const { result } = renderHook(() =>
      useCalendarViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: response,
        fields,
        t: (key: string) => key,
      })
    )

    expect(result.current.events[0].title).toBe('Primary fallback')
  })

  it('缺 title_field 且无 primary 时按第一个 text 字段生成标题', () => {
    const fields: Field[] = [
      createField('f_date', 'Due Date', 'date'),
      createField('f_text', 'Project Name'),
    ]
    const view = createView({ date_field: 'f_date' })
    const record = createRecord('row-text', {
      'Due Date': '2026-02-06',
      'Project Name': 'Text fallback',
    })
    const response = buildResponse(view, [wrap('2026-02-06', record)])

    const { result } = renderHook(() =>
      useCalendarViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: response,
        fields,
        t: (key: string) => key,
      })
    )

    expect(result.current.events[0].title).toBe('Text fallback')
  })

  it('缺 title_field 且无 primary/text 值时展示未命名记录', () => {
    const fields: Field[] = [
      createField('f_date', 'Due Date', 'date'),
      createField('f_count', 'Count', 'number'),
    ]
    const view = createView({ date_field: 'f_date' })
    const record = createRecord('row-id-fallback', {
      'Due Date': '2026-02-06',
      Count: 42,
    })
    const response = buildResponse(view, [wrap('2026-02-06', record)])

    const { result } = renderHook(() =>
      useCalendarViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: response,
        fields,
        t: (key: string) => key === 'calendar.untitledEvent' ? '未命名记录' : key,
      })
    )

    expect(result.current.events[0].title).toBe('未命名记录')
  })

  it('防御性：currentViewRecords 为空 / records 为空 / dateField 缺失 → 返回空 events', () => {
    const fields: Field[] = [createField('f_date', 'Due Date', 'date')]
    const viewNoConfig = createView({})
    const view = createView({ date_field: 'f_date', title_field: 'f_title' })

    // case 1: currentViewRecords 为 null
    const r1 = renderHook(() =>
      useCalendarViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: null,
        fields,
        t: (k: string) => k,
      })
    )
    expect(r1.result.current.events).toEqual([])
    expect(r1.result.current.groupedByDate).toEqual([])

    // case 2: records 为空
    const r2 = renderHook(() =>
      useCalendarViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: buildResponse(view, []),
        fields,
        t: (k: string) => k,
      })
    )
    expect(r2.result.current.events).toEqual([])

    // case 3: dateField 未配置
    const r3 = renderHook(() =>
      useCalendarViewController({
        views: [viewNoConfig],
        currentViewId: viewNoConfig.id,
        currentViewRecords: buildResponse(viewNoConfig, [
          wrap('2026-04-09', createRecord('x', {})),
        ]),
        fields,
        t: (k: string) => k,
      })
    )
    expect(r3.result.current.events).toEqual([])
  })

  it('防御性：wrapper 缺 record / 缺 date 的脏元素直接跳过，不抛错', () => {
    const fields: Field[] = [
      createField('f_date', 'Due Date', 'date'),
      createField('f_title', 'Task Title'),
    ]
    const view = createView({ date_field: 'f_date', title_field: 'f_title' })
    const goodRec = createRecord('good', { 'Due Date': '2026-04-09', 'Task Title': '正常' })

    const response = {
      view: { id: view.id, name: view.name, view_type: view.view_type, config: view.config },
      total: 1,
      matched_total: 1,
      page: 1,
      page_size: 50,
      metadata: { view_type: 'calendar', pagination_unit: 'record', occurrence_count: 1 },
      records: [
        // 缺 date
        { record: goodRec, is_start: true, is_end: true, span_total_days: 1, occurrence_index: 0, dirty: false, truncated: false },
        // 缺 record
        { date: '2026-04-09', is_start: true, is_end: true, span_total_days: 1, occurrence_index: 0, dirty: false, truncated: false },
        // 完全乱掉的 string
        'garbage',
        // 正常 wrapper
        wrap('2026-04-09', goodRec),
      ] as unknown as TableRecord[],
    } as ViewRecordsResponse

    const { result } = renderHook(() =>
      useCalendarViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: response,
        fields,
        t: (k: string) => k,
      })
    )

    expect(result.current.events).toHaveLength(1)
    expect(result.current.events[0].id).toBe('good')
  })

  it('event.raw 是 TableRecord 本体（不是 wrapper），用于 handleEventClick 拿到 id/data/created_at', () => {
    const fields: Field[] = [createField('f_date', 'Due Date', 'date')]
    const view = createView({ date_field: 'f_date', title_field: 'f_date' })
    const rec = createRecord(
      'row-1',
      { 'Due Date': '2026-04-09' },
      {
        created_at: '2026-04-08T10:00:00Z',
        updated_at: '2026-04-08T11:00:00Z',
        created_by_id: 'user-42',
      }
    )

    const response = buildResponse(view, [wrap('2026-04-09', rec)])
    const { result } = renderHook(() =>
      useCalendarViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: response,
        fields,
        t: (k: string) => k,
      })
    )

    const ev = result.current.events[0]
    expect(ev.raw).toBe(rec)
    expect(ev.raw.id).toBe('row-1')
    expect(ev.raw.created_at).toBe('2026-04-08T10:00:00Z')
    expect(ev.raw.updated_at).toBe('2026-04-08T11:00:00Z')
    expect(ev.raw.created_by_id).toBe('user-42')
  })

  it('title_field 为 link 类型时展示链接标题而非 [object Object]', () => {
    const fields: Field[] = [
      createField('f_date', 'Due Date', 'date'),
      createField('f_link', 'Related Link', 'link'),
    ]
    const view = createView({ date_field: 'f_date', title_field: 'f_link' })
    const record = createRecord('row-link', {
      'Due Date': '2026-07-01',
      'Related Link': [{ id: 'rec-1', title: '客户 A' }],
    })
    const response = buildResponse(view, [wrap('2026-07-01', record)])

    const { result } = renderHook(() =>
      useCalendarViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: response,
        fields,
        t: (key: string) => key,
      })
    )

    expect(result.current.events[0].title).toBe('客户 A')
  })

  it('metadata 缺失时 dateRange / endDateField / occurrenceCount 安全返回 undefined', () => {
    const fields: Field[] = [
      createField('f_date', 'Due Date', 'date'),
      createField('f_title', 'Task Title'),
    ]
    const view = createView({ date_field: 'f_date', title_field: 'f_title' })
    const response = {
      view: { id: view.id, name: view.name, view_type: view.view_type, config: view.config },
      total: 0,
      matched_total: 0,
      page: 1,
      page_size: 50,
      metadata: undefined as unknown as Record<string, unknown>,
      records: [],
    } as unknown as ViewRecordsResponse

    const { result } = renderHook(() =>
      useCalendarViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: response,
        fields,
        t: (k: string) => k,
      })
    )
    expect(result.current.dateRange).toBeUndefined()
    expect(result.current.endDateField).toBeUndefined()
    expect(result.current.occurrenceCount).toBeUndefined()
  })
})
