import { describe, expect, it } from 'vitest'
import { shouldInjectBrowserNavigationAllowlist } from '../restricted-shell-mode-policy'

describe('shouldInjectBrowserNavigationAllowlist', () => {
  it.each(['ask', 'plan', 'study'] as const)('%s 模式保留仅导航的浏览能力', (mode) => {
    expect(shouldInjectBrowserNavigationAllowlist(mode)).toBe(true)
  })

  it.each(['agent', 'group', 'yolo'] as const)('%s 模式不需要受限 shell 导航白名单', (mode) => {
    expect(shouldInjectBrowserNavigationAllowlist(mode)).toBe(false)
  })
})
