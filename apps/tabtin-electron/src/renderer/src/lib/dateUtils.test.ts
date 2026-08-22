import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TFunction } from 'i18next'
import {
  formatConversationTime,
  formatMessageClock,
  formatMessageTimestamp,
} from './dateUtils'

const t = ((key: string) => key === 'yesterday' ? '昨天' : key) as unknown as TFunction

describe('dateUtils locale formatting', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('繁中会话列表使用本地化上午下午格式且不补零', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 20, 18, 0))

    const value = new Date(2026, 7, 20, 16, 31).toISOString()

    expect(formatConversationTime(value, t, 'zh-TW')).toBe('下午4:31')
    expect(formatMessageClock(value, 'zh-TW')).toBe('下午4:31')
  })

  it('繁中较早日期和消息时间不显示英文月份或 AM/PM', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 20, 18, 0))

    const value = new Date(2026, 7, 18, 16, 31).toISOString()

    expect(formatConversationTime(value, t, 'zh-TW')).toBe('8月18日')
    expect(formatMessageTimestamp(value, t, 'zh-TW')).toBe('8月18日 下午4:31')
  })
})
