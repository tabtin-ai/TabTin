/**
 *  回归：自动化「描述」字段可编辑。
 *
 *  曾把描述输入整段删除，导致详情页能看到 description 却无法修改。
 * 方案 A 恢复「可选」描述：
 *   1. 编辑态打开表单回填 editTracker.description
 *   2. 编辑态提交 payload 带上(可被改写的) description
 *   3. 创建态提交 payload 带上 description
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TrackerTask } from '@/services/trackerApi'
import { DUPLICATE_NAME_ERROR_TITLE } from '@/lib/duplicateNameError'

const {
  createTask,
  updateTask,
  toastInfo,
  toastError,
  toastSuccess,
  requestAgentForTracker,
  spaceStoreState,
} = vi.hoisted(() => ({
  createTask: vi.fn(),
  updateTask: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  requestAgentForTracker: vi.fn(),
  spaceStoreState: {
    spaces: [{
      id: 'space-ipdt4b',
      organization_id: 'wt-1',
      execution_agent_id: 'agent-ipdt4b',
      name: 'Space-ipdt4b',
      type: 'workspace',
      is_archived: false,
    }],
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key.split('.').pop() ?? key,
  }),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (sel: (s: unknown) => unknown) => sel(spaceStoreState),
}))

vi.mock('@/stores/useTrackerStore', () => ({
  useTrackerStore: (sel: (s: unknown) => unknown) => sel({ createTask, updateTask }),
}))

vi.mock('../context-space/tabtracker/requestAgentForTracker', () => ({
  requestAgentForTracker,
  buildTrackerCreateViaAgentPrompt: (userRequest: string) =>
    `PREFIX\n\n我的需求：\n${userRequest.trim()}`,
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: { info: toastInfo, error: toastError, success: toastSuccess },
}))

vi.mock('@tabtin/smartsheet-ui', () => {
  const passthrough = (tag: string) =>
    ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) =>
      React.createElement(tag, rest, children as React.ReactNode)
  return {
    Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogContent: passthrough('div'),
    DialogFooter: passthrough('div'),
    DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogHeader: passthrough('div'),
    DialogTitle: passthrough('div'),
    DialogScrollBody: passthrough('div'),
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipContent: () => null,
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Button: ({ children, ...rest }: React.ComponentProps<'button'>) => (
      <button {...rest}>{children}</button>
    ),
    Input: (props: React.ComponentProps<'input'>) => <input {...props} />,
    Label: ({ children, ...rest }: React.ComponentProps<'label'>) => (
      <label {...rest}>{children}</label>
    ),
    Textarea: (props: React.ComponentProps<'textarea'>) => <textarea {...props} />,
    Select: ({ children, value, onValueChange }: {
      children: React.ReactNode
      value?: string
      onValueChange?: (v: string) => void
    }) => (
      <div data-testid="mock-select" data-value={value ?? ''}>
        {React.Children.map(children, child => {
          if (!React.isValidElement(child)) return child
          return React.cloneElement(child as React.ReactElement<Record<string, unknown>>, {
            onValueChange,
          })
        })}
      </div>
    ),
    SelectContent: ({ children, onValueChange }: {
      children: React.ReactNode
      onValueChange?: (v: string) => void
    }) => (
      <div>
        {React.Children.map(children, child => {
          if (!React.isValidElement(child)) return child
          return React.cloneElement(child as React.ReactElement<Record<string, unknown>>, {
            onValueChange,
          })
        })}
      </div>
    ),
    SelectItem: ({ children, value, onValueChange, ...rest }: {
      children: React.ReactNode
      value?: string
      onValueChange?: (v: string) => void
    } & React.HTMLAttributes<HTMLDivElement>) => (
      <div
        role="option"
        data-value={value}
        onClick={() => value && onValueChange?.(value)}
        {...rest}
      >
        {children}
      </div>
    ),
    SelectTrigger: ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => (
      <div {...rest}>{children}</div>
    ),
    SelectValue: ({ children, placeholder }: { children?: React.ReactNode; placeholder?: string }) => (
      <span>{children ?? placeholder}</span>
    ),
    OverlayContainerContext: React.createContext({ container: null }),
    Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    TimeSelect: ({
      value,
      onChange,
    }: {
      value?: string
      onChange?: (v: string) => void
    }) => (
      <input
        data-testid="mock-time-select"
        value={value ?? ''}
        onChange={e => onChange?.(e.target.value)}
      />
    ),
    DatePicker: ({
      value,
      onChange,
      placeholder,
      className,
    }: {
      value?: string | null
      onChange?: (v: string | null) => void
      placeholder?: string
      className?: string
    }) => (
      <input
        data-testid="mock-date-picker"
        className={className}
        placeholder={placeholder}
        value={value ?? ''}
        onChange={e => onChange?.(e.target.value || null)}
      />
    ),
    Switch: ({ checked, onCheckedChange, id }: {
      checked?: boolean
      onCheckedChange?: (v: boolean) => void
      id?: string
    }) => (
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={e => onCheckedChange?.(e.target.checked)}
      />
    ),
    toast: { info: toastInfo, error: toastError, success: toastSuccess },
  }
})

vi.mock('@tabtin/app-shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tabtin/app-shell')>()
  return {
    ...actual,
    AgentApiService: {
      ...actual.AgentApiService,
      listAgents: vi.fn().mockResolvedValue([
        { id: 'agent-ipdt4b', name: 'Agent A' },
        { id: 'agent-other', name: 'Agent B' },
        { id: 'agent-default-space', name: 'Agent Default' },
        { id: 'agent-shared', name: 'Agent Shared' },
      ]),
    },
  }
})

import { CreateTrackerDialog } from './CreateTrackerDialog'

const baseEditTracker = {
  id: 'tk-1',
  name: '日报催办',
  description: '原始描述',
  status: 'draft',
  agent_id: 'agent-ipdt4b',
  workspace_id: 'space-ipdt4b',
  trigger_type: 'manual',
  trigger_config: {},
  skill_key: '',
  skill_params: { instructions: '生成日报' },
  total_runs: 0,
  success_runs: 0,
  fail_runs: 0,
  last_run_at: null,
  next_run_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
} as unknown as TrackerTask

async function waitForDefaultAgent(container: HTMLElement) {
  await waitFor(() => {
    expect(
      container.querySelector('[data-testid="tracker-agent-select"]')
        ?.closest('[data-testid="mock-select"]')
        ?.getAttribute('data-value'),
    ).toBe('agent-ipdt4b')
  })
}

function browserTimeZone(): string | undefined {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
}

describe('CreateTrackerDialog 描述字段 ', () => {
  beforeEach(() => {
    createTask.mockReset().mockResolvedValue({
      id: 'tk-new',
      status: 'active',
      trigger_type: 'manual',
      trigger_config: {},
    })
    updateTask.mockReset().mockResolvedValue({ id: 'tk-1' })
    toastInfo.mockReset()
    toastError.mockReset()
    toastSuccess.mockReset()
    requestAgentForTracker.mockReset().mockResolvedValue(true)
    spaceStoreState.spaces = [
      {
        id: 'space-ipdt4b',
        organization_id: 'wt-1',
        execution_agent_id: 'agent-ipdt4b',
        name: 'Space-ipdt4b',
        type: 'workspace',
        is_archived: false,
      },
      {
        id: 'space-default',
        organization_id: 'wt-1',
        execution_agent_id: 'agent-default-space',
        name: '默认 Space',
        type: 'workspace',
        is_archived: false,
      },
      {
        id: 'space-rename',
        organization_id: 'wt-1',
        execution_agent_id: 'agent-other',
        name: '改名测试',
        type: 'workspace',
        is_archived: false,
      },
    ]
  })

  it('新建时默认选中当前 Space，下拉用 Space 名称展示全量', async () => {
    const { container } = render(
      <CreateTrackerDialog open onOpenChange={() => {}} spaceId="space-ipdt4b" />,
    )

    expect(screen.getAllByText('Space-ipdt4b').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('option', { name: 'Space-ipdt4b' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '默认 Space' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '改名测试' })).toBeTruthy()
    expect(screen.queryByText(/执行身份/)).toBeNull()
    await waitForDefaultAgent(container)

    const nameInput = container.querySelector('#tracker-name') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: '新任务' } })
    const instructionsInput = container.querySelector('#tracker-instructions') as HTMLTextAreaElement
    fireEvent.change(instructionsInput, { target: { value: '每天生成日报' } })
    fireEvent.click(screen.getByRole('button', { name: 'submit' }))

    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
    expect(createTask.mock.calls[0][2].agent_id).toBe('agent-ipdt4b')
  })

  it('新建时可改选其它 Space / Agent 并提交对应 workspace_id 与 agent_id', async () => {
    const { container } = render(
      <CreateTrackerDialog open onOpenChange={() => {}} spaceId="space-ipdt4b" />,
    )

    await waitForDefaultAgent(container)
    fireEvent.click(screen.getByRole('option', { name: '改名测试' }))
    fireEvent.click(screen.getByRole('option', { name: 'Agent B' }))

    const nameInput = container.querySelector('#tracker-name') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: '新任务' } })
    const instructionsInput = container.querySelector('#tracker-instructions') as HTMLTextAreaElement
    fireEvent.change(instructionsInput, { target: { value: '每天生成日报' } })
    fireEvent.click(screen.getByRole('button', { name: 'submit' }))

    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
    expect(createTask.mock.calls[0][1]).toBe('space-ipdt4b')
    expect(createTask.mock.calls[0][2].workspace_id).toBe('space-rename')
    expect(createTask.mock.calls[0][2].agent_id).toBe('agent-other')
  })

  it('多个 Space 共用同一 agent_id 时下拉仍按 Space 名称各列一项', () => {
    spaceStoreState.spaces = [
      {
        id: 'space-a',
        organization_id: 'wt-1',
        execution_agent_id: 'agent-shared',
        name: 'Space A',
        type: 'workspace',
        is_archived: false,
      },
      {
        id: 'space-b',
        organization_id: 'wt-1',
        execution_agent_id: 'agent-shared',
        name: 'Space B',
        type: 'workspace',
        is_archived: false,
      },
    ]

    render(<CreateTrackerDialog open onOpenChange={() => {}} spaceId="space-a" />)

    expect(screen.getByRole('option', { name: 'Space A' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Space B' })).toBeTruthy()
  })

  it('无 execution_agent_id 的 Space 仍出现在下拉，并默认选中当前 Space', async () => {
    spaceStoreState.spaces = [
      {
        id: 'space-default',
        organization_id: 'wt-1',
        execution_agent_id: 'agent-default-space',
        name: '默认 Space',
        type: 'workspace',
        is_archived: false,
      },
      {
        id: 'space-ipdt4b',
        organization_id: 'wt-1',
        execution_agent_id: null,
        name: 'Space-ipdt4b',
        type: 'workspace',
        is_archived: false,
      },
      {
        id: 'space-rename',
        organization_id: 'wt-1',
        execution_agent_id: null,
        agent_id: null,
        name: '改名测试',
        type: 'workspace',
        is_archived: false,
      },
    ]

    const { container } = render(
      <CreateTrackerDialog open onOpenChange={() => {}} spaceId="space-rename" />,
    )

    // 执行工作空间 chip 应默认选中当前 Space，而不是 placeholder
    expect(
      container.querySelector('[data-testid="tracker-workspace-select"]')
        ?.closest('[data-testid="mock-select"]')
        ?.getAttribute('data-value'),
    ).toBe('space-rename')
    expect(screen.getAllByText('改名测试').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('option', { name: '改名测试' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Space-ipdt4b' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '默认 Space' })).toBeTruthy()
  })

  it('打开时 Agent 列表就绪后会回填默认选中', async () => {
    const { container } = render(
      <CreateTrackerDialog open onOpenChange={() => {}} spaceId="space-ipdt4b" />,
    )

    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="tracker-agent-select"]')
          ?.closest('[data-testid="mock-select"]')
          ?.getAttribute('data-value'),
      ).toBe('agent-ipdt4b')
    })

    const nameInput = container.querySelector('#tracker-name') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: '新任务' } })
    const instructionsInput = container.querySelector('#tracker-instructions') as HTMLTextAreaElement
    fireEvent.change(instructionsInput, { target: { value: '每天生成日报' } })
    fireEvent.click(screen.getByRole('button', { name: 'submit' }))

    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
    expect(createTask.mock.calls[0][2].agent_id).toBe('agent-ipdt4b')
  })

  it('编辑态回填 editTracker.description 并在提交时带上(可改写后的)描述', async () => {
    const { container } = render(
      <CreateTrackerDialog
        open
        onOpenChange={() => {}}
        spaceId="space-ipdt4b"
        editTracker={baseEditTracker}
      />,
    )

    // 编辑态有描述时「更多选项」会自动展开
    const descTextarea = await screen.findByLabelText('description') as HTMLTextAreaElement
    expect(descTextarea.value).toBe('原始描述')
    await waitForDefaultAgent(container)

    fireEvent.change(descTextarea, { target: { value: '更新后的描述' } })
    fireEvent.click(screen.getByRole('button', { name: 'save' }))

    await waitFor(() => expect(updateTask).toHaveBeenCalledTimes(1))
    const [taskId, payload] = updateTask.mock.calls[0]
    expect(taskId).toBe('tk-1')
    expect(payload.description).toBe('更新后的描述')
  })

  it('编辑已有 cron 时保留原 timezone', async () => {
    const editTracker = {
      ...baseEditTracker,
      trigger_type: 'cron',
      trigger_config: {
        cron_expression: '0 9 * * *',
        timezone: 'America/New_York',
      },
    } as TrackerTask
    render(
      <CreateTrackerDialog
        open
        onOpenChange={() => {}}
        spaceId="space-ipdt4b"
        editTracker={editTracker}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'save' }))

    await waitFor(() => expect(updateTask).toHaveBeenCalledTimes(1))
    expect(updateTask.mock.calls[0][1].trigger_config.timezone).toBe('America/New_York')
  })

  it('创建态提交时 payload 带上描述', async () => {
    const { container } = render(
      <CreateTrackerDialog open onOpenChange={() => {}} spaceId="space-ipdt4b" />,
    )

    const nameInput = container.querySelector('#tracker-name') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: '新任务' } })
    const instructionsInput = container.querySelector('#tracker-instructions') as HTMLTextAreaElement
    fireEvent.change(instructionsInput, { target: { value: '每天生成日报' } })

    fireEvent.click(screen.getByTestId('tracker-more-options'))
    const descTextarea = await screen.findByLabelText('description') as HTMLTextAreaElement
    fireEvent.change(descTextarea, { target: { value: '这是新任务的描述' } })

    fireEvent.click(screen.getByRole('button', { name: 'submit' }))

    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
    const [organizationId, spaceId, payload] = createTask.mock.calls[0]
    expect(organizationId).toBe('wt-1')
    expect(spaceId).toBe('space-ipdt4b')
    expect(payload.description).toBe('这是新任务的描述')
    expect(payload.skill_params).toEqual({ instructions: '每天生成日报' })
    expect(payload.trigger_config.timezone).toBe(browserTimeZone())
  })

  it('创建后始终启用', async () => {
    const { container } = render(
      <CreateTrackerDialog open onOpenChange={() => {}} spaceId="space-ipdt4b" />,
    )

    await waitForDefaultAgent(container)
    const nameInput = container.querySelector('#tracker-name') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: '新任务' } })
    const instructionsInput = container.querySelector('#tracker-instructions') as HTMLTextAreaElement
    fireEvent.change(instructionsInput, { target: { value: '每天生成日报' } })
    fireEvent.click(screen.getByRole('button', { name: 'submit' }))

    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
    expect(createTask.mock.calls[0][2].activate_on_create).toBe(true)
    expect(toastSuccess).toHaveBeenCalled()
    expect(toastInfo).not.toHaveBeenCalled()
  })

  it('指令为空时不可提交', async () => {
    const { container } = render(
      <CreateTrackerDialog open onOpenChange={() => {}} spaceId="space-ipdt4b" />,
    )

    const nameInput = container.querySelector('#tracker-name') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: '新任务' } })
    const submit = screen.getByRole('button', { name: 'submit' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(createTask).not.toHaveBeenCalled()
  })

  it('Agent 创建页签发送后进入右侧对话并关闭弹窗', async () => {
    const onOpenChange = vi.fn()
    render(
      <CreateTrackerDialog open onOpenChange={onOpenChange} spaceId="space-ipdt4b" />,
    )

    fireEvent.click(screen.getByTestId('tracker-create-mode-agent'))
    const request = await screen.findByTestId('tracker-agent-request') as HTMLTextAreaElement
    fireEvent.change(request, { target: { value: '每天早上检查 PR' } })
    fireEvent.click(screen.getByTestId('tracker-agent-create-submit'))

    await waitFor(() => expect(requestAgentForTracker).toHaveBeenCalledTimes(1))
    expect(requestAgentForTracker.mock.calls[0][0]).toBe('space-ipdt4b')
    expect(String(requestAgentForTracker.mock.calls[0][1])).toContain('每天早上检查 PR')
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(createTask).not.toHaveBeenCalled()
  })

  it('#4214 手动填写：任务名称与执行指令是两个带标签的独立字段', () => {
    render(<CreateTrackerDialog open onOpenChange={() => {}} spaceId="space-ipdt4b" />)

    const nameInput = screen.getByTestId('tracker-name')
    const instructionsInput = screen.getByTestId('tracker-instructions')
    expect(nameInput.tagName).toBe('INPUT')
    expect(instructionsInput.tagName).toBe('TEXTAREA')
    // i18n mock 返回 key 末段；必填星号拼进 accessible name
    expect(screen.getByLabelText(/name/)).toBe(nameInput)
    expect(screen.getByLabelText(/instructions/)).toBe(instructionsInput)
    expect(screen.getByText('nameHint')).toBeTruthy()
    expect(screen.getByText('instructionsHint')).toBeTruthy()
    // 不再是一体 composer 卡：名称与指令不在同一无标签容器里糊成一块
    expect(nameInput.closest('[data-testid="tracker-schedule-chips"]')).toBeNull()
    expect(instructionsInput.closest('[data-testid="tracker-schedule-chips"]')).toBeNull()
  })

  it('编辑态重名失败时展示统一提示且保留表单', async () => {
    const onOpenChange = vi.fn()
    updateTask.mockRejectedValue(new Error('当前 Space 已存在名为「日报催办」的自动化，请换一个名称。'))

    const { container } = render(
      <CreateTrackerDialog
        open
        onOpenChange={onOpenChange}
        spaceId="space-ipdt4b"
        editTracker={baseEditTracker}
      />,
    )

    await waitForDefaultAgent(container)
    const nameInput = container.querySelector('#tracker-name') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: '日报催办' } })
    fireEvent.click(screen.getByRole('button', { name: 'save' }))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(DUPLICATE_NAME_ERROR_TITLE)
    })
    expect(screen.getByText(DUPLICATE_NAME_ERROR_TITLE)).toBeTruthy()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})

describe('CreateTrackerDialog 打开期间不被 live editTracker 重置 ', () => {
  beforeEach(() => {
    createTask.mockReset()
    updateTask.mockReset()
    toastInfo.mockReset()
    toastError.mockReset()
    toastSuccess.mockReset()
  })

  it('弹窗开着时 editTracker 引用变化不覆盖用户未保存修改', () => {
    const { rerender, container } = render(
      <CreateTrackerDialog
        open
        onOpenChange={() => {}}
        spaceId="space-ipdt4b"
        editTracker={baseEditTracker}
      />,
    )

    const nameInput = container.querySelector('#tracker-name') as HTMLInputElement
    expect(nameInput.value).toBe('日报催办')
    fireEvent.change(nameInput, { target: { value: '我改过的名字' } })
    expect(nameInput.value).toBe('我改过的名字')

    // 模拟详情页后台 refresh：内容相同、对象引用不同
    const refreshed = { ...baseEditTracker } as TrackerTask
    rerender(
      <CreateTrackerDialog
        open
        onOpenChange={() => {}}
        spaceId="space-ipdt4b"
        editTracker={refreshed}
      />,
    )

    const nameAfterRefresh = container.querySelector('#tracker-name') as HTMLInputElement
    expect(nameAfterRefresh.value).toBe('我改过的名字')
  })

  it('关闭后再打开会按最新 editTracker 重新初始化', () => {
    const { rerender, container } = render(
      <CreateTrackerDialog
        open
        onOpenChange={() => {}}
        spaceId="space-ipdt4b"
        editTracker={baseEditTracker}
      />,
    )

    const nameInput = container.querySelector('#tracker-name') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: '我改过的名字' } })

    rerender(
      <CreateTrackerDialog
        open={false}
        onOpenChange={() => {}}
        spaceId="space-ipdt4b"
        editTracker={baseEditTracker}
      />,
    )

    const updated = { ...baseEditTracker, name: '服务端新名字' } as TrackerTask
    rerender(
      <CreateTrackerDialog
        open
        onOpenChange={() => {}}
        spaceId="space-ipdt4b"
        editTracker={updated}
      />,
    )

    const nameAfterReopen = container.querySelector('#tracker-name') as HTMLInputElement
    expect(nameAfterReopen.value).toBe('服务端新名字')
  })
})

describe('CreateTrackerDialog 模板预填与 intent_snapshot ', () => {
  beforeEach(() => {
    createTask.mockReset().mockResolvedValue({
      id: 'tk-new',
      status: 'active',
      trigger_type: 'cron',
      trigger_config: {},
    })
    updateTask.mockReset()
    toastInfo.mockReset()
    toastError.mockReset()
    toastSuccess.mockReset()
    sessionStorage.removeItem('tabtin:tracker:cliInitialValues')
    spaceStoreState.spaces = [{
      id: 'space-ipdt4b',
      organization_id: 'wt-1',
      execution_agent_id: 'agent-ipdt4b',
      name: 'Space-ipdt4b',
      type: 'workspace',
      is_archived: false,
    }]
  })

  it('弹窗打开期间 initialValues 引用变化不覆盖用户已编辑内容', () => {
    const firstValues = {
      name: 'AI 新闻推送',
      instructions: '汇总今日 AI 动态',
      schedulePreset: 'weekdays' as const,
      atTime: '09:30',
      templateId: 'ai_news_digest',
      templateVersion: '1',
      source: 'template' as const,
    }
    const { container, rerender } = render(
      <CreateTrackerDialog
        open
        onOpenChange={() => {}}
        spaceId="space-ipdt4b"
        initialValues={firstValues}
      />,
    )

    const nameInput = container.querySelector('#tracker-name') as HTMLInputElement
    const instructionsInput = container.querySelector('#tracker-instructions') as HTMLTextAreaElement
    fireEvent.change(nameInput, { target: { value: '用户改过的任务名' } })
    fireEvent.change(instructionsInput, { target: { value: '用户改过的指令' } })

    rerender(
      <CreateTrackerDialog
        open
        onOpenChange={() => {}}
        spaceId="space-ipdt4b"
        initialValues={{
          ...firstValues,
          name: '服务端新模板名',
          instructions: '服务端新模板指令',
        }}
      />,
    )

    expect((container.querySelector('#tracker-name') as HTMLInputElement).value)
      .toBe('用户改过的任务名')
    expect((container.querySelector('#tracker-instructions') as HTMLTextAreaElement).value)
      .toBe('用户改过的指令')
  })

  it('关闭后新一轮打开才按最新 initialValues 重置', () => {
    const firstValues = {
      name: 'AI 新闻推送',
      instructions: '汇总今日 AI 动态',
      schedulePreset: 'weekdays' as const,
      atTime: '09:30',
      templateId: 'ai_news_digest',
      templateVersion: '1',
      source: 'template' as const,
    }
    const { container, rerender } = render(
      <CreateTrackerDialog
        open
        onOpenChange={() => {}}
        spaceId="space-ipdt4b"
        initialValues={firstValues}
      />,
    )

    fireEvent.change(container.querySelector('#tracker-name') as HTMLInputElement, {
      target: { value: '用户改过的任务名' },
    })
    rerender(
      <CreateTrackerDialog
        open={false}
        onOpenChange={() => {}}
        spaceId="space-ipdt4b"
        initialValues={firstValues}
      />,
    )

    rerender(
      <CreateTrackerDialog
        open
        onOpenChange={() => {}}
        spaceId="space-ipdt4b"
        initialValues={{
          ...firstValues,
          name: '新一轮模板名',
          instructions: '新一轮模板指令',
        }}
      />,
    )

    expect((container.querySelector('#tracker-name') as HTMLInputElement).value)
      .toBe('新一轮模板名')
    expect((container.querySelector('#tracker-instructions') as HTMLTextAreaElement).value)
      .toBe('新一轮模板指令')
  })

  it('模板 initialValues 预填 name/instructions/schedule，intent_snapshot 含 template 元数据且 created_via 可审计', async () => {
    const { container } = render(
      <CreateTrackerDialog
        open
        onOpenChange={() => {}}
        spaceId="space-ipdt4b"
        initialValues={{
          name: 'AI 新闻推送',
          instructions: '汇总今日 AI 动态',
          schedulePreset: 'weekdays',
          atTime: '09:30',
          // 用 UTC（极少等于浏览器本地 IANA）避免未接线却碰巧绿
          timezone: 'UTC',
          templateId: 'ai_news_digest',
          templateVersion: '1',
          source: 'template',
        }}
      />,
    )

    await waitFor(() => {
      expect((container.querySelector('#tracker-name') as HTMLInputElement).value).toBe('AI 新闻推送')
    })
    expect((container.querySelector('#tracker-instructions') as HTMLTextAreaElement).value)
      .toBe('汇总今日 AI 动态')
    expect(
      container.querySelector('[data-testid="tracker-schedule"]')
        ?.closest('[data-testid="mock-select"]')
        ?.getAttribute('data-value'),
    ).toBe('weekdays')
    await waitForDefaultAgent(container)

    fireEvent.click(screen.getByRole('button', { name: 'submit' }))
    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
    const payload = createTask.mock.calls[0][2]
    expect(payload.intent_snapshot.created_via).toBe('ui')
    expect(payload.intent_snapshot.template_id).toBe('ai_news_digest')
    expect(payload.intent_snapshot.template_version).toBe('1')
    expect(payload.trigger_config.timezone).toBe('UTC')
    expect(payload.trigger_config.timezone).not.toBe(browserTimeZone())
  })

  it.each(['', 'Not/AZone'])('模板 timezone=%j 时回落浏览器本地时区', async timezone => {
    const { container } = render(
      <CreateTrackerDialog
        open
        onOpenChange={() => {}}
        spaceId="space-ipdt4b"
        initialValues={{
          name: '模板任务',
          instructions: '模板指令',
          schedulePreset: 'daily',
          atTime: '09:00',
          timezone,
          templateId: 'template-1',
          templateVersion: '1',
          source: 'template',
        }}
      />,
    )

    await waitForDefaultAgent(container)
    fireEvent.click(screen.getByRole('button', { name: 'submit' }))

    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
    expect(createTask.mock.calls[0][2].trigger_config.timezone).toBe(browserTimeZone())
  })

  it('模板打开不消费待处理 Cmd+K storage，随后普通打开仍可消费并保留来源', async () => {
    const cmdKPayload = JSON.stringify({
      name: '待处理 CmdK 任务',
      schedulePreset: 'daily',
      atTime: '08:00',
    })
    sessionStorage.setItem('tabtin:tracker:cliInitialValues', cmdKPayload)

    const { container, rerender } = render(
      <CreateTrackerDialog
        open
        onOpenChange={() => {}}
        spaceId="space-ipdt4b"
        initialValues={{
          name: '模板任务',
          instructions: '模板指令',
          schedulePreset: 'weekdays',
          atTime: '09:30',
          templateId: 'template-1',
          templateVersion: '1',
          source: 'template',
        }}
      />,
    )

    expect((container.querySelector('#tracker-name') as HTMLInputElement).value).toBe('模板任务')
    expect(sessionStorage.getItem('tabtin:tracker:cliInitialValues')).toBe(cmdKPayload)

    rerender(
      <CreateTrackerDialog
        open={false}
        onOpenChange={() => {}}
        spaceId="space-ipdt4b"
        initialValues={{
          name: '模板任务',
          instructions: '模板指令',
          schedulePreset: 'weekdays',
          atTime: '09:30',
          templateId: 'template-1',
          templateVersion: '1',
          source: 'template',
        }}
      />,
    )
    rerender(
      <CreateTrackerDialog
        open
        onOpenChange={() => {}}
        spaceId="space-ipdt4b"
      />,
    )

    const nameInput = container.querySelector('#tracker-name') as HTMLInputElement
    const instructionsInput = container.querySelector('#tracker-instructions') as HTMLTextAreaElement
    expect(nameInput.value).toBe('待处理 CmdK 任务')
    expect(sessionStorage.getItem('tabtin:tracker:cliInitialValues')).toBeNull()
    fireEvent.change(instructionsInput, { target: { value: 'CmdK 指令' } })
    await waitForDefaultAgent(container)
    fireEvent.click(screen.getByRole('button', { name: 'submit' }))

    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
    expect(createTask.mock.calls[0][2].intent_snapshot.created_via).toBe('command_palette')
  })

  it('消费 Cmd+K sessionStorage 预填并写 created_via=command_palette', async () => {
    sessionStorage.setItem(
      'tabtin:tracker:cliInitialValues',
      JSON.stringify({
        name: 'CmdK 任务',
        schedulePreset: 'daily',
        atTime: '09:00',
      }),
    )
    const { container } = render(
      <CreateTrackerDialog
        open
        onOpenChange={() => {}}
        spaceId="space-ipdt4b"
      />,
    )

    await waitFor(() => {
      expect((container.querySelector('#tracker-name') as HTMLInputElement).value).toBe('CmdK 任务')
    })
    expect(sessionStorage.getItem('tabtin:tracker:cliInitialValues')).toBeNull()
    fireEvent.change(container.querySelector('#tracker-instructions') as HTMLTextAreaElement, {
      target: { value: '每天检查 PR' },
    })
    await waitForDefaultAgent(container)
    fireEvent.click(screen.getByRole('button', { name: 'submit' }))
    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
    const payload = createTask.mock.calls[0][2]
    expect(payload.intent_snapshot.created_via).toBe('command_palette')
    expect(payload.intent_snapshot.template_id).toBeUndefined()
    expect(payload.intent_snapshot.template_version).toBeUndefined()
  })

  it('Cmd+K 来源在 close→open 后不泄漏到普通 UI 创建', async () => {
    sessionStorage.setItem(
      'tabtin:tracker:cliInitialValues',
      JSON.stringify({
        name: 'CmdK 任务',
        schedulePreset: 'daily',
        atTime: '09:00',
      }),
    )
    const { container, rerender } = render(
      <CreateTrackerDialog
        open
        onOpenChange={() => {}}
        spaceId="space-ipdt4b"
      />,
    )

    await waitFor(() => {
      expect((container.querySelector('#tracker-name') as HTMLInputElement).value).toBe('CmdK 任务')
    })
    rerender(
      <CreateTrackerDialog
        open={false}
        onOpenChange={() => {}}
        spaceId="space-ipdt4b"
      />,
    )
    rerender(
      <CreateTrackerDialog
        open
        onOpenChange={() => {}}
        spaceId="space-ipdt4b"
      />,
    )

    const nameInput = container.querySelector('#tracker-name') as HTMLInputElement
    const instructionsInput = container.querySelector('#tracker-instructions') as HTMLTextAreaElement
    expect(nameInput.value).toBe('')
    fireEvent.change(nameInput, { target: { value: '普通 UI 任务' } })
    fireEvent.change(instructionsInput, { target: { value: '普通 UI 指令' } })
    await waitForDefaultAgent(container)
    fireEvent.click(screen.getByRole('button', { name: 'submit' }))

    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
    expect(createTask.mock.calls[0][2].intent_snapshot.created_via).toBe('ui')
  })
})
