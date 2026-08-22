import { describe, expect, it } from 'vitest'
import { getValidStatFuncs, StatFunc } from '../statistics'

describe('getValidStatFuncs', () => {
  it('数字字段支持求和等聚合', () => {
    expect(getValidStatFuncs('number')).toContain(StatFunc.Sum)
    expect(getValidStatFuncs('NUMBER')).toContain(StatFunc.Sum)
  })

  it('文本字段不包含求和', () => {
    expect(getValidStatFuncs('text')).not.toContain(StatFunc.Sum)
    expect(getValidStatFuncs('text')).toContain(StatFunc.Count)
  })
})
