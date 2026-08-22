import { describe, expect, it } from 'vitest'
import { validatePresetField } from '../validatePresetField'
import type { PresetField } from '../registry/types'

const t = ((key: string, fallbackOrOpts?: unknown) => {
  if (typeof fallbackOrOpts === 'string') return fallbackOrOpts
  return key
}) as unknown as import('i18next').TFunction

function field(overrides: Partial<PresetField> & { key: string; type: PresetField['type'] }): PresetField {
  return { ...overrides }
}

describe('validatePresetField', () => {
  describe('required', () => {
    const f = field({ key: 'name', type: 'input', required: true })

    it('undefined / null / empty string 报错', () => {
      expect(validatePresetField(f, undefined, t)).not.toBeNull()
      expect(validatePresetField(f, null, t)).not.toBeNull()
      expect(validatePresetField(f, '', t)).not.toBeNull()
    })

    it('有值通过', () => {
      expect(validatePresetField(f, 'hello', t)).toBeNull()
      expect(validatePresetField(f, 0, t)).toBeNull()
    })

    it('空数组视为未填（multiselect 场景）', () => {
      const ms = field({ key: 'tags', type: 'multiselect', required: true })
      expect(validatePresetField(ms, [], t)).not.toBeNull()
      expect(validatePresetField(ms, ['a'], t)).toBeNull()
    })
  })

  describe('url pattern', () => {
    const f = field({ key: 'url', type: 'input', validate: { pattern: 'url' } })

    it('合法 URL 通过', () => {
      expect(validatePresetField(f, 'https://example.com', t)).toBeNull()
    })

    it('非法 URL 报错', () => {
      expect(validatePresetField(f, 'not-a-url', t)).not.toBeNull()
    })
  })

  describe('min / max', () => {
    const f = field({ key: 'n', type: 'number', validate: { min: 1, max: 10 } })

    it('范围内通过', () => {
      expect(validatePresetField(f, 5, t)).toBeNull()
    })

    it('低于 min 报错', () => {
      expect(validatePresetField(f, 0, t)).not.toBeNull()
    })

    it('高于 max 报错', () => {
      expect(validatePresetField(f, 11, t)).not.toBeNull()
    })
  })

  describe('integer', () => {
    const f = field({ key: 'count', type: 'number', validate: { type: 'integer' } })

    it('整数通过', () => {
      expect(validatePresetField(f, 3, t)).toBeNull()
    })

    it('浮点数报错', () => {
      expect(validatePresetField(f, 3.5, t)).not.toBeNull()
    })
  })

  describe('maxLength', () => {
    const f = field({ key: 'desc', type: 'textarea', validate: { maxLength: 5 } })

    it('在长度内通过', () => {
      expect(validatePresetField(f, 'abc', t)).toBeNull()
    })

    it('超长报错', () => {
      expect(validatePresetField(f, 'abcdef', t)).not.toBeNull()
    })
  })

  describe('custom', () => {
    const f = field({
      key: 'pw',
      type: 'input',
      validate: { custom: (v) => (v as string).length < 3 ? '太短' : null },
    })

    it('自定义通过', () => {
      expect(validatePresetField(f, 'abcde', t)).toBeNull()
    })

    it('自定义报错', () => {
      expect(validatePresetField(f, 'ab', t)).toBe('太短')
    })
  })

  it('非 required 字段空值直接通过', () => {
    const f = field({ key: 'opt', type: 'input', validate: { min: 1 } })
    expect(validatePresetField(f, undefined, t)).toBeNull()
    expect(validatePresetField(f, '', t)).toBeNull()
  })
})
