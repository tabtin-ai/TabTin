import { describe, expect, it } from 'vitest'
import {
  formatSkillVersionLabel,
  suggestNextMinorSemVer,
  suggestNextSemVer,
  validatePublishSemVer,
} from '../skillSemver'

describe('skillSemver', () => {
  it('suggests 0.0.1 when no prior labels exist', () => {
    expect(suggestNextSemVer([])).toEqual({ major: '0', minor: '0', patch: '1' })
  })

  it('bumps patch from highest existing label', () => {
    expect(suggestNextSemVer(['1.0.0', '1.2.3', '1.1.0'])).toEqual({
      major: '1',
      minor: '2',
      patch: '4',
    })
  })

  it('suggests minor bump for publish form default', () => {
    expect(suggestNextMinorSemVer(['1.0.0', '1.2.3', '1.1.0'])).toEqual({
      major: '1',
      minor: '3',
      patch: '0',
    })
  })

  it('keeps the first minor suggestion at the initial publish version', () => {
    expect(suggestNextMinorSemVer([])).toEqual({ major: '0', minor: '0', patch: '1' })
  })

  it('formats labels as v + full semver (legacy seq → vN.0.0)', () => {
    expect(formatSkillVersionLabel('v1.0.0')).toBe('v1.0.0')
    expect(formatSkillVersionLabel('vv1.0')).toBe('v1.0.0')
    expect(formatSkillVersionLabel('1.2.3')).toBe('v1.2.3')
    expect(formatSkillVersionLabel('v6')).toBe('v6.0.0')
    expect(formatSkillVersionLabel('6')).toBe('v6.0.0')
    expect(formatSkillVersionLabel('v4')).toBe('v4.0.0')
    expect(formatSkillVersionLabel(null)).toBe('')
    expect(formatSkillVersionLabel('1.2')).toBe('v1.2.0')
  })

  it('rejects duplicate and non-increasing labels', () => {
    expect(validatePublishSemVer('1.0.0', ['1.0.0'])).toBe('duplicate')
    expect(validatePublishSemVer('1.0.0', ['1.2.0'])).toBe('notGreater')
    expect(validatePublishSemVer('1.3.0', ['1.2.0'])).toBeNull()
    expect(validatePublishSemVer('6.0.0', ['v6'])).toBe('duplicate')
  })

  it('suggests minor bump from legacy seq-like labels', () => {
    expect(suggestNextMinorSemVer(['v6', '1.0.0'])).toEqual({
      major: '6',
      minor: '1',
      patch: '0',
    })
  })
})
