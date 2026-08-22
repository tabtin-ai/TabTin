import { describe, expect, it } from 'vitest'
import {
  applyComposerMention,
  detectComposerMention,
  filterComposerMentionCandidates,
  mergeMentionUserIds,
} from './composer-mentions'

describe('composer mentions', () => {
  it('检测 @query 并应用候选', () => {
    expect(detectComposerMention('你好 @张', 5)).toEqual({ query: '张', startIndex: 3 })
    const applied = applyComposerMention({
      value: '你好 @张',
      mention: { query: '张', startIndex: 3 },
      candidate: { userId: 'u1', displayName: '张三' },
      maxLength: 2000,
    })
    expect(applied.value).toBe('你好 @张三 ')
    expect(applied.userId).toBe('u1')
    expect(mergeMentionUserIds(['u1'], 'u1')).toEqual(['u1'])
    expect(mergeMentionUserIds([], 'u2')).toEqual(['u2'])
  })

  it('按显示名/账号过滤候选', () => {
    const result = filterComposerMentionCandidates([
      { userId: '1', displayName: '张三', accountName: 'zhang' },
      { userId: '2', displayName: '李四', accountName: 'li' },
    ], 'zhang')
    expect(result.map((c) => c.userId)).toEqual(['1'])
  })
})
