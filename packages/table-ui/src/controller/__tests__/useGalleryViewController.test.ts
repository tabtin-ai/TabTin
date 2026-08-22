import { renderHook } from '@testing-library/react'
import { useGalleryViewController } from '../useGalleryViewController'
import type { Field, ViewMeta, ViewRecordsResponse, TableRecord } from '../../types'

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
  name: 'Gallery',
  view_type: 'gallery',
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

const buildResponse = (records: TableRecord[]): ViewRecordsResponse =>
  ({
    total: records.length,
    matched_total: records.length,
    page: 1,
    page_size: 50,
    metadata: { view_type: 'gallery' },
    records,
  }) as ViewRecordsResponse

describe('useGalleryViewController', () => {
  it('从 config.card_size 解析卡片尺寸，缺省为 medium', () => {
    const fields: Field[] = [createField('f_title', 'Title')]
    const smallView = createView({ card_size: 'small' })
    const invalidView = createView({ card_size: 'huge' })

    const { result: smallResult } = renderHook(() =>
      useGalleryViewController({
        views: [smallView],
        currentViewId: smallView.id,
        currentViewRecords: buildResponse([]),
        fields,
      })
    )
    const { result: defaultResult } = renderHook(() =>
      useGalleryViewController({
        views: [invalidView],
        currentViewId: invalidView.id,
        currentViewRecords: buildResponse([]),
        fields,
      })
    )

    expect(smallResult.current.cardSize).toBe('small')
    expect(defaultResult.current.cardSize).toBe('medium')
  })

  it('优先使用显式 title_field 生成卡片标题', () => {
    const fields: Field[] = [
      createField('f_title', 'Title'),
      createField('f_primary', 'Primary', 'text', { is_primary: true }),
    ]
    const view = createView({ title_field: 'f_title' })
    const record = createRecord('row-1', {
      Title: 'Configured title',
      Primary: 'Primary title',
    })

    const { result } = renderHook(() =>
      useGalleryViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: buildResponse([record]),
        fields,
      })
    )

    expect(result.current.getRecordTitle(record)).toBe('Configured title')
  })

  it('显式 title_field 为空时显示未命名记录，不回退主字段', () => {
    const fields: Field[] = [
      createField('f_title', 'Title'),
      createField('f_primary', 'Primary', 'text', { is_primary: true }),
    ]
    const view = createView({ title_field: 'f_title' })
    const record = createRecord('row-empty-title', {
      Title: '',
      Primary: 'Still primary',
    })

    const { result } = renderHook(() =>
      useGalleryViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: buildResponse([record]),
        fields,
      })
    )

    expect(result.current.getRecordTitle(record)).toBe('未命名记录')
    expect(result.current.getRecordTitleFieldId(record)).toBe('f_title')
  })

  it('缺 title_field 时按 primary 字段生成卡片标题', () => {
    const fields: Field[] = [
      createField('f_primary', 'Primary', 'text', { is_primary: true }),
      createField('f_text', 'Description'),
    ]
    const view = createView({})
    const record = createRecord('row-primary', {
      Primary: 'Primary fallback',
      Description: 'Text fallback',
    })

    const { result } = renderHook(() =>
      useGalleryViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: buildResponse([record]),
        fields,
      })
    )

    expect(result.current.getRecordTitle(record)).toBe('Primary fallback')
  })

  it('缺 primary 时按第一个 text 字段生成卡片标题', () => {
    const fields: Field[] = [
      createField('f_number', 'Count', 'number'),
      createField('f_text', 'Project Name'),
    ]
    const view = createView({})
    const record = createRecord('row-text', {
      Count: 42,
      'Project Name': 'Text fallback',
    })

    const { result } = renderHook(() =>
      useGalleryViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: buildResponse([record]),
        fields,
      })
    )

    expect(result.current.getRecordTitle(record)).toBe('Text fallback')
  })

  it('缺 title_field/primary/text 值时回退到 record id', () => {
    const fields: Field[] = [
      createField('f_number', 'Count', 'number'),
    ]
    const view = createView({})
    const record = createRecord('row-id-fallback', { Count: 42 })

    const { result } = renderHook(() =>
      useGalleryViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: buildResponse([record]),
        fields,
      })
    )

    expect(result.current.getRecordTitle(record)).toBe('row-id-fallback')
  })

  it('galleryVisibleFieldIds 排除标题、封面与描述字段，避免卡片重复展示', () => {
    const fields: Field[] = [
      createField('f_title', 'Title'),
      createField('f_cover', 'Cover', 'attachment'),
      createField('f_desc', 'Summary'),
      createField('f_status', 'Status', 'select'),
    ]
    const view: ViewMeta = {
      ...createView({
        title_field: 'f_title',
        cover_field: 'f_cover',
        description_field: 'f_desc',
      }),
      visible_fields: ['f_title', 'f_cover', 'f_desc', 'f_status'],
      field_order: ['f_title', 'f_cover', 'f_desc', 'f_status'],
    }

    const { result } = renderHook(() =>
      useGalleryViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: buildResponse([]),
        fields,
      })
    )

    expect(result.current.galleryVisibleFieldIds).toEqual(['f_status'])
  })

  it('未配置 title_field 时排除 primary 与首个 text 回落字段', () => {
    const fields: Field[] = [
      createField('f_primary', 'Primary', 'text', { is_primary: true }),
      createField('f_text', 'Note'),
      createField('f_status', 'Status', 'select'),
    ]
    const view: ViewMeta = {
      ...createView({}),
      visible_fields: ['f_primary', 'f_text', 'f_status'],
      field_order: ['f_primary', 'f_text', 'f_status'],
    }

    const { result } = renderHook(() =>
      useGalleryViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: buildResponse([]),
        fields,
      })
    )

    expect(result.current.galleryVisibleFieldIds).toEqual(['f_text', 'f_status'])
  })

  it('未配置 title_field 且 primary 非 text 时排除首个 text 字段', () => {
    const fields: Field[] = [
      createField('f_primary', '序号', 'number', { is_primary: true }),
      createField('f_title', '标题'),
      createField('f_status', 'Status', 'select'),
    ]
    const view: ViewMeta = {
      ...createView({}),
      visible_fields: ['f_primary', 'f_title', 'f_status'],
      field_order: ['f_primary', 'f_title', 'f_status'],
    }

    const { result } = renderHook(() =>
      useGalleryViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: buildResponse([]),
        fields,
      })
    )

    expect(result.current.galleryVisibleFieldIds).toEqual(['f_status'])
  })

  it('优先使用 config.visible_fields 并排除标题字段', () => {
    const fields: Field[] = [
      createField('f_title', '标题'),
      createField('f_status', 'Status', 'select'),
    ]
    const view: ViewMeta = {
      ...createView({
        title_field: 'f_title',
        visible_fields: ['f_title', 'f_status'],
      }),
      visible_fields: ['f_title', 'f_status'],
      field_order: ['f_title', 'f_status'],
    }

    const { result } = renderHook(() =>
      useGalleryViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: buildResponse([]),
        fields,
      })
    )

    expect(result.current.galleryVisibleFieldIds).toEqual(['f_status'])
  })

  it('getGalleryCardFieldIds 会按记录实际标题来源再过滤一次', () => {
    const fields: Field[] = [
      createField('f_title', '标题'),
      createField('f_status', 'Status', 'select'),
    ]
    const view: ViewMeta = {
      ...createView({ title_field: 'f_title' }),
      visible_fields: ['f_title', 'f_status'],
      field_order: ['f_title', 'f_status'],
    }
    const record = createRecord('row-1', { 标题: '卡片标题', Status: '进行中' })

    const { result } = renderHook(() =>
      useGalleryViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: buildResponse([record]),
        fields,
      })
    )

    expect(result.current.getRecordTitleFieldId(record)).toBe('f_title')
    expect(result.current.getGalleryCardFieldIds(record)).toEqual(['f_status'])
  })

  it('description_field 按配置返回描述文案', () => {
    const fields: Field[] = [
      createField('f_title', '标题'),
      createField('f_status', 'Status', 'select'),
    ]
    const view: ViewMeta = {
      ...createView({
        title_field: 'f_title',
        description_field: 'f_title',
      }),
      visible_fields: ['f_title', 'f_status'],
      field_order: ['f_title', 'f_status'],
    }
    const record = createRecord('row-1', { 标题: '卡片标题', Status: '进行中' })

    const { result } = renderHook(() =>
      useGalleryViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: buildResponse([record]),
        fields,
      })
    )

    expect(result.current.getRecordDescription(record)).toBe('卡片标题')
  })

  it('title_field 存字段名时也能从卡片正文中排除', () => {
    const fields: Field[] = [
      createField('f_title', '标题'),
      createField('f_status', 'Status', 'select'),
    ]
    const view: ViewMeta = {
      ...createView({ title_field: '标题' }),
      visible_fields: ['f_title', 'f_status'],
      field_order: ['f_title', 'f_status'],
    }

    const { result } = renderHook(() =>
      useGalleryViewController({
        views: [view],
        currentViewId: view.id,
        currentViewRecords: buildResponse([]),
        fields,
      })
    )

    expect(result.current.galleryVisibleFieldIds).toEqual(['f_status'])
  })
})
