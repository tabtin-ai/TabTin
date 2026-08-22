import assert from 'node:assert/strict'
import test from 'node:test'
import { buildShareScopedRecordDetail } from './sharedTableRecordDetail.ts'

test('记录详情只投影分享 meta 允许的字段，不伪造普通表格权限', () => {
  const detail = buildShareScopedRecordDetail(
    {
      tableId: 'table-1',
      tableName: '项目进度',
      tableDescription: '对外协作视图',
      tableIcon: '📊',
      organizationId: 'org-1',
      spaceId: 'space-1',
      fields: [
        { id: 'field-title', name: '标题', field_type: 'text' },
        { id: 'field-status', name: '状态', field_type: 'select' },
      ],
    },
    {
      id: 'record-1',
      data: {
        '标题': '上线评审',
        '状态': '进行中',
        '内部成本': 4200,
      },
    },
  )

  assert.equal(detail.table.current_user_role, null)
  assert.equal(detail.table.created_by_id, '')
  assert.deepEqual(detail.fields.map((field) => field.name), ['标题', '状态'])
  assert.deepEqual(detail.record, {
    id: 'record-1',
    data: { '标题': '上线评审', '状态': '进行中' },
  })
  assert.equal(Object.prototype.hasOwnProperty.call(detail.record.data, '内部成本'), false)
})

test('记录详情兼容 fields/id 存储与顶层平铺的分享记录', () => {
  const detail = buildShareScopedRecordDetail(
    {
      tableId: 'table-1',
      tableName: '项目进度',
      fields: [
        { id: 'field-title', name: '标题', field_type: 'text' },
        { id: 'field-owner', name: '负责人', field_type: 'user' },
      ],
    },
    {
      record_id: 'record-2',
      fields: { 'field-title': '质量复盘' },
      '负责人': [{ id: 'user-1', name: '小林' }],
    },
  )

  assert.equal(detail.record.id, 'record-2')
  assert.deepEqual(detail.record.data, {
    '标题': '质量复盘',
    '负责人': [{ id: 'user-1', name: '小林' }],
  })
})
