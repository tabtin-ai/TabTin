import { describe, expect, it } from 'vitest'
import { DUPLICATE_NAME_ERROR_TITLE, isDuplicateNameErrorMessage } from '@/lib/duplicateNameError'

describe('duplicateNameError', () => {
  it('识别重复文件名错误并提供统一提示', () => {
    expect(DUPLICATE_NAME_ERROR_TITLE).toEqual(expect.any(String))
    expect(DUPLICATE_NAME_ERROR_TITLE.length).toBeGreaterThan(0)
    expect(isDuplicateNameErrorMessage('当前 Space 已存在名为「6666」的文档，请换一个标题。')).toBe(true)
    expect(isDuplicateNameErrorMessage('已有同名文件')).toBe(true)
    expect(isDuplicateNameErrorMessage('duplicate document title')).toBe(true)
    expect(isDuplicateNameErrorMessage('A table with this name already exists')).toBe(true)
    expect(isDuplicateNameErrorMessage('服务暂时不可用')).toBe(false)
  })
})
