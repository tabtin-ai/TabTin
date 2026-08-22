import React from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSkillsPanel } from './AgentSkillsPanel'

const mocks = vi.hoisted(() => ({
  refetchLinks: vi.fn(),
  refetchPool: vi.fn(),
  linksQuery: {
    data: [] as unknown[],
    isLoading: false,
    isError: false,
    error: null as { status?: number } | null,
  },
  poolQuery: {
    data: [] as unknown[],
    isLoading: false,
    isError: false,
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))

vi.mock('@/hooks/queries/agentSkills', () => ({
  useAgentSkillsQuery: () => ({
    ...mocks.linksQuery,
    refetch: mocks.refetchLinks,
  }),
  useAttachAgentSkillMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useDetachAgentSkillMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useUpdateAgentSkillLinkMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
}))

vi.mock('@/hooks/queries/skills', () => ({
  useSkillsListQuery: () => ({
    ...mocks.poolQuery,
    refetch: mocks.refetchPool,
  }),
}))

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'user-1' } }),
}))

vi.mock('./hooks/useSpaceExecutionAgent', () => ({
  useSpaceExecutionAgent: () => ({ agentId: 'resolved-agent', isLoading: false }),
}))

vi.mock('@components/context-space/skills/useSkillLocalChanges', () => ({
  useSkillLocalChanges: () => ({}),
}))

vi.mock('@components/context-space/ContextDialogHeader', () => ({
  ContextDialogHeader: ({ title, description }: { title: string; description: string }) => (
    <header>
      <h2>{title}</h2>
      <p>{description}</p>
    </header>
  ),
}))

vi.mock('./AgentSkillConfigDialog', () => ({
  AgentSkillConfigDialog: () => null,
}))

vi.mock('@components/ui', () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string
    size?: string
  }) => <button type="button" {...props}>{children}</button>,
  ConfirmDialog: () => null,
  Dialog: ({
    open,
    children,
  }: {
    open: boolean
    children: React.ReactNode
  }) => open ? <>{children}</> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Skeleton: () => <div data-testid="skeleton" />,
  Switch: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input type="checkbox" {...props} />
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

describe('AgentSkillsPanel', () => {
  beforeEach(() => {
    mocks.refetchLinks.mockReset()
    mocks.refetchPool.mockReset()
    mocks.linksQuery.data = []
    mocks.linksQuery.isLoading = false
    mocks.linksQuery.isError = false
    mocks.linksQuery.error = null
    mocks.poolQuery.data = []
    mocks.poolQuery.isLoading = false
    mocks.poolQuery.isError = false
  })

  it('技能池加载失败时展示错误和重试，不伪装成全部已添加', () => {
    mocks.poolQuery.isError = true

    render(
      <AgentSkillsPanel
        spaceId="space-1"
        agentId="agent-1"
        canManage
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '添加技能' }))

    expect(screen.getByRole('alert').textContent).toContain(
      '技能库加载失败，暂时无法判断哪些技能可以添加。',
    )
    expect(screen.queryByText('技能库里的技能都已经教给它了。')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'skills.panel.retry' }))
    expect(mocks.refetchPool).toHaveBeenCalledTimes(1)
  })

  it('技能池成功返回空列表时展示真实空态', () => {
    render(
      <AgentSkillsPanel
        spaceId="space-1"
        agentId="agent-1"
        canManage
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '添加技能' }))

    expect(screen.getByText('技能库里还没有可添加的技能。')).toBeTruthy()
    expect(screen.queryByText('技能库里的技能都已经教给它了。')).toBeNull()
  })

  it('小Tin：本机发现的 Skill 无需携带关系也默认出现在技能携带集', () => {
    mocks.poolQuery.data = [{
      skill_key: 'device:local-helper',
      skill_id: 'local-helper',
      name: 'Local Helper',
      description: '本机发现的能力',
      source: 'device',
    }]

    render(
      <AgentSkillsPanel
        spaceId="space-1"
        agentId="agent-1"
        canManage
        isDefaultAgent
      />,
    )

    expect(within(screen.getByTestId('agent-skill-list')).getByText('Local Helper')).toBeTruthy()
    expect(screen.getByText('本机发现的能力')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '收回' })).toBeNull()
    const enabledSwitch = screen.getByRole('checkbox', { name: '本机发现的技能默认可用' }) as HTMLInputElement
    expect(enabledSwitch.checked).toBe(true)
    expect(enabledSwitch.disabled).toBe(true)
  })

  it('其他分身携带集展示已携带的平台/内置 App/本机，未分配的本机不出现', () => {
    mocks.poolQuery.data = [
      {
        skill_key: 'device:local-helper',
        skill_id: 'local-helper',
        name: 'Local Helper',
        description: '本机发现的能力',
        source: 'device',
      },
      {
        skill_key: 'device:unassigned-helper',
        skill_id: 'unassigned-helper',
        name: 'Unassigned Helper',
        description: '还没分给这个分身',
        source: 'device',
      },
    ]
    mocks.linksQuery.data = [
      {
        skill_canonical_key: 'platform:design-system',
        name: 'design-system',
        source: 'platform',
        enabled: true,
        config_json: {},
      },
      {
        skill_canonical_key: 'app:tabdata/table-operator',
        name: 'table-operator',
        source: 'app',
        enabled: true,
        config_json: { distribution: 'builtin' },
      },
      {
        skill_canonical_key: 'device:local-helper',
        name: 'Local Helper',
        source: 'device',
        enabled: true,
        config_json: {},
      },
      {
        skill_canonical_key: 'user:my-skill',
        name: 'my-skill',
        source: 'user',
        enabled: true,
        config_json: {},
      },
    ]

    render(
      <AgentSkillsPanel
        spaceId="space-1"
        agentId="agent-2"
        canManage
      />,
    )

    const list = within(screen.getByTestId('agent-skill-list'))
    expect(list.getByText('my-skill')).toBeTruthy()
    expect(list.getByText('Local Helper')).toBeTruthy()
    expect(list.getByText('design-system')).toBeTruthy()
    expect(list.getByText('table-operator')).toBeTruthy()
    expect(screen.queryByText('Unassigned Helper')).toBeNull()
  })

  it('定制分身模板写入的内置 App 技能不能从携带集消失', () => {
    mocks.linksQuery.data = [
      {
        skill_canonical_key: 'app:tabcode/tabcode-operator',
        name: 'tabcode-operator',
        source: 'app',
        enabled: true,
        config_json: { distribution: 'builtin' },
      },
      {
        skill_canonical_key: 'app:terminal/terminal-operator',
        name: 'terminal-operator',
        source: 'app',
        enabled: true,
        config_json: { distribution: 'builtin' },
      },
      {
        skill_canonical_key: 'app:tabtin-workflow-skills-pack/grill-before-build',
        name: 'grill-before-build',
        source: 'app',
        enabled: true,
        config_json: { distribution: 'marketplace' },
      },
    ]

    render(
      <AgentSkillsPanel
        spaceId="space-1"
        agentId="code-engineer"
        canManage
      />,
    )

    const list = within(screen.getByTestId('agent-skill-list'))
    expect(list.getByText('tabcode-operator')).toBeTruthy()
    expect(list.getByText('terminal-operator')).toBeTruthy()
    expect(list.getByText('grill-before-build')).toBeTruthy()
  })

  it('代码版预装的官方 Pack 与 TabCode 一样标内置起步包', () => {
    mocks.poolQuery.data = [
      {
        skill_key: 'app:tabcode/tabcode-operator',
        name: 'TabCode Operator',
        source: 'app',
        distribution: 'builtin',
      },
      {
        skill_key: 'app:tabtin-workflow-skills-pack/grill-before-build',
        name: '开干前拷问',
        source: 'app',
        distribution: 'marketplace',
        app_id: 'tabtin-workflow-skills-pack',
      },
      {
        skill_key: 'app:tabtin-office-skills-pack/meeting-notes-to-actions',
        name: '会议纪要转行动',
        source: 'app',
        distribution: 'marketplace',
        app_id: 'tabtin-office-skills-pack',
      },
    ]
    mocks.linksQuery.data = [
      {
        skill_canonical_key: 'app:tabcode/tabcode-operator',
        name: 'TabCode Operator',
        source: 'app',
        enabled: true,
        config_json: { distribution: 'builtin' },
      },
      {
        skill_canonical_key: 'app:tabtin-workflow-skills-pack/grill-before-build',
        name: '开干前拷问',
        source: 'app',
        enabled: true,
        config_json: { distribution: 'marketplace' },
      },
      {
        skill_canonical_key: 'app:tabtin-office-skills-pack/meeting-notes-to-actions',
        name: '会议纪要转行动',
        source: 'app',
        enabled: true,
        config_json: { distribution: 'marketplace' },
      },
    ]

    render(
      <AgentSkillsPanel
        spaceId="space-1"
        agentId="code-engineer"
        canManage
      />,
    )

    const list = within(screen.getByTestId('agent-skill-list'))
    expect(list.getAllByText('skills.sourceGroup5.builtin')).toHaveLength(2)
    expect(list.getByText('skills.sourceGroup5.public_market')).toBeTruthy()
  })

  it('携带集标题去掉 pack 前缀', () => {
    mocks.linksQuery.data = [
      {
        skill_canonical_key: 'app:tabtin-data-ai-pack/table-data-production',
        name: 'tabtin-data-ai-pack/table-data-production',
        source: 'app',
        enabled: true,
        config_json: { distribution: 'marketplace' },
      },
    ]

    render(
      <AgentSkillsPanel
        spaceId="space-1"
        agentId="data-analyst"
        canManage
      />,
    )

    expect(within(screen.getByTestId('agent-skill-list')).getByText('table-data-production')).toBeTruthy()
    expect(screen.queryByText('tabtin-data-ai-pack/table-data-production')).toBeNull()
  })

  it('可添加技能都已携带时才显示全部已添加', () => {
    mocks.poolQuery.data = [{
      skill_key: 'platform:design-system',
      name: 'design-system',
      description: '设计系统',
    }]
    mocks.linksQuery.data = [{
      skill_canonical_key: 'platform:design-system',
      name: 'design-system',
      source: 'platform',
      enabled: true,
      config_json: {},
    }]

    render(
      <AgentSkillsPanel
        spaceId="space-1"
        agentId="agent-1"
        canManage
        isDefaultAgent
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '添加技能' }))

    expect(screen.getByText('技能库里的技能都已经教给它了。')).toBeTruthy()
  })

  it('携带集加载失败时禁用添加技能入口', () => {
    mocks.linksQuery.isError = true
    mocks.linksQuery.error = { status: 500 }

    render(
      <AgentSkillsPanel
        spaceId="space-1"
        agentId="agent-1"
        canManage
      />,
    )

    expect(
      (screen.getByRole('button', { name: '添加技能' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.getByText('skills.panel.loadError')).toBeTruthy()
  })

  it('非 owner 返回 404 时展示权限提示并禁用添加', () => {
    mocks.linksQuery.isError = true
    mocks.linksQuery.error = { status: 404 }

    render(
      <AgentSkillsPanel
        spaceId="space-1"
        agentId="agent-1"
        canManage
      />,
    )

    expect(screen.getByText('只有这个 AI 分身的拥有者能查看和管理它的技能。')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: '添加技能' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('默认 Agent 锁定 platform/app：禁用开关并隐藏收回', () => {
    mocks.linksQuery.data = [
      {
        skill_canonical_key: 'platform:design-system',
        name: 'design-system',
        source: 'platform',
        enabled: true,
        locked: true,
        config_json: {},
      },
      {
        skill_canonical_key: 'user:my-skill',
        name: 'my-skill',
        source: 'user',
        enabled: true,
        locked: false,
        config_json: {},
      },
    ]

    render(
      <AgentSkillsPanel
        spaceId="space-1"
        agentId="agent-1"
        canManage
        isDefaultAgent
      />,
    )

    const lockedSwitch = screen.getByRole('checkbox', {
      name: '系统预置分身的默认技能不可关闭或收回',
    }) as HTMLInputElement
    expect(lockedSwitch.disabled).toBe(true)
    expect(lockedSwitch.checked).toBe(true)

    const detachButtons = screen.getAllByRole('button', { name: '收回' })
    expect(detachButtons).toHaveLength(1)
  })

  it('默认 Agent：marketplace 推荐 pack 可关闭（不因 app: 前缀误锁）', () => {
    mocks.linksQuery.data = [
      {
        skill_canonical_key: 'app:tabtin-writing-tools-pack/humanizer-zh',
        name: 'humanizer-zh',
        source: 'app',
        enabled: true,
        locked: false,
        config_json: { distribution: 'marketplace', app_id: 'tabtin-writing-tools-pack' },
      },
    ]

    render(
      <AgentSkillsPanel
        spaceId="space-1"
        agentId="agent-1"
        canManage
        isDefaultAgent
      />,
    )

    const skillSwitch = screen.getByRole('checkbox', {
      name: 'skills.configEnabled',
    }) as HTMLInputElement
    expect(skillSwitch.disabled).toBe(false)
    expect(skillSwitch.checked).toBe(true)
    expect(screen.getByRole('button', { name: '收回' })).toBeTruthy()
  })

  it('默认 Agent：无 locked 字段时按 canonical key 前缀回退锁定', () => {
    mocks.linksQuery.data = [
      {
        skill_canonical_key: 'platform:legacy-no-locked-flag',
        name: 'legacy-platform',
        source: 'user',
        enabled: true,
        config_json: {},
      },
    ]

    render(
      <AgentSkillsPanel
        spaceId="space-1"
        agentId="agent-1"
        canManage
        isDefaultAgent
      />,
    )

    expect(
      screen.getByRole('checkbox', {
        name: '系统预置分身的默认技能不可关闭或收回',
      }),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: '收回' })).toBeNull()
  })

  it('默认 Agent：无 locked 时 app+marketplace config 不回退锁定', () => {
    mocks.linksQuery.data = [
      {
        skill_canonical_key: 'app:tabtin-writing-tools-pack/humanizer-zh',
        name: 'humanizer-zh',
        source: 'app',
        enabled: true,
        config_json: { distribution: 'marketplace' },
      },
    ]

    render(
      <AgentSkillsPanel
        spaceId="space-1"
        agentId="agent-1"
        canManage
        isDefaultAgent
      />,
    )

    expect(
      screen.queryByRole('checkbox', {
        name: '系统预置分身的默认技能不可关闭或收回',
      }),
    ).toBeNull()
    expect(
      (screen.getByRole('checkbox', { name: 'skills.configEnabled' }) as HTMLInputElement).disabled,
    ).toBe(false)
  })

  it('选中携带行后，说明书展示完整描述而不是截断列表', () => {
    mocks.linksQuery.data = [
      {
        skill_canonical_key: 'app:tabcode/tabcode-operator',
        name: 'TabCode Operator',
        source: 'app',
        enabled: true,
        description: '代码项目操作——读写文件。用户提到"写代码"时使用。',
        config_json: {},
      },
      {
        skill_canonical_key: 'app:terminal/terminal-operator',
        name: 'Terminal Operator',
        source: 'app',
        enabled: true,
        description: '本机终端操作——跑命令。用户提到"终端"时使用。',
        config_json: {},
      },
    ]

    render(
      <AgentSkillsPanel
        spaceId="space-1"
        agentId="agent-1"
        canManage
      />,
    )

    expect(screen.getByText('代码项目操作——读写文件')).toBeTruthy()
    expect(screen.getByText('用户提到"写代码"时使用。')).toBeTruthy()
    expect(screen.queryByText('本机终端操作——跑命令')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Terminal Operator/ }))

    expect(screen.getByText('本机终端操作——跑命令')).toBeTruthy()
    expect(screen.getByText('用户提到"终端"时使用。')).toBeTruthy()
    expect(screen.queryByText('代码项目操作——读写文件')).toBeNull()
  })

  it('添加技能先预览再确认，不会在列表行上直接添加', () => {
    mocks.poolQuery.data = [
      {
        skill_key: 'user:weekly-report',
        name: 'Weekly Report',
        description: '周报整理——汇总进展。用户提到"周报"时使用。',
        source: 'user',
      },
      {
        skill_key: 'user:meeting-notes',
        name: 'Meeting Notes',
        description: '会议纪要——抽出待办。用户提到"纪要"时使用。',
        source: 'user',
      },
    ]

    render(
      <AgentSkillsPanel
        spaceId="space-1"
        agentId="agent-1"
        canManage
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '添加技能' }))

    expect(screen.getByText('先看说明，再教给这个 AI 分身。')).toBeTruthy()
    expect(screen.getByText('周报整理——汇总进展')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '添加' })).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Meeting Notes' }))

    expect(screen.getByText('会议纪要——抽出待办')).toBeTruthy()
    expect(screen.queryByText('周报整理——汇总进展')).toBeNull()
  })
})
