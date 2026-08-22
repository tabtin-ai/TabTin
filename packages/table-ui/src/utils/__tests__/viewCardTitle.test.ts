import { describe, expect, it } from 'vitest'
import {
  DEFAULT_UNTITLED_RECORD_TITLE,
  resolveConfiguredCardTitle,
  toTitleText,
} from '../viewCardTitle'

describe('viewCardTitle', () => {
  it('toTitleText trims and drops empty', () => {
    expect(toTitleText('  hello  ')).toBe('hello')
    expect(toTitleText('')).toBeUndefined()
    expect(toTitleText('   ')).toBeUndefined()
    expect(toTitleText(null)).toBeUndefined()
  })

  it('resolveConfiguredCardTitle uses 未命名记录 for empty', () => {
    expect(resolveConfiguredCardTitle('任务 A')).toBe('任务 A')
    expect(resolveConfiguredCardTitle('')).toBe(DEFAULT_UNTITLED_RECORD_TITLE)
    expect(resolveConfiguredCardTitle(null)).toBe(DEFAULT_UNTITLED_RECORD_TITLE)
    expect(DEFAULT_UNTITLED_RECORD_TITLE).toBe('未命名记录')
  })
})
