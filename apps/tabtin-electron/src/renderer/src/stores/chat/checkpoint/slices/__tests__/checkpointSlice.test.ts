import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatSession } from '@tabtin/chat-client'
import { mergeAuthoritativeServerReplace } from '@/stores/chat/domain/messageSyncAction'
import type { CheckpointStore } from '../checkpointSlice'
import type { RecoveryPlanContract } from '../../recoveryPlan'
import {
  createCheckpointActions,
  _resetReconciledSessions,
  resolveRewindAnchorId,
  buildApplyLayerSummaryLines,
  derivePartialSuccessDetailsFromLayers,
} from '../checkpointSlice'

const {
  mockRestoreResources,
  mockToast,
  mockRollbackSession,
  mockUnrevertSession,
  mockCancelActiveRunForSession,
  mockExtractCollabSyncWarnings,
  mockCheckpointCommit,
  mockCheckpointRestore,
  mockCheckpointRestoreSafe,
  mockCheckpointIsAvailable,
  mockCheckpointInitial,
  mockCheckpointDiff,
  mockClearSessionCache,
  mockCacheMessages,
  mockPersistCheckpointHash,
  mockCheckpointDiffSummary,
  mockFileHistoryIsAvailable,
  mockFileHistoryRewind,
  mockFileHistoryCreateSafetySnapshot,
  mockEmitCheckpointCreated,
  mockRollbackTranscript,
  mockRollbackSessionTimeline,
  mockCreateSpaceCheckpoint,
  mockCancelActiveRun,
  mockRollbackAgentRun,
} = vi.hoisted(() => ({
  mockRestoreResources: vi.fn(),
  mockToast: Object.assign(vi.fn(), { info: vi.fn() }),
  mockRollbackSession: vi.fn(),
  mockUnrevertSession: vi.fn(),
  mockCancelActiveRunForSession: vi.fn(),
  mockExtractCollabSyncWarnings: vi.fn(() => ({ hasForceCloseFailed: false, affectedResources: [] })),
  mockCheckpointCommit: vi.fn(),
  mockCheckpointRestore: vi.fn(),
  mockCheckpointRestoreSafe: vi.fn(),
  mockCheckpointIsAvailable: vi.fn(() => false),
  mockCheckpointInitial: vi.fn(),
  mockCheckpointDiff: vi.fn(async () => ({ diffs: [] })),
  mockClearSessionCache: vi.fn(),
  mockCacheMessages: vi.fn(),
  mockPersistCheckpointHash: vi.fn(),
  mockCheckpointDiffSummary: vi.fn(),
  mockFileHistoryIsAvailable: vi.fn(() => true),
  mockFileHistoryRewind: vi.fn(),
  mockFileHistoryCreateSafetySnapshot: vi.fn(async () => undefined),
  mockEmitCheckpointCreated: vi.fn(),
  mockRollbackTranscript: vi.fn(),
  mockRollbackSessionTimeline: vi.fn(),
  mockCreateSpaceCheckpoint: vi.fn(async () => ({ id: 'cp-manual-1' })),
  mockCancelActiveRun: vi.fn(async () => {}),
  mockRollbackAgentRun: vi.fn(),
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'chat:checkpoint.agentRunRollbackFailed') {
        return `撤销这次 AI 操作未完成：${String(options?.reason ?? '{{reason}}')}`
      }
      return String(options?.defaultValue ?? key)
    },
  },
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: mockToast,
}))

vi.mock('../../../../../services/chatExtraApi', () => ({
  restoreResources: mockRestoreResources,
  rollbackSession: mockRollbackSession,
  unrevertSession: mockUnrevertSession,
  cancelActiveRunForSession: mockCancelActiveRunForSession,
  extractCollabSyncWarnings: mockExtractCollabSyncWarnings,
  persistCheckpointHash: mockPersistCheckpointHash,
  createSpaceCheckpoint: mockCreateSpaceCheckpoint,
  rollbackAgentRun: mockRollbackAgentRun,
}))

vi.mock('../../../../../services/checkpointEvents', () => ({
  emitCheckpointCreated: mockEmitCheckpointCreated,
}))

vi.mock('../../../../../services/checkpointIpc', () => ({
  isAvailable: mockCheckpointIsAvailable,
  commit: mockCheckpointCommit,
  restore: mockCheckpointRestore,
  restoreSafe: mockCheckpointRestoreSafe,
  initial: mockCheckpointInitial,
  diff: mockCheckpointDiff,
  diffSummary: mockCheckpointDiffSummary,
}))

vi.mock('../../../../../services/fileHistoryIpc', () => ({
  isAvailable: mockFileHistoryIsAvailable,
  rewind: mockFileHistoryRewind,
  createSafetySnapshot: mockFileHistoryCreateSafetySnapshot,
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
  ),
}))

vi.mock('../../../messages/messageCache', () => ({
  clearSessionCache: mockClearSessionCache,
  cacheMessages: mockCacheMessages,
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const mockSetPrefillForSession = vi.fn()
vi.mock('@stores/useChatRuntimeStore', () => ({
  useChatRuntimeStore: {
    getState: () => ({
      setPrefillForSession: mockSetPrefillForSession,
    }),
  },
}))

// ：slice 经 hub（SessionController）走 runtime IPC / run 取消**连接通道**。
// mock 掉 hub 模块本身（其依赖树含 streamMessageHandler → UI 包，测试环境加载会炸），
// 通道行为转发到本文件既有的 window.tabtin.agentEngine mock，断言口径不变。
vi.mock('@/services/agentService', () => ({
  getSessionController: (sessionId: string) => ({
    rollbackSessionTimeline: (payload: Record<string, unknown>) => {
      const bridge = (window as unknown as { tabtin?: { agentEngine?: Record<string, (p: unknown) => unknown> } }).tabtin?.agentEngine
      if (typeof bridge?.rollbackSessionTimeline !== 'function') {
        throw new Error('agentEngine bridge unavailable (no local runtime IPC)')
      }
      return bridge.rollbackSessionTimeline({ ...payload, sessionId })
    },
    unrevertTranscript: (payload?: Record<string, unknown>) => {
      const bridge = (window as unknown as { tabtin?: { agentEngine?: Record<string, (p: unknown) => unknown> } }).tabtin?.agentEngine
      if (typeof bridge?.unrevertTranscript !== 'function') {
        throw new Error('agentEngine bridge unavailable (no local runtime IPC)')
      }
      return bridge.unrevertTranscript({ ...(payload ?? {}), sessionId })
    },
    // run 取消双通道在真实实现里是 IPC abort + 后端 cancel + settle 窗口；
    // 单测里等价 no-op（原实现的两个通道在本套件中本来就都被 mock 吞掉）。
    cancelActiveRun: mockCancelActiveRun,
  }),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({
      selectedSpace: {
        id: 'space-1',
        organization_id: 'organization-1',
      },
    }),
  },
}))

function buildSession(rollbackState: ChatSession['rollback_state']): ChatSession {
  return {
    id: 'session-1',
    title: 'session',
    status: 'active',
    space_id: 'space-1',
    organization_id: 'organization-1',
    created_at: '2026-04-05T00:00:00.000Z',
    updated_at: '2026-04-05T00:00:00.000Z',
    rollback_state: rollbackState,
  }
}

describe('checkpointSlice retryFailedResourceRestore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('在本地失败缓存缺失时，回退到 rollback_state 持久化的 retryable 计划', async () => {
    let state: CheckpointStore = {
      currentSessionId: 'session-1',
      sessions: [
        buildSession({
          session_id: 'session-1',
          revert_active: true,
          cleanup_status: 'pending',
          can_unrevert: true,
          last_apply_result: 'partial_success',
          partial_success_details: {
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
        }),
      ],
      messagesBySessionId: {},
      streamingBySessionId: {},
      restoringSessionId: null,
      restoringPhase: null,
      checkpointsBySessionId: {},
      lastSafetyCheckpointBySessionId: {},
      checkpointFailCountBySessionId: {},
      checkpointHealthBySessionId: {},
      rewindPreview: null,
      resourceRetryCountBySessionId: {},
      abortStreamAndWait: vi.fn(async () => ({ cancelRequested: false, cancelCompleted: true })),
      sendMessage: vi.fn(async () => {}),
      updateSessionMessages: vi.fn(),
      updateSessionInCaches: (sessionId, patch) => {
        state = {
          ...state,
          sessions: state.sessions.map(session =>
            session.id === sessionId ? { ...session, ...patch } : session,
          ),
        }
      },
    }

    const get = () => state
    const set = (partial: Partial<CheckpointStore> | ((value: CheckpointStore) => Partial<CheckpointStore>)) => {
      const next = typeof partial === 'function' ? partial(state) : partial
      state = { ...state, ...next }
    }

    mockRestoreResources.mockResolvedValue({
      success: true,
      results: [{ resource_type: 'docs', resource_id: 'doc-1', success: true, error: '' }],
      restored_count: 1,
      failed_count: 0,
      overall_status: 'success',
      partial_success_details: null,
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        cleanup_status: 'pending',
        can_unrevert: true,
        last_apply_result: 'success',
        partial_success_details: null,
        resource_restore_state: [],
        updated_at: '2026-04-05T00:00:01.000Z',
      },
      apply_result: null,
    })

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => null),
      getChatClient: () => ({
        messages: {
          list: vi.fn(async () => ({ messages: [] })),
        },
      }),
    })

    await actions.retryFailedResourceRestore('session-1')

    expect(mockRestoreResources).toHaveBeenCalledWith('session-1', [{
      resource_type: 'docs',
      resource_id: 'doc-1',
      action: 'trash',
      restore_to_version_id: null,
    }])
  })
})

// ── 辅助函数 ──────────────────────────────────────────────────────────────

function buildMessage(id: string, role: 'user' | 'assistant', content: string, checkpointHash?: string, agentRunId?: string): ChatMessage {
  return {
    id,
    role,
    content,
    created_at: '2026-04-05T00:00:00.000Z',
    ...(checkpointHash ? { checkpoint_hash: checkpointHash } : {}),
    ...(agentRunId ? { agent_run_id: agentRunId } : {}),
  } as ChatMessage
}

/** assistant 消息 helper：per-file 回退按 agent_run_id 寻址锚点（§3.9）。 */
function buildAssistant(id: string, content: string, agentRunId: string): ChatMessage {
  return buildMessage(id, 'assistant', content, undefined, agentRunId)
}

const REWIND_OK = { filesRestored: [] as string[], filesDeleted: [] as string[], failedFiles: [] as string[] }

function recoveryContract(overrides: Partial<RecoveryPlanContract> = {}): RecoveryPlanContract {
  return {
    version: 2,
    fileAnchor: { id: 'run-b', source: 'preview' },
    ...overrides,
  }
}

function installRollbackTranscriptMock() {
  mockRollbackTranscript.mockResolvedValue({ success: true, applied: true })
  mockRollbackSessionTimeline.mockImplementation(async () => ({
    success: true,
    applied: true,
    backend: await mockRollbackSession(),
  }))
  Object.defineProperty(window, 'tabtin', {
    configurable: true,
    value: {
      agentEngine: {
        rollbackTranscript: mockRollbackTranscript,
        rollbackSessionTimeline: mockRollbackSessionTimeline,
        unrevertTranscript: vi.fn(async () => ({ success: true })),
      },
    },
  })
}

beforeEach(() => {
  installRollbackTranscriptMock()
})

function createStatefulStore(overrides?: Partial<CheckpointStore>) {
  let state: CheckpointStore = {
    currentSessionId: 'session-1',
    sessions: [buildSession(null)],
    messagesBySessionId: {},
    streamingBySessionId: {},
    restoringSessionId: null,
    restoringPhase: null,
    checkpointsBySessionId: {},
    lastSafetyCheckpointBySessionId: {},
    checkpointFailCountBySessionId: {},
    checkpointHealthBySessionId: {},
    rewindPreview: null,
    resourceRetryCountBySessionId: {},
    restoreInterruptedBySessionId: {},
    editResendRevertBySessionId: {},
    abortStreamAndWait: vi.fn(async () => ({ cancelRequested: false, cancelCompleted: true })),
    sendMessage: vi.fn(async () => {}),
    replaceFromRollback: vi.fn((sessionId: string, serverMessages: ChatMessage[]) => {
      const current = state.messagesBySessionId[sessionId] ?? []
      const resolved = mergeAuthoritativeServerReplace(serverMessages, current)
      state = {
        ...state,
        messagesBySessionId: { ...state.messagesBySessionId, [sessionId]: resolved },
      }
      return resolved
    }),
    applyRollbackTruncation: vi.fn((sessionId: string, messages: ChatMessage[]) => {
      state = {
        ...state,
        messagesBySessionId: { ...state.messagesBySessionId, [sessionId]: messages },
      }
    }),
    injectSystemMessage: vi.fn((sessionId: string, message: ChatMessage) => {
      const current = state.messagesBySessionId[sessionId] ?? []
      if (current.some(m => m.id === message.id)) return
      state = {
        ...state,
        messagesBySessionId: { ...state.messagesBySessionId, [sessionId]: [...current, message] },
      }
    }),
    updateSessionInCaches: vi.fn((sessionId: string, patch: Partial<ChatSession>) => {
      state = {
        ...state,
        sessions: state.sessions.map(s => s.id === sessionId ? { ...s, ...patch } : s),
      }
    }),
    ...overrides,
  }

  const get = () => state
  const set = (partial: Partial<CheckpointStore> | ((value: CheckpointStore) => Partial<CheckpointStore>)) => {
    const next = typeof partial === 'function' ? partial(state) : partial
    state = { ...state, ...next }
  }

  return { get, set, getState: () => state }
}

describe('rollbackAgentRun 错误提示', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('使用真实错误原因完成翻译插值，不泄露 {{reason}} 占位符', async () => {
    const { get, set } = createStatefulStore()
    mockRollbackAgentRun.mockRejectedValue(new Error('资源不存在或当前账号无法编辑'))

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => null),
      getChatClient: () => ({ messages: { list: vi.fn(async () => ({ messages: [] })) } }),
    })

    await actions.rollbackAgentRun('run-error')

    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
      title: '撤销这次 AI 操作未完成：资源不存在或当前账号无法编辑',
      variant: 'destructive',
    }))
    expect(String(mockToast.mock.calls.at(-1)?.[0]?.title)).not.toContain('{{reason}}')
  })
})

// ── Test: executeRollbackPipeline happy path ─────────────────────────────

describe('executeRollbackPipeline happy path（per-file rewind）', () => {
  beforeEach(() => { vi.clearAllMocks(); installRollbackTranscriptMock() })

  it('走 fileHistory.rewind(sessionId, agentRunId)、消息截断、映射清理、runtime/HITL 清理', async () => {
    const messages = [
      buildMessage('msg-1', 'user', 'hello'),
      buildAssistant('msg-2', 'reply-1', 'run-a'),
      buildMessage('msg-3', 'user', 'world'),
      buildAssistant('msg-4', 'reply-2', 'run-b'),
      buildAssistant('msg-5', 'reply-3', 'run-b'),
    ]

    const mockCleanupRuntime = vi.fn()
    const mockCleanupHitl = vi.fn()

    const { get, set, getState } = createStatefulStore({
      messagesBySessionId: { 'session-1': messages },
      checkpointsBySessionId: {
        'session-1': { 'msg-2': 'cp-2', 'msg-4': 'cp-4', 'msg-5': 'cp-5' },
      },
    })

    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue({ ...REWIND_OK, filesRestored: ['/ws/a.txt'] })
    mockRollbackSession.mockResolvedValue({
      success: true,
      file_restore_success: true,
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        safety_snapshot_ref: null,
        partial_success_details: null,
        resource_restore_state: null,
      },
    })

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => '/fake/path'),
      getChatClient: () => ({ messages: { list: vi.fn(async () => ({ messages: [] })) } }),
      cleanupRuntimeState: mockCleanupRuntime,
      cleanupHitlState: mockCleanupHitl,
    })

    // 回退到 user msg-3：anchor = 其后第一条 assistant(msg-4) 的 agent_run_id='run-b'
    // （§3.9 修 off-by-one：绝不取 msg-3 前的 msg-2='run-a'）。
    await actions.rollbackToCheckpoint('msg-3')

    const s = getState()

    // keepCount = targetIdx(2) → 保留 msg-1, msg-2，再追加一条 system summary
    const msgs = s.messagesBySessionId['session-1']
    expect(msgs).toHaveLength(3)
    expect(msgs[0].id).toBe('msg-1')
    expect(msgs[1].id).toBe('msg-2')
    expect(msgs[2].role).toBe('system')

    // 被删除消息（msg-3/4/5）的 checkpoint 映射被清理，保留 msg-2
    expect(s.checkpointsBySessionId['session-1']).toEqual({ 'msg-2': 'cp-2' })

    // per-file 回退：按 thread(sessionId) + anchor(run-b) rewind；不再走 shadow git restore/initial
    expect(mockFileHistoryRewind).toHaveBeenCalledWith('session-1', 'run-b', undefined)
    expect(mockCheckpointRestore).not.toHaveBeenCalled()
    expect(mockCheckpointInitial).not.toHaveBeenCalled()
    // failedFiles 为空 → 不弹失败提示
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('个文件未能恢复') }),
    )
    expect(mockCleanupRuntime).toHaveBeenCalledWith('session-1')
    expect(mockCleanupHitl).toHaveBeenCalledWith('session-1', new Set(['msg-3', 'msg-4', 'msg-5']))
    expect(s.restoringSessionId).toBeNull()
    expect(s.restoringPhase).toBeNull()
    expect(mockCacheMessages).toHaveBeenCalledWith('session-1', msgs, undefined, { preserveSyncTimestamp: true })
    expect(mockClearSessionCache).not.toHaveBeenCalled()
  })
})

// ── Test: 回退后预填保留引用 chip（#回退引用丢失）─────────────────────────

describe('rollbackToCheckpoint 回填引用（回退后 chip 不丢失）', () => {
  beforeEach(() => { vi.clearAllMocks(); installRollbackTranscriptMock() })

  function mockHealthyRollback() {
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue({ ...REWIND_OK })
    mockRollbackSession.mockResolvedValue({
      success: true,
      file_restore_success: true,
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        safety_snapshot_ref: null,
        partial_success_details: null,
        resource_restore_state: null,
      },
    })
  }

  it('回退到 assistant 时，上一条用户消息的 content_blocks_json 引用一并预填', async () => {
    const userWithRef = {
      id: 'msg-1',
      role: 'user',
      content: '看看这个文件',
      created_at: '2026-04-05T00:00:00.000Z',
      content_blocks_json: [
        { type: 'text', text: '看看这个文件' },
        { type: 'code_file', file_path: '/ws/a.ts', preview: 'const a = 1', root_path: '/ws' },
      ],
    } as ChatMessage

    const messages = [userWithRef, buildAssistant('msg-2', 'reply-1', 'run-a')]

    const { get, set } = createStatefulStore({
      messagesBySessionId: { 'session-1': messages },
      checkpointsBySessionId: { 'session-1': { 'msg-2': 'cp-2' } },
    })
    mockHealthyRollback()

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => '/fake/path'),
      getChatClient: () => ({ messages: { list: vi.fn(async () => ({ messages: [] })) } }),
    })

    await actions.rollbackToCheckpoint('msg-2')

    expect(mockSetPrefillForSession).toHaveBeenCalledWith('session-1', expect.objectContaining({
      message: '看看这个文件',
      contextBlocks: [expect.objectContaining({ type: 'code_file', file_path: '/ws/a.ts' })],
    }))
    // text block 被滤掉，只留引用 block
    const prefillArg = mockSetPrefillForSession.mock.calls.at(-1)?.[1] as { contextBlocks?: unknown[] }
    expect(prefillArg.contextBlocks).toHaveLength(1)
  })

  it('上一条用户消息无引用无附件时，退化为纯文本预填', async () => {
    const messages = [buildMessage('msg-1', 'user', 'hello'), buildAssistant('msg-2', 'reply-1', 'run-a')]

    const { get, set } = createStatefulStore({
      messagesBySessionId: { 'session-1': messages },
      checkpointsBySessionId: { 'session-1': { 'msg-2': 'cp-2' } },
    })
    mockHealthyRollback()

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => '/fake/path'),
      getChatClient: () => ({ messages: { list: vi.fn(async () => ({ messages: [] })) } }),
    })

    await actions.rollbackToCheckpoint('msg-2')

    expect(mockSetPrefillForSession).toHaveBeenCalledWith('session-1', 'hello')
  })
})

// ── Test: resolveRewindAnchorId 纯函数（§3.9 规则 3，含 off-by-one 修复）─────

describe('resolveRewindAnchorId', () => {
  it('user 目标 → 取其后第一条 assistant 的 agent_run_id（不是它前面的）', () => {
    const messages = [
      buildMessage('u1', 'user', 'hi'),
      buildAssistant('a1', 'r1', 'run-a'),
      buildMessage('u2', 'user', 'go'),
      buildAssistant('a2', 'r2', 'run-b'),
    ]
    // 回退到 u2(idx 2)：anchor 必须是 run-b（u2 触发的那一轮），绝不是 run-a。
    expect(resolveRewindAnchorId(messages, 2)).toBe('run-b')
  })

  it('user 目标 → 跳过子 Agent assistant，锚到之后第一条顶层 assistant', () => {
    const messages = [
      buildMessage('u1', 'user', 'hi'),
      {
        ...buildAssistant('sub-a1', 'subagent result', 'run-sub'),
        subagent_run_id: 'sub-run-1',
      } as ChatMessage,
      buildAssistant('a1', 'root result', 'run-root'),
    ]

    expect(resolveRewindAnchorId(messages, 0)).toBe('run-root')
  })

  it('#4528 assistant 目标（保留该轮）→ 取其后第一条不同 run 的 assistant', () => {
    const messages = [
      buildMessage('u1', 'user', 'hi'),
      buildAssistant('a1', 'r1', 'run-a'),
      buildMessage('u2', 'user', 'go'),
      buildAssistant('a2', 'r2', 'run-b'),
    ]
    // 点 a1(idx 1) 回退：保留 run-a 这轮文件、回退其后 → anchor=run-b（下一轮开始前）。
    expect(resolveRewindAnchorId(messages, 1)).toBe('run-b')
  })

  it('#4528 assistant 目标同 run 的后续消息不作锚点，取下一轮不同 run', () => {
    const messages = [
      buildMessage('u1', 'user', 'hi'),
      buildAssistant('a1a', 'part1', 'run-a'),
      buildAssistant('a1b', 'part2', 'run-a'),
      buildAssistant('a2', 'r2', 'run-b'),
    ]
    // 点 a1a(idx 1)：a1b 同属 run-a 不作锚点，锚到 run-b（保留 run-a 全轮文件）。
    expect(resolveRewindAnchorId(messages, 1)).toBe('run-b')
  })

  it('#4528 assistant 目标是最后一轮（其后无新 run）→ null（无后续文件可回退）', () => {
    const messages = [
      buildMessage('u1', 'user', 'hi'),
      buildAssistant('a1', 'r1', 'run-a'),
    ]
    expect(resolveRewindAnchorId(messages, 1)).toBeNull()
  })

  it('目标后没有 assistant（user 末条还没触发回复）→ null', () => {
    const messages = [
      buildMessage('u1', 'user', 'hi'),
      buildAssistant('a1', 'r1', 'run-a'),
      buildMessage('u2', 'user', 'go'),
    ]
    expect(resolveRewindAnchorId(messages, 2)).toBeNull()
  })

  it('命中的 assistant 缺 agent_run_id → null', () => {
    const messages = [
      buildMessage('u1', 'user', 'hi'),
      buildAssistant('a1', 'r1', 'run-a'),
      buildMessage('u2', 'user', 'go'),
      buildMessage('a2', 'assistant', 'r2'), // 无 agent_run_id（老消息 / 流式占位）
    ]
    // user 目标之后第一条 assistant 无 run id → null
    expect(resolveRewindAnchorId(messages, 2)).toBeNull()
  })

  it('assistant 自身 agent_run_id 为空串 → null', () => {
    // DB agent_run_id 是 CharField、默认 '' 而非 NULL，历史 API 可能回空串；用 `|| null`
    // （非 `?? null`）把空串一并归一成 null，不当成有效锚点（与后端 _resolve 的 or None 一致）。
    const messages: ChatMessage[] = [
      buildMessage('u1', 'user', 'hi'),
      { id: 'a1', role: 'assistant', content: '', created_at: '2026-04-05T00:00:00.000Z', agent_run_id: '' } as ChatMessage,
    ]
    expect(resolveRewindAnchorId(messages, 1)).toBeNull()
  })
})

// ── Test: executeRollbackPipeline 后端成功但文件恢复失败 ─────────────────

describe('executeRollbackPipeline rewind 抛错（fail-visible，对话保留）', () => {
  beforeEach(() => { vi.clearAllMocks(); installRollbackTranscriptMock() })

  it('rewind 抛错 → 提示文件未恢复、但不 unrevert 对话（回退即终态）', async () => {
    installRollbackTranscriptMock()
    const messages = [
      buildMessage('msg-1', 'user', 'hello'),
      buildAssistant('msg-2', 'reply-1', 'run-a'),
      buildMessage('msg-3', 'user', 'world'),
      buildAssistant('msg-4', 'reply-2', 'run-b'),
    ]

    const mockMessagesList = vi.fn(async () => ({ messages: [] }))

    const { get, set, getState } = createStatefulStore({
      messagesBySessionId: { 'session-1': messages },
      checkpointsBySessionId: { 'session-1': { 'msg-2': 'cp-2', 'msg-4': 'cp-4' } },
    })

    mockFileHistoryIsAvailable.mockReturnValue(true)
    // rewind 抛错（path guard / 写权限拒绝）是真实文件恢复失败，必须 fail-visible。
    mockFileHistoryRewind.mockRejectedValue(new Error('path guard denied'))
    mockRollbackSession.mockResolvedValue({
      success: true,
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        safety_snapshot_ref: null,
        partial_success_details: null,
        resource_restore_state: null,
      },
    })

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => '/fake/path'),
      getChatClient: () => ({ messages: { list: mockMessagesList } }),
    })

    // 回退到 user msg-3：anchor = msg-4 的 run-b；rewind 抛错。
    await actions.rollbackToCheckpoint('msg-3')

    // rewind 按 thread+anchor 调用
    expect(mockFileHistoryRewind).toHaveBeenCalledWith('session-1', 'run-b', undefined)
    // fail-visible：明确提示文件未恢复
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '工作区文件未能自动恢复，但对话已回退；请手动检查文件状态',
        variant: 'warning',
      }),
    )
    // 不再走 shadow git 兜底；rewind 失败**不**回滚对话（不调 unrevert）
    expect(mockCheckpointRestoreSafe).not.toHaveBeenCalled()
    expect(mockUnrevertSession).not.toHaveBeenCalled()

    const s = getState()
    // 对话照常回退：保留 msg-1, msg-2（keepCount=2）+ system summary
    const msgs = s.messagesBySessionId['session-1']
    expect(msgs).toHaveLength(3)
    expect(msgs[0].id).toBe('msg-1')
    expect(msgs[1].id).toBe('msg-2')
    expect(msgs[2].role).toBe('system')
    expect(s.restoringSessionId).toBeNull()
    expect(s.restoringPhase).toBeNull()
  })
})

// ── Test: rewind 部分失败（failedFiles 非空）→ fail-visible 提示 ──────────

describe('executeRollbackPipeline rewind 部分文件失败', () => {
  beforeEach(() => { vi.clearAllMocks(); installRollbackTranscriptMock() })

  it('failedFiles 非空 → toast 告知 N 个文件未能恢复，对话照常回退', async () => {
    const messages = [
      buildMessage('msg-1', 'user', 'hello'),
      buildAssistant('msg-2', 'reply-1', 'run-a'),
      buildMessage('msg-3', 'user', 'world'),
      buildAssistant('msg-4', 'reply-2', 'run-b'),
    ]

    const { get, set, getState } = createStatefulStore({
      messagesBySessionId: { 'session-1': messages },
      checkpointsBySessionId: { 'session-1': { 'msg-2': 'cp-2', 'msg-4': 'cp-4' } },
    })

    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue({
      filesRestored: ['/ws/a.txt'],
      filesDeleted: [],
      failedFiles: ['/ws/b.txt', '/ws/c.txt'],
    })
    mockRollbackSession.mockResolvedValue({
      success: true,
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        safety_snapshot_ref: null,
        partial_success_details: null,
        resource_restore_state: null,
      },
    })

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => '/fake/path'),
      getChatClient: () => ({ messages: { list: vi.fn(async () => ({ messages: [] })) } }),
    })

    await actions.rollbackToCheckpoint('msg-3')

    expect(mockFileHistoryRewind).toHaveBeenCalledWith('session-1', 'run-b', undefined)
    // fail-visible：非空 failedFiles 必须明确告知，绝不静默成功
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('个文件未能恢复'),
        variant: 'warning',
      }),
    )
    // 不回滚对话
    expect(mockUnrevertSession).not.toHaveBeenCalled()
    const s = getState()
    expect(s.messagesBySessionId['session-1']).toHaveLength(3)
    expect(s.restoringSessionId).toBeNull()
  })
})

// ── Test: 无可回退锚点（目标后没有 agent run）：跳过文件恢复、绝不 reset ──

describe('executeRollbackPipeline 无可回退锚点', () => {
  beforeEach(() => { vi.clearAllMocks(); installRollbackTranscriptMock() })

  it('回退到末条 user（其后无 assistant）：不调 rewind、提示文件保持不变、对话仍回退', async () => {
    const messages = [
      buildMessage('msg-1', 'user', 'hello'),
      buildAssistant('msg-2', 'reply-1', 'run-a'),
      buildMessage('msg-3', 'user', 'world'), // 末条 user，还没触发 agent run → 无锚点
    ]

    const { get, set, getState } = createStatefulStore({
      messagesBySessionId: { 'session-1': messages },
      checkpointsBySessionId: { 'session-1': { 'msg-2': 'cp-2' } },
    })

    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue({ ...REWIND_OK })
    mockRollbackSession.mockResolvedValue({
      success: true,
      file_restore_success: true,
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        safety_snapshot_ref: null,
        partial_success_details: null,
        resource_restore_state: null,
      },
    })

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => '/fake/path'),
      getChatClient: () => ({ messages: { list: vi.fn(async () => ({ messages: [] })) } }),
    })

    // 回退到 msg-3（末条 user）：其后没有 assistant → resolveRewindAnchorId 返 null
    await actions.rollbackToCheckpoint('msg-3')

    const s = getState()

    // 关键：无锚点 → 不调 rewind，更不会 fallback 到 shadow git restore/initial
    expect(mockFileHistoryRewind).not.toHaveBeenCalled()
    expect(mockCheckpointInitial).not.toHaveBeenCalled()
    expect(mockCheckpointRestore).not.toHaveBeenCalled()
    // 明确告知用户：对话已回退，工作区文件保持不变
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '该消息没有可恢复的代码快照，已回退对话但工作区文件保持不变',
      }),
    )
    // 对话仍照常回退（backend rollback + 本地截断），并正常收尾
    expect(mockRollbackSession).toHaveBeenCalled()
    expect(s.restoringSessionId).toBeNull()
    expect(s.restoringPhase).toBeNull()
  })
})

// ── Test: P1-A editAndResend 文件回退失败时刹车（不自动重发）─────────────

describe('P1-A editAndResend 文件回退失败刹车', () => {
  beforeEach(() => { vi.clearAllMocks(); installRollbackTranscriptMock() })

  function setup() {
    installRollbackTranscriptMock()
    const messages = [
      buildMessage('msg-1', 'user', 'hello'),
      buildAssistant('msg-2', 'reply-1', 'run-a'),
      buildMessage('msg-3', 'user', 'world'),
      buildAssistant('msg-4', 'reply-2', 'run-b'),
    ]
    const mockSendMessage = vi.fn(async () => ({
      accepted: true as const,
      persisted: false,
      route: 'runtime' as const,
    }))
    const { get, set, getState } = createStatefulStore({
      messagesBySessionId: { 'session-1': messages },
      checkpointsBySessionId: { 'session-1': { 'msg-2': 'cp-2', 'msg-4': 'cp-4' } },
    })
    mockRollbackSession.mockResolvedValue({
      success: true,
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        safety_snapshot_ref: null,
        partial_success_details: null,
        resource_restore_state: null,
      },
    })
    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => '/fake/path'),
      getChatClient: () => ({ messages: { list: vi.fn(async () => ({ messages: [] })) } }),
      resendAfterRestore: mockSendMessage,
    })
    return { actions, getState, mockSendMessage }
  }

  it('无 file-history 账本且用户未显式授权 → 暂停自动重发并保留草稿', async () => {
    const { actions, getState, mockSendMessage } = setup()
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockRejectedValue(new Error('No file-history for thread'))

    // 编辑 user msg-3 + 恢复并发送：anchor = msg-4 的 run-b。
    await actions.restoreAndEdit('msg-3', 'edited content')

    expect(mockFileHistoryRewind).toHaveBeenCalledWith('session-1', 'run-b', undefined)
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockSetPrefillForSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ message: 'edited content' }),
    )
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
      title: '文件未能完整回退，已暂停自动发送，请检查工作区后手动发送',
      variant: 'warning',
    }))
    const s = getState()
    // 对话照常回退（keepCount=targetIdx=2 → 保留 msg-1, msg-2 + summary），不 reset / 不 unrevert
    const msgs = s.messagesBySessionId['session-1']
    expect(msgs[0].id).toBe('msg-1')
    expect(msgs[1].id).toBe('msg-2')
    expect(mockUnrevertSession).not.toHaveBeenCalled()
    expect(s.restoringSessionId).toBeNull()
  })

  it('预览已明确缺少账本且用户选择仅重写对话 → 同原因执行失败时继续重发', async () => {
    const { actions, mockSendMessage } = setup()
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockRejectedValue(new Error('No file-history for thread session-1'))

    actions.requestRewindPreview('session-1', 'msg-3', 'editAndResend', 'edited content')
    await actions.confirmRewindPreview({
      resourceRestorePlan: [],
      approvedUnavailableFileReason: 'no_file_history',
      contract: recoveryContract(),
    })

    expect(mockSendMessage).toHaveBeenCalledWith('edited content', undefined, undefined, 'session-1')
    expect(mockSetPrefillForSession).not.toHaveBeenCalled()
  })

  it('用户授权后执行阶段出现不同文件错误 → 不沿用旧许可并暂停重发', async () => {
    const { actions, mockSendMessage } = setup()
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockRejectedValue(new Error('snapshot not found for run-b'))

    actions.requestRewindPreview('session-1', 'msg-3', 'editAndResend', 'edited content')
    await actions.confirmRewindPreview({
      resourceRestorePlan: [],
      approvedUnavailableFileReason: 'no_file_history',
      contract: recoveryContract(),
    })

    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockSetPrefillForSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ message: 'edited content' }),
    )
  })

  it('空闲会话编辑重发时不取消下一轮', async () => {
    const { actions } = setup()
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue(REWIND_OK)

    await actions.restoreAndEdit('msg-3', 'edited content')

    expect(mockCancelActiveRun).not.toHaveBeenCalled()
  })

  it('执行时文件历史 IPC 已断开 → 不自动重发并保留编辑内容', async () => {
    const { actions, mockSendMessage } = setup()
    mockFileHistoryIsAvailable.mockReturnValue(false)

    await actions.restoreAndEdit('msg-3', 'edited content')

    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockSetPrefillForSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ message: 'edited content' }),
    )
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
      title: '文件未能完整回退，已暂停自动发送，请检查工作区后手动发送',
      variant: 'warning',
    }))
  })

  it('failedFiles 非空 → 不自动重发、提示已暂停自动发送', async () => {
    const { actions, mockSendMessage } = setup()
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue({
      filesRestored: ['/ws/a.txt'],
      filesDeleted: [],
      failedFiles: ['/ws/b.txt'],
    })

    await actions.restoreAndEdit('msg-3', 'edited content')

    expect(mockFileHistoryRewind).toHaveBeenCalledWith('session-1', 'run-b', undefined)
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '文件未能完整回退，已暂停自动发送，请检查工作区后手动发送',
        variant: 'warning',
      }),
    )
  })

  it('回退已应用但重发门禁拒绝 → 不反撤销，并完整保留编辑草稿', async () => {
    const { actions, mockSendMessage } = setup()
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue(REWIND_OK)
    mockSendMessage.mockResolvedValueOnce({
      accepted: false,
      persisted: false,
      reason: 'submission_gate_rejected',
    })
    const attachments = [{ id: 'attachment-1', name: 'note.txt' }] as ChatAttachment[]
    const contextBlocks = [{ type: 'file', path: '/tmp/note.txt' }]

    await actions.restoreAndEdit('msg-3', 'edited content', attachments, contextBlocks)

    expect(mockUnrevertSession).not.toHaveBeenCalled()
    expect(mockSetPrefillForSession).toHaveBeenCalledWith('session-1', {
      message: 'edited content',
      attachments: [expect.objectContaining({ id: 'attachment-1' })],
      contextBlocks,
    })
  })

  it('附件-only 编辑在回退后拒发时仍完整回填，不因正文为空丢失', async () => {
    const { actions, mockSendMessage } = setup()
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue(REWIND_OK)
    mockSendMessage.mockResolvedValueOnce({
      accepted: false,
      persisted: false,
      reason: 'submission_gate_rejected',
    })
    const attachments = [{ id: 'attachment-only', name: 'evidence.pdf' }] as ChatAttachment[]
    const contextBlocks = [{ type: 'file', path: '/tmp/evidence.pdf' }]

    await actions.restoreAndEdit('msg-3', '', attachments, contextBlocks)

    expect(mockUnrevertSession).not.toHaveBeenCalled()
    expect(mockSetPrefillForSession).toHaveBeenCalledWith('session-1', {
      message: '',
      attachments: [expect.objectContaining({ id: 'attachment-only' })],
      contextBlocks,
    })
  })

  it('回退已应用但发送入口抛错 → 不反撤销，并完整保留编辑草稿', async () => {
    const { actions, mockSendMessage } = setup()
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue(REWIND_OK)
    mockSendMessage.mockRejectedValueOnce(new Error('send boundary failed'))

    await actions.restoreAndEdit('msg-3', 'edited content')

    expect(mockUnrevertSession).not.toHaveBeenCalled()
    expect(mockSetPrefillForSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ message: 'edited content' }),
    )
  })

  it('rewind 成功（failedFiles 为空）→ 正常自动重发编辑后的内容', async () => {
    const { actions, mockSendMessage } = setup()
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue({ ...REWIND_OK, filesRestored: ['/ws/a.txt'] })

    await actions.restoreAndEdit('msg-3', 'edited content')

    expect(mockFileHistoryRewind).toHaveBeenCalledWith('session-1', 'run-b', undefined)
    // ：editAndResend 回退后立即接受回退、进不了 unrevert 态 → 不建 safety 快照，
    // 也不向 runtime 传 safetySnapshotHash（safetySnapshotRef 恒为 null）。
    expect(mockFileHistoryCreateSafetySnapshot).not.toHaveBeenCalled()
    // 文件回退成功 → 自动重发编辑后的新内容（attachments / contextBlocks 透传 undefined）
    expect(mockSendMessage).toHaveBeenCalledWith('edited content', undefined, undefined, 'session-1')
    expect(mockRollbackSessionTimeline).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      targetMessageId: 'msg-3',
      targetRole: 'user',
      targetContent: 'world',
      targetOccurrenceIndex: 1,
      mode: 'editAndResend',
      keepMessageCount: 2,
      spaceId: 'space-1',
      organizationId: 'organization-1',
    }))
    // 不弹"已暂停自动发送"
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('已暂停自动发送') }),
    )
  })

  it('已选择资源有恢复失败 → 不自动重发，并把编辑内容保留到输入框', async () => {
    const { actions, mockSendMessage } = setup()
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue(REWIND_OK)
    mockRestoreResources.mockResolvedValue({
      success: false,
      results: [{ resource_type: 'docs', resource_id: 'doc-1', success: false, error: 'restore failed' }],
      restored_count: 0,
      // 兼容异常 / 旧响应：即使缺少失败计数，业务 success=false 也必须刹车。
      failed_count: 0,
    })
    const plan = [{
      resource_type: 'docs',
      resource_id: 'doc-1',
      resource_name: '方案文档',
      action: 'restore_version' as const,
      action_label: '恢复',
      can_restore: true,
      restore_to_version_id: 'version-1',
      restore_to_version_time: '2026-04-05T00:00:00.000Z',
      change_count: 1,
    }]

    actions.requestRewindPreview('session-1', 'msg-3', 'editAndResend', 'edited content')
    await actions.confirmRewindPreview({
      resourceRestorePlan: plan,
      contract: recoveryContract({
        previewRevision: 'preview-edit-resource',
        filePreviewRevision: 'file-preview-edit-resource',
      }),
    })

    expect(mockRestoreResources).toHaveBeenCalledWith(
      'session-1',
      [expect.objectContaining({
        resource_type: 'docs',
        resource_id: 'doc-1',
        action: 'restore_version',
        restore_to_version_id: 'version-1',
      })],
      {
        rollbackContractVersion: 2,
        previewRevision: 'preview-edit-resource',
      },
    )
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockSetPrefillForSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ message: 'edited content' }),
    )
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
      title: '资源未能完整恢复，已暂停自动发送；编辑内容已保留',
      variant: 'warning',
    }))
  })

  it('已选择资源恢复请求异常 → 不自动重发，并保留编辑内容', async () => {
    const { actions, mockSendMessage } = setup()
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue(REWIND_OK)
    mockRestoreResources.mockRejectedValue(new Error('network unavailable'))
    const plan = [{
      resource_type: 'docs',
      resource_id: 'doc-1',
      resource_name: '方案文档',
      action: 'restore_version' as const,
      action_label: '恢复',
      can_restore: true,
      restore_to_version_id: 'version-1',
      restore_to_version_time: '2026-04-05T00:00:00.000Z',
      change_count: 1,
    }]

    actions.requestRewindPreview('session-1', 'msg-3', 'editAndResend', 'edited content')
    await actions.confirmRewindPreview({
      resourceRestorePlan: plan,
      contract: recoveryContract(),
    })

    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockSetPrefillForSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ message: 'edited content' }),
    )
  })

  it('用户显式跳过不可恢复资源 → 不视为恢复失败，继续重发', async () => {
    const { actions, mockSendMessage } = setup()
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue(REWIND_OK)
    mockRestoreResources.mockResolvedValue({
      success: true,
      results: [{ resource_type: 'docs', resource_id: 'doc-1', success: true, error: '' }],
      restored_count: 0,
      failed_count: 0,
    })
    const plan = [{
      resource_type: 'docs',
      resource_id: 'doc-1',
      resource_name: '无历史版本文档',
      action: 'skip' as const,
      action_label: '跳过',
      can_restore: false,
      restore_to_version_id: null,
      restore_to_version_time: null,
      change_count: 1,
    }]

    actions.requestRewindPreview('session-1', 'msg-3', 'editAndResend', 'edited content')
    await actions.confirmRewindPreview({
      resourceRestorePlan: plan,
      contract: recoveryContract(),
    })

    expect(mockRestoreResources).toHaveBeenCalledWith(
      'session-1',
      [{ resource_type: 'docs', resource_id: 'doc-1', action: 'skip', restore_to_version_id: null }],
      { rollbackContractVersion: 2, previewRevision: undefined },
    )
    expect(mockSendMessage).toHaveBeenCalledWith('edited content', undefined, undefined, 'session-1')
  })

  it('v2 资源恢复提交预览计划全集：选中项精确恢复，排除和不可恢复项显式 skip', async () => {
    const { actions, mockSendMessage } = setup()
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue(REWIND_OK)
    mockRestoreResources.mockResolvedValue({
      success: true,
      results: [
        { resource_type: 'docs', resource_id: 'doc-restore', success: true, error: '' },
        { resource_type: 'table', resource_id: 'table-skip', success: true, error: '' },
      ],
      restored_count: 1,
      failed_count: 0,
    })
    const plan = [
      {
        resource_type: 'docs',
        resource_id: 'doc-restore',
        resource_name: '方案文档',
        action: 'restore_version' as const,
        action_label: '恢复到 v7',
        can_restore: true,
        restore_to_version_id: 'version-7',
        restore_to_version_time: '2026-04-05T00:00:00.000Z',
        change_count: 1,
      },
      {
        resource_type: 'table',
        resource_id: 'table-skip',
        resource_name: '无版本数据表',
        action: 'no_version' as const,
        action_label: '无历史版本',
        can_restore: false,
        restore_to_version_id: null,
        restore_to_version_time: null,
        change_count: 1,
      },
    ]

    actions.requestRewindPreview('session-1', 'msg-3', 'editAndResend', 'edited content')
    await actions.confirmRewindPreview({
      resourceRestorePlan: plan,
      contract: recoveryContract({
        previewRevision: 'preview-full-plan',
        filePreviewRevision: 'file-preview-full-plan',
      }),
    })

    expect(mockRestoreResources).toHaveBeenCalledWith('session-1', [
      {
        resource_type: 'docs',
        resource_id: 'doc-restore',
        action: 'restore_version',
        restore_to_version_id: 'version-7',
      },
      {
        resource_type: 'table',
        resource_id: 'table-skip',
        action: 'skip',
        restore_to_version_id: null,
      },
    ], {
      rollbackContractVersion: 2,
      previewRevision: 'preview-full-plan',
    })
    expect(mockSendMessage).toHaveBeenCalledWith('edited content', undefined, undefined, 'session-1')
  })

  it('transcript 回退失败 → 不自动重发、提示已暂停自动发送', async () => {
    const { actions, mockSendMessage } = setup()
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue({ ...REWIND_OK, filesRestored: ['/ws/a.txt'] })
    mockRollbackSessionTimeline.mockResolvedValue({ success: false, error: 'transcript not writable' })

    await actions.restoreAndEdit('msg-3', 'edited content')

    expect(mockFileHistoryRewind).not.toHaveBeenCalled()
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '恢复失败，请稍后重试',
        variant: 'destructive',
      }),
    )
  })

  it('transcript applied=false → 不自动重发', async () => {
    const { actions, mockSendMessage } = setup()
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue({ ...REWIND_OK, filesRestored: ['/ws/a.txt'] })
    mockRollbackSessionTimeline.mockResolvedValue({ success: true, applied: false })

    await actions.restoreAndEdit('msg-3', 'edited content')

    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '恢复失败，请稍后重试',
        variant: 'destructive',
      }),
    )
  })

  it('transcript IPC 抛错 → 不自动重发', async () => {
    const { actions, mockSendMessage } = setup()
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue({ ...REWIND_OK, filesRestored: ['/ws/a.txt'] })
    mockRollbackSessionTimeline.mockRejectedValue(new Error('ipc failed'))

    await actions.restoreAndEdit('msg-3', 'edited content')

    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '恢复失败，请稍后重试',
        variant: 'destructive',
      }),
    )
  })

  it('本地 transcript IPC 不存在 → 不自动重发', async () => {
    const { actions, mockSendMessage } = setup()
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: { agentEngine: {} },
    })
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue({ ...REWIND_OK, filesRestored: ['/ws/a.txt'] })

    await actions.restoreAndEdit('msg-3', 'edited content')

    expect(mockRollbackSessionTimeline).not.toHaveBeenCalled()
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '恢复失败，请稍后重试',
        variant: 'destructive',
      }),
    )
  })

  it('daemon 宿主文件由后端处理 → runtime-first 后不调用本地 file rewind 且可自动重发', async () => {
    const { actions, mockSendMessage } = setup()
    mockRollbackSession.mockResolvedValue({
      success: true,
      file_restore_host: 'daemon',
      file_restore_success: true,
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        safety_snapshot_ref: null,
        partial_success_details: null,
        resource_restore_state: null,
      },
    })

    await actions.restoreAndEdit('msg-3', 'edited content')

    expect(mockRollbackSessionTimeline).toHaveBeenCalled()
    expect(mockFileHistoryRewind).not.toHaveBeenCalled()
    expect(mockSendMessage).toHaveBeenCalledWith('edited content', undefined, undefined, 'session-1')
  })

  it('rollbackToCheckpoint runtime 回退失败 → 不进入 UI 回退', async () => {
    const { actions, getState, mockSendMessage } = setup()
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue({ ...REWIND_OK, filesRestored: ['/ws/a.txt'] })
    mockRollbackSessionTimeline.mockRejectedValue(new Error('ipc failed'))

    await actions.rollbackToCheckpoint('msg-3')

    const msgs = getState().messagesBySessionId['session-1']
    expect(msgs.map(m => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4'])
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '回退失败，请稍后重试',
        variant: 'destructive',
      }),
    )
  })
})

// ── Test: createCheckpoint diff_summary 归因──────────────────────

describe('createCheckpoint diff_summary 本轮归因', () => {
  beforeEach(() => { vi.clearAllMocks(); installRollbackTranscriptMock() })

  it('有 baseline 且本轮无改动时不回退 vs parent，避免把预存脏文件挂到聊天气泡', async () => {
    const { get, set } = createStatefulStore({
      messagesBySessionId: {
        'session-1': [buildAssistant('msg-1', '收到视频', 'run-1')],
      },
    })

    mockCheckpointIsAvailable.mockReturnValue(true)
    mockCheckpointCommit.mockResolvedValue({ commitHash: 'commit-with-predirty' })
    mockCheckpointDiffSummary.mockImplementation(async (_path: string, _commit: string, baseline?: string) => {
      if (baseline) {
        return {
          summary: { changed: 0, insertions: 0, deletions: 0 },
          files: [],
        }
      }
      // vs parent：轮前脏文件——若被回退采用就会误标为本轮改动
      return {
        summary: { changed: 10, insertions: 701, deletions: 1 },
        files: [
          { path: 'hn_posts.json', status: 'modified', insertions: 242, deletions: 0 },
        ],
      }
    })
    mockPersistCheckpointHash.mockResolvedValue(undefined)

    const mockResolveSpacePath = vi.fn(async () => '/fake/path')
    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: mockResolveSpacePath,
      getChatClient: () => ({ messages: { list: vi.fn(async () => ({ messages: [] })) } }),
    })

    await actions.createCheckpoint('session-1', 'msg-1', undefined, {
      spaceId: 'space-1',
      baselineHash: 'baseline-tree-with-predirty',
      kind: 'agent_turn_done',
    })

    // ：createCheckpoint 必须按其操作的 sessionId 解析路径，而不是
    // 无参调用全局 active Space 根——否则绑定会话的 turn checkpoint 会误落主目录。
    expect(mockResolveSpacePath).toHaveBeenCalledWith('session-1')
    expect(mockCheckpointDiffSummary).toHaveBeenCalledTimes(1)
    expect(mockCheckpointDiffSummary).toHaveBeenCalledWith(
      '/fake/path',
      'commit-with-predirty',
      'baseline-tree-with-predirty',
    )
    expect(mockPersistCheckpointHash).toHaveBeenCalledWith(
      'msg-1',
      'commit-with-predirty',
      undefined,
      expect.objectContaining({ changed: 0, insertions: 0, deletions: 0, files: [] }),
    )
    expect(mockCreateSpaceCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      spaceId: 'space-1',
      agentRunId: 'run-1',
      anchorSessionId: 'session-1',
      anchorMessageId: 'msg-1',
    }))
  })

  it('本轮相对 baseline 确有改动时仍写入 baseline 窗口的 diff_summary', async () => {
    const { get, set } = createStatefulStore({
      messagesBySessionId: {
        'session-1': [buildAssistant('msg-1', '已写入笔记', 'run-1')],
      },
    })

    mockCheckpointIsAvailable.mockReturnValue(true)
    mockCheckpointCommit.mockResolvedValue({ commitHash: 'commit-real-edits' })
    mockCheckpointDiffSummary.mockResolvedValue({
      summary: { changed: 1, insertions: 12, deletions: 0 },
      files: [{ file: 'notes.md', status: 'added', insertions: 12, deletions: 0, binary: false }],
    })
    mockPersistCheckpointHash.mockResolvedValue(undefined)

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => '/fake/path'),
      getChatClient: () => ({ messages: { list: vi.fn(async () => ({ messages: [] })) } }),
    })

    await actions.createCheckpoint('session-1', 'msg-1', undefined, {
      baselineHash: 'baseline-clean',
      kind: 'agent_turn_done',
    })

    // ：本地消息立即带上 diff_summary，不必等 server reconcile
    const localMsg = get().messagesBySessionId['session-1']?.find((m) => m.id === 'msg-1')
    expect(localMsg?.checkpoint_hash).toBe('commit-real-edits')
    expect(localMsg?.diff_summary).toEqual(expect.objectContaining({
      changed: 1,
      insertions: 12,
      deletions: 0,
      files: [expect.objectContaining({
        file: 'notes.md',
        changes: 12,
        insertions: 12,
        deletions: 0,
        binary: false,
        status: 'added',
      })],
    }))

    expect(mockPersistCheckpointHash).toHaveBeenCalledWith(
      'msg-1',
      'commit-real-edits',
      undefined,
      expect.objectContaining({
        changed: 1,
        insertions: 12,
        files: [expect.objectContaining({ file: 'notes.md' })],
      }),
    )
  })
})

// ── Test: createCheckpoint 连续失败 → 健康降级 ──────────────────────────

describe('createCheckpoint 连续失败健康降级', () => {
  beforeEach(() => { vi.clearAllMocks(); installRollbackTranscriptMock() })

  it('连续 3 次失败：failCount 递增，但 health 不再降级（P2-1：shadow-git 失败不驱动虚假告警 badge/toast）', async () => {
    const { get, set, getState } = createStatefulStore()

    mockCheckpointIsAvailable.mockReturnValue(true)
    // contract W2-β: checkpointIpc.commit 失败路径直接 throw；caller try/catch 走 recordCheckpointFailure。
    mockCheckpointCommit.mockRejectedValue(new Error('disk full'))

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => '/fake/path'),
      getChatClient: () => ({ messages: { list: vi.fn(async () => ({ messages: [] })) } }),
    })

    // P2-1：回退已切 per-file，shadow-git checkpoint commit 失败**不影响**回退能力。
    // failCount 仍累计供调试，但**不再写 checkpointHealth**——它曾驱动 MessageActions 的
    // 「回退功能暂不可用」warning badge + toast（同一句虚假告警，挂在已不负责回退的
    // shadow-git 创建侧）。现 health 恒 undefined → badge/toast 都不弹。
    await actions.createCheckpoint('session-1', 'msg-1')
    expect(getState().checkpointFailCountBySessionId['session-1']).toBe(1)
    expect(getState().checkpointHealthBySessionId['session-1']).toBeUndefined()

    await actions.createCheckpoint('session-1', 'msg-2')
    expect(getState().checkpointFailCountBySessionId['session-1']).toBe(2)
    expect(getState().checkpointHealthBySessionId['session-1']).toBeUndefined()

    await actions.createCheckpoint('session-1', 'msg-3')
    expect(getState().checkpointFailCountBySessionId['session-1']).toBe(3)
    expect(getState().checkpointHealthBySessionId['session-1']).toBeUndefined()
  })
})

// ── Test: confirmRewindPreview 基本流程 ──────────────────────────────────

describe('confirmRewindPreview 基本流程', () => {
  beforeEach(() => { vi.clearAllMocks(); installRollbackTranscriptMock() })

  it('rewindPreview 被清空、对应的 rollback 函数被调用（safetyHash 降级为 undefined）', async () => {
    const messages = [
      buildMessage('msg-1', 'user', 'hello'),
      buildAssistant('msg-2', 'reply-1', 'run-a'),
      buildMessage('msg-3', 'user', 'world'),
      buildAssistant('msg-4', 'reply-2', 'run-b'),
    ]

    const { get, set, getState } = createStatefulStore({
      messagesBySessionId: { 'session-1': messages },
      checkpointsBySessionId: { 'session-1': { 'msg-2': 'cp-2', 'msg-4': 'cp-4' } },
    })

    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue({ ...REWIND_OK })
    mockRollbackSession.mockResolvedValue({
      success: true,
      file_restore_success: true,
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        safety_snapshot_ref: null,
        partial_success_details: null,
        resource_restore_state: null,
      },
    })

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => '/fake/path'),
      getChatClient: () => ({ messages: { list: vi.fn(async () => ({ messages: [] })) } }),
    })

    // 本地消息会推导出 run-b，但执行必须消费用户已确认的服务端计划锚点，
    // 不能再次用消息缓存否决或覆盖它。
    actions.requestRewindPreview('session-1', 'msg-2', 'rollback')
    expect(getState().rewindPreview).not.toBeNull()

    await actions.confirmRewindPreview({
      contract: recoveryContract({
        previewRevision: 'preview-revision-rollback',
        filePreviewRevision: 'file-preview-revision-rollback',
        fileAnchor: { id: 'run-from-preview', source: 'preview' },
      }),
    })

    expect(getState().rewindPreview).toBeNull()
    expect(mockFileHistoryRewind).toHaveBeenCalledWith(
      'session-1',
      'run-from-preview',
      'file-preview-revision-rollback',
    )
    const msgsAfter = getState().messagesBySessionId['session-1']
    expect(msgsAfter.some(m => m.id === 'msg-2')).toBe(true)
    expect(msgsAfter.some(m => m.id === 'msg-1')).toBe(true)
    expect(msgsAfter.some(m => m.id === 'msg-3')).toBe(false)
    expect(msgsAfter.some(m => m.id === 'msg-4')).toBe(false)
    expect(mockFileHistoryCreateSafetySnapshot).toHaveBeenCalledWith(
      'session-1',
      expect.stringMatching(/^safety:session-1:\d+$/),
    )
    expect(mockRollbackSessionTimeline).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      targetMessageId: 'msg-2',
      targetRole: 'assistant',
      targetContent: 'reply-1',
      mode: 'rollback',
      keepMessageCount: 2,
      previewRevision: 'preview-revision-rollback',
      filePreviewRevision: 'file-preview-revision-rollback',
      fileRewindAnchorId: 'run-from-preview',
      rollbackContractVersion: 2,
      safetySnapshotHash: expect.stringMatching(/^safety:session-1:\d+$/),
    }))
  })
})

// ── Test: unrevertSession happy path ────────────────────────────────────

describe('unrevertSession happy path', () => {
  beforeEach(() => { vi.clearAllMocks(); installRollbackTranscriptMock() })

  it('syncMessagesFromServer 被调用、clearSessionCache 被调用、session 恢复正常', async () => {
    const mockMessagesList = vi.fn(async () => ({ messages: [] }))

    const { get, set, getState } = createStatefulStore({
      sessions: [
        buildSession({
          session_id: 'session-1',
          revert_active: true,
          can_unrevert: true,
          safety_snapshot_ref: 'safety:session-1:1234567890',
          cleanup_status: 'pending',
          last_apply_result: 'success',
          partial_success_details: null,
          resource_restore_state: null,
          updated_at: '2026-04-05T00:00:00.000Z',
        }),
      ],
    })

    mockCheckpointIsAvailable.mockReturnValue(true)
    mockCheckpointRestore.mockResolvedValue({ success: true })
    mockFileHistoryRewind.mockResolvedValue({ filesRestored: ['a.txt'], filesDeleted: [], failedFiles: [] })
    mockUnrevertSession.mockResolvedValue({
      success: true,
      snapshot_hash: null,
      message: 'ok',
      rollback_state: {
        session_id: 'session-1',
        revert_active: false,
        can_unrevert: false,
        partial_success_details: null,
        resource_restore_state: null,
      },
    })

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => '/fake/path'),
      getChatClient: () => ({ messages: { list: mockMessagesList } }),
    })

    await actions.unrevertSession('session-1')

    expect(mockFileHistoryRewind).toHaveBeenCalledWith('session-1', 'safety:session-1:1234567890')
    expect(mockMessagesList).toHaveBeenCalledWith('session-1', { limit: 500 })
    expect(mockClearSessionCache).toHaveBeenCalledWith('session-1')

    const s = getState()
    expect(s.restoringSessionId).toBeNull()
  })
})

// ── Test:  整表替换的未落库保护 ─────────────────────────────────────

describe('#2822 syncMessagesFromServer 未落库保护（内容态保留）', () => {
  beforeEach(() => { vi.clearAllMocks(); installRollbackTranscriptMock() })

  it('整表替换按内容态保留未落库的 runtime 起源消息，不删用户刚看到的内容', async () => {
    const serverRow = buildMessage('11111111-aaaa-4aaa-8aaa-111111111111', 'user', '已落库 user')
    const unpersisted = { ...buildAssistant('local-session-1-1783998941-ab', '刚看到但未落库', 'run-x'), created_at: '2026-04-05T00:01:00.000Z' }
    const { get, set, getState } = createStatefulStore({
      messagesBySessionId: { 'session-1': [serverRow, unpersisted] },
    })

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => null),
      //  self-heal 场景：服务端只有 1 条（relay 迟延，目标未落库）
      getChatClient: () => ({ messages: { list: vi.fn(async () => ({ messages: [serverRow] })) } }),
    })

    await actions.resyncMessagesAfterMissingTarget('session-1')

    const ids = getState().messagesBySessionId['session-1'].map((m: ChatMessage) => m.id)
    expect(ids).toContain('local-session-1-1783998941-ab')
    expect(ids).toContain('11111111-aaaa-4aaa-8aaa-111111111111')
  })

  it('整表替换：local- 前缀未落库消息同样按内容态保留（不再区分观察端）', async () => {
    const serverRow = buildMessage('11111111-aaaa-4aaa-8aaa-111111111111', 'user', '已落库 user')
    const unpersisted = { ...buildAssistant('local-session-1-1783998941-ab', '执行端 live 镜像', 'run-x'), created_at: '2026-04-05T00:01:00.000Z' }
    const { get, set, getState } = createStatefulStore({
      messagesBySessionId: { 'session-1': [serverRow, unpersisted] },
    })

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => null),
      getChatClient: () => ({ messages: { list: vi.fn(async () => ({ messages: [serverRow] })) } }),
    })

    await actions.resyncMessagesAfterMissingTarget('session-1')

    const ids = getState().messagesBySessionId['session-1'].map((m: ChatMessage) => m.id)
    expect(ids).toContain('local-session-1-1783998941-ab')
  })
})

// ── Test: reconcileSessionState crash recovery ──────────────────────────

describe('reconcileSessionState 崩溃恢复', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetReconciledSessions()
  })

  it('reverted session 触发 syncMessagesFromServer 并缓存结果', async () => {
    const serverMessages = [
      buildMessage('msg-1', 'user', 'hello'),
      buildMessage('msg-2', 'assistant', 'reply', 'cp-2'),
    ]
    const mockMessagesList = vi.fn(async () => ({ messages: serverMessages }))

    const { get, set } = createStatefulStore({
      sessions: [
        buildSession({
          session_id: 'session-1',
          revert_active: true,
          can_unrevert: true,
          cleanup_status: 'pending',
          last_apply_result: 'success',
          partial_success_details: null,
          resource_restore_state: null,
          updated_at: '2026-04-05T00:00:00.000Z',
        }),
      ],
      messagesBySessionId: { 'session-1': [buildMessage('old-1', 'user', 'stale')] },
    })

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => null),
      getChatClient: () => ({ messages: { list: mockMessagesList } }),
    })

    const handled = actions.reconcileSessionState('session-1')
    expect(handled).toBe(true)

    // 等待异步 sync 完成
    await vi.waitFor(() => {
      expect(mockMessagesList).toHaveBeenCalledWith('session-1', { limit: 500 })
    })
    await vi.waitFor(() => {
      expect(mockCacheMessages).toHaveBeenCalledWith('session-1', serverMessages)
    })
  })

  it('非 reverted session 不触发 sync，返回 false', () => {
    const mockMessagesList = vi.fn()
    const { get, set } = createStatefulStore({
      sessions: [buildSession(null)],
    })

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => null),
      getChatClient: () => ({ messages: { list: mockMessagesList } }),
    })

    const handled = actions.reconcileSessionState('session-1')
    expect(handled).toBe(false)
    expect(mockMessagesList).not.toHaveBeenCalled()
  })

  it('重复调用同一 session 被去重，返回 false', async () => {
    const mockMessagesList = vi.fn(async () => ({ messages: [] }))
    const { get, set } = createStatefulStore({
      sessions: [
        buildSession({
          session_id: 'session-1',
          revert_active: true,
          can_unrevert: true,
          cleanup_status: 'pending',
          last_apply_result: 'success',
          partial_success_details: null,
          resource_restore_state: null,
          updated_at: '2026-04-05T00:00:00.000Z',
        }),
      ],
    })

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => null),
      getChatClient: () => ({ messages: { list: mockMessagesList } }),
    })

    const first = actions.reconcileSessionState('session-1')
    expect(first).toBe(true)

    // 等待首次 sync 完成
    await vi.waitFor(() => {
      expect(mockMessagesList).toHaveBeenCalledTimes(1)
    })

    const second = actions.reconcileSessionState('session-1')
    expect(second).toBe(false)
    expect(mockMessagesList).toHaveBeenCalledTimes(1)
  })

  it('sync 失败时清除去重标记，下次可重试', async () => {
    const mockMessagesList = vi.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ messages: [] })

    const { get, set } = createStatefulStore({
      sessions: [
        buildSession({
          session_id: 'session-1',
          revert_active: true,
          can_unrevert: true,
          cleanup_status: 'pending',
          last_apply_result: 'success',
          partial_success_details: null,
          resource_restore_state: null,
          updated_at: '2026-04-05T00:00:00.000Z',
        }),
      ],
    })

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => null),
      getChatClient: () => ({ messages: { list: mockMessagesList } }),
    })

    const first = actions.reconcileSessionState('session-1')
    expect(first).toBe(true)

    // 等待失败的 sync 完成
    await vi.waitFor(() => {
      expect(mockMessagesList).toHaveBeenCalledTimes(1)
    })

    // 失败后去重标记被清除，可以重试
    await vi.waitFor(() => {
      const retry = actions.reconcileSessionState('session-1')
      expect(retry).toBe(true)
    })
    await vi.waitFor(() => {
      expect(mockMessagesList).toHaveBeenCalledTimes(2)
    })
  })
})

// ── Test: apply_result.layers 分层展示 + partial_success_details 对齐 ─────

describe('buildApplyLayerSummaryLines / derivePartialSuccessDetailsFromLayers', () => {
  it('逐层拼中文摘要行，not_applicable 层跳过、resources 带成败计数', () => {
    const lines = buildApplyLayerSummaryLines({
      conversation: { status: 'success' },
      workspace_files: { status: 'failed', reason: 'path guard denied' },
      resources: { status: 'partial_success', restored_count: 2, failed_count: 1 },
      pg_state: { status: 'not_applicable' },
    })
    expect(lines).toEqual([
      '对话：已完成',
      '文件：失败（path guard denied）',
      '资源：部分成功（{{restored}} 成功 / {{failed}} 失败）',
    ])
  })

  it('从 layers 推导 partial_success_details；全 success 时返回 null', () => {
    expect(derivePartialSuccessDetailsFromLayers({
      conversation: { status: 'success' },
      workspace_files: { status: 'success' },
      resources: { status: 'success' },
      pg_state: { status: 'success' },
    })).toBeNull()

    const derived = derivePartialSuccessDetailsFromLayers({
      conversation: { status: 'success' },
      workspace_files: { status: 'failed', reason: 'rewind failed' },
      resources: {
        status: 'partial_success',
        restored_count: 1,
        failed_count: 2,
        retryable: [{ resource_type: 'tabdoc', resource_id: 'doc-1', action: 'restore_version' }],
      },
      pg_state: { status: 'success' },
    })
    expect(derived).toEqual({
      workspace_files: { success: false, reason: 'rewind failed' },
      resources: {
        restored_count: 1,
        failed_count: 2,
        retryable: [{ resource_type: 'tabdoc', resource_id: 'doc-1', action: 'restore_version' }],
        collab_sync_warnings: [],
      },
    })
  })
})

describe('executeRollbackPipeline partial_success 分层 toast', () => {
  beforeEach(() => { vi.clearAllMocks(); installRollbackTranscriptMock() })

  it('overall_status=partial_success → warning/destructive toast 逐层展示，且 details 对齐写入 rollback_state', async () => {
    const messages = [
      buildMessage('msg-1', 'user', 'hello'),
      buildAssistant('msg-2', 'reply-1', 'run-a'),
    ]

    const { get, set, getState } = createStatefulStore({
      messagesBySessionId: { 'session-1': messages },
      checkpointsBySessionId: { 'session-1': { 'msg-2': 'cp-2' } },
    })

    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue({ ...REWIND_OK })
    mockRollbackSession.mockResolvedValue({
      success: true,
      file_restore_success: true,
      overall_status: 'partial_success',
      // rollback_state 缺 partial_success_details → 应从 layers 推导补齐
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        safety_snapshot_ref: null,
        partial_success_details: null,
        resource_restore_state: null,
      },
      apply_result: {
        apply_id: 'apply-1',
        overall_status: 'partial_success',
        session_state: { session_id: 'session-1', revert_active: true, cleanup_status: 'pending', can_unrevert: true },
        layers: {
          conversation: { status: 'success' },
          workspace_files: { status: 'success' },
          resources: { status: 'partial_success', restored_count: 1, failed_count: 1 },
          pg_state: { status: 'not_applicable' },
        },
      },
    })

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => '/fake/path'),
      getChatClient: () => ({ messages: { list: vi.fn(async () => ({ messages: [] })) } }),
    })

    await actions.rollbackToCheckpoint('msg-2')

    // 分层 toast：无 failed 层 → warning；description 含逐层摘要
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
      title: '回退部分完成',
      variant: 'warning',
      description: expect.stringContaining('对话：已完成'),
    }))
    const toastArg = mockToast.mock.calls.find(c => c[0]?.title === '回退部分完成')?.[0] as { description: string }
    expect(toastArg.description).toContain('资源：部分成功')

    // partial_success_details 从 layers 对齐写入 session 缓存
    const session = getState().sessions.find(s => s.id === 'session-1')
    expect(session?.rollback_state?.partial_success_details).toEqual({
      resources: {
        restored_count: 1,
        failed_count: 1,
        retryable: [],
        collab_sync_warnings: [],
      },
    })
  })

  it('有 failed 层时用 destructive 变体；overall success 时不弹分层 toast', async () => {
    const messages = [
      buildMessage('msg-1', 'user', 'hello'),
      buildAssistant('msg-2', 'reply-1', 'run-a'),
    ]

    const buildStore = () => createStatefulStore({
      messagesBySessionId: { 'session-1': messages },
      checkpointsBySessionId: { 'session-1': { 'msg-2': 'cp-2' } },
    })

    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue({ ...REWIND_OK })

    // Case A: workspace_files failed → destructive
    mockRollbackSession.mockResolvedValue({
      success: true,
      overall_status: 'partial_success',
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        safety_snapshot_ref: null,
        partial_success_details: null,
        resource_restore_state: null,
      },
      apply_result: {
        apply_id: 'apply-2',
        overall_status: 'partial_success',
        session_state: { session_id: 'session-1', revert_active: true, cleanup_status: 'pending', can_unrevert: true },
        layers: {
          conversation: { status: 'success' },
          workspace_files: { status: 'failed', reason: 'rewind failed' },
          resources: { status: 'not_applicable' },
          pg_state: { status: 'not_applicable' },
        },
      },
    })

    {
      const { get, set } = buildStore()
      const actions = createCheckpointActions(get, set, {
        resolveSpacePath: vi.fn(async () => '/fake/path'),
        getChatClient: () => ({ messages: { list: vi.fn(async () => ({ messages: [] })) } }),
      })
      await actions.rollbackToCheckpoint('msg-2')
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
        title: '回退部分完成',
        variant: 'destructive',
      }))
    }

    // Case B: overall success → 不弹分层 toast
    vi.clearAllMocks()
    installRollbackTranscriptMock()
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue({ ...REWIND_OK })
    mockRollbackSession.mockResolvedValue({
      success: true,
      overall_status: 'success',
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        safety_snapshot_ref: null,
        partial_success_details: null,
        resource_restore_state: null,
      },
      apply_result: {
        apply_id: 'apply-3',
        overall_status: 'success',
        session_state: { session_id: 'session-1', revert_active: true, cleanup_status: 'pending', can_unrevert: true },
        layers: {
          conversation: { status: 'success' },
          workspace_files: { status: 'success' },
          resources: { status: 'success' },
          pg_state: { status: 'success' },
        },
      },
    })

    {
      const { get, set } = buildStore()
      const actions = createCheckpointActions(get, set, {
        resolveSpacePath: vi.fn(async () => '/fake/path'),
        getChatClient: () => ({ messages: { list: vi.fn(async () => ({ messages: [] })) } }),
      })
      await actions.rollbackToCheckpoint('msg-2')
      expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({
        title: '回退部分完成',
      }))
    }
  })
})

describe('createManualCheckpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateSpaceCheckpoint.mockResolvedValue({ id: 'cp-manual-1' })
  })

  it('无当前 session 时提示并跳过', async () => {
    const { get, set } = createStatefulStore({ currentSessionId: null })
    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => '/fake/path'),
      getChatClient: () => ({ messages: { list: vi.fn(async () => ({ messages: [] })) } }),
    })

    await actions.createManualCheckpoint(null)

    expect(mockCreateSpaceCheckpoint).not.toHaveBeenCalled()
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }))
  })

  it('成功创建 manual SpaceCheckpoint 并 toast 成功', async () => {
    const { get, set } = createStatefulStore({
      currentSessionId: 'session-1',
      sessions: [buildSession(null)],
    })

    mockCheckpointIsAvailable.mockReturnValue(true)
    mockCheckpointCommit.mockResolvedValue({ commitHash: 'abc123', skipped: false })
    mockCheckpointDiffSummary.mockResolvedValue({
      summary: { changed: 1, insertions: 2, deletions: 0 },
      files: [],
    })

    const mockResolveSpacePath = vi.fn(async () => '/fake/path')
    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: mockResolveSpacePath,
      getChatClient: () => ({ messages: { list: vi.fn(async () => ({ messages: [] })) } }),
    })

    await actions.createManualCheckpoint()

    // ：checkpoint 路径解析必须带上具体 sessionId，而不是无参调用
    // 全局 active Space 根——否则绑定会话的 manual snapshot 会静默落回主目录。
    expect(mockResolveSpacePath).toHaveBeenCalledWith('session-1')
    expect(mockCheckpointCommit).toHaveBeenCalledWith('/fake/path', expect.objectContaining({
      kind: 'manual',
      trigger: 'manual',
      allowEmpty: true,
    }))
    expect(mockCreateSpaceCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      spaceId: 'space-1',
      fileCheckpointHash: 'abc123',
      trigger: 'manual',
      anchorSessionId: 'session-1',
    }))
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' }))
  })

  it('后端 createSpaceCheckpoint 失败时 toast 失败', async () => {
    const { get, set } = createStatefulStore({
      currentSessionId: 'session-1',
      sessions: [buildSession(null)],
    })

    mockCheckpointIsAvailable.mockReturnValue(false)
    mockCreateSpaceCheckpoint.mockResolvedValue(null)

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => null),
      getChatClient: () => ({ messages: { list: vi.fn(async () => ({ messages: [] })) } }),
    })

    await actions.createManualCheckpoint()

    expect(mockCreateSpaceCheckpoint).toHaveBeenCalled()
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }))
  })
})

// ── Test:  getCheckpointDiff 按 sessionId 解析路径 ─────────────

describe('getCheckpointDiff（ sessionId 透传）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCheckpointIsAvailable.mockReturnValue(true)
  })

  it('传入 sessionId 时按该会话执行根解析路径，而非无参调用全局 active Space 根', async () => {
    const { get, set } = createStatefulStore({})
    const mockResolveSpacePath = vi.fn(async () => '/bound/root')
    mockCheckpointDiff.mockResolvedValue({ diffs: [] })

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: mockResolveSpacePath,
      getChatClient: () => ({ messages: { list: vi.fn(async () => ({ messages: [] })) } }),
    })

    await actions.getCheckpointDiff('commit-hash', 'session-bound')

    expect(mockResolveSpacePath).toHaveBeenCalledWith('session-bound')
    expect(mockCheckpointDiff).toHaveBeenCalledWith('/bound/root', 'commit-hash')
  })

  it('缺省 sessionId 时行为与改动前一致——调用 resolveSpacePath(undefined)', async () => {
    const { get, set } = createStatefulStore({})
    const mockResolveSpacePath = vi.fn(async () => '/space/root')
    mockCheckpointDiff.mockResolvedValue({ diffs: [] })

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: mockResolveSpacePath,
      getChatClient: () => ({ messages: { list: vi.fn(async () => ({ messages: [] })) } }),
    })

    await actions.getCheckpointDiff('commit-hash')

    expect(mockResolveSpacePath).toHaveBeenCalledWith(undefined)
    expect(mockCheckpointDiff).toHaveBeenCalledWith('/space/root', 'commit-hash')
  })
})

// ── Test:  全量回退不残留空 interrupted 壳 / finalizing 中止 ─────────

describe('#9066 editAndResend strips empty interrupted assistant shells', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installRollbackTranscriptMock()
    _resetReconciledSessions()
  })

  it('keep 前缀里的空已中断壳在写出前被剥掉，不与 rewind-summary 并排', async () => {
    const emptyInterrupted = {
      ...buildAssistant('msg-empty', '', 'run-empty'),
      intent: 'interrupted' as const,
      content_blocks_json: [],
    }
    const messages = [
      buildMessage('msg-1', 'user', 'hello'),
      emptyInterrupted,
      buildMessage('msg-3', 'user', 'world'),
      buildAssistant('msg-4', 'reply-2', 'run-b'),
    ]
    const mockSendMessage = vi.fn(async () => ({
      accepted: true as const,
      persisted: false,
      route: 'runtime' as const,
    }))
    const { get, set, getState } = createStatefulStore({
      messagesBySessionId: { 'session-1': messages },
    })
    mockFileHistoryIsAvailable.mockReturnValue(true)
    mockFileHistoryRewind.mockResolvedValue(REWIND_OK)
    mockRollbackSession.mockResolvedValue({
      success: true,
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        safety_snapshot_ref: null,
        partial_success_details: null,
        resource_restore_state: null,
      },
    })

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => '/fake/path'),
      getChatClient: () => ({ messages: { list: vi.fn(async () => ({ messages: [] })) } }),
      resendAfterRestore: mockSendMessage,
    })

    await actions.restoreAndEdit('msg-3', 'edited content')

    const msgs = getState().messagesBySessionId['session-1']
    expect(msgs.map((m) => m.id)).not.toContain('msg-empty')
    expect(msgs[0]?.id).toBe('msg-1')
    expect(msgs.some((m) => m.role === 'system' && String(m.content).includes('回退完成'))).toBe(false)
    expect(mockSendMessage).toHaveBeenCalledWith('edited content', undefined, undefined, 'session-1')
  })

  it('finalizing 时 LIVE 目标消息消失则中止硬截并 unrevert', async () => {
    const messages = [
      buildMessage('msg-1', 'user', 'hello'),
      buildAssistant('msg-2', 'reply-1', 'run-a'),
      buildMessage('msg-3', 'user', 'world'),
      buildAssistant('msg-4', 'reply-2', 'run-b'),
    ]
    const { get, set, getState } = createStatefulStore({
      messagesBySessionId: { 'session-1': messages },
    })
    mockFileHistoryIsAvailable.mockReturnValue(false)
    mockRollbackSession.mockResolvedValue({
      success: true,
      rollback_state: {
        session_id: 'session-1',
        revert_active: true,
        safety_snapshot_ref: null,
        partial_success_details: null,
        resource_restore_state: null,
      },
    })
    mockUnrevertSession.mockResolvedValue({
      success: true,
      rollback_state: {
        session_id: 'session-1',
        revert_active: false,
        can_unrevert: false,
        partial_success_details: null,
        resource_restore_state: null,
      },
    })

    // 后端回退后、finalizing 前清空 LIVE，模拟目标被并发冲掉。
    mockRollbackSessionTimeline.mockImplementation(async () => {
      const backend = await mockRollbackSession()
      set({
        messagesBySessionId: {
          'session-1': [buildMessage('msg-other', 'user', 'replaced')],
        },
      })
      return { success: true, applied: true, backend }
    })

    const actions = createCheckpointActions(get, set, {
      resolveSpacePath: vi.fn(async () => '/fake/path'),
      getChatClient: () => ({
        messages: { list: vi.fn(async () => ({ messages: [buildMessage('msg-1', 'user', 'hello')] })) },
      }),
    })

    await actions.rollbackToCheckpoint('msg-3')

    expect(mockUnrevertSession).toHaveBeenCalledWith('session-1')
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
      title: '文件恢复失败，对话状态已自动还原',
      variant: 'destructive',
    }))
    // 未写出硬截时间线（仍是 mock 清空后的 LIVE，或 sync 后的列表）
    const msgs = getState().messagesBySessionId['session-1']
    expect(msgs.some((m) => m.role === 'system' && String(m.content).includes('回退完成'))).toBe(false)
    expect(getState().restoringSessionId).toBeNull()
  })
})
