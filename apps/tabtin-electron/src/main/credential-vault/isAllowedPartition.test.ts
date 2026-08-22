/**
 * 白名单测试 —— 保证 ``tabtin:env:`` / ``task-`` 前缀放行，其他一律拦截。
 *
 * 这条白名单是所有 credential-vault cookie IPC 的第一道防线，CookieSyncService
 * 也只在 ``tabtin:env:xxx`` partition 上做 cookie 注入 / 清除 —— 不通过白名单
 * 整条链路会被静默拒绝。
 *
 * 历史变更：
 *   - W2-PRE-1：新增 ``tabtin:env:`` 前缀（Wave 1 本地化退役主战场）
 *   - L-W2-3 (Wave 3, 2026-05-01)：移除 ``tabtin:crawlspace:`` 历史前缀
 *     （CookieSync 已不再监听该族，留在白名单纯死代码 + 攻击面）
 *
 * 为什么要把这条"几行改动"都覆盖单测：
 *   - 白名单是 cookie 隔离边界，任何前缀新增/删除都应该过测试守门；
 *   - 任何重新加回 legacy 前缀的尝试会立即被反向断言拦下。
 */

import { describe, expect, it, vi } from 'vitest'

// 打桩模块依赖，避免 import ipc.ts 时把 Electron / fs 等副作用真装进来。
// 这里只测纯函数逻辑，无副作用。
vi.mock('electron', () => ({
  ipcMain: { removeHandler: vi.fn() },
  session: {},
  dialog: {},
}))

vi.mock('../utils/guarded-handle', () => ({
  guardedHandle: vi.fn(),
}))

vi.mock('./autofill-service', () => ({
  registerAutofillHandlers: vi.fn(),
  initAutofillService: vi.fn(),
}))

vi.mock('./browser-detector', () => ({ detectInstalledBrowsers: vi.fn() }))
vi.mock('./extractors/ChromeExtractor', () => ({ ChromeExtractor: class {} }))
vi.mock('./extractors/FirefoxExtractor', () => ({ FirefoxExtractor: class {} }))
vi.mock('./extractors/SafariExtractor', () => ({ SafariExtractor: class {} }))
vi.mock('./extractors/PasswordExtractor', () => ({ PasswordExtractor: class {} }))

import { isAllowedPartition } from './ipc'

describe('isAllowedPartition — W2-PRE-1 白名单', () => {
  describe('允许的 partition', () => {
    it('tabtin:env: 前缀（Wave 2a 新增）放行', () => {
      expect(isAllowedPartition('tabtin:env:default')).toBe(true)
      expect(isAllowedPartition('tabtin:env:abc123def456')).toBe(true)
      expect(isAllowedPartition('persist:tabtin:env:default')).toBe(true)
    })

    it('task- 前缀（任务 view）仍放行', () => {
      expect(isAllowedPartition('task-123')).toBe(true)
      expect(isAllowedPartition('persist:task-abc')).toBe(true)
    })

    it('tabtin:organization: 前缀（Phase 3a 普通浏览器共享罐）放行', () => {
      expect(isAllowedPartition('tabtin:organization:wt-123:browser')).toBe(true)
      expect(isAllowedPartition('persist:tabtin:organization:wt-123:browser')).toBe(true)
      expect(isAllowedPartition('tabtin:organization:abc_DEF-456:browser')).toBe(true)
    })
  })

  describe('拒绝的 partition', () => {
    it('空字符串 / null / 非字符串返回 false', () => {
      expect(isAllowedPartition('')).toBe(false)
      expect(isAllowedPartition(undefined as unknown as string)).toBe(false)
      expect(isAllowedPartition(null as unknown as string)).toBe(false)
      expect(isAllowedPartition(123 as unknown as string)).toBe(false)
    })

    it('Wave 3 退役 — `tabtin:crawlspace:` 前缀不再受信', () => {
      // 历史 legacy 前缀，本地化退役 Wave 3 从白名单中移除。任何调用方
      // 仍传该前缀都应被拒绝（防止悄悄复活的攻击面）。
      expect(isAllowedPartition('tabtin:crawlspace:ws-1')).toBe(false)
      expect(isAllowedPartition('persist:tabtin:crawlspace:ws-1')).toBe(false)
      expect(isAllowedPartition('tabtin:crawlspace:cs-session-abc')).toBe(false)
    })

    it('攻击者伪造的类似前缀拒绝', () => {
      // 不是以白名单前缀**开头**，而只是包含
      expect(isAllowedPartition('evil-tabtin:env:x')).toBe(false)
      // 多余的 persist:: 双前缀不算合法
      expect(isAllowedPartition('persist:persist:tabtin:env:x')).toBe(false)
    })

    it('系统内置但未在白名单的 partition 拒绝', () => {
      expect(isAllowedPartition('webview')).toBe(false)
      expect(isAllowedPartition('persist:webview')).toBe(false)
      expect(isAllowedPartition('tabtin:unknown:x')).toBe(false)
      expect(isAllowedPartition('tabtin:session:x')).toBe(false)
    })

    it('不带 tabtin: namespace 的裸名字拒绝', () => {
      expect(isAllowedPartition('env:default')).toBe(false)
      expect(isAllowedPartition('default')).toBe(false)
    })
  })
})
