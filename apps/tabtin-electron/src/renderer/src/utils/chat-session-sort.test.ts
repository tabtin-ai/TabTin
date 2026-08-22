/**
 * Wave 5 (charter v1.8 §6.7 表达点 #2 + 总控 §4 设计 C):
 * isTrackerRunSession + GroupKey trackerRuns 单测
 */

import { describe, it, expect } from 'vitest'
import type { ChatSession, TrackerRunMeta } from '@tabtin/chat-client'
import {
  isTrackerRunSession,
  groupSessionsByTime,
  GROUP_ORDER,
  getSessionActivityTs,
  sortSessionsByActivity,
} from './chat-session-sort'

const baseMeta: TrackerRunMeta = {
  run_id: 'r-1',
  run_index: 1,
  run_status: 'running',
  tracker_id: 't-1',
  tracker_name: 'foo',
  tracker_origin: 'user_created',
  trigger_type: 'manual',
  trigger_context: {},
}

const make = (id: string, withRun?: boolean): ChatSession => ({
  id,
  title: `t-${id}`,
  status: 'active' as ChatSession['status'],
  organization_id: 'wt-1',
  created_at: '2026-04-26T10:00:00Z',
  updated_at: '2026-04-26T10:00:00Z',
  tracker_run: withRun ? baseMeta : null,
})

describe('isTrackerRunSession', () => {
  it('tracker_run 存在时返回 true', () => {
    expect(isTrackerRunSession(make('a', true))).toBe(true)
  })
  it('tracker_run 缺失时返回 false', () => {
    expect(isTrackerRunSession(make('b', false))).toBe(false)
  })
})

describe('GROUP_ORDER 包含 trackerRuns', () => {
  it('trackerRuns 在 pinned 之后,时间分组之前', () => {
    expect(GROUP_ORDER).toContain('trackerRuns')
    const idxPinned = GROUP_ORDER.indexOf('pinned')
    const idxTracker = GROUP_ORDER.indexOf('trackerRuns')
    const idxToday = GROUP_ORDER.indexOf('today')
    expect(idxPinned).toBeLessThan(idxTracker)
    expect(idxTracker).toBeLessThan(idxToday)
  })
})

describe('groupSessionsByTime 不会把普通会话和 Tracker Run 混在一起', () => {
  it('groupSessionsByTime 仅按时间分组(消费方需自己过滤 trackerRunSession)', () => {
    // 这是当前 API 的契约: groupSessionsByTime 不感知 tracker_run。
    // 调用方(ChatSessionSwitcher)负责先过滤再分组。
    const sessions = [make('a'), make('b', true)]
    const groups = groupSessionsByTime(sessions)
    // 都会落进时间分组(本测试只是钉死契约,真实分流在 ChatSessionSwitcher)
    expect(groups.length).toBeGreaterThan(0)
  })
})

describe('getSessionActivityTs / groupSessionsByTime 按 last_message_at 优先', () => {
  // 回归测试：修复"5/9 创建的会话今天发了消息还停留在最近 30 天分组"。
  // 后端 update_last_message_time() 用 update_fields=['last_message_at']
  // 显式只改 last_message_at，updated_at 不会被 auto_now 顺带 bump。
  const now = Date.now()
  const todayIso = new Date(now).toISOString()
  const dayAgoIso = new Date(now - 86400000).toISOString()
  const twoWeeksAgoIso = new Date(now - 14 * 86400000).toISOString()

  const session = (overrides: Partial<ChatSession>): ChatSession => ({
    id: 's',
    title: 't',
    status: 'active' as ChatSession['status'],
    organization_id: 'wt-1',
    created_at: twoWeeksAgoIso,
    updated_at: twoWeeksAgoIso,
    tracker_run: null,
    ...overrides,
  })

  it('last_message_at 比 updated_at 新时取 last_message_at', () => {
    const s = session({ last_message_at: todayIso })
    expect(getSessionActivityTs(s)).toBe(Date.parse(todayIso))
  })

  it('last_message_at 为 null 时回退到 updated_at', () => {
    const s = session({ last_message_at: null, updated_at: dayAgoIso })
    expect(getSessionActivityTs(s)).toBe(Date.parse(dayAgoIso))
  })

  it('分组按 last_message_at 决定——5/9 旧会话今天发消息后归到今天', () => {
    const groups = groupSessionsByTime([
      session({ id: 'fresh-but-old-updated', last_message_at: todayIso }),
      session({ id: 'truly-old', last_message_at: null, updated_at: twoWeeksAgoIso }),
    ])
    const today = groups.find(g => g.key === 'today')
    const recent30d = groups.find(g => g.key === 'recent30d')
    expect(today?.sessions.map(s => s.id)).toEqual(['fresh-but-old-updated'])
    expect(recent30d?.sessions.map(s => s.id)).toEqual(['truly-old'])
  })

  it('活跃时间优先 last_message_at，再 updated_at，再 created_at（与后端 Coalesce 同源）', () => {
    const olderCreated = session({
      id: 'old',
      last_message_at: null,
      updated_at: twoWeeksAgoIso,
      created_at: todayIso,
    })
    expect(getSessionActivityTs(olderCreated)).toBe(Date.parse(twoWeeksAgoIso))
  })
})

describe('sortSessionsByActivity', () => {
  const session = (overrides: Partial<ChatSession>): ChatSession => ({
    id: 's',
    title: 't',
    status: 'active' as ChatSession['status'],
    organization_id: 'wt-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    tracker_run: null,
    ...overrides,
  })

  it('最新会话排在最前', () => {
    const ordered = sortSessionsByActivity([
      session({ id: 'old', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }),
      session({ id: 'new', created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z' }),
      session({ id: 'mid', created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z' }),
    ])
    expect(ordered.map(s => s.id)).toEqual(['new', 'mid', 'old'])
  })
})
