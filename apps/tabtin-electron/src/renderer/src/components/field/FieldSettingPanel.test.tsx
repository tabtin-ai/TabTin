import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FieldSettingPanel } from './FieldSettingPanel'

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  createField: vi.fn(),
  updateField: vi.fn(),
  upsertFieldLocal: vi.fn(),
  loadFields: vi.fn(),
  loadViews: vi.fn(),
  loadRecordsByTable: vi.fn(),
  refreshCurrentView: vi.fn(),
  buildPayload: vi.fn(),
  validate: vi.fn(),
  toast: vi.fn(),
  checkConversion: vi.fn(),
  startPreview: vi.fn(),
  executeConversion: vi.fn(),
  formatResultParts: vi.fn(),
  conversionOptions: null as null | { onError?: (error: unknown) => void },
  handleFieldTypeChange: vi.fn(),
  initForCreate: vi.fn(),
  initFromField: vi.fn(),
  updateFieldForRuntime: vi.fn(),
  createFieldForRuntime: vi.fn(),
  lastInteractOutsidePrevented: null as boolean | null,
  lastPointerDownOutsidePrevented: null as boolean | null,
  tableCollab: null as null | {
    isCollabRuntime: boolean
    updateFieldForRuntime: ReturnType<typeof vi.fn>
    createFieldForRuntime: ReturnType<typeof vi.fn>
  },
  currentViewId: 'view-1' as string | null,
  fieldType: 'text',
  operator: 'insert' as 'add' | 'insert' | 'edit',
  isOpen: true,
  hostId: null as string | null,
  fields: [] as Array<Record<string, unknown>>,
  fieldId: null as string | null,
  referenceFieldId: 'field-ref' as string | null,
  insertPosition: 'before' as 'before' | 'after' | null,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}))

vi.mock('lucide-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('lucide-react')>()
  return {
    ...actual,
    Loader2: () => React.createElement('span', { 'data-testid': 'loader' }),
  }
})

vi.mock('@tabtin/smartsheet-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tabtin/smartsheet-ui')>()
  return {
    ...actual,
    Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SheetContent: ({
      children,
      onInteractOutside,
      onPointerDownOutside,
    }: {
      children: React.ReactNode
      onInteractOutside?: (event: Event) => void
      onPointerDownOutside?: (event: Event) => void
    }) => {
      const dispatchOutside = (
        handler: ((event: Event) => void) | undefined,
        key: 'lastInteractOutsidePrevented' | 'lastPointerDownOutsidePrevented',
      ) => {
        const event = new Event('outside', { cancelable: true })
        Object.defineProperty(event, 'target', {
          configurable: true,
          value: document.body,
        })
        handler?.(event)
        mocks[key] = event.defaultPrevented
        if (!event.defaultPrevented) {
          mocks.close()
        }
      }

      return (
        <div>
          <button
            type="button"
            onClick={() => dispatchOutside(onInteractOutside, 'lastInteractOutsidePrevented')}
          >
            simulate interact outside
          </button>
          <button
            type="button"
            onClick={() => dispatchOutside(onPointerDownOutside, 'lastPointerDownOutsidePrevented')}
          >
            simulate pointer outside
          </button>
          {children}
        </div>
      )
    },
    SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SheetFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SheetTitle: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
    SheetDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
    Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
      <button type="button" onClick={onClick} disabled={disabled}>
        {children}
      </button>
    ),
    ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    toast: mocks.toast,
    ConversionPreviewDialog: ({ onConfirm }: { onConfirm?: () => void }) => (
      <button type="button" onClick={onConfirm}>确认转换测试</button>
    ),
    useFieldConversion: (options?: { onError?: (error: unknown) => void }) => {
      mocks.conversionOptions = options ?? null
      return {
        previewOpen: false,
        preview: null,
        previewLoading: false,
        converting: false,
        checkConversion: mocks.checkConversion,
        startPreview: mocks.startPreview,
        executeConversion: mocks.executeConversion,
        cancelPreview: vi.fn(),
        setPreviewOpen: vi.fn(),
        formatResultParts: mocks.formatResultParts,
      }
    },
    FieldConfigFormBody: ({ handleFieldTypeChange, afterTypeSelector, state }: {
      handleFieldTypeChange: (type: 'number' | 'user') => void
      afterTypeSelector?: React.ReactNode
      state: { fieldType: string }
    }) => (
      <div data-testid="field-config-form">
        <div data-testid="field-type">{state.fieldType}</div>
        <button type="button" onClick={() => handleFieldTypeChange('number')}>选择数字</button>
        <button type="button" onClick={() => handleFieldTypeChange('user')}>选择人员</button>
        {afterTypeSelector}
      </div>
    ),
  }
})

vi.mock('@/components/table/utils/tableDrawerCoordinator', () => ({
  announceTableDrawerOpen: vi.fn(),
  useCloseOnOtherTableDrawerOpen: vi.fn(),
}))

vi.mock('@tabtin/table-core', () => ({
  FieldApiService: {
    createField: mocks.createField,
    updateField: mocks.updateField,
  },
  LinkFieldApiService: {
    getLinkableFields: vi.fn(),
    getLinkableRecords: vi.fn(),
  },
  TableApiService: {
    getTables: vi.fn(),
  },
  ViewApiService: {
    getViewsByTable: vi.fn(),
  },
}))

vi.mock('@/stores/useTableStore', () => ({
  useTableStore: (selector: (state: unknown) => unknown) =>
    selector({
      fields: mocks.fields,
      selectedTable: { id: 'table-1' },
      loadFields: mocks.loadFields,
      upsertFieldLocal: mocks.upsertFieldLocal,
      tables: [],
    }),
}))

vi.mock('@/stores/useViewStore', () => ({
  useViewStore: (selector: (state: unknown) => unknown) =>
    selector({
      currentViewId: mocks.currentViewId,
      loadViews: mocks.loadViews,
      refreshCurrentView: mocks.refreshCurrentView,
    }),
}))

vi.mock('@/stores/useRecordStore', () => ({
  useRecordStore: (selector: (state: unknown) => unknown) =>
    selector({
      loadRecordsByTable: mocks.loadRecordsByTable,
    }),
}))

vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: unknown) => unknown) =>
    selector({
      selectedSpace: null,
    }),
}))

vi.mock('@/stores/useFieldSettingStore', () => ({
  useFieldSettingStore: (selector: (state: unknown) => unknown) =>
    selector({
      isOpen: mocks.isOpen,
      operator: mocks.operator,
      tableId: 'table-1',
      hostId: mocks.hostId,
      fieldId: mocks.fieldId,
      referenceFieldId: mocks.referenceFieldId,
      insertPosition: mocks.insertPosition,
      activeSection: null,
      close: mocks.close,
    }),
}))

vi.mock('@components/table/TableCollabContext', () => ({
  useTableCollabOptional: () => mocks.tableCollab,
}))

vi.mock('./useFieldSettingForm', () => ({
  useFieldSettingForm: () => ({
    state: { fieldType: mocks.fieldType },
    handleFieldTypeChange: mocks.handleFieldTypeChange,
    initForCreate: mocks.initForCreate,
    initFromField: mocks.initFromField,
    validate: mocks.validate,
    buildPayload: mocks.buildPayload,
  }),
}))

vi.mock('./field-config', () => ({
  SelectChoicesEditor: () => null,
}))

describe('FieldSettingPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.currentViewId = 'view-1'
    mocks.fieldType = 'text'
    mocks.conversionOptions = null
    mocks.tableCollab = null
    mocks.isOpen = true
    mocks.operator = 'insert'
    mocks.hostId = null
    mocks.fields = []
    mocks.fieldId = null
    mocks.referenceFieldId = 'field-ref'
    mocks.insertPosition = 'before'
    mocks.validate.mockReturnValue({})
    mocks.buildPayload.mockReturnValue({
      name: 'New field',
      field_type: 'text',
      insert_position: 'before',
      reference_field_id: 'field-ref',
    })
    mocks.createField.mockResolvedValue({ id: 'field-new' })
    mocks.updateField.mockResolvedValue({ id: 'field-text' })
    mocks.checkConversion.mockResolvedValue({ can_convert: true })
    mocks.startPreview.mockResolvedValue(undefined)
    mocks.executeConversion.mockResolvedValue({ success: true })
    mocks.formatResultParts.mockReturnValue([])
    mocks.updateFieldForRuntime.mockResolvedValue(undefined)
    mocks.createFieldForRuntime.mockResolvedValue({ id: 'field-new' })
    mocks.lastInteractOutsidePrevented = null
    mocks.lastPointerDownOutsidePrevented = null
    mocks.loadFields.mockResolvedValue(undefined)
    mocks.loadViews.mockResolvedValue(true)
    mocks.loadRecordsByTable.mockResolvedValue(undefined)
    mocks.refreshCurrentView.mockResolvedValue(undefined)
  })

  const openEditField = (fieldType = 'number') => {
    mocks.operator = 'edit'
    mocks.fieldId = 'field-text'
    mocks.referenceFieldId = null
    mocks.insertPosition = null
    mocks.fieldType = fieldType
    mocks.fields = [{
      id: 'field-text',
      name: 'txt',
      field_type: 'text',
      is_primary: false,
      updated_at: 'v1',
      options: {},
    }]
    mocks.buildPayload.mockReturnValue({
      name: 'txt',
      field_type: fieldType,
      options: {},
    })
  }

  it('only initializes the field form in the host that opened it', () => {
    mocks.operator = 'add'
    mocks.referenceFieldId = null
    mocks.insertPosition = null
    mocks.hostId = 'embed-a'

    render(<FieldSettingPanel hostId="embed-b" />)
    expect(mocks.initForCreate).not.toHaveBeenCalled()
  })

  it('does not let a regular table panel consume an embedded host session', () => {
    mocks.operator = 'add'
    mocks.referenceFieldId = null
    mocks.insertPosition = null
    mocks.hostId = 'embed-a'

    render(<FieldSettingPanel />)
    expect(mocks.initForCreate).not.toHaveBeenCalled()
  })

  it('initializes the field form when the host id matches', () => {
    mocks.operator = 'add'
    mocks.referenceFieldId = null
    mocks.insertPosition = null
    mocks.hostId = 'embed-a'

    render(<FieldSettingPanel hostId="embed-a" />)
    expect(mocks.initForCreate).toHaveBeenCalledWith('text', undefined)
  })

  it('does not close the non-modal drawer when users click outside it', () => {
    render(<FieldSettingPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'simulate interact outside' }))
    fireEvent.click(screen.getByRole('button', { name: 'simulate pointer outside' }))

    expect(mocks.lastInteractOutsidePrevented).toBe(true)
    expect(mocks.lastPointerDownOutsidePrevented).toBe(true)
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it('refreshes view metadata after creating an inserted field', async () => {
    render(<FieldSettingPanel />)

    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => expect(mocks.createField).toHaveBeenCalled())
    expect(mocks.loadFields).toHaveBeenCalledWith('table-1')
    expect(mocks.loadViews).toHaveBeenCalledWith('table-1')
    expect(mocks.close).toHaveBeenCalled()
  })

  it('does not load views when no current view is selected', async () => {
    mocks.currentViewId = null
    render(<FieldSettingPanel />)

    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => expect(mocks.createField).toHaveBeenCalled())
    expect(mocks.loadFields).toHaveBeenCalledWith('table-1')
    expect(mocks.loadViews).not.toHaveBeenCalled()
  })

  it('saves title-only field edits and mirrors the returned field locally', async () => {
    const originalField = {
      id: 'field-1',
      table_id: 'table-1',
      name: 'Original title',
      field_type: 'text',
      is_primary: false,
      is_hidden: false,
      sort_order: 0,
      created_at: '2026-07-07T00:00:00Z',
      updated_at: '2026-07-07T00:00:00Z',
    }
    const updatedField = {
      ...originalField,
      name: 'Renamed title',
      updated_at: '2026-07-07T00:00:01Z',
    }
    mocks.fields = [originalField]
    mocks.operator = 'edit'
    mocks.fieldId = 'field-1'
    mocks.referenceFieldId = null
    mocks.insertPosition = null
    mocks.buildPayload.mockReturnValue({
      name: 'Renamed title',
      field_type: 'text',
    })
    mocks.updateField.mockResolvedValue(updatedField)

    render(<FieldSettingPanel />)

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.updateField).toHaveBeenCalled())
    expect(mocks.updateField).toHaveBeenCalledWith('field-1', expect.objectContaining({
      name: 'Renamed title',
    }))
    expect(mocks.upsertFieldLocal).toHaveBeenCalledWith('table-1', updatedField)
    expect(mocks.loadFields).toHaveBeenCalledWith('table-1')
    expect(mocks.close).toHaveBeenCalled()
  })

  it('syncs edited field defaults into the collab runtime schema', async () => {
    const originalField = {
      id: 'field-date',
      table_id: 'table-1',
      name: 'Due date',
      field_type: 'date',
      is_primary: false,
      is_hidden: false,
      sort_order: 0,
      created_at: '2026-07-07T00:00:00Z',
      updated_at: '2026-07-07T00:00:00Z',
      default_value: null,
      options: {},
    }
    const updatedField = {
      ...originalField,
      default_value: { mode: 'created_time' },
      updated_at: '2026-07-07T00:00:01Z',
    }
    mocks.fields = [originalField]
    mocks.operator = 'edit'
    mocks.fieldId = 'field-date'
    mocks.referenceFieldId = null
    mocks.insertPosition = null
    mocks.fieldType = 'date'
    mocks.tableCollab = {
      isCollabRuntime: true,
      updateFieldForRuntime: mocks.updateFieldForRuntime,
      createFieldForRuntime: mocks.createFieldForRuntime,
    }
    mocks.buildPayload.mockReturnValue({
      name: 'Due date',
      field_type: 'date',
      options: {},
      default_value: { mode: 'created_time' },
    })
    mocks.updateField.mockResolvedValue(updatedField)

    render(<FieldSettingPanel />)

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.updateFieldForRuntime).toHaveBeenCalled())
    expect(mocks.updateFieldForRuntime).toHaveBeenCalledWith('field-date', expect.objectContaining({
      name: 'Due date',
      field_type: 'date',
      options: {},
      default_value: { mode: 'created_time' },
    }))
    expect(mocks.upsertFieldLocal).toHaveBeenCalledWith('table-1', updatedField)
  })

  it('saves literal defaults for edited non-date fields and syncs them into collab runtime schema', async () => {
    const originalField = {
      id: 'field-text',
      table_id: 'table-1',
      name: 'Name',
      field_type: 'text',
      is_primary: false,
      is_hidden: false,
      sort_order: 0,
      created_at: '2026-07-07T00:00:00Z',
      updated_at: '2026-07-07T00:00:00Z',
      default_value: null,
      options: {},
    }
    const updatedField = {
      ...originalField,
      default_value: { mode: 'literal', value: 'Alice' },
      updated_at: '2026-07-07T00:00:01Z',
    }
    mocks.fields = [originalField]
    mocks.operator = 'edit'
    mocks.fieldId = 'field-text'
    mocks.referenceFieldId = null
    mocks.insertPosition = null
    mocks.fieldType = 'text'
    mocks.tableCollab = {
      isCollabRuntime: true,
      updateFieldForRuntime: mocks.updateFieldForRuntime,
      createFieldForRuntime: mocks.createFieldForRuntime,
    }
    mocks.buildPayload.mockReturnValue({
      name: 'Name',
      field_type: 'text',
      options: {},
      default_value: { mode: 'literal', value: 'Alice' },
    })
    mocks.updateField.mockResolvedValue(updatedField)

    render(<FieldSettingPanel />)

    fireEvent.click(screen.getByRole('button', { name: /\u4fdd\u5b58/ }))

    await waitFor(() => expect(mocks.updateField).toHaveBeenCalled())
    expect(mocks.updateField).toHaveBeenCalledWith('field-text', expect.objectContaining({
      name: 'Name',
      default_value: { mode: 'literal', value: 'Alice' },
    }))
    await waitFor(() => expect(mocks.updateFieldForRuntime).toHaveBeenCalled())
    expect(mocks.updateFieldForRuntime).toHaveBeenCalledWith('field-text', expect.objectContaining({
      name: 'Name',
      field_type: 'text',
      options: {},
      default_value: { mode: 'literal', value: 'Alice' },
    }))
    expect(mocks.upsertFieldLocal).toHaveBeenCalledWith('table-1', updatedField)
  })

  it('saves primary field edits with the active contract', async () => {
    const primaryField = {
      id: 'field-primary',
      table_id: 'table-1',
      name: 'Title',
      field_type: 'text',
      is_primary: true,
      is_hidden: false,
      sort_order: 0,
      created_at: '2026-07-07T00:00:00Z',
      updated_at: '2026-07-07T00:00:00Z',
    }
    const updatedField = {
      ...primaryField,
      name: 'Renamed title',
      updated_at: '2026-07-07T00:00:01Z',
    }
    mocks.fields = [primaryField]
    mocks.operator = 'edit'
    mocks.fieldId = 'field-primary'
    mocks.referenceFieldId = null
    mocks.insertPosition = null
    mocks.buildPayload.mockReturnValue({
      name: 'Renamed title',
      field_type: 'text',
    })
    mocks.updateField.mockResolvedValue(updatedField)
    mocks.tableCollab = {
      isCollabRuntime: true,
      updateFieldForRuntime: mocks.updateFieldForRuntime,
      createFieldForRuntime: mocks.createFieldForRuntime,
    }

    render(<FieldSettingPanel />)

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.updateField).toHaveBeenCalled())
    expect(mocks.updateField).toHaveBeenCalledWith('field-primary', expect.objectContaining({
      name: 'Renamed title',
    }))
    expect(mocks.updateFieldForRuntime).toHaveBeenCalledWith('field-primary', expect.objectContaining({
      name: 'Renamed title',
    }))
    expect(mocks.close).toHaveBeenCalled()
  })

  it('converts primary fields with the active contract', async () => {
    mocks.operator = 'edit'
    mocks.fieldId = 'field-primary'
    mocks.referenceFieldId = null
    mocks.insertPosition = null
    mocks.fieldType = 'number'
    mocks.fields = [{
      id: 'field-primary',
      table_id: 'table-1',
      name: 'Title',
      field_type: 'text',
      is_primary: true,
      updated_at: 'v1',
      options: {},
    }]
    mocks.buildPayload.mockReturnValue({
      name: 'Title',
      field_type: 'number',
      options: {},
    })

    render(<FieldSettingPanel />)

    fireEvent.click(screen.getByRole('button', { name: '确认转换测试' }))

    await waitFor(() => expect(mocks.executeConversion).toHaveBeenCalled())
    expect(mocks.executeConversion).toHaveBeenCalledWith(
      'field-primary',
      'number',
      {},
      expect.objectContaining({ name: 'Title' }),
      { force: false },
    )
  })

  it('refreshes records after confirming a field type conversion', async () => {
    openEditField('number')

    render(<FieldSettingPanel />)

    fireEvent.click(screen.getByRole('button', { name: '确认转换测试' }))

    await waitFor(() => expect(mocks.executeConversion).toHaveBeenCalled())
    expect(mocks.loadFields).toHaveBeenCalledWith('table-1')
    expect(mocks.loadViews).toHaveBeenCalledWith('table-1')
    expect(mocks.loadRecordsByTable).toHaveBeenCalledWith('table-1', { page: 1 })
    expect(mocks.refreshCurrentView).toHaveBeenCalledTimes(1)
    expect(mocks.close).toHaveBeenCalled()
  })

  it('shows a visible error when field conversion execution fails', async () => {
    openEditField('number')
    mocks.executeConversion.mockImplementation(async () => {
      mocks.conversionOptions?.onError?.(new Error('转换失败: invalid input syntax for type date'))
      return null
    })

    render(<FieldSettingPanel />)

    fireEvent.click(screen.getByRole('button', { name: '确认转换测试' }))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({
      title: '字段转换失败',
      description: '转换失败: invalid input syntax for type date',
      variant: 'destructive',
    }))
    expect(mocks.loadFields).not.toHaveBeenCalled()
    expect(mocks.loadRecordsByTable).not.toHaveBeenCalled()
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it.each([
    ['number', '选择数字'],
    ['user', '选择人员'],
  ] as const)('blocks unsupported text to %s conversion consistently', async (targetType, buttonName) => {
    openEditField('text')
    mocks.checkConversion.mockResolvedValue({
      can_convert: false,
      error: `backend says ${targetType} is unsupported`,
    })

    render(<FieldSettingPanel />)

    fireEvent.click(screen.getByRole('button', { name: buttonName }))

    await waitFor(() => {
      expect(mocks.checkConversion).toHaveBeenCalledWith('field-text', targetType)
    })
    expect(mocks.handleFieldTypeChange).not.toHaveBeenCalled()
    expect(screen.getByText('当前字段类型不支持直接转换为该类型，请新建字段后迁移数据。')).toBeTruthy()
    expect(mocks.toast).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.startPreview).not.toHaveBeenCalled()
    expect(mocks.updateField).not.toHaveBeenCalled()
  })

  it('clears unsupported conversion state when the panel is reopened', async () => {
    openEditField('text')
    mocks.checkConversion.mockResolvedValue({
      can_convert: false,
    })

    const { rerender } = render(<FieldSettingPanel />)
    fireEvent.click(screen.getByRole('button', { name: '选择人员' }))

    await waitFor(() => {
      expect(screen.getByText('当前字段类型不支持直接转换为该类型，请新建字段后迁移数据。')).toBeTruthy()
    })

    mocks.isOpen = false
    rerender(<FieldSettingPanel />)
    mocks.isOpen = true
    rerender(<FieldSettingPanel />)

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.updateField).toHaveBeenCalled())
    expect(mocks.startPreview).not.toHaveBeenCalled()
  })
})
