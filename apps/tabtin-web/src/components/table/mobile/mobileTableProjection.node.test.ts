import assert from 'node:assert/strict'
import test from 'node:test'
import type { Field, TableRecord, ViewMeta } from '@tabtin/table-core'
import type { TableGridRow } from '@tabtin/table-engine'
import {
  projectMobileTableItems,
  readMobileCardFieldValue,
  resolveMobileCardFields,
  resolveMobileCreateInitialValues,
} from './mobileTableProjection.ts'
import { formatMobileCardValue } from './mobileTablePrimitives.ts'

const field = (
  id: string,
  name: string,
  fieldType: Field['field_type'] = 'text',
  extra: Partial<Field> = {},
): Field => ({
  id,
  table_id: 'tbl-1',
  name,
  field_type: fieldType,
  is_primary: false,
  is_hidden: false,
  sort_order: 0,
  created_at: '',
  updated_at: '',
  ...extra,
})

const fields = [
  field('fld-title', '标题', 'text', { is_primary: true }),
  field('fld-cover', '截图', 'attachment'),
  field('fld-status', '状态', 'select'),
  field('fld-owner', '负责人', 'user'),
  field('fld-cycle', '发布周期', 'text'),
  field('fld-notes', '备注', 'long_text'),
  field('fld-extra', '额外字段', 'text'),
]

const view = {
  id: 'view-1',
  table_id: 'tbl-1',
  name: '处理视角',
  view_type: 'grid',
  filters: [],
  sorts: [],
  groups: [],
  visible_fields: fields.map((item) => item.id),
  field_order: fields.map((item) => item.id),
  config: {},
  is_shared: true,
  is_locked: false,
  order: 0,
  created_at: '',
} satisfies ViewMeta

test('移动卡片遵循当前视图字段顺序，并把主字段和封面移出正文', () => {
  const projection = resolveMobileCardFields(view, fields)

  assert.equal(projection.titleField?.id, 'fld-title')
  assert.equal(projection.coverField?.id, 'fld-cover')
  assert.deepEqual(
    projection.bodyFields.map((item) => item.id),
    ['fld-status', 'fld-owner', 'fld-cycle', 'fld-notes'],
  )
})

test('显式卡片配置优先于主字段与首个附件字段', () => {
  const configuredView = {
    ...view,
    config: {
      card_title_field: 'fld-cycle',
      card_cover_field: 'fld-cover',
    },
  }
  const projection = resolveMobileCardFields(configuredView, fields)

  assert.equal(projection.titleField?.id, 'fld-cycle')
  assert.equal(projection.coverField?.id, 'fld-cover')
  assert.equal(projection.bodyFields.some((item) => item.id === 'fld-cycle'), false)
})

test('移动卡片遵循 column_meta 的显隐与顺序', () => {
  const configuredView = {
    ...view,
    column_meta: {
      'fld-title': { order: 0, hidden: false },
      'fld-status': { order: 1, hidden: true },
      'fld-cycle': { order: 2, hidden: false },
      'fld-cover': { order: 3, hidden: false },
    },
  }
  const projection = resolveMobileCardFields(configuredView, fields)

  assert.equal(projection.titleField?.id, 'fld-title')
  assert.equal(projection.coverField?.id, 'fld-cover')
  assert.equal(projection.bodyFields.some((item) => item.id === 'fld-status'), false)
  assert.equal(projection.bodyFields[0]?.id, 'fld-cycle')
})

test('移动卡片兼容名称形式的 visible_fields 与 field_order', () => {
  const configuredView = {
    ...view,
    visible_fields: ['标题', '发布周期'],
    field_order: ['发布周期', '标题'],
    column_meta: undefined,
  }
  const projection = resolveMobileCardFields(configuredView, fields)

  assert.equal(projection.titleField?.id, 'fld-title')
  assert.equal(projection.bodyFields[0]?.id, 'fld-cycle')
  assert.equal(projection.bodyFields.some((item) => item.id === 'fld-status'), false)
  assert.equal(projection.bodyFields.some((item) => item.id === 'fld-owner'), false)
})

test('移动卡片兼容 columnMeta 别名', () => {
  const configuredView = {
    ...view,
    column_meta: undefined,
    columnMeta: {
      'fld-title': { order: 0, hidden: false },
      'fld-status': { order: 1, hidden: true },
      'fld-cycle': { order: 2, hidden: false },
    },
  }
  const projection = resolveMobileCardFields(configuredView, fields)

  assert.equal(projection.bodyFields.some((item) => item.id === 'fld-status'), false)
  assert.equal(projection.bodyFields[0]?.id, 'fld-cycle')
})

test('记录字段值保留 fields 中的显式空值优先级', () => {
  const record = {
    id: 'rec-1',
    data: { 标题: '旧标题', 'fld-title': '更旧标题' },
    fields: { 'fld-title': null },
  }

  assert.equal(readMobileCardFieldValue(record, fields[0]), null)
})

test('分组新增记录合并视图筛选与分组预填，分组值优先', () => {
  const statusField = fields.find((item) => item.id === 'fld-status')!
  const filteredView = {
    ...view,
    filters: [{
      id: 'filter-status',
      field_id: statusField.id,
      operator: 'equals',
      value: '处理中',
      enabled: true,
    }],
    groups: [{ field_id: statusField.id, direction: 'asc' as const }],
    config: { filter_logic: 'and' },
  }

  assert.deepEqual(
    resolveMobileCreateInitialValues({
      currentView: filteredView,
      fields,
      groupValues: { 状态: '新提交' },
    }),
    { 状态: '新提交' },
  )
})

test('冲突的视图筛选不预填，但分组值仍可作为新建上下文', () => {
  const statusField = fields.find((item) => item.id === 'fld-status')!
  const filteredView = {
    ...view,
    filters: [
      { id: 'filter-a', field_id: statusField.id, operator: 'equals', value: '处理中', enabled: true },
      { id: 'filter-b', field_id: statusField.id, operator: 'equals', value: '已完成', enabled: true },
    ],
    groups: [{ field_id: statusField.id, direction: 'asc' as const }],
    config: { filter_logic: 'and' },
  }

  assert.deepEqual(
    resolveMobileCreateInitialValues({
      currentView: filteredView,
      fields,
      groupValues: { '状态': '新提交' },
    }),
    { '状态': '新提交' },
  )
})

test('卡片保留复选框的未选中状态', () => {
  assert.equal(formatMobileCardValue(false, field('fld-done', '已完成', 'checkbox')), '✕')
  assert.equal(formatMobileCardValue(true, field('fld-done', '已完成', 'checkbox')), '✓')
})

test('目录查不到的用户显示「未知」，绝不把原始 id 显示给用户', () => {
  const owner = field('fld-owner', '负责人', 'user')
  const orphanId = 'c05d8e27-4a16-4f93-b8c2-9d7e1f3a6b45'

  const single = formatMobileCardValue(orphanId, owner, '—', new Map())
  assert.equal(single, '未知')
  assert.ok(!single.includes('c05d8e27'), '连 id 片段也不许上屏')

  // 跨组织成员两个目录都查不到，但值里带了姓名，这时用内嵌姓名而不是「未知」
  assert.equal(
    formatMobileCardValue(
      { id: 'e91b7d3a-5f04-42c8-9e67-1a8d3b5c7f20', name: '外部-赵珂' },
      owner,
      '—',
      new Map(),
    ),
    '外部-赵珂',
  )

  // 空字段走 emptyLabel，不该被说成「未知」——「未知」专指有 id 但查不到
  assert.equal(formatMobileCardValue(null, owner, '—', new Map()), '—')
  assert.equal(formatMobileCardValue([], owner, '—', new Map()), '—')

  // 接上离组快照数据源后，离职成员保留姓名并标注状态
  assert.equal(
    formatMobileCardValue(
      'departed-1',
      owner,
      '—',
      new Map([['departed-1', '周叙']]),
      new Set(['departed-1']),
    ),
    '周叙（已离职）',
  )

  // 多选里逐个独立解析，顺序不变
  assert.equal(
    formatMobileCardValue(
      ['member-1', 'departed-1', { id: 'ext-1', name: '外部-赵珂' }, orphanId],
      owner,
      '—',
      new Map([
        ['member-1', '林小满'],
        ['departed-1', '周叙'],
      ]),
      new Set(['departed-1']),
    ),
    '林小满, 周叙（已离职）, 外部-赵珂, 未知',
  )
})

test('移动卡片的用户字段通过成员目录把稳定 id 投影为最新姓名', () => {
  assert.equal(
    formatMobileCardValue(
      'user-1',
      field('fld-owner', '负责人', 'user'),
      '—',
      new Map([['user-1', '王五']]),
    ),
    '王五',
  )
  assert.equal(
    formatMobileCardValue(
      [{ id: 'user-1', name: '旧姓名' }, { user_id: 'user-2' }],
      field('fld-owner', '负责人', 'user'),
      '—',
      new Map([
        ['user-1', '王五'],
        ['user-2', '李雷'],
      ]),
    ),
    '王五, 李雷',
  )
})

test('分组行与记录行投影成稳定的移动卡片流，结构行不进入结果', () => {
  const rows: TableGridRow[] = [
    {
      id: '__group__new',
      __rowType: 'group_header',
      __groupPath: 'status:new',
      __groupLabel: '新提交',
      __groupCount: 1,
      __groupLevel: 0,
      __groupValues: { 状态: '新提交' },
    },
    { __recordId: 'rec-1' },
    { id: '__group_add__new', __rowType: 'group_add' },
    { id: '__add_row__', __rowType: 'add' },
  ]
  const records: TableRecord[] = [{
    id: 'rec-1',
    table_id: 'tbl-1',
    data: {
      标题: '自动化任务失败',
      截图: [{ name: 'screen.png', thumbnail_url: 'https://example.test/screen.png' }],
      状态: '新提交',
      负责人: 'user-1',
      发布周期: 'release/260812',
      备注: '',
    },
    fields: {},
    created_by_id: 'user-1',
    created_at: '',
    updated_at: '',
  }]

  const result = projectMobileTableItems({
    rows,
    records,
    fields,
    currentView: view,
    userDisplayNameById: new Map([['user-1', '王五']]),
  })

  assert.equal(result.length, 2)
  assert.deepEqual(result[0], {
    kind: 'group',
    id: 'status:new',
    label: '新提交',
    count: 1,
    level: 0,
    collapsed: false,
    groupValues: { 状态: '新提交' },
  })
  assert.equal(result[1]?.kind, 'record')
  if (result[1]?.kind !== 'record') return
  assert.equal(result[1].id, 'rec-1')
  assert.equal(result[1].title, '自动化任务失败')
  assert.equal(result[1].coverUrl, 'https://example.test/screen.png')
  assert.deepEqual(result[1].fields.map((item) => item.field.name), [
    '状态',
    '负责人',
    '发布周期',
    '备注',
  ])
  assert.equal(
    result[1].fields.find((item) => item.field.id === 'fld-owner')?.displayValue,
    '王五',
  )
})
