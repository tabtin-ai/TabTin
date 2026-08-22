import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSpaces = [
  { id: 'space-1', organization_id: 'ws-1' },
  { id: 'space-2', organization_id: 'ws-1' },
  { id: 'space-3', organization_id: 'ws-2' },
]

vi.mock('../useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({ spaces: mockSpaces }),
  },
}))

describe('useSpaceViewPrefsStore', () => {
  beforeEach(async () => {
    vi.resetModules()
    localStorage.clear()
  })

  it('resourceScope 在同一 organization 内共享记忆', async () => {
    const { useSpaceViewPrefsStore } = await import('../useSpaceViewPrefsStore')

    useSpaceViewPrefsStore.getState().setResourceScope('space-1', 'space')

    expect(useSpaceViewPrefsStore.getState().getPrefs('space-1').resourceScope).toBe('space')
    expect(useSpaceViewPrefsStore.getState().getPrefs('space-2').resourceScope).toBe('space')
    expect(useSpaceViewPrefsStore.getState().getPrefs('space-3').resourceScope).toBe('organization')
  })

  describe('对话模式右侧画布默认折叠', () => {
    it('无任何记录时默认折叠（聚焦对话心流）', async () => {
      const { useSpaceViewPrefsStore } = await import('../useSpaceViewPrefsStore')

      expect(useSpaceViewPrefsStore.getState().getCanvasCollapsed('scope-x')).toBe(true)
      // 带 legacy space id 但该 space 无显式记录 → 仍默认折叠
      expect(useSpaceViewPrefsStore.getState().getCanvasCollapsed('scope-y', 'space-1')).toBe(true)
    })

    it('用户手动展开/折叠后按 scope 记住', async () => {
      const { useSpaceViewPrefsStore } = await import('../useSpaceViewPrefsStore')

      useSpaceViewPrefsStore.getState().setCanvasCollapsedForScope('scope-a', false)
      expect(useSpaceViewPrefsStore.getState().getCanvasCollapsed('scope-a')).toBe(false)

      useSpaceViewPrefsStore.getState().setCanvasCollapsedForScope('scope-b', true)
      expect(useSpaceViewPrefsStore.getState().getCanvasCollapsed('scope-b')).toBe(true)

      // 未设置过的 scope 不受影响，仍走默认折叠
      expect(useSpaceViewPrefsStore.getState().getCanvasCollapsed('scope-c')).toBe(true)
    })

    it('legacy per-space 显式布尔值仍被尊重', async () => {
      const { useSpaceViewPrefsStore } = await import('../useSpaceViewPrefsStore')

      // 模拟历史 per-space 记录里存过 canvasCollapsed=false（展开）
      useSpaceViewPrefsStore.setState(state => ({
        prefsBySpace: {
          ...state.prefsBySpace,
          'space-2': { ...state.getPrefs('space-2'), canvasCollapsed: false },
        },
      }))

      // scope 无记录 → 回落到 legacy space 的显式值（展开）
      expect(useSpaceViewPrefsStore.getState().getCanvasCollapsed('fresh-scope', 'space-2')).toBe(false)
    })
  })

  describe('任务三态视图', () => {
    it('默认从旧画布折叠态兼容推导，并按 scope 独立记忆', async () => {
      const { useSpaceViewPrefsStore } = await import('../useSpaceViewPrefsStore')
      const store = useSpaceViewPrefsStore.getState()

      expect(store.getTaskViewMode('conversation:a')).toBe('chat-focus')
      store.setTaskViewModeForScope('conversation:a', 'app-focus')
      store.setTaskViewModeForScope('conversation:b', 'split')

      expect(useSpaceViewPrefsStore.getState().getTaskViewMode('conversation:a')).toBe('app-focus')
      expect(useSpaceViewPrefsStore.getState().getTaskViewMode('conversation:b')).toBe('split')
      expect(useSpaceViewPrefsStore.getState().getCanvasCollapsed('conversation:a')).toBe(false)
    })

    it('资源打开沿旧 API 展开画布时同步进入分屏', async () => {
      const { useSpaceViewPrefsStore } = await import('../useSpaceViewPrefsStore')
      const store = useSpaceViewPrefsStore.getState()
      store.setTaskViewModeForScope('conversation:a', 'chat-focus')
      store.setCanvasCollapsedForScope('conversation:a', false)

      expect(useSpaceViewPrefsStore.getState().getTaskViewMode('conversation:a')).toBe('split')
    })

    it('应用聚焦下展开画布不得碾成分屏', async () => {
      const { useSpaceViewPrefsStore } = await import('../useSpaceViewPrefsStore')
      const store = useSpaceViewPrefsStore.getState()
      store.setTaskViewModeForScope('conversation:a', 'app-focus')
      store.setCanvasCollapsedForScope('conversation:a', false)

      expect(useSpaceViewPrefsStore.getState().getTaskViewMode('conversation:a')).toBe('app-focus')
      expect(useSpaceViewPrefsStore.getState().getCanvasCollapsed('conversation:a')).toBe(false)
    })

    it('IM 会话桌面展开画布时同步进入分屏，收起可修复脱节态', async () => {
      const { useSpaceViewPrefsStore } = await import('../useSpaceViewPrefsStore')
      const store = useSpaceViewPrefsStore.getState()
      const scopeKey = 'im:conv-42'

      store.setTaskViewModeForScope(scopeKey, 'chat-focus')
      store.setCanvasCollapsedForScope(scopeKey, false)

      expect(useSpaceViewPrefsStore.getState().getTaskViewMode(scopeKey)).toBe('split')
      expect(useSpaceViewPrefsStore.getState().getCanvasCollapsed(scopeKey)).toBe(false)

      // 模拟历史脱节：mode 已是 chat-focus，但画布仍展开——标签栏「收起」必须仍能写回折叠。
      useSpaceViewPrefsStore.setState((state) => ({
        taskViewModeByScopeKey: {
          ...state.taskViewModeByScopeKey,
          [scopeKey]: 'chat-focus',
        },
        canvasCollapsedByScopeKey: {
          ...state.canvasCollapsedByScopeKey,
          [scopeKey]: false,
        },
      }))
      useSpaceViewPrefsStore.getState().setTaskViewModeForScope(scopeKey, 'chat-focus')

      expect(useSpaceViewPrefsStore.getState().getTaskViewMode(scopeKey)).toBe('chat-focus')
      expect(useSpaceViewPrefsStore.getState().getCanvasCollapsed(scopeKey)).toBe(true)
    })

    it('草稿转正式任务后可清理草稿现场', async () => {
      const { useSpaceViewPrefsStore } = await import('../useSpaceViewPrefsStore')
      const store = useSpaceViewPrefsStore.getState()
      store.setTaskViewModeForScope('conversation:draft:space-1', 'app-focus')
      store.clearTaskViewModeForScope('conversation:draft:space-1')

      expect(
        useSpaceViewPrefsStore.getState().taskViewModeByScopeKey['conversation:draft:space-1'],
      ).toBeUndefined()
      expect(
        useSpaceViewPrefsStore.getState().getTaskViewMode('conversation:draft:space-1'),
      ).toBe('chat-focus')
    })
  })

  describe('v12 迁移：清理历史画布折叠噪音', () => {
    it('清空 canvasCollapsedByScopeKey 并剥离 legacy canvasCollapsed', async () => {
      const { useSpaceViewPrefsStore } = await import('../useSpaceViewPrefsStore')
      const migrate = useSpaceViewPrefsStore.persist.getOptions().migrate!

      const migrated = migrate(
        {
          canvasCollapsedByScopeKey: { 'scope-a': false, 'scope-b': true },
          sidebarModeByOrganizationUser: { 'organization-user:ws-1:u1': 'conversations' },
          prefsBySpace: {
            'space-1': { sidebarMode: 'conversations', canvasCollapsed: false },
            'space-2': { sidebarMode: 'desktop' },
          },
        },
        11,
      ) as {
        canvasCollapsedByScopeKey: Record<string, boolean>
        sidebarModeByOrganizationUser: Record<string, string>
        prefsBySpace: Record<string, Record<string, unknown>>
      }

      expect(migrated.canvasCollapsedByScopeKey).toEqual({})
      expect('canvasCollapsed' in migrated.prefsBySpace['space-1']).toBe(false)
      expect('canvasCollapsed' in migrated.prefsBySpace['space-2']).toBe(false)
      // 其它偏好不受影响
      expect(migrated.prefsBySpace['space-1'].sidebarMode).toBe('conversations')
      expect(migrated.sidebarModeByOrganizationUser).toEqual({ 'organization-user:ws-1:u1': 'conversations' })
    })
  })

  describe('Workspace 列表排序偏好', () => {
    it('默认按名称，可切换为按最近活跃', async () => {
      const { useSpaceViewPrefsStore } = await import('../useSpaceViewPrefsStore')

      expect(useSpaceViewPrefsStore.getState().workspaceListSortMode).toBe('name')
      useSpaceViewPrefsStore.getState().setWorkspaceListSortMode('activity')
      expect(useSpaceViewPrefsStore.getState().workspaceListSortMode).toBe('activity')
    })

    it('v13 迁移补齐缺省排序模式', async () => {
      const { useSpaceViewPrefsStore } = await import('../useSpaceViewPrefsStore')
      const migrate = useSpaceViewPrefsStore.persist.getOptions().migrate!

      const migrated = migrate(
        {
          pinnedAgentIds: [],
        },
        12,
      ) as { workspaceListSortMode?: string }

      expect(migrated.workspaceListSortMode).toBe('name')
    })
  })

  describe('新任务最近 Workspace 偏好', () => {
    it('按组织隔离记录最后主动使用的 Workspace', async () => {
      const { useSpaceViewPrefsStore } = await import('../useSpaceViewPrefsStore')
      const store = useSpaceViewPrefsStore.getState()

      store.setLastUsedWorkspaceId('org-a', 'space-1')
      store.setLastUsedWorkspaceId('org-b', 'space-3')

      expect(useSpaceViewPrefsStore.getState().getLastUsedWorkspaceId('org-a')).toBe('space-1')
      expect(useSpaceViewPrefsStore.getState().getLastUsedWorkspaceId('org-b')).toBe('space-3')
      expect(useSpaceViewPrefsStore.getState().getLastUsedWorkspaceId('org-c')).toBeNull()
    })

    it('v15 迁移为旧用户补空映射，不改变其它偏好', async () => {
      const { useSpaceViewPrefsStore } = await import('../useSpaceViewPrefsStore')
      const migrate = useSpaceViewPrefsStore.persist.getOptions().migrate!

      const migrated = migrate(
        { workspaceListSortMode: 'activity' },
        14,
      ) as {
        workspaceListSortMode: string
        lastUsedWorkspaceIdByOrganization: Record<string, string>
      }

      expect(migrated.workspaceListSortMode).toBe('activity')
      expect(migrated.lastUsedWorkspaceIdByOrganization).toEqual({})
    })
  })

  describe('云盘当前文件夹偏好', () => {
    it('按组织隔离记录并恢复当前文件夹', async () => {
      const { useSpaceViewPrefsStore } = await import('../useSpaceViewPrefsStore')
      const store = useSpaceViewPrefsStore.getState()

      store.setCloudDriveBrowseFolderId('org-a', 'folder-a')
      store.setCloudDriveBrowseFolderId('org-b', 'folder-b')

      expect(useSpaceViewPrefsStore.getState().getCloudDriveBrowseFolderId('org-a')).toBe('folder-a')
      expect(useSpaceViewPrefsStore.getState().getCloudDriveBrowseFolderId('org-b')).toBe('folder-b')
      expect(useSpaceViewPrefsStore.getState().getCloudDriveBrowseFolderId('org-c')).toBeNull()
    })

    it('返回根目录时清除该组织的历史文件夹', async () => {
      const { useSpaceViewPrefsStore } = await import('../useSpaceViewPrefsStore')
      const store = useSpaceViewPrefsStore.getState()

      store.setCloudDriveBrowseFolderId('org-a', 'folder-a')
      store.setCloudDriveBrowseFolderId('org-a', null)

      expect(useSpaceViewPrefsStore.getState().getCloudDriveBrowseFolderId('org-a')).toBeNull()
      expect(useSpaceViewPrefsStore.getState().cloudDriveBrowseFolderIdByOrganization).not.toHaveProperty('org-a')
    })

    it('v18 迁移为旧用户补空映射', async () => {
      const { useSpaceViewPrefsStore } = await import('../useSpaceViewPrefsStore')
      const migrate = useSpaceViewPrefsStore.persist.getOptions().migrate!

      const migrated = migrate({ pinnedAgentIds: ['agent-a'] }, 17) as {
        pinnedAgentIds: string[]
        cloudDriveBrowseFolderIdByOrganization: Record<string, string>
      }

      expect(migrated.pinnedAgentIds).toEqual(['agent-a'])
      expect(migrated.cloudDriveBrowseFolderIdByOrganization).toEqual({})
    })
  })

  describe('ActivityRail 域顺序', () => {
    it('默认 undefined（未拖过），写入后按新顺序返回', async () => {
      const { useSpaceViewPrefsStore } = await import('../useSpaceViewPrefsStore')

      expect(useSpaceViewPrefsStore.getState().activityRailDomainOrder).toBeUndefined()

      useSpaceViewPrefsStore.getState().setActivityRailDomainOrder(
        ['messages', 'tasks', 'agents', 'cloud-docs', 'projects'],
      )

      expect(useSpaceViewPrefsStore.getState().activityRailDomainOrder)
        .toEqual(['messages', 'tasks', 'agents', 'cloud-docs', 'projects'])
    })

    it('相同顺序重复写入是幂等空操作', async () => {
      const { useSpaceViewPrefsStore } = await import('../useSpaceViewPrefsStore')
      const order: Array<'tasks' | 'messages' | 'agents' | 'cloud-docs' | 'projects'> =
        ['messages', 'tasks', 'agents', 'cloud-docs', 'projects']

      useSpaceViewPrefsStore.getState().setActivityRailDomainOrder(order)
      const before = useSpaceViewPrefsStore.getState()
      before.setActivityRailDomainOrder([...order])
      // 幂等：state 引用不变，不触发多余订阅通知
      expect(useSpaceViewPrefsStore.getState()).toBe(before)
    })

    it('v19 迁移清洗非法顺序值，合法值原样保留', async () => {
      const { useSpaceViewPrefsStore } = await import('../useSpaceViewPrefsStore')
      const migrate = useSpaceViewPrefsStore.persist.getOptions().migrate!

      const illegal = migrate({ activityRailDomainOrder: ['tasks', 'dead-domain'] }, 18) as {
        activityRailDomainOrder?: string[]
      }
      expect(illegal.activityRailDomainOrder).toBeUndefined()

      const notArray = migrate({ activityRailDomainOrder: 'tasks' }, 18) as {
        activityRailDomainOrder?: string[]
      }
      expect(notArray.activityRailDomainOrder).toBeUndefined()

      const legalOrder = ['messages', 'tasks', 'agents', 'cloud-docs', 'projects']
      const legal = migrate({ activityRailDomainOrder: legalOrder }, 18) as {
        activityRailDomainOrder?: string[]
      }
      expect(legal.activityRailDomainOrder).toEqual(legalOrder)
    })
  })
})
