import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequestState, AskUserRequestState, TodoItem } from '../../../../stores/chat/shared/types'
import { useResourcePreviewStore } from '../../preview/useResourcePreviewStore'
import { __resetSendCooldownForTest } from '../../../../stores/chat/execution/sendCooldown'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})

const {
  mockSetAgentMode,
  mockClearAllPresets,
  mockGateway,
  mockSlashSkills,
  mockVoiceStart,
  mockVoiceStop,
  mockVoiceCancel,
  mockOpenAgentSettings,
  mockToastError,
  voiceMockState,
  wsMockState,
  runtimeMockState,
  spaceMockState,
  todoMockState,
} = vi.hoisted(() => ({
  mockSetAgentMode: vi.fn(),
  mockClearAllPresets: vi.fn(),
  mockGateway: {},
  mockSlashSkills: [] as Array<Record<string, unknown>>,
  mockVoiceStart: vi.fn(),
  mockVoiceStop: vi.fn(),
  mockVoiceCancel: vi.fn(),
  mockOpenAgentSettings: vi.fn(),
  mockToastError: vi.fn(),
  voiceMockState: {
    state: 'idle' as 'idle' | 'preparing' | 'recording' | 'error',
  },
  wsMockState: {
    status: 'connected' as 'connected' | 'disconnected' | 'reconnecting' | 'idle',
  },
  //  测试用：通过 pendingPrefill 注入"已上传 ready"的附件，驱动 AttachmentPreview。
  runtimeMockState: {
    // ：会话执行态（入队 gate 改读它）。
    runProjectionBySessionId: {} as Record<string, { busy: boolean; queuedRunIds: string[]; source: string; lastSyncAt: number }>,
    approvalModeBySessionId: {} as Record<string, string>,
    groupRuntimeBySessionId: {} as Record<string, unknown>,
    pendingPrefillBySessionId: {} as Record<string, unknown>,
    pendingInterruptedMessageBySessionId: {} as Record<string, unknown>,
    nextPrefill: null as null | {
      message: string
      attachments: Array<{
        id: string
        filename: string
        mimeType: string
        size: number
        type: 'image' | 'file'
        remoteUrl?: string
        fileId?: string
        previewUrl?: string
      }>
    },
    nextInterruptedMessage: null as null | {
      message: string
    },
  },
  spaceMockState: {
    selectedSpace: { id: 'space-fallback', type: 'chat' } as { id: string; type: string },
    selectedAgent: {
      agent_config: { security: { allow_yolo_mode: false } },
    } as { agent_config?: { security?: { approval_grant?: string; allow_yolo_mode?: boolean } } },
  },
  todoMockState: {
    todos: [] as TodoItem[],
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  OVERLAY_SURFACE_CLASS: 'overlay-surface',
  useOverlayContainer: () => null,
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    error: mockToastError,
  },
}))

vi.mock('@/stores/useWsConnectionStore', () => ({
  useWsConnectionStore: (selector: (state: { status: string }) => unknown) => selector(wsMockState),
}))

vi.mock('@/hooks/useAgentGatewayStatus', () => ({
  useAgentGatewayStatus: () => 'ready',
}))

vi.mock('@/hooks/queries/skills', () => ({
  useSkillsListQuery: () => ({ data: mockSlashSkills }),
  useSkillConfigsQuery: () => ({ data: {} }),
}))

vi.mock('@stores/chat/presentation/todoTimeline', () => ({
  useTodoTimeline: () => ({
    activeTodos: todoMockState.todos,
  }),
  deriveTodoTimeline: () => ({
    activeTodos: todoMockState.todos,
    entries: [],
  }),
}))

vi.mock('@tabtin/agent-modes', () => {
  const AGENT_MODE_NAMES = ['ask', 'agent', 'plan', 'study', 'yolo', 'group'] as const
  const APPROVAL_MODE_NAMES = ['always_ask', 'auto', 'full_access'] as const
  return {
    AGENT_MODE_NAMES,
    SELECTABLE_AGENT_MODES: AGENT_MODE_NAMES,
    isAgentModeName: (value: unknown) => typeof value === 'string' && AGENT_MODE_NAMES.includes(value as typeof AGENT_MODE_NAMES[number]),
    resolveAgentModeName: (value: unknown, fallback = 'agent') =>
      typeof value === 'string' && AGENT_MODE_NAMES.includes(value as typeof AGENT_MODE_NAMES[number])
        ? value
        : fallback,
    APPROVAL_MODE_NAMES,
    isApprovalModeName: (value: unknown) => typeof value === 'string' && APPROVAL_MODE_NAMES.includes(value as typeof APPROVAL_MODE_NAMES[number]),
    resolveApprovalModeName: (value: unknown, fallback = 'always_ask') =>
      typeof value === 'string' && APPROVAL_MODE_NAMES.includes(value as typeof APPROVAL_MODE_NAMES[number])
        ? value
        : fallback,
  }
})

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({
      agentMode: 'agent',
      setAgentMode: mockSetAgentMode,
      getSessionById: () => undefined,
      // ChatInput 订阅 replyTargetBySessionId（ 引用回复）；缺它会让 selector 抛错。
      replyTargetBySessionId: {},
      approvalModeBySessionId: runtimeMockState.approvalModeBySessionId,
      // useLlmSnapshotsForSession 订阅 messagesBySessionId（ debug 面板）。
      messagesBySessionId: {},
      hostPendingSendsBySessionId: {},
    }),
    {
      getState: () => ({
        agentMode: 'agent',
        getSessionById: () => undefined,
        replyTargetBySessionId: {},
        approvalModeBySessionId: runtimeMockState.approvalModeBySessionId,
        clearReplyTarget: vi.fn(),
        messagesBySessionId: {},
        hostPendingSendsBySessionId: {},
        setSessionMessages: vi.fn(),
        // useLlmSnapshotsForSession / useSubagentLlmSnapshots 反查 session 归属时遍历它。
        sessionsBySpaceId: {},
      }),
    },
  ),
}))

vi.mock('@/stores/useChatRuntimeStore', () => ({
  useChatRuntimeStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({
      agentModeBySessionId: {},
      approvalModeBySessionId: runtimeMockState.approvalModeBySessionId,
      groupRuntimeBySessionId: runtimeMockState.groupRuntimeBySessionId,
      pendingPrefillBySessionId: runtimeMockState.pendingPrefillBySessionId,
      pendingInterruptedMessageBySessionId: runtimeMockState.pendingInterruptedMessageBySessionId,
      uploadProgressBySessionId: {},
      todosBySessionId: {},
      //  debug 面板：ChatInput 订阅 snapshots / subagent runs。
      snapshotsBySessionId: {},
      subagentRunsBySessionId: {},
    }),
    {
      getState: () => ({
        agentModeBySessionId: {},
        approvalModeBySessionId: runtimeMockState.approvalModeBySessionId,
        groupRuntimeBySessionId: runtimeMockState.groupRuntimeBySessionId,
        runProjectionBySessionId: runtimeMockState.runProjectionBySessionId,
        uploadProgressBySessionId: {},
        todosBySessionId: {},
        consumePrefillForSession: () => {
          const p = runtimeMockState.nextPrefill
          runtimeMockState.nextPrefill = null
          return p
        },
        consumeInterruptedMessageRecovery: (sessionId: string) => {
          const recovery = runtimeMockState.nextInterruptedMessage
          runtimeMockState.nextInterruptedMessage = null
          delete runtimeMockState.pendingInterruptedMessageBySessionId[sessionId]
          return recovery
        },
        discardInterruptedMessageRecovery: (sessionId: string) => {
          delete runtimeMockState.pendingInterruptedMessageBySessionId[sessionId]
          runtimeMockState.nextInterruptedMessage = null
        },
        loadSnapshotsForSession: vi.fn(),
        abortUpload: vi.fn(),
      }),
      setState: vi.fn(),
    },
  ),
}))

vi.mock('@/stores/useVoiceSettingsStore', () => ({
  useVoiceSettingsStore: Object.assign(
    (selector: (state: {
      voiceShortcut: string
      enabled: boolean
      mergedHotwords: () => never[]
      enableDialogContext: boolean
    }) => unknown) => selector({
      voiceShortcut: 'mod+shift+j',
      enabled: true,
      mergedHotwords: () => [],
      enableDialogContext: false,
    }),
    {
      getState: () => ({
        voiceShortcut: 'mod+shift+j',
        enabled: true,
        mergedHotwords: () => [],
        enableDialogContext: false,
      }),
    },
  ),
  matchesShortcut: () => false,
  formatShortcut: () => 'Ctrl+J',
}))

vi.mock('@/stores/useOrganizationStore', () => ({
  useOrganizationStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({
      selectedOrganization: {
        id: 'organization-1',
        settings: { allow_member_yolo: true },
      },
      getEffectiveOrganizationId: () => 'organization-1',
    }),
    {
      getState: () => ({
        selectedOrganization: {
          id: 'organization-1',
          settings: { allow_member_yolo: true },
        },
        getEffectiveOrganizationId: () => 'organization-1',
      }),
      subscribe: vi.fn(() => () => {}),
    },
  ),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({
      selectedSpace: spaceMockState.selectedSpace,
      selectedAgent: spaceMockState.selectedAgent,
      spaces: spaceMockState.selectedSpace
        ? [spaceMockState.selectedSpace]
        : [],
    }),
    {
      getState: () => ({
        selectedSpace: spaceMockState.selectedSpace,
        selectedAgent: spaceMockState.selectedAgent,
        spaces: spaceMockState.selectedSpace
          ? [spaceMockState.selectedSpace]
          : [],
      }),
    },
  ),
}))

vi.mock('@stores/useAgentSettingsSheetStore', () => ({
  useAgentSettingsSheetStore: (selector: (state: { open: typeof mockOpenAgentSettings }) => unknown) => selector({
    open: mockOpenAgentSettings,
  }),
}))

// 权限入口已改为轻量浮层（ApprovalGrantPopover），不再打开全局抽屉。
// 浮层自身行为（开合 / 图标随审批档变色 / 确认框联动）在
// ApprovalGrantPopover.test.tsx 覆盖；这里 stub 掉只验证 ChatInput 的接线。
vi.mock('../../approval/ApprovalGrantPopover', () => ({
  ApprovalGrantPopover: ({ spaceId, sessionId }: { spaceId: string | null; sessionId: string | null }) => (
    <button
      type="button"
      aria-label="input.permissionSettings"
      data-space-id={spaceId ?? ''}
      data-session-id={sessionId ?? ''}
    />
  ),
}))

vi.mock('@/stores/useComposerPresetStore', () => ({
  useComposerPresetStore: Object.assign(
    (selector: (state: { presetsBySessionId: Record<string, never[]> }) => unknown) => selector({
      presetsBySessionId: {},
    }),
    {
      getState: () => ({
        clearAllPresets: mockClearAllPresets,
        collectSlotAttachments: () => [],
        setFieldError: vi.fn(),
      }),
    },
  ),
}))

vi.mock('@/services/chatApi', () => ({
  getChatClient: () => ({
    getGateway: () => mockGateway,
  }),
}))

vi.mock('@/services/chatClientSingleton', () => ({
  getChatClientInstance: () => null,
}))

// 添加即上传：mock OSS 上传，让附件进 composer 后立刻变 ready（不打真实后端）
vi.mock('@/services/chatAttachmentApi', () => ({
  uploadChatAttachment: vi.fn(async (att: { filename: string; mimeType: string; size: number }) => ({
    file_id: `fid-${att.filename}`,
    file_name: att.filename,
    file_key: `chat/attachments/${att.filename}`,
    file_size: att.size,
    file_type: att.mimeType,
    access_url: `http://127.0.0.1:6060/api/services/oss/local-object?object_key=chat%2F${att.filename}`,
    cdn_url: `http://127.0.0.1:6060/api/services/oss/local-object?object_key=chat%2F${att.filename}`,
  })),
}))

vi.mock('@/hooks/useCentrifugoClient', () => ({
  reconnectCentrifugo: vi.fn(),
}))

vi.mock('../../context/useContextInjection', () => ({
  contextRefsToBlocks: () => [],
}))

vi.mock('../../model/CompactModelSelector', () => ({
  CompactModelSelector: () => null,
}))

vi.mock('../../model/AgentModeSelector', () => ({
  AgentModeSelector: ({ disabled }: { disabled?: boolean }) => (
    <button type="button" data-testid="agent-mode-selector" disabled={Boolean(disabled)} />
  ),
}))

vi.mock('../../billing/TokenUsageRing', () => ({
  TokenUsageRing: () => null,
}))

vi.mock('../../billing/LLMSnapshotPanel', () => ({
  LLMSnapshotPanel: () => null,
}))

vi.mock('../MentionPopover', () => ({
  MentionPopover: () => null,
}))

vi.mock('@components/sidebar/SpaceSwitcherPopover', () => ({
  SpaceSwitcherPopover: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="space-switcher-popover">{children}</div>
  ),
}))

vi.mock('../../context/ContextChip', () => ({
  ContextChipList: () => null,
}))

vi.mock('../../approval/ApprovalPanel', () => ({
  ApprovalPanel: ({
    decisionSurface = 'panel',
  }: {
    decisionSurface?: 'panel' | 'external'
  }) => (
    <div data-testid="approval-panel-decision-surface">
      {decisionSurface}
    </div>
  ),
  isApprovalHighRisk: (action: { decision_reason?: { type?: string } }) => (
    [
      'hardline_confirm',
      'hardline_command',
      'hardline_path',
      'rule_high_risk_allowlist_miss',
      'destructive_in_workspace_ask',
    ].includes(action.decision_reason?.type ?? '')
  ),
}))

vi.mock('../../ask-user/AskUserPanel', () => ({
  AskUserPanel: () => <div data-testid="ask-user-panel" />,
}))

vi.mock('../../voice/ASRStreamClient', () => ({
  ASRStreamClient: { preconnect: vi.fn() },
  buildDialogContext: () => '',
}))

vi.mock('../../voice/extractAppHotwords', () => ({
  extractAppHotwords: () => [],
}))

vi.mock('../../voice/useVoiceRecording', () => ({
  useVoiceRecording: () => ({
    state: voiceMockState.state,
    startRecording: mockVoiceStart,
    stopRecording: mockVoiceStop,
    cancelRecording: mockVoiceCancel,
    audioLevels: [],
    duration: 0,
    errorMessage: null,
    errorKind: null,
  }),
}))

vi.mock('../../voice/VoiceRecordingCapsule', () => ({
  VoiceRecordingCapsule: () => null,
}))

vi.mock('../../composer-presets/ComposerPresetCard', () => ({
  ComposerPresetCardList: () => null,
}))

vi.mock('../../composer-presets/PresetPickerPopover', () => ({
  PresetPickerPopover: () => null,
}))

vi.mock('../../composer-presets/registry/composerPresetRegistry', () => ({
  getComposerPreset: () => null,
  getAllPresets: () => [],
}))

vi.mock('../../../tabcode/utils/hotkeys', () => ({
  HOTKEYS: {
    cycleAgentMode: { key: '.', mod: true, shift: true },
  },
  useHotkey: vi.fn(),
}))

function buildPendingAskUser(blockingPolicy: 'soft' | 'hard'): AskUserRequestState {
  return {
    sessionId: 'session-1',
    threadId: 'chat-session-1',
    interruptId: 'ask-1',
    interactionType: 'ask_user',
    blockingPolicy,
    toolCallId: 'tool-1',
    messageId: 'message-1',
    message: '请补充信息',
  }
}

function buildPendingApproval(
  overrides: Partial<ApprovalRequestState> = {},
): ApprovalRequestState {
  return {
    sessionId: 'session-1',
    threadId: 'chat-session-1',
    batchId: 'batch-1',
    actionRequests: [
      { request_id: 'req-1', tool_call_id: 'call-1', tool_name: 'run_terminal_command' },
    ] as ApprovalRequestState['actionRequests'],
    reviewConfigs: [],
    messageId: 'message-1',
    message: '需要确认',
    ...overrides,
  }
}

describe('ChatInput', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSlashSkills.splice(0, mockSlashSkills.length)
    voiceMockState.state = 'idle'
    wsMockState.status = 'connected'
    spaceMockState.selectedSpace = { id: 'space-fallback', type: 'chat' }
    spaceMockState.selectedAgent = { agent_config: { security: { allow_yolo_mode: false } } }
    todoMockState.todos = []
    for (const k of Object.keys(runtimeMockState.pendingPrefillBySessionId)) {
      delete runtimeMockState.pendingPrefillBySessionId[k]
    }
    for (const k of Object.keys(runtimeMockState.pendingInterruptedMessageBySessionId)) {
      delete runtimeMockState.pendingInterruptedMessageBySessionId[k]
    }
    for (const k of Object.keys(runtimeMockState.runProjectionBySessionId)) {
      delete runtimeMockState.runProjectionBySessionId[k]
    }
    for (const k of Object.keys(runtimeMockState.approvalModeBySessionId)) {
      delete runtimeMockState.approvalModeBySessionId[k]
    }
    for (const k of Object.keys(runtimeMockState.groupRuntimeBySessionId)) {
      delete runtimeMockState.groupRuntimeBySessionId[k]
    }
    runtimeMockState.nextPrefill = null
    runtimeMockState.nextInterruptedMessage = null
    __resetSendCooldownForTest()
    useResourcePreviewStore.getState().close()
  })

  it('权限受限会话可由统一 Composer 隐藏添加与引用入口', async () => {
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={vi.fn()}
        sessionId="shared-session-1"
        showAddMenu={false}
      />,
    )

    expect(screen.queryByLabelText('input.addMenu')).toBeNull()
  })

  it('新任务草稿在底栏展示工作空间并保留权限入口', async () => {
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={vi.fn()}
        spaceId="space-1"
        spaceName="默认工作空间"
        onExecutionSpaceChange={vi.fn()}
        enableAgentPicker
      />,
    )

    expect(screen.getByTestId('chat-input-model-bar')).toBeTruthy()
    expect(screen.getByTestId('space-switcher-popover')).toBeTruthy()
    expect(screen.getByText('默认工作空间')).toBeTruthy()
    expect(screen.getByLabelText('input.permissionSettings')).toBeTruthy()
  })

  it('streaming 时仍可打开工作空间选择器', async () => {
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={vi.fn()}
        spaceId="space-1"
        spaceName="默认工作空间"
        onExecutionSpaceChange={vi.fn()}
        enableAgentPicker
        isStreaming
      />,
    )

    const workspaceButton = screen.getByRole('button', { name: /默认工作空间/ })
    expect(workspaceButton).toBeTruthy()
    expect((workspaceButton as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('space-switcher-popover')).toBeTruthy()
  })

  it('#7481 streaming 时 Agent 选择器不被 isStreaming 锁死', async () => {
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={vi.fn()}
        spaceId="space-1"
        spaceName="默认工作空间"
        canChangeAgent
        isStreaming
      />,
    )

    const agentTrigger = screen.getByTestId('agent-mode-selector') as HTMLButtonElement
    expect(agentTrigger.disabled).toBe(false)
  })

  it('正式任务在底栏只读展示工作空间，不再使用顶部任务设置条', async () => {
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={vi.fn()}
        sessionId="session-1"
        spaceId="space-1"
        spaceName="默认工作空间"
      />,
    )

    expect(screen.queryByLabelText('newTask.setupLabel')).toBeNull()
    expect(screen.queryByTestId('space-switcher-popover')).toBeNull()
    expect(screen.getByText('默认工作空间')).toBeTruthy()
    expect(screen.getByLabelText('input.permissionSettings')).toBeTruthy()
    // ：placeholder 按 session.agent_id 解析名称；surface 不得漏传 sessionId。
    expect(screen.getByRole('textbox').getAttribute('data-session-id')).toBe('session-1')
  })

  it('已有新草稿时保留它，并提供恢复被中断消息的入口', async () => {
    const { ChatInput } = await import('../ChatInput')

    const onSend = vi.fn()
    const { rerender } = render(<ChatInput onSend={onSend} sessionId="session-1" />)

    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textbox, { target: { value: '正在写的下一条消息' } })
    runtimeMockState.pendingInterruptedMessageBySessionId['session-1'] = { pending: true }
    runtimeMockState.nextInterruptedMessage = {
      message: '被中断的原始输入',
    }
    rerender(<ChatInput onSend={onSend} sessionId="session-1" />)

    const restore = await screen.findByRole('button', {
      name: 'input.restoreInterruptedMessage',
    })
    expect(textbox.value).toBe('正在写的下一条消息')

    fireEvent.click(restore)

    expect(textbox.value).toBe('被中断的原始输入')
  })

  it('输入框为空时自动恢复被中断的消息', async () => {
    runtimeMockState.pendingInterruptedMessageBySessionId['session-1'] = { pending: true }
    runtimeMockState.nextInterruptedMessage = {
      message: '自动恢复的原始输入',
    }
    const { ChatInput } = await import('../ChatInput')

    render(<ChatInput onSend={vi.fn()} sessionId="session-1" />)

    await vi.waitFor(() => {
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('自动恢复的原始输入')
    })
  })

  it('soft askUser 下仍允许发送消息', async () => {
    const onSend = vi.fn()
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={onSend}
        pendingAskUser={buildPendingAskUser('soft')}
        sessionId="session-1"
      />,
    )

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '继续往下做' } })
    fireEvent.click(screen.getByLabelText('input.sendTitle'))

    expect(onSend).toHaveBeenCalledWith('继续往下做', undefined, undefined, undefined)
  })

  it('主 Composer 显式标记允许中断后恢复输入', async () => {
    const onSend = vi.fn()
    const { ChatInput } = await import('../ChatInput')
    render(
      <ChatInput
        onSend={onSend}
        sessionId="session-1"
        allowInterruptedEditRecovery
      />,
    )

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '可以中断后编辑' } })
    fireEvent.click(screen.getByLabelText('input.sendTitle'))

    expect(onSend).toHaveBeenCalledWith(
      '可以中断后编辑',
      undefined,
      undefined,
      { allowInterruptedEditRecovery: true },
    )
  })

  it('#9234 hard askUser 不禁用输入，发送直发（不再本地入队）', async () => {
    const onSend = vi.fn()
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={onSend}
        pendingAskUser={buildPendingAskUser('hard')}
        sessionId="session-1"
      />,
    )

    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textbox.disabled).toBe(false)
    fireEvent.change(textbox, { target: { value: '现在先继续' } })
    fireEvent.click(screen.getByLabelText('input.sendTitle'))

    expect(onSend).toHaveBeenCalled()
  })

  it('#9234 pendingApproval 不禁用输入，发送直发（不再本地入队）', async () => {
    const onSend = vi.fn()
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={onSend}
        pendingApproval={buildPendingApproval()}
        sessionId="session-1"
      />,
    )

    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', {
      name: 'approval.attentionDock.addInstruction',
    }))

    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textbox.disabled).toBe(false)
    fireEvent.change(textbox, { target: { value: '审批期间先排队' } })
    fireEvent.click(screen.getByLabelText('input.sendTitle'))

    expect(onSend).toHaveBeenCalled()
  })

  it('Todo 无论是否有审批都使用默认收起的当前任务摘要条', async () => {
    todoMockState.todos = [
      { id: 'todo-1', content: '已完成准备工作', status: 'completed' },
      { id: 'todo-2', content: '创建幻灯片并导出到 /tmp', status: 'in_progress' },
      { id: 'todo-3', content: '发送最终结果', status: 'pending' },
    ]
    const { ChatInput } = await import('../ChatInput')
    const onSend = vi.fn()
    const { rerender } = render(
      <ChatInput onSend={onSend} sessionId="session-1" isStreaming />,
    )

    let todoStrip = screen.getByTestId('todo-progress-strip')
    expect(within(todoStrip).getByText('card.todoCurrent')).toBeTruthy()
    expect(within(todoStrip).queryByText('card.todo', { exact: true })).toBeNull()

    rerender(
      <ChatInput
        onSend={onSend}
        sessionId="session-1"
        isStreaming
        pendingApproval={buildPendingApproval()}
      />,
    )

    expect(screen.getAllByTestId('todo-progress-strip')).toHaveLength(1)
    todoStrip = screen.getByTestId('todo-progress-strip')
    expect(within(todoStrip).getByText('card.todoCurrent')).toBeTruthy()
    expect(within(todoStrip).queryByText('card.todo', { exact: true })).toBeNull()
  })

  it('普通单项审批默认收起 Composer，并可从 Attention Dock 默认记住允许', async () => {
    const onApprovalSubmit = vi.fn()
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={vi.fn()}
        onApprovalSubmit={onApprovalSubmit}
        pendingApproval={buildPendingApproval()}
        sessionId="session-1"
      />,
    )

    const dock = screen.getByTestId('approval-attention-dock')
    expect(dock.className).toContain('@container/approval-dock')
    const dockActions = screen.getByTestId('approval-dock-actions')
    expect(dockActions.className).toContain(
      '@[420px]/approval-dock:w-auto',
    )
    expect(screen.getByTestId('approval-panel-decision-surface').textContent)
      .toBe('external')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByTestId('approval-dock-remember-toggle').getAttribute('aria-pressed'))
      .toBe('true')
    fireEvent.click(screen.getByRole('button', {
      name: 'approval.allow',
    }))

    await waitFor(() => {
      expect(onApprovalSubmit).toHaveBeenCalledWith([expect.objectContaining({
        request_id: 'req-1',
        tool_call_id: 'call-1',
        decision: 'approve',
        scope: 'always',
        decision_kind: 'pattern',
      })])
    })
  })

  it('Attention Dock 取消记住后允许提交 scope=once', async () => {
    const onApprovalSubmit = vi.fn()
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={vi.fn()}
        onApprovalSubmit={onApprovalSubmit}
        pendingApproval={buildPendingApproval({
          approvalSource: 'platform',
          actionRequests: [{
            request_id: 'req-1',
            tool_call_id: 'call-1',
            tool_name: 'browser.open',
            allowed_scopes: ['once', 'thread', 'always'],
          }] as ApprovalRequestState['actionRequests'],
        })}
        sessionId="session-1"
      />,
    )

    fireEvent.click(screen.getByTestId('approval-dock-remember-toggle'))
    fireEvent.click(screen.getByRole('button', { name: 'approval.allow' }))

    expect(onApprovalSubmit).toHaveBeenCalledWith([{
      request_id: 'req-1',
      tool_call_id: 'call-1',
      decision: 'approve',
      scope: 'once',
      rejection_message: undefined,
    }])
  })

  it('Attention Dock 切到对话内记住后允许提交 scope=thread', async () => {
    const onApprovalSubmit = vi.fn()
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={vi.fn()}
        onApprovalSubmit={onApprovalSubmit}
        pendingApproval={buildPendingApproval({
          actionRequests: [{
            request_id: 'req-1',
            tool_call_id: 'call-1',
            tool_name: 'run_terminal_command',
            allowed_scopes: ['once', 'thread', 'always'],
          }] as ApprovalRequestState['actionRequests'],
        })}
        sessionId="session-1"
      />,
    )

    fireEvent.click(screen.getByTestId('approval-dock-remember-scope'))
    fireEvent.click(screen.getByTestId('approval-dock-remember-scope-thread'))
    fireEvent.click(screen.getByRole('button', { name: 'approval.allow' }))

    expect(onApprovalSubmit).toHaveBeenCalledWith([{
      request_id: 'req-1',
      tool_call_id: 'call-1',
      decision: 'approve',
      scope: 'thread',
      rejection_message: undefined,
    }])
  })

  it('审批到达前已有草稿时不隐藏 Composer', async () => {
    runtimeMockState.pendingPrefillBySessionId['session-1'] = { ts: 1 }
    runtimeMockState.nextPrefill = {
      message: '这条草稿还没发',
      attachments: [],
    }
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={vi.fn()}
        pendingApproval={buildPendingApproval()}
        sessionId="session-1"
      />,
    )

    await waitFor(() => {
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value)
        .toBe('这条草稿还没发')
    })
  })

  it('高风险审批不提供快捷允许，强制从详情审阅', async () => {
    const pendingApproval = buildPendingApproval({
      actionRequests: [{
        request_id: 'req-risk',
        tool_call_id: 'call-risk',
        tool_name: 'run_terminal_command',
        decision_reason: { type: 'hardline_confirm' },
      }] as ApprovalRequestState['actionRequests'],
    })
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={vi.fn()}
        onApprovalSubmit={vi.fn()}
        pendingApproval={pendingApproval}
        sessionId="session-1"
      />,
    )

    expect(screen.getByText('approval.attentionDock.highRisk')).toBeTruthy()
    expect(screen.queryByRole('button', {
      name: 'approval.allow',
    })).toBeNull()
  })

  it('批量审批只在详情中决策，Dock 不再显示重复的允许或拒绝', async () => {
    const onApprovalSubmit = vi.fn()
    const pendingApproval = buildPendingApproval({
      actionRequests: [
        {
          request_id: 'req-1',
          tool_call_id: 'call-1',
          tool_name: 'run_terminal_command',
        },
        {
          request_id: 'req-2',
          tool_call_id: 'call-2',
          tool_name: 'write_file',
        },
      ] as ApprovalRequestState['actionRequests'],
    })
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={vi.fn()}
        onApprovalSubmit={onApprovalSubmit}
        pendingApproval={pendingApproval}
        sessionId="session-1"
      />,
    )

    expect(screen.queryByRole('button', {
      name: 'approval.allow',
    })).toBeNull()
    expect(screen.queryByRole('button', { name: 'approval.reject' })).toBeNull()
    expect(screen.getByText('approval.attentionDock.reviewAndDecide')).toBeTruthy()
    expect(screen.getByTestId('approval-panel-decision-surface').textContent)
      .toBe('panel')
    expect(onApprovalSubmit).not.toHaveBeenCalled()
  })

  it('Dock 自己负责到期回收，不依赖详情浮层保持挂载', async () => {
    const onApprovalDismiss = vi.fn()
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={vi.fn()}
        onApprovalDismiss={onApprovalDismiss}
        pendingApproval={buildPendingApproval({
          expiresAt: Date.now() - 1_000,
        })}
        sessionId="session-1"
      />,
    )

    await waitFor(() => {
      expect(onApprovalDismiss).toHaveBeenCalledWith('expired')
    })
    expect(screen.getByText('approval.attentionDock.expired')).toBeTruthy()
  })

  it('非执行 Owner 只看到等待态，Composer 保持可用', async () => {
    const pendingApproval = buildPendingApproval({
      canResolve: false,
      teamSpaceExecution: {
        executionOwnerDisplayName: 'Alice',
      },
    })
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={vi.fn()}
        pendingApproval={pendingApproval}
        sessionId="session-1"
      />,
    )

    expect(screen.getByText('approval.attentionDock.waitingOwner')).toBeTruthy()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false)
    expect(screen.queryByRole('button', {
      name: 'approval.allow',
    })).toBeNull()
  })

  it('#9234 终态窗口：busy 已清 → 直发', async () => {
    runtimeMockState.runProjectionBySessionId['session-1'] = { busy: false, queuedRunIds: [], source: 'event', lastSyncAt: Date.now() }
    const onSend = vi.fn()
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={onSend}
        isStreaming={false}
        sessionId="session-1"
      />,
    )

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '刚结束立刻发' } })
    fireEvent.click(screen.getByLabelText('input.sendTitle'))

    expect(onSend).toHaveBeenCalled()
  })

  it('#9234 已发送未流式窗口：直发排队，不再本地 enqueue', async () => {
    runtimeMockState.runProjectionBySessionId['session-1'] = { busy: true, queuedRunIds: [], source: 'runtime-sync', lastSyncAt: Date.now() }
    const onSend = vi.fn()
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={onSend}
        isStreaming={false}
        sessionId="session-1"
      />,
    )

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '追加一条' } })
    fireEvent.click(screen.getByLabelText('input.sendTitle'))

    expect(onSend).toHaveBeenCalled()
  })

  it('soft askUser 挂起期仍直发（不因 busy 误入队）', async () => {
    // 软 askUser 挂起期会话仍 busy。修复须显式排除该例外，保留  的
    // 软 askUser 直发，不能因 busy 而误入队。
    runtimeMockState.runProjectionBySessionId['session-1'] = { busy: true, queuedRunIds: [], source: 'runtime-sync', lastSyncAt: Date.now() }
    const onSend = vi.fn()
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={onSend}
        pendingAskUser={buildPendingAskUser('soft')}
        isStreaming={false}
        sessionId="session-1"
      />,
    )

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '继续往下做' } })
    fireEvent.click(screen.getByLabelText('input.sendTitle'))

    expect(onSend).toHaveBeenCalledWith('继续往下做', undefined, undefined, undefined)
  })

  it('底部权限入口接线到轻量浮层组件（透传 spaceId/sessionId，不再打开全局抽屉）', async () => {
    const onSend = vi.fn()
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={onSend}
        sessionId="session-1"
        spaceId="space-1"
      />,
    )

    const entry = screen.getByLabelText('input.permissionSettings')
    expect(entry.getAttribute('data-space-id')).toBe('space-1')
    expect(entry.getAttribute('data-session-id')).toBe('session-1')

    fireEvent.click(entry)
    expect(mockOpenAgentSettings).not.toHaveBeenCalled()
  })

  it('执行 Space 在新对话可切换，已有会话只读显示', async () => {
    const onSend = vi.fn()
    const onExecutionSpaceChange = vi.fn()
    const { ChatInput } = await import('../ChatInput')

    // 草稿：enableAgentPicker 控制底栏工作空间切换；正式会话不再传 true
    const { rerender } = render(
      <ChatInput
        onSend={onSend}
        spaceId="space-1"
        spaceName="TabTin"
        sessionId={null}
        onExecutionSpaceChange={onExecutionSpaceChange}
        enableAgentPicker
      />,
    )

    expect(screen.getByTestId('space-switcher-popover')).toBeTruthy()

    rerender(
      <ChatInput
        onSend={onSend}
        spaceId="space-1"
        spaceName="TabTin"
        sessionId="session-1"
        onExecutionSpaceChange={onExecutionSpaceChange}
      />,
    )

    expect(screen.queryByTestId('space-switcher-popover')).toBeNull()
    expect(screen.getByLabelText('input.executionTarget · TabTin')).toBeTruthy()
    expect(screen.getByText('input.executionTarget · TabTin')).toBeTruthy()
    expect(screen.queryByText('input.executionTarget')).toBeNull()
    expect(screen.getByText('TabTin')).toBeTruthy()
  })

  it('当前上下文绝对定位在输入文字下方、底部工具栏上方', async () => {
    const onSend = vi.fn()
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={onSend}
        sessionId="session-1"
        contextDisplay={{ icon: 'table', label: 'TabData', name: '36氪项目库' }}
      />,
    )

    const textarea = screen.getByRole('textbox')
    const contextLabel = screen.getByText('36氪项目库')
    const toolbarButton = screen.getByLabelText('input.permissionSettings')

    expect(textarea.compareDocumentPosition(contextLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(contextLabel.compareDocumentPosition(toolbarButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(contextLabel.closest('.absolute')).toBeTruthy()
    expect(contextLabel.closest('.bottom-9')).toBeTruthy()
    expect(contextLabel.closest('.justify-end')).toBeTruthy()
    expect(contextLabel.className).toContain('text-muted-foreground/60')
    expect(screen.queryByText('TabData')).toBeNull()
  })

  it('#9051 在线队列非空且未 streaming 时仍显示停止铬', async () => {
    const onSend = vi.fn()
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={onSend}
        sessionId="session-1"
        isStreaming={false}
        queueCount={1}
      />,
    )

    expect(screen.getByLabelText('input.stopTitle')).toBeTruthy()
    expect(screen.queryByLabelText('input.sendTitle')).toBeNull()
  })

  it('slash skill 发送斜杠原文 + 结构化 skillSlashInvoke（ 直链，不再改写 meta-prompt）', async () => {
    mockSlashSkills.push({
      skill_id: 'what-is-your-base-model',
      skill_key: 'user:what-is-your-base-model',
      slug: 'what-is-your-base-model',
      name: 'what-is-your-base-model',
      source: 'user',
      installed: true,
      enabled: true,
    })
    const onSend = vi.fn()
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={onSend}
        sessionId="session-1"
      />,
    )

    const raw = '/what-is-your-base-model 请按默认流程执行'
    fireEvent.change(screen.getByRole('textbox'), { target: { value: raw } })
    fireEvent.click(screen.getByLabelText('input.sendTitle'))

    expect(onSend).toHaveBeenCalledTimes(1)
    const [effectiveMessage, attachments, contextBlocks, options] = onSend.mock.calls[0]
    // 发给 runtime 的执行文本 = 斜杠原文（同时也是可见气泡），不再是「请调用 skill_invoke」meta-prompt
    expect(effectiveMessage).toBe(raw)
    expect(effectiveMessage).not.toContain('请调用 `skill_invoke`')
    expect(attachments).toBeUndefined()
    expect(contextBlocks).toBeUndefined()
    // 结构化直链字段透传给 runtime（首次 LLM 调用前确定性展开）
    expect(options).toEqual({
      skillSlashInvoke: {
        skillKey: 'user:what-is-your-base-model',
        args: '请按默认流程执行',
      },
    })
  })

  it('拖拽文件到输入区后会作为附件随消息发送', async () => {
    const onSend = vi.fn()
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={onSend}
        sessionId="session-1"
      />,
    )

    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    await act(async () => {
      fireEvent.drop(screen.getByRole('textbox'), {
        dataTransfer: {
          files: [file],
          types: ['Files'],
          getData: vi.fn(() => ''),
        },
      })
    })

    expect(await screen.findByText('notes.txt')).toBeTruthy()

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '请看附件' } })
    // 添加即上传：等附件传完（发送按钮从禁用变可用）再发送
    await waitFor(() =>
      expect((screen.getByLabelText('input.sendTitle') as HTMLButtonElement).disabled).toBe(false),
    )
    await act(async () => { fireEvent.click(screen.getByLabelText('input.sendTitle')) })

    expect(onSend).toHaveBeenCalledTimes(1)
    const [message, attachments] = onSend.mock.calls[0]
    expect(message).toBe('请看附件')
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({
      filename: 'notes.txt',
      mimeType: 'text/plain',
      type: 'file',
      status: 'ready',
      fileId: 'fid-notes.txt',
    })
  })

  it('语音录制中发送消息会停止语音服务并回到停止态', async () => {
    voiceMockState.state = 'recording'
    const onSend = vi.fn()
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={onSend}
        sessionId="session-1"
      />,
    )

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '语音输入完成' } })
    fireEvent.click(screen.getByLabelText('input.sendTitle'))

    expect(onSend).toHaveBeenCalledWith('语音输入完成', undefined, undefined, undefined)
    expect(mockVoiceCancel).toHaveBeenCalledTimes(1)
    expect(mockVoiceStop).not.toHaveBeenCalled()
  })

  it('语音录制中 streaming 发送会停止语音并直发', async () => {
    voiceMockState.state = 'recording'
    const onSend = vi.fn()
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={onSend}
        isStreaming
        sessionId="session-1"
      />,
    )

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '先排队这条' } })
    // streaming 时停止铬占位；有内容时仍可走发送（或 interrupt）——点发送标题
    const sendOrEnqueue = screen.queryByLabelText('input.sendTitle')
      ?? screen.queryByLabelText('queue.enqueue')
    expect(sendOrEnqueue).toBeTruthy()
    fireEvent.click(sendOrEnqueue!)

    expect(onSend).toHaveBeenCalled()
    expect(mockVoiceCancel).toHaveBeenCalledTimes(1)
  })

  it('语音录制中断网发送会停止语音且拒发（不入队）', async () => {
    voiceMockState.state = 'recording'
    wsMockState.status = 'disconnected'
    const onSend = vi.fn()
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={onSend}
        sessionId="session-1"
      />,
    )

    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textbox, { target: { value: '离线时拒发' } })
    await act(async () => {
      fireEvent.click(screen.getByLabelText('input.wsDisconnectedSendBlocked'))
    })

    expect(onSend).not.toHaveBeenCalled()
    expect(textbox.value).toBe('离线时拒发')
    expect(mockVoiceCancel).toHaveBeenCalledTimes(1)
    expect(mockVoiceStop).not.toHaveBeenCalled()
    expect(mockToastError).toHaveBeenCalledWith('input.wsDisconnectedSendBlocked')
  })

  it('dropApiRef 注入文件时复用附件链路', async () => {
    const onSend = vi.fn()
    const dropApiRef: React.MutableRefObject<{ ingestFiles: (files: File[]) => void } | null> = { current: null }
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={onSend}
        sessionId="session-1"
        dropApiRef={dropApiRef}
      />,
    )

    const file = new File(['from panel'], 'panel-drop.md', { type: 'text/markdown' })
    await act(async () => {
      dropApiRef.current?.ingestFiles([file])
    })

    expect(await screen.findByText('panel-drop.md')).toBeTruthy()

    // 添加即上传：等附件传完再发送
    await waitFor(() =>
      expect((screen.getByLabelText('input.sendTitle') as HTMLButtonElement).disabled).toBe(false),
    )
    await act(async () => { fireEvent.click(screen.getByLabelText('input.sendTitle')) })

    expect(onSend).toHaveBeenCalledTimes(1)
    const [message, attachments] = onSend.mock.calls[0]
    expect(message).toBe('')
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({
      filename: 'panel-drop.md',
      mimeType: 'text/markdown',
      type: 'file',
      status: 'ready',
      fileId: 'fid-panel-drop.md',
    })
  })

  it('非全局输入接收者不会消费浏览器标注注入事件', async () => {
    const onSend = vi.fn()
    const onAddContextRef = vi.fn()
    const { ChatInput } = await import('../ChatInput')
    const { BROWSER_ANNOTATION_INJECT_EVENT } = await import('../../context/browserAnnotationInjection')

    render(
      <ChatInput
        onSend={onSend}
        sessionId="session-1"
        onAddContextRef={onAddContextRef}
        acceptGlobalInputEvents={false}
      />,
    )

    window.dispatchEvent(new CustomEvent(BROWSER_ANNOTATION_INJECT_EVENT, {
      detail: {
        contextRef: {
          type: 'file',
          resourceId: 'file-1',
          label: 'README.md',
        },
      },
    }))

    expect(onAddContextRef).not.toHaveBeenCalled()
  })

  it('非全局输入接收者不会响应 Agent 模式全局快捷键', async () => {
    const onSend = vi.fn()
    const { ChatInput } = await import('../ChatInput')

    render(
      <ChatInput
        onSend={onSend}
        sessionId="session-1"
        acceptGlobalInputEvents={false}
      />,
    )

    fireEvent.keyDown(window, { key: '.', ctrlKey: true, shiftKey: true })

    expect(mockSetAgentMode).not.toHaveBeenCalled()
  })

  it('#2543: 已上传的非图片附件在输入框可点击预览（pdf）', async () => {
    runtimeMockState.pendingPrefillBySessionId['session-1'] = { ts: 1 }
    runtimeMockState.nextPrefill = {
      message: '看下这份 pdf',
      attachments: [{
        id: 'att-pdf-1',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        size: 1024,
        type: 'file',
        remoteUrl: 'https://oss.example.com/doc.pdf',
        fileId: 'fid-pdf-1',
      }],
    }
    const onSend = vi.fn()
    const { ChatInput } = await import('../ChatInput')

    render(<ChatInput onSend={onSend} sessionId="session-1" />)

    // 附件 chip 渲染出来
    const filenameBtn = await screen.findByText('doc.pdf')
    const btn = filenameBtn.closest('button') as HTMLButtonElement
    expect(btn).toBeTruthy()
    // 上传完成后 canPreview 为 true，按钮可点
    expect(btn.disabled).toBe(false)

    fireEvent.click(btn)

    const st = useResourcePreviewStore.getState()
    expect(st.isOpen).toBe(true)
    expect(st.resources[0].kind).toBe('pdf')
    expect(st.resources[0].url).toBe('https://oss.example.com/doc.pdf')
    expect(st.resources[0].fileId).toBe('fid-pdf-1')
  })

  it('#2543: pending 态（未上传）的 pdf 附件用本地 blob URL 即可预览', async () => {
    // jsdom 不实现 objectURL——mock 掉，同时断言 blob 生命周期。
    const createObjectURLMock = vi.fn().mockReturnValue('blob:mock://draft-pdf')
    const revokeObjectURLMock = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURLMock, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURLMock, configurable: true })

    const onSend = vi.fn()
    const { ChatInput } = await import('../ChatInput')
    // 让添加即上传停在 uploading（不 resolve），以验证上传窗口内走本地 blob 预览
    const { uploadChatAttachment } = await import('@/services/chatAttachmentApi')
    vi.mocked(uploadChatAttachment).mockImplementationOnce(() => new Promise(() => {}))

    const { unmount } = render(<ChatInput onSend={onSend} sessionId="session-1" />)

    // 拖入一个 pdf（上传中，无 remoteUrl/fileId——本地 blob 即可预览）
    const file = new File(['%PDF-1.4'], 'draft.pdf', { type: 'application/pdf' })
    await act(async () => {
      fireEvent.drop(screen.getByRole('textbox'), {
        dataTransfer: {
          files: [file],
          types: ['Files'],
          getData: vi.fn(() => ''),
        },
      })
    })

    const filenameBtn = await screen.findByText('draft.pdf')
    const btn = filenameBtn.closest('button') as HTMLButtonElement
    //  时序缺口修复：发送前窗口也能预览
    expect(btn.disabled).toBe(false)
    expect(createObjectURLMock).toHaveBeenCalledWith(file)

    fireEvent.click(btn)

    const st = useResourcePreviewStore.getState()
    expect(st.isOpen).toBe(true)
    expect(st.resources[0].kind).toBe('pdf')
    expect(st.resources[0].url).toBe('blob:mock://draft-pdf')

    // 卸载后 revoke 本地 blob，不泄漏
    unmount()
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock://draft-pdf')
  })

  it('#2543: pending 态 txt 附件用本地 blob URL 即可预览', async () => {
    const createObjectURLMock = vi.fn().mockReturnValue('blob:mock://draft-txt')
    const revokeObjectURLMock = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURLMock, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURLMock, configurable: true })

    const onSend = vi.fn()
    const { ChatInput } = await import('../ChatInput')
    // 让添加即上传停在 uploading（不 resolve），以验证上传窗口内走本地 blob 预览
    const { uploadChatAttachment } = await import('@/services/chatAttachmentApi')
    vi.mocked(uploadChatAttachment).mockImplementationOnce(() => new Promise(() => {}))

    const { unmount } = render(<ChatInput onSend={onSend} sessionId="session-1" />)

    const file = new File(['plain text'], 'notes-2543.txt', { type: 'text/plain' })
    await act(async () => {
      fireEvent.drop(screen.getByRole('textbox'), {
        dataTransfer: {
          files: [file],
          types: ['Files'],
          getData: vi.fn(() => ''),
        },
      })
    })

    const filenameBtn = await screen.findByText('notes-2543.txt')
    const btn = filenameBtn.closest('button') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(createObjectURLMock).toHaveBeenCalled()

    fireEvent.click(btn)
    const st = useResourcePreviewStore.getState()
    expect(st.isOpen).toBe(true)
    expect(st.resources[0].kind).toBe('txt')
    expect(st.resources[0].url).toBe('blob:mock://draft-txt')

    unmount()
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock://draft-txt')
  })

  it('#2543: 不可预览类型（zip）可点但 toast，不建 blob', async () => {
    const createObjectURLMock = vi.fn().mockReturnValue('blob:mock://never')
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURLMock, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })

    const onSend = vi.fn()
    const { ChatInput } = await import('../ChatInput')

    render(<ChatInput onSend={onSend} sessionId="session-1" />)

    const file = new File(['PK'], 'archive.zip', { type: 'application/zip' })
    await act(async () => {
      fireEvent.drop(screen.getByRole('textbox'), {
        dataTransfer: {
          files: [file],
          types: ['Files'],
          getData: vi.fn(() => ''),
        },
      })
    })

    const filenameBtn = await screen.findByText('archive.zip')
    const btn = filenameBtn.closest('button') as HTMLButtonElement
    // ：非图片一律可点；不支持预览时 toast，不建 local blob
    expect(btn.disabled).toBe(false)
    expect(createObjectURLMock).not.toHaveBeenCalled()
  })

  describe('#3922 composer draft persistence across remount', () => {
    beforeEach(() => {
      localStorage.clear()
    })

    it('flushes draft to localStorage on unmount even before debounce', async () => {
      const { ChatInput } = await import('../ChatInput')
      const view = render(<ChatInput onSend={vi.fn()} sessionId="session-3922" />)

      fireEvent.change(screen.getByRole('textbox'), {
        target: { value: '切页前未发送的草稿' },
      })
      view.unmount()

      expect(localStorage.getItem('tabtin:draft:session-3922')).toBe('切页前未发送的草稿')
    })

    it('restores session draft after remount', async () => {
      localStorage.setItem('tabtin:draft:session-3922', '已缓存的会话草稿')
      const { ChatInput } = await import('../ChatInput')

      render(<ChatInput onSend={vi.fn()} sessionId="session-3922" />)

      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('已缓存的会话草稿')
    })

    it('persists and restores draft for draft session via spaceId when sessionId is null', async () => {
      const { ChatInput } = await import('../ChatInput')
      const view = render(
        <ChatInput onSend={vi.fn()} sessionId={null} spaceId="space-3922" />,
      )

      fireEvent.change(screen.getByRole('textbox'), {
        target: { value: '新对话草稿不应丢' },
      })
      view.unmount()

      expect(localStorage.getItem('tabtin:draft:space:space-3922')).toBe('新对话草稿不应丢')

      render(<ChatInput onSend={vi.fn()} sessionId={null} spaceId="space-3922" />)
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('新对话草稿不应丢')
    })
  })

  describe('#9204 composer attachment survives remount (settings round-trip)', () => {
    beforeEach(async () => {
      const { usePendingComposerAttachmentsStore } = await import(
        '@/stores/usePendingComposerAttachmentsStore'
      )
      usePendingComposerAttachmentsStore.setState({ pendingByScopeId: {} })
      Object.defineProperty(URL, 'createObjectURL', {
        value: vi.fn().mockReturnValue('blob:mock://paste-image'),
        configurable: true,
      })
      Object.defineProperty(URL, 'revokeObjectURL', {
        value: vi.fn(),
        configurable: true,
      })
    })

    it('stashes pending image on unmount and restores after remount', async () => {
      const { ChatInput } = await import('../ChatInput')
      const { uploadChatAttachment } = await import('@/services/chatAttachmentApi')
      // 第一次停在 uploading，模拟「粘贴后尚未发完就切设置」；重挂后续传成功
      vi.mocked(uploadChatAttachment)
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce({
          file_id: 'fid-image.png',
          file_name: 'image.png',
          file_key: 'chat/attachments/image.png',
          file_size: 4,
          file_type: 'image/png',
          access_url: 'http://example.com/image.png',
          cdn_url: 'http://example.com/image.png',
        })

      const view = render(<ChatInput onSend={vi.fn()} sessionId="session-9204" />)
      const file = new File([new Uint8Array([1, 2, 3, 4])], 'image.png', { type: 'image/png' })
      await act(async () => {
        fireEvent.drop(screen.getByRole('textbox'), {
          dataTransfer: {
            files: [file],
            types: ['Files'],
            getData: vi.fn(() => ''),
          },
        })
      })

      expect(await screen.findByText('image.png')).toBeTruthy()
      view.unmount()

      const { usePendingComposerAttachmentsStore } = await import(
        '@/stores/usePendingComposerAttachmentsStore'
      )
      const stashed = usePendingComposerAttachmentsStore.getState().pendingByScopeId['session-9204']
      expect(stashed?.map(a => a.filename)).toEqual(['image.png'])
      expect(stashed?.[0]?.status).toBe('pending')

      render(<ChatInput onSend={vi.fn()} sessionId="session-9204" />)
      expect(await screen.findByText('image.png')).toBeTruthy()
      // 重挂后续传完成后应显示体积，而不是卡在「上传中 0%」
      await waitFor(() => {
        expect(screen.queryByText(/uploadingProgress|上传中/)).toBeNull()
        expect(screen.getByText(/4\s*B|4\s*字节|4 Bytes/i)).toBeTruthy()
      })
      expect(
        usePendingComposerAttachmentsStore.getState().pendingByScopeId['session-9204'],
      ).toBeUndefined()
    })

    it('recovers orphan uploading chip left without an active controller', async () => {
      const { usePendingComposerAttachmentsStore } = await import(
        '@/stores/usePendingComposerAttachmentsStore'
      )
      const { ChatInput } = await import('../ChatInput')
      const { uploadChatAttachment } = await import('@/services/chatAttachmentApi')
      vi.mocked(uploadChatAttachment).mockResolvedValueOnce({
        file_id: 'fid-orphan.png',
        file_name: 'image.png',
        file_key: 'chat/attachments/image.png',
        file_size: 8,
        file_type: 'image/png',
        access_url: 'http://example.com/orphan.png',
        cdn_url: 'http://example.com/orphan.png',
      })

      const orphanFile = new File([new Uint8Array(8)], 'image.png', { type: 'image/png' })
      usePendingComposerAttachmentsStore.getState().enqueue('session-9204-orphan', {
        id: 'att-orphan-uploading',
        file: orphanFile,
        filename: 'image.png',
        mimeType: 'image/png',
        size: 8,
        type: 'image',
        status: 'uploading',
        uploadProgress: 0,
        previewUrl: 'blob:mock://orphan',
      })

      render(<ChatInput onSend={vi.fn()} sessionId="session-9204-orphan" />)
      expect(await screen.findByText('image.png')).toBeTruthy()
      await waitFor(() => {
        expect(screen.queryByText(/uploadingProgress|上传中/)).toBeNull()
      })
    })
  })

  describe('#5587 composer scope key drives remount without draft flash', () => {
    beforeEach(() => {
      localStorage.clear()
    })

    it('scope key is stable per session/space and changes across scopes', async () => {
      const { composerDraftScopeKey } = await import('../chatInputDraft')
      // 同 scope 稳定 → 不无谓 remount
      expect(composerDraftScopeKey('s-a', 'sp-1')).toBe(composerDraftScopeKey('s-a', 'sp-2'))
      // 会话切换 → key 变 → remount
      expect(composerDraftScopeKey('s-a', 'sp-1')).not.toBe(composerDraftScopeKey('s-b', 'sp-1'))
      // 草稿态按 spaceId 区分
      expect(composerDraftScopeKey(null, 'sp-1')).not.toBe(composerDraftScopeKey(null, 'sp-2'))
      // 会话 vs 草稿态不同
      expect(composerDraftScopeKey('s-a', null)).not.toBe(composerDraftScopeKey(null, 'sp-1'))
      // 全空回退到稳定字面量，避免 React 无 key
      expect(composerDraftScopeKey(null, null)).toBe(composerDraftScopeKey(undefined, undefined))
    })

    it('does not carry over previous session text when scope key remounts', async () => {
      const { ChatInput } = await import('../ChatInput')
      const { composerDraftScopeKey } = await import('../chatInputDraft')

      function Harness({ sessionId }: { sessionId: string | null }) {
        return (
          <ChatInput
            key={composerDraftScopeKey(sessionId, 'space-5587')}
            onSend={vi.fn()}
            sessionId={sessionId}
            spaceId="space-5587"
          />
        )
      }

      const view = render(<Harness sessionId="session-a" />)
      fireEvent.change(screen.getByRole('textbox'), {
        target: { value: '会话 A 未发送内容' },
      })

      // 切到新对话（sessionId=null）→ key 变 → ChatInput remount
      view.rerender(<Harness sessionId={null} />)

      // 新实例直接读 space:space-5587 草稿（空），不残留会话 A 文本
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
      // 切走时会话 A 文本经卸载 flush 落盘，切回不丢
      expect(localStorage.getItem('tabtin:draft:session-a')).toBe('会话 A 未发送内容')
    })
  })

})
