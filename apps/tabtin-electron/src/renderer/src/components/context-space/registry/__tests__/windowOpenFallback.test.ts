/**
 * windowOpenFallback — W8 L33 / L88 守门测试
 *
 * 测 `isModifierExternalDisposition` 把 main 进程 setWindowOpenHandler 透传的
 * Chromium WindowOpenHandlerDetails.disposition 映射到 D2 第 5 层 modifierExternal。
 *
 * 业务背景：
 *   - ⌘+click（macOS） / Ctrl+click（Win/Linux） / 中键 → disposition='foreground-tab'
 *   - 普通点击 / target=_blank → disposition='default' 或 'new-window'
 *   - 后台新窗口 → 'background-tab'
 *
 * renderer 端 fallback handler 收不到原始 e.metaKey（click 已经被 main 吞掉），
 * 所以 D2 第 5 层「⌘ 修饰键短路」在 fallback 路径只能靠 disposition 还原。
 *
 * 任何"disposition → modifierExternal" 映射变更都会被本测试 fail —— 与
 * Chromium / Electron 版本升级带来的字段变化绑死。
 */

import { describe, expect, it } from 'vitest'
import { isModifierExternalDisposition } from '../windowOpenFallback'

describe('isModifierExternalDisposition — Chromium WindowOpenHandlerDetails 映射', () => {
  it("disposition='foreground-tab' → modifierExternal=true（⌘+click / Ctrl+click / middle-click 唯一可靠跨平台信号）", () => {
    expect(isModifierExternalDisposition('foreground-tab')).toBe(true)
  })

  it("disposition='default' → modifierExternal=false（普通点击 / target=_blank）", () => {
    expect(isModifierExternalDisposition('default')).toBe(false)
  })

  it("disposition='new-window' → modifierExternal=false（window.open() 不带 ⌘）", () => {
    expect(isModifierExternalDisposition('new-window')).toBe(false)
  })

  it("disposition='background-tab' → modifierExternal=false（用户不在交互 tab）", () => {
    // 注意：技术上 background-tab 也是 ⌘+click 的一种（macOS ⌥+⌘+click），
    // 但用户语义是"后台预读，焦点不动"——不应触发系统应用打开。
    expect(isModifierExternalDisposition('background-tab')).toBe(false)
  })

  it("disposition='save-to-disk' → modifierExternal=false（下载意图，不开新载体）", () => {
    expect(isModifierExternalDisposition('save-to-disk')).toBe(false)
  })

  it("disposition='other' → modifierExternal=false（保守兜底）", () => {
    expect(isModifierExternalDisposition('other')).toBe(false)
  })

  it('disposition=undefined（旧版 main 进程未升级 IPC payload）→ modifierExternal=false', () => {
    // 后向兼容：W8 之前的 main 进程不带 disposition；renderer 端不应炸，按
    // "无 modifier" 走 D2 1-4 层。
    expect(isModifierExternalDisposition(undefined)).toBe(false)
  })

  it('disposition=空字符串 → modifierExternal=false（异常 payload 不应误触发系统应用）', () => {
    expect(isModifierExternalDisposition('')).toBe(false)
  })
})
