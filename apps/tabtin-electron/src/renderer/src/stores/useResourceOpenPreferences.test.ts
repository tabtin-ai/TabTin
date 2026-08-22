/**
 * useResourceOpenPreferences 单元测试 — W4「Agent 产物在 Space 内的打开」
 *
 * 覆盖：
 *   1. CRUD：setPreference / clearPreference / clearAllPreferences / getPreference
 *   2. CRUD：setSessionOverride / clearSessionOverride / clearAllSessionOverrides
 *   3. 持久化往返（preferences 落 localStorage；sessionOverrides 不落）
 *   4. createResourceOpenPreferenceAdapter 实现 ResourceOpenPreferenceStore
 *      契约（包含 W4 新增 getSessionOverride）
 *   5. 边界：空 key / 空 carrierAppId 不写入；clearPreference 不存在的 key 不抛
 *   6. selector 隔离：preferences 与 sessionOverrides 各自变化不互相触发
 *      （PRD §4 D2 五层数据源独立）
 *
 * setup.ts 的 afterEach 会清 localStorage；但 zustand store 是 module singleton——
 * 状态会跨 test 残留。每个测试用 `useResourceOpenPreferences.setState(...)` 重置。
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  createResourceOpenPreferenceAdapter,
  useResourceOpenPreferences,
} from './useResourceOpenPreferences'
import { PERSIST_KEYS } from './persist-key-registry'

beforeEach(() => {
  // 重置 store 内存状态（setup.ts 已清 localStorage）
  useResourceOpenPreferences.setState({
    preferences: {},
    sessionOverrides: {},
  })
})

describe('useResourceOpenPreferences — preferences CRUD', () => {
  it('setPreference + getPreference roundtrip', () => {
    const store = useResourceOpenPreferences.getState()
    store.setPreference('type:document', 'tabdoc')
    expect(store.getPreference('type:document')).toBe('tabdoc')
  })

  it('setPreference 多次写覆盖', () => {
    const store = useResourceOpenPreferences.getState()
    store.setPreference('type:document', 'tabdoc')
    store.setPreference('type:document', 'tabweb')
    expect(store.getPreference('type:document')).toBe('tabweb')
  })

  it('clearPreference 删除单条', () => {
    const store = useResourceOpenPreferences.getState()
    store.setPreference('type:document', 'tabdoc')
    store.setPreference('scheme:https:', 'tabweb')
    store.clearPreference('type:document')
    expect(store.getPreference('type:document')).toBeUndefined()
    expect(store.getPreference('scheme:https:')).toBe('tabweb')
  })

  it('clearAllPreferences 清空全部', () => {
    const store = useResourceOpenPreferences.getState()
    store.setPreference('type:document', 'tabdoc')
    store.setPreference('scheme:https:', 'tabweb')
    store.clearAllPreferences()
    expect(useResourceOpenPreferences.getState().preferences).toEqual({})
  })

  it('clearPreference 不存在的 key 不抛、不变 state', () => {
    const store = useResourceOpenPreferences.getState()
    store.setPreference('type:document', 'tabdoc')
    const before = useResourceOpenPreferences.getState().preferences
    store.clearPreference('type:non_existent')
    const after = useResourceOpenPreferences.getState().preferences
    // 引用相等：state 没被改写（避免无效 set 触发不必要重渲染）
    expect(after).toBe(before)
  })

  it('setPreference 拒绝空 key / 空 carrierAppId（noop）', () => {
    const store = useResourceOpenPreferences.getState()
    store.setPreference('', 'tabdoc')
    store.setPreference('type:document', '')
    expect(useResourceOpenPreferences.getState().preferences).toEqual({})
  })
})

describe('useResourceOpenPreferences — sessionOverrides CRUD', () => {
  it('setSessionOverride + getSessionOverride roundtrip', () => {
    const store = useResourceOpenPreferences.getState()
    store.setSessionOverride('type:document', 'tabweb')
    expect(store.getSessionOverride('type:document')).toBe('tabweb')
  })

  it('clearSessionOverride 删除单条', () => {
    const store = useResourceOpenPreferences.getState()
    store.setSessionOverride('type:document', 'tabweb')
    store.setSessionOverride('scheme:https:', 'tabcode')
    store.clearSessionOverride('type:document')
    expect(store.getSessionOverride('type:document')).toBeUndefined()
    expect(store.getSessionOverride('scheme:https:')).toBe('tabcode')
  })

  it('clearAllSessionOverrides 清空全部', () => {
    const store = useResourceOpenPreferences.getState()
    store.setSessionOverride('type:document', 'tabweb')
    store.setSessionOverride('scheme:https:', 'tabcode')
    store.clearAllSessionOverrides()
    expect(useResourceOpenPreferences.getState().sessionOverrides).toEqual({})
  })

  it('preferences 与 sessionOverrides 互不影响', () => {
    const store = useResourceOpenPreferences.getState()
    store.setPreference('type:document', 'tabdoc')
    store.setSessionOverride('type:document', 'tabweb')

    // 同一 prefKey 两层独立读取
    expect(store.getPreference('type:document')).toBe('tabdoc')
    expect(store.getSessionOverride('type:document')).toBe('tabweb')

    store.clearPreference('type:document')
    expect(store.getPreference('type:document')).toBeUndefined()
    // session 不受影响
    expect(store.getSessionOverride('type:document')).toBe('tabweb')

    store.clearSessionOverride('type:document')
    expect(store.getSessionOverride('type:document')).toBeUndefined()
  })
})

describe('useResourceOpenPreferences — persist roundtrip', () => {
  it('preferences 落 localStorage（key 命中 PERSIST_KEYS.resourceOpenPreferences）', () => {
    useResourceOpenPreferences.getState().setPreference('type:document', 'tabdoc')
    useResourceOpenPreferences.getState().setPreference('scheme:https:', 'tabweb')

    const raw = localStorage.getItem(PERSIST_KEYS.resourceOpenPreferences)
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed.state.preferences).toEqual({
      'type:document': 'tabdoc',
      'scheme:https:': 'tabweb',
    })
    expect(parsed.version).toBe(1)
  })

  it('sessionOverrides 故意 NOT 落 localStorage', () => {
    useResourceOpenPreferences.getState().setSessionOverride('type:document', 'tabweb')
    const raw = localStorage.getItem(PERSIST_KEYS.resourceOpenPreferences)
    if (raw) {
      const parsed = JSON.parse(raw)
      expect(parsed.state.sessionOverrides).toBeUndefined()
    }
    // 反向校验：手工写入 sessionOverrides 不应被持久化层回灌
    expect(localStorage.getItem(PERSIST_KEYS.resourceOpenPreferences) || '').not.toContain(
      'sessionOverrides',
    )
  })

  it('clearAllPreferences 同步清空 localStorage 的 preferences 字段', () => {
    useResourceOpenPreferences.getState().setPreference('type:document', 'tabdoc')
    useResourceOpenPreferences.getState().clearAllPreferences()
    const raw = localStorage.getItem(PERSIST_KEYS.resourceOpenPreferences)
    if (raw) {
      const parsed = JSON.parse(raw)
      expect(parsed.state.preferences).toEqual({})
    }
  })
})

describe('createResourceOpenPreferenceAdapter — router 接口契约', () => {
  it('实现 ResourceOpenPreferenceStore 全部 4 个方法', () => {
    const adapter = createResourceOpenPreferenceAdapter()
    expect(typeof adapter.get).toBe('function')
    expect(typeof adapter.set).toBe('function')
    expect(typeof adapter.unset).toBe('function')
    expect(typeof adapter.getSessionOverride).toBe('function')
  })

  it('get / set / unset 直通 store preferences', () => {
    const adapter = createResourceOpenPreferenceAdapter()
    adapter.set('type:document', 'tabdoc')
    expect(adapter.get('type:document')).toBe('tabdoc')
    expect(useResourceOpenPreferences.getState().preferences['type:document']).toBe(
      'tabdoc',
    )
    adapter.unset('type:document')
    expect(adapter.get('type:document')).toBeUndefined()
  })

  it('getSessionOverride 直通 store sessionOverrides（不读 preferences）', () => {
    const adapter = createResourceOpenPreferenceAdapter()
    useResourceOpenPreferences.getState().setSessionOverride('type:document', 'tabweb')
    useResourceOpenPreferences.getState().setPreference('type:document', 'tabdoc')
    expect(adapter.getSessionOverride!('type:document')).toBe('tabweb')
    // 关键：getSessionOverride 不返 user_pref 那个值
    expect(adapter.getSessionOverride!('type:document')).not.toBe('tabdoc')
  })
})
