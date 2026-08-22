import { describe, it, expect, vi } from 'vitest'

vi.mock('lucide-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('lucide-react')>()
  return {
    ...actual,
    Film: 'Film',
    FileText: 'FileText',
    Image: 'Image',
    Music: 'Music',
    Archive: 'Archive',
    File: 'File',
    CheckCircle2: 'CheckCircle2',
    XCircle: 'XCircle',
    Pause: 'Pause',
  }
})

vi.mock('@/i18n', () => ({
  default: {
    t: (_key: string, opts?: string | { defaultValue?: string }) => {
      if (typeof opts === 'string') return opts
      return opts?.defaultValue ?? _key
    },
  },
}))

import {
  extractDomain,
  formatSpeed,
  formatRemainingTimeValue,
  groupByDate,
} from '../renderer/src/components/crawl/utils/download-utils'
import type { DownloadItem } from '../shared/types/download'

function makeItem(overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 'test-1',
    name: 'file.zip',
    url: 'https://example.com/file.zip',
    savePath: '/tmp/file.zip',
    status: 'completed',
    mimeType: 'application/zip',
    startTime: Date.now(),
    size: { received: 1024, total: 1024 },
    speed: 0,
    canResume: false,
    ...overrides,
  }
}

describe('extractDomain', () => {
  it('extracts hostname from standard URL', () => {
    expect(extractDomain('https://example.com/path/file.zip')).toBe('example.com')
  })

  it('extracts hostname with subdomain', () => {
    expect(extractDomain('https://cdn.example.com/file')).toBe('cdn.example.com')
  })

  it('extracts hostname with port', () => {
    expect(extractDomain('http://localhost:3000/file')).toBe('localhost')
  })

  it('returns empty string for invalid URL', () => {
    expect(extractDomain('not-a-url')).toBe('')
  })

  it('returns empty string for empty input', () => {
    expect(extractDomain('')).toBe('')
  })
})

describe('formatSpeed', () => {
  const fakeFormatSize = (bytes: number) => `${bytes}B`

  it('returns empty string for zero speed', () => {
    expect(formatSpeed(0, fakeFormatSize)).toBe('')
  })

  it('returns empty string for negative speed', () => {
    expect(formatSpeed(-100, fakeFormatSize)).toBe('')
  })

  it('formats positive speed with /s suffix', () => {
    expect(formatSpeed(1024, fakeFormatSize)).toBe('1024B/s')
  })
})

describe('formatRemainingTimeValue', () => {
  it('returns empty for zero speed', () => {
    expect(formatRemainingTimeValue(100, 1000, 0)).toBe('')
  })

  it('returns empty for zero total', () => {
    expect(formatRemainingTimeValue(100, 0, 500)).toBe('')
  })

  it('returns empty when received >= total', () => {
    expect(formatRemainingTimeValue(1000, 1000, 500)).toBe('')
    expect(formatRemainingTimeValue(1500, 1000, 500)).toBe('')
  })

  it('formats seconds for < 60s remaining', () => {
    const result = formatRemainingTimeValue(0, 30, 1)
    expect(result).toBe('30s')
  })

  it('formats minutes for < 3600s remaining', () => {
    const result = formatRemainingTimeValue(0, 120, 1)
    expect(result).toBe('2min')
  })

  it('formats hours + minutes for >= 3600s remaining', () => {
    const result = formatRemainingTimeValue(0, 3660, 1)
    expect(result).toBe('1h 1min')
  })
})

describe('groupByDate', () => {
  const now = Date.now()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayMs = today.getTime()

  it('returns empty array for empty input', () => {
    expect(groupByDate([])).toEqual([])
  })

  it('groups items from today', () => {
    const items = [makeItem({ startTime: todayMs + 1000 })]
    const result = groupByDate(items)
    expect(result).toHaveLength(1)
    expect(result[0].label).toBe('today')
    expect(result[0].items).toHaveLength(1)
  })

  it('groups items from yesterday', () => {
    const items = [makeItem({ startTime: todayMs - 1000 })]
    const result = groupByDate(items)
    expect(result).toHaveLength(1)
    expect(result[0].label).toBe('yesterday')
  })

  it('groups older items by date string', () => {
    const threeAgo = todayMs - 3 * 86400000
    const items = [makeItem({ startTime: threeAgo })]
    const result = groupByDate(items)
    expect(result).toHaveLength(1)
    expect(result[0].label).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('sorts groups: today first, yesterday second, older descending', () => {
    const items = [
      makeItem({ id: '1', startTime: todayMs - 5 * 86400000 }),
      makeItem({ id: '2', startTime: todayMs + 100 }),
      makeItem({ id: '3', startTime: todayMs - 1000 }),
      makeItem({ id: '4', startTime: todayMs - 10 * 86400000 }),
    ]
    const result = groupByDate(items)
    expect(result[0].label).toBe('today')
    expect(result[1].label).toBe('yesterday')
    const olderLabels = result.slice(2).map(g => g.label)
    for (let i = 0; i < olderLabels.length - 1; i++) {
      expect(olderLabels[i] > olderLabels[i + 1]).toBe(true)
    }
  })

  it('assigns multiple items to same group', () => {
    const items = [
      makeItem({ id: '1', startTime: todayMs + 100 }),
      makeItem({ id: '2', startTime: todayMs + 200 }),
    ]
    const result = groupByDate(items)
    expect(result).toHaveLength(1)
    expect(result[0].items).toHaveLength(2)
  })
})
