import { renderHook, act } from '@testing-library/react'
import { useFormViewController } from '../useFormViewController'
import type { Field, ViewMeta } from '../../types'

const createField = (id: string, name: string, fieldType: string = 'text', isPrimary = false): Field => ({
  id,
  table_id: 'table-1',
  name,
  field_type: fieldType,
  is_primary: isPrimary,
  is_hidden: false,
  sort_order: 0,
  created_at: '',
  updated_at: '',
})

const createFormView = (overrides: Partial<ViewMeta> = {}): ViewMeta => ({
  id: 'view-form-1',
  table_id: 'table-1',
  name: 'Form View',
  view_type: 'form',
  filters: [],
  sorts: [],
  groups: [],
  visible_fields: [],
  field_order: [],
  config: {},
  is_shared: false,
  is_locked: false,
  order: 0,
  created_at: '',
  ...overrides,
})

describe('useFormViewController', () => {
  describe('BS-007: setFieldVisible 当 visibleFieldIds 为空时应正确隐藏字段', () => {
    it('visibleFieldIds 为空（全部可见）时，setFieldVisible(id, false) 应传入排除该字段的完整 ID 列表', async () => {
      const fields: Field[] = [
        createField('f1', 'Name', 'text', true),
        createField('f2', 'Email', 'text'),
        createField('f3', 'Phone', 'text'),
      ]

      const view = createFormView({
        visible_fields: [],
        column_meta: undefined,
      })

      const onUpdateView = vi.fn().mockResolvedValue(undefined)

      const { result } = renderHook(() =>
        useFormViewController({
          views: [view],
          currentViewId: view.id,
          currentViewRecords: null,
          fields,
          onUpdateView,
        }),
      )

      expect(result.current.formFields).toHaveLength(3)

      await act(async () => {
        await result.current.setFieldVisible('f2', false)
      })

      expect(onUpdateView).toHaveBeenCalledTimes(1)
      const updatePayload = onUpdateView.mock.calls[0][0]

      if (updatePayload.column_meta) {
        const meta = updatePayload.column_meta as Record<string, { visible?: boolean; hidden?: boolean }>
        const f2Meta = meta['f2']
        expect(
          f2Meta?.visible === false || f2Meta?.hidden === true,
        ).toBe(true)
      } else if (updatePayload.visible_fields) {
        expect(updatePayload.visible_fields).not.toContain('f2')
        expect(updatePayload.visible_fields).toContain('f1')
        expect(updatePayload.visible_fields).toContain('f3')
      } else {
        throw new Error('onUpdateView should have been called with column_meta or visible_fields that excludes f2')
      }
    })

    it('visibleFieldIds 非空时，setFieldVisible(id, false) 仍然正常过滤', async () => {
      const fields: Field[] = [
        createField('f1', 'Name', 'text', true),
        createField('f2', 'Email', 'text'),
        createField('f3', 'Phone', 'text'),
      ]

      const view = createFormView({
        visible_fields: ['f1', 'f2', 'f3'],
      })

      const onUpdateView = vi.fn().mockResolvedValue(undefined)

      const { result } = renderHook(() =>
        useFormViewController({
          views: [view],
          currentViewId: view.id,
          currentViewRecords: null,
          fields,
          onUpdateView,
        }),
      )

      await act(async () => {
        await result.current.setFieldVisible('f2', false)
      })

      expect(onUpdateView).toHaveBeenCalledTimes(1)
    })

    it('系统字段在 formFields 中被正确排除', async () => {
      const fields: Field[] = [
        createField('f1', 'Name', 'text', true),
        createField('f2', 'Email', 'text'),
        createField('f_sys', 'Created At', 'created_time'),
      ]

      const view = createFormView({
        visible_fields: [],
      })

      const onUpdateView = vi.fn().mockResolvedValue(undefined)

      const { result } = renderHook(() =>
        useFormViewController({
          views: [view],
          currentViewId: view.id,
          currentViewRecords: null,
          fields,
          onUpdateView,
        }),
      )

      expect(result.current.unavailableFields).toHaveLength(1)
      expect(result.current.unavailableFields[0].id).toBe('f_sys')
      expect(result.current.formFields.some(f => f.id === 'f_sys')).toBe(false)

      await act(async () => {
        await result.current.setFieldVisible('f2', false)
      })

      expect(onUpdateView).toHaveBeenCalledTimes(1)
      const updatePayload = onUpdateView.mock.calls[0][0]
      if (updatePayload.visible_fields) {
        expect(updatePayload.visible_fields).not.toContain('f2')
      }
    })
  })
})
