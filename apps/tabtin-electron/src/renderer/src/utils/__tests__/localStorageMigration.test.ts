import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateLegacyLocalStorageKey } from '../localStorageMigration'

describe('migrateLegacyLocalStorageKey', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('迁移:旧 key 存在 + 新 key 不存在 → 旧 key 删除 + 新 key 含旧 value', () => {
    localStorage.setItem('legacy-key', 'true')

    migrateLegacyLocalStorageKey('legacy-key', 'legacy-key:wt-1')

    expect(localStorage.getItem('legacy-key')).toBeNull()
    expect(localStorage.getItem('legacy-key:wt-1')).toBe('true')
  })

  it('保留:旧 key + 新 key 都存在 → 保留新 key(不覆盖)+ 删旧 key', () => {
    localStorage.setItem('legacy-key', 'old-value')
    localStorage.setItem('legacy-key:wt-1', 'new-value')

    migrateLegacyLocalStorageKey('legacy-key', 'legacy-key:wt-1')

    expect(localStorage.getItem('legacy-key')).toBeNull()
    expect(localStorage.getItem('legacy-key:wt-1')).toBe('new-value')
  })

  it('noop:旧 key + 新 key 都不存在 → 双方仍为 null', () => {
    migrateLegacyLocalStorageKey('legacy-key', 'legacy-key:wt-1')

    expect(localStorage.getItem('legacy-key')).toBeNull()
    expect(localStorage.getItem('legacy-key:wt-1')).toBeNull()
  })

  it('noop:legacyKey 与 namespacedKey 相同 → 不动数据(避免误删)', () => {
    localStorage.setItem('same-key', 'kept')

    migrateLegacyLocalStorageKey('same-key', 'same-key')

    expect(localStorage.getItem('same-key')).toBe('kept')
  })

  it('支持复杂 JSON 值的搬运(如 chat-collapsed-groups 序列化的数组)', () => {
    localStorage.setItem('chat-collapsed-groups', JSON.stringify(['trackerRuns', 'older']))

    migrateLegacyLocalStorageKey('chat-collapsed-groups', 'chat-collapsed-groups:wt-A')

    expect(localStorage.getItem('chat-collapsed-groups')).toBeNull()
    expect(localStorage.getItem('chat-collapsed-groups:wt-A'))
      .toBe(JSON.stringify(['trackerRuns', 'older']))
  })

  it('localStorage 抛异常时静默失败(隐私模式 / quota)', () => {
    // 模拟 localStorage.getItem 抛异常 → migrate 不应抛
    const getSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: access denied')
    })

    expect(() => migrateLegacyLocalStorageKey('legacy-key', 'legacy-key:wt-1')).not.toThrow()

    getSpy.mockRestore()
  })
})
