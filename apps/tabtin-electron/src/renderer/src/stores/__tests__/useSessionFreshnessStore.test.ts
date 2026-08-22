import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionFreshnessStore } from '../useSessionFreshnessStore'

const getState = () => useSessionFreshnessStore.getState()

beforeEach(() => {
  getState().reset()
  vi.useRealTimers()
})

describe('useSessionFreshnessStore', () => {
  describe('initial state', () => {
    it('未知 sessionId 既不 fresh 也不 stale', () => {
      expect(getState().isFresh('unknown')).toBe(false)
      expect(getState().isStale('unknown')).toBe(false)
      expect(getState().getEntry('unknown')).toBeUndefined()
    })

    it('reset 后 freshnessBySessionId 为空对象', () => {
      getState().markFresh('a')
      getState().markStale('b')
      getState().reset()
      expect(getState().freshnessBySessionId).toEqual({})
    })
  })

  describe('markFresh', () => {
    it('标记 fresh 后 isFresh=true、isStale=false、failureCount=0', () => {
      getState().markFresh('s1')
      const entry = getState().getEntry('s1')
      expect(entry?.status).toBe('fresh')
      expect(entry?.failureCount).toBe(0)
      expect(entry?.lastError).toBeUndefined()
      expect(entry?.lastSyncedAt).not.toBeNull()
      expect(getState().isFresh('s1')).toBe(true)
      expect(getState().isStale('s1')).toBe(false)
    })

    it('从 stale 切到 fresh 会清掉 failureCount 和 lastError', () => {
      getState().markStale('s1', { status: 500, message: 'boom' })
      getState().markStale('s1', { status: 500, message: 'boom2' })
      expect(getState().getEntry('s1')?.failureCount).toBe(2)

      getState().markFresh('s1')
      const entry = getState().getEntry('s1')
      expect(entry?.failureCount).toBe(0)
      expect(entry?.lastError).toBeUndefined()
      expect(entry?.status).toBe('fresh')
    })
  })

  describe('markStale', () => {
    it('递增 failureCount 并保留 lastSyncedAt', () => {
      getState().markFresh('s1')
      const freshAt = getState().getEntry('s1')?.lastSyncedAt
      expect(freshAt).not.toBeNull()

      getState().markStale('s1', { status: 500, message: 'first' })
      expect(getState().getEntry('s1')?.failureCount).toBe(1)
      expect(getState().getEntry('s1')?.status).toBe('stale')
      expect(getState().getEntry('s1')?.lastError?.message).toBe('first')
      expect(getState().getEntry('s1')?.lastSyncedAt).toBe(freshAt)

      getState().markStale('s1', { status: 502, message: 'second' })
      expect(getState().getEntry('s1')?.failureCount).toBe(2)
      expect(getState().getEntry('s1')?.lastError?.message).toBe('second')
    })

    it('从未同步过的 session 标记 stale 后 lastSyncedAt 仍为 null', () => {
      getState().markStale('s1', { message: 'boom' })
      expect(getState().getEntry('s1')?.lastSyncedAt).toBeNull()
      expect(getState().getEntry('s1')?.status).toBe('stale')
    })
  })

  describe('markSyncing', () => {
    it('保留 prev failureCount 和 lastSyncedAt（不算重置）', () => {
      getState().markFresh('s1')
      const freshAt = getState().getEntry('s1')?.lastSyncedAt
      getState().markStale('s1', { message: 'boom' })

      getState().markSyncing('s1')
      const entry = getState().getEntry('s1')
      expect(entry?.status).toBe('syncing')
      expect(entry?.failureCount).toBe(1)
      expect(entry?.lastSyncedAt).toBe(freshAt)
    })

    it('syncing 状态下既不算 fresh 也不算 stale', () => {
      getState().markFresh('s1')
      getState().markSyncing('s1')
      expect(getState().isFresh('s1')).toBe(false)
      expect(getState().isStale('s1')).toBe(false)
    })
  })

  describe('isFresh TTL', () => {
    it('默认 TTL 30s 内的 fresh 视为 fresh', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

      getState().markFresh('s1')
      expect(getState().isFresh('s1')).toBe(true)

      vi.advanceTimersByTime(15_000)
      expect(getState().isFresh('s1')).toBe(true)

      vi.advanceTimersByTime(20_000)
      expect(getState().isFresh('s1')).toBe(false)
    })

    it('自定义 TTL 生效', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

      getState().markFresh('s1')

      vi.advanceTimersByTime(5_000)
      expect(getState().isFresh('s1', 1_000)).toBe(false)
      expect(getState().isFresh('s1', 10_000)).toBe(true)
    })
  })

  describe('getStaleSessionIds', () => {
    it('只返回 status=stale 的 session', () => {
      getState().markFresh('fresh-1')
      getState().markStale('stale-1')
      getState().markStale('stale-2')
      getState().markSyncing('syncing-1')

      expect(getState().getStaleSessionIds().sort()).toEqual(['stale-1', 'stale-2'])
    })
  })

  describe('clearSession', () => {
    it('删除指定 sessionId 的记录，其它不动', () => {
      getState().markFresh('keep')
      getState().markStale('drop')

      getState().clearSession('drop')
      expect(getState().getEntry('drop')).toBeUndefined()
      expect(getState().getEntry('keep')).toBeDefined()
    })

    it('对不存在的 sessionId 调用是 no-op', () => {
      getState().markFresh('keep')
      const before = getState().freshnessBySessionId

      getState().clearSession('nonexistent')
      const after = getState().freshnessBySessionId
      expect(after).toBe(before)
    })
  })
})
