import React, { useRef } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  snapshot: {
    lockedViewIds: [] as string[],
    userControlledViewIds: [] as string[],
    sessionIdsByViewId: {} as Record<string, string[]>,
  },
  sessions: new Map<string, { id: string; title: string }>(),
  abortStreamFromComposer: vi.fn(),
  injectSystemMessage: vi.fn(),
  takeOverBrowser: vi.fn(),
  handBackBrowser: vi.fn(),
  toast: vi.fn(),
  webviewEnabled: true,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'embedded.agentControlStatus': 'Agent 正在控制',
      'embedded.userControlStatus': '你正在控制',
      'embedded.agentLockUntitled': '新任务',
      'embedded.takeOver': '接管',
      'embedded.handBack': '交还给 Agent',
      'embedded.stopTask': '终止任务',
      'embedded.stopAllTasks': '终止全部任务',
      'embedded.takeOverFact': '你接管了浏览器，Agent 已暂停',
      'embedded.handBackFact': '你已交还此浏览器控制权',
      'embedded.handBackResumedFact': '你已交还浏览器，Agent 将继续任务',
      'embedded.taskCount': '2 个任务',
      'embedded.unknownTask': '未知任务',
      'embedded.taskUnavailable': '无法定位任务',
      'embedded.controlActionFailed': '浏览器控制权切换失败，请重试',
      'embedded.stopTaskFailed': '部分任务终止失败，请重试',
    })[key] ?? key,
  }),
}))

vi.mock('@stores/useBrowserTabLockStore', () => ({
  useBrowserTabLockStore: (
    selector: (state: {
      isLocked: (viewId: string) => boolean
      isUserControlling: (viewId: string) => boolean
      getSessionIds: (viewId: string) => string[]
    }) => unknown,
  ) => selector({
    isLocked: (viewId) => mocks.snapshot.lockedViewIds.includes(viewId),
    isUserControlling: (viewId) => mocks.snapshot.userControlledViewIds.includes(viewId),
    getSessionIds: (viewId) => mocks.snapshot.sessionIdsByViewId[viewId] ?? [],
  }),
}))

vi.mock('@stores/chat/useChatStore', () => {
  const state = {
    getSessionById: (sessionId: string) => mocks.sessions.get(sessionId),
    abortStreamFromComposer: mocks.abortStreamFromComposer,
    injectSystemMessage: mocks.injectSystemMessage,
  }
  const useChatStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  )
  return { useChatStore }
})

vi.mock('@/utils/browserContainerMode', () => ({
  isWebviewContainerEnabled: () => mocks.webviewEnabled,
}))

vi.mock('@components/ui', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
  toast: mocks.toast,
}))

import { AgentBrowserControlCapsule } from '../AgentBrowserControlCapsule'

function setControlSnapshot(snapshot: {
  lockedViewIds?: string[]
  userControlledViewIds?: string[]
  sessionIdsByViewId?: Record<string, string[]>
}) {
  mocks.snapshot.lockedViewIds = snapshot.lockedViewIds ?? []
  mocks.snapshot.userControlledViewIds = snapshot.userControlledViewIds ?? []
  mocks.snapshot.sessionIdsByViewId = snapshot.sessionIdsByViewId ?? {}
}

function Harness({ isActive = true }: { isActive?: boolean }) {
  const paneRef = useRef<HTMLDivElement>(null)
  return (
    <>
      <div ref={paneRef} />
      <AgentBrowserControlCapsule
        paneRef={paneRef}
        viewId="view-1"
        isActive={isActive}
        spaceId="space-1"
      />
    </>
  )
}

describe('AgentBrowserControlCapsule', () => {
  beforeEach(() => {
    setControlSnapshot({})
    mocks.sessions.clear()
    mocks.sessions.set('session-1', { id: 'session-1', title: 'Watcha 产品调研' })
    mocks.sessions.set('session-2', { id: 'session-2', title: '竞品价格采集' })
    mocks.abortStreamFromComposer.mockReset().mockResolvedValue(undefined)
    mocks.injectSystemMessage.mockReset()
    mocks.takeOverBrowser.mockReset().mockResolvedValue({
      success: true,
      sessionIds: ['session-1'],
    })
    mocks.handBackBrowser.mockReset().mockResolvedValue({
      success: true,
      sessionIds: ['session-1'],
      releasedSessionIds: ['session-1'],
    })
    mocks.toast.mockReset()
    mocks.webviewEnabled = true
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      writable: true,
      value: {
        ...(window.tabtin ?? {}),
        crawlView: {
          ...(window.tabtin?.crawlView ?? {}),
          takeOverBrowser: mocks.takeOverBrowser,
          handBackBrowser: mocks.handBackBrowser,
        },
      },
    })
  })

  it('空闲、非活动或非 webview 时不显示', () => {
    const { rerender } = render(<Harness />)
    expect(screen.queryByTestId('agent-browser-control-capsule')).toBeNull()

    setControlSnapshot({
      lockedViewIds: ['view-1'],
      sessionIdsByViewId: { 'view-1': ['session-1'] },
    })
    rerender(<Harness isActive={false} />)
    expect(screen.queryByTestId('agent-browser-control-capsule')).toBeNull()

    mocks.webviewEnabled = false
    rerender(<Harness />)
    expect(screen.queryByTestId('agent-browser-control-capsule')).toBeNull()
  })

  it('Agent 控制态显示真实 holder 任务名、接管和终止', () => {
    setControlSnapshot({
      lockedViewIds: ['view-1'],
      sessionIdsByViewId: { 'view-1': ['session-1'] },
    })

    render(<Harness />)

    expect(screen.getByText('Watcha 产品调研')).toBeTruthy()
    expect(screen.getByText('Agent 正在控制')).toBeTruthy()
    expect(screen.getByRole('button', { name: '接管' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '终止任务' })).toBeTruthy()
  })

  it('用户控制态保留胶囊并显示交还和终止', () => {
    setControlSnapshot({
      userControlledViewIds: ['view-1'],
      sessionIdsByViewId: { 'view-1': ['session-1'] },
    })

    render(<Harness />)

    expect(screen.getByText('你正在控制')).toBeTruthy()
    expect(screen.getByRole('button', { name: '交还给 Agent' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '终止任务' })).toBeTruthy()
  })

  it('接管成功后按 IPC 返回 session 去重注入系统事实', async () => {
    setControlSnapshot({
      lockedViewIds: ['view-1'],
      sessionIdsByViewId: { 'view-1': ['session-1'] },
    })
    mocks.takeOverBrowser.mockResolvedValue({
      success: true,
      sessionIds: ['session-1', 'session-1', 'session-2'],
    })
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: '接管' }))

    await waitFor(() => expect(mocks.takeOverBrowser).toHaveBeenCalledWith('view-1'))
    expect(mocks.injectSystemMessage).toHaveBeenCalledTimes(2)
    expect(mocks.injectSystemMessage).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        role: 'system',
        content: '你接管了浏览器，Agent 已暂停',
        metadata: { system_fact: 'browser_control_taken_over' },
      }),
    )
    expect(screen.getByRole('button', { name: '接管' })).toBeTruthy()
  })

  it.each([
    {
      name: 'released 为空（同 session 仍控制其它 view）',
      releasedSessionIds: [] as string[],
      expected: {
        'session-1': '你已交还此浏览器控制权',
        'session-2': '你已交还此浏览器控制权',
      },
    },
    {
      name: '部分 released',
      releasedSessionIds: ['session-1'],
      expected: {
        'session-1': '你已交还浏览器，Agent 将继续任务',
        'session-2': '你已交还此浏览器控制权',
      },
    },
    {
      name: '全部 released',
      releasedSessionIds: ['session-1', 'session-2'],
      expected: {
        'session-1': '你已交还浏览器，Agent 将继续任务',
        'session-2': '你已交还浏览器，Agent 将继续任务',
      },
    },
  ])('交还成功后按 affected 注入，$name 使用真实恢复文案', async ({
    releasedSessionIds,
    expected,
  }) => {
    setControlSnapshot({
      userControlledViewIds: ['view-1'],
      sessionIdsByViewId: { 'view-1': ['session-1', 'session-2'] },
    })
    mocks.handBackBrowser.mockResolvedValue({
      success: true,
      sessionIds: ['session-1', 'session-2', 'session-2'],
      releasedSessionIds,
    })
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: '交还给 Agent' }))

    await waitFor(() => expect(mocks.handBackBrowser).toHaveBeenCalledWith('view-1'))
    expect(mocks.injectSystemMessage).toHaveBeenCalledTimes(2)
    for (const [sessionId, content] of Object.entries(expected)) {
      expect(mocks.injectSystemMessage).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({
          content,
          metadata: { system_fact: 'browser_control_handed_back' },
        }),
      )
    }
  })

  it('多 holder、未知 holder 和空 holder 呈现真实任务范围', () => {
    setControlSnapshot({
      lockedViewIds: ['view-1'],
      sessionIdsByViewId: { 'view-1': ['session-1', 'missing-session'] },
    })
    const { rerender } = render(<Harness />)

    expect(screen.getByText('Watcha 产品调研')).toBeTruthy()
    expect(screen.getByText('2 个任务')).toBeTruthy()
    expect(screen.getByRole('button', { name: '终止全部任务' })).toBeTruthy()

    mocks.sessions.clear()
    rerender(<Harness />)
    expect(screen.getByText('未知任务')).toBeTruthy()

    setControlSnapshot({
      lockedViewIds: ['view-1'],
      sessionIdsByViewId: { 'view-1': [] },
    })
    rerender(<Harness />)
    expect(screen.getByText('无法定位任务')).toBeTruthy()
    expect((screen.getByRole('button', { name: '终止任务' }) as HTMLButtonElement).disabled)
      .toBe(true)
  })

  it('交互区使用 group，状态使用独立 live region 并由可见文本标记', () => {
    setControlSnapshot({
      lockedViewIds: ['view-1'],
      sessionIdsByViewId: { 'view-1': ['session-1'] },
    })
    render(<Harness />)

    const group = screen.getByRole('group')
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(group.getAttribute('aria-labelledby')).toBe(
      `${screen.getByText('Watcha 产品调研').id} ${status.id}`,
    )
    expect(group.getAttribute('aria-label')).toBeNull()
  })

  it('IPC 返回失败或抛错时 toast、不注入事实且不乐观切换', async () => {
    setControlSnapshot({
      lockedViewIds: ['view-1'],
      sessionIdsByViewId: { 'view-1': ['session-1'] },
    })
    mocks.takeOverBrowser.mockResolvedValueOnce({ success: false, sessionIds: [] })
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: '接管' }))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1))
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: '浏览器控制权切换失败，请重试',
      variant: 'destructive',
    }))
    expect(mocks.injectSystemMessage).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '接管' })).toBeTruthy()

    mocks.takeOverBrowser.mockRejectedValueOnce(new Error('secret transport detail'))
    fireEvent.click(screen.getByRole('button', { name: '接管' }))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(2))
    expect(mocks.toast.mock.calls.flat().join(' ')).not.toContain('secret transport detail')
  })

  it('动作 pending 时禁用全部按钮且不乐观切换', async () => {
    let resolveTakeOver!: (value: { success: boolean; sessionIds: string[] }) => void
    mocks.takeOverBrowser.mockReturnValue(new Promise((resolve) => {
      resolveTakeOver = resolve
    }))
    setControlSnapshot({
      lockedViewIds: ['view-1'],
      sessionIdsByViewId: { 'view-1': ['session-1'] },
    })
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: '接管' }))

    expect((screen.getByRole('button', { name: '接管' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '终止任务' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('你正在控制')).toBeNull()

    await act(async () => {
      resolveTakeOver({ success: true, sessionIds: ['session-1'] })
    })
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '接管' }) as HTMLButtonElement).disabled).toBe(false)
    })
  })

  it('按钮可 Tab 聚焦并用键盘触发', async () => {
    setControlSnapshot({
      lockedViewIds: ['view-1'],
      sessionIdsByViewId: { 'view-1': ['session-1'] },
    })
    render(<Harness />)

    const takeOverButton = screen.getByRole('button', { name: '接管' })
    const stopButton = screen.getByRole('button', { name: '终止任务' })
    expect(takeOverButton.tabIndex).toBe(0)
    expect(stopButton.tabIndex).toBe(0)

    takeOverButton.focus()
    expect(document.activeElement).toBe(takeOverButton)
    fireEvent.click(takeOverButton, { detail: 0 })
    await waitFor(() => expect(mocks.takeOverBrowser).toHaveBeenCalledWith('view-1'))
  })

  it('终止任务按 snapshot holder 去重逐个调用 Composer Stop，单个失败不阻止其它 session', async () => {
    setControlSnapshot({
      userControlledViewIds: ['view-1'],
      sessionIdsByViewId: {
        'view-1': ['session-1', 'session-1', 'session-2'],
      },
    })
    mocks.abortStreamFromComposer.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'session-1') throw new Error('stop failed')
    })
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: '终止全部任务' }))

    await waitFor(() => expect(mocks.abortStreamFromComposer).toHaveBeenCalledTimes(2))
    expect(mocks.abortStreamFromComposer).toHaveBeenCalledWith('session-1')
    expect(mocks.abortStreamFromComposer).toHaveBeenCalledWith('session-2')
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: '部分任务终止失败，请重试',
      variant: 'destructive',
    }))
  })
})
