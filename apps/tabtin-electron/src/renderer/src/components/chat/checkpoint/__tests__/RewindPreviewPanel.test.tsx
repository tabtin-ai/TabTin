import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_VIEW_OVERLAY_ATTRIBUTE } from '@/utils/native-view-overlays'

function formatTranslation(defaultValue: string | undefined, options?: Record<string, unknown>) {
  return Object.entries(options ?? {}).reduce((text, [key, value]) => {
    return text.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), String(value))
  }, defaultValue ?? '')
}

type MockChatStoreState = {
  messagesBySessionId: Record<string, Array<Record<string, unknown>>>
  sessions: Array<{ id: string; rollback_state: Record<string, unknown> | null }>
  getCheckpointDiff: ReturnType<typeof vi.fn>
}

const {
  mockRollbackPreview,
  mockChatStoreState,
  mockFileHistoryIsAvailable,
  mockFileHistoryGetAffectedPaths,
  mockFileHistoryGetPreview,
  mockFileHistoryGetRewindDiff,
} = vi.hoisted(() => ({
  mockRollbackPreview: vi.fn(),
  mockChatStoreState: {
    messagesBySessionId: { 'session-1': [] },
    sessions: [{ id: 'session-1', rollback_state: null }],
    getCheckpointDiff: vi.fn(),
  } as MockChatStoreState,
  mockFileHistoryIsAvailable: vi.fn(() => false),
  mockFileHistoryGetAffectedPaths: vi.fn(),
  mockFileHistoryGetPreview: vi.fn(),
  mockFileHistoryGetRewindDiff: vi.fn(async () => []),
}))

// useTranslation 必须返回**稳定**的 t / i18n 引用：组件里 fetchPreview 的
// useCallback 依赖 t，若每次渲染都 new 一个 t，会让拉 preview 的 effect 每次
// 渲染都重跑、反复把 preview 置空，preview 永远落不下来（测试卡在 loading）。
vi.mock('react-i18next', () => {
  const t = (_key: string, options?: Record<string, unknown> & { defaultValue?: string }) => (
    formatTranslation(options?.defaultValue, options) || _key
  )
  const translation = { t, i18n: { language: 'zh-CN' } }
  return {
    useTranslation: () => translation,
  }
})

vi.mock('@components/layout/SpaceActivityContext', () => ({
  useSpaceActivity: () => ({ isForeground: true }),
}))

vi.mock('../../../../services/chatExtraApi', () => ({
  rollbackPreview: (...args: unknown[]) => mockRollbackPreview(...args).then((preview: Record<string, unknown>) => ({
    rollback_contract_version: preview.rollback_contract_version ?? 2,
    preview_revision: Object.prototype.hasOwnProperty.call(preview, 'preview_revision')
      ? preview.preview_revision
      : 'preview-default',
    file_preview_revision: Object.prototype.hasOwnProperty.call(preview, 'file_preview_revision')
      ? preview.file_preview_revision
      : 'file-preview-default',
    ...preview,
  })),
}))

vi.mock('../../../../services/fileHistoryIpc', () => ({
  isAvailable: mockFileHistoryIsAvailable,
  getAffectedPaths: mockFileHistoryGetAffectedPaths,
  getPreview: mockFileHistoryGetPreview,
  getRewindDiff: mockFileHistoryGetRewindDiff,
  classifyFileHistoryUnavailableReason: (error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error)
    if (detail.includes('No file-history for thread')) return 'no_file_history'
    if (detail.includes('snapshot not found')) return 'file_snapshot_missing'
    return 'local_file_preview_failed'
  },
  canContinueWithoutFileRestore: (reason: string | null | undefined) => (
    reason === 'no_file_history'
    || reason === 'file_snapshot_missing'
    || reason === 'path_guard_denied'
    || reason === 'unrestorable_files'
  ),
}))

vi.mock('../../../../stores/chat/useChatStore', () => ({
  useChatStore: (selector: (state: MockChatStoreState) => unknown) => selector(mockChatStoreState),
}))

vi.mock('../../../../stores/chat/checkpoint/utils/rollbackResult', () => ({
  getRollbackResourceDetailsFromState: () => ({
    restoredCount: 0,
    failedCount: 0,
    retryableItems: [],
    collabWarnings: [],
  }),
  hasWorkspaceFilesFailure: () => false,
}))

vi.mock('@components/common/ListSkeletons', () => ({
  DetailedRowListSkeleton: () => <div data-testid="rewind-skeleton" />,
  PaneLoadingSkeleton: () => <div data-testid="pane-skeleton" />,
}))

describe('RewindPreviewPanel', () => {
  let RewindPreviewPanel: typeof import('../RewindPreviewPanel').RewindPreviewPanel

  beforeAll(async () => {
    ({ RewindPreviewPanel } = await import('../RewindPreviewPanel'))
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockChatStoreState.messagesBySessionId = { 'session-1': [] }
    mockChatStoreState.sessions = [{ id: 'session-1', rollback_state: null }]
    // 本套件验证 Electron 桌面端：默认本机 file-history IPC 可用；
    // 远端宿主或 IPC 缺失由对应测试显式覆盖。
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryGetPreview.mockImplementation(async (sessionId: string, anchorId: string | null) => {
      if (anchorId === null) {
        return {
          success: true,
          status: 'not_applicable',
          reason: 'no_file_anchor',
          paths: [],
          revision: `v2:${'0'.repeat(64)}`,
          unrestorable: [],
        }
      }
      try {
        const paths = await mockFileHistoryGetAffectedPaths(sessionId, anchorId)
        return {
          success: true,
          status: paths.length > 0 ? 'available' : 'not_applicable',
          reason: paths.length > 0 ? undefined : 'no_file_changes',
          paths,
          revision: `v2:${'a'.repeat(64)}`,
          unrestorable: [],
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const reason = detail.includes('No file-history for thread')
          ? 'no_file_history'
          : detail.includes('snapshot not found')
            ? 'file_snapshot_missing'
            : 'preview_failed'
        return {
          success: false,
          status: 'unavailable',
          reason,
          paths: [],
          revision: `v2:${'b'.repeat(64)}`,
          unrestorable: [],
        }
      }
    })
    mockRollbackPreview.mockResolvedValue({
      target_message_id: 'msg-1',
      target_timestamp: '2026-04-05T12:00:00Z',
      checkpoint_hash: null,
      messages_to_remove: 0,
      messages_preview: [],
      resource_changes: [],
      resource_restore_plan: [],
      resource_preview_status: 'not_applicable',
      unrestorable_items: [],
      no_impact: true,
      degraded_reasons: [],
      impact: {
        files: { available: false, diff_available: false },
        resources: { available: false, change_count: 0, restore_count: 0 },
        messages: { to_remove: 0 },
      },
      effective_checkpoint: null,
    })
  })

  it('no_impact 时展示 no-op 文案并关闭而不触发确认', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <RewindPreviewPanel
        sessionId="session-1"
        targetMessageId="msg-1"
        mode="rollback"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )

    await waitFor(() => {
      expect(mockRollbackPreview).toHaveBeenCalledWith('session-1', 'msg-1', expect.any(AbortSignal))
    })

    expect(
      screen.getByText('当前已在目标状态，本次不会移除消息、恢复文件或资源，也不会改变当前回退状态。'),
    ).toBeTruthy()
    expect(screen.queryByText('将回到：')).toBeNull()
    expect(
      screen.queryByText('此操作将同时回退所有相关资源。如需恢复单个资源，请使用对应模块的版本历史面板。'),
    ).toBeNull()
    expect(screen.queryByText('确认回退')).toBeNull()

    fireEvent.click(screen.getByText('关闭'))

    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('重发入口明确展示将重写的对话，并在没有版本影响时说明文件与资源不变', async () => {
    mockRollbackPreview.mockResolvedValue({
      target_message_id: 'msg-resend',
      target_timestamp: '2026-04-05T12:00:00Z',
      checkpoint_hash: null,
      messages_to_remove: 2,
      messages_preview: [{ id: 'assistant-1', role: 'assistant', content: '不会展示的对话' }],
      resource_changes: [],
      resource_restore_plan: [],
      resource_preview_status: 'not_applicable',
      unrestorable_items: [],
      no_impact: false,
      degraded_reasons: [],
      file_preview_success: true,
      file_preview_status: 'not_applicable',
      impact: {
        files: { available: false, diff_available: false },
        resources: { available: false, change_count: 0, restore_count: 0 },
        messages: { to_remove: 2 },
      },
      effective_checkpoint: null,
    })

    render(
      <RewindPreviewPanel
        sessionId="session-1"
        targetMessageId="msg-resend"
        mode="editAndResend"
        resendIntent="resend"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(await screen.findByText('重新发送这条消息？')).toBeTruthy()
    expect(await screen.findByText('将撤销从这条消息开始的 2 条消息，并重新生成后续对话。')).toBeTruthy()
    expect(screen.getByText('未发现需要恢复的工作区文件版本，文件不会变更。')).toBeTruthy()
    expect(screen.getByText('未发现需要恢复的文档、表格等资源，资源不会变更。')).toBeTruthy()
    expect(screen.queryByText('Agent 改过的文件、文档和表格也会被回退。')).toBeNull()
    expect(screen.getByRole('button', { name: '重新发送' })).toBeTruthy()
    expect(screen.queryByText('编辑并重新发送')).toBeNull()
    expect(screen.queryByText('不会展示的对话')).toBeNull()
    expect(screen.queryByText('影响范围')).toBeNull()
  })

  it('编辑入口使用编辑后内容重发文案', async () => {
    mockRollbackPreview.mockResolvedValue({
      target_message_id: 'msg-edit',
      target_timestamp: '2026-04-05T12:00:00Z',
      checkpoint_hash: null,
      messages_to_remove: 1,
      messages_preview: [],
      resource_changes: [],
      resource_restore_plan: [],
      resource_preview_status: 'not_applicable',
      unrestorable_items: [],
      no_impact: false,
      degraded_reasons: [],
      file_preview_success: true,
      file_preview_status: 'not_applicable',
      impact: {
        files: { available: false, diff_available: false },
        resources: { available: false, change_count: 0, restore_count: 0 },
        messages: { to_remove: 1 },
      },
      effective_checkpoint: null,
    })

    render(
      <RewindPreviewPanel
        sessionId="session-1"
        targetMessageId="msg-edit"
        mode="editAndResend"
        resendIntent="edit"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(await screen.findByText('用编辑后的内容重新发送？')).toBeTruthy()
    expect(await screen.findByText('将撤销从这条消息开始的 1 条消息，并重新生成后续对话。')).toBeTruthy()
    expect(screen.getByText('未发现需要恢复的工作区文件版本，文件不会变更。')).toBeTruthy()
    expect(screen.getByText('未发现需要恢复的文档、表格等资源，资源不会变更。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '确认并重新发送' })).toBeTruthy()
    expect(screen.queryByText('影响范围')).toBeNull()
  })

  it('展示 checkpoint 语义摘要与降级原因', async () => {
    mockRollbackPreview.mockResolvedValue({
      target_message_id: 'msg-2',
      target_timestamp: '2026-04-05T12:00:00Z',
      checkpoint_hash: 'hash-1',
      messages_to_remove: 2,
      messages_preview: [],
      resource_changes: [],
      resource_restore_plan: [],
      unrestorable_items: [],
      no_impact: false,
      degraded_reasons: ['missing_resource_snapshot'],
      impact: {
        files: { available: true, diff_available: true },
        resources: { available: false, change_count: 0, restore_count: 0 },
        messages: { to_remove: 2 },
      },
      effective_checkpoint: {
        checkpoint_id: 'msg-2',
        session_id: 'session-1',
        anchor_type: 'assistant_turn',
        status: 'degraded',
        capability_scope: {
          message_preview: true,
          file_diff: true,
          file_restore: true,
          resource_restore: false,
          unrevert: true,
        },
        degraded_reasons: ['missing_resource_snapshot'],
      },
    })

    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <RewindPreviewPanel
        sessionId="session-1"
        targetMessageId="msg-2"
        mode="rollback"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )

    await waitFor(() => {
      expect(screen.getAllByText('可以回退对话和文件，但不能自动恢复文档、表格等资源。').length).toBeGreaterThan(0)
    })

    expect(screen.getAllByText('可以回退对话和文件，但不能自动恢复文档、表格等资源。').length).toBeGreaterThan(0)
    expect(screen.queryByText('将移除 2 条消息')).toBeNull()
    expect(screen.getByText('此操作将回退对话消息，并恢复相关工作区文件。')).toBeTruthy()
    expect(screen.getByText('在发送新消息之前，可以点击「恢复原状」撤销本次回退')).toBeTruthy()
    expect(screen.queryByText('文件将恢复到检查点状态')).toBeNull()
    expect(screen.queryByText('将自动恢复：Agent 通过文件工具改过的文件，以及终端命令改过或删过、且已备份的工作区文件。')).toBeNull()
    expect(screen.queryByText('通常不会自动回退：你手动编辑的文件、终端新建的文件，以及工作区过大或命令在后台运行导致备份不完整时可能漏掉的改动。')).toBeNull()
  })

  it('编辑重发加载预览时也保持轻量提示，不闪现完整影响面板', () => {
    mockRollbackPreview.mockReturnValue(new Promise(() => {}))

    const { unmount } = render(
      <RewindPreviewPanel
        sessionId="session-1"
        targetMessageId="msg-loading"
        mode="editAndResend"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByText('重新发送这条消息？')).toBeTruthy()
    expect(screen.getByText('请稍候…')).toBeTruthy()
    expect(screen.queryByText('编辑此消息 — 影响范围')).toBeNull()
    expect(screen.queryByText('重新发送 — 影响范围')).toBeNull()

    unmount()
  })

  it('重发存在不可恢复资源时展示影响，并提供显式仅重写对话动作', async () => {
    const resourceRestorePlan = [
      {
        resource_type: 'docs',
        resource_id: 'internal-doc-id',
        resource_name: '内部文档',
        action: 'restore_version' as const,
        action_label: '无历史版本可恢复',
        can_restore: false,
        change_count: 1,
      },
    ]
    mockRollbackPreview.mockResolvedValue({
      target_message_id: 'msg-edit',
      target_timestamp: '2026-04-05T12:00:00Z',
      checkpoint_hash: 'hash-edit',
      messages_to_remove: 2,
      messages_preview: [
        { id: 'assistant-1', role: 'assistant', content: '不应出现在轻量确认里的回复内容' },
      ],
      resource_changes: [
        {
          resource_type: 'docs',
          resource_id: 'internal-doc-id',
          resource_name: '内部文档',
          change_type: 'update',
          summary: '更新文档',
          agent_run_id: 'run-1',
        },
      ],
      resource_restore_plan: resourceRestorePlan,
      resource_preview_status: 'available',
      unrestorable_items: ['内部文档没有可恢复版本'],
      no_impact: false,
      degraded_reasons: ['missing_resource_snapshot'],
      impact: {
        files: { available: true, diff_available: true },
        resources: { available: true, change_count: 1, restore_count: 0 },
        messages: { to_remove: 2 },
      },
      effective_checkpoint: {
        checkpoint_id: 'msg-edit',
        session_id: 'session-1',
        anchor_type: 'assistant_turn',
        status: 'degraded',
        capability_scope: {
          message_preview: true,
          file_diff: true,
          file_restore: true,
          resource_restore: false,
          unrevert: true,
        },
        degraded_reasons: ['missing_resource_snapshot'],
      },
    })

    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <RewindPreviewPanel
        sessionId="session-1"
        targetMessageId="msg-edit"
        mode="editAndResend"
        resendIntent="resend"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('重新发送这条消息？')).toBeTruthy()
    })

    expect(await screen.findByText('将撤销从这条消息开始的 2 条消息，并重新生成后续对话。')).toBeTruthy()
    expect(screen.getByText('内部文档')).toBeTruthy()
    expect(screen.getByText('无历史版本可恢复')).toBeTruthy()
    expect(screen.getByText('1 个资源没有可恢复版本；继续后它们将保持当前状态。')).toBeTruthy()
    expect(screen.queryByText('不应出现在轻量确认里的回复内容')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '仅重写对话并重新发送' }))

    expect(onConfirm).toHaveBeenCalledWith({
      resourceRestorePlan: [expect.objectContaining({
        resource_type: 'docs',
        resource_id: 'internal-doc-id',
        action: 'skip',
        can_restore: false,
      })],
      approvedUnavailableFileReason: undefined,
      contract: expect.objectContaining({
        version: 2,
        previewRevision: 'preview-default',
        filePreviewRevision: expect.stringMatching(/^v2:/),
      }),
    })
  })

  it('文件影响预览失败时解释风险并禁止继续重发', async () => {
    mockRollbackPreview.mockResolvedValue({
      target_message_id: 'msg-file-preview-failed',
      target_timestamp: '2026-04-05T12:00:00Z',
      checkpoint_hash: null,
      messages_to_remove: 2,
      messages_preview: [],
      resource_changes: [],
      resource_restore_plan: [],
      resource_preview_status: 'not_applicable',
      unrestorable_items: [],
      no_impact: false,
      degraded_reasons: [],
      file_restore_host: 'daemon',
      file_preview_success: false,
      file_preview_status: 'unavailable',
      file_preview_reason: 'device_offline',
      impact: {
        files: { available: false, diff_available: false },
        resources: { available: false, change_count: 0, restore_count: 0 },
        messages: { to_remove: 2 },
      },
      effective_checkpoint: null,
    })

    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <RewindPreviewPanel
        sessionId="session-1"
        targetMessageId="msg-file-preview-failed"
        mode="editAndResend"
        resendIntent="edit"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )

    expect(await screen.findByText('控制工作区文件的设备当前离线，无法确认文件版本。')).toBeTruthy()
    expect(screen.getByText('无法确认工作区文件会回到哪个版本。为避免文件与对话不一致，请重新检查或取消。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重新检查' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '确认并重新发送' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '重新检查' }))
    await waitFor(() => expect(mockRollbackPreview).toHaveBeenCalledTimes(2))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('资源预览未完成时禁止继续重发', async () => {
    mockRollbackPreview.mockResolvedValue({
      target_message_id: 'msg-resource-preview-failed',
      target_timestamp: '2026-04-05T12:00:00Z',
      checkpoint_hash: null,
      messages_to_remove: 2,
      messages_preview: [],
      resource_changes: [],
      resource_restore_plan: [],
      resource_preview_status: 'unavailable',
      resource_preview_reason: 'resource_change_query_failed',
      unrestorable_items: [],
      no_impact: false,
      degraded_reasons: [],
      file_preview_success: true,
      file_preview_status: 'not_applicable',
      impact: {
        files: { available: false, diff_available: false },
        resources: { available: false, change_count: 0, restore_count: 0 },
        messages: { to_remove: 2 },
      },
      effective_checkpoint: null,
    })

    const onConfirm = vi.fn()
    render(
      <RewindPreviewPanel
        sessionId="session-1"
        targetMessageId="msg-resource-preview-failed"
        mode="editAndResend"
        resendIntent="edit"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    )

    expect(await screen.findByText(/resource_change_query_failed/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('本地宿主有文件锚点但 IPC 不可用时禁止把占位状态当成无文件影响', async () => {
    mockChatStoreState.messagesBySessionId = {
      'session-1': [
        { id: 'msg-local-ipc-unavailable', role: 'user', agent_run_id: undefined },
        { id: 'assistant-local', role: 'assistant', agent_run_id: 'run-local' },
      ],
    }
    mockFileHistoryIsAvailable.mockReturnValue(false)
    mockRollbackPreview.mockResolvedValue({
      target_message_id: 'msg-local-ipc-unavailable',
      target_timestamp: '2026-04-05T12:00:00Z',
      checkpoint_hash: null,
      messages_to_remove: 2,
      messages_preview: [],
      resource_changes: [],
      resource_restore_plan: [],
      resource_preview_status: 'not_applicable',
      unrestorable_items: [],
      no_impact: false,
      degraded_reasons: [],
      file_restore_host: 'local',
      file_preview_success: true,
      file_preview_status: 'not_applicable',
      impact: {
        files: { available: false, diff_available: false },
        resources: { available: false, change_count: 0, restore_count: 0 },
        messages: { to_remove: 2 },
      },
      effective_checkpoint: null,
    })

    render(
      <RewindPreviewPanel
        sessionId="session-1"
        targetMessageId="msg-local-ipc-unavailable"
        mode="editAndResend"
        resendIntent="edit"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(await screen.findByText('当前客户端无法读取本机文件版本记录。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重新检查' })).toBeTruthy()
    expect(screen.queryByText('未发现需要恢复的工作区文件版本，文件不会变更。')).toBeNull()
    expect(mockFileHistoryGetAffectedPaths).not.toHaveBeenCalled()
  })

  it('服务端文件锚点与本地消息缓存不一致时仍按权威计划编辑重发', async () => {
    mockRollbackPreview.mockResolvedValue({
      target_message_id: 'u2',
      target_timestamp: '2026-04-05T12:00:00Z',
      checkpoint_hash: null,
      rewind_anchor_id: 'run-server',
      file_restore_host: 'local',
      file_preview_success: true,
      file_preview_status: 'available',
      affected_paths: ['/ws/a.txt'],
      messages_to_remove: 2,
      messages_preview: [],
      resource_changes: [],
      resource_restore_plan: [],
      resource_preview_status: 'not_applicable',
      unrestorable_items: [],
      no_impact: false,
      degraded_reasons: [],
      impact: {
        files: { available: true, diff_available: true },
        resources: { available: false, change_count: 0, restore_count: 0 },
        messages: { to_remove: 2 },
      },
      effective_checkpoint: null,
    })
    mockChatStoreState.messagesBySessionId = {
      'session-1': [
        { id: 'u2', role: 'user', agent_run_id: undefined },
        { id: 'a2', role: 'assistant', agent_run_id: 'run-local' },
      ],
    }
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryGetAffectedPaths.mockResolvedValue(['/ws/local.txt'])
    const onConfirm = vi.fn()

    render(
      <RewindPreviewPanel
        sessionId="session-1"
        targetMessageId="u2"
        mode="editAndResend"
        resendIntent="edit"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    )

    expect(await screen.findByText('将把 1 个工作区文件恢复到这轮 Agent 工作开始前的版本。')).toBeTruthy()
    expect(mockFileHistoryGetAffectedPaths).toHaveBeenCalledWith('session-1', 'run-server')

    fireEvent.click(screen.getByRole('button', { name: '确认并重新发送' }))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      contract: expect.objectContaining({
        fileAnchor: { id: 'run-server', source: 'preview' },
      }),
    }))
  })

  it('只有文件预览返回受影响路径时才承诺恢复工作区文件', async () => {
    mockRollbackPreview.mockResolvedValue({
      target_message_id: 'msg-file-impact',
      target_timestamp: '2026-04-05T12:00:00Z',
      checkpoint_hash: null,
      messages_to_remove: 2,
      messages_preview: [],
      resource_changes: [],
      resource_restore_plan: [],
      resource_preview_status: 'not_applicable',
      unrestorable_items: [],
      no_impact: false,
      degraded_reasons: [],
      file_restore_host: 'daemon',
      file_preview_success: true,
      file_preview_status: 'available',
      affected_paths: ['/workspace/report.md'],
      impact: {
        files: { available: false, diff_available: false },
        resources: { available: false, change_count: 0, restore_count: 0 },
        messages: { to_remove: 2 },
      },
      effective_checkpoint: null,
    })

    render(
      <RewindPreviewPanel
        sessionId="session-1"
        targetMessageId="msg-file-impact"
        mode="editAndResend"
        resendIntent="edit"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(await screen.findByText('将把 1 个工作区文件恢复到这轮 Agent 工作开始前的版本。')).toBeTruthy()
    expect(screen.queryByText('未发现需要恢复的工作区文件版本，文件不会变更。')).toBeNull()
    expect(screen.getByRole('button', { name: '确认并重新发送' })).toBeTruthy()
  })

  it('资源预览返回可恢复版本时展示名称和目标版本', async () => {
    const resourceRestorePlan = [{
      resource_type: 'docs',
      resource_id: 'doc-1',
      resource_name: '产品方案',
      action: 'restore_version' as const,
      action_label: '恢复到 13:20 的版本',
      can_restore: true,
      restore_to_version_id: 'vh-1',
      restore_to_version_time: '2026-04-05T13:20:00Z',
      change_count: 1,
    }]
    mockRollbackPreview.mockResolvedValue({
      target_message_id: 'msg-resource-impact',
      target_timestamp: '2026-04-05T12:00:00Z',
      preview_revision: 'preview-revision-1',
      checkpoint_hash: null,
      messages_to_remove: 2,
      messages_preview: [],
      resource_changes: [{
        resource_type: 'docs',
        resource_id: 'doc-1',
        resource_name: '产品方案',
        change_type: 'update',
        summary: '更新文档',
        agent_run_id: 'run-1',
      }],
      resource_restore_plan: resourceRestorePlan,
      resource_preview_status: 'available',
      unrestorable_items: [],
      no_impact: false,
      degraded_reasons: [],
      file_preview_success: true,
      file_preview_status: 'not_applicable',
      impact: {
        files: { available: false, diff_available: false },
        resources: { available: true, change_count: 1, restore_count: 1 },
        messages: { to_remove: 2 },
      },
      effective_checkpoint: null,
    })
    const onConfirm = vi.fn()

    render(
      <RewindPreviewPanel
        sessionId="session-1"
        targetMessageId="msg-resource-impact"
        mode="editAndResend"
        resendIntent="edit"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    )

    expect(await screen.findByText('产品方案')).toBeTruthy()
    expect(screen.getByText('恢复到 13:20 的版本')).toBeTruthy()
    expect(screen.getByText(/将恢复到 .* 的版本/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认并重新发送' }))
    expect(onConfirm).toHaveBeenCalledWith({
      resourceRestorePlan,
      approvedUnavailableFileReason: undefined,
      contract: expect.objectContaining({
        version: 2,
        previewRevision: 'preview-revision-1',
        filePreviewRevision: expect.stringMatching(/^v2:/),
      }),
    })
  })

  it('无有效文件版本点但资源仍可恢复时，展示资源回退计划', async () => {
    mockRollbackPreview.mockResolvedValue({
      target_message_id: 'msg-3',
      target_timestamp: '2026-04-05T12:00:00Z',
      checkpoint_hash: null,
      messages_to_remove: 2,
      messages_preview: [],
      resource_changes: [
        {
          resource_type: 'docs',
          resource_id: 'doc-1',
          resource_name: 'Roadmap',
          change_type: 'update',
          summary: '更新文档',
          agent_run_id: 'run-1',
        },
      ],
      resource_restore_plan: [
        {
          resource_type: 'docs',
          resource_id: 'doc-1',
          resource_name: 'Roadmap',
          action: 'restore_version',
          action_label: '恢复到版本 v1',
          can_restore: true,
          restore_to_version_id: 'vh-1',
          restore_to_version_time: '2026-04-05T11:55:00Z',
          change_count: 1,
        },
      ],
      unrestorable_items: [],
      no_impact: false,
      degraded_reasons: ['missing_effective_checkpoint'],
      impact: {
        files: { available: false, diff_available: false },
        resources: { available: true, change_count: 1, restore_count: 1 },
        messages: { to_remove: 2 },
      },
      effective_checkpoint: null,
    })

    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <RewindPreviewPanel
        sessionId="session-1"
        targetMessageId="msg-3"
        mode="rollback"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('可以回退对话并恢复可用资源，但不能恢复工作区文件。')).toBeTruthy()
    })

    expect(screen.getByText('可以回退对话并恢复可用资源，但不能恢复工作区文件。')).toBeTruthy()
    expect(screen.getByText('1 个资源将被回退')).toBeTruthy()
    expect(screen.getByText('Roadmap')).toBeTruthy()
    expect(screen.getByText('恢复到版本 v1')).toBeTruthy()
  })

  // ── Bug 2：per-file 本地能力覆盖后端旧 shadow-git checkpoint_hash 文件误报 ──

  it('Electron 本地宿主 per-file 有备份时，简要说明消息与文件回退并消除"不能恢复文件"误报', async () => {
    // 后端（基于旧 shadow-git）认为无文件可恢复：checkpoint_hash=null + missing_effective_checkpoint。
    mockRollbackPreview.mockResolvedValue({
      target_message_id: 'u2',
      target_timestamp: '2026-04-05T12:00:00Z',
      checkpoint_hash: null,
      messages_to_remove: 2,
      messages_preview: [],
      resource_changes: [],
      resource_restore_plan: [],
      resource_preview_status: 'not_applicable',
      unrestorable_items: [],
      no_impact: false,
      degraded_reasons: ['missing_effective_checkpoint'],
      impact: {
        files: { available: false, diff_available: false },
        resources: { available: false, change_count: 0, restore_count: 0 },
        messages: { to_remove: 2 },
      },
      effective_checkpoint: null,
    })

    // per-file 本地宿主：thread 在本机有账本，回退该轮会恢复两个文件。
    mockChatStoreState.messagesBySessionId = {
      'session-1': [
        { id: 'u1', role: 'user', agent_run_id: undefined },
        { id: 'a1', role: 'assistant', agent_run_id: 'run-a' },
        { id: 'u2', role: 'user', agent_run_id: undefined },
        { id: 'a2', role: 'assistant', agent_run_id: 'run-b' },
      ],
    }
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryGetAffectedPaths.mockResolvedValue(['/ws/a.txt', '/ws/b.txt'])

    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <RewindPreviewPanel
        sessionId="session-1"
        targetMessageId="u2"
        mode="rollback"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )

    // 锚点 = 目标 user(u2) 之后第一条 assistant(a2) 的 agent_run_id=run-b（§3.9）。
    await waitFor(() => {
      expect(mockFileHistoryGetAffectedPaths).toHaveBeenCalledWith('session-1', 'run-b')
    })

    // per-file 本地权威：简要说明消息与文件会回退，不再展开文件清单。
    await waitFor(() => {
      expect(screen.getByText('此操作将回退对话消息，并恢复相关工作区文件。')).toBeTruthy()
    })
    expect(screen.queryByText('将恢复 2 个文件')).toBeNull()
    expect(screen.queryByText('/ws/a.txt')).toBeNull()
    expect(screen.queryByText('/ws/b.txt')).toBeNull()
    expect(screen.queryByText('将自动恢复：Agent 通过文件工具改过的文件，以及终端命令改过或删过、且已备份的工作区文件。')).toBeNull()

    // 关键：不再出现后端旧能力的"不能恢复工作区文件"误报。
    expect(screen.queryByText('可以回退对话并恢复可用资源，但不能恢复工作区文件。')).toBeNull()
    expect(screen.queryByText('这次只能回退对话，不能恢复工作区文件或文档、表格等资源。')).toBeNull()
  })

  it('Daemon 宿主（本地无该 thread 账本，getAffectedPaths 抛错）回退到后端能力判定', async () => {
    mockRollbackPreview.mockResolvedValue({
      target_message_id: 'u2',
      target_timestamp: '2026-04-05T12:00:00Z',
      checkpoint_hash: null,
      messages_to_remove: 2,
      messages_preview: [],
      resource_changes: [],
      resource_restore_plan: [
        {
          resource_type: 'docs',
          resource_id: 'doc-1',
          resource_name: 'Roadmap',
          action: 'restore_version',
          action_label: '恢复到版本 v1',
          can_restore: true,
          restore_to_version_id: 'vh-1',
          restore_to_version_time: '2026-04-05T11:55:00Z',
          change_count: 1,
        },
      ],
      unrestorable_items: [],
      no_impact: false,
      degraded_reasons: ['missing_effective_checkpoint'],
      impact: {
        files: { available: false, diff_available: false },
        resources: { available: true, change_count: 1, restore_count: 1 },
        messages: { to_remove: 2 },
      },
      effective_checkpoint: null,
    })

    mockChatStoreState.messagesBySessionId = {
      'session-1': [
        { id: 'u1', role: 'user', agent_run_id: undefined },
        { id: 'a1', role: 'assistant', agent_run_id: 'run-a' },
        { id: 'u2', role: 'user', agent_run_id: undefined },
        { id: 'a2', role: 'assistant', agent_run_id: 'run-b' },
      ],
    }
    // fileHistoryIpc 可用但本机无该 thread 账本（典型 Daemon 宿主）→ getAffectedPaths 抛错。
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryGetAffectedPaths.mockRejectedValue(new Error('No file-history for thread'))

    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <RewindPreviewPanel
        sessionId="session-1"
        targetMessageId="u2"
        mode="rollback"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )

    await waitFor(() => {
      expect(mockFileHistoryGetAffectedPaths).toHaveBeenCalledWith('session-1', 'run-b')
    })

    // 本地探测失败 → 回退到后端能力：仍展示资源回退计划 + 后端的"不能恢复文件"语义。
    await waitFor(() => {
      expect(screen.getByText('可以回退对话并恢复可用资源，但不能恢复工作区文件。')).toBeTruthy()
    })
    expect(screen.getByText('1 个资源将被回退')).toBeTruthy()
    // 不会冒出 per-file 的"将恢复 N 个文件"（本地没账本）。
    expect(screen.queryByText(/将恢复 \d+ 个文件/)).toBeNull()
  })

  it('存在轮次锚点但当前设备无 file-history 账本时，只在用户明确接受后放行', async () => {
    mockRollbackPreview.mockResolvedValue({
      target_message_id: 'u2',
      target_timestamp: '2026-04-05T12:00:00Z',
      checkpoint_hash: null,
      messages_to_remove: 2,
      messages_preview: [],
      resource_changes: [],
      resource_restore_plan: [],
      unrestorable_items: [],
      no_impact: false,
      degraded_reasons: [],
      file_restore_host: 'local',
      resource_preview_status: 'not_applicable',
      impact: {
        files: { available: false, diff_available: false },
        resources: { available: false, change_count: 0, restore_count: 0 },
        messages: { to_remove: 2 },
      },
      effective_checkpoint: null,
    })
    mockChatStoreState.messagesBySessionId = {
      'session-1': [
        { id: 'u2', role: 'user', agent_run_id: undefined },
        { id: 'a2', role: 'assistant', agent_run_id: 'run-b' },
      ],
    }
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryGetAffectedPaths.mockRejectedValue(new Error('No file-history for thread u2'))

    const onConfirm = vi.fn()
    render(
      <RewindPreviewPanel
        sessionId="session-1"
        targetMessageId="u2"
        mode="editAndResend"
        resendIntent="edit"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    )

    expect(await screen.findByText('当前设备没有这轮对话的文件版本记录。')).toBeTruthy()
    expect(screen.getByText('无法确认工作区文件会回到哪个版本。你可以重新检查，或明确选择只重写对话；文件将保持当前状态。')).toBeTruthy()
    expect(screen.queryByText('未发现需要恢复的工作区文件版本，文件不会变更。')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '仅重写对话并重新发送' }))
    expect(onConfirm).toHaveBeenCalledWith({
      resourceRestorePlan: [],
      approvedUnavailableFileReason: 'no_file_history',
      contract: expect.objectContaining({
        version: 2,
        previewRevision: 'preview-default',
        filePreviewRevision: expect.stringMatching(/^v2:/),
        fileAnchor: { id: 'run-b', source: 'legacy_message_cache' },
      }),
    })
  })

  it('本机预览发现不可恢复文件时展示具体路径和稳定原因，不泄露内部错误', async () => {
    mockRollbackPreview.mockResolvedValue({
      target_message_id: 'u-gap',
      target_timestamp: '2026-04-05T12:00:00Z',
      rewind_anchor_id: 'run-gap',
      file_restore_host: 'local',
      file_preview_status: 'unavailable',
      file_preview_reason: 'unrestorable_files',
      messages_to_remove: 2,
      messages_preview: [],
      resource_changes: [],
      resource_restore_plan: [],
      resource_preview_status: 'not_applicable',
      unrestorable_items: [],
      no_impact: false,
      degraded_reasons: [],
      impact: {
        files: { available: false, diff_available: false },
        resources: { available: false, change_count: 0, restore_count: 0 },
        messages: { to_remove: 2 },
      },
      effective_checkpoint: null,
    })
    mockChatStoreState.messagesBySessionId = {
      'session-1': [
        { id: 'u-gap', role: 'user', agent_run_id: undefined },
        { id: 'a-gap', role: 'assistant', agent_run_id: 'run-gap' },
      ],
    }
    mockFileHistoryGetPreview.mockResolvedValue({
      success: false,
      status: 'unavailable',
      reason: 'unrestorable_files',
      paths: [],
      revision: `v2:${'c'.repeat(64)}`,
      unrestorable: [
        { path: 'reports/summary.pdf', reason: 'unsupported', detail: 'internal decoder stack' },
        { path: 'data/source.csv', reason: 'backup_missing', detail: '/private/backup/path' },
      ],
    })

    render(
      <RewindPreviewPanel
        sessionId="session-1"
        targetMessageId="u-gap"
        mode="editAndResend"
        resendIntent="edit"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(await screen.findByText('reports/summary.pdf')).toBeTruthy()
    expect(screen.getByText('data/source.csv')).toBeTruthy()
    expect(screen.getByText(/不支持自动恢复/)).toBeTruthy()
    expect(screen.getByText(/备份已不存在/)).toBeTruthy()
    expect(screen.queryByText(/internal decoder stack|private\/backup\/path/)).toBeNull()
    expect(screen.getByRole('button', { name: '仅重写对话并重新发送' })).toBeTruthy()
  })

  it('shadow-git fallback 时简要说明消息与文件回退，不展开文件 diff', async () => {
    mockRollbackPreview.mockResolvedValue({
      target_message_id: 'msg-shadow',
      target_timestamp: '2026-04-05T12:00:00Z',
      checkpoint_hash: 'hash-shadow',
      messages_to_remove: 1,
      messages_preview: [],
      resource_changes: [],
      resource_restore_plan: [],
      unrestorable_items: [],
      no_impact: false,
      degraded_reasons: [],
      impact: {
        files: { available: true, diff_available: true },
        resources: { available: false, change_count: 0, restore_count: 0 },
        messages: { to_remove: 1 },
      },
      effective_checkpoint: null,
    })
    mockChatStoreState.getCheckpointDiff = vi.fn(async () => [
      { path: '/ws/old.txt', status: 'modified' as const, before: 'a', after: 'b' },
    ])

    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <RewindPreviewPanel
        sessionId="session-1"
        targetMessageId="msg-shadow"
        mode="rollback"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('此操作将回退对话消息，并恢复相关工作区文件。')).toBeTruthy()
    })
    expect(screen.queryByText('以下差异按历史快照估算，可能与实际恢复不一致；实际恢复以文件历史记录为准。')).toBeNull()
    expect(screen.queryByText('/ws/old.txt')).toBeNull()
  })

  it('前台打开时标记 native-view overlay，避免浏览器 WebContentsView 遮挡弹窗', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <RewindPreviewPanel
        sessionId="session-1"
        targetMessageId="msg-1"
        mode="rollback"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )

    await waitFor(() => {
      expect(mockRollbackPreview).toHaveBeenCalled()
    })

    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute(NATIVE_VIEW_OVERLAY_ATTRIBUTE)).toBe('true')
  })
})
