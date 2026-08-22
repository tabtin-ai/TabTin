import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

function formatTranslation(defaultValue: string | undefined, options?: Record<string, unknown>) {
  return Object.entries(options ?? {}).reduce((text, [key, value]) => {
    return text.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), String(value))
  }, defaultValue ?? '')
}

type MockRollbackState = {
  session_id: string
  revert_active: boolean
  cleanup_status: string
  can_unrevert: boolean
  last_apply_result: 'success' | 'partial_success' | 'failed' | null
  partial_success_details: Record<string, unknown> | null
  resource_restore_state: Array<Record<string, unknown>> | null
  updated_at: string
}

type MockChatStoreState = {
  sessions: Array<{ id: string; rollback_state: MockRollbackState | null }>
  rollbackToCheckpoint: ReturnType<typeof vi.fn>
}

const { mockGetRevertHistory, mockChatStoreState } = vi.hoisted(() => ({
  mockGetRevertHistory: vi.fn(),
  mockChatStoreState: {
    sessions: [],
    rollbackToCheckpoint: vi.fn(),
  } as MockChatStoreState,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown> & { defaultValue?: string }) => (
      formatTranslation(options?.defaultValue, options) || _key
    ),
    i18n: { language: 'zh-CN' },
  }),
}))

vi.mock('../../../../services/chatExtraApi', () => ({
  getRevertHistory: mockGetRevertHistory,
}))

vi.mock('../../../../stores/chat/useChatStore', () => ({
  useChatStore: (selector: (state: MockChatStoreState) => unknown) => selector(mockChatStoreState),
}))

vi.mock('@components/common/ListSkeletons', () => ({
  DetailedRowListSkeleton: () => <div data-testid="history-skeleton" />,
}))

describe('RevertHistorySheet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockChatStoreState.rollbackToCheckpoint = vi.fn()
    mockChatStoreState.sessions = [{
      id: 'session-1',
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        cleanup_status: 'pending_retry',
        can_unrevert: true,
        last_apply_result: 'partial_success',
        partial_success_details: {
          workspace_files: {
            success: false,
            reason: 'daemon_restore_failed',
          },
          resources: {
            restored_count: 0,
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
    mockGetRevertHistory.mockResolvedValue([
      {
        type: 'rollback',
        created_at: '2026-04-05T00:00:00.000Z',
        messages_removed: 3,
        snapshot_hash: 'checkpoint-1',
        apply_result: 'partial_success',
        partial_success_details: {
          workspace_files: {
            success: false,
            reason: 'daemon_restore_failed',
          },
          resources: {
            restored_count: 0,
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
      },
    ])
  })

  it('展示当前回退现状与历史中的稳定分层结果', async () => {
    const { RevertHistorySheet } = await import('../RevertHistorySheet')

    render(<RevertHistorySheet sessionId="session-1" onClose={() => {}} />)

    await waitFor(() => {
      expect(mockGetRevertHistory).toHaveBeenCalledWith('session-1')
    })

    expect(screen.getByText('当前状态')).toBeTruthy()
    expect(screen.getByText('当前仍处于已回退状态，可撤销回退恢复对话（工作区文件不会自动还原）。')).toBeTruthy()
    expect(screen.getByText('仍有 1 个资源可重试回退。')).toBeTruthy()
    expect(screen.getByText('消息整理尚未完成，系统会在下一次对话时自动重试。')).toBeTruthy()
    expect(screen.getByText('文件层恢复失败，需要手动检查工作区状态')).toBeTruthy()
    expect(screen.getByText('建议重试 1 个资源: docs:doc-1')).toBeTruthy()
  })

  it('从 unrevert 历史记录再次执行同一批资源回退', async () => {
    const onClose = vi.fn()
    mockGetRevertHistory.mockResolvedValue([
      {
        type: 'unrevert',
        target_message_id: 'msg-target',
        created_at: '2026-04-05T00:00:00.000Z',
        resource_count: 1,
        reapply_resource_items: [{
          resource_type: 'docs',
          resource_id: '12345678-1234-1234-1234-123456789abc',
          action: 'restore_version',
          restore_to_version_id: 'vh-1',
        }],
        apply_result: 'success',
      },
    ])
    const { RevertHistorySheet } = await import('../RevertHistorySheet')

    render(<RevertHistorySheet sessionId="session-1" onClose={onClose} />)

    const button = await screen.findByText('再次执行这次资源回退')
    fireEvent.click(button)

    await waitFor(() => {
      expect(mockChatStoreState.rollbackToCheckpoint).toHaveBeenCalledWith('msg-target', 'session-1', [{
        resource_type: 'docs',
        resource_id: '12345678-1234-1234-1234-123456789abc',
        resource_name: 'docs:12345678',
        action: 'restore_version',
        action_label: '恢复版本',
        can_restore: true,
        restore_to_version_id: 'vh-1',
        restore_to_version_time: null,
        change_count: 1,
      }])
    })
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled()
    })
  })
})
