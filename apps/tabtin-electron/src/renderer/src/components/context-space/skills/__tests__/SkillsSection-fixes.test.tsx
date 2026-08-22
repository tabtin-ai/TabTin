/**
 * SkillsSection 回归测试
 * FE-001/FE-003/FE-004/FE-005/FE-007/FE-008
 *
 * Wave 1（PRD V3.3 §11.5）：useSkillSync 已切到 react-query 缓存失效路径，
 * 需要 QueryClientProvider 包裹（renderWithQueryClient helper）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mockToast = vi.fn()
const mockRefetchConfigs = vi.fn().mockResolvedValue({ data: {} })
const mockRefetchSkills = vi.fn().mockResolvedValue({ data: [] })
const mockMutateAsync = vi.fn()
const mockDisableMutateAsync = vi.fn().mockResolvedValue({ found: true })
const mockEnableMutateAsync = vi.fn().mockResolvedValue({ enabled: true })
const mockDeleteMutateAsync = vi.fn().mockResolvedValue({ deleted: true })
const mockStartWatcher = vi.fn()
const mockStopWatcher = vi.fn()
const mockOpenResourceTab = vi.fn()
const mockSetActiveKey = vi.fn()

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, ...props }: any) => <button type="button" {...props}>{children}</button>,
  Dialog: ({ children, open }: any) => open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: any) => <div data-testid="dialog-content">{children}</div>,
  Input: (props: any) => <input {...props} />,
  toast: mockToast,
  TooltipProvider: ({ children }: any) => <>{children}</>,
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ children }: any) => <>{children}</>,
  TooltipContent: ({ children }: any) => <>{children}</>,
  ConfirmDialog: ({ open, title, description, confirmText, onConfirm }: any) => open ? (
    <div data-testid="confirm-dialog">
      <div>{title}</div>
      <div>{description}</div>
      <button type="button" onClick={onConfirm}>{confirmText}</button>
    </div>
  ) : null,
}))

vi.mock('@/hooks/queries/skills', () => ({
  useSkillsListQuery: () => ({
    data: [
      { skill_id: 'test-skill', name: 'Test', skill_key: 'managed:test-skill', source: 'managed' },
      {
        skill_id: 'own-user-skill',
        name: 'Own User Skill',
        skill_key: 'user:own-user-skill',
        source: 'user',
        owner_user_id: 'user-1',
        visibility: 'private',
      },
    ],
    isLoading: false,
    refetch: mockRefetchSkills,
  }),
  useSkillConfigsQuery: () => ({
    data: { 'managed:test-skill': { enabled: true } },
    refetch: mockRefetchConfigs,
  }),
  useEnableSkillMutation: () => ({
    mutateAsync: mockEnableMutateAsync,
    isPending: false,
    variables: null,
  }),
  useDisableSkillMutation: () => ({
    mutateAsync: mockDisableMutateAsync,
    isPending: false,
    variables: null,
  }),
  useDeleteSkillMutation: () => ({
    mutateAsync: mockDeleteMutateAsync,
    isPending: false,
  }),
  useUpdateSkillVisibilityMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  usePublishSkillMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useUpdateSkillConfigMutation: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
  }),
  useInstallSkillMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
    variables: null,
  }),
  createSkillSilent: vi.fn(),
  publishSkillSilent: vi.fn(),
  deleteSkillSilent: vi.fn(),
  updateSkillVisibilitySilent: vi.fn(),
  invalidateSkillSpaceQueries: vi.fn(),
  skillKeys: {
    all: ['skills'],
    market: (p: any) => ['skills', 'market', p],
  },
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (sel: any) => sel({
    spaces: [{ id: 'space-1', type: 'personal', organization_id: 'org-1' }],
    selectedAgent: { id: 'agent-1' },
  }),
}))
vi.mock('@stores/useOrganizationStore', () => {
  const state = {
    organizations: [{ id: 'org-1', type: 'team' }],
    selectedOrganization: { id: 'org-1', type: 'team' },
  }
  const useOrganizationStore = (sel?: any) => (typeof sel === 'function' ? sel(state) : state)
  useOrganizationStore.getState = () => state
  useOrganizationStore.subscribe = vi.fn(() => () => {})
  return { useOrganizationStore }
})
vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: (sel: any) => sel({ user: { id: 'user-1' } }),
}))
vi.mock('../useSkillSync', () => ({
  useSkillSync: () => undefined,
}))
vi.mock('../../ContextPageHeader', () => ({
  ContextPageHeader: ({ title, actions }: any) => (
    <div data-testid="context-page-header">
      <div>{title}</div>
      <div>{actions}</div>
    </div>
  ),
}))
vi.mock('@stores/useSpaceContextTabsStore', () => {
  const store = {
    setActiveKey: mockSetActiveKey,
    openResourceTab: mockOpenResourceTab,
  }
  const useSpaceContextTabsStore = (sel: any) => sel(store)
  useSpaceContextTabsStore.getState = () => store
  return { useSpaceContextTabsStore }
})
vi.mock('@components/context-space/folder/useFolderStore', () => ({
  useFolderContextStore: (sel: any) => sel({ addSpaceFolder: vi.fn().mockReturnValue({ folderId: 'f1' }) }),
}))
vi.mock('@components/context-space/registry', () => ({
  contextRegistry: { buildTabKey: vi.fn().mockReturnValue('tab-1') },
}))
vi.mock('@components/context-space/registry/resolveUtils', () => ({
  resolveAppHomeTabModel: vi.fn(() => ({
    title: 'Skill Marketplace',
    labelKey: null,
    displayLabel: 'Skill Marketplace',
    displayEmoji: '✨',
  })),
}))
vi.mock('@/skills/agentSkills', () => ({
  startAgentSkillsWatcher: mockStartWatcher,
  stopAgentSkillsWatcher: mockStopWatcher,
}))
vi.mock('../SkillConfigDialog', () => ({
  SkillConfigDialog: () => <div data-testid="config-dialog" />,
}))
vi.mock('@utils/cn', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}))

let baseRender: any
let screen: any
let fireEvent: any
let act: any
let waitFor: any

const renderWithQueryClient = (ui: React.ReactElement) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return baseRender(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  )
}
const render = (ui: React.ReactElement) => renderWithQueryClient(ui)

beforeEach(async () => {
  vi.clearAllMocks()
  const testingLib = await import('@testing-library/react')
  baseRender = testingLib.render
  screen = testingLib.screen
  fireEvent = testingLib.fireEvent
  act = testingLib.act
  waitFor = testingLib.waitFor

  Object.defineProperty(window, 'tabtin', {
    value: {
      fileSystem: {
        ensureSpaceSandbox: vi.fn().mockResolvedValue({ success: true, path: '/tmp/sandbox' }),
        readDir: vi.fn().mockResolvedValue({ success: true, entries: [] }),
        readFilePreview: vi.fn(),
        watch: vi.fn(),
        onWatchEvent: vi.fn(),
        unwatch: vi.fn(),
      },
    },
    writable: true,
    configurable: true,
  })
})

describe('FE-001 / FE-008: 统一市场入口', () => {
  it('应渲染"探索技能"按钮', async () => {
    const { SkillsSection } = await import('../SkillsSection')
    render(<SkillsSection spaceId="space-1" />)

    const buttons = screen.getAllByText('skills.exploreSkills')
    expect(buttons.length).toBeGreaterThan(0)
  }, 15_000)

  it('点击"探索技能"按钮后应打开统一 Marketplace apphome', async () => {
    const { SkillsSection } = await import('../SkillsSection')
    render(<SkillsSection spaceId="space-1" />)

    const btn = screen.getAllByText('skills.exploreSkills')[0]
    await act(() => fireEvent.click(btn))

    expect(mockOpenResourceTab).toHaveBeenCalledWith('space-1', expect.objectContaining({
      type: 'apphome',
      id: 'marketplace',
      title: 'Skill Marketplace',
      meta: expect.objectContaining({
        appId: 'marketplace',
      }),
    }))
  }, 15_000)
})

describe('FE-005: watcher 生命周期管理 (M9: 主进程统一 watcher)', () => {
  it('组件卸载时不再直接调用 stopAgentSkillsWatcher (改为 IPC)', async () => {
    const { SkillsSection } = await import('../SkillsSection')
    const { unmount } = render(<SkillsSection spaceId="space-1" />)

    unmount()

    expect(mockStopWatcher).not.toHaveBeenCalled()
  })
})

// FE-007: Wave 1（PRD V3.3 §11.5）syncAgentSkills 草稿上云路径已删除，
// 该测试场景不再适用。本地索引由主进程 LocalSkillRegistry 直接扫描。

describe('FE-003: SkillConfigDialog 打开时刷新 configs', () => {
  it('打开配置对话框前应调用 refetchConfigs', async () => {
    const { SkillsSection } = await import('../SkillsSection')
    render(<SkillsSection spaceId="space-1" />)

    const configBtns = screen.getAllByText('apps.config')
    await act(async () => {
      fireEvent.click(configBtns[0])
    })

    await waitFor(() => {
      expect(mockRefetchConfigs).toHaveBeenCalled()
    })
  })
})

describe('#664: 我的 Skill 删除入口', () => {
  it('owner 自己的 user skill 走删除确认和 delete mutation', async () => {
    const { SkillsSection } = await import('../SkillsSection')
    render(<SkillsSection spaceId="space-1" />)

    await act(async () => {
      fireEvent.click(screen.getByText('skills.discardDraft'))
    })
    expect(screen.getByTestId('confirm-dialog')).toBeDefined()

    await act(async () => {
      fireEvent.click(screen.getByText('skills.discardConfirmAction'))
    })

    await waitFor(() => {
      expect(mockDeleteMutateAsync).toHaveBeenCalledWith({
        skillId: 'own-user-skill',
        spaceId: 'space-1',
      })
    })
    expect(mockDisableMutateAsync).not.toHaveBeenCalledWith(
      expect.objectContaining({ canonicalKey: 'user:own-user-skill' }),
    )
  })
})
