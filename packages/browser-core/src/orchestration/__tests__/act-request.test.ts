import { describe, expect, it } from 'vitest'
import { normalizeActRequest } from '../act-request'

describe('normalizeActRequest', () => {
  it.each([
    [{ actions: [{ type: 'fill', value: '张三' }] }, '张三', 0],
    [{ actions: [{ type: 'fill', text: '张三' }] }, '张三', 1],
    [{ actions: [{ type: 'fill', value: '', text: '' }] }, '', 1],
  ])('normalizes fill request %#', (input, expectedValue, warningCount) => {
    const result = normalizeActRequest(input)
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error('expected normalized request')
    expect(result.body.actions).toEqual([{ type: 'fill', value: expectedValue }])
    expect(result.compatibilityWarnings).toHaveLength(warningCount)
  })

  it('reports the fill text alias with the action index', () => {
    const result = normalizeActRequest({ actions: [{ type: 'click' }, { type: 'fill', text: '张三' }] })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error('expected normalized request')
    expect(result.compatibilityWarnings).toEqual([{
      action_index: 1,
      code: 'FILL_TEXT_ALIAS',
      message: expect.any(String),
    }])
  })

  it.each([
    [{ actions: [{ type: 'FILL', text: '张三' }] }, [{ type: 'fill', value: '张三' }], 1],
    [{ actions: [{ type: 'FiLl', value: '张三', text: '张三' }] }, [{ type: 'fill', value: '张三' }], 1],
  ])('normalizes case-insensitive fill %# before validating its aliases', (input, expectedActions, warningCount) => {
    const result = normalizeActRequest(input)
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error('expected normalized request')
    expect(result.body.actions).toEqual(expectedActions)
    expect(result.compatibilityWarnings).toHaveLength(warningCount)
  })

  it.each([
    [{ actions: [{ type: 'fill' }] }, '缺少 value'],
    [{ actions: [{ type: 'fill', value: 1 }] }, 'value 必须是字符串'],
    [{ actions: [{ type: 'fill', text: 1 }] }, 'text 必须是字符串'],
    [{ actions: [{ type: 'fill', value: 'A', text: 'B' }] }, 'text 与 value 不一致'],
    [{ actions: [{ type: 'FILL', value: 'A', text: 'B' }] }, 'text 与 value 不一致'],
    [{ actions: [{ type: 'FILL', text: 1 }] }, 'text 必须是字符串'],
  ])('rejects invalid fill request %#', (input, message) => {
    const result = normalizeActRequest(input)
    expect(result).toMatchObject({ ok: false })
    if (result.ok) throw new Error('expected validation error')
    expect(result.error.info.status).toBe(400)
    expect(result.error.info.error.code).toBe('VALIDATION_ERROR')
    expect(result.error.info.error.message).toContain(message)
  })

  it.each([
    [{ actions: [{ type: 'type', value: '张三' }] }, [{ type: 'type', value: '张三' }], 0],
    [{ actions: [{ type: 'type', text: '张三' }] }, [{ type: 'type', value: '张三' }], 1],
    [{ actions: [{ type: 'TYPE', text: 'test@example.com' }] }, [{ type: 'type', value: 'test@example.com' }], 1],
    [{ actions: [{ type: 'type', ref: 'e1' }] }, [{ type: 'type', ref: 'e1' }], 0],
  ])('normalizes type.text → value for  %#', (input, expectedActions, warningCount) => {
    const result = normalizeActRequest(input)
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error('expected normalized request')
    expect(result.body.actions).toEqual(expectedActions)
    expect(result.compatibilityWarnings).toHaveLength(warningCount)
    if (warningCount > 0) {
      expect(result.compatibilityWarnings[0]).toMatchObject({
        code: 'TYPE_TEXT_ALIAS',
        action_index: 0,
      })
    }
  })

  it.each([
    [{ actions: [{ type: 'type', value: 1 }] }, 'value 必须是字符串'],
    [{ actions: [{ type: 'type', text: 1 }] }, 'text 必须是字符串'],
    [{ actions: [{ type: 'type', value: 'A', text: 'B' }] }, 'text 与 value 不一致'],
  ])('rejects invalid type request %#', (input, message) => {
    const result = normalizeActRequest(input)
    expect(result).toMatchObject({ ok: false })
    if (result.ok) throw new Error('expected validation error')
    expect(result.error.info.error.message).toContain(message)
  })
})
