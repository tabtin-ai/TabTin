import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { TaskDetail, TaskRun } from '@/services/trackerApi'

const getTask = vi.fn()
const listTaskRuns = vi.fn()
const cancelTaskRun = vi.fn()
const activateTask = vi.fn()
const resumeTask = vi.fn()
const pauseTask = vi.fn()
const triggerTask = vi.fn()
const enterChatSession = vi.fn()
const openResourceTab = vi.fn()
const closeTab = vi.fn()
const abortStream = vi.fn()
const listAgents = vi.fn()
const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}))
const trackerEventStreamMock = vi.hoisted(() => ({
  options: null as {
    onTrackerDeleted?: (payload: { tracker_id: string }) => void
    onRunCancelled?: (payload: { tracker_id: string; space_id?: string | null }) => void
  } | null,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> | string) => {
      if (key === 'detail.openRunSession') return '打开本次执行对话'
      if (key === 'detail.openRunSessionFailed') return '打开执行对话失败，请重试'
      if (key === 'detail.actions.trigger') return '立即执行'
      if (key === 'detail.actions.triggerDisabledActiveRun') {
        return '已有执行中的任务，请等待完成或先取消后再触发'
      }
      if (key === 'detail.runStatus.failed') return '失败'
      if (key === 'detail.runStatus.completed') return '成功'
      if (key === 'detail.runHistory') return '历史记录'
      if (key === 'status.active') return '已激活'
      if (key === 'detail.scheduleActive') return String((opts as Record<string, unknown>)?.schedule)
      if (key === 'detail.schedulePaused') return `${String((opts as Record<string, unknown>)?.schedule)} · 当前已暂停`
      if (key === 'frequencyHint.atOnce') return `${String((opts as Record<string, unknown>)?.at)} 执行一次`
      if (key === 'detail.health.failing') return '最近执行失败较多，建议查看下方记录排查'
      if (key === 'detail.health.missedSkipped') return `最近一次错过已按设置跳过（${String((opts as Record<string, unknown>)?.time)}），累计跳过 ${String((opts as Record<string, unknown>)?.count)} 次`
      if (key === 'status.paused') return '已暂停'
      if (key === 'trigger.cron') return '定时'
      if (typeof opts === 'string') return opts
      if (opts?.defaultValue) return String(opts.defaultValue)
      return key
    },
  }),
}))

vi.mock('@/i18n', () => ({
  default: {
    language: 'zh-CN',
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  },
}))

vi.mock('@/hooks/useResolvedOrganizationId', () => ({
  useResolvedOrganizationId: () => 'org-1',
}))

vi.mock('@tabtin/app-shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tabtin/app-shell')>()
  return {
    ...actual,
    AgentApiService: {
      listAgents: (...args: unknown[]) => listAgents(...args),
    },
  }
})

vi.mock('@/services/trackerApi', () => ({
  getTask: (...args: unknown[]) => getTask(...args),
  listTaskRuns: (...args: unknown[]) => listTaskRuns(...args),
  cancelTaskRun: (...args: unknown[]) => cancelTaskRun(...args),
  activateTask: (...args: unknown[]) => activateTask(...args),
  resumeTask: (...args: unknown[]) => resumeTask(...args),
  pauseTask: (...args: unknown[]) => pauseTask(...args),
  triggerTask: (...args: unknown[]) => triggerTask(...args),
  getDisplayableNextRunAt: vi.fn(() => null),
}))

vi.mock('@/services/chatSessionNavigation', () => ({
  enterChatSession: (...args: unknown[]) => enterChatSession(...args),
}))

vi.mock('@/stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      openResourceTab,
      closeTab,
    }),
  },
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      abortStream,
    }),
  },
}))

vi.mock('@/hooks/useTrackerEventStream', () => ({
  useTrackerEventStream: (options: typeof trackerEventStreamMock.options) => {
    trackerEventStreamMock.options = options
  },
}))

vi.mock('@components/common/ListSkeletons', () => ({
  DetailedRowListSkeleton: () => <div data-testid="skeleton" />,
}))

vi.mock('./CreateTrackerDialog', () => ({
  CreateTrackerDialog: () => null,
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, ...rest }: React.ComponentProps<'button'>) => (
    <button {...rest}>{children}</button>
  ),
  Switch: ({
    checked,
    onCheckedChange,
    ...rest
  }: {
    checked?: boolean
    onCheckedChange?: (checked: boolean) => void
  } & Omit<React.ComponentProps<'button'>, 'onChange'>) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange?.(!checked)}
      {...rest}
    />
  ),
  // 87a983353 把删除确认从 ConfirmDialog 换成 Dialog 系列后 mock 未同步，
  // 缺失导出渲染为 undefined 导致整个 detail 渲染崩溃（同类问题见 ）。
  Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) => (
    open ? <div role="dialog">{children}</div> : null
  ),
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  toast: {
    success: toastMocks.success,
    info: toastMocks.info,
    error: toastMocks.error,
  },
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: React.ReactNode }) => (
    <div role="tooltip">{children}</div>
  ),
  // packages/table-ui 编译产物会 import 这些 utils（@tabtin/smartsheet-ui 的真实 export），
  // 测试 mock 必须 stub 出来，否则 import 阶段抛 "No 'resolveChoiceTagColors' export is defined" 让整个 test file 加载失败。
  // 本测试只测 TrackerDetail run-session 跳转逻辑，不渲染任何选择字段标签，stub 成 noop 即可。
  resolveChoiceTagColors: vi.fn(() => ({ background: '#ffffff', text: '#000000' })),
  CHOICE_COLOR_HEX_MAP: {},
  FALLBACK_TAG_BG_COLORS: [],
  FALLBACK_TAG_TEXT_COLORS: [],
  stableHash: vi.fn(() => 0),
  normalizeHexColor: vi.fn((v: string) => v),
  isLightHexColor: vi.fn(() => true),
  getChoiceValue: vi.fn((c: unknown) => String(c)),
  getChoiceLabel: vi.fn((c: unknown) => String(c)),
  choicesToText: vi.fn((c: unknown[]) => c.map(String).join(',')),
}))

import { TrackerDetail } from './TrackerDetail'

describe('TrackerDetail run session navigation', () => {
  beforeEach(() => {
    getTask.mockReset()
    listTaskRuns.mockReset()
    cancelTaskRun.mockReset()
    activateTask.mockReset()
    resumeTask.mockReset()
    pauseTask.mockReset()
    triggerTask.mockReset().mockResolvedValue({})
    enterChatSession.mockReset()
    openResourceTab.mockReset()
    closeTab.mockReset()
    abortStream.mockReset()
    listAgents.mockReset().mockResolvedValue([{ id: 'agent-1', name: '执行助手' }])
    toastMocks.success.mockReset()
    toastMocks.info.mockReset()
    toastMocks.error.mockReset()
    trackerEventStreamMock.options = null
  })

  it('面包屑点击自动化返回主列表', async () => {
    getTask.mockResolvedValue(makeDetail())
    listTaskRuns.mockResolvedValue([])

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    // detail.name 同时出现在面包屑当前项和页头标题，用 findAll 等渲染完成即可
    await screen.findAllByText('日报催办')
    fireEvent.click(screen.getByRole('button', { name: 'appName' }))

    expect(openResourceTab).toHaveBeenCalledWith('space-1', {
      type: 'tabtracker',
      id: 'tracker-space-1',
      title: 'appName',
      meta: { spaceId: 'space-1' },
    })
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('点击带 chat_session_id 的执行记录会进入对应对话 session', async () => {
    getTask.mockResolvedValue(makeDetail())
    listTaskRuns.mockResolvedValue([
      makeRun({ id: 'run-1', chat_session_id: 'session-1' }),
    ])

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    const runCard = await screen.findByTitle('打开本次执行对话')
    fireEvent.click(runCard)

    await waitFor(() => {
      expect(enterChatSession).toHaveBeenCalledWith('space-1', 'session-1', {
        verifySessionExists: true,
        sessionFailureMessage: '打开执行对话失败，请重试',
        initialScroll: 'first-message',
      })
    })
  })

  it('执行记录仅在键盘聚焦时展示完整的内嵌焦点提示', async () => {
    getTask.mockResolvedValue(makeDetail())
    listTaskRuns.mockResolvedValue([
      makeRun({ id: 'run-1', chat_session_id: 'session-1' }),
    ])

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    const runCard = await screen.findByTitle('打开本次执行对话')
    expect(runCard.className).not.toContain('focus:ring-2')
    expect(runCard.className).not.toContain('focus:ring-offset-1')
    expect(runCard.className).toContain('focus-visible:ring-2')
    expect(runCard.className).toContain('focus-visible:ring-inset')
  })

  it('历史记录展示相对时间、绝对时间与状态，不展示耗时', async () => {
    getTask.mockResolvedValue(makeDetail())
    listTaskRuns.mockResolvedValue([
      makeRun({
        status: 'completed',
        chat_session_id: 'session-1',
        duration: 162,
        error_summary: '',
        started_at: '2026-08-03T09:00:00.000Z',
      }),
    ])

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    expect(await screen.findByText('历史记录')).toBeTruthy()
    expect(screen.queryByText('detail.refreshRuns')).toBeNull()

    const relativeTime = screen.getByTestId('tracker-run-relative-time-run-1')
    const status = screen.getByTestId('tracker-run-status-run-1')
    const rightMeta = screen.getByTestId('tracker-run-right-meta-run-1')
    expect(status.parentElement).toBe(rightMeta)
    expect(rightMeta.parentElement).toBe(relativeTime.parentElement)
    expect(relativeTime.compareDocumentPosition(rightMeta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(status.querySelector('.rounded-full')).not.toBeNull()
    expect(status.className).toContain('text-body')
    expect(screen.getByTestId('tracker-run-chevron-run-1')).toBeTruthy()
    expect(screen.queryByText(/耗时/)).toBeNull()
  })

  it('有无执行对话时都保留相同的箭头槽位，让成功和失败状态对齐', async () => {
    getTask.mockResolvedValue(makeDetail())
    listTaskRuns.mockResolvedValue([
      makeRun({
        id: 'run-success',
        status: 'completed',
        chat_session_id: 'session-success',
      }),
      makeRun({
        id: 'run-failed',
        status: 'failed',
        chat_session_id: null,
      }),
    ])

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    const successSlot = await screen.findByTestId('tracker-run-chevron-slot-run-success')
    const failedSlot = screen.getByTestId('tracker-run-chevron-slot-run-failed')
    expect(successSlot.className).toContain('h-4 w-4')
    expect(failedSlot.className).toContain('h-4 w-4')
    expect(screen.getByTestId('tracker-run-chevron-run-success')).toBeTruthy()
    expect(screen.queryByTestId('tracker-run-chevron-run-failed')).toBeNull()
  })

  it('展示错过后按 skip 策略跳过的页面提示', async () => {
    getTask.mockResolvedValue(makeDetail({
      trigger_config: {
        catchup_policy: 'skip',
        _missed_count: 2,
        _last_missed_at: '2026-07-06T07:18:23.000Z',
      },
    }))
    listTaskRuns.mockResolvedValue([])

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    expect(await screen.findByText(/最近一次错过已按设置跳过/)).toBeTruthy()
    expect(screen.getByText(/累计跳过 2 次/)).toBeTruthy()
  })

  it('执行失败较多时不再展示额外警告提示', async () => {
    getTask.mockResolvedValue(makeDetail({
      status: 'active',
      success_runs: 0,
      fail_runs: 3,
      last_run_at: new Date().toISOString(),
    }))
    listTaskRuns.mockResolvedValue([])

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    await screen.findAllByText('日报催办')
    expect(screen.queryByText('最近执行失败较多，建议查看下方记录排查')).toBeNull()
  })

  it('产品状态只展示活动或暂停，更多中展示备注、错过策略和授权提示，不展示时区', async () => {
    getTask.mockResolvedValue(makeDetail({
      status: 'disabled',
      agent_id: 'agent-1',
      space_name: '市场工作空间',
      trigger_config: {
        catchup_policy: 'skip',
        timezone: 'Asia/Shanghai',
      },
    }))
    listTaskRuns.mockResolvedValue([])

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    expect(await screen.findAllByText('已暂停')).not.toHaveLength(0)
    expect(screen.queryByText('status.disabled')).toBeNull()
    expect(await screen.findByText('执行助手')).toBeTruthy()
    expect(screen.getByText('市场工作空间')).toBeTruthy()

    fireEvent.click(screen.getByText('detail.more.title'))
    expect(screen.getByText('每天检查今日到期未完成的任务，生成催办通知')).toBeTruthy()
    expect(screen.getByText('createDialog.catchup.skip')).toBeTruthy()
    expect(screen.queryByText('Asia/Shanghai')).toBeNull()
    expect(screen.getByText('createDialog.permissionNotice.hint')).toBeTruthy()
  })

  it('暂停态通过唯一状态开关恢复为活动', async () => {
    getTask.mockResolvedValue(makeDetail({ status: 'paused' }))
    listTaskRuns.mockResolvedValue([])
    resumeTask.mockResolvedValue(makeDetail({ status: 'active' }))

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    fireEvent.click(await screen.findByTestId('tracker-detail-status-toggle'))
    await waitFor(() => {
      expect(resumeTask).toHaveBeenCalledWith('task-1')
      expect(toastMocks.success).toHaveBeenCalledWith('detail.actions.resumed')
    })
  })

  it('暂停态仍允许立即执行且不会先恢复自动调度', async () => {
    getTask.mockResolvedValue(makeDetail({ status: 'paused' }))
    listTaskRuns.mockResolvedValue([])

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    fireEvent.click(await screen.findByTestId('tracker-detail-trigger'))
    await waitFor(() => {
      expect(triggerTask).toHaveBeenCalledWith('task-1')
      expect(resumeTask).not.toHaveBeenCalled()
      expect(toastMocks.success).toHaveBeenCalledWith('detail.actions.triggered')
    })
  })

  it('定时一次在详情标题下展示明确的执行时间', async () => {
    getTask.mockResolvedValue(makeDetail({
      status: 'active',
      trigger_type: 'at',
      trigger_config: { at: '2026-08-15T01:30:00.000Z' },
    }))
    listTaskRuns.mockResolvedValue([])

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    expect((await screen.findAllByText(/^2026-08-15 \d{2}:30(?: 执行一次)?$/)).length).toBeGreaterThanOrEqual(2)
  })

  it('详情不提供删除入口', async () => {
    getTask.mockResolvedValue(makeDetail())
    listTaskRuns.mockResolvedValue([])

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    expect(await screen.findByText('detail.actions.edit')).toBeTruthy()
    expect(screen.queryByText('detail.actions.delete')).toBeNull()
  })

  it('外部删除当前 Tracker 时提示并回到首页', async () => {
    getTask.mockResolvedValue(makeDetail())
    listTaskRuns.mockResolvedValue([])

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    await waitFor(() => {
      expect(trackerEventStreamMock.options?.onTrackerDeleted).toBeTypeOf('function')
    })

    trackerEventStreamMock.options?.onTrackerDeleted?.({ tracker_id: 'task-1' })

    expect(toastMocks.info).toHaveBeenCalledWith('detail.actions.deleted')
    expect(openResourceTab).toHaveBeenCalledWith('space-1', {
      type: 'tabtracker',
      id: 'tracker-space-1',
      title: 'appName',
      meta: { spaceId: 'space-1' },
    })
    expect(closeTab).toHaveBeenCalledWith(
      'space-1',
      'tabtracker:task-1',
      'tabtracker:tracker-space-1',
    )
  })

  it('有执行中 Run 时禁用立即执行并展示互斥 tooltip', async () => {
    getTask.mockResolvedValue(makeDetail({ status: 'active' }))
    listTaskRuns.mockResolvedValue([
      makeRun({ status: 'running', error_summary: '', finished_at: null }),
    ])

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    const trigger = await screen.findByTestId('tracker-detail-trigger') as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    expect(screen.getByRole('tooltip').textContent).toContain('已有执行中的任务')
  })

  it('执行结果按 Markdown 渲染', async () => {
    getTask.mockResolvedValue(makeDetail())
    listTaskRuns.mockResolvedValue([
      makeRun({
        status: 'completed',
        error_summary: '',
        result_summary: '**自动化基础能力测试已触发**\n\n已成功触发提醒通知。',
      }),
    ])

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    const heading = await screen.findByText('自动化基础能力测试已触发')
    expect(heading.tagName.toLowerCase()).toBe('strong')
    expect(screen.queryByText('**自动化基础能力测试已触发**')).toBeNull()
  })

  it('在执行结果区域按键不会误打开执行对话', async () => {
    getTask.mockResolvedValue(makeDetail())
    listTaskRuns.mockResolvedValue([
      makeRun({
        status: 'completed',
        chat_session_id: 'session-1',
        error_summary: '',
        result_summary: '**自动化基础能力测试已触发**',
      }),
    ])

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    const summary = await screen.findByText('detail.resultSummary')
    fireEvent.keyDown(summary, { key: 'Enter' })

    expect(enterChatSession).not.toHaveBeenCalled()
  })

  it('失败记录以折叠展示完整错误，并附带不同的原始错误', async () => {
    getTask.mockResolvedValue(makeDetail())
    listTaskRuns.mockResolvedValue([
      makeRun({
        status: 'failed',
        chat_session_id: 'session-1',
        error_summary: '模型服务太忙了，请稍后再试（已自动重试 2 次）',
        result_summary: 'Model service is too busy. Please try again later.',
      }),
    ])

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    const summary = await screen.findByText('detail.errorDetail')
    const details = summary.closest('details')
    expect(details).not.toBeNull()
    expect(details?.open).toBe(false)

    fireEvent.click(summary)
    expect(details?.open).toBe(true)
    expect(screen.getByText('模型服务太忙了，请稍后再试（已自动重试 2 次）')).toBeTruthy()
    expect(screen.getByText('Model service is too busy. Please try again later.')).toBeTruthy()
  })

  it('在失败详情区域按键不会误打开执行对话', async () => {
    getTask.mockResolvedValue(makeDetail())
    listTaskRuns.mockResolvedValue([
      makeRun({
        status: 'failed',
        chat_session_id: 'session-1',
        error_summary: '执行超时',
        result_summary: 'run timed out after 38 minutes',
      }),
    ])

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    const summary = await screen.findByText('detail.errorDetail')
    fireEvent.keyDown(summary, { key: 'Enter' })

    expect(enterChatSession).not.toHaveBeenCalled()
  })

  it('取消记录折叠标题使用取消原因文案', async () => {
    getTask.mockResolvedValue(makeDetail())
    listTaskRuns.mockResolvedValue([
      makeRun({
        status: 'cancelled',
        error_summary: 'live verify probe cancelled',
        result_summary: '',
      }),
    ])

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    const summary = await screen.findByText('detail.cancelDetail')
    const details = summary.closest('details')
    expect(details).not.toBeNull()
    expect(details?.open).toBe(false)
    expect(screen.getByText('live verify probe cancelled')).toBeTruthy()

    fireEvent.click(summary)
    expect(details?.open).toBe(true)
  })

  it('收到取消终态事件后刷新执行记录', async () => {
    getTask.mockResolvedValue(makeDetail())
    listTaskRuns
      .mockResolvedValueOnce([makeRun({ status: 'running', error_summary: '', finished_at: null })])
      .mockResolvedValueOnce([makeRun({ status: 'cancelled', error_summary: '', finished_at: new Date().toISOString() })])

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    await waitFor(() => {
      expect(trackerEventStreamMock.options?.onRunCancelled).toBeTypeOf('function')
    })

    await act(async () => {
      trackerEventStreamMock.options?.onRunCancelled?.({ tracker_id: 'task-1', space_id: 'space-1' })
    })

    await waitFor(() => {
      expect(listTaskRuns).toHaveBeenCalledTimes(2)
    })
  })

  it('取消接口发现 run 已终态时刷新旧状态并移除取消按钮', async () => {
    getTask.mockResolvedValue(makeDetail())
    listTaskRuns
      .mockResolvedValueOnce([makeRun({ status: 'running', error_summary: '', finished_at: null })])
      .mockResolvedValueOnce([makeRun({ status: 'completed', error_summary: '', result_summary: '已完成' })])
    cancelTaskRun.mockRejectedValue(new Error('只能取消等待中或运行中的执行 (当前状态: completed)'))

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    fireEvent.click(await screen.findByText('detail.actions.cancelRun'))

    await waitFor(() => {
      expect(cancelTaskRun).toHaveBeenCalledWith('task-1', 'run-1')
      expect(toastMocks.error).toHaveBeenCalledWith('只能取消等待中或运行中的执行 (当前状态: completed)')
      expect(screen.queryByText('detail.actions.cancelRun')).toBeNull()
    })
  })

  it('取消请求未返回时重复点击不会重复发送取消请求', async () => {
    getTask.mockResolvedValue(makeDetail())
    listTaskRuns.mockResolvedValue([
      makeRun({ status: 'running', error_summary: '', finished_at: null }),
    ])
    let resolveCancel: ((value: TaskRun) => void) | undefined
    cancelTaskRun.mockReturnValue(new Promise<TaskRun>((resolve) => {
      resolveCancel = resolve
    }))

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    const cancelButton = await screen.findByText('detail.actions.cancelRun')
    fireEvent.click(cancelButton)
    fireEvent.click(cancelButton)

    expect(cancelTaskRun).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveCancel?.(makeRun({ status: 'cancelled', error_summary: '' }))
    })
  })

  it('取消带 chat_session_id 的执行记录会同步中止右侧对话流', async () => {
    getTask.mockResolvedValue(makeDetail())
    listTaskRuns
      .mockResolvedValueOnce([
        makeRun({ status: 'running', chat_session_id: 'session-1', error_summary: '', finished_at: null }),
      ])
      .mockResolvedValueOnce([
        makeRun({ status: 'cancelled', chat_session_id: 'session-1', error_summary: '' }),
      ])
    cancelTaskRun.mockResolvedValue(makeRun({
      status: 'cancelled',
      chat_session_id: 'session-1',
      error_summary: '',
    }))

    render(<TrackerDetail spaceId="space-1" taskId="task-1" />)

    fireEvent.click(await screen.findByText('detail.actions.cancelRun'))

    await waitFor(() => {
      expect(cancelTaskRun).toHaveBeenCalledWith('task-1', 'run-1')
      expect(abortStream).toHaveBeenCalledWith('session-1')
    })
  })
})

function makeDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: 'task-1',
    name: '日报催办',
    description: '每天检查今日到期未完成的任务，生成催办通知',
    event_type: 'agent_task',
    status: 'paused',
    trigger_type: 'cron',
    trigger_config: {},
    next_run_at: null,
    last_run_at: null,
    skill_key: '',
    skill_params: null,
    total_runs: 1,
    success_runs: 0,
    fail_runs: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as unknown as TaskDetail
}

function makeRun(overrides: Partial<TaskRun>): TaskRun {
  return {
    id: 'run-1',
    tracker_id: 'task-1',
    chat_session_id: null,
    trigger_type: 'scheduled',
    trigger_context: {},
    status: 'failed',
    total_steps: 0,
    completed_steps: 0,
    progress: 100,
    progress_pct: 100,
    progress_message: '',
    tokens_used: 0,
    current_cycle: 1,
    max_cycles: 1,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration: 0,
    error_summary: 'Task-level failure',
    created_at: new Date().toISOString(),
    ...overrides,
  }
}
