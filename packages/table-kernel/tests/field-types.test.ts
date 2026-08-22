import { describe, it, expect } from 'vitest'
import { validateFieldValue, formatFieldValue } from '../src/field-types/index.js'
import fixtures from './fixtures/field-validation.json'

type FixtureCase = {
  value: unknown
  valid: boolean
  formatted?: unknown
  options?: Record<string, unknown>
}

describe('Field Type Validation & Formatting', () => {
  for (const [fieldType, cases] of Object.entries(fixtures)) {
    describe(fieldType, () => {
      for (const tc of cases as FixtureCase[]) {
        const label = `value=${JSON.stringify(tc.value)} → valid=${tc.valid}`
        it(label, () => {
          expect(validateFieldValue(fieldType, tc.value, tc.options)).toBe(tc.valid)
        })

        if ('formatted' in tc) {
          it(`format(${JSON.stringify(tc.value)}) → ${JSON.stringify(tc.formatted)}`, () => {
            expect(formatFieldValue(fieldType, tc.value, tc.options)).toEqual(tc.formatted)
          })
        }
      }
    })
  }

  describe('unknown type', () => {
    it('returns false for unknown field type', () => {
      expect(validateFieldValue('nonexistent', 'any')).toBe(false)
    })
  })

  describe('select choices', () => {
    const structuredChoices = [
      { value: 'todo', label: '待处理', color: '#4299E1' },
      { value: 'done', label: '已完成', color: '#48BB78' },
    ]

    it('validates legacy string choices', () => {
      expect(validateFieldValue('select', 'todo', { choices: ['todo', 'done'] })).toBe(true)
      expect(validateFieldValue('multi_select', ['todo', 'done'], { choices: ['todo', 'done'] })).toBe(true)
    })

    it('validates structured choices by value', () => {
      expect(validateFieldValue('select', 'todo', { choices: structuredChoices })).toBe(true)
      expect(validateFieldValue('multi_select', ['todo', 'done'], { choices: structuredChoices })).toBe(true)
    })

    it('rejects values missing from structured choices', () => {
      expect(validateFieldValue('select', 'blocked', { choices: structuredChoices })).toBe(false)
      expect(validateFieldValue('multi_select', ['todo', 'blocked'], { choices: structuredChoices })).toBe(false)
    })
  })

  describe('attachment', () => {
    it('validates basic attachment', () => {
      expect(validateFieldValue('attachment', null)).toBe(true)
      expect(validateFieldValue('attachment', [])).toBe(true)
      expect(validateFieldValue('attachment', [{ name: 'file.pdf', url: 'https://example.com/file.pdf' }])).toBe(true)
      expect(validateFieldValue('attachment', [{ name: '', url: '' }])).toBe(false)
      expect(validateFieldValue('attachment', 'not_array')).toBe(false)
    })
  })

  describe('user', () => {
    it('validates various user formats', () => {
      expect(validateFieldValue('user', null)).toBe(true)
      expect(validateFieldValue('user', 'user-id-123')).toBe(true)
      expect(validateFieldValue('user', { id: 'u1', name: 'Alice' })).toBe(true)
      expect(validateFieldValue('user', [{ id: 'u1' }, 'u2'])).toBe(true)
      expect(validateFieldValue('user', 123)).toBe(false)
    })
  })
})
