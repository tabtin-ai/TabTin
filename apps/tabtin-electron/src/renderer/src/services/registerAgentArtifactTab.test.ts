import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  tabsState: {
    itemsBySpace: {} as Record<string, Record<string, unknown>>,
    explicitClosedTabKeysByScope: {} as Record<string, string[]>,
  },
}))

vi.mock('./resourceRouter', () => ({
  resourceRouter: { open: mocks.open },
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => mocks.tabsState,
  },
}))

vi.mock('./openResourceLink', () => ({
  resolveSpaceIdForResourceLink: () => 'space-1',
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}))

import {
  _clearAgentArtifactRegistrationState,
  registerAgentArtifactTab,
} from './registerAgentArtifactTab'

describe('registerAgentArtifactTab', () => {
  beforeEach(() => {
    mocks.open.mockReset()
    mocks.tabsState.itemsBySpace = {}
    mocks.tabsState.explicitClosedTabKeysByScope = {}
    mocks.open.mockResolvedValue({ outcome: 'in_space_opened' })
    _clearAgentArtifactRegistrationState()
  })

  it('只向 conversation scope 静默登记，不展开应用', async () => {
    await expect(registerAgentArtifactTab({
      tabScopeKey: 'conversation:session-1',
      resourceType: 'table',
      resourceId: 'table-1',
      title: '风险清单',
      token: 'present-token',
    })).resolves.toBe(true)

    expect(mocks.open).toHaveBeenCalledWith(
      'space-1',
      expect.objectContaining({ type: 'table', id: 'table-1' }),
      expect.objectContaining({
        tabScopeKey: 'conversation:session-1',
        registerOnly: true,
      }),
    )
  })

  it('标签已存在时幂等，不重复路由', async () => {
    mocks.tabsState.itemsBySpace['conversation:session-1'] = {
      'tabdata:table-1': { id: 'table-1' },
    }

    await expect(registerAgentArtifactTab({
      tabScopeKey: 'conversation:session-1',
      resourceType: 'table',
      resourceId: 'table-1',
    })).resolves.toBe(true)
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('拒绝 desktop scope 与浏览器网页，避免后台创建 WebContentsView', async () => {
    await expect(registerAgentArtifactTab({
      tabScopeKey: 'desktop:org:user',
      resourceType: 'doc',
      resourceId: 'doc-1',
    })).resolves.toBe(false)
    await expect(registerAgentArtifactTab({
      tabScopeKey: 'conversation:session-1',
      resourceType: 'webpage',
      resourceId: 'https://example.com',
    })).resolves.toBe(false)
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('显式关闭的标签不会被历史消息重新挂载时自动恢复', async () => {
    mocks.tabsState.explicitClosedTabKeysByScope['conversation:session-1'] = [
      'file:artifacts/report.md',
    ]

    await expect(registerAgentArtifactTab({
      tabScopeKey: 'conversation:session-1',
      resourceType: 'file',
      resourceId: 'artifacts/report.md',
    })).resolves.toBe(true)
    expect(mocks.open).not.toHaveBeenCalled()
  })

})
