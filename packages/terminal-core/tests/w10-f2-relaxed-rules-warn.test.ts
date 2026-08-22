/**
 * W10-F2 S2: resolveRelaxedRules warns on unknown rule names
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveRelaxedRules, RELAXABLE_ALLOW_RULES } from '../src/allowlist'

describe('resolveRelaxedRules — unknown rule warning', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

  afterEach(() => {
    warnSpy.mockClear()
  })

  it('resolves known rules without warning', () => {
    const { rules, unknowns } = resolveRelaxedRules(['curl-mutating', 'wget-write'])
    expect(rules.length).toBeGreaterThan(0)
    expect(unknowns).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('warns on unknown rule name and returns unknowns', () => {
    const { rules, unknowns } = resolveRelaxedRules(['npm'])
    expect(rules).toEqual([])
    expect(unknowns).toEqual(['npm'])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = warnSpy.mock.calls[0][0] as string
    expect(msg).toContain('unknown rule name(s): npm')
    expect(msg).toContain('curl-mutating')
  })

  it('warns on multiple unknown rule names and returns all unknowns', () => {
    const { rules, unknowns } = resolveRelaxedRules(['npm', 'yarn', 'curl-mutating'])
    expect(rules.length).toBeGreaterThan(0)
    expect(unknowns).toEqual(['npm', 'yarn'])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = warnSpy.mock.calls[0][0] as string
    expect(msg).toContain('npm')
    expect(msg).toContain('yarn')
  })

  it('lists known rules in warning message', () => {
    resolveRelaxedRules(['unknown-rule'])
    const msg = warnSpy.mock.calls[0][0] as string
    for (const key of Object.keys(RELAXABLE_ALLOW_RULES)) {
      expect(msg).toContain(key)
    }
  })

  it('returns empty rules and unknowns for all-unknown names', () => {
    const { rules, unknowns } = resolveRelaxedRules(['foo', 'bar'])
    expect(rules).toEqual([])
    expect(unknowns).toEqual(['foo', 'bar'])
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('no warning for empty array', () => {
    const { rules, unknowns } = resolveRelaxedRules([])
    expect(rules).toEqual([])
    expect(unknowns).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
