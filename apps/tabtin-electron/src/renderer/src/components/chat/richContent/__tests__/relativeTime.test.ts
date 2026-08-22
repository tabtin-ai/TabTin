import { afterEach, describe, expect, it, vi } from 'vitest'

import { formatRichRelativeTime } from '../relativeTime'

const t = (key: string, options?: Record<string, unknown>) => {
  if (key === 'richContent.cliRelative.justNow') return '刚刚'
  const count = options?.count
  if (key.endsWith('.minutes')) return `${count} 分钟前`
  if (key.endsWith('.hours')) return `${count} 小时前`
  if (key.endsWith('.days')) return `${count} 天前`
  return key
}

describe('formatRichRelativeTime', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns empty for missing / blank iso', () => {
    expect(formatRichRelativeTime(null, t)).toBe('')
    expect(formatRichRelativeTime(undefined, t)).toBe('')
    expect(formatRichRelativeTime('', t)).toBe('')
  })

  it('passes through unparseable strings', () => {
    expect(formatRichRelativeTime('not-a-date', t)).toBe('not-a-date')
  })

  it('uses relative wording within 30 days', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T10:00:00+08:00'))
    expect(formatRichRelativeTime('2026-07-15T09:59:30+08:00', t)).toBe('刚刚')
    expect(formatRichRelativeTime('2026-07-15T09:30:00+08:00', t)).toBe('30 分钟前')
    expect(formatRichRelativeTime('2026-07-14T10:00:00+08:00', t)).toBe('1 天前')
  })

  it('falls back to local calendar date instead of UTC ISO date', () => {
    vi.useFakeTimers()
    // 东八区 2026-05-01 07:00 = UTC 2026-04-30 23:00；若用 toISOString 会错成 04-30。
    vi.setSystemTime(new Date('2026-07-15T10:00:00+08:00'))
    const iso = '2026-04-30T23:00:00.000Z'
    const out = formatRichRelativeTime(iso, t)
    expect(out).not.toBe('2026-04-30')
    expect(out).toBe(new Date(iso).toLocaleDateString())
  })
})
