import { describe, expect, it } from 'vitest'

import {
  type AdvisoryConflict,
  describeAdvisoryConflicts,
  summarizeAdvisoryConflicts,
} from './advisoryConflictNotice'

const fields = [
  { id: 'fld-title', name: '标题' },
  { id: 'fld-status', name: '状态' },
  { id: 'fld-owner', name: '负责人' },
]

function conflict(fieldId: string, recordId = 'rec-1'): AdvisoryConflict {
  return {
    record_id: recordId,
    field_id: fieldId,
    your_value: 'mine',
    server_value: 'theirs',
  }
}

/** 把 i18n 模板换成可断言的假实现，顺带证明引号/分隔符没被写死在代码里。 */
const translate = (key: string, options?: Record<string, unknown>): string => {
  switch (key) {
    case 'table:collab.conflictFieldSeparator':
      return '、'
    case 'table:collab.conflictFieldChanged':
      return `「${options?.fieldNames}」在你编辑期间被他人改过`
    case 'table:collab.conflictFieldsChanged':
      return `「${options?.fieldNames}」等 ${options?.count} 个字段在你编辑期间被他人改过`
    default:
      return key
  }
}

describe('summarizeAdvisoryConflicts', () => {
  it('把 field_id 映射成字段名', () => {
    const summary = summarizeAdvisoryConflicts([conflict('fld-status')], fields)

    expect(summary.listed).toEqual(['状态'])
    expect(summary.total).toBe(1)
  })

  it('同一字段在多条记录上冲突只算一次', () => {
    const summary = summarizeAdvisoryConflicts(
      [conflict('fld-status', 'rec-1'), conflict('fld-status', 'rec-2')],
      fields,
    )

    expect(summary.listed).toEqual(['状态'])
    expect(summary.total).toBe(1)
  })

  it('字段已被删除时退回 field_id，不静默丢掉这条冲突', () => {
    const summary = summarizeAdvisoryConflicts([conflict('fld-removed')], fields)

    expect(summary.listed).toEqual(['fld-removed'])
    expect(summary.total).toBe(1)
  })

  it('超过上限时截断列表但保留真实总数', () => {
    const summary = summarizeAdvisoryConflicts(
      [conflict('fld-title'), conflict('fld-status'), conflict('fld-owner')],
      fields,
    )

    expect(summary.listed).toEqual(['标题', '状态'])
    expect(summary.total).toBe(3)
  })
})

describe('describeAdvisoryConflicts', () => {
  it('无冲突时不出文案', () => {
    expect(describeAdvisoryConflicts([], fields, translate)).toBeNull()
  })

  it('单个字段冲突走单数文案', () => {
    expect(describeAdvisoryConflicts([conflict('fld-status')], fields, translate)).toBe(
      '「状态」在你编辑期间被他人改过',
    )
  })

  it('两个字段冲突仍在列举上限内，用分隔符拼接', () => {
    expect(
      describeAdvisoryConflicts([conflict('fld-title'), conflict('fld-status')], fields, translate),
    ).toBe('「标题、状态」在你编辑期间被他人改过')
  })

  it('超出上限时折叠成总数', () => {
    expect(
      describeAdvisoryConflicts(
        [conflict('fld-title'), conflict('fld-status'), conflict('fld-owner')],
        fields,
        translate,
      ),
    ).toBe('「标题、状态」等 3 个字段在你编辑期间被他人改过')
  })

  it('分隔符与引号来自 i18n，切到英文模板不会漏出中文标点', () => {
    const englishTranslate = (key: string, options?: Record<string, unknown>): string => {
      switch (key) {
        case 'table:collab.conflictFieldSeparator':
          return ', '
        case 'table:collab.conflictFieldChanged':
          return `"${options?.fieldNames}" changed while you were editing`
        case 'table:collab.conflictFieldsChanged':
          return `${options?.count} fields including "${options?.fieldNames}" changed while you were editing`
        default:
          return key
      }
    }

    const description = describeAdvisoryConflicts(
      [conflict('fld-title'), conflict('fld-status'), conflict('fld-owner')],
      fields,
      englishTranslate,
    )

    expect(description).toBe('3 fields including "标题, 状态" changed while you were editing')
    expect(description).not.toContain('、')
    expect(description).not.toContain('「')
  })
})
