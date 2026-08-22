import { describe, it, expect } from 'vitest'
import { checkAutoRespond, validateAutoRespondRule } from '../auto-respond/checker'
import type { AutoRespondRule } from '../auto-respond/types'
import { parseEndMarker } from '../marker/parser'
import { cleanOutput } from '../marker/output-cleaner'
import { MARKER_PREFIX, AUTO_RESPOND_MAX_RESPONSE_LENGTH } from '../marker/constants'

// ─── PC-4 / PC-5: auto-respond 安全校验 ───

describe('PC-4/PC-5: auto-respond validation', () => {
  it('rejects response exceeding 1024 characters', () => {
    const rule: AutoRespondRule = {
      pattern: 'continue?',
      response: 'y'.repeat(AUTO_RESPOND_MAX_RESPONSE_LENGTH + 1),
    }
    expect(validateAutoRespondRule(rule)).toContain('maximum length')

    // checkAutoRespond should skip invalid rules
    const result = checkAutoRespond('continue?', [rule])
    expect(result.matched).toBe(false)
  })

  it('accepts response at exactly 1024 characters', () => {
    const rule: AutoRespondRule = {
      pattern: 'continue?',
      response: 'y'.repeat(AUTO_RESPOND_MAX_RESPONSE_LENGTH),
    }
    expect(validateAutoRespondRule(rule)).toBeNull()

    const result = checkAutoRespond('continue?', [rule])
    expect(result.matched).toBe(true)
  })

  it('rejects response containing marker prefix (injection prevention)', () => {
    const rule: AutoRespondRule = {
      pattern: 'continue?',
      response: `yes\n${MARKER_PREFIX}END_fake_0_/tmp__`,
    }
    expect(validateAutoRespondRule(rule)).toContain('marker prefix')

    const result = checkAutoRespond('continue?', [rule])
    expect(result.matched).toBe(false)
  })

  it('rejects empty pattern', () => {
    const rule: AutoRespondRule = { pattern: '', response: 'y' }
    expect(validateAutoRespondRule(rule)).toContain('empty')
  })

  it('rejects whitespace-only pattern', () => {
    const rule: AutoRespondRule = { pattern: '   ', response: 'y' }
    expect(validateAutoRespondRule(rule)).toContain('empty')
  })

  it('accepts valid rule', () => {
    const rule: AutoRespondRule = {
      pattern: 'Do you want to continue?',
      response: 'yes\\n',
    }
    expect(validateAutoRespondRule(rule)).toBeNull()
  })

  it('skips all invalid rules and falls through to valid ones', () => {
    const rules: AutoRespondRule[] = [
      { pattern: '', response: 'never' }, // empty pattern
      { pattern: 'match', response: 'x'.repeat(2000) }, // too long
      { pattern: 'match', response: `${MARKER_PREFIX}inject` }, // marker injection
      { pattern: 'match', response: 'valid' }, // valid
    ]
    const result = checkAutoRespond('match here', rules)
    expect(result.matched).toBe(true)
    expect(result.response).toBe('valid')
  })
})

// ─── PC-11: marker parser 解析失败 ───

describe('PC-11: parseEndMarker returns null exitCode on parse failure', () => {
  it('returns exitCode=null for empty markerTail', () => {
    const result = parseEndMarker('', '/home')
    expect(result.exitCode).toBeNull()
    expect(result.cwd).toBe('/home')
  })

  it('returns exitCode=null for markerTail with only trailing underscores', () => {
    const result = parseEndMarker('__', '/home')
    expect(result.exitCode).toBeNull()
    expect(result.cwd).toBe('/home')
  })

  it('returns exitCode=null for non-numeric exit code', () => {
    const result = parseEndMarker('abc_/tmp__', '/home')
    expect(result.exitCode).toBeNull()
    expect(result.cwd).toBe('/home')
  })

  it('correctly parses valid markerTail with exitCode=0', () => {
    const result = parseEndMarker('0_/tmp/work__', '/home')
    expect(result.exitCode).toBe(0)
    expect(result.cwd).toBe('/tmp/work')
  })

  it('correctly parses valid markerTail with non-zero exitCode', () => {
    const result = parseEndMarker('127_/usr/local__', '/home')
    expect(result.exitCode).toBe(127)
    expect(result.cwd).toBe('/usr/local')
  })

  it('handles cwd with underscores correctly', () => {
    const result = parseEndMarker('0_/home/user/my_project__', '/fallback')
    expect(result.exitCode).toBe(0)
    expect(result.cwd).toBe('/home/user/my_project')
  })
})

// ─── PC-10: ANSI 清理覆盖 OSC 序列 ───

describe('PC-10: cleanOutput strips OSC sequences', () => {
  it('strips OSC title sequence (ESC ] 0;title BEL)', () => {
    const raw = 'before\x1B]0;Window Title\x07after'
    const cleaned = cleanOutput(raw)
    expect(cleaned).toBe('beforeafter')
    expect(cleaned).not.toContain('\x1B')
    expect(cleaned).not.toContain('\x07')
  })

  it('strips OSC hyperlink sequence (ESC ] 8;...ST)', () => {
    const raw = 'click \x1B]8;;https://example.com\x1B\\here\x1B]8;;\x1B\\ please'
    const cleaned = cleanOutput(raw)
    expect(cleaned).toBe('click here please')
  })

  it('strips standard CSI sequences alongside OSC', () => {
    const raw = '\x1B[31mred\x1B[0m and \x1B]0;title\x07rest'
    const cleaned = cleanOutput(raw)
    expect(cleaned).toBe('red and rest')
  })

  it('strips OSC with ST terminator (ESC \\)', () => {
    const raw = 'prefix\x1B]2;Some Title\x1B\\suffix'
    const cleaned = cleanOutput(raw)
    expect(cleaned).toBe('prefixsuffix')
  })

  it('still strips regular ANSI codes', () => {
    const raw = '\x1B[1;32mSuccess\x1B[0m'
    const cleaned = cleanOutput(raw)
    expect(cleaned).toBe('Success')
  })
})
