import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  normalizeSelectChoices,
  resolveSelectChipColors,
} from '../src/utils/choice-colors'

describe('resolveSelectChipColors', () => {
  it('uses the saved backend hex as the exact chip background', () => {
    const result = resolveSelectChipColors({
      value: '5327-live-opt-A',
      label: '5327-live-opt-A',
      color: '#ED8936',
    })
    assert.equal(result.backgroundColor.toUpperCase(), '#ED8936')
    assert.equal(result.color, '#000000')
  })

  it('keeps light semantic colors as background with dark text', () => {
    const result = resolveSelectChipColors({
      value: 'aaa',
      label: 'aaa',
      color: 'purpleLight2',
    })
    assert.equal(result.backgroundColor.toUpperCase(), '#E5CCFF')
    assert.equal(result.color, '#000000')
  })

  it('falls back to a stable preset color when color is missing', () => {
    const result = resolveSelectChipColors({ value: 'untitled', label: 'untitled' })
    assert.match(result.backgroundColor, /^#[0-9A-Fa-f]{6}$/)
    assert.match(result.color, /^#[0-9A-Fa-f]{6}$/)
    assert.notEqual(result.backgroundColor.toUpperCase(), result.color.toUpperCase())
  })
})

describe('normalizeSelectChoices', () => {
  it('preserves object colors and fills historical string choices from the preset palette', () => {
    const result = normalizeSelectChoices([
      { value: 'P0', label: 'Priority 0', color: '#D90A19' },
      'P1',
    ])

    assert.deepEqual(result[0], { value: 'P0', label: 'Priority 0', color: '#D90A19' })
    assert.deepEqual(result[1], { value: 'P1', label: 'P1', color: '#FA8000' })
  })
})
