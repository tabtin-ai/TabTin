import { describe, expect, it } from 'vitest'
import {
  getGroupableFields,
  isKanbanGroupableFieldType,
  mapGroupsToEditorRules,
} from '../groupHelpers'

const fields = [
  { id: 'f-track', name: '赛道', field_type: 'text' },
  { id: 'f-date', name: '发布日期', field_type: 'date' },
  { id: 'f-importance', name: '重要性', field_type: 'rating' },
  { id: 'f-featured', name: '是否精选', field_type: 'checkbox' },
  { id: 'f-email', name: '联系邮箱', field_type: 'email' },
  { id: 'f-phone', name: '联系电话', field_type: 'phone' },
  { id: 'f-round', name: '轮次', field_type: 'select' },
  { id: 'f-tags', name: '标签', field_type: 'multi_select' },
  { id: 'f-alias', name: '状态别名', field_type: 'single_select' },
  { id: 'f-file', name: '附件', field_type: 'attachment' },
  { id: 'f-hidden', name: '隐藏字段', field_type: 'text', is_hidden: true },
]

describe('isKanbanGroupableFieldType', () => {
  it('allows common stack fields including text/date/email ', () => {
    for (const type of [
      'text',
      'date',
      'select',
      'single_select',
      'multi_select',
      'checkbox',
      'rating',
      'email',
      'phone',
      'number',
      'url',
      'user',
    ]) {
      expect(isKanbanGroupableFieldType(type), type).toBe(true)
    }
  })

  it('rejects file-based field types and aliases', () => {
    for (const type of ['attachment', 'file', 'image']) {
      expect(isKanbanGroupableFieldType(type), type).toBe(false)
    }
  })
})

describe('getGroupableFields', () => {
  it('filters kanban options to non-file fields and skips hidden', () => {
    const groupable = getGroupableFields(fields, 'kanban')
    expect(groupable.map(f => f.name)).toEqual([
      '赛道',
      '发布日期',
      '重要性',
      '是否精选',
      '联系邮箱',
      '联系电话',
      '轮次',
      '标签',
      '状态别名',
    ])
  })

  it('keeps all visible fields for grid grouping', () => {
    const groupable = getGroupableFields(fields, 'grid')
    expect(groupable.map(f => f.id)).toContain('f-file')
    expect(groupable.map(f => f.id)).not.toContain('f-hidden')
  })

  it('preserves already-selected kanban group field in editor rules even when listing expands', () => {
    const groupable = getGroupableFields(fields, 'kanban')
    const rules = mapGroupsToEditorRules(
      [{ field_id: 'f-track', direction: 'asc' }],
      groupable,
    )
    expect(rules).toEqual([{ fieldId: 'f-track', direction: 'asc' }])
  })
})
