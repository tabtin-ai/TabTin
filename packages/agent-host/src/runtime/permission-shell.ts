/**
 * Permission shell — shared createRuntime W6a slice.
 *
 * Assembles ApprovalMemoStore (commit/refetch/bootstrap) + permission handler
 * injection + UserInteractiveChannel bridge. Electron / Daemon previously
 * duplicated this block inside createRuntimeForSession.
 *
 * Platform differences stay in ports:
 *  - apiBaseUrl / getAuthToken
 *  - createPermissionHandler (ElectronPermissionHandler vs LocalPermissionHandler)
 *  - onAlwaysCommitSuccess (Electron broadcasts to renderer; Daemon no-ops)
 *  - registerApprovalMemo (AgentHost route table)
 */

import type {
  EnginePermissionHandler,
  StreamEvent,
} from '@tabtin/agent-runtime/engine'
import {
  createApprovalMemoStore,
  createApprovalMemoCommitClient,
  createApprovalMemoRefetchClient,
  bridgeUserInteractiveToLocalPermissionHandler,
  type InMemoryApprovalMemoStore,
  type LocalPermissionHandlerOptions,
  type UserInteractiveChannel,
} from '@tabtin/agent-runtime'
import { buildMemoPatternKey } from '../policy/build-memo-pattern-key.js'

export interface PermissionShellLogger {
  warn(message: string): void
  debug(message: string): void
}

export interface AssemblePermissionShellInput {
  sessionId: string
  workspaceId: string
  apiBaseUrl: string
  getAuthToken: () => Promise<string | null> | string | null
  emitStreamEvent: (event: StreamEvent) => void
  waitForUserInput: (requestId: string) => Promise<unknown>
  runtimeMode: NonNullable<LocalPermissionHandlerOptions['runtimeMode']>
  /** Thread id exposed to UserInteractiveChannel.getThreadId. */
  interactiveThreadId: string
  log: PermissionShellLogger
  registerApprovalMemo?: (input: {
    sessionId: string
    workspaceId: string
    store: InMemoryApprovalMemoStore
  }) => void
  /** Electron: broadcastApprovalMemoChangedToRenderer; Daemon: omit. */
  onAlwaysCommitSuccess?: (workspaceId: string) => void
  /**
   * Construct the concrete EnginePermissionHandler. Platforms supply
   * ElectronPermissionHandler or LocalPermissionHandler (+ onLog).
   */
  createPermissionHandler: (
    options: LocalPermissionHandlerOptions,
  ) => EnginePermissionHandler
}

export interface PermissionShellResult {
  permissionMemoStore: InMemoryApprovalMemoStore
  permissionHandler: EnginePermissionHandler
  userInteractiveChannel: UserInteractiveChannel
}

async function resolveAuthToken(
  getAuthToken: AssemblePermissionShellInput['getAuthToken'],
): Promise<string | null> {
  const token = await getAuthToken()
  return token || null
}

/**
 * Assemble ApprovalMemo + permission handler + UserInteractiveChannel.
 */
export function assemblePermissionShell(
  input: AssemblePermissionShellInput,
): PermissionShellResult {
  if (!input.workspaceId) {
    throw new Error('assemblePermissionShell: workspaceId is required')
  }

  const getAuthToken = () => resolveAuthToken(input.getAuthToken)

  let memoStoreRef: InMemoryApprovalMemoStore | null = null
  const memoCommitClient = createApprovalMemoCommitClient({
    apiBaseUrl: input.apiBaseUrl,
    workspaceId: input.workspaceId,
    getAuthToken,
    // late-bind：store 用 commitClient 构造，commitClient 又要读 store.generation
    getCurrentGeneration: () => memoStoreRef?.generation ?? 0,
    onCommitGenerationAdvance: (gen: number) => {
      memoStoreRef?.advanceGeneration(gen)
      input.onAlwaysCommitSuccess?.(input.workspaceId)
    },
    onConflict: async (gen: number) => {
      await memoStoreRef?.maybeRefetch(gen)
    },
    log: input.log,
  })
  const memoRefetchClient = createApprovalMemoRefetchClient({
    apiBaseUrl: input.apiBaseUrl,
    workspaceId: input.workspaceId,
    getAuthToken,
    log: input.log,
  })
  const permissionMemoStore = createApprovalMemoStore({
    commitAlways: memoCommitClient,
    refetchAll: memoRefetchClient,
    onCommitError: (err: unknown, key: string) => {
      const msg = err instanceof Error ? err.message : String(err)
      input.log.warn(`[ApprovalMemo] commit/bootstrap failed for key=${key}: ${msg}`)
    },
    // W3-轮 1 (PRD §7.6.2 接口 B)：cancelPendingApprovals 调用入口预留。
    // 本期实装"接口 + 单测"，不做 HTTP 真接通（07 PRD 启动后接 Django REST）。
    cancelPendingApprovals: async (threadId, reason, rollbackEventId) => {
      input.log.warn(
        `[ApprovalMemo] cancelPendingApprovals not wired (07 PRD pending): ` +
          `thread=${threadId} reason=${reason} rollback=${rollbackEventId ?? '-'}`,
      )
      throw new Error(
        '[ApprovalMemo] cancelPendingApprovals: HTTP cancel client not wired ' +
          '(implement when 07 PRD Checkpoint-and-Rollback launches; W3-轮 1 仅落接口 + 单测)',
      )
    },
  })
  memoStoreRef = permissionMemoStore

  void permissionMemoStore.bootstrap().catch(() => {
    // onCommitError already logged; swallow to keep createRuntime non-blocking.
  })

  input.registerApprovalMemo?.({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    store: permissionMemoStore,
  })

  const permissionHandler = input.createPermissionHandler({
    emitStreamEvent: input.emitStreamEvent,
    waitForUserInput: input.waitForUserInput,
    runtimeMode: input.runtimeMode,
    memoStore: permissionMemoStore,
    buildMemoPatternKey,
  })

  // ：agentRunId 不在此注入——它是 per-turn 字段，由 orchestration /
  // interruptBatch 的 requestApprovalsBatch(params.agentRunId) 每次传入；
  // bridge 缺字段会 throw，禁止空串降级。
  const userInteractiveChannel = bridgeUserInteractiveToLocalPermissionHandler(
    permissionHandler,
    { getThreadId: () => input.interactiveThreadId },
  )

  return {
    permissionMemoStore,
    permissionHandler,
    userInteractiveChannel,
  }
}
