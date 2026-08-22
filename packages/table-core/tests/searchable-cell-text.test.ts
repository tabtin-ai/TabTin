import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cellTextMatchesSearchQuery,
  extractFieldSearchableCellText,
  extractSearchableCellText,
  fieldCellTextMatchesSearchQuery,
} from '../src'

test('searchable-cell-text: 保留标量', () => {
  assert.equal(extractSearchableCellText('4008001001'), '4008001001')
  assert.equal(extractSearchableCellText(42), '42')
})

test('searchable-cell-text: link/user 只取展示字段，跳过 id', () => {
  assert.equal(
    extractSearchableCellText({
      id: 'a4b5c6d7-8901-2345-6789-abcdef012345',
      title: '深圳科技有限公司',
    }),
    '深圳科技有限公司',
  )
  assert.equal(
    extractSearchableCellText({
      id: 'user-with-digit-4',
      name: '张三',
    }),
    '张三',
  )
})

test('searchable-cell-text: 多值结构化单元格聚合展示名', () => {
  assert.equal(
    extractSearchableCellText([
      { id: 'aaaa4aaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: '甲供应商' },
      { id: '11111111-2222-3333-4444-555555555555', name: '乙供应商' },
    ]),
    '甲供应商 乙供应商',
  )
})

test('searchable-cell-text: 附件用 filename 不用 file_token', () => {
  assert.equal(
    extractSearchableCellText({
      file_token: 'tok4en',
      filename: '报价单.pdf',
    }),
    '报价单.pdf',
  )
})

test('searchable-cell-text: 数字查询不命中仅含 UUID id 的 link', () => {
  assert.equal(cellTextMatchesSearchQuery('4', '4008001001'), true)
  assert.equal(
    cellTextMatchesSearchQuery('4', {
      id: 'a4b5c6d7-8901-2345-6789-abcdef012345',
      title: '无数字标题',
    }),
    false,
  )
})

test('searchable-cell-text: 纯数字查询跳过 UUID 形态展示名', () => {
  assert.equal(
    cellTextMatchesSearchQuery('4', 'a4b5c6d7-8901-2345-6789-abcdef012345'),
    false,
  )
  assert.equal(cellTextMatchesSearchQuery('400', '4008001001'), true)
})

test('searchable-cell-text: 用户字段按成员目录解析纯 id', () => {
  const members = new Map([
    ['user-try-yang', 'TryYang'],
  ])

  assert.equal(
    extractFieldSearchableCellText('user', 'user-try-yang', members),
    'tryyang',
  )
  assert.equal(
    fieldCellTextMatchesSearchQuery('Yang', 'user', 'user-try-yang', members),
    true,
  )
  assert.equal(
    fieldCellTextMatchesSearchQuery('user-try', 'user', 'user-try-yang', members),
    false,
  )
})

test('searchable-cell-text: 多人和系统用户字段共用展示名语义', () => {
  const members = new Map([
    ['user-a', 'Alice'],
    ['user-b', 'TryYang'],
  ])

  assert.equal(
    extractFieldSearchableCellText(
      'user',
      ['user-a', { id: 'user-b' }],
      members,
    ),
    'alice tryyang',
  )
  assert.equal(
    fieldCellTextMatchesSearchQuery(
      'yang',
      'created_by',
      { id: 'user-b' },
      members,
    ),
    true,
  )
  assert.equal(
    fieldCellTextMatchesSearchQuery(
      'alice',
      'last_modified_by',
      'user-a',
      members,
    ),
    true,
  )
})

test('searchable-cell-text: 用户对象优先使用内嵌展示名，未知 id 不参与搜索', () => {
  const members = new Map([
    ['user-a', 'Member Name'],
  ])

  assert.equal(
    extractFieldSearchableCellText(
      'user',
      { id: 'user-a', display_name: 'Embedded Name' },
      members,
    ),
    'embedded name',
  )
  assert.equal(
    fieldCellTextMatchesSearchQuery(
      'unknown-user-id',
      'user',
      'unknown-user-id',
      members,
    ),
    false,
  )
})

test('searchable-cell-text: 普通字段保持原有搜索规则', () => {
  const members = new Map([
    ['user-a', 'TryYang'],
  ])

  assert.equal(
    fieldCellTextMatchesSearchQuery('user-a', 'text', 'user-a', members),
    true,
  )
  assert.equal(
    fieldCellTextMatchesSearchQuery('yang', 'text', 'user-a', members),
    false,
  )
})
