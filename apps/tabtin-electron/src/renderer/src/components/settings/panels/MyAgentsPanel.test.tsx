import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MyAgentsPanel } from './MyAgentsPanel'
import { useAgentMemoryFocusStore } from '@/services/agentMemoryNavigation'

const mocks = vi.hoisted(() => ({
  listOrganizationAgents: vi.fn(),
  getCachedOrganizationAgents: vi.fn().mockReturnValue(null),
  listAgentTemplates: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn().mockResolvedValue(true),
  reactivateAgent: vi.fn().mockResolvedValue(true),
  listDeactivatedAgents: vi.fn(),
  permanentDeleteAgent: vi.fn(),
  useSkillLibraryContextSpaceId: vi.fn(),
  loadAgent: vi.fn().mockResolvedValue(null),
  spaceState: {
    error: null as string | null,
    agentCache: {} as Record<string, { id: string; name: string; custom_rules?: string }>,
  },
  organizationState: {
    selectedOrganization: { id: 'org-1' },
  },
  toast: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | { defaultValue?: string; [k: string]: unknown }) => {
      const template = typeof options === 'string'
        ? options
        : typeof options?.defaultValue === 'string' ? options.defaultValue : key
      if (!options || typeof options === 'string') return template
      return Object.entries(options).reduce(
        (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
        template,
      )
    },
  }),
}))

vi.mock('@/services/organizationAgentsApi', () => ({
  listOrganizationAgents: mocks.listOrganizationAgents,
  getCachedOrganizationAgents: mocks.getCachedOrganizationAgents,
}))

vi.mock('@/services/agentTemplatesApi', () => ({
  listAgentTemplates: mocks.listAgentTemplates,
}))

vi.mock('@tabtin/app-shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tabtin/app-shell')>()
  return {
    ...actual,
    SpaceApiService: {
      ...actual.SpaceApiService,
      listDeactivatedAgents: (...args: unknown[]) => mocks.listDeactivatedAgents(...args),
    },
    AgentApiService: {
      ...actual.AgentApiService,
      permanentDeleteAgent: (...args: unknown[]) => mocks.permanentDeleteAgent(...args),
    },
  }
})

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: typeof mocks.organizationState) => unknown) =>
    selector(mocks.organizationState),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: { nickname: string } }) => unknown) =>
    selector({ user: { nickname: '进宝' } }),
}))

vi.mock('@stores/useSpaceStore', () => {
  const state = () => ({
    updateAgent: mocks.updateAgent,
    deleteAgent: mocks.deleteAgent,
    reactivateAgent: mocks.reactivateAgent,
    loadAgent: mocks.loadAgent,
    agentCache: mocks.spaceState.agentCache,
    error: mocks.spaceState.error,
    selectedSpace: null,
    spaces: [],
  })
  const useSpaceStore = Object.assign(
    (selector: (s: ReturnType<typeof state>) => unknown) => selector(state()),
    { getState: state },
  )
  return { useSpaceStore }
})

vi.mock('./SkillLibraryPanel', () => ({
  useSkillLibraryContextSpaceId: (organizationId?: string | null) => {
    mocks.useSkillLibraryContextSpaceId(organizationId)
    return 'space-anchor'
  },
}))

// 记忆治理面（ W3）自成体系、依赖 /agent-memory + 画像 API，这里只验证挂载
// 与 agentId 直入，避免把整棵治理子树的 API 依赖拉进 MyAgentsPanel 单测。
vi.mock('./AgentMemoryGovernancePanel', () => ({
  AgentMemoryGovernancePanel: ({
    agentId,
    organizationId,
  }: {
    agentId: string
    organizationId: string
  }) => (
    <div
      data-testid="agent-memory-governance"
      data-agent-id={agentId}
      data-organization-id={organizationId}
    />
  ),
}))

vi.mock('@components/space-settings/AgentSkillsPanel', () => ({
  AgentSkillsPanel: ({ agentId }: { agentId?: string }) => (
    <div data-testid="agent-skills-panel" data-agent-id={agentId ?? ''} />
  ),
}))

vi.mock('@components/sidebar/NewAgentButton', () => ({
  NewAgentDialog: ({
    open,
    organizationId,
  }: {
    open: boolean
    organizationId?: string | null
  }) => (
    open
      ? <div data-testid="new-agent-dialog" data-organization-id={organizationId} />
      : null
  ),
}))

vi.mock('@components/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
  toast: (...args: unknown[]) => mocks.toast(...args),
  ConfirmDialog: ({
    open,
    title,
    confirmLabel,
    confirmText,
    onConfirm,
  }: {
    open: boolean
    title?: string
    confirmLabel?: string
    confirmText?: string
    onConfirm?: () => void | Promise<void>
  }) => (
    open
      ? (
        <div data-testid="confirm-dialog" role="dialog" aria-label={title}>
          <button
            type="button"
            onClick={() => {
              const result = onConfirm?.()
              if (result instanceof Promise) void result.catch(() => undefined)
            }}
          >
            {confirmText || confirmLabel || 'confirm'}
          </button>
        </div>
      )
      : null
  ),
}))

describe('MyAgentsPanel', () => {
  beforeEach(() => {
    mocks.listOrganizationAgents.mockReset()
    mocks.getCachedOrganizationAgents.mockReset().mockReturnValue(null)
    mocks.listAgentTemplates.mockReset().mockResolvedValue([
      { id: 'code-engineer', name: '代码版' },
    ])
    mocks.updateAgent.mockReset()
    mocks.deleteAgent.mockReset().mockResolvedValue(true)
    mocks.reactivateAgent.mockReset().mockResolvedValue(true)
    mocks.listDeactivatedAgents.mockReset().mockResolvedValue({ items: [], total: 0 })
    mocks.permanentDeleteAgent.mockReset().mockResolvedValue(undefined)
    mocks.useSkillLibraryContextSpaceId.mockReset()
    mocks.loadAgent.mockReset().mockResolvedValue(null)
    mocks.spaceState.error = null
    mocks.spaceState.agentCache = {}
    mocks.organizationState.selectedOrganization = { id: 'org-1' }
    mocks.toast.mockReset()
    useAgentMemoryFocusStore.setState({
      organizationId: null,
      agentId: null,
      memoryId: null,
      nonce: 0,
    })
  })

  it('独立工作台使用一级页面标题，设置入口保留设置页标题层级', () => {
    mocks.listOrganizationAgents.mockImplementation(() => new Promise(() => {}))
    mocks.listAgentTemplates.mockImplementation(() => new Promise(() => {}))

    const { unmount } = render(<MyAgentsPanel standalone />)
    expect(screen.getByRole('heading', { level: 1, name: 'AI 分身' })).toBeTruthy()
    unmount()

    render(<MyAgentsPanel />)
    expect(screen.getByRole('heading', { level: 2, name: 'sections.myAgents' })).toBeTruthy()
  })

  it('嵌入任务侧栏工作台时隐藏面板页眉，开新分身仍可用', () => {
    mocks.listOrganizationAgents.mockImplementation(() => new Promise(() => {}))
    mocks.listAgentTemplates.mockImplementation(() => new Promise(() => {}))

    render(<MyAgentsPanel hidePageHeader />)
    expect(screen.queryByRole('heading', { level: 1, name: 'AI 分身' })).toBeNull()
    expect(screen.queryByRole('heading', { level: 2, name: 'sections.myAgents' })).toBeNull()
    expect(screen.getByRole('button', { name: '开新分身' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '已停用' })).toBeTruthy()
  })

  it('上交页眉动作后列表区不再重复「开新分身 / 已停用」', () => {
    mocks.listOrganizationAgents.mockImplementation(() => new Promise(() => {}))
    mocks.listAgentTemplates.mockImplementation(() => new Promise(() => {}))
    const onHeaderActions = vi.fn()

    render(<MyAgentsPanel hidePageHeader onHeaderActions={onHeaderActions} />)

    expect(onHeaderActions).toHaveBeenCalled()
    const hosted = onHeaderActions.mock.calls.find(
      (call) => call[0] != null,
    )?.[0] as React.ReactElement
    expect(hosted).toBeTruthy()

    // 列表标题行只保留「我的 AI 分身」，动作已上交宿主页眉
    expect(screen.getByRole('heading', { name: '我的 AI 分身' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '开新分身' })).toBeNull()
    expect(screen.queryByRole('button', { name: '已停用' })).toBeNull()
  })

  it('列表渲染 Agent 行：角色名 + 来源角标（模板名 / 自建）', async () => {
    mocks.listOrganizationAgents.mockResolvedValue([
      { id: 'agent-1', name: '代码版', template_id: 'code-engineer' },
      { id: 'agent-2', name: '自定义号', template_id: '' },
    ])

    render(<MyAgentsPanel />)

    // 未改名的模板实例：名字与模板名角标同文，用 findAll
    expect((await screen.findAllByText('代码版')).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('自定义号')).toBeTruthy()
    // 模板实例角标显示模板名；纯自建显示「自建」
    await waitFor(() => {
      expect(screen.getAllByText('代码版').length).toBeGreaterThanOrEqual(1)
    })
    expect(screen.getByText('自建')).toBeTruthy()
    // 行尾「＋开新分身」
    fireEvent.click(screen.getByRole('button', { name: /开新分身/ }))
    expect(screen.getByTestId('new-agent-dialog')).toBeTruthy()
  })

  it('列表行与详情头共用圆形身份头像（默认 logo / 自定义图，）', async () => {
    mocks.listOrganizationAgents.mockResolvedValue([
      { id: 'agent-1', name: '小钛', template_id: '' },
    ])

    render(<MyAgentsPanel />)

    // 主从布局：首个分身自动选中，列表行与详情头各渲染一枚同源身份头像。
    await waitFor(() => {
      expect(screen.getAllByRole('img', { name: '小钛' })).toHaveLength(2)
    })
    const [listAvatar, detailAvatar] = screen.getAllByRole('img', { name: '小钛' })
    expect(listAvatar.tagName).toBe('IMG')
    expect(listAvatar.getAttribute('title')).toBe('小钛')
    expect(listAvatar.className).toContain('rounded-full')
    expect(listAvatar.className).toContain('h-9')
    expect(listAvatar.className).toContain('w-9')
    expect(listAvatar.getAttribute('src')).toBeTruthy()
    expect(detailAvatar.getAttribute('src')).toBe(listAvatar.getAttribute('src'))
    expect(detailAvatar.className).toBe(listAvatar.className)
  })

  it('已保存的人设出现在「人设与规则」编辑区，标题下不再摘要展示', async () => {
    mocks.listOrganizationAgents.mockResolvedValue([
      { id: 'agent-1', name: '代码搭子', template_id: '' },
    ])
    mocks.spaceState.agentCache = {
      'agent-1': {
        id: 'agent-1',
        name: '代码搭子',
        custom_rules: '严谨地分析问题，并优先给出可验证的结论。',
      },
    }

    render(<MyAgentsPanel />)

    const rules = await screen.findByLabelText('人设与规则') as HTMLTextAreaElement
    expect(rules.value).toBe('严谨地分析问题，并优先给出可验证的结论。')
    // 标题行只保留名字 + 角标，不在身份头重复铺人设长文。
    const titleBlock = screen.getByRole('heading', { level: 2, name: '代码搭子' }).parentElement
    expect(titleBlock?.textContent).not.toContain('严谨地分析问题')
  })

  it('人设草稿可编辑并保存到 custom_rules', async () => {
    mocks.listOrganizationAgents.mockResolvedValue([
      { id: 'agent-1', name: '代码搭子', template_id: '' },
    ])
    mocks.spaceState.agentCache = {
      'agent-1': { id: 'agent-1', name: '代码搭子', custom_rules: '' },
    }
    mocks.updateAgent.mockImplementation(async (_agentId: string, updates: { custom_rules?: string }) => {
      mocks.spaceState.agentCache = {
        'agent-1': {
          id: 'agent-1',
          name: '代码搭子',
          custom_rules: updates.custom_rules ?? '',
        },
      }
      return true
    })

    render(<MyAgentsPanel />)

    const rules = await screen.findByLabelText('人设与规则') as HTMLTextAreaElement
    expect(rules.value).toBe('')
    fireEvent.change(rules, { target: { value: '保存后人设应立刻可见' } })
    expect(rules.value).toBe('保存后人设应立刻可见')

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(mocks.updateAgent).toHaveBeenCalledWith('agent-1', {
        custom_rules: '保存后人设应立刻可见',
      })
    })
    await waitFor(() => {
      expect((screen.getByLabelText('人设与规则') as HTMLTextAreaElement).value)
        .toBe('保存后人设应立刻可见')
    })
  })

  it('点行进详情：技能携带集按 agentId 直入，改名成功后刷新列表', async () => {
    mocks.listOrganizationAgents.mockResolvedValue([
      { id: 'agent-1', name: '进宝代码版', template_id: 'code-engineer' },
    ])
    mocks.updateAgent.mockResolvedValue(true)

    render(<MyAgentsPanel />)

    fireEvent.click((await screen.findAllByText('进宝代码版'))[0])

    // 详情默认落在人设 tab；切到技能携带集后再验 agentId 直入
    fireEvent.click(screen.getByRole('button', { name: '技能携带集' }))
    expect(screen.getByTestId('agent-skills-panel').getAttribute('data-agent-id')).toBe('agent-1')
    // 授权记忆属于工作空间安全设置，不能从 Agent 详情猜测任意工作空间。
    expect(screen.queryByText('授权记忆')).toBeNull()

    // 改名：铅笔 → 输入 → 保存
    fireEvent.click(screen.getByRole('button', { name: '改名' }))
    const input = screen.getByLabelText('AI 分身名字') as HTMLInputElement
    fireEvent.change(input, { target: { value: '代码搭子' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(mocks.updateAgent).toHaveBeenCalledWith('agent-1', { name: '代码搭子' })
    })
    // 改名成功 → 重新拉列表（初次 1 次 + 刷新 1 次）
    await waitFor(() => {
      expect(mocks.listOrganizationAgents).toHaveBeenCalledTimes(2)
    })
  })

  it('改名携带保留占位符被后端拒绝时展示防呆提示', async () => {
    mocks.listOrganizationAgents.mockResolvedValue([
      { id: 'agent-1', name: '进宝代码版', template_id: '' },
    ])
    mocks.updateAgent.mockImplementation(async () => {
      mocks.spaceState.error = '名称不能包含保留占位符 {owner}'
      return false
    })

    render(<MyAgentsPanel />)

    // 主从布局：名字在左栏卡片与右栏档案各出现一次，点左栏卡片进入选中。
    fireEvent.click((await screen.findAllByText('进宝代码版'))[0])
    fireEvent.click(screen.getByRole('button', { name: '改名' }))
    const input = screen.getByLabelText('AI 分身名字') as HTMLInputElement
    fireEvent.change(input, { target: { value: '{owner}新名' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText('名字不能包含保留占位符 {owner}')).toBeTruthy()
    // 保持编辑态让用户改正
    expect(screen.getByLabelText('AI 分身名字')).toBeTruthy()
  })

  it('切换 Agent 后保留未保存的人设草稿', async () => {
    mocks.listOrganizationAgents.mockResolvedValue([
      { id: 'agent-1', name: '代码搭子', template_id: '' },
      { id: 'agent-2', name: '研究搭子', template_id: '' },
    ])
    mocks.spaceState.agentCache = {
      'agent-1': { id: 'agent-1', name: '代码搭子', custom_rules: '原始人设' },
      'agent-2': { id: 'agent-2', name: '研究搭子', custom_rules: '研究人设' },
    }

    render(<MyAgentsPanel />)

    const rules = await screen.findByLabelText('人设与规则') as HTMLTextAreaElement
    fireEvent.change(rules, { target: { value: '尚未保存的新草稿' } })
    expect(screen.getByText('未保存')).toBeTruthy()
    fireEvent.change(rules, { target: { value: '原始人设' } })
    expect(screen.queryByText('未保存')).toBeNull()
    fireEvent.change(rules, { target: { value: '尚未保存的新草稿' } })

    fireEvent.click(screen.getByRole('button', { name: /研究搭子/ }))
    expect((screen.getByLabelText('人设与规则') as HTMLTextAreaElement).value).toBe('研究人设')

    fireEvent.click(screen.getByRole('button', { name: /代码搭子/ }))
    expect((screen.getByLabelText('人设与规则') as HTMLTextAreaElement).value).toBe('尚未保存的新草稿')
  })

  it('Agent 详情加载失败时展示可重试状态', async () => {
    mocks.listOrganizationAgents.mockResolvedValue([
      { id: 'agent-1', name: '代码搭子', template_id: '' },
    ])
    mocks.loadAgent.mockResolvedValue(null)

    render(<MyAgentsPanel />)

    expect(
      (await screen.findAllByText('人设加载失败，请重试。')).length,
    ).toBeGreaterThanOrEqual(1)
    fireEvent.click(screen.getAllByRole('button', { name: '重试' })[0])
    await waitFor(() => {
      expect(mocks.loadAgent).toHaveBeenCalledTimes(2)
    })
  })

  it('Agent 列表支持方向键切换选中项', async () => {
    mocks.listOrganizationAgents.mockResolvedValue([
      { id: 'agent-1', name: '代码搭子', template_id: '' },
      { id: 'agent-2', name: '研究搭子', template_id: '' },
    ])
    mocks.spaceState.agentCache = {
      'agent-1': { id: 'agent-1', name: '代码搭子', custom_rules: '' },
      'agent-2': { id: 'agent-2', name: '研究搭子', custom_rules: '' },
    }

    render(<MyAgentsPanel />)

    const firstAgent = await screen.findByRole('button', { name: /代码搭子/ })
    fireEvent.keyDown(firstAgent, { key: 'ArrowDown' })

    expect(screen.getByRole('button', { name: /研究搭子/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('切换组织时立即清空旧 Agent 详情，避免跨组织误操作', async () => {
    mocks.listOrganizationAgents.mockImplementation(async (organizationId: string) => {
      if (organizationId === 'org-1') {
        return [{ id: 'agent-org-1', name: '旧组织 Agent', template_id: '' }]
      }
      return new Promise<never>(() => {})
    })

    const { rerender } = render(<MyAgentsPanel />)
    expect((await screen.findAllByText('旧组织 Agent')).length).toBeGreaterThanOrEqual(1)

    mocks.organizationState.selectedOrganization = { id: 'org-2' }
    rerender(<MyAgentsPanel />)

    await waitFor(() => {
      expect(mocks.listOrganizationAgents).toHaveBeenCalledWith('org-2')
      expect(screen.queryByText('旧组织 Agent')).toBeNull()
    })
  })

  it('深链目标不存在后允许用户切换组织，不再被旧意图拉回', async () => {
    mocks.listOrganizationAgents.mockImplementation(async (organizationId: string) => (
      organizationId === 'org-3'
        ? [{ id: 'agent-org-3', name: '新组织 Agent', template_id: '' }]
        : []
    ))
    useAgentMemoryFocusStore.getState().setFocus({
      organizationId: 'org-2',
      agentId: 'missing-agent',
    })

    const { rerender } = render(<MyAgentsPanel />)
    await waitFor(() => {
      expect(mocks.listOrganizationAgents).toHaveBeenCalledWith('org-2')
    })

    mocks.organizationState.selectedOrganization = { id: 'org-3' }
    rerender(<MyAgentsPanel />)

    await waitFor(() => {
      expect(mocks.listOrganizationAgents).toHaveBeenCalledWith('org-3')
      expect(useAgentMemoryFocusStore.getState().organizationId).toBeNull()
    })
  })

  it('深链携带组织时从目标组织加载并选中 Agent', async () => {
    mocks.listOrganizationAgents.mockImplementation(async (organizationId: string) => (
      organizationId === 'org-2'
        ? [{ id: 'agent-org-2', name: '跨组织 Agent', template_id: '' }]
        : [{ id: 'agent-org-1', name: '错误组织 Agent', template_id: '' }]
    ))
    useAgentMemoryFocusStore.getState().setFocus({
      organizationId: 'org-2',
      agentId: 'agent-org-2',
    })

    render(<MyAgentsPanel />)

    await waitFor(() => {
      expect(mocks.listOrganizationAgents).toHaveBeenCalledWith('org-2')
      expect(mocks.useSkillLibraryContextSpaceId).toHaveBeenCalledWith('org-2')
      expect(
        screen.getByRole('button', { name: /跨组织 Agent/ }).getAttribute('aria-pressed'),
      ).toBe('true')
    })
    fireEvent.click(screen.getByRole('button', { name: /开新分身/ }))
    expect(
      screen.getByTestId('new-agent-dialog').getAttribute('data-organization-id'),
    ).toBe('org-2')
    // 深链带 agentId 时详情应落在记忆 tab
    expect(
      (await screen.findByTestId('agent-memory-governance')).getAttribute('data-organization-id'),
    ).toBe('org-2')
  })

  it('详情管理 tab 展示停用 AI 分身，确认后调用 deleteAgent', async () => {
    mocks.spaceState.agentCache = {
      'agent-1': {
        id: 'agent-1',
        name: '可停用号',
        custom_rules: '',
      },
    }
    mocks.listOrganizationAgents
      .mockResolvedValueOnce([{ id: 'agent-1', name: '可停用号', template_id: '', is_default: false }])
      .mockResolvedValueOnce([])

    render(<MyAgentsPanel />)

    fireEvent.click(await screen.findByRole('button', { name: '管理' }))
    expect(await screen.findByRole('button', { name: /停用 AI 分身/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /停用 AI 分身/ }))
    expect(await screen.findByTestId('confirm-dialog')).toBeTruthy()
    fireEvent.click(within(screen.getByTestId('confirm-dialog')).getByRole('button', { name: /confirm/ }))

    await waitFor(() => {
      expect(mocks.deleteAgent).toHaveBeenCalledWith('agent-1')
    })
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('已停用'),
      }),
    )
  })

  it('默认 AI 分身隐藏停用入口并提示不可停用', async () => {
    const systemDefault = {
      id: 'agent-default',
      name: '小Tin',
      template_id: '',
      is_default: true,
      settings: { provision_source: 'system_default' },
    }
    mocks.listOrganizationAgents.mockResolvedValue([systemDefault])
    mocks.spaceState.agentCache = {
      'agent-default': {
        ...systemDefault,
        custom_rules: '',
      },
    }

    render(<MyAgentsPanel />)

    expect((await screen.findAllByText('小Tin')).length).toBeGreaterThan(0)
    // 列表 / 详情均不得标「自建」；应出现「默认」角标
    expect(screen.queryByText('自建')).toBeNull()
    expect(screen.getAllByText('默认').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '管理' }))
    expect(screen.getByText('这是你的默认身份，无法停用。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /停用 AI 分身/ })).toBeNull()
  })

  it('已停用列表二次确认后彻底删除分身', async () => {
    mocks.listOrganizationAgents.mockResolvedValue([])
    mocks.listDeactivatedAgents.mockResolvedValue({
      items: [{
        id: 'agent-deactivated',
        name: '旧分身',
        type: 'bot',
        is_default: false,
        created_at: '2026-07-01T00:00:00Z',
        deactivated_at: '2026-07-29T00:00:00Z',
      }],
      total: 1,
    })

    render(<MyAgentsPanel />)

    fireEvent.click(screen.getByRole('button', { name: '已停用' }))
    expect(await screen.findByText('旧分身')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }))

    const dialog = await screen.findByRole('dialog', { name: '彻底删除 AI 分身？' })
    fireEvent.click(within(dialog).getByRole('button', { name: '彻底删除' }))

    await waitFor(() => {
      expect(mocks.permanentDeleteAgent).toHaveBeenCalledWith('agent-deactivated')
    })
    await waitFor(() => {
      expect(screen.queryByText('旧分身')).toBeNull()
    })
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: '「旧分身」已彻底删除' }),
    )
  })

  it('已停用默认分身不显示彻底删除入口', async () => {
    mocks.listOrganizationAgents.mockResolvedValue([])
    mocks.listDeactivatedAgents.mockResolvedValue({
      items: [{
        id: 'agent-default-deactivated',
        name: '默认分身',
        type: 'bot',
        is_default: true,
        created_at: '2026-07-01T00:00:00Z',
        deactivated_at: '2026-07-29T00:00:00Z',
      }],
      total: 1,
    })

    render(<MyAgentsPanel />)

    fireEvent.click(screen.getByRole('button', { name: '已停用' }))
    expect(await screen.findByText('默认分身')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '彻底删除' })).toBeNull()
  })

  it('彻底删除失败时保留分身与确认框并展示错误', async () => {
    mocks.listOrganizationAgents.mockResolvedValue([])
    mocks.listDeactivatedAgents.mockResolvedValue({
      items: [{
        id: 'agent-protected',
        name: '有历史记录的分身',
        type: 'bot',
        is_default: false,
        created_at: '2026-07-01T00:00:00Z',
        deactivated_at: '2026-07-29T00:00:00Z',
      }],
      total: 1,
    })
    mocks.permanentDeleteAgent.mockRejectedValue(new Error('该 Agent 仍有受保护的执行记录'))

    render(<MyAgentsPanel />)

    fireEvent.click(screen.getByRole('button', { name: '已停用' }))
    expect(await screen.findByText('有历史记录的分身')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }))
    const dialog = await screen.findByRole('dialog', { name: '彻底删除 AI 分身？' })
    fireEvent.click(within(dialog).getByRole('button', { name: '彻底删除' }))

    await waitFor(() => {
      expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
        title: '该 Agent 仍有受保护的执行记录',
        variant: 'destructive',
      }))
    })
    expect(screen.getByText('有历史记录的分身')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: '彻底删除 AI 分身？' })).toBeTruthy()
  })

  it('详情四个配置区以 tab 切换，默认落在人设与规则', async () => {
    mocks.listOrganizationAgents.mockResolvedValue([
      { id: 'agent-1', name: '代码搭子', template_id: '' },
    ])
    mocks.spaceState.agentCache = {
      'agent-1': { id: 'agent-1', name: '代码搭子', custom_rules: '' },
    }

    render(<MyAgentsPanel />)

    expect(await screen.findByLabelText('人设与规则')).toBeTruthy()
    expect(screen.queryByTestId('agent-skills-panel')).toBeNull()
    expect(screen.queryByTestId('agent-memory-governance')).toBeNull()
    expect(screen.queryByRole('button', { name: /停用 AI 分身/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '技能携带集' }))
    expect(screen.getByTestId('agent-skills-panel')).toBeTruthy()
    expect(screen.queryByLabelText('人设与规则')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '记忆' }))
    expect(screen.getByTestId('agent-memory-governance')).toBeTruthy()
    expect(screen.queryByTestId('agent-skills-panel')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '管理' }))
    expect(screen.getByRole('button', { name: /停用 AI 分身/ })).toBeTruthy()
    expect(screen.queryByTestId('agent-memory-governance')).toBeNull()
  })
})
