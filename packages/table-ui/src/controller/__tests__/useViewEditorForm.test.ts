import { act, renderHook } from '@testing-library/react'
import { useViewEditorForm } from '../useViewEditorForm'
import type { Field, ViewMeta } from '../../types'

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

const fields: Field[] = [
  createField('f_date', 'Date', 'date'),
  createField('f_title', 'Title', 'text', { is_primary: true }),
]

const createCalendarView = (overrides: Partial<ViewMeta> = {}): ViewMeta => ({
  id: 'view-cal-1',
  table_id: 'table-1',
  name: 'Calendar',
  view_type: 'calendar',
  description: '',
  config: { date_field: 'f_date' },
  created_at: '',
  updated_at: '',
  ...overrides,
})

describe('useViewEditorForm', () => {
  it('calendar 只设置 date_field 时可构造 payload 且不强制 title_field', () => {
    const { result } = renderHook(() =>
      useViewEditorForm({
        open: true,
        mode: 'create',
        initialView: null,
        fields,
        translate: (key: string) => key,
      })
    )

    act(() => {
      result.current.setName('Calendar')
      result.current.setViewType('calendar')
      result.current.calendar.setDateField('f_date')
    })

    const built = result.current.buildAndValidate()

    expect(built.error).toBeNull()
    expect(built.payload?.config).toEqual({ date_field: 'f_date' })
  })

  it('gallery 可设置 description_field', () => {
    const { result } = renderHook(() =>
      useViewEditorForm({
        open: true,
        mode: 'create',
        initialView: null,
        fields,
        translate: (key: string) => key,
      })
    )

    act(() => {
      result.current.setName('Gallery')
      result.current.setViewType('gallery')
      result.current.gallery.setTitleField('f_title')
      result.current.gallery.setDescriptionField('f_date')
    })

    const built = result.current.buildAndValidate()

    expect(built.error).toBeNull()
    expect(built.payload?.config).toMatchObject({
      title_field: 'f_title',
      description_field: 'f_date',
    })

    act(() => {
      result.current.gallery.setDescriptionField('f_title')
    })

    const builtSame = result.current.buildAndValidate()

    expect(builtSame.error).toBeNull()
    expect(builtSame.payload?.config).toMatchObject({
      title_field: 'f_title',
      description_field: 'f_title',
    })
  })

  it('gallery 未设置 title_field 时可构造 payload 且不强制标题字段', () => {
    const { result } = renderHook(() =>
      useViewEditorForm({
        open: true,
        mode: 'create',
        initialView: null,
        fields,
        translate: (key: string) => key,
      })
    )

    act(() => {
      result.current.setName('Gallery')
      result.current.setViewType('gallery')
    })

    const built = result.current.buildAndValidate()

    expect(built.error).toBeNull()
    expect(built.payload?.config).toEqual({
      cover_field: undefined,
      card_size: 'medium',
      visible_fields: ['f_date', 'f_title'],
    })
  })

  it('#6141：打开期间 initialView/fields 引用刷新不应覆盖用户草稿', () => {
    const initialView = createCalendarView()
    const { result, rerender } = renderHook(
      (props: { initialView: ViewMeta; fields: Field[] }) =>
        useViewEditorForm({
          open: true,
          mode: 'edit',
          initialView: props.initialView,
          fields: props.fields,
          translate: (key: string) => key,
        }),
      { initialProps: { initialView, fields } },
    )

    expect(result.current.calendar.dateField).toBe('f_date')

    act(() => {
      result.current.calendar.setDateField('f_title')
      result.current.calendar.setTitleField('f_title')
    })

    // 模拟 store/collab 刷新：同内容新对象引用
    rerender({
      initialView: createCalendarView({
        config: { date_field: 'f_date', title_field: 'f_date' },
      }),
      fields: fields.map(field => ({ ...field })),
    })

    expect(result.current.calendar.dateField).toBe('f_title')
    expect(result.current.calendar.titleField).toBe('f_title')
  })

  it('#6141：关闭再打开时应按最新 initialView 重新灌入', () => {
    const { result, rerender } = renderHook(
      (props: { open: boolean; initialView: ViewMeta }) =>
        useViewEditorForm({
          open: props.open,
          mode: 'edit',
          initialView: props.initialView,
          fields,
          translate: (key: string) => key,
        }),
      {
        initialProps: {
          open: true,
          initialView: createCalendarView(),
        },
      },
    )

    act(() => {
      result.current.calendar.setDateField('f_title')
    })

    rerender({
      open: false,
      initialView: createCalendarView(),
    })
    rerender({
      open: true,
      initialView: createCalendarView({
        config: { date_field: 'f_date', title_field: 'f_title' },
      }),
    })

    expect(result.current.calendar.dateField).toBe('f_date')
    expect(result.current.calendar.titleField).toBe('f_title')
  })

  it('#6141：打开期间切换目标视图 id 时应重新灌入', () => {
    const { result, rerender } = renderHook(
      (props: { initialView: ViewMeta }) =>
        useViewEditorForm({
          open: true,
          mode: 'edit',
          initialView: props.initialView,
          fields,
          translate: (key: string) => key,
        }),
      {
        initialProps: {
          initialView: createCalendarView(),
        },
      },
    )

    act(() => {
      result.current.calendar.setDateField('f_title')
    })

    rerender({
      initialView: createCalendarView({
        id: 'view-cal-2',
        config: { date_field: 'f_date', title_field: 'f_date' },
      }),
    })

    expect(result.current.calendar.dateField).toBe('f_date')
    expect(result.current.calendar.titleField).toBe('f_date')
  })
})
