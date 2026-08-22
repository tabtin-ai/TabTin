import { describe, expect, it } from 'vitest'

import { preferServerDisplayContent } from '../preferServerDisplayContent'

describe('preferServerDisplayContent', () => {
  it('#8294 Tracker 模板包着纯指令 → prefer server', () => {
    const instruction = '整理上周 PR'
    const templated = [
      '## 任务',
      instruction,
      '',
      '请独立完成以上任务并汇报结果。',
    ].join('\n')
    expect(preferServerDisplayContent(templated, instruction)).toBe(true)
  })

  it('截断前缀（server 是 local 前缀）→ 不 prefer server', () => {
    const full = 'a'.repeat(300)
    const summary = full.slice(0, 200)
    expect(preferServerDisplayContent(full, summary)).toBe(false)
  })

  it('不含子串 → 不 prefer server（反向）', () => {
    expect(preferServerDisplayContent('本地完全不同的长正文一二三四五六', '服务端指令')).toBe(
      false,
    )
  })

  it('等长或本地更短 → 不 prefer server', () => {
    expect(preferServerDisplayContent('abc', 'abcdef')).toBe(false)
    expect(preferServerDisplayContent('same', 'same')).toBe(false)
  })
})
