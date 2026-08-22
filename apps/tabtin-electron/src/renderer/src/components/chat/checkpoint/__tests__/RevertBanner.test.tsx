import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { evictChatStoreSessionData } from '../../../../stores/chat/session/utils/evictSessionData'

function formatTranslation(defaultValue: string | undefined, options?: Record<string, unknown>) {
  return Object.entries(options ?? {}).reduce((text, [key, value]) => {
    return text.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), String(value))
  }, defaultValue ?? '')
}

type MockChatStoreState = {
  currentSessionId: string | null
  sessions: Array<Record<string, unknown>>
  messagesBySessionId: Record<string, Array<Record<string, unknown>>>
  restoringSessionId: string | null
  streamingBySessionId: Record<string, boolean>
  restoreInterruptedBySessionId: Record<string, { status: 'pending' | 'failed' }>
  editResendRevertBySessionId: Record<string, boolean>
  revertBannerCollapsedBySessionId: Record<string, string>
  requestRewindPreview: (sessionId?: string | null) => Promise<void>
  retryFailedResourceRestore: (sessionId?: string | null) => Promise<void>
  unrevertSession: (sessionId?: string | null) => Promise<void>
}

const {
  mockRetryFailedResourceRestore,
  mockUnrevertSession,
  mockChatStoreState,
} = vi.hoisted(() => ({
  mockRetryFailedResourceRestore: vi.fn(async () => {}),
  mockUnrevertSession: vi.fn(async () => {}),
  mockChatStoreState: {
    currentSessionId: 'session-1',
    sessions: [],
    messagesBySessionId: {},
    restoringSessionId: null,
    streamingBySessionId: {},
    restoreInterruptedBySessionId: {},
    editResendRevertBySessionId: {},
    revertBannerCollapsedBySessionId: {},
    requestRewindPreview: vi.fn(async () => {}),
    retryFailedResourceRestore: vi.fn(async () => {}),
    unrevertSession: vi.fn(async () => {}),
  } as MockChatStoreState,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown> & { defaultValue?: string }) => (
      formatTranslation(options?.defaultValue, options) || _key
    ),
  }),
}))

function createUseChatStoreMock() {
  const useChatStore = Object.assign(
    (selector: (state: MockChatStoreState) => unknown) => selector(mockChatStoreState),
    {
      setState: (
        partial: Partial<MockChatStoreState> | ((state: MockChatStoreState) => Partial<MockChatStoreState>),
      ) => {
        const next = typeof partial === 'function' ? partial(mockChatStoreState) : partial
        Object.assign(mockChatStoreState, next)
      },
    },
  )
  return { useChatStore }
}

vi.mock('../../../../stores/chat/useChatStore', createUseChatStoreMock)
vi.mock('@/stores/chat/useChatStore', createUseChatStoreMock)

vi.mock('../../../../stores/chat/execution/sessionRunProjection', () => ({
  useSessionBusy: () => false,
}))
vi.mock('@/stores/chat/execution/sessionRunProjection', () => ({
  useSessionBusy: () => false,
}))

import { RevertBanner } from '../RevertBanner'

describe('RevertBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockChatStoreState.currentSessionId = 'session-1'
    mockChatStoreState.sessions = [{
      id: 'session-1',
      title: 'session',
      status: 'active',
      organization_id: 'organization-1',
      created_at: '2026-04-05T00:00:00.000Z',
      updated_at: '2026-04-05T00:00:00.000Z',
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        target_checkpoint_id: 'cp-1',
        cleanup_status: 'pending_retry',
        can_unrevert: true,
        last_apply_result: 'partial_success',
        partial_success_details: {
          workspace_files: {
            success: false,
            reason: 'daemon_restore_failed',
          },
          resources: {
            restored_count: 1,
            failed_count: 1,
            retryable: [{
              resource_type: 'docs',
              resource_id: 'doc-1',
              action: 'trash',
              restore_to_version_id: null,
            }],
            collab_sync_warnings: [],
          },
        },
        resource_restore_state: null,
        updated_at: '2026-04-05T00:00:00.000Z',
      },
    }]
    mockChatStoreState.messagesBySessionId = {}
    mockChatStoreState.restoringSessionId = null
    mockChatStoreState.streamingBySessionId = {}
    mockChatStoreState.restoreInterruptedBySessionId = {}
    mockChatStoreState.editResendRevertBySessionId = {}
    mockChatStoreState.revertBannerCollapsedBySessionId = {}
    mockChatStoreState.requestRewindPreview = vi.fn(async () => {})
    mockChatStoreState.retryFailedResourceRestore = mockRetryFailedResourceRestore
    mockChatStoreState.unrevertSession = mockUnrevertSession
  })

  it('使用 rollback_state 中持久化的 retryable 结果渲染稳定反馈并允许重试', async () => {
    render(<RevertBanner sessionId="session-1" />)

    expect(screen.getByText('回退已完成，但仍有部分步骤需要处理')).toBeTruthy()
    expect(screen.getByText('优先重试 1 个失败的资源回退；发送新消息后将无法恢复原状。')).toBeTruthy()
    expect(screen.getByText('对话')).toBeTruthy()
    expect(screen.getByText('文件')).toBeTruthy()
    expect(screen.getByText('资源')).toBeTruthy()
    expect(screen.getByText('消息整理')).toBeTruthy()
    expect(screen.getByText('待重试资源 1 个: docs:doc-1')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '知道了' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '重试恢复' }))

    await waitFor(() => {
      expect(mockRetryFailedResourceRestore).toHaveBeenCalledWith('session-1')
    })
  })

  it('简单成功回退点击“知道了”后折叠到底部提示', async () => {
    mockChatStoreState.sessions = [{
      id: 'session-1',
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        target_checkpoint_id: null,
        cleanup_status: 'done',
        can_unrevert: true,
        last_apply_result: 'success',
        partial_success_details: null,
        resource_restore_state: null,
        updated_at: '2026-04-05T01:00:00.000Z',
      },
    }]
    const view = render(<RevertBanner sessionId="session-1" />)

    expect(screen.getByText('已回退到历史版本')).toBeTruthy()
    expect(screen.getByRole('button', { name: '恢复原状' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '知道了' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    view.rerender(<RevertBanner sessionId="session-1" />)

    expect(screen.getByText('已回退到历史版本')).toBeTruthy()
    expect(screen.getByRole('button', { name: '展开' })).toBeTruthy()
    expect(mockUnrevertSession).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '展开' }))
    view.rerender(<RevertBanner sessionId="session-1" />)

    expect(screen.getByRole('button', { name: '知道了' })).toBeTruthy()
  })

  it('#4711 编辑重发产生的回退态不展示回退横幅', async () => {
    mockChatStoreState.sessions = [{
      id: 'session-1',
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        target_checkpoint_id: null,
        cleanup_status: 'done',
        can_unrevert: true,
        last_apply_result: 'success',
        partial_success_details: null,
        resource_restore_state: null,
        updated_at: '2026-04-05T01:00:00.000Z',
      },
    }]
    // 标记该 session 的回退态由「编辑并重发」产生 → 横幅应被抑制
    mockChatStoreState.editResendRevertBySessionId = { 'session-1': true }
    const { container } = render(<RevertBanner sessionId="session-1" />)

    expect(container.firstChild).toBeNull()
    expect(screen.queryByText('已回退到历史版本')).toBeNull()
    expect(screen.queryByRole('button', { name: '恢复原状' })).toBeNull()
  })

  it('复杂成功回退点击“知道了”后折叠到底部提示', async () => {
    mockChatStoreState.sessions = [{
      id: 'session-1',
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        target_checkpoint_id: 'cp-1',
        cleanup_status: 'done',
        can_unrevert: true,
        last_apply_result: 'success',
        partial_success_details: {
          resources: {
            restored_count: 1,
            failed_count: 0,
            retryable: [],
            collab_sync_warnings: [],
          },
        },
        resource_restore_state: [{ resource_type: 'docs', resource_id: 'doc-1', status: 'success' }],
        updated_at: '2026-04-05T01:00:00.000Z',
      },
    }]
    const view = render(<RevertBanner sessionId="session-1" />)

    expect(screen.getByText('已回退到历史版本')).toBeTruthy()
    expect(screen.getByText('资源')).toBeTruthy()
    expect(screen.getByRole('button', { name: '恢复原状' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    view.rerender(<RevertBanner sessionId="session-1" />)

    expect(screen.getByText('已回退到历史版本')).toBeTruthy()
    expect(screen.getByRole('button', { name: '展开' })).toBeTruthy()
    expect(screen.queryByText('资源')).toBeNull()
    expect(mockChatStoreState.sessions[0].rollback_state).toMatchObject({
      revert_active: true,
      updated_at: '2026-04-05T01:00:00.000Z',
    })
    expect(mockUnrevertSession).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '展开' }))
    view.rerender(<RevertBanner sessionId="session-1" />)

    expect(screen.getByText('资源')).toBeTruthy()
    expect(screen.getByRole('button', { name: '知道了' })).toBeTruthy()
  })

  it('消息整理失败的复杂横幅不显示“知道了”按钮', async () => {
    mockChatStoreState.sessions = [{
      id: 'session-1',
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        target_checkpoint_id: 'cp-1',
        cleanup_status: 'failed',
        can_unrevert: true,
        last_apply_result: 'success',
        partial_success_details: {
          resources: {
            restored_count: 1,
            failed_count: 0,
            retryable: [],
            collab_sync_warnings: [],
          },
        },
        resource_restore_state: [{ resource_type: 'docs', resource_id: 'doc-1', status: 'success' }],
        updated_at: '2026-04-05T01:00:00.000Z',
      },
    }]
    render(<RevertBanner sessionId="session-1" />)

    expect(screen.getByText('回退已完成，但仍有部分步骤需要处理')).toBeTruthy()
    expect(screen.getByText('消息整理')).toBeTruthy()
    expect(screen.getByText('处理失败')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '知道了' })).toBeNull()
  })

  it('新的回退版本会重新显示复杂成功提示', async () => {
    mockChatStoreState.revertBannerCollapsedBySessionId = {
      'session-1': '2026-04-05T01:00:00.000Z',
    }
    mockChatStoreState.sessions = [{
      id: 'session-1',
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        target_checkpoint_id: 'cp-1',
        cleanup_status: 'done',
        can_unrevert: false,
        last_apply_result: 'success',
        partial_success_details: {
          resources: {
            restored_count: 1,
            failed_count: 0,
            retryable: [],
            collab_sync_warnings: [],
          },
        },
        resource_restore_state: [{ resource_type: 'docs', resource_id: 'doc-1', status: 'success' }],
        updated_at: '2026-04-05T02:00:00.000Z',
      },
    }]
    render(<RevertBanner sessionId="session-1" />)

    expect(screen.getByText('已回退到历史版本')).toBeTruthy()
    expect(screen.getByRole('button', { name: '知道了' })).toBeTruthy()
    expect((screen.getByRole('button', { name: '恢复原状' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('分屏场景中确认一个 session 不会隐藏另一个 session 的回退提示', async () => {
    mockChatStoreState.sessions = [
      {
        id: 'session-1',
        rollback_state: {
          session_id: 'session-1',
          revert_active: true,
          target_checkpoint_id: 'cp-1',
          cleanup_status: 'done',
          can_unrevert: true,
          last_apply_result: 'success',
          partial_success_details: {
            resources: {
              restored_count: 1,
              failed_count: 0,
              retryable: [],
              collab_sync_warnings: [],
            },
          },
          resource_restore_state: [{ resource_type: 'docs', resource_id: 'doc-1', status: 'success' }],
          updated_at: '2026-04-05T01:00:00.000Z',
        },
      },
      {
        id: 'session-2',
        rollback_state: {
          session_id: 'session-2',
          revert_active: true,
          target_checkpoint_id: 'cp-1',
          cleanup_status: 'done',
          can_unrevert: true,
          last_apply_result: 'success',
          partial_success_details: {
            resources: {
              restored_count: 1,
              failed_count: 0,
              retryable: [],
              collab_sync_warnings: [],
            },
          },
          resource_restore_state: [{ resource_type: 'docs', resource_id: 'doc-2', status: 'success' }],
          updated_at: '2026-04-05T01:00:00.000Z',
        },
      },
    ]
    const view = render(<RevertBanner sessionId="session-1" />)
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    view.rerender(<RevertBanner sessionId="session-1" />)
    expect(screen.getByText('已回退到历史版本')).toBeTruthy()
    expect(screen.getByRole('button', { name: '展开' })).toBeTruthy()
    expect(screen.queryByText('资源')).toBeNull()

    view.rerender(<RevertBanner sessionId="session-2" />)
    expect(screen.getByText('已回退到历史版本')).toBeTruthy()
    expect(screen.getByRole('button', { name: '知道了' })).toBeTruthy()
    expect(screen.getByText('资源')).toBeTruthy()
  })

  it('#4528：target 之后已有真实用户消息（回退后发了新任务）时不显示横幅', async () => {
    // 后端 revert_active 仍为 true（清算滞后 / relay 竞态），但 message 列表里
    // target_message_id 之后已经有了新一轮用户消息 → 回退已消费，横幅撤下。
    mockChatStoreState.sessions = [{
      id: 'session-1',
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        target_message_id: 'msg-target',
        cleanup_status: 'done',
        can_unrevert: true,
        last_apply_result: 'success',
        partial_success_details: null,
        resource_restore_state: null,
        updated_at: '2026-04-05T01:00:00.000Z',
      },
    }]
    mockChatStoreState.messagesBySessionId = {
      'session-1': [
        { id: 'msg-target', role: 'assistant', message_kind: 'llm' },
        { id: 'msg-env', role: 'user', message_kind: 'environment_context' },
        { id: 'msg-new', role: 'user', message_kind: 'llm' },
      ],
    }
    render(<RevertBanner sessionId="session-1" />)

    expect(screen.queryByText('已回退到历史版本')).toBeNull()
    expect(screen.queryByRole('button', { name: '恢复原状' })).toBeNull()
  })

  it('#4528：target 之后仅有 environment_context 注入时仍显示横幅（未发新任务）', async () => {
    mockChatStoreState.sessions = [{
      id: 'session-1',
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        target_message_id: 'msg-target',
        cleanup_status: 'done',
        can_unrevert: true,
        last_apply_result: 'success',
        partial_success_details: null,
        resource_restore_state: null,
        updated_at: '2026-04-05T01:00:00.000Z',
      },
    }]
    mockChatStoreState.messagesBySessionId = {
      'session-1': [
        { id: 'msg-target', role: 'assistant', message_kind: 'llm' },
        { id: 'msg-env', role: 'user', message_kind: 'environment_context' },
      ],
    }
    render(<RevertBanner sessionId="session-1" />)

    expect(screen.getByText('已回退到历史版本')).toBeTruthy()
  })

  it('target 之后仅有 system_prompt_context 注入时仍显示横幅（未发新任务）', async () => {
    mockChatStoreState.sessions = [{
      id: 'session-1',
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        target_message_id: 'msg-target',
        cleanup_status: 'done',
        can_unrevert: true,
        last_apply_result: 'success',
        partial_success_details: null,
        resource_restore_state: null,
        updated_at: '2026-04-05T01:00:00.000Z',
      },
    }]
    mockChatStoreState.messagesBySessionId = {
      'session-1': [
        { id: 'msg-target', role: 'assistant', message_kind: 'llm' },
        { id: 'msg-system', role: 'user', message_kind: 'system_prompt_context' },
      ],
    }
    render(<RevertBanner sessionId="session-1" />)

    expect(screen.getByText('已回退到历史版本')).toBeTruthy()
  })

  it('session eviction 会清理已折叠的回退提示状态', () => {
    const patch = evictChatStoreSessionData({
      revertBannerCollapsedBySessionId: {
        'session-1': '2026-04-05T01:00:00.000Z',
        'session-2': '2026-04-05T02:00:00.000Z',
      },
    }, 'session-1')

    expect(patch.revertBannerCollapsedBySessionId).toEqual({
      'session-2': '2026-04-05T02:00:00.000Z',
    })
  })
})
