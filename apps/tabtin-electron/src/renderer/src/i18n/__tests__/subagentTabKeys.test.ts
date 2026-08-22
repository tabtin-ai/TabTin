/**
 * subagentTabKeys.test.ts — PRD §7.4 i18n smoke
 *
 * 锁定 chat:subagent.tab.* 一组 key 在中英文 locale 下都存在且为非空字符串。
 * 直接读 JSON（不走 i18n.t），避开 lazy-backend 异步加载窗口；本测试目的就是
 * 守门翻译文件的字段完整性，不必经过 runtime。
 */
import { describe, it, expect } from 'vitest'
import chatZh from '../locales/zh-CN/chat.json'
import chatEn from '../locales/en-US/chat.json'

const REQUIRED_TAB_KEYS: ReadonlyArray<string[]> = [
  ['subagent', 'tab', 'fallbackTitle'],
  ['subagent', 'tab', 'ariaLabel'],
  ['subagent', 'tab', 'drillInTooltip'],
  ['subagent', 'tab', 'scrollLocateButton'],
  ['subagent', 'tab', 'scrollLocateMissingToast'],
  ['subagent', 'tab', 'closeRunningConfirm', 'title'],
  ['subagent', 'tab', 'closeRunningConfirm', 'detail'],
  ['subagent', 'tab', 'closeRunningConfirm', 'confirm'],
  ['subagent', 'tab', 'closeRunningConfirm', 'cancel'],
  ['subagent', 'tab', 'cancelAction'],
  ['subagent', 'tab', 'retryAction'],
  ['subagent', 'tab', 'canvasSectionTitle'],
  ['subagent', 'tab', 'openInTabButton'],
  ['subagent', 'tab', 'paneError'],
  // PRD v3.1 dogfood 重塑新增（折叠继承 / 跨设备文案）
  ['subagent', 'tab', 'inheritedContextLabel'],
  ['subagent', 'tab', 'collapseHint'],
  ['subagent', 'tab', 'expandHint'],
  ['subagent', 'tab', 'crossDeviceTitle'],
  ['subagent', 'tab', 'crossDeviceDetail'],
  // PRD v3.3 实时流架构（review 修复：父会话不可达文案 + 启动中空态文案）
  ['subagent', 'tab', 'parentUnavailableTitle'],
  ['subagent', 'tab', 'parentUnavailableDetail'],
  ['subagent', 'tab', 'startingHint'],
]

function readKey(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj
  for (const seg of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

describe('chat:subagent.tab.* i18n 键存在性 smoke', () => {
  for (const path of REQUIRED_TAB_KEYS) {
    const display = `chat:${path.join('.')}`
    it(`[zh-CN] ${display} 存在且为非空字符串`, () => {
      const value = readKey(chatZh as never, path)
      expect(typeof value).toBe('string')
      expect((value as string).trim().length).toBeGreaterThan(0)
    })
    it(`[en-US] ${display} 存在且为非空字符串`, () => {
      const value = readKey(chatEn as never, path)
      expect(typeof value).toBe('string')
      expect((value as string).trim().length).toBeGreaterThan(0)
    })
  }
})
