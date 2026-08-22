import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AgentWorkbenchDetail } from './AgentWorkbenchDetail'

vi.mock('@components/space-settings/AgentSkillsPanel', () => ({
  AgentSkillsPanel: () => <div data-testid="agent-skills-panel" />,
}))

vi.mock('@components/settings/panels/AgentMemoryGovernancePanel', () => ({
  AgentMemoryGovernancePanel: ({ agentName }: { agentName?: string }) => (
    <div data-testid="agent-memory-panel" data-agent-name={agentName} />
  ),
}))

vi.mock('./AgentRecentActivitiesPanel', () => ({
  AgentRecentActivitiesPanel: () => <div data-testid="agent-recent-tasks" />,
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: Object.assign(
    (selector: (state: { agentCache: Record<string, { custom_rules: string }>; loadAgent: () => Promise<boolean> }) => unknown) => selector({
      agentCache: {
        'agent-1': { custom_rules: '负责写代码' },
      },
      loadAgent: vi.fn(async () => true),
    }),
    {
      getState: () => ({
        agentCache: {
          'agent-1': { custom_rules: '负责写代码' },
        },
        error: null,
      }),
    },
  ),
}))

function renderDetail(overrides?: Partial<ComponentProps<typeof AgentWorkbenchDetail>>) {
  return render(
    <AgentWorkbenchDetail
      organizationId="org-1"
      agent={{
        id: 'agent-1',
        name: '豆包',
        is_default: false,
      }}
      skillContextSpaceId="space-1"
      updateAgent={vi.fn(async () => true)}
      deleteAgent={vi.fn(async () => true)}
      onUpdated={vi.fn()}
      onDeactivated={vi.fn()}
      rulesDraft={null}
      onRulesDraftChange={vi.fn()}
      {...overrides}
    />,
  )
}

describe('AgentWorkbenchDetail', () => {
  it('渲染工作台上下结构：横排入口卡 + 记忆/任务分栏', () => {
    renderDetail()

    const root = screen.getByTestId('agent-workbench-detail')
    expect(root.getAttribute('data-panel')).toBe('overview')
    expect(root.className).toContain('grid')
    expect(root.className).toContain('gap-4')
    expect(root.className).toContain('md:grid-cols-12')
    expect(screen.getByText('豆包')).toBeTruthy()
    expect(screen.getByText('myAgents.rulesTitle')).toBeTruthy()
    expect(screen.getByText('myAgents.skillsTitle')).toBeTruthy()
    expect(screen.getByText('负责写代码')).toBeTruthy()
    expect(screen.getByTestId('agent-memory-panel')).toBeTruthy()
    expect(screen.getByTestId('agent-recent-tasks')).toBeTruthy()
    expect(screen.queryByLabelText('myAgents.rulesTitle')).toBeNull()
    expect(screen.queryByTestId('agent-skills-panel')).toBeNull()
  })

  it('点击人设入口进入整页编辑，返回后回到总览', () => {
    renderDetail()

    fireEvent.click(screen.getByRole('button', { name: /myAgents\.rulesTitle/i }))

    expect(screen.getByTestId('agent-workbench-detail').getAttribute('data-panel')).toBe('rules')
    expect(screen.getByLabelText('myAgents.rulesTitle')).toBeTruthy()
    expect(screen.queryByTestId('agent-memory-panel')).toBeNull()
    expect(screen.queryByText('豆包')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /myAgents\.workbench\.closePanel/i }))

    expect(screen.getByTestId('agent-workbench-detail').getAttribute('data-panel')).toBe('overview')
    expect(screen.getByTestId('agent-memory-panel')).toBeTruthy()
    expect(screen.getByText('豆包')).toBeTruthy()
  })

  it('点击技能入口进入整页面板，关闭后回到总览', () => {
    renderDetail()

    fireEvent.click(screen.getByRole('button', { name: /myAgents\.skillsTitle/i }))

    expect(screen.getByTestId('agent-workbench-detail').getAttribute('data-panel')).toBe('skills')
    expect(screen.getByTestId('agent-skills-panel')).toBeTruthy()
    expect(screen.queryByTestId('agent-memory-panel')).toBeNull()
    expect(screen.queryByLabelText('myAgents.rulesTitle')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /myAgents\.workbench\.closePanel/i }))

    expect(screen.getByTestId('agent-workbench-detail').getAttribute('data-panel')).toBe('overview')
    expect(screen.getByTestId('agent-memory-panel')).toBeTruthy()
    expect(screen.queryByTestId('agent-skills-panel')).toBeNull()
  })

  it('改名成功后在 props 仍为旧名时只读态与记忆区立即显示新名', async () => {
    let resolveUpdate: ((ok: boolean) => void) | undefined
    const updateAgent = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveUpdate = resolve
    }))
    const onUpdated = vi.fn()

    renderDetail({
      agent: {
        id: 'agent-1',
        name: '豆包',
        is_default: true,
      },
      updateAgent,
      onUpdated,
    })

    expect(screen.getByTestId('agent-memory-panel').getAttribute('data-agent-name')).toBe('豆包')

    fireEvent.click(screen.getByRole('button', { name: /myAgents\.renameAction/i }))
    fireEvent.change(screen.getByLabelText(/myAgents\.nameInputLabel/i), {
      target: { value: '新名字' },
    })
    fireEvent.click(screen.getByRole('button', { name: /myAgents\.confirmRename/i }))

    resolveUpdate?.(true)

    await waitFor(() => {
      expect(screen.getByText('新名字')).toBeTruthy()
      expect(screen.queryByText('豆包')).toBeNull()
      expect(screen.getByTestId('agent-memory-panel').getAttribute('data-agent-name')).toBe('新名字')
      expect(onUpdated).toHaveBeenCalledTimes(1)
    })
  })

  it('编辑头像展示旧版与功能简笔预设，并提交独立 avatar_key', async () => {
    const updateAgent = vi.fn(async () => true)
    const onUpdated = vi.fn()

    renderDetail({
      agent: {
        id: 'agent-1',
        name: '豆包',
        is_default: false,
        settings: {
          avatar_key: 'general-assistant',
          avatar_url: 'https://cdn.example.com/legacy-upload.png',
        },
      },
      updateAgent,
      onUpdated,
    })

    fireEvent.click(screen.getByRole('button', { name: /myAgents\.editAvatarAction/i }))

    expect(screen.getAllByRole('radio')).toHaveLength(14)
    expect(screen.queryByRole('button', { name: /上传头像/ })).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: /function-web-researcher/ }))
    fireEvent.click(screen.getByRole('button', { name: /myAgents\.avatarSaveAction/i }))

    await waitFor(() => {
      expect(updateAgent).toHaveBeenCalledWith('agent-1', {
        avatar_key: 'function-web-researcher',
      })
      expect(onUpdated).toHaveBeenCalledTimes(1)
    })
  })

  it('只打开或取消头像编辑不会覆盖已有头像设置', () => {
    const updateAgent = vi.fn(async () => true)

    renderDetail({
      agent: {
        id: 'agent-1',
        name: '豆包',
        is_default: true,
        settings: {
          avatar_key: 'general-assistant',
          avatar_url: 'https://cdn.example.com/custom.png',
        },
      },
      updateAgent,
    })

    fireEvent.click(screen.getByRole('button', { name: /myAgents\.editAvatarAction/i }))

    expect(
      (screen.getByRole('radio', {
        name: /agentAvatarPresets\.general-assistant$/,
      }) as HTMLInputElement).checked,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /common:cancel/i }))

    expect(updateAgent).not.toHaveBeenCalled()
  })
})
