import { describe, expect, it } from 'vitest'

import zhSpace from '@/i18n/locales/zh-CN/space.json'
import enSpace from '@/i18n/locales/en-US/space.json'
import zhChat from '@/i18n/locales/zh-CN/chat.json'
import enChat from '@/i18n/locales/en-US/chat.json'

/** 产品层禁止再向用户暴露的历史口径 */
const FORBIDDEN_USER_COPY = [
  /bot Agent/i,
  /绑定固定 Agent/,
  /Agent 绑定/,
  /Agent 档案/,
  /Space 设置/,
  /Space 管理/,
  /Agent 目录/,
  /Agent directory/i,
  /属于 Space/,
  /(?:小\s*)?Tin/,
]

const SPACE_BEHAVIOR_KEYS = [
  'menu.settings',
  'profileRules.label',
  'profileRules.hint',
  'profileRules.resetToDefault',
  'profileSheet.noExecutionContext',
  'profileSheet.workingDirTitle',
  'sessionExpired.description',
  'remoteExecution.chatNoDeviceDesc',
  'create.workingDirHint',
  'fields.customRulesPlaceholder',
  'fields.customRulesHint',
  'profilePane.previewHints.rules',
  'profilePane.previewHints.deviceUnbound',
  'extensions.desc',
  'executionLimits.enabled',
  'executionLimits.fillRecommended',
  'workingDir.changeDisabled',
] as const

const CHAT_WORKSPACE_KEYS = [
  'sessionList.openSpaceSettings',
  'card.openFile.openInWorkspace',
] as const

function getNestedValue(source: Record<string, unknown>, dottedKey: string): string {
  const value = dottedKey.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part]
    }
    return undefined
  }, source)
  return typeof value === 'string' ? value : ''
}

describe('space behavior copy ', () => {
  it.each(SPACE_BEHAVIOR_KEYS)('zh-CN %s 不含 Agent 绑定历史口径', (key) => {
    const text = getNestedValue(zhSpace as Record<string, unknown>, key)
    expect(text.length).toBeGreaterThan(0)
    for (const pattern of FORBIDDEN_USER_COPY) {
      expect(text).not.toMatch(pattern)
    }
  })

  it('menu.settings 分语言：zh 工作空间 / en Workspace', () => {
    expect(zhSpace.menu.settings).toBe('工作空间设置')
    expect(enSpace.menu.settings).toBe('Workspace settings')
  })

  it('profileSheet.workingDirTitle 分语言：zh 工作目录 / en Working directory', () => {
    expect(zhSpace.profileSheet.workingDirTitle).toBe('工作目录')
    expect(enSpace.profileSheet.workingDirTitle).toBe('Working directory')
  })

  it('workingDir.pathLabel 分语言：zh 工作目录 / en Working directory', () => {
    expect(zhSpace.workingDir.pathLabel).toBe('工作目录')
    expect(enSpace.workingDir.pathLabel).toBe('Working directory')
  })

  it.each(CHAT_WORKSPACE_KEYS)('zh-CN chat %s 不含历史 Space/Agent 目录口径', (key) => {
    const text = getNestedValue(zhChat as Record<string, unknown>, key)
    expect(text.length).toBeGreaterThan(0)
    for (const pattern of FORBIDDEN_USER_COPY) {
      expect(text).not.toMatch(pattern)
    }
  })

  it('sessionList.openSpaceSettings 分语言：zh 工作空间 / en Workspace', () => {
    expect(zhChat.sessionList.openSpaceSettings).toBe('工作空间设置')
    expect(enChat.sessionList.openSpaceSettings).toBe('Workspace settings')
  })
})
