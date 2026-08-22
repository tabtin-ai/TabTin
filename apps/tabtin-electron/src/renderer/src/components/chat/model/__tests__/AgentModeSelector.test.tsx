/**
 * AgentModeSelector — 任务模式选择器行为验证。
 *
 *  三档审批策略：yolo 已从任务模式下拉移除（审批档由授权策略里的
 * 审批权限授权承接），旧 PR4-yolo gate 用例随之删除。
 *
 * 覆盖：
 *  1. yolo / study 不在下拉中出现
 *  2. 常规模式可点 + onModeChange
 *  3. 打开下拉自动 loadAgent(force=true) — PRD §5.4.3 单次握手
 *  4. cycle hotkey 不在本测试覆盖范围（在 ChatInput 测）
 *  5. Agent 选择器：20px 身份头像 + 双行副行 + 动作项前 hairline
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'

// ── hoisted mocks ─────────────────────────────────────────────────────
const { spaceState, selectionMocks, identityState, modelState } = vi.hoisted(() => ({
  spaceState: {
    selectedAgent: null as { id?: string; agent_config?: { security?: { allow_yolo_mode?: boolean } } } | null,
    selectedSpace: null as { id?: string; type?: string } | null,
    spaces: [] as Array<{
      id: string
      organization_id: string
      type?: 'workspace' | 'team_space'
      is_default?: boolean
      agent_id?: string | null
      execution_agent_id?: string | null
    }>,
    loadAgent: vi.fn().mockResolvedValue(null),
  },
  selectionMocks: {
    selectIdentity: vi.fn(),
    reloadAgents: vi.fn().mockResolvedValue(undefined),
  },
  identityState: {
    agents: [
      { id: 'agent-1', name: '小豆子' },
      { id: 'agent-2', name: '干活' },
    ] as Array<{
      id: string
      name: string
      display_name?: string
      goal?: string
      /** 人设与规则（配置页 custom_rules） */
      custom_rules?: string
      preferred_model_id?: string
      type?: string
      settings?: { icon?: string | null }
    }>,
    currentAgentId: 'agent-1',
  },
  modelState: {
    availableModels: [
      { id: 'model-k2', display_name: 'k2', name: 'kimi-k2' },
    ] as Array<{ id: string; display_name?: string; name?: string }>,
    loadedOrganizationId: 'org-session' as string | null,
    loadModels: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@stores/useSpaceStore', () => {
  const store = vi.fn((sel: (state: typeof spaceState) => unknown) => sel(spaceState))
  return { useSpaceStore: store }
})

vi.mock('@/stores/useChatModelStore', () => ({
  useChatModelStore: (sel: (state: typeof modelState) => unknown) => sel(modelState),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opt?: { defaultValue?: string }) => opt?.defaultValue ?? k,
  }),
}))

vi.mock('../useAgentIdentitySelection', () => ({
  useAgentIdentitySelection: (
    _sessionId: string | null,
    enabledOrOptions: boolean | { showIdentity?: boolean; canChangeAgent?: boolean } = false,
  ) => {
    const opts = typeof enabledOrOptions === 'boolean'
      ? { showIdentity: enabledOrOptions, canChangeAgent: enabledOrOptions }
      : {
          showIdentity: enabledOrOptions.showIdentity ?? false,
          canChangeAgent: enabledOrOptions.canChangeAgent ?? false,
        }
    const agents = opts.canChangeAgent ? identityState.agents : []
    const currentAgent = (opts.showIdentity || opts.canChangeAgent)
      ? identityState.agents.find(agent => agent.id === identityState.currentAgentId)
        ?? identityState.agents[0]
        ?? null
      : null
    return {
      agents,
      currentAgent,
      currentAgentId: identityState.currentAgentId,
      identityPlaceholder: null,
      organizationId: 'org-session',
      isLoading: false,
      isUpdating: false,
      canChangeAgent: opts.canChangeAgent,
      showIdentity: opts.showIdentity || opts.canChangeAgent,
      selectIdentity: selectionMocks.selectIdentity,
      reloadAgents: selectionMocks.reloadAgents,
    }
  },
}))

vi.mock('@components/sidebar/NewAgentButton', () => ({
  NewAgentDialog: ({
    open,
    organizationId,
    onOpenChange,
  }: {
    open: boolean
    organizationId?: string
    onOpenChange?: (open: boolean) => void
  }) => (
    open ? (
      <div data-testid="new-agent-dialog" data-organization-id={organizationId}>
        <button type="button" onClick={() => onOpenChange?.(false)}>关闭新分身</button>
      </div>
    ) : null
  ),
}))

// hotkey utils 只取字面量，无副作用即可
vi.mock('../../../tabcode/utils/hotkeys', () => ({
  hotkeyLabel: () => 'Ctrl+Shift+.',
  HOTKEYS: { cycleAgentMode: 'mod+shift+.' },
}))

// 默认情况下 cn 把 falsy 过滤后空格拼起来
vi.mock('@utils/cn', () => ({
  cn: (...xs: unknown[]) => xs.filter(Boolean).join(' '),
}))

import { AgentModeSelector } from '../AgentModeSelector'

function openAgentPicker() {
  render(
    <AgentModeSelector
      currentMode="agent"
      onModeChange={vi.fn()}
      enableAgentPicker
    />,
  )
  const triggerName = identityState.agents.find(a => a.id === identityState.currentAgentId)?.name
    ?? identityState.agents[0]?.name
    ?? '小豆子'
  fireEvent.click(screen.getByText(triggerName))
}

beforeEach(() => {
  spaceState.selectedAgent = {
    id: 'agent-1',
    agent_config: { security: { allow_yolo_mode: false } },
  }
  spaceState.selectedSpace = { id: 'space-1', type: 'workspace' }
  spaceState.spaces = []
  spaceState.loadAgent.mockClear()
  selectionMocks.selectIdentity.mockReset()
  selectionMocks.reloadAgents.mockClear()
  identityState.currentAgentId = 'agent-1'
  identityState.agents = [
    { id: 'agent-1', name: '小豆子' },
    { id: 'agent-2', name: '干活' },
  ]
  modelState.availableModels = [
    { id: 'model-k2', display_name: 'k2', name: 'kimi-k2' },
  ]
  modelState.loadedOrganizationId = 'org-session'
  modelState.loadModels.mockClear()
})

describe('AgentModeSelector', () => {
  it('Agent、Mode 与相邻控件由调用方的同一父容器排布', () => {
    render(
      <div data-testid="toolbar-controls" className="flex items-center gap-1">
        <AgentModeSelector
          currentMode="agent"
          onModeChange={vi.fn()}
          showAgentIdentity
        />
        <span data-testid="approval-control" />
      </div>,
    )

    const controls = screen.getByTestId('toolbar-controls')
    expect(controls.className).toContain('gap-1')
    expect(screen.getByTestId('agent-identity-trigger').closest('span')?.parentElement).toBe(controls)
    expect(screen.getByTestId('agent-mode-trigger').closest('span')?.parentElement).toBe(controls)
    expect(screen.getByTestId('approval-control').parentElement).toBe(controls)
  })

  it('执行模式触发器保留模式主题色', () => {
    render(<AgentModeSelector currentMode="agent" onModeChange={vi.fn()} />)

    const trigger = screen.getByRole('button', { name: 'agentMode.agent.name' })
    expect(trigger.querySelector('svg')?.getAttribute('class')).toContain('text-success')
  })

  it('yolo 已从任务模式下拉移除（ 审批档承接）', () => {
    spaceState.selectedAgent = {
      id: 'agent-1',
      agent_config: { security: { allow_yolo_mode: true } },
    }
    render(<AgentModeSelector currentMode="agent" onModeChange={vi.fn()} />)
    fireEvent.click(screen.getByText('agentMode.agent.name'))
    expect(document.querySelector('[data-mode="yolo"]')).toBeNull()
  })

  it('study 模式从选择器隐藏（UI 不暴露入口）', () => {
    render(<AgentModeSelector currentMode="agent" onModeChange={vi.fn()} />)
    fireEvent.click(screen.getByText('agentMode.agent.name'))
    expect(document.querySelector('[data-mode="study"]')).toBeNull()
  })

  it('常规模式可点 + onModeChange', () => {
    const onModeChange = vi.fn()
    render(<AgentModeSelector currentMode="agent" onModeChange={onModeChange} />)
    fireEvent.click(screen.getByText('agentMode.agent.name'))
    const planBtn = document.querySelector('[data-mode="plan"]') as HTMLElement
    expect(planBtn).not.toBeNull()
    fireEvent.click(planBtn)
    expect(onModeChange).toHaveBeenCalledWith('plan')
  })

  it('打开下拉时自动 loadAgent(force=true) — PRD §5.4.3 单次握手', () => {
    render(<AgentModeSelector currentMode="agent" onModeChange={vi.fn()} />)
    fireEvent.click(screen.getByText('agentMode.agent.name'))
    expect(spaceState.loadAgent).toHaveBeenCalledWith('agent-1', { force: true })
    expect(selectionMocks.reloadAgents).not.toHaveBeenCalled()
  })

  it('开启 Agent 选择器时打开下拉会 reloadAgents', () => {
    render(
      <AgentModeSelector
        currentMode="agent"
        onModeChange={vi.fn()}
        enableAgentPicker
      />,
    )
    fireEvent.click(screen.getByText('小豆子'))
    expect(selectionMocks.reloadAgents).toHaveBeenCalled()
    expect(spaceState.loadAgent).toHaveBeenCalledWith('agent-1', { force: true })
  })

  it('Agent 与模式菜单拆开，不再提供 Agent 设置入口', async () => {
    render(
      <AgentModeSelector
        currentMode="agent"
        onModeChange={vi.fn()}
        sessionId="session-1"
        enableAgentPicker
      />,
    )

    fireEvent.click(screen.getByTestId('agent-identity-trigger'))
    fireEvent.click(screen.getByRole('radio', { name: '干活' }))
    expect(selectionMocks.selectIdentity).toHaveBeenCalledWith('agent-2')
    expect(screen.getByTestId('agent-identity-trigger').getAttribute('aria-expanded')).toBe('false')
    // AnimatePresence 退出动画期间节点可能短暂残留，等收口后再断言
    await waitFor(() => {
      expect(screen.queryByRole('radiogroup', { name: '选择 Agent' })).toBeNull()
    })
    expect(document.querySelector('[data-mode="plan"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Agent 设置' })).toBeNull()

    fireEvent.click(screen.getByTestId('agent-mode-trigger'))
    expect(document.querySelector('[data-mode="plan"]')).not.toBeNull()
  })

  it('身份卡片可只选择 Agent，不混入任务模式', () => {
    render(
      <AgentModeSelector
        currentMode="agent"
        onModeChange={vi.fn()}
        enableAgentPicker
        showModes={false}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '小豆子' }))
    expect(screen.getByRole('radio', { name: '干活' })).toBeTruthy()
    expect(document.querySelector('[data-mode="plan"]')).toBeNull()
  })

  it('开新分身仍在组合菜单中', () => {
    render(
      <AgentModeSelector
        currentMode="agent"
        onModeChange={vi.fn()}
        enableAgentPicker
      />,
    )
    fireEvent.click(screen.getByText('小豆子'))
    fireEvent.click(screen.getByRole('button', { name: '开新分身' }))
    expect(
      screen.getByTestId('new-agent-dialog').getAttribute('data-organization-id'),
    ).toBe('org-session')
  })

  it('关闭开新分身弹窗后 reloadAgents', () => {
    render(
      <AgentModeSelector
        currentMode="agent"
        onModeChange={vi.fn()}
        enableAgentPicker
      />,
    )
    fireEvent.click(screen.getByText('小豆子'))
    fireEvent.click(screen.getByRole('button', { name: '开新分身' }))
    selectionMocks.reloadAgents.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '关闭新分身' }))
    expect(selectionMocks.reloadAgents).toHaveBeenCalledTimes(1)
  })

  describe('Agent 选择器身份行', () => {
    it('composer 触发器与下拉列表使用同一 20px 身份头像', () => {
      render(
        <AgentModeSelector
          currentMode="agent"
          onModeChange={vi.fn()}
          enableAgentPicker
        />,
      )
      const trigger = screen.getByRole('button', { name: /小豆子/ })
      const triggerAvatar = within(trigger).getByRole('img', { name: '小豆子' })
      fireEvent.click(trigger)
      const rowAvatar = within(
        screen.getByRole('radio', { name: '小豆子' }),
      ).getByRole('img', { name: '小豆子' })

      expect(triggerAvatar.textContent).toBe(rowAvatar.textContent)
      expect(triggerAvatar.className).toBe(rowAvatar.className)
      expect(triggerAvatar.className).toContain('h-5')
      expect(triggerAvatar.className).toContain('rounded-full')
    })

    it('新任务条同款 props：触发器与下拉选中项共用身份头像，切换 agent 后同步', () => {
      // 对齐 ChatInputTaskSetupBar：enableAgentPicker + 无模式标签；不得再强制 Bot 图标。
      identityState.agents = [
        { id: 'agent-1', name: 'agent-1' },
        { id: 'agent-222', name: 'agent-222' },
        { id: 'agent-333', name: 'agent-333' },
      ]
      identityState.currentAgentId = 'agent-1'

      const props = {
        currentMode: 'agent' as const,
        onModeChange: vi.fn(),
        enableAgentPicker: true,
        showModeLabel: false,
        showModes: false,
      }

      const assertTriggerMatchesSelectedRow = (_agentId: string, name: string) => {
        const trigger = screen.getByRole('button', { name })
        const triggerAvatar = within(trigger).getByRole('img', { name })
        expect(triggerAvatar.tagName).toBe('IMG')
        expect(triggerAvatar.className).toContain('h-5')
        expect(triggerAvatar.className).toContain('w-5')
        expect(trigger.querySelector('.lucide-bot')).toBeNull()

        fireEvent.click(trigger)
        const rowAvatar = within(screen.getByRole('radio', { name })).getByRole('img', { name })
        expect(triggerAvatar.getAttribute('src')).toBe(rowAvatar.getAttribute('src'))
        expect(triggerAvatar.className).toBe(rowAvatar.className)
        fireEvent.click(trigger)
      }

      const { rerender } = render(<AgentModeSelector {...props} />)
      assertTriggerMatchesSelectedRow('agent-1', 'agent-1')

      identityState.currentAgentId = 'agent-222'
      rerender(<AgentModeSelector {...props} />)
      assertTriggerMatchesSelectedRow('agent-222', 'agent-222')

      identityState.currentAgentId = 'agent-333'
      rerender(<AgentModeSelector {...props} />)
      assertTriggerMatchesSelectedRow('agent-333', 'agent-333')
    })

    it('真实 Agent 行用 20px 身份头像图（默认 logo / 自定义，）', () => {
      openAgentPicker()
      const radio = screen.getByRole('radio', { name: '小豆子' })
      const avatar = within(radio).getByRole('img', { name: '小豆子' })
      expect(avatar.tagName).toBe('IMG')
      expect(avatar.className).toContain('h-5')
      expect(avatar.className).toContain('w-5')
      expect(avatar.className).toContain('rounded-full')
      expect(avatar.getAttribute('src')).toBeTruthy()
      expect(avatar.getAttribute('title')).toBe('小豆子')
      expect(within(radio).queryByTestId('template-icon')).toBeNull()
      expect(radio.querySelector('.text-accent')).toBeNull()
    })

    it('有人设时副行取首行前 40 字，并附真实模型显示名', () => {
      identityState.agents = [
        {
          id: 'agent-1',
          name: '小豆子',
          custom_rules: '专注表格分析与清洗\n第二行不应出现',
          preferred_model_id: 'model-k2',
        },
      ]
      openAgentPicker()
      const radio = screen.getByRole('radio', { name: '小豆子' })
      expect(within(radio).getByText('专注表格分析与清洗')).toBeTruthy()
      expect(within(radio).getByTestId('agent-picker-model-badge').textContent).toBe('k2')
    })

    it('人设超长时副行截到 40 字', () => {
      const long = '一二三四五六七八九十'.repeat(5) // 50 字
      identityState.agents = [
        {
          id: 'agent-1',
          name: '小豆子',
          custom_rules: long,
          preferred_model_id: 'model-k2',
        },
      ]
      openAgentPicker()
      const radio = screen.getByRole('radio', { name: '小豆子' })
      const preview = Array.from(long).slice(0, 40).join('')
      expect(within(radio).getByText(preview)).toBeTruthy()
      expect(within(radio).getByTestId('agent-picker-model-badge').textContent).toBe('k2')
    })

    it('无人设时弱化显示「未设定人设」，有模型才附模型', () => {
      identityState.agents = [
        { id: 'agent-1', name: '小豆子', preferred_model_id: 'model-k2' },
        { id: 'agent-2', name: '干活' },
      ]
      openAgentPicker()
      const withModel = within(screen.getByRole('radio', { name: '小豆子' }))
      expect(withModel.getByText('未设定人设')).toBeTruthy()
      expect(withModel.getByTestId('agent-picker-model-badge').textContent).toBe('k2')
      const withoutModel = within(screen.getByRole('radio', { name: '干活' }))
      expect(withoutModel.getByText('未设定人设')).toBeTruthy()
      expect(withoutModel.queryByTestId('agent-picker-model-badge')).toBeNull()
    })

    it('默认 Space 归属来自绑定关系与 Space 类型，不按名字猜测', () => {
      identityState.agents = [
        {
          id: 'default-space',
          name: '小Tin',
          preferred_model_id: 'model-k2',
        },
        {
          id: 'team-default',
          name: '团队执行身份',
        },
      ]
      spaceState.spaces = [
        {
          id: 'personal-home',
          organization_id: 'org-session',
          type: 'workspace',
          is_default: true,
          agent_id: 'default-space',
        },
        {
          id: 'team-home',
          organization_id: 'org-session',
          type: 'team_space',
          is_default: true,
          execution_agent_id: 'team-default',
        },
      ]
      identityState.currentAgentId = 'default-space'
      openAgentPicker()
      const personalDefault = within(screen.getByRole('radio', { name: '小Tin' }))
      expect(personalDefault.getByText('个人 Space')).toBeTruthy()
      expect(personalDefault.getByTestId('agent-picker-model-badge').textContent).toBe('k2')
      expect(
        within(screen.getByRole('radio', { name: '团队执行身份' })).getByText('团队'),
      ).toBeTruthy()
      expect(
        within(screen.getByRole('radio', { name: '团队执行身份' })).queryByText(/未设定人设/),
      ).toBeNull()
    })

    it('自建 Agent 即使同名“默认工作空间”也不误标团队归属', () => {
      identityState.agents = [{ id: 'custom-same-name', name: '默认工作空间' }]
      identityState.currentAgentId = 'custom-same-name'
      openAgentPicker()
      const row = within(screen.getByRole('radio', { name: '默认工作空间' }))
      expect(row.getByText('未设定人设')).toBeTruthy()
      expect(row.queryByText('团队')).toBeNull()
    })

    it('动作项「开新分身」前有 hairline 分隔；模式项不在 Agent 菜单内', () => {
      openAgentPicker()
      const newAgentBtn = screen.getByRole('button', { name: '开新分身' })
      const hairline = newAgentBtn.previousElementSibling
      expect(hairline).not.toBeNull()
      expect(hairline?.getAttribute('data-testid')).toBe('agent-picker-actions-hairline')
      expect(document.querySelector('[data-mode="plan"]')).toBeNull()
      expect(screen.queryByText('模式')).toBeNull()

      fireEvent.click(screen.getByTestId('agent-mode-trigger'))
      expect(document.querySelector('[data-mode="plan"]')).not.toBeNull()
    })

    it('偏好模型未命中目录时不展示原始 ID', () => {
      identityState.agents = [
        {
          id: 'agent-1',
          name: '小豆子',
          custom_rules: '调研助手',
          preferred_model_id: 'uuid-model-not-loaded',
        },
      ]
      openAgentPicker()
      const radio = screen.getByRole('radio', { name: '小豆子' })
      expect(within(radio).queryByText('uuid-model-not-loaded')).toBeNull()
      expect(within(radio).queryByTestId('agent-picker-model-badge')).toBeNull()
    })

    it('模型目录不属于当前组织时不展示旧模型，并触发当前组织加载', () => {
      identityState.agents = [{
        id: 'agent-1',
        name: '小豆子',
        custom_rules: '调研助手',
        preferred_model_id: 'model-k2',
      }]
      modelState.loadedOrganizationId = 'org-old'
      openAgentPicker()
      const radio = within(screen.getByRole('radio', { name: '小豆子' }))
      expect(radio.queryByTestId('agent-picker-model-badge')).toBeNull()
      expect(modelState.loadModels).toHaveBeenCalledWith('org-session')
    })
  })

  describe('Agent + Mode 同时可见', () => {
    it('草稿态同时可感知 Agent 头像/名称与 Mode icon，且各自打开独立菜单', () => {
      render(
        <AgentModeSelector
          currentMode="plan"
          onModeChange={vi.fn()}
          enableAgentPicker
          showAgentIdentity
        />,
      )
      const agentTrigger = screen.getByTestId('agent-identity-trigger')
      const modeTrigger = screen.getByTestId('agent-mode-trigger')
      expect(within(agentTrigger).getByRole('img', { name: '小豆子' })).toBeTruthy()
      expect(within(agentTrigger).getByTestId('agent-identity-name').textContent).toBe('小豆子')
      expect(
        within(modeTrigger).getByTestId('agent-mode-icon').getAttribute('data-mode-icon'),
      ).toBe('plan')
      expect(agentTrigger.getAttribute('aria-expanded')).toBe('false')
      expect(agentTrigger.getAttribute('aria-haspopup')).toBe('menu')
      expect(modeTrigger.getAttribute('aria-haspopup')).toBe('menu')

      fireEvent.click(agentTrigger)
      expect(agentTrigger.getAttribute('aria-expanded')).toBe('true')
      expect(screen.getByRole('radiogroup', { name: '选择 Agent' })).toBeTruthy()
      expect(document.querySelector('[data-mode="plan"]')).toBeNull()

      fireEvent.click(modeTrigger)
      expect(modeTrigger.getAttribute('aria-expanded')).toBe('true')
      expect(screen.queryByRole('radiogroup', { name: '选择 Agent' })).toBeNull()
      expect(document.querySelector('[data-mode="plan"]')).not.toBeNull()
    })

    it('团队 Space 等锁死态：同时可见 Agent + Mode，只读身份 aria 含不可更换，Mode 仍可改', () => {
      const onModeChange = vi.fn()
      render(
        <AgentModeSelector
          currentMode="agent"
          onModeChange={onModeChange}
          sessionId="session-1"
          canChangeAgent={false}
          showAgentIdentity
        />,
      )
      const agentTrigger = screen.getByTestId('agent-identity-trigger')
      const modeTrigger = screen.getByTestId('agent-mode-trigger')
      expect(within(agentTrigger).getByRole('img', { name: '小豆子' })).toBeTruthy()
      expect(within(agentTrigger).getByTestId('agent-identity-name').textContent).toBe('小豆子')
      expect(
        within(modeTrigger).getByTestId('agent-mode-icon').getAttribute('data-mode-icon'),
      ).toBe('agent')
      expect(agentTrigger.getAttribute('aria-label')).toMatch(/不可更换/)
      expect(agentTrigger.getAttribute('aria-haspopup')).toBeNull()

      fireEvent.click(agentTrigger)
      expect(screen.queryByRole('radiogroup', { name: '选择 Agent' })).toBeNull()
      fireEvent.click(modeTrigger)
      const planBtn = document.querySelector('[data-mode="plan"]') as HTMLElement
      fireEvent.click(planBtn)
      expect(onModeChange).toHaveBeenCalledWith('plan')
    })

    it('#7086 正式会话 canChangeAgent=true：可打开 Agent 选择器，且不依赖 enableAgentPicker', () => {
      render(
        <AgentModeSelector
          currentMode="agent"
          onModeChange={vi.fn()}
          sessionId="session-1"
          enableAgentPicker={false}
          canChangeAgent
          showAgentIdentity
        />,
      )
      const trigger = screen.getByTestId('agent-identity-trigger')
      expect(trigger.getAttribute('aria-label')).not.toMatch(/不可更换/)
      expect(within(trigger).getByRole('img', { name: '小豆子' })).toBeTruthy()
      expect(within(trigger).getByTestId('agent-identity-name').textContent).toBe('小豆子')

      fireEvent.click(trigger)
      expect(screen.getByRole('radiogroup', { name: '选择 Agent' })).toBeTruthy()
    })

    it('#7481 disabled=false 时可打开选择器（生成中由 Toolbar 不再传 isStreaming 锁）', () => {
      render(
        <AgentModeSelector
          currentMode="agent"
          onModeChange={vi.fn()}
          sessionId="session-1"
          canChangeAgent
          showAgentIdentity
          disabled={false}
        />,
      )
      const trigger = screen.getByTestId('agent-identity-trigger')
      expect((trigger as HTMLButtonElement).disabled).toBe(false)
      fireEvent.click(trigger)
      expect(screen.getByRole('radiogroup', { name: '选择 Agent' })).toBeTruthy()
    })

    it('compact 小窗只显示 Agent avatar + Mode icon，名称保留在 accessible name', () => {
      render(
        <AgentModeSelector
          currentMode="ask"
          onModeChange={vi.fn()}
          canChangeAgent={false}
          showAgentIdentity
          compact
        />,
      )
      const agentTrigger = screen.getByTestId('agent-identity-trigger')
      const modeTrigger = screen.getByTestId('agent-mode-trigger')
      expect(within(agentTrigger).getByRole('img', { name: '小豆子' })).toBeTruthy()
      expect(within(agentTrigger).queryByTestId('agent-identity-name')).toBeNull()
      expect(
        within(modeTrigger).getByTestId('agent-mode-icon').getAttribute('data-mode-icon'),
      ).toBe('ask')
      expect(within(modeTrigger).queryByTestId('agent-mode-name')).toBeNull()
      expect(agentTrigger.getAttribute('aria-label')).toMatch(/小豆子/)
      expect(agentTrigger.getAttribute('aria-label')).toMatch(/不可更换/)
      expect(modeTrigger.getAttribute('aria-label')).toMatch(/ask/)
      expect(modeTrigger.getAttribute('aria-haspopup')).toBe('menu')
    })

    it('支持先折叠模式、最后折叠 Agent 的分级状态', () => {
      const { rerender } = render(
        <AgentModeSelector
          currentMode="ask"
          onModeChange={vi.fn()}
          canChangeAgent={false}
          showAgentIdentity
          compactMode
        />,
      )

      expect(screen.getByTestId('agent-identity-name')).toBeTruthy()
      expect(screen.queryByTestId('agent-mode-name')).toBeNull()

      rerender(
        <AgentModeSelector
          currentMode="ask"
          onModeChange={vi.fn()}
          canChangeAgent={false}
          showAgentIdentity
          compactIdentity
          compactMode
        />,
      )

      expect(screen.queryByTestId('agent-identity-name')).toBeNull()
      expect(screen.queryByTestId('agent-mode-name')).toBeNull()
    })
  })
})
