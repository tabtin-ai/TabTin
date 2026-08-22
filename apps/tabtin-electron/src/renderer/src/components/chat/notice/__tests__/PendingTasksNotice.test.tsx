/**
 * PendingTasksNotice.test.tsx —— B「pending 任务预告条」组件级显隐 + 接线回归。
 *
 * 覆盖（在纯函数 pendingTasks.test.ts 之外，验证 store 订阅 + IPC pull + 显隐串起来）：
 *   1. phase==='done' 且有子 Agent active → 渲染预告条 + 子 Agent 行；
 *   2. turn 进行中（phase 非 done）即使有 active → 不渲染（return null）；
 *   3. phase==='done' 但无 pending（子 Agent 终态 + 无后台命令）→ 不渲染；
 *   4. 后台终端 IPC pull：phase==='done' 时拉取 running 命令并渲染（async）。
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
    i18n: { language: 'zh-CN' },
  }),
}))

import { PendingTasksNotice } from '../PendingTasksNotice'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'
import { INITIAL_RUN_STATE, type RunPhase, type SubagentRun } from '../../../../stores/chat/shared/types'

const SID = 'session-1'
const SID_B = 'session-2'
const SPACE = 'space-1'

function makeRun(overrides: Partial<SubagentRun> & { subagentRunId: string }): SubagentRun {
  return { status: 'running', label: '测试助手', ...overrides } as SubagentRun
}

function seed(opts: { runs?: SubagentRun[]; phase?: RunPhase }): void {
  useChatRuntimeStore.setState({
    subagentRunsBySessionId: opts.runs ? { [SID]: opts.runs } : {},
    runStateBySessionId: { [SID]: { ...INITIAL_RUN_STATE, phase: opts.phase ?? 'done' } },
  })
}

beforeEach(() => {
  useChatRuntimeStore.setState({ subagentRunsBySessionId: {}, runStateBySessionId: {} })
  // 默认无 IPC（后台终端为空）—— pending 全来自子 Agent，走同步路径。
  ;(window as unknown as { tabtin?: unknown }).tabtin = undefined
})

afterEach(() => {
  cleanup()
  ;(window as unknown as { tabtin?: unknown }).tabtin = undefined
})

describe('PendingTasksNotice — 显隐', () => {
  it('phase=done 且子 Agent active → 默认折叠，点击后渲染子 Agent 行', () => {
    seed({ runs: [makeRun({ subagentRunId: 'r1', role: '科普撰稿人', status: 'running' })], phase: 'done' })
    const { queryByTestId, getByTestId, getByText } = render(<PendingTasksNotice sessionId={SID} spaceId={SPACE} />)
    expect(queryByTestId('pending-tasks-notice')).not.toBeNull()
    expect(queryByTestId('pending-task-row')).toBeNull()
    expect(getByTestId('pending-tasks-toggle').getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(getByTestId('pending-tasks-toggle'))

    expect(getByTestId('pending-tasks-toggle').getAttribute('aria-expanded')).toBe('true')
    expect(queryByTestId('pending-task-row')).not.toBeNull()
    expect(getByText('科普撰稿人')).toBeTruthy()
  })

  it('展开后的任务列表位于固定开关上方，收起仍点击同一底部锚点', () => {
    seed({ runs: [makeRun({ subagentRunId: 'r1', role: '科普撰稿人', status: 'running' })], phase: 'done' })
    const { getByTestId, queryByTestId } = render(<PendingTasksNotice sessionId={SID} spaceId={SPACE} />)
    const toggle = getByTestId('pending-tasks-toggle')

    fireEvent.click(toggle)

    const taskList = getByTestId('pending-tasks-list')
    expect(taskList.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(getByTestId('pending-tasks-toggle')).toBe(toggle)

    fireEvent.click(toggle)

    expect(queryByTestId('pending-tasks-list')).toBeNull()
    expect(getByTestId('pending-tasks-toggle')).toBe(toggle)
  })

  it('turn 进行中（phase=tool_calls）有 active → 仍渲染（避免短后台竞态）', () => {
    seed({ runs: [makeRun({ subagentRunId: 'r1', status: 'running', role: '助手' })], phase: 'tool_calls' })
    const { queryByTestId, getByTestId, getByText } = render(<PendingTasksNotice sessionId={SID} spaceId={SPACE} />)
    expect(queryByTestId('pending-tasks-notice')).not.toBeNull()
    fireEvent.click(getByTestId('pending-tasks-toggle'))
    expect(getByText('助手')).toBeTruthy()
  })

  it('phase=done 但子 Agent 已终态 + 无后台命令 → 不渲染', () => {
    seed({ runs: [makeRun({ subagentRunId: 'r1', status: 'completed' })], phase: 'done' })
    const { queryByTestId } = render(<PendingTasksNotice sessionId={SID} spaceId={SPACE} />)
    expect(queryByTestId('pending-tasks-notice')).toBeNull()
  })

  it('sessionId 为 null → 不渲染', () => {
    const { queryByTestId } = render(<PendingTasksNotice sessionId={null} spaceId={SPACE} />)
    expect(queryByTestId('pending-tasks-notice')).toBeNull()
  })

  it('不在组件层重复投影子 Agent 状态', () => {
    const reconcile = vi
      .spyOn(useChatRuntimeStore.getState(), 'reconcileSubagentRunsFromArchive')
      .mockResolvedValue(undefined)
    seed({ runs: [makeRun({ subagentRunId: 'r1', status: 'running' })], phase: 'done' })

    render(<PendingTasksNotice sessionId={SID} spaceId={SPACE} />)

    expect(reconcile).not.toHaveBeenCalled()
    reconcile.mockRestore()
  })
})

describe('PendingTasksNotice — 后台终端 IPC pull', () => {
  it('phase=done 时拉取 running 后台命令并渲染', async () => {
    const listRunningBackgroundTasks = vi
      .fn()
      .mockResolvedValue([{ sessionId: 'pty-1', command: 'npm run dev', startedAt: 1 }])
    ;(window as unknown as { tabtin?: unknown }).tabtin = {
      agentEngine: { listRunningBackgroundTasks },
    }
    seed({ phase: 'done' })
    const { findByTestId, findByText, getByTestId } = render(<PendingTasksNotice sessionId={SID} spaceId={SPACE} />)
    fireEvent.click(await findByTestId('pending-tasks-toggle'))
    await findByText('npm run dev')
    expect(getByTestId('pending-tasks-notice')).toBeTruthy()
    // IPC 入参用 renderer 语义 { sessionId, spaceId }。
    expect(listRunningBackgroundTasks).toHaveBeenCalledWith({ sessionId: SID, spaceId: SPACE })
  })

  it('phase 非 done 时也会 pull IPC（短后台任务需在 turn 内可见）', async () => {
    const listRunningBackgroundTasks = vi
      .fn()
      .mockResolvedValue([{ sessionId: 'pty-1', command: 'sleep 30', startedAt: 1 }])
    ;(window as unknown as { tabtin?: unknown }).tabtin = {
      agentEngine: { listRunningBackgroundTasks },
    }
    seed({ phase: 'tool_calls' })
    const { findByTestId, findByText } = render(<PendingTasksNotice sessionId={SID} spaceId={SPACE} />)
    fireEvent.click(await findByTestId('pending-tasks-toggle'))
    await findByText('sleep 30')
    expect(listRunningBackgroundTasks).toHaveBeenCalled()
  })

  it('展开后点击后台命令停止按钮 → 调 pty.agentKill', async () => {
    const listRunningBackgroundTasks = vi
      .fn()
      .mockResolvedValue([{ sessionId: 'pty-1', command: 'sleep 30', startedAt: 1 }])
    const agentKill = vi.fn().mockResolvedValue({ success: true })
    ;(window as unknown as { tabtin?: unknown }).tabtin = {
      agentEngine: { listRunningBackgroundTasks },
      pty: { agentKill },
    }
    seed({ phase: 'done' })
    const { findByTestId, findByText, findByLabelText, queryByTestId } = render(<PendingTasksNotice sessionId={SID} spaceId={SPACE} />)
    fireEvent.click(await findByTestId('pending-tasks-toggle'))
    await findByText('sleep 30')

    fireEvent.click(await findByLabelText('停止后台任务'))

    await waitFor(() => {
      expect(agentKill).toHaveBeenCalledWith('pty-1')
    })
    await waitFor(() => {
      expect(queryByTestId('pending-task-row')).toBeNull()
    })
  })

  it('会话 A 切到 B 后不暂存 A 的后台命令，停止按钮不能误停 A 的进程', async () => {
    let resolveSessionB: ((tasks: Array<{ sessionId: string; command: string; startedAt: number }>) => void) | null = null
    const sessionBTasks = new Promise<Array<{ sessionId: string; command: string; startedAt: number }>>((resolve) => {
      resolveSessionB = resolve
    })
    const listRunningBackgroundTasks = vi.fn((input: { sessionId: string }) => {
      if (input.sessionId === SID) {
        return Promise.resolve([{ sessionId: 'pty-a', command: 'sleep 300', startedAt: 1 }])
      }
      return sessionBTasks
    })
    const agentKill = vi.fn().mockResolvedValue({ success: true })
    ;(window as unknown as { tabtin?: unknown }).tabtin = {
      agentEngine: { listRunningBackgroundTasks },
      pty: { agentKill },
    }
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: {},
      runStateBySessionId: {
        [SID]: { ...INITIAL_RUN_STATE, phase: 'done' },
        [SID_B]: { ...INITIAL_RUN_STATE, phase: 'done' },
      },
    })

    const { findByTestId, findByText, queryByTestId, queryByLabelText, rerender } = render(
      <PendingTasksNotice sessionId={SID} spaceId={SPACE} />,
    )
    fireEvent.click(await findByTestId('pending-tasks-toggle'))
    await findByText('sleep 300')

    rerender(<PendingTasksNotice sessionId={SID_B} spaceId={SPACE} />)

    expect(queryByTestId('pending-tasks-notice')).toBeNull()
    expect(queryByLabelText('停止后台任务')).toBeNull()
    expect(agentKill).not.toHaveBeenCalled()

    resolveSessionB?.([])
    await waitFor(() => {
      expect(listRunningBackgroundTasks).toHaveBeenCalledWith({ sessionId: SID_B, spaceId: SPACE })
    })
  })
})
