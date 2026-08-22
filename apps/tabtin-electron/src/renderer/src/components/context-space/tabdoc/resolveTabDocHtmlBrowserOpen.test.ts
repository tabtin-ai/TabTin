import { describe, expect, it } from 'vitest'
import { resolveTabDocHtmlBrowserOpenTarget } from './resolveTabDocHtmlBrowserOpen'

describe('resolveTabDocHtmlBrowserOpenTarget', () => {
  it('cloud-docs 模式写入 cloud-docs 全局 scope（侧栏 Dock + 主画布）', () => {
    const target = resolveTabDocHtmlBrowserOpenTarget({
      workbenchMode: 'cloud-docs',
      spaceId: 'space-1',
      documentId: 'doc-1',
      organizationId: 'org-1',
      userId: 'user-1',
    })
    expect(target.tabScopeKey).toBe(
      'cloud-docs:organization:org-1:user:user-1',
    )
  })

  it('space 模式使用前台 scope', () => {
    const target = resolveTabDocHtmlBrowserOpenTarget({
      workbenchMode: 'space',
      spaceId: 'space-1',
      documentId: 'doc-1',
      fallbackTabScopeKey: 'desktop:organization:org-1:user:user-1',
    })
    expect(target.tabScopeKey).toBe('desktop:organization:org-1:user:user-1')
  })
})
