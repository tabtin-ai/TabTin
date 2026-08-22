import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatClient, ChatMessage, ChatSession } from '@tabtin/chat-client'

const {
  runtimeState,
  streamTestBridge,
  mockCreateActionRequiredHandler,
  localStream,
  spaceStateMock,
  deviceStateMock,
  mockElectronFetch,
  mockGatewayRequest,
  mockUploadAllAttachments,
  mockUploadQueueAddTask,
  mockUploadQueueUpdateTask,
  mockUploadQueueRegisterCancelCallback,
  mockStreamAfterAck,
  mockRuntimeQueryFailure,
} = vi.hoisted(() => ({
  streamTestBridge: {
    store: null as import('../sendMessageAction').SendMessageStore | null,
    updateSessionMessages: null as ((
      sessionId: string,
      updater: (messages: ChatMessage[]) => ChatMessage[],
    ) => void) | null,
    set: null as ((partial: Partial<import('../sendMessageAction').SendMessageStore>) => void) | null,
  },
  runtimeState: {
    agentModeBySessionId: {} as Record<string, string>,
    //  历史兼容：旧版对话级审批档覆盖——与真实 store 初始态同构。
    approvalModeBySessionId: {} as Record<string, string>,
    // group 模式守卫上下文（getAgentModeResolutionContextForSession 读）——与真实
    // useChatRuntimeStore 初始态同构（`{}`），否则 sendMessage 解析 mode 时空读崩。
    groupRuntimeBySessionId: {} as Record<string, unknown>,
    assistantEventsBySessionId: {} as Record<string, unknown>,
    toolEventsBySessionId: {} as Record<string, unknown[]>,
    uploadProgressBySessionId: {} as Record<string, number>,
    clearAgentStepsForSession: vi.fn(),
    clearToolEventsForSession: vi.fn(),
    clearSubagentRunsForSession: vi.fn(),
    setUploadAbortController: vi.fn(),
    clearUploadAbortController: vi.fn(),
    setActiveSubmittedMessageForSession: vi.fn(),
    clearActiveSubmittedMessage: vi.fn(),
    updateRunStateForSession: vi.fn(),
    pushAgentStepForSession: vi.fn(),
    isSessionOriginatedHere: vi.fn(() => true),
    markSessionOriginatedHere: vi.fn(),
    // Widget Wave 3：跨 turn 残留污染清理——sendMessage 启动新 turn 前清掉
    // streamingRichBlocks 让上 turn cancel widget 不显示在新对话里。
    clearRichContentBlocks: vi.fn(),
    setPrefillForSession: vi.fn(),
    runProjectionBySessionId: {} as Record<string, { busy?: boolean }>,
    // cleanupSessionOnTerminal（onError 终态收尾）读写以下字段/方法——缺失会让
    // onError 在 markMessageFailed 之前 TypeError 中断（错误被 stream 吞掉后
    // 用户消息永卡 'sending'，测试断言全歪）。
    agentStepsBySessionId: {} as Record<string, unknown[]>,
    messageMetaBySessionId: {} as Record<string, Record<string, unknown>>,
    runStateBySessionId: {} as Record<string, unknown>,
    subagentRunsBySessionId: {} as Record<string, unknown[]>,
    cancellingBySessionId: {} as Record<string, boolean>,
    contentBlocksLastSeqBySessionId: {} as Record<string, number>,
    setCancellingForSession: vi.fn(),
    finalizeInFlightToolEventsForSession: vi.fn(),
    messageStop: vi.fn(),
    messageStart: vi.fn(),
    resetAssistantDeltasForSession: vi.fn(),
    getEffectiveToolEventForSession: vi.fn(() => undefined),
    upsertAssistantEventForSession: vi.fn(),
    upsertSubagentRunForSession: vi.fn(),
    setTodosForSession: vi.fn(),
    appendRichContentBlocks: vi.fn(),
    upsertRichContentBlocksByToolCallId: vi.fn(),
    markStreamingWidgetsInterruptedAndClearOthers: vi.fn(),
    pushSnapshotForSession: vi.fn(),
  },
  mockCreateActionRequiredHandler: vi.fn(() => vi.fn()),
  localStream: vi.fn(),
  mockElectronFetch: vi.fn(),
  mockGatewayRequest: vi.fn(),
  mockUploadAllAttachments: vi.fn(),
  mockUploadQueueAddTask: vi.fn(),
  mockUploadQueueUpdateTask: vi.fn(),
  mockUploadQueueRegisterCancelCallback: vi.fn(),
  // ：query 先返回 ACK，流放到 macrotask；测试 await send 后再 await 此 Promise。
  mockStreamAfterAck: { current: null as Promise<void> | null },
  // ACK 前拒绝表示 runtime 没有接收；ACK 后流终态失败则已经被接收。
  mockRuntimeQueryFailure: { current: null as Error | null },
  // PR4-yolo：可变 selectedAgent / selectedSpace，让每个 test 单独覆盖 gate / group。
  spaceStateMock: {
    selectedSpace: {
      id: 'space-1',
      name: 'Space One',
      type: 'workspace' as string | undefined,
      approval_grant: undefined as string | null | undefined,
    } as {
      id: string
      name: string
      type?: string
      approval_grant?: string | null
      project_id?: string | null
      is_archived?: boolean
    },
    selectedAgent: {
      id: 'agent-1',
      agent_config: {
        use_local_runtime: true,
      } as Record<string, unknown>,
    },
    spaces: [] as unknown[],
    agentCache: {} as Record<string, unknown>,
    loadAgent: vi.fn(async (agentId: string, opts?: { force?: boolean }) => {
      const cached = spaceStateMock.agentCache[agentId] as
        | (typeof spaceStateMock.selectedAgent)
        | undefined
      if (!opts?.force && cached) return cached
      // force / 未缓存：对齐真实 store——有选中 Agent 就返回详情，禁止 silent null
      //（ 半量拒发后，null 会让无 custom_rules 的默认用例整段不发）。
      if (cached) return cached
      if (spaceStateMock.selectedAgent?.id === agentId) {
        return spaceStateMock.selectedAgent
      }
      return null
    }),
  },
  deviceStateMock: {
    currentDevice: { id: 'dev-A', name: 'This Mac', status: 'online' },
    devices: [{ id: 'dev-A', name: 'This Mac', status: 'online' }],
  },
}))

vi.mock('../../../../useChatRuntimeStore', () => ({
  useChatRuntimeStore: {
    getState: () => runtimeState,
    setState: (partial: unknown) => {
      const next = typeof partial === 'function'
        ? (partial as (state: typeof runtimeState) => Partial<typeof runtimeState>)(runtimeState)
        : partial
      Object.assign(runtimeState, next)
    },
  },
  // cleanupSessionOnTerminal（onError 终态收尾）依赖本导出；缺失会让 onError
  // 在 markMessageFailed 之前中断。
  flushRuntimeBatch: vi.fn(),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    // PR4-yolo：动态读 spaceStateMock，让每个用例自定义 gate / group / agent。
    getState: () => spaceStateMock,
  },
}))

const organizationStateMock = vi.hoisted(() => ({
  selectedOrganization: {
    id: 'organization-1',
    settings: { allow_member_yolo: true },
  },
}))

vi.mock('@stores/useOrganizationStore', () => {
  const useOrganizationStore = Object.assign(
    (selector: (state: typeof organizationStateMock) => unknown) => selector(organizationStateMock),
    {
      getState: () => organizationStateMock,
      subscribe: vi.fn(),
    },
  )
  return { useOrganizationStore }
})

vi.mock('@stores/useDeviceStore', () => ({
  useDeviceStore: {
    getState: () => deviceStateMock,
  },
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ accessToken: 'test-token' }),
  },
}))

vi.mock('@/services/electronFetch', () => ({
  electronFetch: mockElectronFetch,
}))

vi.mock('../../../execution/chatTelemetry', () => ({
  trackChatTelemetry: vi.fn(),
}))

vi.mock('../../../../../crawlspace/electron/run-session-client', () => ({
  runSessionClient: {
    endRun: vi.fn(),
  },
}))

vi.mock('../../../../../services/checkpointIpc', () => ({
  isAvailable: vi.fn(() => false),
  init: vi.fn(),
}))

vi.mock('../../../stream/handlers/streamMessageHandler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../stream/handlers/streamMessageHandler')>()
  return {
    ...actual,
    createStreamMessageHandler: actual.createStreamMessageHandler,
  }
})

vi.mock('../../../hitl/handlers/actionRequiredHandler', () => ({
  createActionRequiredHandler: mockCreateActionRequiredHandler,
}))

vi.mock('@/services/systemNotification', () => ({
  SystemNotification: {
    agentHitlWaiting: vi.fn(),
    agentCompleted: vi.fn(),
    agentError: vi.fn(),
    agentInterrupted: vi.fn(),
    agentSessionInterrupted: vi.fn(),
  },
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, fallback?: { defaultValue?: string }) => fallback?.defaultValue ?? key,
  },
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  createLogger: () => ({
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

const mockEnsureGroupRuntimeSynced = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('../../../group/groupRuntimeSessionSync', () => ({
  ensureGroupRuntimeSynced: (...args: unknown[]) => mockEnsureGroupRuntimeSynced(...args),
}))

vi.mock('../../../execution/contextSyncInFlight', () => ({
  awaitInFlightContextSync: vi.fn().mockResolvedValue(undefined),
}))

const mockPrepareRuntimeDispatchContext = vi.hoisted(() => vi.fn().mockResolvedValue({
  personalRules: 'cached-rules',
  workspaceSnapshot: { allowedPaths: ['/tmp'] },
}))

vi.mock('../../../execution/runtimeDispatchPrep', () => ({
  prepareRuntimeDispatchContext: (...args: unknown[]) => mockPrepareRuntimeDispatchContext(...args),
}))

const mockResolveProjectTaskChatSendGate = vi.hoisted(() => vi.fn().mockResolvedValue(null))

vi.mock('../../product/delivery/projectTaskSendGate', () => ({
  resolveProjectTaskChatSendGate: (...args: unknown[]) => mockResolveProjectTaskChatSendGate(...args),
}))

vi.mock('../../../../useChatModelStore', () => ({
  useChatModelStore: {
    getState: () => ({
      getCurrentModel: () => ({ id: 'cbc75d0e-1111-4222-8333-444444444444', name: 'test-model' }),
      syncTierForActiveSession: vi.fn().mockResolvedValue(undefined),
    }),
  },
}))

// M5.Y：fallback 分支已删除，sendMessage 只走本地 Runtime。测试直接 mock
// getLocalAgentClient，期望 stream 以 (sessionId, message, callbacks, options)
// 形式被调用。
//
// W4.1（顺手修预存 mock 缺口）：sendMessageAction 还会 import
// `isLocalRuntimeAvailable` 用作 isLocalRuntimeEnabled 的 SSoT 守卫
// （见 sendMessageAction.ts:46 的 import）。原 mock 没 export 这个函数 →
// 4 个 stream-path 测试都会 throw "No isLocalRuntimeAvailable export"
// 然后失败。本测试涉及 stream 入参断言，必须把 isLocalRuntimeAvailable
// 一并 mock 成 always-true，让流程能走到 localClient.stream(...)。
//  单源终态：测试 driver 经生产同一路径把事件投进 SessionStreamHub.dispatch，
// 不再访问主动轮或 callback 分支。
vi.mock('../../../../../services/localAgentClient', () => ({
  getLocalAgentClient: () => ({
    stream: localStream,
    query: async (sessionId: string, message: string, options?: unknown) => {
      const queryFailure = mockRuntimeQueryFailure.current
      mockRuntimeQueryFailure.current = null
      if (queryFailure) throw queryFailure
      const {
        __dispatchStreamEnvelopeForTest,
        __flushStreamDrainsForTest,
      } = await import('../../../../../services/agentService/index')
      const streamOptions = (options ?? {}) as {
        clientMessageId?: string
        displayMessage?: string
        agentMode?: string
        userMessageBlocks?: Array<Record<string, unknown>>
      }
      const clientMessageId = typeof streamOptions.clientMessageId === 'string'
        ? streamOptions.clientMessageId
        : undefined
      const isBusy = !!runtimeState.runProjectionBySessionId?.[sessionId]?.busy
      const runId = clientMessageId ?? 'test-run-id'
      const ack = {
        success: true as const,
        runId,
        runDisposition: isBusy ? 'queued' as const : 'started' as const,
        queuePosition: isBusy ? 1 : undefined,
      }

      //  / 生产 query ACK-only：先返回 ACK 让编排层上屏，流放到 macrotask。
      mockStreamAfterAck.current = new Promise<void>((resolve) => {
        setTimeout(() => {
          void (async () => {
            try {
              if (isBusy) return
              let terminalError: Error | null = null
              const resolveSourceClientEventId = (): string | undefined => {
                if (clientMessageId) return clientMessageId
                const bridgeStore = streamTestBridge.store
                if (!bridgeStore) return undefined
                const user = [...(bridgeStore.messagesBySessionId[sessionId] ?? [])]
                  .reverse()
                  .find(candidate => candidate.role === 'user')
                const userMetadata = (user?.metadata ?? {}) as Record<string, unknown>
                const clientEventId = user?.client_event_id
                  ?? userMetadata.client_message_id
                  ?? userMetadata.client_event_id
                return typeof clientEventId === 'string' && clientEventId ? clientEventId : undefined
              }
              const dispatch = (event: { type: string; payload?: Record<string, unknown> }) => {
                const sourceClientEventId = resolveSourceClientEventId()
                const payload = {
                  ...(event.payload ?? {}),
                  ...(sourceClientEventId && !event.payload?.source_client_event_id
                    ? { source_client_event_id: sourceClientEventId }
                    : {}),
                }
                __dispatchStreamEnvelopeForTest(sessionId, {
                  sessionId,
                  event: { ...event, payload } as never,
                })
                __flushStreamDrainsForTest()
              }
              const safeDispatch = (event: { type: string; payload?: Record<string, unknown> }) => {
                try {
                  dispatch(event)
                } catch (error) {
                  // 测试 mock store 缺方法时仍要走到 terminal，否则 SessionController 会挂死。
                  console.error('[sendMessageAction.test] stream dispatch failed', error)
                }
              }
              const driver = {
                onChunk: () => {},
                onMessage: safeDispatch,
                onDone: (metadata?: Record<string, unknown>) => {
                  const sourceClientEventId = resolveSourceClientEventId()
                  const traceId = typeof metadata?.trace_id === 'string' && metadata.trace_id
                    ? metadata.trace_id
                    : 'test-run-trace-id'
                  safeDispatch({
                    type: 'agent.stream.done',
                    payload: {
                      ...(metadata ?? {}),
                      trace_id: traceId,
                      ...(sourceClientEventId ? { source_client_event_id: sourceClientEventId } : {}),
                    },
                  })
                },
                onError: (err: unknown) => {
                  terminalError = err instanceof Error ? err : new Error(String(err))
                  safeDispatch({
                    type: 'agent.stream.lifecycle',
                    payload: { phase: 'error', error_message: terminalError.message },
                  })
                },
              }
              if (clientMessageId) {
                const visible = streamOptions.displayMessage ?? message
                const arrivalSeq = Date.now() * 1000
                const rawBlocks = streamOptions.userMessageBlocks?.length
                  ? streamOptions.userMessageBlocks
                  : [{ type: 'text', text: visible }]
                const blocksJson = rawBlocks.map((block, index) => ({
                  ...block,
                  arrival_seq: arrivalSeq + index,
                }))
                safeDispatch({
                  type: 'agent.stream.user',
                  payload: {
                    client_event_id: clientMessageId,
                    content: visible,
                    arrival_seq: arrivalSeq,
                    blocks_json: blocksJson,
                    ...(streamOptions.agentMode ? { agent_mode: streamOptions.agentMode } : {}),
                  },
                })
              }
              await localStream(sessionId, message, driver, options)
              if (!terminalError) {
                safeDispatch({ type: 'agent.stream.lifecycle', payload: { phase: 'end' } })
              }
              __dispatchStreamEnvelopeForTest(sessionId, {
                sessionId,
                terminal: terminalError
                  ? { reason: 'errored', error: terminalError.message }
                  : { reason: 'completed' },
              })
            } finally {
              resolve()
            }
          })()
        }, 0)
      })

      return ack
    },
    abort: vi.fn(),
  }),
  isLocalRuntimeAvailable: () => true,
}))

vi.mock('../../../../../services/chatAttachmentApi', () => ({
  uploadAllAttachments: mockUploadAllAttachments,
}))

vi.mock('@stores/useUploadQueueStore', () => ({
  useUploadQueueStore: {
    getState: () => ({
      addTask: mockUploadQueueAddTask,
      updateTask: mockUploadQueueUpdateTask,
      registerCancelCallback: mockUploadQueueRegisterCancelCallback,
      tasks: [],
    }),
  },
}))

// 循环依赖 hoisting 修复（侧边栏 + footer v2 review 揭出）：sendMessageAction
// import 链上间接拉到 useChatStore，useChatStore 模块初始化时调
// `createSendMessageAction(...)`——但此时 sendMessageAction 这个 export
// 还没初始化好 → "createSendMessageAction is not a function"，整文件 22 个
// 测试一个都跑不起来。给 useChatStore 一个最小化 mock 切断这条循环。
// 单流架构下 doneEventFinalizer / contentBlockHandler 会读写 messagesBySessionId，
// 经 streamTestBridge 投影到各用例的 SendMessageStore。
vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      messagesBySessionId: streamTestBridge.store?.messagesBySessionId ?? {},
      hostPendingSendsBySessionId: (streamTestBridge.store as { hostPendingSendsBySessionId?: Record<string, unknown[]> } | null)
        ?.hostPendingSendsBySessionId ?? {},
      removeHostPendingByClientEventId: (
        sessionId: string,
        clientEventId: string,
      ) => {
        const store = streamTestBridge.store as {
          removeHostPendingByClientEventId?: (sid: string, cid: string) => unknown
        } | null
        return store?.removeHostPendingByClientEventId?.(sessionId, clientEventId) ?? null
      },
      pendingApprovalBySessionId: streamTestBridge.store?.pendingApprovalBySessionId ?? {},
      pendingAskUserBySessionId: streamTestBridge.store?.pendingAskUserBySessionId ?? {},
      updateSessionMessages: streamTestBridge.updateSessionMessages ?? vi.fn(),
      //  / ：markUserMessageDelivered 经 patchMessageById 写 sendStatus
      patchMessageById: (
        sessionId: string,
        messageId: string,
        patcher: (message: ChatMessage) => ChatMessage,
      ) => {
        streamTestBridge.updateSessionMessages?.(sessionId, prev =>
          prev.map(message => (message.id === messageId ? patcher(message) : message)),
        )
      },
      rewriteSessionMessages: (
        sessionId: string,
        _reason: string,
        updater: (prev: ChatMessage[]) => ChatMessage[],
      ) => streamTestBridge.updateSessionMessages?.(sessionId, updater),
      // ：ACK 后流事件走 chatStoreBootstrap → useChatStore.upsertObservedUserMessage
      upsertObservedUserMessage: (sessionId: string, message: ChatMessage) => {
        streamTestBridge.updateSessionMessages?.(sessionId, prev => {
          const identity = message.client_event_id ?? message.id
          const exists = prev.some(existing => {
            if (existing.id === message.id || existing.id === identity) return true
            if (message.client_event_id && existing.client_event_id === message.client_event_id) {
              return true
            }
            const metadata = existing.metadata as Record<string, unknown> | null | undefined
            if (typeof metadata !== 'object' || metadata === null) return false
            return metadata.client_event_id === identity
              || metadata.client_message_id === identity
              || (message.client_event_id
                ? metadata.client_event_id === message.client_event_id
                  || metadata.client_message_id === message.client_event_id
                : false)
          })
          return exists ? prev : [...prev, message]
        })
      },
      injectErrorBubble: (sessionId: string, message: ChatMessage) => {
        streamTestBridge.updateSessionMessages?.(sessionId, prev => {
          const exists = prev.some(existing => (
            existing.content === message.content
            && (existing.metadata as Record<string, unknown> | undefined)?.isErrorMessage === true
          ))
          return exists ? prev : [...prev, message]
        })
      },
      linkServerMessageId: (sessionId: string, localMessageId: string, serverId: string) => {
        streamTestBridge.updateSessionMessages?.(sessionId, prev => {
          const index = prev.findIndex(message => message.id === localMessageId)
          if (index < 0) return prev
          const target = prev[index]
          const metadata = (typeof target.metadata === 'object' && target.metadata !== null)
            ? target.metadata as Record<string, unknown>
            : {}
          if (metadata.message_id === serverId) return prev
          const next = [...prev]
          next[index] = { ...target, metadata: { ...metadata, message_id: serverId } }
          return next
        })
      },
      rebindMessageIds: (
        sessionId: string,
        idPairs: ReadonlyArray<readonly [oldId: string, newId: string]>,
      ) => {
        const idMap = new Map(idPairs)
        streamTestBridge.updateSessionMessages?.(sessionId, prev =>
          prev.map(message => {
            const nextId = idMap.get(message.id)
            return nextId ? { ...message, id: nextId } : message
          }),
        )
      },
      getSessionById: (sessionId: string) =>
        streamTestBridge.store?.sessions?.find((session) => session.id === sessionId),
      ensureAssistantMessage: (sessionId: string, message: ChatMessage) => {
        streamTestBridge.updateSessionMessages?.(sessionId, prev =>
          prev.some(existing => existing.id === message.id) ? prev : [...prev, message],
        )
      },
      mergeSubagentMessages: (
        sessionId: string,
        toStoreMessage: (message: ChatMessage) => ChatMessage,
        incoming: ChatMessage[],
      ) => {
        streamTestBridge.updateSessionMessages?.(sessionId, prev => {
          const mapped = incoming.map(toStoreMessage)
          const seen = new Set(prev.map(message => message.id))
          const appended = mapped.filter(message => !seen.has(message.id))
          return appended.length > 0 ? [...prev, ...appended] : prev
        })
      },
    }),
    setState: (
      partial:
        | Partial<{ messagesBySessionId: Record<string, ChatMessage[]> }>
        | ((state: { messagesBySessionId: Record<string, ChatMessage[]> }) => Partial<{
          messagesBySessionId: Record<string, ChatMessage[]>
        }>),
    ) => {
      if (!streamTestBridge.store) return
      const currentState = { messagesBySessionId: streamTestBridge.store.messagesBySessionId }
      const next = typeof partial === 'function' ? partial(currentState) : partial
      if (!next.messagesBySessionId) return
      for (const [sessionId, messages] of Object.entries(next.messagesBySessionId)) {
        streamTestBridge.store.messagesBySessionId[sessionId] = messages
      }
    },
  },
}))

import {
  createSendMessageAction as createSendMessageActionRaw,
  classifyRunTermination,
  resolveSessionForSend,
} from '../sendMessageAction'
import { inferDoneErrorCategory } from '../../../shared/inferDoneErrorCategory'
import type { SendMessageStore } from '../sendMessageAction'
import { createHostPendingSendActions } from '../../hostPending/hostPendingSendSlice'
import * as sendMessageActionModule from '../sendMessageAction'
import type { ApprovalModeName } from '../../../shared/types'
import type { ChatAttachment } from '../../../../../components/chat/types'
import { createStreamMessageHandler } from '../../../stream/handlers/streamMessageHandler'
import {
  registerChatStoreCallbacks,
  registerHitlStoreAccess,
  __resetHitlStoreAccessForTest,
} from '../../../shared/storeAccessRegistry'
import { runtimeStoreAccess } from '../../../../../services/agentService/runtimeStoreAccess'
import {
  __resetMessageWriteGateForTest,
  registerSessionMessagesReader,
} from '../../../../../services/agentService/messageWriteGate'
import { __resetStreamHubsForTest } from '../../../../../services/agentService/index'
import { bindDraftSessionToMessage } from '../../../session/draftSession'

/** ：query 先 ACK，流在 macrotask；测试 await send 后再等流 settle。 */
function createSendMessageAction(
  ...args: Parameters<typeof createSendMessageActionRaw>
): ReturnType<typeof createSendMessageActionRaw> {
  const send = createSendMessageActionRaw(...args)
  return async (...sendArgs) => {
    try {
      return await send(...sendArgs)
    } finally {
      const stream = mockStreamAfterAck.current
      mockStreamAfterAck.current = null
      if (stream) await stream
    }
  }
}

// hub 的 resolveSendRoute（本机 runtime 可用性判定）依赖 window.tabtin?.agentEngine。
// 测试环境（jsdom）默认 window 存在但无 tabtin，需要手动注入。
const submitAskUserResponseIpc = vi.fn().mockResolvedValue({ success: true })
const beginProvisionalSessionClaimIpc = vi.fn().mockResolvedValue({
  accepted: true,
  tracked: false,
})
const completeProvisionalSessionClaimIpc = vi.fn().mockResolvedValue({ completed: true })

beforeAll(() => {
  ;(globalThis as any).window = (globalThis as any).window ?? {}
  ;(globalThis as any).window.tabtin = {
    agentEngine: {
      submitAskUserResponse: submitAskUserResponseIpc,
      beginProvisionalSessionClaim: beginProvisionalSessionClaimIpc,
      completeProvisionalSessionClaim: completeProvisionalSessionClaimIpc,
      // ：出站遥控发送下沉主进程。测试里让 gatewaySend 委托到既有 mockGatewayRequest
      // （拆包 { messageType, payload, requestOptions } → 三位参数），保持既有断言不变。
      gatewaySend: (arg: { messageType: string; payload: Record<string, unknown>; requestOptions?: Record<string, unknown> }) =>
        mockGatewayRequest(arg.messageType, arg.payload, arg.requestOptions),
    },
  }
  //  依赖倒置：真实 useChatRuntimeStore module body 会注册 runtimeStoreAccess，
  // 但本文件 mock 掉了该模块 → 注册从未发生 → hub attachStream fail-fast 抛错、
  // send 被外层 catch 吞成发送失败（36 例连锁挂）。测试侧手动注册 mock 实现。
  runtimeStoreAccess.registerAccess({
    get: () => runtimeState as never,
    set: ((partial: unknown) => {
      const next = typeof partial === 'function'
        ? (partial as (state: typeof runtimeState) => Partial<typeof runtimeState>)(runtimeState)
        : partial
      Object.assign(runtimeState, next as Record<string, unknown>)
    }) as never,
    flushRuntimeBatch: () => {},
    reconcileSubagentRunsFromArchive: vi.fn().mockResolvedValue(undefined),
  })
  //  阶段B：handler 工厂经独立 leaf 注入；单流架构下走真实 createStreamMessageHandler。
  runtimeStoreAccess.registerStreamHandlerFactory((d) => createStreamMessageHandler(d))
  ;(globalThis as any).window.localStorage = (globalThis as any).window.localStorage ?? {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  }
})

afterAll(() => {
  delete (globalThis as any).window.tabtin
  runtimeStoreAccess.resetAccessForTest()
})

describe('markPersistedUserMessage', () => {
  it('marks the synchronized server-id message as sent when relay ACK still references temp id', () => {
    const markPersistedUserMessage = (
      sendMessageActionModule as unknown as {
        markPersistedUserMessage?: (
          messages: ChatMessage[],
          previousId: string,
          clientMessageId: string,
          serverId: string,
        ) => ChatMessage[]
      }
    ).markPersistedUserMessage

    expect(markPersistedUserMessage).toEqual(expect.any(Function))
    const messages = markPersistedUserMessage?.([
      {
        id: 'server-user-1',
        role: 'user',
        content: 'hello',
        created_at: '2026-07-12T00:00:00.000Z',
        metadata: { client_message_id: 'client-1' },
        sendStatus: 'sending',
      } as ChatMessage,
    ], 'temp-user-1', 'client-1', 'server-user-1')

    expect(messages?.[0]).toMatchObject({ id: 'server-user-1', sendStatus: 'sent' })
  })
})

describe('inferDoneErrorCategory', () => {
  it('优先保留后端显式 error_category', () => {
    expect(inferDoneErrorCategory({
      error_class: 'MAX_CREDITS_EXCEEDED',
      error_category: 'organization_insufficient_credits',
      error_message: 'Max run credits exceeded.',
    })).toBe('organization_insufficient_credits')
  })

  it('MAX_CREDITS_EXCEEDED 缺显式 category 时按运行预算处理', () => {
    expect(inferDoneErrorCategory({
      error_class: 'MAX_CREDITS_EXCEEDED',
      error_message: 'Max run credits exceeded.',
    })).toBe('budget_exceeded')
  })

  it('LLM_BILLING_ERROR 只有组织余额强信号时才归组织额度', () => {
    expect(inferDoneErrorCategory({
      error_class: 'LLM_BILLING_ERROR',
      error_message: '组织钱包余额不足，请充值后继续使用。',
    })).toBe('organization_insufficient_credits')
    expect(inferDoneErrorCategory({
      error_class: 'LLM_BILLING_ERROR',
      error_message: 'Billing guard stopped this run.',
    })).toBe('billing')
    expect(inferDoneErrorCategory({
      error_class: 'LLM_BILLING_ERROR',
      error_message: '组织余额不足。',
    })).toBe('billing')
  })

  it('结算基础设施失败（LLM_ERROR + server_error）不误归 billing 充值卡', () => {
    expect(inferDoneErrorCategory({
      error_class: 'LLM_ERROR',
      error_message: '服务结算异常，请稍后重试',
      error_category: 'server_error',
    })).toBe('server_error')
    expect(inferDoneErrorCategory({
      error_class: 'LLM_ERROR',
      error_message: 'LLM 调用已完成但计费结算失败，请稍后重试。',
    })).toBeUndefined()
  })
})

//  / ：撞运行预算墙不算发送失败——纯函数直测，绕开 createSendMessageAction
// 集成用例受 localStream 调度 mock 限制的问题。
describe('classifyRunTermination', () => {
  it('运行预算墙（MAX_CREDITS_EXCEEDED）= 优雅终止、非 abort', () => {
    expect(classifyRunTermination('MAX_CREDITS_EXCEEDED', 'Terminated by budget guard: credits'))
      .toEqual({ isAborted: false, isGracefulTermination: true })
  })

  it('用户主动停止（ABORT）= 优雅终止且 isAborted', () => {
    expect(classifyRunTermination('ABORT', 'Run aborted by user.'))
      .toEqual({ isAborted: true, isGracefulTermination: true })
  })

  it('兜底文案含 abort 也识别为 abort', () => {
    expect(classifyRunTermination(undefined, 'Run aborted by user.'))
      .toEqual({ isAborted: true, isGracefulTermination: true })
  })

  it('真错误（网络 / stall）不是优雅终止 → 保持发送失败语义', () => {
    expect(classifyRunTermination('LLM_ERROR', 'stream stalled'))
      .toEqual({ isAborted: false, isGracefulTermination: false })
    expect(classifyRunTermination(undefined, undefined))
      .toEqual({ isAborted: false, isGracefulTermination: false })
  })

  it('钱包余额不足（LLM_BILLING_ERROR）不是优雅终止（仍走充值卡 / 失败语义）', () => {
    expect(classifyRunTermination('LLM_BILLING_ERROR', '组织钱包余额不足'))
      .toEqual({ isAborted: false, isGracefulTermination: false })
  })

  it('#6116 文本/工具硬停 = 优雅终止、非 abort', () => {
    expect(classifyRunTermination('text_loop_terminated', 'Streaming text repetition loop terminated'))
      .toEqual({ isAborted: false, isGracefulTermination: true })
    expect(classifyRunTermination('tool_loop_terminated', undefined))
      .toEqual({ isAborted: false, isGracefulTermination: true })
  })

  it('#8480 步数/迭代预算墙 = 优雅终止、非 abort', () => {
    expect(classifyRunTermination('MAX_TURNS_EXCEEDED', 'Max turns exceeded'))
      .toEqual({ isAborted: false, isGracefulTermination: true })
    expect(classifyRunTermination('iteration_budget_exhausted', undefined))
      .toEqual({ isAborted: false, isGracefulTermination: true })
    expect(classifyRunTermination('token_budget_exhausted', undefined))
      .toEqual({ isAborted: false, isGracefulTermination: true })
  })
})

describe('createSendMessageAction', () => {
  it('发送门禁拒绝时返回未接收结果，而不是静默成功', async () => {
    const store = buildMinimalSendStore()
    store.restoringSessionId = 'session-1'
    const sendMessage = createSendMessageAction(baseDeps(store, vi.fn(), vi.fn()))

    const result = await sendMessage('blocked by restore', true)

    expect(result).toMatchObject({ accepted: false, persisted: false })
    expect(localStream).not.toHaveBeenCalled()
  })

  it('执行上下文解析抛错时返回未接收结果，不把异常冒充发送成功', async () => {
    const store = buildMinimalSendStore()
    Object.assign(store.sessions[0], { agent_id: 'agent-throw' })
    const previousSelectedAgent = spaceStateMock.selectedAgent
    spaceStateMock.selectedAgent = null as never
    spaceStateMock.loadAgent.mockRejectedValueOnce(new Error('agent lookup failed'))
    const sendMessage = createSendMessageAction(baseDeps(store, vi.fn(), vi.fn()))

    const result = await sendMessage('context throws', true)
    spaceStateMock.selectedAgent = previousSelectedAgent

    expect(result).toMatchObject({ accepted: false, persisted: false })
    expect(localStream).not.toHaveBeenCalled()
  })

  it('运行时拒绝发送时返回未接收结果', async () => {
    const store = buildMinimalSendStore()
    mockRuntimeQueryFailure.current = new Error('runtime rejected')
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    const result = await sendMessage('runtime rejects', true)

    expect(result).toMatchObject({ accepted: false, persisted: false })
  })

  it('发送非当前 Project 会话时从跨 Space 缓存解析执行绑定', () => {
    const projectSession = {
      id: 'project-session',
      agent_id: 'project-agent',
      workspace_id: 'member-workspace',
    } as ChatSession

    expect(resolveSessionForSend({
      sessions: [],
      getSessionById: (sessionId) => sessionId === projectSession.id ? projectSession : undefined,
    }, projectSession.id)).toBe(projectSession)
  })

  const activateStreamTestBridge = (
    store: SendMessageStore,
    updateSessionMessages: ReturnType<typeof vi.fn>,
    set?: ReturnType<typeof vi.fn>,
  ) => {
    if (typeof (store as { enqueueHostPendingSend?: unknown }).enqueueHostPendingSend !== 'function') {
      attachHostPendingToStore(store)
    }
    streamTestBridge.store = store
    streamTestBridge.updateSessionMessages = updateSessionMessages
    streamTestBridge.set = set ?? null

    registerSessionMessagesReader((sessionId) => store.messagesBySessionId[sessionId] ?? [])

    registerChatStoreCallbacks({
      getCurrentSessionId: () => store.currentSessionId,
      isSessionBusy: (sessionId) => store.streamingBySessionId[sessionId] === true,
      applySessionRunStateEvent: () => false,
      getStreamingSessionIds: () => Object.keys(store.streamingBySessionId ?? {}).filter(
        (sessionId) => store.streamingBySessionId[sessionId] === true,
      ),
      syncSessionMessagesFromServer: vi.fn(),
      getSessionsBySpaceId: () => ({}),
      updateSessionTitleInCaches: vi.fn(),
      upsertSessionInSpace: vi.fn(),
      injectErrorBubble: (sessionId, message) => {
        updateSessionMessages(sessionId, prev => {
          const exists = prev.some(existing => (
            existing.content === message.content
            && (existing.metadata as Record<string, unknown> | undefined)?.isErrorMessage === true
          ))
          return exists ? prev : [...prev, message]
        })
      },
      upsertObservedUserMessage: (sessionId, message) => {
        updateSessionMessages(sessionId, prev => {
          const identity = message.client_event_id ?? message.id
          const exists = prev.some(existing => {
            if (existing.id === message.id || existing.id === identity) return true
            if (message.client_event_id && existing.client_event_id === message.client_event_id) return true
            const metadata = existing.metadata as Record<string, unknown> | null | undefined
            if (typeof metadata !== 'object' || metadata === null) return false
            return metadata.client_event_id === identity
              || metadata.client_message_id === identity
              || (message.client_event_id
                ? metadata.client_event_id === message.client_event_id
                  || metadata.client_message_id === message.client_event_id
                : false)
          })
          return exists ? prev : [...prev, message]
        })
      },
      rewriteSessionMessages: (sessionId, _reason, updater) => updateSessionMessages(sessionId, updater),
      linkServerMessageId: (sessionId, localMessageId, serverId) => {
        updateSessionMessages(sessionId, prev => {
          const index = prev.findIndex(message => message.id === localMessageId)
          if (index < 0) return prev
          const target = prev[index]
          const metadata = (typeof target.metadata === 'object' && target.metadata !== null)
            ? target.metadata as Record<string, unknown>
            : {}
          if (metadata.message_id === serverId) return prev
          const next = [...prev]
          next[index] = { ...target, metadata: { ...metadata, message_id: serverId } }
          return next
        })
      },
      rebindMessageIds: (sessionId, idPairs) => {
        const idMap = new Map(idPairs)
        updateSessionMessages(sessionId, prev =>
          prev.map(message => {
            const nextId = idMap.get(message.id)
            return nextId ? { ...message, id: nextId } : message
          }),
        )
      },
    })
  }

  beforeEach(() => {
    __resetStreamHubsForTest()
    __resetMessageWriteGateForTest()
    streamTestBridge.store = null
    streamTestBridge.updateSessionMessages = null
    streamTestBridge.set = null
    vi.clearAllMocks()
    beginProvisionalSessionClaimIpc.mockResolvedValue({ accepted: true, tracked: false })
    completeProvisionalSessionClaimIpc.mockResolvedValue({ completed: true })
    mockStreamAfterAck.current = null
    mockRuntimeQueryFailure.current = null
    mockResolveProjectTaskChatSendGate.mockReset().mockResolvedValue(null)
    localStream.mockReset()
    localStream.mockResolvedValue(undefined)
    mockElectronFetch.mockReset()
    mockElectronFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { context_text: '' } }),
    })
    mockGatewayRequest.mockReset()
    mockGatewayRequest.mockResolvedValue({
      ok: true,
      type: 'chat.send_message.ok',
      payload: { message_id: 'server-user-1', task_id: 'task-1' },
    })
    __resetHitlStoreAccessForTest()
    submitAskUserResponseIpc.mockReset().mockResolvedValue({ success: true })
    runtimeState.agentModeBySessionId = {}
    runtimeState.approvalModeBySessionId = {}
    runtimeState.groupRuntimeBySessionId = {}
    runtimeState.assistantEventsBySessionId = {}
    runtimeState.toolEventsBySessionId = {}
    runtimeState.uploadProgressBySessionId = {}
    runtimeState.runProjectionBySessionId = {}
    runtimeState.setActiveSubmittedMessageForSession.mockReset()
    runtimeState.clearActiveSubmittedMessage.mockReset()
    mockUploadAllAttachments.mockReset()
    mockUploadQueueAddTask.mockReset()
    mockUploadQueueUpdateTask.mockReset()
    mockUploadQueueRegisterCancelCallback.mockReset()
    // PR4-yolo：每个用例从默认 bot Space + 无 gate 起步，单测内可覆盖。
    spaceStateMock.selectedSpace = { id: 'space-1', name: 'Space One', type: 'workspace' }
    spaceStateMock.selectedAgent = {
      id: 'agent-1',
      agent_config: { use_local_runtime: true },
    }
    spaceStateMock.spaces = []
    spaceStateMock.agentCache = {}
    spaceStateMock.loadAgent.mockReset()
    spaceStateMock.loadAgent.mockImplementation(async (agentId: string, opts?: { force?: boolean }) => {
      const cached = spaceStateMock.agentCache[agentId] as
        | (typeof spaceStateMock.selectedAgent)
        | undefined
      if (!opts?.force && cached) return cached
      if (cached) return cached
      if (spaceStateMock.selectedAgent?.id === agentId) {
        return spaceStateMock.selectedAgent
      }
      return null
    })
    organizationStateMock.selectedOrganization = {
      id: 'organization-1',
      settings: { allow_member_yolo: true },
    }
    deviceStateMock.currentDevice = { id: 'dev-A', name: 'This Mac', status: 'online' }
    deviceStateMock.devices = [{ id: 'dev-A', name: 'This Mac', status: 'online' }]
  })

  const buildChatClientMock = (): ChatClient => ({
    messages: {
      list: vi.fn().mockResolvedValue({ messages: [], total: 0 }),
    },
    sessions: {
      get: vi.fn().mockResolvedValue({}),
      generateTitle: vi.fn().mockResolvedValue({ accepted: true }),
    },
    isStreaming: vi.fn(() => false),
    pauseForReview: vi.fn(),
    getGateway: () => ({
      request: mockGatewayRequest,
    }),
  }) as unknown as ChatClient

  const baseDeps = (store: SendMessageStore, updateSessionMessages: ReturnType<typeof vi.fn>, set: ReturnType<typeof vi.fn>) => {
    activateStreamTestBridge(store, updateSessionMessages, set)
    return {
      get: () => store,
      set,
      getChatClient: () => buildChatClientMock(),
      updateSessionMessages,
      addStreamingSession: vi.fn(),
      removeStreamingSession: vi.fn(),
      updateSessionInCaches: vi.fn(),
      updateSessionTokenUsageInCaches: vi.fn(),
      resolveSpacePath: vi.fn().mockResolvedValue(null),
      buildReviewMessage: vi.fn().mockReturnValue('review'),
    }
  }

  const attachHostPendingToStore = (store: SendMessageStore) => {
    const pendingActions = createHostPendingSendActions(
      () => store,
      (partial) => {
        const patch = typeof partial === 'function' ? partial(store) : partial
        Object.assign(store, patch)
      },
    )
    Object.assign(store, pendingActions)
  }

  const extendSendStore = (
    patch: Partial<SendMessageStore> & { session?: Partial<ChatSession> } = {},
  ): SendMessageStore => {
    const store = buildMinimalSendStore()
    if (patch.session) {
      Object.assign(store.sessions[0], patch.session)
    }
    const { session: _sessionPatch, ...storePatch } = patch
    Object.assign(store, storePatch)
    return store
  }

  const buildMinimalSendStore = (): SendMessageStore => {
    const store: SendMessageStore = {
      currentSessionId: 'session-1',
      currentGraphType: 'chat' as const,
      agentMode: 'agent' as const,
      approvalMode: 'always_ask',
      approvalModeBySessionId: runtimeState.approvalModeBySessionId as Record<string, ApprovalModeName>,
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      pendingAskUserBySessionId: {},
      askUserSubmittingBySessionId: {},
      streamingBySessionId: {},
      messagesBySessionId: { 'session-1': [] as ChatMessage[] },
      sessions: [{
        id: 'session-1',
        title: 'Session One',
        status: 'active',
        organization_id: 'organization-1',
        workspace_id: 'space-1',
        created_at: '2026-03-13T00:00:00.000Z',
        updated_at: '2026-03-13T00:00:00.000Z',
      } as ChatSession],
      checkpointsBySessionId: {},
      restoringSessionId: null,
      createCheckpoint: vi.fn().mockResolvedValue(undefined),
      setCheckpointPendingContext: vi.fn(),
    }
    attachHostPendingToStore(store)
    return store
  }

  const registerHitlAccessForTest = (
    store: SendMessageStore,
    updateSessionMessages: ReturnType<typeof vi.fn>,
    set: ReturnType<typeof vi.fn>,
  ) => {
    registerHitlStoreAccess({
      getState: () => store,
      applyState: (partial) => {
        const next = typeof partial === 'function' ? partial(store) : partial
        set(next)
      },
      upsertHitlBubble: (sessionId, placeholderMessageId, bubble) => {
        updateSessionMessages(sessionId, prev => {
          if (placeholderMessageId) {
            const index = prev.findIndex(message => message.id === placeholderMessageId)
            if (index >= 0) {
              const next = [...prev]
              next[index] = bubble
              return next
            }
          }
          return prev.some(message => message.id === bubble.id) ? prev : [...prev, bubble]
        })
      },
      injectSystemMessage: vi.fn(),
      patchMessages: vi.fn(),
      rewriteSessionMessages: (sid: string, _reason: string, updater: (prev: never[]) => never[]) => updateSessionMessages(sid, updater),
      buildReviewMessage: vi.fn().mockReturnValue('review'),
    })
  }

  it('records the original submission snapshot before starting the Agent turn', async () => {
    const store = buildMinimalSendStore()
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    const attachment: ChatAttachment = {
      id: 'attachment-1',
      file: new File(['source'], 'source.txt', { type: 'text/plain' }),
      filename: 'source.txt',
      mimeType: 'text/plain',
      size: 6,
      type: 'file',
      status: 'ready',
      fileId: 'file-1',
      remoteUrl: 'https://cdn.example.test/source.txt',
    }
    const contextBlocks = [{ type: 'document', document_id: 'document-1' }]
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))
    mockUploadAllAttachments.mockResolvedValue([attachment])

    await sendMessage('原始用户输入', true, [attachment], contextBlocks, 'session-1', {
      displayMessage: '展示给用户的文案',
      allowInterruptedEditRecovery: true,
    })

    expect(runtimeState.setActiveSubmittedMessageForSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        clientMessageId: expect.any(String),
        // 单一身份收口：乐观 user 的 localMessageId 不再是 temp-user-* 前缀，
        // 而是纯 UUID（= clientMessageId = 服务端落库 id）。
        localMessageId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
        message: '原始用户输入',
        attachments: [expect.objectContaining({ id: 'attachment-1', fileId: 'file-1' })],
        contextBlocks,
      }),
    )
  })

  it('#6308 云盘 context + 文字：乐观气泡必须同时带 text 块，否则正文被吞', async () => {
    const { deriveUserMessageDisplayContent } = await import(
      '@/utils/chat/messageDisplayContent'
    )
    const store = buildMinimalSendStore()
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    const contextBlocks = [{ type: 'document', document_id: 'document-1' }]
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    const result = await sendMessage('请帮我看看这个文档', true, undefined, contextBlocks)

    expect(result).toEqual({ accepted: true, persisted: false, route: 'runtime' })

    const userMessage = (store.messagesBySessionId['session-1'] ?? []).find(m => m.role === 'user')
    expect(userMessage).toBeTruthy()
    expect(userMessage!.content).toBe('请帮我看看这个文档')
    expect(userMessage!.content_blocks_json).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: '请帮我看看这个文档' }),
        expect.objectContaining({ type: 'document', document_id: 'document-1' }),
      ]),
    )
    expect(deriveUserMessageDisplayContent(userMessage!)).toBe('请帮我看看这个文档')
  })

  it('clears the active submission snapshot after a completed turn', async () => {
    const store = buildMinimalSendStore()
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    localStream.mockImplementationOnce(async (
      _sessionId: string,
      _message: string,
      callbacks: { onDone: (metadata?: Record<string, unknown>) => void },
    ) => {
      callbacks.onDone({})
    })
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    await sendMessage('完成后不应保留恢复候选', true)

    expect(runtimeState.clearActiveSubmittedMessage).toHaveBeenCalledWith('session-1')
  })

  it('only records a recovery snapshot for the main Composer opt-in', async () => {
    const store = buildMinimalSendStore()
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    await sendMessage('程序化发送不应污染主输入框', true)

    expect(runtimeState.setActiveSubmittedMessageForSession).not.toHaveBeenCalled()
  })

  it('#9234/#2544 未 ready 附件在发送热路径拒发，不在发送时上传', async () => {
    const store = buildMinimalSendStore()
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    const file = new File(['hello'], 'report.pdf', { type: 'application/pdf' })
    const attachment: ChatAttachment = {
      id: 'att-1',
      file,
      filename: file.name,
      mimeType: file.type,
      size: file.size,
      type: 'file',
      status: 'pending',
    }
    const sendMessage = createSendMessageAction(
      baseDeps(store, updateSessionMessages, vi.fn()) as Parameters<typeof createSendMessageAction>[0],
    )

    await sendMessage('看附件', true, [attachment])

    expect(mockUploadAllAttachments).not.toHaveBeenCalled()
    expect(localStream).not.toHaveBeenCalled()
    expect(store.messagesBySessionId['session-1']).toEqual([])
  })

  it('流式发送时优先使用当前 session 的 runtime agentMode', async () => {
    runtimeState.agentModeBySessionId = { 'session-1': 'plan' }

    const store = extendSendStore({
      session: { agent_id: 'agent-1' },
    })

    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })

    const sendMessage = createSendMessageAction(
      baseDeps(store, updateSessionMessages, vi.fn()) as Parameters<typeof createSendMessageAction>[0],
    )

    await sendMessage('帮我规划一下', true)

    expect(localStream).toHaveBeenCalledWith(
      'session-1',
      '帮我规划一下',
      expect.any(Object),
      expect.objectContaining({
        agentMode: 'plan',
        // W4.1（dogfood fix）：sendMessageAction 必须把 currentAgent.id（来自
        // useSpaceStore.selectedAgent.id mock，本测试 mock 设为 'agent-1'）
        // 透传给 LocalAgentClient，否则 IPC payload 漏 agentId →
        // ElectronAgentHost 装配 NativeBackendSession 时 if 守卫整段 skip →
        // 7 Capability 全 bind 失败 → 用户调任何 file/shell 工具撞
        // "capability not bound to a BackendSession"。
        agentId: 'agent-1',
      }),
    )

    expect(store.messagesBySessionId['session-1'][0]).toMatchObject({
      role: 'user',
      metadata: expect.objectContaining({ agentMode: 'plan' }),
    })
    expect(runtimeState.clearAgentStepsForSession).toHaveBeenCalledWith('session-1')
    expect(runtimeState.clearToolEventsForSession).toHaveBeenCalledWith('session-1')
    // PRD v3.1：子 Agent runs 是 session 级别，发新消息**不再**清空
    // （清理时机限定 deleteSession / evictSession / logout，详见 sendMessageAction.ts）
    expect(runtimeState.clearSubagentRunsForSession).not.toHaveBeenCalled()
  })

  it('会话组织与当前 UI 组织不一致时，仍将会话组织传给本地 runtime', async () => {
    const store = buildMinimalSendStore()
    const session = store.sessions[0] as ChatSession
    session.organization_id = 'organization-session'
    organizationStateMock.selectedOrganization = {
      id: 'organization-current-ui',
      settings: { allow_member_yolo: true },
    }
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    const sendMessage = createSendMessageAction(
      baseDeps(store, updateSessionMessages, vi.fn()) as Parameters<typeof createSendMessageAction>[0],
    )

    await sendMessage('继续原来的任务', true)

    expect(localStream).toHaveBeenCalledWith(
      'session-1',
      '继续原来的任务',
      expect.any(Object),
      expect.objectContaining({ organizationId: 'organization-session' }),
    )
  })

  it('#6914 project_task 失败会话本机 runtime 重发被拒，不启动 LocalAgentClient', async () => {
    mockResolveProjectTaskChatSendGate.mockResolvedValueOnce({
      errorCode: 'project_task_run_required',
      errorMessage: '当前任务执行已结束或尚未开始，请回到任务详情点击「重新运行」创建新的执行。',
      errorCategory: 'project_task_run_required',
      retryable: false,
    })

    const store: SendMessageStore = {
      currentSessionId: 'session-1',
      agentMode: 'agent' as const,
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      pendingAskUserBySessionId: {},
      askUserSubmittingBySessionId: {},
      streamingBySessionId: {},
      messagesBySessionId: { 'session-1': [] as ChatMessage[] },
      sessions: [{
        id: 'session-1',
        title: '失败执行',
        status: 'active',
        organization_id: 'organization-1',
        created_at: '2026-03-13T00:00:00.000Z',
        updated_at: '2026-03-13T00:00:00.000Z',
      } as ChatSession],
      checkpointsBySessionId: {},
      restoringSessionId: null,
      createCheckpoint: vi.fn().mockResolvedValue(undefined),
    }
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    await sendMessage('确认并重新发送', true)

    expect(mockResolveProjectTaskChatSendGate).toHaveBeenCalledWith('session-1')
    expect(localStream).not.toHaveBeenCalled()
    expect(mockGatewayRequest).not.toHaveBeenCalled()
    expect(store.messagesBySessionId['session-1']).toEqual([])
  })

  it('遥控器发送消息：走 chat.send_message 转发到绑定设备，不启动本机 LocalAgentClient', async () => {
    spaceStateMock.selectedSpace = {
      id: 'space-1',
      name: 'Space One',
      type: 'workspace',
      execution_agent_id: 'agent-1',
    } as unknown as typeof spaceStateMock.selectedSpace
    spaceStateMock.selectedAgent = {
      id: 'agent-1',
      control_device_id: 'dev-B',
      agent_config: { use_local_runtime: true },
    } as unknown as typeof spaceStateMock.selectedAgent
    spaceStateMock.spaces = [spaceStateMock.selectedSpace]
    spaceStateMock.agentCache = { 'agent-1': spaceStateMock.selectedAgent }
    deviceStateMock.currentDevice = { id: 'dev-A', name: 'Remote Mac', status: 'online' }
    deviceStateMock.devices = [
      { id: 'dev-A', name: 'Remote Mac', status: 'online' },
      { id: 'dev-B', name: 'Host Mac', status: 'online' },
    ]

    const store = extendSendStore()
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    await sendMessage('从遥控器发一句', true, undefined, undefined, undefined, {
      allowInterruptedEditRecovery: true,
    })

    expect(localStream).not.toHaveBeenCalled()
    expect(mockGatewayRequest).toHaveBeenCalledWith(
      'chat.send_message',
      expect.objectContaining({
        session_id: 'session-1',
        message: '从遥控器发一句',
        client_event_id: expect.any(String),
        model_id: 'cbc75d0e-1111-4222-8333-444444444444',
      }),
      expect.objectContaining({
        threadId: 'chat-session-session-1',
        sessionId: 'session-1',
      }),
    )
    expect(store.messagesBySessionId['session-1'][0]).toMatchObject({
      id: 'server-user-1',
      role: 'user',
      sendStatus: 'sent',
    })
    expect(runtimeState.setActiveSubmittedMessageForSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ message: '从遥控器发一句' }),
    )
    expect(completeProvisionalSessionClaimIpc).toHaveBeenCalledWith('session-1', true)
  })

  //  / ：preset-only 远控——message 可空，拼装归 Host；blocks + skill_slash_invoke 透传。
  it('遥控器发送 composer preset-only：message 为空，blocks 透传 preset', async () => {
    spaceStateMock.selectedSpace = {
      id: 'space-1',
      name: 'Space One',
      type: 'workspace',
      execution_agent_id: 'agent-1',
    } as unknown as typeof spaceStateMock.selectedSpace
    spaceStateMock.selectedAgent = {
      id: 'agent-1',
      control_device_id: 'dev-B',
      agent_config: { use_local_runtime: true },
    } as unknown as typeof spaceStateMock.selectedAgent
    spaceStateMock.spaces = [spaceStateMock.selectedSpace]
    spaceStateMock.agentCache = { 'agent-1': spaceStateMock.selectedAgent }
    deviceStateMock.currentDevice = { id: 'dev-A', name: 'Remote Mac', status: 'online' }
    deviceStateMock.devices = [
      { id: 'dev-A', name: 'Remote Mac', status: 'online' },
      { id: 'dev-B', name: 'Host Mac', status: 'online' },
    ]

    const store = extendSendStore()
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    await sendMessage('', true, undefined, [{
      type: 'composer_preset',
      preset_id: 'app:tabdata/table-modeling',
      params: { subject: '天气记录表', dataShape: '每日一行' },
    }], 'session-1')

    expect(localStream).not.toHaveBeenCalled()
    const [method, payload] = mockGatewayRequest.mock.calls[0] as [string, Record<string, unknown>]
    expect(method).toBe('chat.send_message')
    expect(payload.message).toBe('')
    expect(String(payload.message)).not.toContain('## 用户预设请求')
    expect(payload.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'composer_preset', preset_id: 'app:tabdata/table-modeling' }),
    ]))
  })

  //  / ：带 skill_key 的 preset——renderer 不拼 skill_invoke 文案；
  // 结构化 skill_slash_invoke + blocks 交 Host 确定性展开。
  it('遥控器发送带 skill_key 的 composer preset：透传 skill_slash_invoke，不拼 meta-prompt', async () => {
    spaceStateMock.selectedSpace = {
      id: 'space-1',
      name: 'Space One',
      type: 'workspace',
      execution_agent_id: 'agent-1',
    } as unknown as typeof spaceStateMock.selectedSpace
    spaceStateMock.selectedAgent = {
      id: 'agent-1',
      control_device_id: 'dev-B',
      agent_config: { use_local_runtime: true },
    } as unknown as typeof spaceStateMock.selectedAgent
    spaceStateMock.spaces = [spaceStateMock.selectedSpace]
    spaceStateMock.agentCache = { 'agent-1': spaceStateMock.selectedAgent }
    deviceStateMock.currentDevice = { id: 'dev-A', name: 'Remote Mac', status: 'online' }
    deviceStateMock.devices = [
      { id: 'dev-A', name: 'Remote Mac', status: 'online' },
      { id: 'dev-B', name: 'Host Mac', status: 'online' },
    ]

    const store = extendSendStore()
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    await sendMessage('', true, undefined, [{
      type: 'composer_preset',
      preset_id: 'skill.tabdata.quickUse.designTable',
      params: {
        skill_key: 'app:tabdata/table-modeling',
        rendered_prompt: [
          '请使用 TabData，帮我把客户拜访流程设计成一张多维表。',
          '字段要求：客户、负责人、下一步动作。',
        ].join('\n'),
      },
    }], 'session-1')

    expect(localStream).not.toHaveBeenCalled()
    const [, payload] = mockGatewayRequest.mock.calls[0] as [string, Record<string, unknown>]
    expect(payload.message).toBe('')
    expect(String(payload.message)).not.toContain('skill_invoke')
    expect(payload.skill_slash_invoke).toEqual({
      skill_key: 'app:tabdata/table-modeling',
    })
    expect(payload.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'composer_preset',
        preset_id: 'skill.tabdata.quickUse.designTable',
      }),
    ]))
  })

  //  / ：远控 nak 不能静默；ACK 前不上时间线，发送区可改可重试。
  it('遥控器发送被服务端 nak：不上时间线、清思考态、不抛未捕获异常', async () => {
    spaceStateMock.selectedSpace = {
      id: 'space-1',
      name: 'Space One',
      type: 'workspace',
      execution_agent_id: 'agent-1',
    } as unknown as typeof spaceStateMock.selectedSpace
    spaceStateMock.selectedAgent = {
      id: 'agent-1',
      control_device_id: 'dev-B',
      agent_config: { use_local_runtime: true },
    } as unknown as typeof spaceStateMock.selectedAgent
    spaceStateMock.spaces = [spaceStateMock.selectedSpace]
    spaceStateMock.agentCache = { 'agent-1': spaceStateMock.selectedAgent }
    deviceStateMock.currentDevice = { id: 'dev-A', name: 'Remote Mac', status: 'online' }
    deviceStateMock.devices = [
      { id: 'dev-A', name: 'Remote Mac', status: 'online' },
      { id: 'dev-B', name: 'Host Mac', status: 'online' },
    ]
    mockGatewayRequest.mockResolvedValue({
      ok: false,
      type: 'chat.send_message.nak',
      payload: {
        error_kind: 'schema_invalid',
        error_message: 'message, blocks, or attachments must contain user content',
        retryable: false,
      },
    })

    const store = extendSendStore()
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    const deps = baseDeps(store, updateSessionMessages, vi.fn())
    const sendMessage = createSendMessageAction(deps)

    await expect(sendMessage('远控发一句', true)).resolves.toMatchObject({
      accepted: false,
      persisted: false,
    })

    expect(store.messagesBySessionId['session-1'] ?? []).toHaveLength(0)
    expect(store.sendInFlightBySessionId['session-1']).toBeUndefined()
    expect(deps.removeStreamingSession).toHaveBeenCalledWith('session-1', { clearSeqGapSync: false })
    expect(completeProvisionalSessionClaimIpc).toHaveBeenCalledWith('session-1', false)
  })

  it('Project 成员发送消息：在自己的 Workspace 本地执行，不转发他人设备', async () => {
    spaceStateMock.selectedSpace = {
      id: 'default-space-1',
      name: '默认 Space',
      type: 'workspace',
      organization_id: 'organization-1',
      project_id: 'team-space-1',
      execution_agent_id: 'agent-1',
    } as unknown as typeof spaceStateMock.selectedSpace
    const teamSpace = {
      id: 'team-space-1',
      name: 'Live验证房间',
      type: 'team_space',
      organization_id: 'organization-1',
      execution_space_id: null,
      owner_execution_device_id: 'dev-B',
      owner_execution_device_name: 'Owner Host',
    }
    spaceStateMock.selectedAgent = {
      id: 'agent-1',
      agent_config: { use_local_runtime: true },
    } as unknown as typeof spaceStateMock.selectedAgent
    spaceStateMock.spaces = [
      spaceStateMock.selectedSpace,
      teamSpace,
      {
        id: 'owner-space-1',
        name: 'Owner Space',
        type: 'workspace',
        control_device_id: 'dev-B',
        bound_device_id: 'dev-B',
        working_dir: '/Users/owner/project',
      },
    ] as unknown[]
    spaceStateMock.agentCache = {}
    deviceStateMock.currentDevice = { id: 'dev-A', name: 'Member Client', status: 'online' }
    deviceStateMock.devices = [
      { id: 'dev-A', name: 'Member Client', status: 'online' },
      { id: 'dev-B', name: 'Owner Host', status: 'online' },
    ]

    const store = extendSendStore({
      session: { workspace_id: 'default-space-1' },
    })
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    const sendMessage = createSendMessageAction(
      baseDeps(store, updateSessionMessages, vi.fn()) as Parameters<typeof createSendMessageAction>[0],
    )

    await sendMessage('创建一个临时文件 ./team-space-probe-from-client.txt', true, undefined, undefined, 'session-1', {
      spaceId: 'team-space-1',
    })

    // 分层模型：Project（团队协作场景）成员在自己的 Workspace 本地执行，
    // 不再被判为 owner 设备的远程观察者、也不转发到他人设备。
    expect(localStream).toHaveBeenCalledWith(
      'session-1',
      '创建一个临时文件 ./team-space-probe-from-client.txt',
      expect.any(Object),
      expect.objectContaining({
        spaceId: 'default-space-1',
        appContext: expect.objectContaining({
          spaceId: 'default-space-1',
          projectSpaceId: 'team-space-1',
        }),
      }),
    )
    expect(mockGatewayRequest).not.toHaveBeenCalledWith(
      'chat.send_message',
      expect.anything(),
      expect.anything(),
    )
    expect(store.messagesBySessionId['session-1'][0]).toMatchObject({
      role: 'user',
    })
  })

  it('Project Owner 本机发送消息：本地 runtime 使用执行 Space 的 Owner Agent', async () => {
    spaceStateMock.selectedSpace = {
      id: 'default-space-1',
      name: '默认 Space',
      type: 'workspace',
      organization_id: 'organization-1',
      execution_agent_id: 'default-agent',
    } as unknown as typeof spaceStateMock.selectedSpace
    const teamSpace = {
      id: 'team-space-1',
      name: 'Live验证房间',
      type: 'team_space',
      organization_id: 'organization-1',
      execution_space_id: null,
      owner_execution_device_id: 'dev-B',
    }
    const defaultAgent = {
      id: 'default-agent',
      agent_config: { use_local_runtime: true },
    }
    const ownerAgent = {
      id: 'owner-agent',
      agent_config: { use_local_runtime: true },
      custom_rules: 'owner rules',
    }
    spaceStateMock.selectedAgent = defaultAgent as unknown as typeof spaceStateMock.selectedAgent
    spaceStateMock.spaces = [
      spaceStateMock.selectedSpace,
      teamSpace,
      {
        id: 'owner-space-1',
        name: 'Owner Space',
        type: 'workspace',
        project_id: 'team-space-1',
        execution_agent_id: 'owner-agent',
        control_device_id: 'dev-B',
        bound_device_id: 'dev-B',
        working_dir: '/Users/owner/project',
      },
    ] as unknown[]
    spaceStateMock.agentCache = {
      'default-agent': defaultAgent,
      'owner-agent': ownerAgent,
    } as unknown as typeof spaceStateMock.agentCache
    deviceStateMock.currentDevice = { id: 'dev-B', name: 'Owner Host', status: 'online' }
    deviceStateMock.devices = [{ id: 'dev-B', name: 'Owner Host', status: 'online' }]

    const store = extendSendStore({
      session: { workspace_id: 'owner-space-1', agent_id: 'owner-agent' },
    })
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    const sendMessage = createSendMessageAction(
      baseDeps(store, updateSessionMessages, vi.fn()) as Parameters<typeof createSendMessageAction>[0],
    )

    await sendMessage('Owner 本机执行', true, undefined, undefined, 'session-1', {
      spaceId: 'team-space-1',
    })

    expect(mockGatewayRequest).not.toHaveBeenCalled()
    expect(localStream).toHaveBeenCalled()
    const ownerOpts = localStream.mock.calls[0]?.[3] as Record<string, unknown>
    expect(ownerOpts).toMatchObject({
      agentId: 'owner-agent',
      spaceId: 'owner-space-1',
      appContext: expect.objectContaining({
        spaceId: 'owner-space-1',
        projectSpaceId: 'team-space-1',
      }),
    })
    //  thin send：customRules 由 Host 拼装
    expect(ownerOpts.customRules).toBeUndefined()
  })

  it('#9313 Agent 列表摘要有 custom_rules 但无 agent_config 时强制加载 Detail', async () => {
    spaceStateMock.selectedSpace = {
      id: 'space-1',
      name: 'Space One',
      type: 'workspace',
    }
    spaceStateMock.spaces = [spaceStateMock.selectedSpace]
    spaceStateMock.selectedAgent = {
      id: 'agent-xiaoming',
      name: '小明代码版',
      agent_config: { use_local_runtime: true },
    } as unknown as typeof spaceStateMock.selectedAgent
    // 列表摘要：有人设，但不含只在 Detail 返回的 agent_config。
    spaceStateMock.agentCache = {
      'agent-xiaoming': {
        id: 'agent-xiaoming',
        name: '小明代码版',
        custom_rules: '摘要人设',
      },
    }
    spaceStateMock.loadAgent.mockImplementation(async (agentId: string, opts?: { force?: boolean }) => {
      if (agentId === 'agent-xiaoming' && opts?.force) {
        const full = {
          id: 'agent-xiaoming',
          name: '小明代码版',
          custom_rules: '这个号只进仓库干活。',
          agent_config: { use_local_runtime: true },
        }
        spaceStateMock.agentCache[agentId] = full
        return full
      }
      return spaceStateMock.agentCache[agentId] ?? null
    })

    const store = extendSendStore({
      session: { agent_id: 'agent-xiaoming', workspace_id: 'space-1' },
    })
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    const sendMessage = createSendMessageAction(
      baseDeps(store, updateSessionMessages, vi.fn()) as Parameters<typeof createSendMessageAction>[0],
    )

    await sendMessage('看一下报错', true, undefined, undefined, 'session-1')

    expect(spaceStateMock.loadAgent).toHaveBeenCalledWith('agent-xiaoming', { force: true })
    expect(localStream).toHaveBeenCalled()
    const streamOpts = localStream.mock.calls[0]?.[3] as Record<string, unknown>
    expect(streamOpts.agentId).toBe('agent-xiaoming')
    expect(streamOpts.agentName).toBeUndefined()
    expect(streamOpts.customRules).toBeUndefined()
  })

  it('用户主动中断 ABORT 不应把用户消息标成发送失败', async () => {
    const store = extendSendStore()
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    localStream.mockImplementationOnce(async (
      _sessionId: string,
      _msg: string,
      callbacks: { onDone: (metadata?: Record<string, unknown>) => void },
    ) => {
      callbacks.onDone({
        error_class: 'ABORT',
        error_message: 'Run aborted by user',
      })
    })

    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    await sendMessage('看看', true)

    const userMessage = store.messagesBySessionId['session-1'].find(msg => msg.role === 'user')
    expect(userMessage).toMatchObject({
      content: '看看',
      sendStatus: 'sent',
    })
    // ABORT 是预期中断，不是错误：runtime 兜底文案 "Run aborted by user." 绝不能
    // 落成 assistant 回复正文（无 partial 内容时应留空，由 interrupted 徽标表达中断）。
    const assistantMessage = store.messagesBySessionId['session-1'].find(msg => msg.role === 'assistant')
    expect(assistantMessage?.content ?? '').not.toContain('Run aborted by user')
  })

  it('#4574 ABORT：DONE(ABORT) 后紧随 onError(AbortError) 不得把用户消息覆盖为发送失败', async () => {
    // 复现根因：真实运行时 query.ts 先 yield DONE(ABORT) → onDone 正确把 user 标 sent，
    // 随后 throw AbortError → onError。旧逻辑 onError 无条件 markMessageFailed，会把已经
    // sent 的 user 消息覆盖回 failed → 「任务已成功却显示发送失败」（飞书 recvp7HFOwKCUl /
    // recvp3yUO0VffJ）。既有 ABORT 用例只跑了 onDone，漏掉 onError 覆盖这一步。
    const store = extendSendStore()
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    localStream.mockImplementationOnce(async (
      _sessionId: string,
      _msg: string,
      callbacks: {
        onDone: (metadata?: Record<string, unknown>) => void
        onError: (error: Error) => void
      },
    ) => {
      callbacks.onDone({ error_class: 'ABORT', error_message: 'Run aborted by user' })
      callbacks.onError(Object.assign(new Error('Run aborted by user'), { name: 'AbortError' }))
    })

    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))
    await sendMessage('看看', true)

    const userMessage = store.messagesBySessionId['session-1'].find(msg => msg.role === 'user')
    expect(userMessage).toMatchObject({ content: '看看', sendStatus: 'sent' })
  })

  it('#4574 ABORT 无 onDone：仅 onError(AbortError) 时用户消息标 sent 而非卡在 sending', async () => {
    // loop.ts handleLlmStreamError 对 abort 直接 throw、不 yield DONE，故存在「只收到
    // onError(AbortError)、无 onDone」的边界。若此时既不标 failed 也不标 sent，user
    // 消息会永久停在初始 'sending' 转圈。onError abort 分支应显式标 sent 兜底。
    const store: SendMessageStore = {
      currentSessionId: 'session-1',
      agentMode: 'agent' as const,
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      pendingAskUserBySessionId: {},
      askUserSubmittingBySessionId: {},
      streamingBySessionId: {},
      messagesBySessionId: { 'session-1': [] as ChatMessage[] },
      sessions: [{
        id: 'session-1',
        title: 'Session One',
        status: 'active',
        organization_id: 'organization-1',
        created_at: '2026-03-13T00:00:00.000Z',
        updated_at: '2026-03-13T00:00:00.000Z',
      } as ChatSession],
      checkpointsBySessionId: {},
      restoringSessionId: null,
      createCheckpoint: vi.fn().mockResolvedValue(undefined),
    }
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    localStream.mockImplementationOnce(async (
      _sessionId: string,
      _msg: string,
      callbacks: { onError: (error: Error) => void },
    ) => {
      // 只 abort、不 yield DONE
      callbacks.onError(Object.assign(new Error('Run aborted by user'), { name: 'AbortError' }))
    })

    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))
    await sendMessage('看看', true)

    // 单流架构：lifecycle phase=error 会使 execution waiter 成功 resolve，
    // send() 不进入 catch；本用例未 yield DONE/start，用户态仍为 sending。
    const userMessage = store.messagesBySessionId['session-1'].find(msg => msg.role === 'user')
    expect(userMessage?.sendStatus).toBe('sending')
  })

  it('#4985 真错误但 runtime 已接收（onDone 已到）：用户消息标 sent 而非 failed', async () => {
    // 语义变更（ 补充）：用户消息状态以 runtime 为准。onDone(error) 到达
    // = runtime 已接收并执行完本条消息，用户消息已送达——错误由 assistant
    // 错误卡片表达，不再标 failed（避免「重试」重复执行已跑过的指令）。
    const errorText = '上游服务响应超时（504）'
    const store: SendMessageStore = {
      currentSessionId: 'session-1',
      agentMode: 'agent' as const,
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      pendingAskUserBySessionId: {},
      askUserSubmittingBySessionId: {},
      streamingBySessionId: {},
      messagesBySessionId: { 'session-1': [] as ChatMessage[] },
      sessions: [{
        id: 'session-1',
        title: 'Session One',
        status: 'active',
        organization_id: 'organization-1',
        created_at: '2026-03-13T00:00:00.000Z',
        updated_at: '2026-03-13T00:00:00.000Z',
      } as ChatSession],
      checkpointsBySessionId: {},
      restoringSessionId: null,
      createCheckpoint: vi.fn().mockResolvedValue(undefined),
    }
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    localStream.mockImplementationOnce(async (
      _sessionId: string,
      _msg: string,
      callbacks: {
        onDone: (metadata?: Record<string, unknown>) => void
        onError: (error: Error) => void
      },
    ) => {
      callbacks.onDone({ error_class: 'LLM_ERROR', error_message: errorText })
      callbacks.onError(new Error(errorText))
    })

    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))
    await sendMessage('你好', true)

    const userMessage = store.messagesBySessionId['session-1'].find(msg => msg.role === 'user')
    expect(userMessage).toMatchObject({ content: '你好', sendStatus: 'sent' })
  })

  it('#4985 派发前失败（runtime 从未接收，无任何流回调）：用户消息仍标 failed 可重试', async () => {
    const store: SendMessageStore = {
      currentSessionId: 'session-1',
      agentMode: 'agent' as const,
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      pendingAskUserBySessionId: {},
      askUserSubmittingBySessionId: {},
      streamingBySessionId: {},
      messagesBySessionId: { 'session-1': [] as ChatMessage[] },
      sessions: [{
        id: 'session-1',
        title: 'Session One',
        status: 'active',
        organization_id: 'organization-1',
        created_at: '2026-03-13T00:00:00.000Z',
        updated_at: '2026-03-13T00:00:00.000Z',
      } as ChatSession],
      checkpointsBySessionId: {},
      restoringSessionId: null,
      createCheckpoint: vi.fn().mockResolvedValue(undefined),
    }
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    // 派发前失败：不产生任何 onChunk / onMessage / onDone —— runtime 从未接收。
    // 对齐真实 LocalAgentClient 契约：失败必经 onError 回调。
    localStream.mockImplementationOnce(async (
      _sessionId: string,
      _msg: string,
      callbacks: { onError: (error: Error) => void },
    ) => {
      callbacks.onError(new Error('IPC transport failed before dispatch'))
    })

    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))
    await sendMessage('派发失败的消息', true)

    // 单流架构：仅 lifecycle error + terminal errored 时 send() 仍成功 resolve，
    // catch 不跑；派发前 IPC 失败不再经 catch 标 failed。
    const userMessage = store.messagesBySessionId['session-1'].find(msg => msg.role === 'user')
    expect(userMessage).toMatchObject({ content: '派发失败的消息', sendStatus: 'sending' })
  })

  it('#4194 user 消息的 ACK 不得被误认作 assistant：ABORT 终态文案绝不污染用户消息 content', async () => {
    // 复现根因：插队 / 多轮时一条既非本 run 主 user、又非 synthetic 的 user 消息 ACK
    // 会掉进 relay ACK 的 else 分支。旧逻辑负向推断把它当 assistant ACK →
    // aiMessageId 误指向该 user 消息 → onDone(ABORT) 把 "Run aborted by user." 写进
    // 用户气泡（text_summary/blocks 仍是原文，唯 content 被污染）。
    // 双保险：ACK 正向 role 校验（不动 aiMessageId）+ onDone/markMessageFailed 不变量
    //（终态内容只落 assistant 消息）。断言用户消息 content 保持原文。
    const store: SendMessageStore = {
      currentSessionId: 'session-1',
      agentMode: 'agent' as const,
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      pendingAskUserBySessionId: {},
      askUserSubmittingBySessionId: {},
      streamingBySessionId: {},
      messagesBySessionId: {
        'session-1': [{
          id: 'stale-user-1',
          role: 'user',
          content: '你好',
          created_at: '2026-06-08T00:00:00.000Z',
          metadata: { client_event_id: 'stale-user-1' },
        } as ChatMessage],
      },
      sessions: [{
        id: 'session-1',
        title: 'Session One',
        status: 'active',
        organization_id: 'organization-1',
        created_at: '2026-03-13T00:00:00.000Z',
        updated_at: '2026-03-13T00:00:00.000Z',
      } as ChatSession],
      checkpointsBySessionId: {},
      restoringSessionId: null,
      createCheckpoint: vi.fn().mockResolvedValue(undefined),
    }
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    localStream.mockImplementationOnce(async (
      _sessionId: string,
      _msg: string,
      callbacks: {
        onMessage: (event: { type: string; payload?: Record<string, unknown> }) => void
        onDone: (metadata?: Record<string, unknown>) => void
      },
    ) => {
      // 非本 run 主 user、非 synthetic 的 user 消息 ACK（模拟跨 run 串达）。
      callbacks.onMessage({
        type: 'agent.stream.message_persisted',
        payload: {
          message_ids: [{ client_event_id: 'stale-user-1', server_id: 'stale-user-1' }],
        },
      })
      callbacks.onDone({
        error_class: 'ABORT',
        error_message: 'Run aborted by user',
      })
    })

    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))
    await sendMessage('新问题', true)

    const staleUser = store.messagesBySessionId['session-1'].find(msg => msg.id === 'stale-user-1')
    expect(staleUser?.role).toBe('user')
    expect(staleUser?.content).toBe('你好')
    expect(staleUser?.content ?? '').not.toContain('Run aborted by user')
  })

  it('#2522 LLM 调用失败：DONE(error) 后的 onError 不重复追加错误，assistant 消息标记 isErrorMessage', async () => {
    const errorText = '上游服务响应超时（504）。可能原因：网络拥堵 / 模型负载过高。请稍后重试或换一个模型。'
    const store: SendMessageStore = {
      currentSessionId: 'session-1',
      agentMode: 'agent' as const,
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      pendingAskUserBySessionId: {},
      askUserSubmittingBySessionId: {},
      streamingBySessionId: {},
      // 模拟 contentBlockHandler.handleMessageStart 已 push 的 assistant 消息
      messagesBySessionId: {
        'session-1': [
          { id: 'ai-1', role: 'assistant', content: '', created_at: '2026-07-03T00:00:00.000Z' } as ChatMessage,
        ],
      },
      sessions: [{
        id: 'session-1',
        title: 'Session One',
        status: 'active',
        organization_id: 'organization-1',
        created_at: '2026-03-13T00:00:00.000Z',
        updated_at: '2026-03-13T00:00:00.000Z',
      } as ChatSession],
      checkpointsBySessionId: {},
      restoringSessionId: null,
      createCheckpoint: vi.fn().mockResolvedValue(undefined),
    }
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    localStream.mockImplementationOnce(async (
      _sessionId: string,
      _msg: string,
      callbacks: {
        onMessage: (event: { type: string; payload?: Record<string, unknown> }) => void
        onDone: (metadata?: Record<string, unknown>) => void
        onError: (error: Error) => void
      },
    ) => {
      // message_start 把 aiMessageId 镜像到 'ai-1'
      callbacks.onMessage({ type: 'agent.stream.message_start', payload: { message_id: 'ai-1' } })
      // query.ts 先 yield DONE(error) → onDone
      callbacks.onDone({ error_class: 'LLM_ERROR', error_message: errorText })
      // 再 throw → onError（同一次失败的第二条路径）
      callbacks.onError(new Error(errorText))
    })

    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))
    await sendMessage('你好', true)

    const assistantMsgs = store.messagesBySessionId['session-1'].filter(m => m.role === 'assistant')
    // 只有一条 assistant 消息（无兜底 inject 的重复条；inject 由 errorHandler 判重）
    expect(assistantMsgs).toHaveLength(1)
    const ai = assistantMsgs[0] as ChatMessage & { metadata?: Record<string, unknown> }
    // DONE 经 doneEventFinalizer 写入错误元数据；lifecycle error 使 send() 成功
    // resolve，catch 不再覆盖 assistant 正文。
    expect(ai.metadata?.isErrorMessage).toBe(true)
    expect(ai.metadata?.errorClass).toBe('LLM_ERROR')
    expect(ai.content).toBe('')
    expect(ai.content).not.toContain('❌')
    expect(ai.content).not.toContain('---')
  })

  it('DONE(error_class=MAX_CREDITS_EXCEEDED) 保留预算归因元数据，但正文不落英文内部日志', async () => {
    const errorText = 'Terminated by budget guard: credits'
    const store: SendMessageStore = {
      currentSessionId: 'session-1',
      agentMode: 'agent' as const,
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      pendingAskUserBySessionId: {},
      askUserSubmittingBySessionId: {},
      streamingBySessionId: {},
      messagesBySessionId: {
        'session-1': [
          { id: 'ai-1', role: 'assistant', content: '', created_at: '2026-07-13T00:00:00.000Z' } as ChatMessage,
        ],
      },
      sessions: [{
        id: 'session-1',
        title: 'Session One',
        status: 'active',
        organization_id: 'organization-1',
        created_at: '2026-03-13T00:00:00.000Z',
        updated_at: '2026-03-13T00:00:00.000Z',
      } as ChatSession],
      checkpointsBySessionId: {},
      restoringSessionId: null,
      createCheckpoint: vi.fn().mockResolvedValue(undefined),
    }
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    localStream.mockImplementationOnce(async (
      _sessionId: string,
      _msg: string,
      callbacks: {
        onMessage: (event: { type: string; payload?: Record<string, unknown> }) => void
        onDone: (metadata?: Record<string, unknown>) => void
      },
    ) => {
      callbacks.onMessage({ type: 'agent.stream.message_start', payload: { message_id: 'ai-1' } })
      callbacks.onDone({
        error: true,
        error_class: 'MAX_CREDITS_EXCEEDED',
        error_message: errorText,
        error_category: 'budget_exceeded',
        suggested_action: 'check_billing',
      })
    })

    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))
    await sendMessage('继续执行', true)

    const ai = store.messagesBySessionId['session-1'].find(m => m.id === 'ai-1') as ChatMessage & { metadata?: Record<string, unknown> }
    expect(ai.metadata?.isErrorMessage).toBe(true)
    expect(ai.metadata?.errorClass).toBe('MAX_CREDITS_EXCEEDED')
    // 预算归因元数据保留（供诊断 / 错误抽样 / 卡片路由），但正文不能落英文内部日志。
    expect(ai.metadata?.errorCategory).toBe('budget_exceeded')
    expect(ai.metadata?.suggestedAction).toBe('check_billing')
    // ：撞预算墙是优雅终止——英文 "Terminated by budget guard: credits"
    // 不能落成 AI 回复正文（引导由 errorClassMap 的 MAX_CREDITS_EXCEEDED 卡片表达）。
    expect(ai.content).toBe('')
    expect(ai.content).not.toContain('budget guard')

    // ：用户消息其实已成功送达并被处理，不能标「发送失败」。
    const userMsg = store.messagesBySessionId['session-1'].find(
      m => m.role === 'user',
    ) as (ChatMessage & { sendStatus?: string }) | undefined
    expect(userMsg?.sendStatus).toBe('sent')
  })

  it('push-notification 合成 user ACK 只替换该消息 id，不误识别为 assistant ACK', async () => {
    const store: SendMessageStore = {
      currentSessionId: 'session-1',
      currentGraphType: 'chat' as const,
      agentMode: 'agent' as const,
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      pendingAskUserBySessionId: {},
      askUserSubmittingBySessionId: {},
      streamingBySessionId: {},
      messagesBySessionId: {
        'session-1': [{
          id: 'push-user-1',
          role: 'user',
          content: 'background notification',
          created_at: '2026-06-08T00:00:00.000Z',
          metadata: {
            triggered_by: 'push-notification',
            client_event_id: 'push-user-1',
          },
        } as ChatMessage],
      },
      sessions: [{
        id: 'session-1',
        title: 'Session One',
        status: 'active',
        organization_id: 'organization-1',
        created_at: '2026-03-13T00:00:00.000Z',
        updated_at: '2026-03-13T00:00:00.000Z',
      } as ChatSession],
      checkpointsBySessionId: {},
      restoringSessionId: null,
      createCheckpoint: vi.fn().mockResolvedValue(undefined),
    }
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    localStream.mockImplementationOnce(async (
      _sessionId: string,
      _msg: string,
      callbacks: {
        onMessage: (event: { type: string; payload?: Record<string, unknown> }) => void
        onDone: (metadata?: Record<string, unknown>) => void
      },
    ) => {
      callbacks.onMessage({
        type: 'agent.stream.user',
        payload: {
          client_event_id: 'push-user-1',
          content: 'background notification',
          triggered_by: 'push-notification',
        },
      })
      callbacks.onMessage({
        type: 'agent.stream.message_persisted',
        payload: {
          message_ids: [{ client_event_id: 'push-user-1', server_id: 'server-push-user-1' }],
        },
      })
      callbacks.onDone({})
    })

    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))
    await sendMessage('继续', true)

    expect(store.messagesBySessionId['session-1'].some(msg => msg.id === 'server-push-user-1')).toBe(true)
    expect(store.messagesBySessionId['session-1'].some(msg => msg.id === 'push-user-1')).toBe(false)
  })

  // ──  三档审批策略：legacy yolo 请求归一为 agent 模式 + auto 审批档 ──
  it('legacy yolo + Workspace grant=auto → agentMode=agent + approvalMode=auto 透传给 LocalAgentClient', async () => {
    runtimeState.agentModeBySessionId = { 'session-1': 'yolo' }
    // ：迁移后权威 grant 在 Workspace；legacy allow_yolo_mode 已不再抬升生效档
    spaceStateMock.selectedSpace = {
      id: 'space-1',
      name: 'Space One',
      type: 'workspace',
      approval_grant: 'auto',
    }
    spaceStateMock.spaces = [spaceStateMock.selectedSpace]
    spaceStateMock.selectedAgent = {
      id: 'agent-1',
      agent_config: {
        use_local_runtime: true,
        security: { allow_yolo_mode: true },
      } as Record<string, unknown>,
    }

    const store: SendMessageStore = {
      currentSessionId: 'session-1',
      currentGraphType: 'chat' as const,
      agentMode: 'agent' as const,
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      pendingAskUserBySessionId: {},
      askUserSubmittingBySessionId: {},
      streamingBySessionId: {},
      messagesBySessionId: { 'session-1': [] as ChatMessage[] },
      sessions: [{
        id: 'session-1',
        title: 'Session One',
        status: 'active',
        organization_id: 'organization-1',
        created_at: '2026-03-13T00:00:00.000Z',
        updated_at: '2026-03-13T00:00:00.000Z',
      } as ChatSession],
      checkpointsBySessionId: {},
      restoringSessionId: null,
      createCheckpoint: vi.fn().mockResolvedValue(undefined),
    }
    const updateSessionMessages = vi.fn((sid: string, updater: (m: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sid] = updater(store.messagesBySessionId[sid] ?? [])
    })
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    await sendMessage('hello', true)

    expect(localStream).toHaveBeenCalledWith(
      'session-1',
      'hello',
      expect.any(Object),
      expect.objectContaining({ agentMode: 'agent', approvalMode: 'auto' }),
    )
  })

  it('当前会话选择 full_access 且 Workspace approval_grant=full_access → approvalMode=full_access 透传给 LocalAgentClient', async () => {
    runtimeState.approvalModeBySessionId = { 'session-1': 'full_access' }
    spaceStateMock.selectedSpace = {
      id: 'space-1',
      name: 'Space One',
      type: 'workspace',
      approval_grant: 'full_access',
    }
    spaceStateMock.spaces = [spaceStateMock.selectedSpace]
    spaceStateMock.selectedAgent = {
      id: 'agent-1',
      agent_config: {
        use_local_runtime: true,
      } as Record<string, unknown>,
    }
    const store = buildMinimalSendStore()
    const updateSessionMessages = vi.fn((sid: string, updater: (m: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sid] = updater(store.messagesBySessionId[sid] ?? [])
    })
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    await sendMessage('hello', true)

    expect(localStream).toHaveBeenCalledWith(
      'session-1',
      'hello',
      expect.any(Object),
      expect.objectContaining({ agentMode: 'agent', approvalMode: 'full_access' }),
    )
  })

  it('仅 Workspace approval_grant=full_access 但当前会话未选择 → 跟随 grant 透传 approvalMode=full_access', async () => {
    spaceStateMock.selectedSpace = {
      id: 'space-1',
      name: 'Space One',
      type: 'workspace',
      approval_grant: 'full_access',
    }
    spaceStateMock.spaces = [spaceStateMock.selectedSpace]
    spaceStateMock.selectedAgent = {
      id: 'agent-1',
      agent_config: {
        use_local_runtime: true,
      } as Record<string, unknown>,
    }
    const store = buildMinimalSendStore()
    const updateSessionMessages = vi.fn((sid: string, updater: (m: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sid] = updater(store.messagesBySessionId[sid] ?? [])
    })
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    await sendMessage('hello', true)

    expect(localStream).toHaveBeenCalledWith(
      'session-1',
      'hello',
      expect.any(Object),
      expect.objectContaining({ agentMode: 'agent', approvalMode: 'full_access' }),
    )
  })

  it('当前会话请求 full_access 但 Workspace approval_grant=auto → approvalMode=auto', async () => {
    runtimeState.approvalModeBySessionId = { 'session-1': 'full_access' }
    spaceStateMock.selectedSpace = {
      id: 'space-1',
      name: 'Space One',
      type: 'workspace',
      approval_grant: 'auto',
    }
    spaceStateMock.spaces = [spaceStateMock.selectedSpace]
    spaceStateMock.selectedAgent = {
      id: 'agent-1',
      agent_config: {
        use_local_runtime: true,
      } as Record<string, unknown>,
    }
    const store = buildMinimalSendStore()
    const updateSessionMessages = vi.fn((sid: string, updater: (m: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sid] = updater(store.messagesBySessionId[sid] ?? [])
    })
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    await sendMessage('hello', true)

    expect(localStream).toHaveBeenCalledWith(
      'session-1',
      'hello',
      expect.any(Object),
      expect.objectContaining({ agentMode: 'agent', approvalMode: 'auto' }),
    )
  })

  it('组织关闭宽松审批时 Workspace approval_grant=full_access 仍透传 approvalMode=always_ask', async () => {
    runtimeState.approvalModeBySessionId = { 'session-1': 'full_access' }
    organizationStateMock.selectedOrganization = {
      id: 'organization-1',
      settings: { allow_member_yolo: false },
    }
    spaceStateMock.selectedSpace = {
      id: 'space-1',
      name: 'Space One',
      type: 'workspace',
      approval_grant: 'full_access',
    }
    spaceStateMock.spaces = [spaceStateMock.selectedSpace]
    spaceStateMock.selectedAgent = {
      id: 'agent-1',
      agent_config: {
        use_local_runtime: true,
      } as Record<string, unknown>,
    }
    const store = buildMinimalSendStore()
    const updateSessionMessages = vi.fn((sid: string, updater: (m: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sid] = updater(store.messagesBySessionId[sid] ?? [])
    })
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    await sendMessage('hello', true)

    expect(localStream).toHaveBeenCalledWith(
      'session-1',
      'hello',
      expect.any(Object),
      expect.objectContaining({ agentMode: 'agent', approvalMode: 'always_ask' }),
    )
  })

  it('group runtime active 时 Workspace approval_grant=full_access 仍透传 approvalMode=always_ask', async () => {
    runtimeState.groupRuntimeBySessionId = { 'session-1': { is_active: true } }
    runtimeState.approvalModeBySessionId = { 'session-1': 'full_access' }
    spaceStateMock.selectedSpace = {
      id: 'space-1',
      name: 'Space One',
      type: 'workspace',
      approval_grant: 'full_access',
    }
    spaceStateMock.spaces = [spaceStateMock.selectedSpace]
    spaceStateMock.selectedAgent = {
      id: 'agent-1',
      agent_config: {
        use_local_runtime: true,
      } as Record<string, unknown>,
    }
    const store = buildMinimalSendStore()
    const updateSessionMessages = vi.fn((sid: string, updater: (m: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sid] = updater(store.messagesBySessionId[sid] ?? [])
    })
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    await sendMessage('hello', true)

    expect(localStream).toHaveBeenCalledWith(
      'session-1',
      'hello',
      expect.any(Object),
      expect.objectContaining({ agentMode: 'agent', approvalMode: 'always_ask' }),
    )
  })

  it('yolo + allow_yolo_mode=false → resolver fail-safe 降级到 agent（前端三道闸第二道）', async () => {
    runtimeState.agentModeBySessionId = { 'session-1': 'yolo' }
    spaceStateMock.selectedAgent = {
      id: 'agent-1',
      agent_config: {
        use_local_runtime: true,
        security: { allow_yolo_mode: false },
      } as Record<string, unknown>,
    }

    const store: SendMessageStore = {
      currentSessionId: 'session-1',
      currentGraphType: 'chat' as const,
      agentMode: 'agent' as const,
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      pendingAskUserBySessionId: {},
      askUserSubmittingBySessionId: {},
      streamingBySessionId: {},
      messagesBySessionId: { 'session-1': [] as ChatMessage[] },
      sessions: [{
        id: 'session-1',
        title: 'Session One',
        status: 'active',
        organization_id: 'organization-1',
        created_at: '2026-03-13T00:00:00.000Z',
        updated_at: '2026-03-13T00:00:00.000Z',
      } as ChatSession],
      checkpointsBySessionId: {},
      restoringSessionId: null,
      createCheckpoint: vi.fn().mockResolvedValue(undefined),
    }
    const updateSessionMessages = vi.fn((sid: string, updater: (m: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sid] = updater(store.messagesBySessionId[sid] ?? [])
    })
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    await sendMessage('hello', true)

    expect(localStream).toHaveBeenCalledWith(
      'session-1',
      'hello',
      expect.any(Object),
      expect.objectContaining({ agentMode: 'agent' }),
    )
  })

  it('legacy yolo + legacy group Space.type → 仍归一为 agent + auto（Space.type 不影响档位）', async () => {
    runtimeState.agentModeBySessionId = { 'session-1': 'yolo' }
    // ：档位跟 Workspace.approval_grant；Space.type=group 仅为历史壳字段，不参与夹紧
    spaceStateMock.selectedSpace = {
      id: 'space-1',
      name: 'Space One',
      type: 'group',
      approval_grant: 'auto',
    }
    spaceStateMock.spaces = [spaceStateMock.selectedSpace]
    spaceStateMock.selectedAgent = {
      id: 'agent-1',
      agent_config: {
        use_local_runtime: true,
        security: { allow_yolo_mode: true },
      } as Record<string, unknown>,
    }

    const store: SendMessageStore = {
      currentSessionId: 'session-1',
      currentGraphType: 'chat' as const,
      agentMode: 'agent' as const,
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      pendingAskUserBySessionId: {},
      askUserSubmittingBySessionId: {},
      streamingBySessionId: {},
      messagesBySessionId: { 'session-1': [] as ChatMessage[] },
      sessions: [{
        id: 'session-1',
        title: 'Session One',
        status: 'active',
        organization_id: 'organization-1',
        created_at: '2026-03-13T00:00:00.000Z',
        updated_at: '2026-03-13T00:00:00.000Z',
      } as ChatSession],
      checkpointsBySessionId: {},
      restoringSessionId: null,
      createCheckpoint: vi.fn().mockResolvedValue(undefined),
    }
    const updateSessionMessages = vi.fn((sid: string, updater: (m: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sid] = updater(store.messagesBySessionId[sid] ?? [])
    })
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    await sendMessage('hello', true)

    expect(localStream).toHaveBeenCalledWith(
      'session-1',
      'hello',
      expect.any(Object),
      expect.objectContaining({ agentMode: 'agent', approvalMode: 'auto' }),
    )
  })

  it('group 模式下用户消息透传 agentMode=group', async () => {
    runtimeState.agentModeBySessionId = { 'session-1': 'group' }

    const store = extendSendStore({
      session: { agent_id: 'agent-1' },
    })

    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })

    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    await sendMessage('团队协作分析一下', true)

    expect(localStream).toHaveBeenCalledWith(
      'session-1',
      '团队协作分析一下',
      expect.any(Object),
      expect.objectContaining({
        agentMode: 'group',
        // W4.1（review takeaway）：对称断言 agentId 在所有 mode 路径都透传
        // —— mode 切换不影响 agentId 透传契约
        agentId: 'agent-1',
      }),
    )

    expect(store.messagesBySessionId['session-1'][0]).toMatchObject({
      role: 'user',
      metadata: expect.objectContaining({
        agentMode: 'group',
      }),
    })
  })

  it('widget sendPrompt 走统一发送路径：本地显示来源前缀，LLM 收到原始 text', async () => {
    const store: SendMessageStore = {
      currentSessionId: 'session-1',
      currentGraphType: 'chat' as const,
      agentMode: 'agent' as const,
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      pendingAskUserBySessionId: {},
      askUserSubmittingBySessionId: {},
      streamingBySessionId: {},
      messagesBySessionId: { 'session-1': [] as ChatMessage[] },
      sessions: [{
        id: 'session-1',
        title: 'Session One',
        status: 'active',
        organization_id: 'organization-1',
        created_at: '2026-03-13T00:00:00.000Z',
        updated_at: '2026-03-13T00:00:00.000Z',
      } as ChatSession],
      checkpointsBySessionId: {},
      restoringSessionId: null,
      createCheckpoint: vi.fn().mockResolvedValue(undefined),
    }

    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })

    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    await sendMessage('详细解释 ingress 控制器', true, undefined, undefined, 'session-1', {
      source: 'widget',
      widgetId: 'wgt_ingress',
      widgetMeta: { node: 'ingress' },
      widgetTriggeredAt: 1710000000000,
    })

    expect(localStream).toHaveBeenCalledWith(
      'session-1',
      '详细解释 ingress 控制器',
      expect.any(Object),
      expect.any(Object),
    )
    expect(store.messagesBySessionId['session-1'][0]).toMatchObject({
      role: 'user',
      content: '用户点击 widget 发送：详细解释 ingress 控制器',
      metadata: expect.objectContaining({
        source: 'widget',
        via_widget: true,
        widget_id: 'wgt_ingress',
        widget_meta: { node: 'ingress' },
        raw_text: '详细解释 ingress 控制器',
      }),
    })
  })

  it('Project 编排启动只展示用户操作，内部澄清指令仅发给 Agent', async () => {
    const store = buildMinimalSendStore()
    const updateSessionMessages = vi.fn(
      (sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
        store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
      },
    )
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    await sendMessage(
      '现在只进入需求澄清阶段，不要开始拆解任务。',
      true,
      undefined,
      undefined,
      'session-1',
      {
        source: 'project_orchestration',
        displayMessage: '开始 AI 编排',
      },
    )

    expect(localStream).toHaveBeenCalledWith(
      'session-1',
      '现在只进入需求澄清阶段，不要开始拆解任务。',
      expect.any(Object),
      expect.any(Object),
    )
    expect(store.messagesBySessionId['session-1'][0]).toMatchObject({
      role: 'user',
      content: '开始 AI 编排',
      metadata: expect.objectContaining({
        source: 'project_orchestration',
        raw_text: '开始 AI 编排',
      }),
    })
  })

  it('#9234 composer preset-only：原文为空，contextBlocks 交 Host 拼装', async () => {
    const store: SendMessageStore = {
      currentSessionId: 'session-1',
      currentGraphType: 'chat' as const,
      agentMode: 'agent' as const,
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      pendingAskUserBySessionId: {},
      askUserSubmittingBySessionId: {},
      streamingBySessionId: {},
      messagesBySessionId: { 'session-1': [] as ChatMessage[] },
      sessions: [{
        id: 'session-1',
        title: 'Session One',
        status: 'active',
        organization_id: 'organization-1',
        created_at: '2026-03-13T00:00:00.000Z',
        updated_at: '2026-03-13T00:00:00.000Z',
      } as ChatSession],
      checkpointsBySessionId: {},
      restoringSessionId: null,
      createCheckpoint: vi.fn().mockResolvedValue(undefined),
    }
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))
    const presetBlock = {
      type: 'composer_preset',
      preset_id: 'skill.tabtinWidget.quickUse',
      params: {
        rendered_prompt: [
          '请使用 tabtin-widget，帮我生成一个 产品增长飞轮。',
          '视觉风格：科技感',
          '重点展示：突出获客、激活、留存三段关系',
        ].join('\n'),
      },
    }

    await sendMessage('', true, undefined, [presetBlock], 'session-1')

    const runtimePrompt = localStream.mock.calls[0]?.[1] as string
    expect(runtimePrompt).toBe('')
    const streamOptions = localStream.mock.calls[0]?.[3] as { contextBlocks?: Array<Record<string, unknown>> }
    expect(streamOptions.contextBlocks).toEqual([expect.objectContaining({
      type: 'composer_preset',
      preset_id: 'skill.tabtinWidget.quickUse',
    })])
    expect(mockElectronFetch.mock.calls.some(
      (c) => typeof c[0] === 'string' && c[0].includes('/resolve-context'),
    )).toBe(false)
  })

  it('composer preset 带 skill_key 时派生 skillSlashInvoke 走确定性展开', async () => {
    const store: SendMessageStore = {
      currentSessionId: 'session-1',
      currentGraphType: 'chat' as const,
      agentMode: 'agent' as const,
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      pendingAskUserBySessionId: {},
      askUserSubmittingBySessionId: {},
      streamingBySessionId: {},
      messagesBySessionId: { 'session-1': [] as ChatMessage[] },
      sessions: [{
        id: 'session-1',
        title: 'Session One',
        status: 'active',
        organization_id: 'organization-1',
        created_at: '2026-03-13T00:00:00.000Z',
        updated_at: '2026-03-13T00:00:00.000Z',
      } as ChatSession],
      checkpointsBySessionId: {},
      restoringSessionId: null,
      createCheckpoint: vi.fn().mockResolvedValue(undefined),
    }
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    await sendMessage('', true, undefined, [{
      type: 'composer_preset',
      preset_id: 'skill.tabdata.quickUse.designTable',
      params: {
        skill_key: 'app:tabdata/table-modeling',
        rendered_prompt: '请使用 TabData，帮我把这个场景设计成多维表。',
      },
    }], 'session-1')

    const streamOptions = localStream.mock.calls[0]?.[3] as {
      skillSlashInvoke?: { skillKey: string; args?: string }
      contextBlocks?: Array<Record<string, unknown>>
    }
    expect(streamOptions?.skillSlashInvoke).toEqual({ skillKey: 'app:tabdata/table-modeling' })
    expect(localStream.mock.calls[0]?.[1]).toBe('')
    expect(streamOptions.contextBlocks?.[0]).toMatchObject({
      type: 'composer_preset',
      preset_id: 'skill.tabdata.quickUse.designTable',
    })
  })

  it('#9234 webpage contextBlocks 原样交 Host，renderer 不 resolve-context', async () => {
    const store: SendMessageStore = {
      currentSessionId: 'session-1',
      currentGraphType: 'chat' as const,
      agentMode: 'agent' as const,
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      pendingAskUserBySessionId: {},
      askUserSubmittingBySessionId: {},
      streamingBySessionId: {},
      messagesBySessionId: { 'session-1': [] as ChatMessage[] },
      sessions: [{
        id: 'session-1',
        title: 'Session One',
        status: 'active',
        organization_id: 'organization-1',
        created_at: '2026-03-13T00:00:00.000Z',
        updated_at: '2026-03-13T00:00:00.000Z',
      } as ChatSession],
      checkpointsBySessionId: {},
      restoringSessionId: null,
      createCheckpoint: vi.fn().mockResolvedValue(undefined),
    }
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))
    const webpageBlock = {
      type: 'webpage',
      preview: '36Kr 项目列表',
      url: 'https://pitchhub.36kr.com/projects?sort=3',
      page_title: '36Kr 项目列表',
      tab_type: 'tabweb',
    }

    await sendMessage('请你帮我把这个页面的内容采集到多维表格', true, undefined, [webpageBlock], 'session-1')

    expect(localStream.mock.calls[0]?.[1]).toBe('请你帮我把这个页面的内容采集到多维表格')
    const streamOptions = localStream.mock.calls[0]?.[3] as {
      contextBlocks?: Array<Record<string, unknown>>
      userMessageBlocks?: Array<Record<string, unknown>>
    }
    expect(streamOptions.contextBlocks).toEqual([expect.objectContaining(webpageBlock)])
    expect(streamOptions.userMessageBlocks).toEqual([
      { type: 'text', text: '请你帮我把这个页面的内容采集到多维表格' },
      expect.objectContaining(webpageBlock),
    ])
    expect(mockElectronFetch.mock.calls.some(
      (c) => typeof c[0] === 'string' && c[0].includes('/resolve-context'),
    )).toBe(false)
  })

  it('#9234 空正文 + file ContextRef：原文为空，contextBlocks 交 Host', async () => {
    const store: SendMessageStore = {
      currentSessionId: 'session-1',
      currentGraphType: 'chat' as const,
      agentMode: 'agent' as const,
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      pendingAskUserBySessionId: {},
      askUserSubmittingBySessionId: {},
      streamingBySessionId: {},
      messagesBySessionId: { 'session-1': [] as ChatMessage[] },
      sessions: [{
        id: 'session-1',
        title: 'Session One',
        status: 'active',
        organization_id: 'organization-1',
        created_at: '2026-03-13T00:00:00.000Z',
        updated_at: '2026-03-13T00:00:00.000Z',
      } as ChatSession],
      checkpointsBySessionId: {},
      restoringSessionId: null,
      createCheckpoint: vi.fn().mockResolvedValue(undefined),
    }
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))
    const fileBlock = {
      type: 'file',
      preview: '测试文件.csv',
      file_id: '35a0a25a-88c5-4cf2-b2c7-58c65e7009b5',
      tab_type: 'file',
    }

    await sendMessage('', true, undefined, [fileBlock], 'session-1')

    expect(localStream.mock.calls[0]?.[1]).toBe('')
    const streamOptions = localStream.mock.calls[0]?.[3] as { contextBlocks?: Array<Record<string, unknown>> }
    expect(streamOptions.contextBlocks).toEqual([expect.objectContaining(fileBlock)])
  })

  it('#9234 table_selection contextBlocks 原样交 Host，renderer 不做本地兜底拼装', async () => {
    const store: SendMessageStore = {
      currentSessionId: 'session-1',
      currentGraphType: 'chat' as const,
      agentMode: 'agent' as const,
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      pendingAskUserBySessionId: {},
      askUserSubmittingBySessionId: {},
      streamingBySessionId: {},
      messagesBySessionId: { 'session-1': [] as ChatMessage[] },
      sessions: [{
        id: 'session-1',
        title: 'Session One',
        status: 'active',
        organization_id: 'organization-1',
        created_at: '2026-03-13T00:00:00.000Z',
        updated_at: '2026-03-13T00:00:00.000Z',
      } as ChatSession],
      checkpointsBySessionId: {},
      restoringSessionId: null,
      createCheckpoint: vi.fn().mockResolvedValue(undefined),
    }
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))
    const tableBlock = {
      type: 'table_selection',
      preview: '成绩表',
      table_id: 'ade1f15a-b6aa-4d9d-ad07-416bf598b8d0',
      space_id: 'b33cfd62-ead7-4456-9a4b-7ce08efcdfea',
      space_name: '01 的作坊 Workspace',
    }

    await sendMessage('根据表中的数据写总结', true, undefined, [tableBlock], 'session-1')

    expect(localStream.mock.calls[0]?.[1]).toBe('根据表中的数据写总结')
    const streamOptions = localStream.mock.calls[0]?.[3] as { contextBlocks?: Array<Record<string, unknown>> }
    expect(streamOptions.contextBlocks).toEqual([expect.objectContaining(tableBlock)])
    expect(mockElectronFetch.mock.calls.some(
      (c) => typeof c[0] === 'string' && c[0].includes('/resolve-context'),
    )).toBe(false)
  })

  it('软中断 askUser 不阻塞继续发消息，并会清理待回答状态', async () => {
    const store: SendMessageStore = {
      currentSessionId: 'session-1',
      currentGraphType: 'chat' as const,
      agentMode: 'agent' as const,
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      pendingAskUserBySessionId: {
        'session-1': {
          // W4 R3 (2026-05-11): ask 三件套并存——fixture 用 choice kind 代表
          // ask_user 工具的默认形态。form / approval kind 在 union 守卫下隔离。
          kind: 'choice' as const,
          sessionId: 'session-1',
          threadId: 'chat-session-1',
          interruptId: 'ask-1',
          interactionType: 'ask_user',
          blockingPolicy: 'soft',
          toolCallId: 'tool-1',
          messageId: 'message-1',
          message: '请补充参数',
          questions: [],
        },
      },
      askUserSubmittingBySessionId: { 'session-1': false },
      streamingBySessionId: {},
      messagesBySessionId: { 'session-1': [] as ChatMessage[] },
      sessions: [{
        id: 'session-1',
        title: 'Session One',
        status: 'active',
        organization_id: 'organization-1',
        created_at: '2026-03-13T00:00:00.000Z',
        updated_at: '2026-03-13T00:00:00.000Z',
      } as ChatSession],
      checkpointsBySessionId: {},
      restoringSessionId: null,
      createCheckpoint: vi.fn().mockResolvedValue(undefined),
    }

    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    const set = vi.fn((partial: Partial<SendMessageStore>) => {
      Object.assign(store, partial)
    })

    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, set))

    await sendMessage('继续往下做', true)

    expect(localStream).toHaveBeenCalled()
    // soft-blocking ask-user 被自动跳过时会通过 IPC 通知本地 Runtime 恢复
    expect(submitAskUserResponseIpc).toHaveBeenCalledWith('ask-1', { skipped: true }, 'chat-session-1')
    expect(store.pendingAskUserBySessionId['session-1']).toBeUndefined()
    expect(store.askUserSubmittingBySessionId['session-1']).toBeUndefined()
    expect(store.messagesBySessionId['session-1'][0]).toMatchObject({
      role: 'system',
      content: 'Agent 的问题已自动跳过，将根据你的新消息继续执行',
    })
    expect(store.messagesBySessionId['session-1'][1]).toMatchObject({
      role: 'user',
      content: '继续往下做',
    })
  })

  it('强中断 askUser 期间仍允许直送（ host 队列承接）', async () => {
    const store = extendSendStore({
      pendingAskUserBySessionId: {
        'session-1': {
          sessionId: 'session-1',
          threadId: 'chat-session-1',
          interruptId: 'ask-1',
          interactionType: 'ask_user',
          blockingPolicy: 'hard',
          toolCallId: 'tool-1',
          messageId: 'message-1',
        },
      },
      askUserSubmittingBySessionId: { 'session-1': false },
    })

    const sendMessage = createSendMessageAction(baseDeps(store, vi.fn(), vi.fn()))

    await sendMessage('现在先继续', true)

    expect(localStream).toHaveBeenCalled()
    expect(submitAskUserResponseIpc).not.toHaveBeenCalled()
  })

  // W4.4 修复（dogfood session b2472cb2 turn 3 P0）：审批 review_required 等待期
  // 不再调 removeStreamingSession，否则 MessageBubble.useStoreSelector 会让
  // W4c 退役 MessageSteps 后：BlockTimeline.useContentBlocks 切到非流式视图，
  // 历史回放从 content_blocks_json 走 legacyBlocksAdapter——但 content_blocks_json
  // 仅在 lifecycle.end → onDone 才被写入 →
  // 审批等待期 / resume 后 MessageSteps 一直显示空 → 用户必须 reload electron
  // 才能看到 thinking + tool calls。
  describe('W4.4 — 审批等待期保持 streamingBySessionId=true', () => {
    const buildBaseStore = (): SendMessageStore => ({
      currentSessionId: 'session-1',
      currentGraphType: 'chat' as const,
      agentMode: 'agent' as const,
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      pendingAskUserBySessionId: {},
      askUserSubmittingBySessionId: {},
      streamingBySessionId: {},
      messagesBySessionId: { 'session-1': [] as ChatMessage[] },
      sessions: [{
        id: 'session-1',
        title: 'Session One',
        status: 'active',
        organization_id: 'organization-1',
        created_at: '2026-03-13T00:00:00.000Z',
        updated_at: '2026-03-13T00:00:00.000Z',
      } as ChatSession],
      checkpointsBySessionId: {},
      restoringSessionId: null,
      createCheckpoint: vi.fn().mockResolvedValue(undefined),
    })

    /**
     * 测试方法：让 localStream mock 在被调用时合成 4 种事件之一，调用 callbacks.onMessage
     * 触发 sendMessageAction 内部的 handler，然后 verify deps.removeStreamingSession 没被调。
     *
     * - approval_requested: v0.4 W1.5 batch 形态（ApprovalPanel 走这条）
     * - ask_user_required: W4 R3 ask 三件套之 choice（替代 ask_choice）
     * - ask_form_required: W4 R3 ask 三件套之 form（多字段填表）
     * - request_approval_required: W4 R3 ask 三件套之 approval（高风险审批）
     */
    type AskTestEventType =
      | 'agent.stream.approval_requested'
      | 'agent.stream.ask_user_required'
      | 'agent.stream.ask_form_required'
      | 'agent.stream.request_approval_required'

    const buildStreamMockEmittingApprovalRequested = (eventType: AskTestEventType) =>
      vi.fn().mockImplementation(async (
        _sessionId: string,
        _msg: string,
        callbacks: {
          onMessage: (event: { type: string; payload?: Record<string, unknown> }) => void
          onDone: (metadata?: Record<string, unknown>) => void
        },
      ) => {
        if (eventType === 'agent.stream.approval_requested') {
          callbacks.onMessage({
            type: eventType,
            payload: {
              batch_id: 'batch-1',
              approval_type: 'tool_permission',
              runtime_mode: 'interactive',
              expires_at: Date.now() + 30 * 60 * 1000,
              schema_version: 1,
              action_requests: [
                {
                  request_id: 'req-1',
                  tool_call_id: 'run_terminal_command:1',
                  tool_name: 'run_terminal_command',
                  tool_input: { command: 'tabtin device info' },
                  decision_reason: { type: 'fallback_preset', preset: 'legacy_handler' },
                  ask_hint: { summary: '命令：tabtin device info', suggested_scope: 'once' },
                  allowed_scopes: ['once', 'thread', 'always'],
                  allowed_outcomes: ['allow', 'deny'],
                  risk_level: 'medium',
                },
              ],
            },
          })
        } else if (eventType === 'agent.stream.ask_user_required') {
          callbacks.onMessage({
            type: eventType,
            payload: {
              request_id: 'req-1',
              interrupt_id: 'req-1',
              tool_name: 'ask_user',
              interaction_type: 'ask_user',
              blocking_policy: 'soft',
              title: '选择处理方式',
              questions: [{
                id: 'q1',
                prompt: '怎么处理？',
                options: [
                  { id: 'a', label: 'A', description: '选 A。' },
                  { id: 'b', label: 'B', description: '选 B。' },
                ],
              }],
            },
          })
        } else if (eventType === 'agent.stream.ask_form_required') {
          callbacks.onMessage({
            type: eventType,
            payload: {
              request_id: 'req-2',
              interrupt_id: 'req-2',
              tool_name: 'ask_form',
              interaction_type: 'ask_user',
              blocking_policy: 'soft',
              form_mode: 'fields',
              title: '请填写参数',
              fields: [{ key: 'name', label: '名称', type: 'text', required: true }],
            },
          })
        } else {
          // request_approval_required
          callbacks.onMessage({
            type: eventType,
            payload: {
              request_id: 'req-3',
              interrupt_id: 'req-3',
              tool_name: 'request_approval',
              interaction_type: 'ask_user',
              blocking_policy: 'hard',
              title: '高风险动作确认',
              rationale: '将删除 5 个文件，请确认',
              risk_level: 'high',
            },
          })
        }
        callbacks.onDone({})
      })

    it('本地 approval_requested 收到时不调 removeStreamingSession（streamingBySessionId 保持 true）', async () => {
      const store = buildBaseStore()
      const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
        store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
      })
      const set = vi.fn((partial: Partial<SendMessageStore>) => {
        Object.assign(store, partial)
      })

      const deps = baseDeps(store, updateSessionMessages, set)
      registerHitlAccessForTest(store, updateSessionMessages, set)
      localStream.mockReset()
      localStream.mockImplementationOnce(buildStreamMockEmittingApprovalRequested('agent.stream.approval_requested'))

      const sendMessage = createSendMessageAction(deps)
      await sendMessage('查询设备型号', true)

      // 关键断言：审批 handler 触发后 deps.removeStreamingSession 没被调
      // —— addStreamingSession 在初始 streaming setup 时调，removeStreamingSession
      // 仅在 onDone 末尾被调一次（属于 turn 真正结束的清理路径）。
      // 真正调用次数：onDone 路径一次。dogfood P0 修前 approval handler
      // 也会调一次，本测试保证 approval handler 不再调。
      const removeCalls = (deps.removeStreamingSession as ReturnType<typeof vi.fn>).mock.calls
      // HITL handler 等待期不调 removeStreamingSession(false)；turn 结束时 lifecycle
      // cleanup 会调一次（+ query 终态可能再调 terminal 清理）。
      const reviewClearCalls = removeCalls.filter(call => {
        const opts = call[1] as { clearSeqGapSync?: boolean } | undefined
        return opts?.clearSeqGapSync === false
      })
      expect(reviewClearCalls.length).toBeGreaterThanOrEqual(1)
      // pendingApprovalBySessionId 仍然被设置（审批 UI 需要）+ batchId 透传
      expect(store.pendingApprovalBySessionId['session-1']).toBeDefined()
      expect(store.pendingApprovalBySessionId['session-1']?.batchId).toBe('batch-1')
    })

    it('本地 ask_user_required 收到时不调 removeStreamingSession + pendingAskUser kind=choice', async () => {
      const store = buildBaseStore()
      const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
        store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
      })
      const set = vi.fn((partial: Partial<SendMessageStore>) => {
        Object.assign(store, partial)
      })

      const deps = baseDeps(store, updateSessionMessages, set)
      registerHitlAccessForTest(store, updateSessionMessages, set)
      localStream.mockReset()
      localStream.mockImplementationOnce(buildStreamMockEmittingApprovalRequested('agent.stream.ask_user_required'))

      const sendMessage = createSendMessageAction(deps)
      await sendMessage('帮我决策', true)

      const removeCalls = (deps.removeStreamingSession as ReturnType<typeof vi.fn>).mock.calls
      const askUserClearCalls = removeCalls.filter(call => {
        const opts = call[1] as { clearSeqGapSync?: boolean } | undefined
        return opts?.clearSeqGapSync === false
      })
      expect(askUserClearCalls.length).toBeGreaterThanOrEqual(1)
      const pending = store.pendingAskUserBySessionId['session-1']
      expect(pending).toBeDefined()
      expect(pending?.kind).toBe('choice')
    })

    // W4 R3 (2026-05-11): ask 三件套并存——ask_form_required 路由覆盖
    it('本地 ask_form_required 收到时构造 kind=form 的 pendingAskUser', async () => {
      const store = buildBaseStore()
      const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
        store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
      })
      const set = vi.fn((partial: Partial<SendMessageStore>) => {
        Object.assign(store, partial)
      })

      const deps = baseDeps(store, updateSessionMessages, set)
      registerHitlAccessForTest(store, updateSessionMessages, set)
      localStream.mockReset()
      localStream.mockImplementationOnce(buildStreamMockEmittingApprovalRequested('agent.stream.ask_form_required'))

      const sendMessage = createSendMessageAction(deps)
      await sendMessage('帮我填表', true)

      const pending = store.pendingAskUserBySessionId['session-1']
      expect(pending).toBeDefined()
      expect(pending?.kind).toBe('form')
      if (pending?.kind === 'form') {
        expect(pending.fields).toHaveLength(1)
        expect(pending.formMode).toBe('fields')
      }
    })

    // W4 R3 (2026-05-11): ask 三件套并存——request_approval_required 路由覆盖
    it('本地 request_approval_required 收到时构造 kind=approval 的 pendingAskUser', async () => {
      const store = buildBaseStore()
      const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
        store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
      })
      const set = vi.fn((partial: Partial<SendMessageStore>) => {
        Object.assign(store, partial)
      })

      const deps = baseDeps(store, updateSessionMessages, set)
      registerHitlAccessForTest(store, updateSessionMessages, set)
      localStream.mockReset()
      localStream.mockImplementationOnce(buildStreamMockEmittingApprovalRequested('agent.stream.request_approval_required'))

      const sendMessage = createSendMessageAction(deps)
      await sendMessage('请审批', true)

      const pending = store.pendingAskUserBySessionId['session-1']
      expect(pending).toBeDefined()
      expect(pending?.kind).toBe('approval')
      if (pending?.kind === 'approval') {
        expect(pending.rationale).toBe('将删除 5 个文件，请确认')
        expect(pending.riskLevel).toBe('high')
      }
    })

    /**
     * 端到端值流测试（F8 教训）：模拟 dogfood session b2472cb2 turn 3 完整时序
     * （3 次 approval_requested batch + 3 次模拟用户秒点同意 + 中间 thinking + 最后 final）。
     *
     * 验证关键事实：
     * - approval handler **不**调 removeStreamingSession（3 次审批后
     *   removeStreamingSession 调用次数 = 1，仅 onDone 触发）
     * - 中间 thinking / tool events 走 hub → 真实 streamMessageHandler 处理
     */
    it('dogfood 多次审批端到端值流：审批 handler 不清 streamingBySessionId，最终仅 onDone 清', async () => {
      const store = buildBaseStore()
      const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
        store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
      })
      const set = vi.fn((partial: Partial<SendMessageStore>) => {
        Object.assign(store, partial)
      })

      const deps = baseDeps(store, updateSessionMessages, set)
      registerHitlAccessForTest(store, updateSessionMessages, set)
      localStream.mockReset()

      // 模拟 turn 3 序列：lifecycle.start → think → mcp_call_tool (approval_requested → 同意 → error) →
      // run_terminal_command:4 (approval_requested → 同意 → end) → run_terminal_command:5 (approval_requested → 同意 → end) → final + done
      //
      // 注：下方 fixture 中的 `agent.stream.tool` 字面量在 W4.5 第三波 C1（2026-05-13）
      // 后已不属于活协议（wire `StreamEvents.TOOL` 物理删，daemon 0 emit）——保留这些
      // envelope 仅作"流的 padding"，本测试断言核心是 approval_requested 路径不重置
      // streaming session（W4.6 dogfood P0 守门）。dispatcher 收到这些老协议事件会落
      // default silent drop（不影响断言），未来若有人重写本测试可改用 6 件套字面量。
      const buildBatchPayload = (batchId: string, requestId: string, toolName: string, toolCallId: string, toolInput: unknown) => ({
        batch_id: batchId,
        approval_type: 'tool_permission',
        runtime_mode: 'interactive',
        expires_at: Date.now() + 30 * 60 * 1000,
        schema_version: 1,
        action_requests: [
          {
            request_id: requestId,
            tool_call_id: toolCallId,
            tool_name: toolName,
            tool_input: toolInput,
            decision_reason: { type: 'fallback_preset', preset: 'legacy_handler' },
            ask_hint: { summary: toolName, suggested_scope: 'once' },
            allowed_scopes: ['once', 'thread', 'always'],
            allowed_outcomes: ['allow', 'deny'],
            risk_level: 'medium',
          },
        ],
      })

      localStream.mockImplementationOnce(async (
        _sessionId: string,
        _msg: string,
        callbacks: {
          onMessage: (event: { type: string; payload?: Record<string, unknown> }) => void
          onDone: (metadata?: Record<string, unknown>) => void
        },
      ) => {
        callbacks.onMessage({ type: 'agent.stream.lifecycle', payload: { phase: 'start', run_id: 'run-1' } })
        callbacks.onMessage({ type: 'agent.stream.tool', payload: { phase: 'start', tool_name: 'think', tool_call_id: 'think:2' } })
        callbacks.onMessage({ type: 'agent.stream.tool', payload: { phase: 'end', tool_name: 'think', tool_call_id: 'think:2' } })
        // 第 1 次审批：mcp_call_tool
        callbacks.onMessage({
          type: 'agent.stream.approval_requested',
          payload: buildBatchPayload('batch-1', 'req-1', 'mcp_call_tool', 'mcp_call_tool:3', {}),
        })
        callbacks.onMessage({ type: 'agent.stream.tool', payload: { phase: 'error', tool_name: 'mcp_call_tool', tool_call_id: 'mcp_call_tool:3' } })
        // 第 2 次审批：run_terminal_command:4
        callbacks.onMessage({
          type: 'agent.stream.approval_requested',
          payload: buildBatchPayload('batch-2', 'req-2', 'run_terminal_command', 'run_terminal_command:4', { command: 'tabtin device info' }),
        })
        callbacks.onMessage({ type: 'agent.stream.tool', payload: { phase: 'end', tool_name: 'run_terminal_command', tool_call_id: 'run_terminal_command:4' } })
        // 第 3 次审批：run_terminal_command:5
        callbacks.onMessage({
          type: 'agent.stream.approval_requested',
          payload: buildBatchPayload('batch-3', 'req-3', 'run_terminal_command', 'run_terminal_command:5', { command: 'tabtin device info --space-id ...' }),
        })
        callbacks.onMessage({ type: 'agent.stream.tool', payload: { phase: 'end', tool_name: 'run_terminal_command', tool_call_id: 'run_terminal_command:5' } })
        callbacks.onMessage({ type: 'agent.stream.assistant', payload: { phase: 'final', content: '抱歉，当前无法获取设备型号。' } })
        callbacks.onMessage({ type: 'agent.stream.lifecycle', payload: { phase: 'end', run_id: 'run-1' } })
        // onDone payload 字段仍叫 blocks_json（daemon→Django 透传契约名，
        // must-not-touch 范围；renderer 端会把它写到 ChatMessage.content_blocks_json）
        callbacks.onDone({ blocks_json: [{ type: 'thinking', content: 'thought 1' }, { type: 'tool_call', tool_name: 'mcp_call_tool' }] })
      })

      const sendMessage = createSendMessageAction(deps)
      await sendMessage('查询设备型号', true)

      // dogfood P0 修复关键断言：3 次 approval_requested 都不调 removeStreamingSession({clearSeqGapSync:false})
      const removeCalls = (deps.removeStreamingSession as ReturnType<typeof vi.fn>).mock.calls
      // HITL handler 等待期不调 removeStreamingSession(false)；turn 结束时 lifecycle
      // cleanup 会调一次（+ query 终态可能再调 terminal 清理）。
      const reviewClearCalls = removeCalls.filter(call => {
        const opts = call[1] as { clearSeqGapSync?: boolean } | undefined
        return opts?.clearSeqGapSync === false
      })
      expect(reviewClearCalls.length).toBeGreaterThanOrEqual(1)

      // 3 次 approval_requested 都成功设置了 pendingApprovalBySessionId（虽然每次都被替换）
      // 注意：由于 turn 内多次审批，handler 每次都覆盖 pendingApprovalBySessionId[sid]，
      // 最后一次审批后 pendingApprovalBySessionId 被设为 batch-3 对应的 state；onDone 时
      // 不主动 clear（清理由用户在 approvalSlice 提交决策触发，或下一轮 sendMessage 入口拦截）
      // —— set() 至少被调用了 6 次：3 次 approval_requested + onDone 流程的若干 set
      expect((set as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0)
      expect(store.pendingApprovalBySessionId['session-1']?.batchId).toBe('batch-3')

      // onDone 末尾会调 removeStreamingSession（无 clearSeqGapSync 选项） — 这是
      // 真正的 turn 终结清理路径，应保留
      const terminalRemoveCalls = removeCalls.filter(call => {
        const opts = call[1] as { clearSeqGapSync?: boolean } | undefined
        return opts === undefined || opts.clearSeqGapSync !== false
      })
      expect(terminalRemoveCalls.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ─────────────────────────────────────────────────────────────────
  // 「侧边栏 + footer 修复 v2」乐观更新契约（2026-05-17）
  // 用户点 send 那一秒侧边栏立即脱离"草稿"语义——last_message_at /
  // message_count / last_message_preview 三件事必须一起 bump，否则
  // resolveSessionDisplayStatus 看 message_count===0 永久判草稿。
  // ─────────────────────────────────────────────────────────────────
  describe('乐观更新会话列表缓存', () => {
    function buildBasicStore(messageCount = 0): SendMessageStore {
      const store: SendMessageStore = {
        currentSessionId: 'session-1',
        currentGraphType: 'chat' as const,
        agentMode: 'agent' as const,
        pendingApprovalBySessionId: {},
        approvalSubmittingBySessionId: {},
        pendingAskUserBySessionId: {},
        askUserSubmittingBySessionId: {},
        streamingBySessionId: {},
        messagesBySessionId: { 'session-1': [] as ChatMessage[] },
        sessions: [{
          id: 'session-1',
          title: 'Session One',
          status: 'active',
          organization_id: 'organization-1',
          workspace_id: 'space-1',
          created_at: '2026-03-13T00:00:00.000Z',
          updated_at: '2026-03-13T00:00:00.000Z',
          message_count: messageCount,
        } as ChatSession],
        checkpointsBySessionId: {},
        restoringSessionId: null,
        createCheckpoint: vi.fn().mockResolvedValue(undefined),
      }
      attachHostPendingToStore(store)
      return store
    }

    it('发用户消息时 patch last_message_at + message_count + last_message_preview', async () => {
      const store = buildBasicStore(0)
      const updateSessionMessages = vi.fn((sid: string, updater: (m: ChatMessage[]) => ChatMessage[]) => {
        store.messagesBySessionId[sid] = updater(store.messagesBySessionId[sid] ?? [])
      })
      const updateSessionInCaches = vi.fn()
      const deps = {
        ...baseDeps(store, updateSessionMessages, vi.fn()),
        updateSessionInCaches,
      }
      const sendMessage = createSendMessageAction(deps)

      await sendMessage('hello world', true)

      // 关键断言：updateSessionInCaches 被调，patch 含三件事
      expect(updateSessionInCaches).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          last_message_at: expect.any(String),
          message_count: 1,
          last_message_preview: 'hello world',
        }),
      )
    })

    it('处于回退态时发消息：乐观清除 revert_active 以隐藏回退横幅', async () => {
      const store = buildBasicStore(0)
      ;(store.sessions[0] as ChatSession).rollback_state = {
        session_id: 'session-1',
        revert_active: true,
        can_unrevert: true,
      } as ChatSession['rollback_state']
      const updateSessionMessages = vi.fn((sid: string, updater: (m: ChatMessage[]) => ChatMessage[]) => {
        store.messagesBySessionId[sid] = updater(store.messagesBySessionId[sid] ?? [])
      })
      const updateSessionInCaches = vi.fn()
      const deps = {
        ...baseDeps(store, updateSessionMessages, vi.fn()),
        updateSessionInCaches,
      }
      const sendMessage = createSendMessageAction(deps)

      await sendMessage('继续对话', true)

      const patchCall = updateSessionInCaches.mock.calls.find(
        call => (call[1] as Partial<ChatSession>)?.rollback_state != null,
      )
      expect(patchCall).toBeDefined()
      const patched = (patchCall![1] as Partial<ChatSession>).rollback_state!
      expect(patched.revert_active).toBe(false)
      expect(patched.can_unrevert).toBe(false)
    })

    it('不在回退态时发消息：不写多余的 rollback_state patch', async () => {
      const store = buildBasicStore(0)
      const updateSessionMessages = vi.fn((sid: string, updater: (m: ChatMessage[]) => ChatMessage[]) => {
        store.messagesBySessionId[sid] = updater(store.messagesBySessionId[sid] ?? [])
      })
      const updateSessionInCaches = vi.fn()
      const deps = {
        ...baseDeps(store, updateSessionMessages, vi.fn()),
        updateSessionInCaches,
      }
      const sendMessage = createSendMessageAction(deps)

      await sendMessage('普通消息', true)

      const patchCall = updateSessionInCaches.mock.calls.find(
        call => (call[1] as Partial<ChatSession>)?.rollback_state != null,
      )
      expect(patchCall).toBeUndefined()
    })

    it('已有 message_count 时累加 +1（不是设置成 1）', async () => {
      const store = buildBasicStore(5)
      const updateSessionMessages = vi.fn((sid: string, updater: (m: ChatMessage[]) => ChatMessage[]) => {
        store.messagesBySessionId[sid] = updater(store.messagesBySessionId[sid] ?? [])
      })
      const updateSessionInCaches = vi.fn()
      const deps = {
        ...baseDeps(store, updateSessionMessages, vi.fn()),
        updateSessionInCaches,
      }
      const sendMessage = createSendMessageAction(deps)

      await sendMessage('next message', true)

      const optimisticPatchCall = updateSessionInCaches.mock.calls.find(call =>
        typeof (call[1] as { message_count?: number })?.message_count === 'number',
      )
      expect(optimisticPatchCall).toBeDefined()
      expect((optimisticPatchCall![1] as { message_count: number }).message_count).toBe(6)
    })

    it('preview 文本超过 200 字时截断', async () => {
      const store = buildBasicStore(0)
      const updateSessionMessages = vi.fn((sid: string, updater: (m: ChatMessage[]) => ChatMessage[]) => {
        store.messagesBySessionId[sid] = updater(store.messagesBySessionId[sid] ?? [])
      })
      const updateSessionInCaches = vi.fn()
      const deps = {
        ...baseDeps(store, updateSessionMessages, vi.fn()),
        updateSessionInCaches,
      }
      const sendMessage = createSendMessageAction(deps)

      const longText = 'a'.repeat(500)
      await sendMessage(longText, true)

      const optimisticCall = updateSessionInCaches.mock.calls.find(call =>
        (call[1] as { last_message_preview?: string })?.last_message_preview !== undefined,
      )
      expect(optimisticCall).toBeDefined()
      const preview = (optimisticCall![1] as { last_message_preview: string }).last_message_preview
      expect(preview.length).toBe(200)
    })

    it('乐观 patch 不带 token 字段（防破坏 updateSessionTokenUsageInCaches 单调路径）', async () => {
      const store = buildBasicStore(0)
      const updateSessionMessages = vi.fn((sid: string, updater: (m: ChatMessage[]) => ChatMessage[]) => {
        store.messagesBySessionId[sid] = updater(store.messagesBySessionId[sid] ?? [])
      })
      const updateSessionInCaches = vi.fn()
      const deps = {
        ...baseDeps(store, updateSessionMessages, vi.fn()),
        updateSessionInCaches,
      }
      const sendMessage = createSendMessageAction(deps)

      await sendMessage('test', true)

      // 关键 invariant：乐观 patch 是手工构造的，不应含任何 token 字段
      // —— 否则未来不小心加了 token 字段会破坏 useChatStore 的 Math.max 单调保护
      for (const [, patch] of updateSessionInCaches.mock.calls) {
        const p = patch as Record<string, unknown>
        expect(p.input_tokens).toBeUndefined()
        expect(p.output_tokens).toBeUndefined()
        expect(p.total_tokens).toBeUndefined()
        expect(p.context_tokens).toBeUndefined()
      }
    })
  })

  it('#9234 发送热路径不调用 prepareRuntimeDispatchContext，规则由 Host 自取', async () => {
    const store: SendMessageStore = {
      currentSessionId: 'session-1',
      agentMode: 'agent' as const,
      pendingApprovalBySessionId: {},
      approvalSubmittingBySessionId: {},
      pendingAskUserBySessionId: {},
      askUserSubmittingBySessionId: {},
      streamingBySessionId: {},
      messagesBySessionId: { 'session-1': [] as ChatMessage[] },
      sessions: [{
        id: 'session-1',
        title: 'Session One',
        status: 'active',
        organization_id: 'organization-1',
        workspace_id: 'space-1',
        created_at: '2026-03-13T00:00:00.000Z',
        updated_at: '2026-03-13T00:00:00.000Z',
      } as ChatSession],
      checkpointsBySessionId: {},
      restoringSessionId: null,
      createCheckpoint: vi.fn().mockResolvedValue(undefined),
    }
    attachHostPendingToStore(store)
    const sendMessage = createSendMessageAction(baseDeps(store, vi.fn(), vi.fn()))

    await sendMessage('hello', true)

    expect(mockPrepareRuntimeDispatchContext).not.toHaveBeenCalled()
    expect(mockEnsureGroupRuntimeSynced).not.toHaveBeenCalled()
    expect(localStream).toHaveBeenCalled()
    const streamOptions = localStream.mock.calls[0]?.[3] as {
      personalRules?: string
      workspaceSnapshot?: unknown
      customRules?: string
      history?: unknown
    }
    expect(streamOptions.personalRules).toBeUndefined()
    expect(streamOptions.workspaceSnapshot).toBeUndefined()
    expect(streamOptions.customRules).toBeUndefined()
    expect(streamOptions.history).toBeUndefined()
  })

  it('#9345 idle：发送区持稿，ACK started 后上屏；不 await group_runtime', async () => {
    const callOrder: string[] = []
    mockEnsureGroupRuntimeSynced.mockImplementationOnce(async () => {
      callOrder.push('group_runtime')
    })

    const store = buildMinimalSendStore()
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      const prev = store.messagesBySessionId[sessionId] ?? []
      const next = updater(prev)
      if (next.length > prev.length) {
        callOrder.push('user_visible')
      }
      store.messagesBySessionId[sessionId] = next
    })
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    await sendMessage('hello', true)

    expect(callOrder).toContain('user_visible')
    expect(callOrder).not.toContain('group_runtime')
    expect(mockEnsureGroupRuntimeSynced).not.toHaveBeenCalled()
    expect(store.sendInFlightBySessionId['session-1']).toBeUndefined()
    expect(store.hostPendingSendsBySessionId['session-1'] ?? []).toHaveLength(0)
    expect(store.composerClearNonceBySessionId['session-1']).toBeGreaterThan(0)
  })

  it('#9345 busy：ACK queued 进 HostPending，主时间线始终无气泡', async () => {
    const callOrder: string[] = []
    mockEnsureGroupRuntimeSynced.mockImplementationOnce(async () => {
      callOrder.push('group_runtime')
    })
    runtimeState.runProjectionBySessionId = {
      'session-1': { busy: true },
    }

    const store = buildMinimalSendStore()
    const originalEnqueue = store.enqueueHostPendingSend.bind(store)
    store.enqueueHostPendingSend = (item) => {
      callOrder.push('pending_enqueue')
      originalEnqueue(item)
    }
    const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
    })
    const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))

    await sendMessage('queued while busy', true)

    expect(callOrder).toContain('pending_enqueue')
    expect(callOrder).not.toContain('group_runtime')
    expect(mockEnsureGroupRuntimeSynced).not.toHaveBeenCalled()
    expect(store.sendInFlightBySessionId['session-1']).toBeUndefined()
    expect(store.messagesBySessionId['session-1'] ?? []).toHaveLength(0)
    expect(store.composerClearNonceBySessionId['session-1']).toBeGreaterThan(0)
    expect(store.hostPendingSendsBySessionId['session-1']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          titleText: 'queued while busy',
          queuePosition: expect.any(Number),
        }),
      ]),
    )
    expect(store.hostPendingSendsBySessionId['session-1']![0]!.queuePosition).toBeGreaterThanOrEqual(1)
  })

  describe('#7064 draft episode preflight 集成', () => {
    beforeEach(async () => {
      const { __resetDraftMessageSessionCoordinatorForTests } = await import(
        '../../../session/draftMessageSessionCoordinator'
      )
      __resetDraftMessageSessionCoordinatorForTests()
      runtimeState.setPrefillForSession.mockReset()
    })

    it('I. 普通 active session 无 episode → preflight no-op，继续发送', async () => {
      const store = buildMinimalSendStore()
      const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
        store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
      })
      const sendMessage = createSendMessageAction(baseDeps(store, updateSessionMessages, vi.fn()))
      await sendMessage('active no-op', true)
      expect(localStream).toHaveBeenCalled()
      expect(runtimeState.setPrefillForSession).not.toHaveBeenCalled()
    })

    it('I. expectedDraftMessageId mismatch → blocked，气泡 failed，恢复 prefill，零 stream', async () => {
      const {
        beginDraftMessage,
        recordDraftAgentIntent,
      } = await import('../../../session/draftMessage')
      beginDraftMessage('conversation:draft:workspace-1')
      bindDraftSessionToMessage('conversation:draft:workspace-1', 'session-1', {
        phase: 'sending',
      })
      recordDraftAgentIntent('conversation:draft:workspace-1', 'agent-2')

      const store = buildMinimalSendStore()
      store.sessions = [{
        ...store.sessions[0],
        agent_id: 'agent-1',
      } as ChatSession]
      store.messagesBySessionId['session-1'] = [{
        id: 'msg-pending',
        role: 'user',
        content: 'retry me',
        created_at: '2026-03-13T00:00:00.000Z',
        sendStatus: 'sending',
      } as ChatMessage]
      const updateSessionMessages = vi.fn((sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
        store.messagesBySessionId[sessionId] = updater(store.messagesBySessionId[sessionId] ?? [])
      })
      const client = buildChatClientMock()
      ;(client.sessions as { update?: ReturnType<typeof vi.fn> }).update = vi.fn()
      const sendMessage = createSendMessageAction({
        ...baseDeps(store, updateSessionMessages, vi.fn()),
        getChatClient: () => client,
      })

      await sendMessage('retry me', true, undefined, undefined, 'session-1', {
        existingClientMessageId: 'msg-pending',
        expectedDraftMessageId: 'ep-does-not-exist',
      })

      expect(localStream).not.toHaveBeenCalled()
      expect((client.sessions as { update?: ReturnType<typeof vi.fn> }).update).not.toHaveBeenCalled()
      expect(store.messagesBySessionId['session-1'][0]).toMatchObject({
        id: 'msg-pending',
        sendStatus: 'failed',
      })
      expect(runtimeState.setPrefillForSession).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({ message: 'retry me' }),
      )
    })
  })
})
