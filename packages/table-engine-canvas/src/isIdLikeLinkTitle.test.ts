import { describe, it, expect } from 'vitest'

import {
  isIdLikeLinkTitle,
  resolveLinkRecordDisplayTitle,
  resolvePrimaryFieldRecordTitle,
  resolveSubRecordParentLinkTitle,
} from './linkRecordDisplay'

describe('isIdLikeLinkTitle ( 子记录父链假标题识别)', () => {
  const id = '6cdd953d-1234-4abc-8def-0123456789ab'

  it('空 title → 视为假标题', () => {
    expect(isIdLikeLinkTitle(id, '')).toBe(true)
  })

  it('title 等于完整 id（旧兜底）→ 假标题', () => {
    expect(isIdLikeLinkTitle(id, id)).toBe(true)
  })

  it('title 是 id 前 8 位片段（ 后端旧兜底 id[:8]）→ 假标题', () => {
    expect(isIdLikeLinkTitle(id, '6cdd953d')).toBe(true)
  })

  it('title 是 id 更长前缀片段 → 假标题', () => {
    expect(isIdLikeLinkTitle(id, '6cdd953d-1234')).toBe(true)
  })

  it('真实主字段标题（如 "2"）→ 非假标题，不覆盖', () => {
    expect(isIdLikeLinkTitle(id, '2')).toBe(false)
  })

  it('普通文本标题 → 非假标题', () => {
    expect(isIdLikeLinkTitle(id, '父记录')).toBe(false)
  })

  it('恰好等于 id 长度但不同的字符串 → 非假标题（非前缀）', () => {
    expect(isIdLikeLinkTitle(id, 'zzzzzzzz-1234-4abc-8def-0123456789ab')).toBe(false)
  })
})

describe('resolveLinkRecordDisplayTitle', () => {
  const id = '6cdd953d-1234-4abc-8def-0123456789ab'

  it('shows the unnamed-record placeholder for empty or UUID-like titles', () => {
    expect(resolveLinkRecordDisplayTitle(id, '')).toBe('未命名记录')
    expect(resolveLinkRecordDisplayTitle(id, id)).toBe('未命名记录')
  })

  it('keeps a meaningful record title unchanged', () => {
    expect(resolveLinkRecordDisplayTitle(id, '父记录')).toBe('父记录')
  })
})

describe('resolvePrimaryFieldRecordTitle', () => {
  it('resolves a member primary field to the member display name', () => {
    const memberId = '81046376-d1a1-4abc-8def-0123456789ab'

    expect(resolvePrimaryFieldRecordTitle(
      [{ id: memberId }],
      {
        fieldType: 'user',
        userDisplayNameById: new Map([[memberId, '殷玉蒙']]),
      },
    )).toBe('殷玉蒙')
  })

  it('keeps scalar primary field titles unchanged', () => {
    expect(resolvePrimaryFieldRecordTitle(' 父记录 ')).toBe('父记录')
    expect(resolvePrimaryFieldRecordTitle(2)).toBe('2')
  })
})

describe('resolveSubRecordParentLinkTitle', () => {
  const id = '6cdd953d-1234-4abc-8def-0123456789ab'

  it('prefers the loaded parent primary-field projection over a serialized member value', () => {
    expect(resolveSubRecordParentLinkTitle(
      id,
      "[{'id': '81046376-d1a1-4abc-8def-0123456789ab'}]",
      () => '殷玉蒙',
    )).toBe('殷玉蒙')
  })

  it('refreshes a stale meaningful title from the loaded parent record', () => {
    expect(resolveSubRecordParentLinkTitle(
      id,
      '旧姓名',
      () => '新姓名',
    )).toBe('新姓名')
  })

  it('keeps the denormalized title when the parent record is not loaded', () => {
    expect(resolveSubRecordParentLinkTitle(id, '父记录', () => undefined)).toBe('父记录')
  })

  it('hides an unresolved serialized member value behind the unnamed placeholder', () => {
    expect(resolveSubRecordParentLinkTitle(
      id,
      "[{'id': '81046376-d1a1-4abc-8def-0123456789ab'}]",
      () => undefined,
    )).toBe('未命名记录')
  })
})
