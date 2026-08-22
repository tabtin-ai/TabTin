/**
 * @vitest-environment jsdom
 *
 * ModeSwitchProposalCard — Phase 3 F2 修复：approve 路径 auto-continue 断言
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ModeSwitchProposalCard } from './ModeSwitchProposalCard'

const mockExecuteModeSwitch = vi.fn()
const mockSetAgentMode = vi.fn()
const mockUpdateSessionMessages = vi.fn()
const mockSendMessage = vi.fn()

vi.mock('@/services/modeSwitchExecuteApi', () => ({
  executeModeSwitch: (...args: unknown[]) => mockExecuteModeSwitch(...args),
  notifyModeSwitched: vi.fn().mockResolvedValue({ success: true }),
}))

// （第二刀）：mode 切换 approved 后 clearPendingApprovalForSession
// 会走 cancel-hitl IPC 收敛 pending → cancelled 终态。测试 mock 门面避免拉
// 整条 agentService 依赖链（chatApi / IPC streams / WS gateway 等）。
const mockCancelHitlInteraction = vi.fn().mockResolvedValue({ success: true })
vi.mock('@/services/agentService', () => ({
  getSessionController: () => ({
    cancelHitlInteraction: mockCancelHitlInteraction,
  }),
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        messagesBySessionId: { 'sess-1': [] },
      }),
    {
      getState: () => ({
        setAgentMode: mockSetAgentMode,
        updateSessionMessages: mockUpdateSessionMessages,
        sendMessage: mockSendMessage,
        patchMessageById: vi.fn(),
        messagesBySessionId: { 'sess-1': [] },
        pendingApprovalBySessionId: {},
        approvalSubmittingBySessionId: {},
      }),
      setState: vi.fn(),
    },
  ),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => {
      if (key === 'modeSwitchProposal.descriptionToAgent' && opts?.reason) {
        return `${opts.reason} 切换后将允许直接修改文件、执行命令等。`
      }
      if (key === 'modeSwitchProposal.descriptionToPlan' && opts?.reason) {
        return `${opts.reason} 切换后将进入规划模式。`
      }
      const map: Record<string, string> = {
        'modeSwitchProposal.title': `请求切换到 ${opts?.targetMode ?? ''} 模式`,
        'agentMode.agent.name': 'Agent',
        'agentMode.plan.name': '规划',
        'modeSwitchProposal.switchButton': `切换到 ${opts?.targetMode ?? ''}`,
        'modeSwitchProposal.cancelButton': '取消',
        'modeSwitchProposal.continuationPromptToAgent':
          '用户已批准切换到 Agent 模式，请继续之前在 Plan 模式下的工作。',
        'modeSwitchProposal.continuationPromptToPlan':
          '用户已批准切换到 Plan 模式，请先梳理方案。',
      }
      return map[key] ?? key
    },
  }),
}))

describe('ModeSwitchProposalCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExecuteModeSwitch.mockResolvedValue({ success: true, outcome: 'approved' })
    mockSendMessage.mockResolvedValue(undefined)
  })

  it('renders title, reason, and action buttons', () => {
    render(
      <ModeSwitchProposalCard
        metadata={{
          proposal_id: 'prop-1',
          target_mode_id: 'agent',
          from_mode_id: 'plan',
          reason: '需要写代码',
          resolved: null,
        }}
        sessionId="sess-1"
        messageId="msg-1"
      />,
    )
    expect(screen.getByText('请求切换到 Agent 模式')).toBeTruthy()
    expect(screen.getByText(/需要写代码/)).toBeTruthy()
    // ：caption 用 i18n 显示名，不渲染内部 mode id
    expect(screen.getByText('规划 → Agent')).toBeTruthy()
    expect(screen.queryByText('plan → agent')).toBeNull()
    expect(screen.getByTestId('mode-switch-approve')).toBeTruthy()
    expect(screen.getByTestId('mode-switch-cancel')).toBeTruthy()
  })

  it('approve calls IPC and setAgentMode', async () => {
    render(
      <ModeSwitchProposalCard
        metadata={{
          proposal_id: 'prop-1',
          target_mode_id: 'agent',
          from_mode_id: 'plan',
          reason: 'go',
          resolved: null,
        }}
        sessionId="sess-1"
        messageId="msg-1"
      />,
    )
    fireEvent.click(screen.getByTestId('mode-switch-approve'))
    await waitFor(() => {
      expect(mockExecuteModeSwitch).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        proposalId: 'prop-1',
        outcome: 'approved',
      })
      expect(mockSetAgentMode).toHaveBeenCalledWith('agent', { sessionId: 'sess-1' })
    })
  })

  it('renders plan target title when proposing agent→plan', () => {
    render(
      <ModeSwitchProposalCard
        metadata={{
          proposal_id: 'prop-2',
          target_mode_id: 'plan',
          from_mode_id: 'agent',
          reason: '需要先规划',
          resolved: null,
        }}
        sessionId="sess-1"
        messageId="msg-2"
      />,
    )
    expect(screen.getByText('请求切换到 规划 模式')).toBeTruthy()
    expect(screen.getByText(/需要先规划/)).toBeTruthy()
    expect(screen.getByText('切换到 规划')).toBeTruthy()
  })

  it('does not render an approved proposal after the mode has switched', () => {
    const { container } = render(
      <ModeSwitchProposalCard
        metadata={{
          proposal_id: 'prop-approved',
          target_mode_id: 'agent',
          from_mode_id: 'plan',
          reason: '需要写代码',
          resolved: 'approved',
        }}
        sessionId="sess-1"
        messageId="msg-approved"
      />,
    )

    expect(container.innerHTML).toBe('')
  })

  it('approve agent→plan syncs UI mode to plan without sending a continuation message', async () => {
    render(
      <ModeSwitchProposalCard
        metadata={{
          proposal_id: 'prop-2',
          target_mode_id: 'plan',
          from_mode_id: 'agent',
          reason: 'need plan',
          resolved: null,
        }}
        sessionId="sess-1"
        messageId="msg-2"
      />,
    )
    fireEvent.click(screen.getByTestId('mode-switch-approve'))
    await waitFor(() => {
      expect(mockSetAgentMode).toHaveBeenCalledWith('plan', { sessionId: 'sess-1' })
    })
    // ：切换走纯 HITL 路径（主进程 reconfigure + resolve waiter），
    // renderer 不再发任何续聊用户消息。
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  //  核心断言：approve 后**不再**发续聊用户消息（切换由主进程 HITL 完成，
  // Agent 在同一轮内以新模式继续）。
  it('approve does NOT send any continuation user message', async () => {
    render(
      <ModeSwitchProposalCard
        metadata={{
          proposal_id: 'prop-1',
          target_mode_id: 'agent',
          from_mode_id: 'plan',
          reason: 'need writes',
          resolved: null,
        }}
        sessionId="sess-1"
        messageId="msg-1"
      />,
    )
    fireEvent.click(screen.getByTestId('mode-switch-approve'))
    await waitFor(() => {
      expect(mockSetAgentMode).toHaveBeenCalledWith('agent', { sessionId: 'sess-1' })
    })
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  // 边界：cancel 路径不切模式、也不发消息。
  it('cancel does NOT trigger sendMessage (mode unchanged)', async () => {
    mockExecuteModeSwitch.mockResolvedValueOnce({ success: true, outcome: 'cancelled' })
    render(
      <ModeSwitchProposalCard
        metadata={{
          proposal_id: 'prop-1',
          target_mode_id: 'agent',
          from_mode_id: 'plan',
          reason: 'go',
          resolved: null,
        }}
        sessionId="sess-1"
        messageId="msg-1"
      />,
    )
    fireEvent.click(screen.getByTestId('mode-switch-cancel'))
    await waitFor(() => {
      expect(mockExecuteModeSwitch).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        proposalId: 'prop-1',
        outcome: 'cancelled',
      })
    })
    expect(mockSetAgentMode).not.toHaveBeenCalled()
    expect(mockSendMessage).not.toHaveBeenCalled()
  })
})
