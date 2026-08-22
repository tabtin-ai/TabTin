import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Field, ViewMeta } from '../../types'
import { useKanbanViewController } from '../useKanbanViewController'

const field = {
  id: 'fld-status',
  table_id: 'tbl-1',
  name: '状态',
  field_type: 'single_select',
  is_primary: false,
  is_hidden: false,
  sort_order: 0,
  created_at: '',
  updated_at: '',
} satisfies Field

const staleView = {
  id: 'view-1',
  table_id: 'tbl-1',
  name: '看板',
  view_type: 'kanban',
  filters: [],
  sorts: [],
  groups: [],
  visible_fields: [],
  field_order: [],
  config: {},
  is_shared: true,
  is_locked: false,
  order: 0,
  created_at: '',
} satisfies ViewMeta

describe('useKanbanViewController', () => {
  it('优先使用协作态传入的有效视图配置', () => {
    const effectiveView = {
      ...staleView,
      config: { group_by_field: field.id },
    }

    const { result } = renderHook(() =>
      useKanbanViewController({
        views: [staleView],
        currentViewId: staleView.id,
        currentViewOverride: effectiveView,
        currentViewRecords: null,
        fields: [field],
        selectedTableId: 'tbl-1',
        t: key => key,
      }),
    )

    expect(result.current.currentView).toBe(effectiveView)
    expect(result.current.kanbanConfig.groupByField).toBe(field.id)
  })

  it('成员字段作为分组和卡片标题时展示成员名，同时保留后端传输值', () => {
    const memberId = '74806fb6-3ba8-48aa-9ffd-a50de9a85319'
    const memberField = {
      ...field,
      id: 'fld-assignee',
      name: '指派人',
      field_type: 'user',
      is_primary: true,
    } satisfies Field
    const view = {
      ...staleView,
      config: {
        group_by_field: memberField.id,
        card_title_field: memberField.id,
      },
    }
    const record = {
      id: 'rec-1',
      table_id: 'tbl-1',
      data: { 指派人: [memberId] },
      fields: { [memberField.id]: [memberId] },
      created_by_id: '',
      created_at: '',
      updated_at: '',
    }

    const { result } = renderHook(() =>
      useKanbanViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: {
          view: {
            id: view.id,
            name: view.name,
            view_type: view.view_type,
            config: view.config,
          },
          total: 1,
          matched_total: 1,
          page: 1,
          page_size: 100,
          records: [record],
          metadata: {
            groups: [{
              group_value: [memberId],
              group_label: memberId,
              count: 1,
              records: [record],
            }],
          },
        },
        fields: [memberField],
        selectedTableId: 'tbl-1',
        userDisplayNameById: new Map([[memberId, '张三']]),
        t: key => key,
      }),
    )

    expect(result.current.groups).toHaveLength(1)
    expect(result.current.groups[0]).toMatchObject({
      label: '张三',
      value: memberId,
      rawValue: [memberId],
    })
    expect(result.current.groups[0].id).toContain(`user:["${memberId}"]`)
    expect(result.current.getRecordTitle(record)).toBe('张三')
  })

  it('成员分组元数据带 JSON 引号且组内记录为空时仍展示成员名', () => {
    const memberId = '74806fb6-3ba8-48aa-9ffd-a50de9a85319'
    const memberField = {
      ...field,
      id: 'fld-assignee',
      name: '指派人',
      field_type: 'user',
      is_primary: true,
    } satisfies Field
    const view = {
      ...staleView,
      config: {
        group_by_field: memberField.id,
        card_title_field: memberField.id,
      },
    }
    const record = {
      id: 'rec-1',
      table_id: 'tbl-1',
      data: { 指派人: memberId },
      fields: { [memberField.id]: memberId },
      created_by_id: '',
      created_at: '',
      updated_at: '',
    }
    const serializedGroupValue = JSON.stringify(memberId)

    const { result } = renderHook(() =>
      useKanbanViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: {
          view: {
            id: view.id,
            name: view.name,
            view_type: view.view_type,
            config: view.config,
          },
          total: 1,
          matched_total: 1,
          page: 1,
          page_size: 100,
          records: [],
          metadata: {
            groups: [{
              group_value: serializedGroupValue,
              group_label: serializedGroupValue,
              count: 1,
              records: [],
            }],
          },
        },
        fields: [memberField],
        selectedTableId: 'tbl-1',
        userDisplayNameById: new Map([[memberId, '张三']]),
        t: key => key,
      }),
    )

    expect(result.current.groups).toHaveLength(1)
    expect(result.current.groups[0]).toMatchObject({
      label: '张三',
      value: serializedGroupValue,
      rawValue: memberId,
    })
    expect(result.current.groups[0].id).toContain(`user:["${memberId}"]`)
    expect(result.current.getRecordTitle(record)).toBe('张三')
  })
})
