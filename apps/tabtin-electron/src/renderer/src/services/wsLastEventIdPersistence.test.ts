/**
 * W4c · §3.6 catchup localStorage 持久化模块单测。
 *
 * 覆盖：
 *   - load/clear roundtrip
 *   - load 缺 localStorage 兜底（jsdom 已默认注入；用 spy 模拟异常）
 *   - attachLastEventIdPersistence 的 envelope event_id 提取 + 节流写入
 *   - 进程重启场景：listener 拿到 event 后下次 load 能拿到
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadPersistedLastEventId,
  clearPersistedLastEventId,
  attachLastEventIdPersistence,
} from './wsLastEventIdPersistence'

const STORAGE_KEY = 'tabtin.ws.lastEventId.v1'

describe('wsLastEventIdPersistence', () => {
  beforeEach(() => {
    // 每个 case 隔离 localStorage（vitest 默认 jsdom 全局）
    window.localStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('load / clear', () => {
    it('localStorage 空时 loadPersistedLastEventId 返回 undefined', () => {
      expect(loadPersistedLastEventId()).toBeUndefined()
    })

    it('localStorage 有 Stream id 形态值时正确读取', () => {
      // W4c 联合 Review P1-1：fixture 必须是 Redis Stream id 形态（<digits>-<digits>），
      // 不再用老 'evt_*' UUID 形态——后者会被 loadPersistedLastEventId 净化清理
      window.localStorage.setItem(STORAGE_KEY, '1702000000000-0')
      expect(loadPersistedLastEventId()).toBe('1702000000000-0')
    })

    it('W4c R5-P0-1 净化：localStorage 含污染 evt_* 形态时返回 undefined + 自动清理', () => {
      // 模拟存量用户升级前 localStorage 已被污染：'evt_<uuid>' 形态
      window.localStorage.setItem(STORAGE_KEY, 'evt_8a3f2c9d-1234-5678-9abc-def012345678')
      expect(loadPersistedLastEventId()).toBeUndefined()
      // 同步清理污染数据，下次冷启动是干净状态
      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('W4c R5-P0-1 净化：其他非 Stream id 形态（无 dash / 字母混入）也返回 undefined + 清理', () => {
      window.localStorage.setItem(STORAGE_KEY, 'no-dash-id')
      expect(loadPersistedLastEventId()).toBeUndefined()
      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()

      window.localStorage.setItem(STORAGE_KEY, '12345abc-0')
      expect(loadPersistedLastEventId()).toBeUndefined()
      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('clearPersistedLastEventId 移除 key', () => {
      window.localStorage.setItem(STORAGE_KEY, '1702000000000-0')
      clearPersistedLastEventId()
      expect(loadPersistedLastEventId()).toBeUndefined()
    })

    it('localStorage 被 setItem 抛异常时（隐私模式 / 配额）clear 不崩', () => {
      const originalSetItem = window.localStorage.setItem.bind(window.localStorage)
      const originalRemoveItem = window.localStorage.removeItem.bind(window.localStorage)
      try {
        window.localStorage.setItem = () => { throw new Error('QuotaExceeded') }
        window.localStorage.removeItem = () => { throw new Error('Forbidden') }
        expect(() => clearPersistedLastEventId()).not.toThrow()
      } finally {
        window.localStorage.setItem = originalSetItem
        window.localStorage.removeItem = originalRemoveItem
      }
    })
  })

  describe('attachLastEventIdPersistence', () => {
    it('listener 钩接 gateway → envelope.event_id (Redis Stream 形态) 节流写入 localStorage', () => {
      const listeners: Array<(env: unknown) => void> = []
      const fakeGateway = {
        addListener: (cb: (env: unknown) => void) => {
          listeners.push(cb)
          return () => {}
        },
      }
      attachLastEventIdPersistence(fakeGateway)
      expect(listeners).toHaveLength(1)

      // Redis Stream 形态：<digits>-<digits>
      listeners[0]({ event_id: '1702000000000-0', type: 'agent.stream.message_start' })
      // 节流期间还没写入
      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()

      // 触发 timer
      vi.advanceTimersByTime(1100)
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe('1702000000000-0')
    })

    it('节流：1s 内 100 条 stream event 只触发 1 次 setItem', () => {
      const listeners: Array<(env: unknown) => void> = []
      const fakeGateway = { addListener: (cb: (env: unknown) => void) => { listeners.push(cb); return () => {} } }
      attachLastEventIdPersistence(fakeGateway)

      const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
      for (let i = 0; i < 100; i++) {
        listeners[0]({ event_id: `${1702000000000 + i}-0`, type: 'agent.stream.text_delta' })
      }
      vi.advanceTimersByTime(1100)
      // 100 条 event 节流到 1 次写入
      expect(setItemSpy).toHaveBeenCalledTimes(1)
      // 写入的是最后一条（trailing-edge 语义）
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe('1702000000099-0')
    })

    // W4c · R5-P0-1：legacy evt_<uuid> 形态的 event_id 必须被拒绝持久化
    it('legacy evt_ UUID 形态 event_id 不被持久化（防 cursor 污染）', () => {
      const listeners: Array<(env: unknown) => void> = []
      const fakeGateway = { addListener: (cb: (env: unknown) => void) => { listeners.push(cb); return () => {} } }
      attachLastEventIdPersistence(fakeGateway)

      // 老 publish_to_user 路径产生的 evt_<uuid> 形态
      listeners[0]({ event_id: 'evt_abc123def456', type: 'agent.user.title_updated' })
      vi.advanceTimersByTime(1100)
      // 不写入——legacy ID 不在 Redis Stream 里，写了 cursor 也无效
      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('混合 stream + legacy event：仅 stream 形态被持久化（trailing-edge 取最后 stream）', () => {
      const listeners: Array<(env: unknown) => void> = []
      const fakeGateway = { addListener: (cb: (env: unknown) => void) => { listeners.push(cb); return () => {} } }
      attachLastEventIdPersistence(fakeGateway)

      listeners[0]({ event_id: '1702000000000-0' })           // stream，OK
      listeners[0]({ event_id: 'evt_legacy_uuid' })           // legacy，跳过
      listeners[0]({ event_id: '1702000000050-0' })           // stream，OK
      listeners[0]({ event_id: 'evt_another_legacy' })        // legacy，跳过
      vi.advanceTimersByTime(1100)
      // 只有 stream 形态被记录，最后写入的是最后一条 stream（不被 legacy 覆盖）
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe('1702000000050-0')
    })

    it('request_id 以 evt_ 开头但 event_id 缺失时不被持久化（fire-and-forget 路径不参与 resume）', () => {
      const listeners: Array<(env: unknown) => void> = []
      const fakeGateway = { addListener: (cb: (env: unknown) => void) => { listeners.push(cb); return () => {} } }
      attachLastEventIdPersistence(fakeGateway)

      listeners[0]({ request_id: 'evt_fire_and_forget_42' })
      vi.advanceTimersByTime(1100)
      // 不再误识别 request_id 为 event_id —— 防 R5-P0-1 cursor 污染
      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('非 evt_ 前缀的 request_id 不被误识别为 event_id（譬如 req_xxx response）', () => {
      const listeners: Array<(env: unknown) => void> = []
      const fakeGateway = { addListener: (cb: (env: unknown) => void) => { listeners.push(cb); return () => {} } }
      attachLastEventIdPersistence(fakeGateway)

      listeners[0]({ request_id: 'req_subscribe_response' }) // 这不是 event id
      vi.advanceTimersByTime(1100)
      // 没写入
      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('null / undefined / 非对象 envelope 不崩', () => {
      const listeners: Array<(env: unknown) => void> = []
      const fakeGateway = { addListener: (cb: (env: unknown) => void) => { listeners.push(cb); return () => {} } }
      attachLastEventIdPersistence(fakeGateway)

      expect(() => {
        listeners[0](null)
        listeners[0](undefined)
        listeners[0]('string-envelope')
        listeners[0](42)
      }).not.toThrow()
      vi.advanceTimersByTime(1100)
      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('localStorage setItem 抛错时静默吞（不 propagate 影响 listener 链）', () => {
      const listeners: Array<(env: unknown) => void> = []
      const fakeGateway = { addListener: (cb: (env: unknown) => void) => { listeners.push(cb); return () => {} } }
      attachLastEventIdPersistence(fakeGateway)

      const originalSetItem = window.localStorage.setItem.bind(window.localStorage)
      try {
        window.localStorage.setItem = () => { throw new Error('QuotaExceeded') }
        expect(() => {
          listeners[0]({ event_id: 'evt_1' })
          vi.advanceTimersByTime(1100)
        }).not.toThrow()
      } finally {
        window.localStorage.setItem = originalSetItem
      }
    })
  })

  describe('跨进程模拟：load → setItem → clear → load 链路', () => {
    it('attachListener 写入 stream event_id 后下次 load 能恢复（模拟用户关进程再打开）', () => {
      // 第一次"进程"：listener 写入 stream-id 形态的 event_id
      const listeners1: Array<(env: unknown) => void> = []
      attachLastEventIdPersistence({
        addListener: (cb: (env: unknown) => void) => { listeners1.push(cb); return () => {} },
      })
      listeners1[0]({ event_id: '1702000099-0' })
      vi.advanceTimersByTime(1100)

      // 模拟"重启"：在新模块作用域里 load
      expect(loadPersistedLastEventId()).toBe('1702000099-0')

      // teardown 路径：登出清掉
      clearPersistedLastEventId()
      expect(loadPersistedLastEventId()).toBeUndefined()
    })
  })
})
