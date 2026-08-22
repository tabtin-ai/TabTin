import { afterEach, describe, expect, it } from 'vitest'
import { openSharedResourceTab } from './openSharedResource'
import { useAuthStore } from '@/stores/useAuthStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'

describe('openSharedResourceTab', () => {
  afterEach(() => {
    useAuthStore.setState({ user: null })
    useSpaceStore.setState({ spaces: [] })
    useSpaceContextTabsStore.setState({
      activeKeyBySpace: {},
      displayKeyBySpace: {},
      tabOrderBySpace: {},
      itemsBySpace: {},
      lastActiveSubagentByParentSession: {},
    })
  })

  it('显式 scope 时把共享资源留在当前 IM 会话桌面', () => {
    openSharedResourceTab({
      hostSpaceId: 'host-space-1',
      resourceType: 'doc',
      resourceId: 'doc-1',
      resourceSpaceId: 'resource-space-1',
      organizationId: 'org-resource',
      title: '需求文档',
      tabScopeKey: 'im:conversation-1',
    })

    expect(useSpaceContextTabsStore.getState().activeKeyBySpace).toHaveProperty(
      'im:conversation-1',
      'tabdoc:doc-1',
    )
  })

  it('opens shared IM resources in the desktop scope instead of a Session scope', () => {
    useAuthStore.setState({ user: { id: 'user-1' } as never })
    useSpaceStore.setState({
      spaces: [{ id: 'host-space-1', organization_id: 'org-host' }],
    } as never)

    openSharedResourceTab({
      hostSpaceId: 'host-space-1',
      resourceType: 'table',
      resourceId: 'table-1',
      resourceSpaceId: 'resource-space-1',
      organizationId: 'org-resource',
      title: '客户表',
    })

    const desktopScopeKey = 'desktop:organization:org-host:user:user-1'
    expect(useSpaceContextTabsStore.getState().activeKeyBySpace).toHaveProperty(
      desktopScopeKey,
      'tabdata:table-1',
    )
    expect(useSpaceContextTabsStore.getState().activeKeyBySpace).not.toHaveProperty(
      'conversation:session-1',
    )
  })

  it('云文档侧栏显式 scope 时把分享资源开进 cloud-docs 桶而非 desktop', () => {
    useAuthStore.setState({ user: { id: 'user-1' } as never })
    useSpaceStore.setState({
      spaces: [{ id: 'host-space-1', organization_id: 'org-host' }],
    } as never)

    const cloudDocsScope = 'cloud-docs:organization:org-host:user:user-1'
    openSharedResourceTab({
      hostSpaceId: 'host-space-1',
      resourceType: 'table',
      resourceId: 'table-shared-1',
      resourceSpaceId: 'owner-space-1',
      organizationId: 'org-host',
      title: 'win58表格2',
      tabScopeKey: cloudDocsScope,
    })

    expect(useSpaceContextTabsStore.getState().activeKeyBySpace).toHaveProperty(
      cloudDocsScope,
      'tabdata:table-shared-1',
    )
    expect(useSpaceContextTabsStore.getState().activeKeyBySpace).not.toHaveProperty(
      'desktop:organization:org-host:user:user-1',
    )
  })

  it('同文档已在 cloud-docs 时再从 IM 打开 → migrate 到目标桶，禁止双写', () => {
    useAuthStore.setState({ user: { id: 'user-1' } as never })
    useSpaceStore.setState({
      spaces: [{ id: 'host-space-1', organization_id: 'org-host' }],
    } as never)

    const cloudDocsScope = 'cloud-docs:organization:org-host:user:user-1'
    const draftScope = 'conversation:draft:host-space-1'
    const tabKey = 'tabdoc:doc-shared-1'

    useSpaceContextTabsStore.setState({
      tabOrderBySpace: {
        [cloudDocsScope]: [tabKey],
        [draftScope]: [tabKey, 'apphome:tabdoc'],
      },
      itemsBySpace: {
        [cloudDocsScope]: {
          [tabKey]: {
            tabKey,
            type: 'tabdoc',
            id: 'doc-shared-1',
            title: '旧桶',
            meta: { foreignShared: true },
          },
        },
        [draftScope]: {
          [tabKey]: {
            tabKey,
            type: 'tabdoc',
            id: 'doc-shared-1',
            title: '草稿桶',
            meta: {},
          },
          'apphome:tabdoc': {
            tabKey: 'apphome:tabdoc',
            type: 'apphome',
            id: 'tabdoc',
            title: '文档',
          },
        },
      },
      activeKeyBySpace: {
        [cloudDocsScope]: tabKey,
        [draftScope]: tabKey,
      },
      displayKeyBySpace: {},
      lastActiveSubagentByParentSession: {},
    })

    openSharedResourceTab({
      hostSpaceId: 'host-space-1',
      resourceType: 'doc',
      resourceId: 'doc-shared-1',
      organizationId: 'org-host',
      title: '需求文档',
      tabScopeKey: 'im:conversation-1',
    })

    const state = useSpaceContextTabsStore.getState()
    expect(state.activeKeyBySpace['im:conversation-1']).toBe(tabKey)
    expect(state.tabOrderBySpace['im:conversation-1']).toContain(tabKey)
    expect(state.tabOrderBySpace[cloudDocsScope] ?? []).not.toContain(tabKey)
    expect(state.tabOrderBySpace[draftScope] ?? []).not.toContain(tabKey)
    expect(state.itemsBySpace[cloudDocsScope]?.[tabKey]).toBeUndefined()
    expect(state.itemsBySpace[draftScope]?.[tabKey]).toBeUndefined()
    expect(state.itemsBySpace['im:conversation-1']?.[tabKey]?.meta?.foreignShared).toBe(true)
  })
})
