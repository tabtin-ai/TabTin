/**
 * Checkpoint slice — createCheckpoint, restoreAndEdit, rollbackToCheckpoint.
 *
 * Extracted from useChatStore.ts to reduce its size.
 * These functions operate on the store via get()/set() and rely on
 * external dependencies (auth, API, preload) injected through a deps object.
 */

import type {
  ChatMessage,
  ChatSession,
  MessageListResponse,
  RollbackApplyResultView,
  RollbackPartialSuccessDetails,
} from '@tabtin/chat-client'
import type { ChatAttachment } from '../../../../components/chat/types'
import i18n from '@/i18n'
import { toast } from '@tabtin/smartsheet-ui'
import * as chatExtraApi from '../../../../services/chatExtraApi'
import * as checkpointIpc from '../../../../services/checkpointIpc'
import * as fileHistoryIpc from '../../../../services/fileHistoryIpc'
import { emitCheckpointCreated } from '../../../../services/checkpointEvents'
import { buildCheckpointMapFromMessages } from '../../session/slices/sessionRuntimeState'
import { isSessionBusy } from '../../execution/sessionRunProjection'
import { clearSessionCache, cacheMessages } from '../../messages/messageCache'
import { createLogger } from '@/utils/logger'
import { extractRetryableResourceRestoreItemsFromRollbackState } from '../utils/rollbackResult'
import { resolveRewindAnchorId } from '../utils/rewindAnchor'
import { stripEmptyInterruptedAssistants } from '../utils/stripEmptyInterruptedAssistants'
import {
  countSemanticMessages,
  isContextInjectionMessage,
  isRegularUserMessage,
} from '../../messages/utils/semanticMessageCount'
import { getSessionMessagesFacade } from '@/services/agentService/sessionMessages'
import { getSessionController } from '@/services/agentService'
import { rollbackRegistry } from '@/services/agentService/rollbackRegistry'
import { resolveSessionScopeId } from '@tabtin/app-shell'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useChatRuntimeStore, type PrefillData } from '@stores/useChatRuntimeStore'
import {
  mapAttachmentsForPrefill,
  mapBlocksForPrefill,
} from '../../presentation/messageBubble/messageResendContext'
import {
  isProjectTaskEditAndResendBlocked,
  PROJECT_TASK_RUN_REQUIRED_MESSAGE,
} from '../../messages/product/delivery/projectTaskSendGate'
import { prefillComposerAfterBlockedSend } from '../../messages/runtime/prefillComposerAfterBlockedSend'
import type {
  RecoveryPlanConfirmation,
  RecoveryPlanContract,
} from '../recoveryPlan'

// 回退编排与回退预览面板共用同一锚点解析（§3.9 规则 3）。函数本体抽到纯 util
// `../utils/rewindAnchor`（无重依赖），此处 re-export 保持既有 import 路径不变。
export { resolveRewindAnchorId }

const log = createLogger('Checkpoint')

/** per-file safety anchor 前缀（区别于 agentRunId / shadow-git hash）。 */
export const PER_FILE_SAFETY_ANCHOR_PREFIX = 'safety:'

function buildPerFileSafetyAnchorId(sessionId: string): string {
  return `${PER_FILE_SAFETY_ANCHOR_PREFIX}${sessionId}:${Date.now()}`
}

function isPerFileSafetyAnchor(ref: string | null | undefined): ref is string {
  return typeof ref === 'string' && ref.startsWith(PER_FILE_SAFETY_ANCHOR_PREFIX)
}

const CHECKPOINT_PERSIST_MAX_ATTEMPTS = 6
const RESOURCE_RESTORE_MAX_RETRIES = 3
const STREAM_ABORT_TIMEOUT_MS = 4_000
const ACTIVE_RUN_CANCEL_TIMEOUT_MS = 10_000
const ACTIVE_RUN_CANCEL_SETTLE_MS = 250
const operationQueues = new Map<string, Promise<void>>()
const FALLBACK_QUEUE_KEY = '_fallback'

/**
 * Tracks sessions that have already been reconciled in this app lifecycle.
 * Prevents redundant server syncs on repeated session switches.
 */
const reconciledSessionIds = new Set<string>()

function normaliseMessageContent(content: string | undefined): string {
  return (content ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 从「回退后保留的用户消息」重建 composer 预填数据。
 *
 * 回退到某条 assistant 后，会把它上一条用户消息回填到输入框方便重发。旧实现
 * 只回填 `content`（纯文本），丢掉了 `content_blocks_json` 里的引用 block 与
 * `attachments_json` 附件——回退后 chip / 附件全部消失。这里连同引用与附件一起
 * 还原成 `PrefillData`（与「编辑并重新发送」路径同构），交给 ChatInput 经
 * `blockToContextRef` 重建 chip。无引用无附件时退化为纯文本字符串，保持原语义。
 */
function buildRollbackPrefill(message: ChatMessage): string | PrefillData {
  const text = message.content || ''
  // ：与 regenerate/resend 共用 map*ForPrefill——media 进 attachments，
  // ContextRef 进 contextBlocks，避免 video file_id 被当成 TabVideo 丢掉。
  const contextBlocks = mapBlocksForPrefill(message.content_blocks_json)
  const attachments = mapAttachmentsForPrefill(message.attachments_json)
  if (!contextBlocks && !attachments) return text
  return {
    message: text,
    ...(contextBlocks ? { contextBlocks } : {}),
    ...(attachments ? { attachments } : {}),
  }
}

function resolveTargetOccurrenceIndex(messages: readonly ChatMessage[], targetMsg: ChatMessage): number | undefined {
  if (targetMsg.role !== 'user' && targetMsg.role !== 'assistant') return undefined
  const targetContent = normaliseMessageContent(typeof targetMsg.content === 'string' ? targetMsg.content : undefined)
  if (!targetContent) return undefined
  let occurrence = 0
  for (const message of messages) {
    if (targetMsg.role === 'user') {
      // ：occurrence 只计真人用户轮，跳过 push / skill_invoke / context inject
      if (!isRegularUserMessage(message)) continue
    } else {
      if (isContextInjectionMessage(message)) continue
      if (message.role !== targetMsg.role) continue
    }
    const content = normaliseMessageContent(typeof message.content === 'string' ? message.content : undefined)
    if (content !== targetContent) continue
    occurrence += 1
    if (message.id === targetMsg.id) return occurrence
  }
  return undefined
}

/** @internal — exposed for unit tests only */
export function _resetReconciledSessions() { reconciledSessionIds.clear() }

const ENQUEUE_TIMEOUT_MS = 65_000

let _activeRollbackAbortController: AbortController | null = null

function checkpointPersistRetryDelayMs(attempt: number): number {
  if (import.meta.env.MODE === 'test') return 0
  return Math.min(1000 * 2 ** attempt, 5000)
}

export function abortActiveRollback(): void {
  _activeRollbackAbortController?.abort()
}

/**
 * Enqueue an async operation so checkpoint actions execute serially per session.
 * Each session has its own queue so split-pane operations don't block each other.
 * Each operation has a 65s timeout to prevent queue deadlocks.
 */
function enqueue<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const key = sessionId || FALLBACK_QUEUE_KEY
  const withTimeout = () => {
    let timerId: ReturnType<typeof setTimeout> | null = null
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => reject(new EnqueueTimeoutError()), ENQUEUE_TIMEOUT_MS)
    })
    return Promise.race([fn(), timeoutPromise]).finally(() => {
      if (timerId != null) clearTimeout(timerId)
    })
  }
  const prev = operationQueues.get(key) ?? Promise.resolve()
  const task = prev.then(withTimeout, withTimeout)
  const settled = task.then(() => {}, () => {})
  operationQueues.set(key, settled)
  settled.then(() => {
    if (operationQueues.get(key) === settled) operationQueues.delete(key)
  })
  return task
}

class EnqueueTimeoutError extends Error {
  constructor() { super('Checkpoint operation timed out'); this.name = 'EnqueueTimeoutError' }
}

// ── apply_result.layers 结构化展示（ 追加：partial_success 分层 toast）────

type ApplyLayers = RollbackApplyResultView['layers']
type ApplyLayerKey = keyof ApplyLayers

const APPLY_LAYER_ORDER: ApplyLayerKey[] = ['conversation', 'workspace_files', 'resources', 'pg_state']

function applyLayerLabel(key: ApplyLayerKey): string {
  switch (key) {
    case 'conversation':
      return i18n.t('chat:checkpoint.layerConversation', { defaultValue: '对话' })
    case 'workspace_files':
      return i18n.t('chat:checkpoint.layerFiles', { defaultValue: '文件' })
    case 'resources':
      return i18n.t('chat:checkpoint.layerResources', { defaultValue: '资源' })
    case 'pg_state':
      return i18n.t('chat:checkpoint.layerPgState', { defaultValue: '数据状态' })
  }
}

function applyLayerStatusLabel(status: ApplyLayers[ApplyLayerKey]['status']): string {
  switch (status) {
    case 'success':
      return i18n.t('chat:checkpoint.layerStatusSuccess', { defaultValue: '已完成' })
    case 'partial_success':
      return i18n.t('chat:checkpoint.layerStatusPartial', { defaultValue: '部分成功' })
    case 'failed':
      return i18n.t('chat:checkpoint.layerStatusFailed', { defaultValue: '失败' })
    case 'pending':
      return i18n.t('chat:checkpoint.layerStatusPending', { defaultValue: '处理中' })
    case 'not_applicable':
      return ''
  }
}

/**
 * 把 apply_result.layers 逐层拼成中文摘要行（`对话：已完成` / `资源：部分成功（2 成功 / 1 失败）`）。
 * `not_applicable` 层跳过。@internal exposed for unit tests.
 */
export function buildApplyLayerSummaryLines(layers: ApplyLayers): string[] {
  const lines: string[] = []
  for (const key of APPLY_LAYER_ORDER) {
    const layer = layers[key]
    if (!layer || layer.status === 'not_applicable') continue
    let detail = applyLayerStatusLabel(layer.status)
    if (key === 'resources' && (layer.restored_count != null || layer.failed_count != null) && layer.status !== 'success') {
      detail += `（${i18n.t('chat:checkpoint.layerResourcesPartial', {
        restored: layer.restored_count ?? 0,
        failed: layer.failed_count ?? 0,
        defaultValue: '{{restored}} 成功 / {{failed}} 失败',
      })}）`
    } else if (layer.reason && layer.status !== 'success') {
      detail += `（${layer.reason}）`
    }
    lines.push(`${applyLayerLabel(key)}：${detail}`)
  }
  return lines
}

/**
 * 后端 apply_result 已带 layers、但 rollback_state.partial_success_details 缺失时，
 * 从 layers 推导出对齐的 details（RevertBanner / RevertHistorySheet 消费同一形状）。
 * 无失败/部分层时返回 null。@internal exposed for unit tests.
 */
export function derivePartialSuccessDetailsFromLayers(layers: ApplyLayers): RollbackPartialSuccessDetails | null {
  const details: RollbackPartialSuccessDetails = {}
  const wf = layers.workspace_files
  if (wf && (wf.status === 'failed' || wf.status === 'partial_success')) {
    details.workspace_files = { success: false, reason: wf.reason ?? null }
  }
  const res = layers.resources
  if (res && (res.status === 'failed' || res.status === 'partial_success')) {
    details.resources = {
      restored_count: res.restored_count ?? 0,
      failed_count: res.failed_count ?? 0,
      retryable: res.retryable ?? [],
      collab_sync_warnings: res.warnings ?? [],
    }
  }
  return Object.keys(details).length > 0 ? details : null
}

export interface CheckpointDeps {
  /**
   * ：解析 checkpoint 操作的工作区路径。传入 `sessionId` 时按该会话的
   * 执行根解析（有活跃代码根绑定则用绑定根，否则回落全局 active Space 根）；
   * 缺省 `sessionId`（历史调用点 / 无 session 上下文）时行为与改动前一致。
   */
  resolveSpacePath: (sessionId?: string | null) => Promise<string | null>
  getChatClient: () => { messages: { list: (sessionId: string, opts: { limit: number }) => Promise<MessageListResponse | { messages?: ChatMessage[] }> } }
  cleanupHitlState?: (sessionId: string, removedMessageIds: Set<string>) => void
  cleanupRuntimeState?: (sessionId: string) => void
  /**
   *  阶段C：回退成功后重发新内容（编辑重发）。以注入端口取代
   * `get().sendMessage(...)` 直接互调——checkpoint slice 不再依赖发送编排存在，
   * 「回退→重发」的接线由组合根显式装配（斩断 checkpoint↔send 直接耦合）。
   * 组合根（useChatStore）必然注入；可选仅为兼容不测试重发路径的单测。
   */
  resendAfterRestore?: (
    content: string,
    attachments: ChatAttachment[] | undefined,
    contextBlocks: Array<Record<string, unknown>> | undefined,
    sessionId: string,
  ) => Promise<{
    accepted: boolean
    persisted: boolean
    reason?: string
  }>
}

/**
 * Store slice that checkpoint actions need to read/write.
 */
export interface RewindPreviewState {
  sessionId: string
  targetMessageId: string
  mode: 'rollback' | 'editAndResend'
  resendIntent?: 'edit' | 'resend'
  editContent?: string
  editAttachments?: ChatAttachment[]
  editContextBlocks?: Array<Record<string, unknown>>
  resourceRestorePlan?: chatExtraApi.ResourceRestoreInfo[]
}

export type CheckpointHealth = 'healthy' | 'warning' | 'error'

export type RestoringPhase = 'preparing' | 'files' | 'resources' | 'finalizing'

export interface CheckpointStore {
  currentSessionId: string | null
  sessions: ChatSession[]
  messagesBySessionId: Record<string, ChatMessage[]>
  restoringSessionId: string | null
  restoringPhase: RestoringPhase | null
  restoreInterruptedBySessionId: Record<string, boolean>
  editResendRevertBySessionId: Record<string, boolean>
  checkpointsBySessionId: Record<string, Record<string, string>>
  lastSafetyCheckpointBySessionId: Record<string, string>
  checkpointFailCountBySessionId: Record<string, number>
  checkpointHealthBySessionId: Record<string, CheckpointHealth>
  rewindPreview: RewindPreviewState | null
  resourceRetryCountBySessionId: Record<string, number>
  abortStreamAndWait: (timeoutMs?: number, sessionId?: string | null) => Promise<{ cancelRequested: boolean; cancelCompleted: boolean }>
  sendMessage: (message: string, streaming?: boolean, attachments?: ChatAttachment[], contextBlocks?: Array<Record<string, unknown>>, targetSessionId?: string) => Promise<void>
  replaceFromRollback: (sessionId: string, serverMessages: ChatMessage[]) => ChatMessage[]
  applyRollbackTruncation: (sessionId: string, messages: ChatMessage[]) => void
  injectSystemMessage: (sessionId: string, message: ChatMessage) => void
  updateSessionInCaches: (sessionId: string, patch: Partial<ChatSession>) => void
}

type GetFn = () => CheckpointStore
type SetFn = (partial: Partial<CheckpointStore> | ((state: CheckpointStore) => Partial<CheckpointStore>)) => void

export function createCheckpointActions(
  get: GetFn,
  set: SetFn,
  deps: CheckpointDeps,
) {
  const { resolveSpacePath, getChatClient, cleanupHitlState, cleanupRuntimeState, resendAfterRestore } = deps

  function handleCollabPostRestore(
    label: string,
    collabSyncWarnings: Array<{ resource?: string | null; warning?: string | null }> | null | undefined,
    resourceTypes: string[],
  ): void {
    const { hasForceCloseFailed } = chatExtraApi.extractCollabSyncWarnings(collabSyncWarnings ?? undefined)
    if (hasForceCloseFailed) {
      log.warn(`${label}: collab force-close failed for some resources`, collabSyncWarnings)
      toast({
        title: i18n.t('chat:checkpoint.collabSyncWarning', {
          defaultValue: '版本已恢复，但部分在线用户的协作状态可能未同步，请通知相关用户刷新页面',
        }),
        variant: 'warning',
      })
    }
    if (resourceTypes.length > 0) {
      window.dispatchEvent(new CustomEvent('tabtin:collab-resource-restored', {
        detail: { resourceTypes },
      }))
    }
  }

  function recordCheckpointFailure(sessionId: string): void {
    // per-file 迁移期（CO-3 / 批次1 复核 P2-1）：回退已由 per-file file-history 接管，
    // shadow-git checkpoint commit 失败**不影响**回退能力。**不再写 checkpointHealth**
    // ——它同时驱动（已静音的）toast 与 MessageActions 的「回退功能暂不可用」warning
    // badge（MessageBubble.shouldShowRollbackWarning 看 health==='warning'/'error'），
    // 二者是同一句虚假告警（挂在已不负责回退的 shadow-git 创建侧）。只保留 failCount
    // 供调试；health 不再被写 → badge / toast 都不再弹。shadow-git 创建侧在阶段 5 下线。
    const failCount = (get().checkpointFailCountBySessionId[sessionId] || 0) + 1
    set(state => ({
      checkpointFailCountBySessionId: { ...state.checkpointFailCountBySessionId, [sessionId]: failCount },
    }))
  }

  async function syncMessagesFromServer(sessionId: string, extraState?: Partial<CheckpointStore>) {
    const client = getChatClient()
    const response = await client.messages.list(sessionId, { limit: 500 })
    const serverMessages: ChatMessage[] = 'messages' in response && Array.isArray(response.messages)
      ? response.messages
      : []
    // ：整表替换 + 未落库保护 + 结构性变更登记 + 写回全部内聚在 replaceFromRollback，
    // 保留「runtime 起源且服务端尚无对应行」的消息（relay 迟延窗口， self-heal 曾误刷）。
    const resolved = get().replaceFromRollback(sessionId, serverMessages)
    set(state => ({
      checkpointsBySessionId: {
        ...state.checkpointsBySessionId,
        [sessionId]: buildCheckpointMapFromMessages(resolved),
      },
      ...extraState,
    }))
    return resolved
  }

  function resetResourceRetryCount(sessionId: string) {
    set(state => {
      const { [sessionId]: _, ...rest } = state.resourceRetryCountBySessionId
      return { resourceRetryCountBySessionId: rest }
    })
  }

  async function rollbackViaRuntime(
    sessionId: string,
    targetMsg: ChatMessage,
    targetIdx: number,
    mode: 'rollback' | 'editAndResend',
    rollbackReason?: string,
    safetySnapshotHash?: string | null,
    recoveryPlan?: RecoveryPlanContract,
    acknowledgedFilePreviewReason?: string,
  ): Promise<Awaited<ReturnType<typeof chatExtraApi.rollbackSession>>> {
    // assistant 目标保留其本身（keep = targetIdx + 1）；user 目标移除该 user 及其后
    // （keep = targetIdx）。与 runtime computeRuntimeKeepMessageCount / UI keepCount 对齐。
    const keepMessageCount = targetIdx >= 0
      ? (targetMsg.role === 'assistant' ? targetIdx + 1 : targetIdx)
      : 0
    const currentSession = get().sessions.find(session => session.id === sessionId)
    const selectedSpace = useSpaceStore.getState().selectedSpace
    const messages = get().messagesBySessionId[sessionId] ?? []
    // ：runtime 时间线回退的**通道**在 hub（SessionController）；参数组装与
    // 结果解包（业务语义）留在本编排层。
    let res: Awaited<ReturnType<ReturnType<typeof getSessionController>['rollbackSessionTimeline']>>
    try {
      res = await getSessionController(sessionId).rollbackSessionTimeline({
        targetMessageId: targetMsg.id,
        targetRole: targetMsg.role === 'assistant' ? 'assistant' : 'user',
        targetContent: typeof targetMsg.content === 'string' ? targetMsg.content : undefined,
        targetOccurrenceIndex: resolveTargetOccurrenceIndex(messages, targetMsg),
        mode,
        keepMessageCount,
        rollbackReason,
        previewRevision: recoveryPlan?.previewRevision,
        filePreviewRevision: recoveryPlan?.filePreviewRevision,
        fileRewindAnchorId: recoveryPlan?.fileAnchor.id ?? undefined,
        rollbackContractVersion: recoveryPlan?.version,
        acknowledgedFilePreviewReason,
        safetySnapshotHash: safetySnapshotHash ?? undefined,
        spaceId: resolveSessionScopeId(currentSession) ?? selectedSpace?.id,
        organizationId: currentSession?.organization_id ?? selectedSpace?.organization_id,
      })
    } catch (err) {
      // 通道不可用（无本机 runtime bridge）→ 翻译成用户可读文案（fail-visible）。
      log.warn('rollbackViaRuntime: runtime channel unavailable', err)
      throw new Error(i18n.t('chat:checkpoint.runtimeRollbackUnavailable', {
        defaultValue: '本地运行时回退能力不可用，无法执行回退',
      }))
    }
    if (!res?.success || res.applied === false || !res.backend) {
      const detail = res?.error ?? 'runtime rollback failed'
      throw new Error(i18n.t('chat:checkpoint.backendRollbackFailed', { detail }))
    }
    return res.backend as Awaited<ReturnType<typeof chatExtraApi.rollbackSession>>
  }

  async function cancelActiveRunBestEffort(sessionId: string): Promise<void> {
    // ：run 取消是双通道连接操作（本机 IPC abort + 后端 cancel），收在 hub。
    await getSessionController(sessionId).cancelActiveRun({
      timeoutMs: ACTIVE_RUN_CANCEL_TIMEOUT_MS,
      settleMs: ACTIVE_RUN_CANCEL_SETTLE_MS,
    })
  }

  // ── 本地文件回退已切换到 per-file（§3.5 / §3.9 /  / ）────────
  // 旧 shadow-git `createSafetyCheckpoint` / `restoreFiles` / `restoreSafe` 已删除。
  // 现行口径（ 起，不再是「本期降级只恢复对话」）：
  //   - 回退文件：`fileHistoryIpc.rewind(sessionId, agentRunId)`（见下方 pipeline）。
  //   - unrevert 文件：回退前 `createSafetySnapshot` → `safety:…` 锚点写入后端；
  //     unrevert 在 API 成功后对 `safety:` 锚点再 `rewind`（无锚点 / IPC 不可用则
  //     只保证对话，文件层 fail-visible）。

  // ── Shared rollback pipeline ──────────────────────────────────────────
  //
  // Both restoreAndEdit and rollbackToCheckpoint follow the same steps:
  //   1. Precondition checks (session, restoring state)
  //   2. Abort streaming if needed（空闲会话绝不发送 abort，避免取消下一轮）
  //   3. Find target message + resolve rewind anchorId(=agentRunId)
  //   4. Rollback backend (对话/云资源/HITL) → per-file rewind (本地文件)
  //   5. Truncate messages + update store
  //   6. Post-success actions (send message / mark reverted)
  //   7. Error recovery (unrevert backend, toast)

  interface RollbackPipelineConfig {
    messageId: string
    sessionId?: string
    label: string
    /**
     * 解析 per-file 回退锚点（§3.9 规则 3）：返回目标那一轮顶层 `agentRunId`，
     * 用于 `fileHistoryIpc.rewind(sessionId, anchorId)`。返回 `null` = 无可回退
     * 文件快照（跳过文件恢复，但对话/云资源照常回退，不报错、不 reset）。
     */
    resolveAnchorId: (ctx: {
      messages: ChatMessage[]
      targetMsg: ChatMessage
      targetIdx: number
    }) => string | null
    /** 保留多少条消息：targetIdx = 移除 target 及其后（rollback / editAndResend）。 */
    keepCount: (ctx: { targetMsg: ChatMessage; targetIdx: number }) => number
    /** Resource restore plan from preview API (Phase 2) */
    resourceRestorePlan?: chatExtraApi.ResourceRestoreInfo[]
    /** 用户确认的恢复计划；执行阶段不得再从本地消息重算其中的锚点或修订。 */
    recoveryPlan?: RecoveryPlanContract
    /**
     * 用户在预览中明确接受的“文件保持当前状态”原因。执行阶段只在同一个
     * 稳定原因再次出现时放行；任何新原因仍刹车并保留草稿。
     */
    approvedUnavailableFileReason?: string
    /** 用户标注的回退原因（可选） */
    rollbackReason?: string
    /**
     * 回退前是否为本地 per-file 建 safety 快照（供 unrevert「恢复原状」还原文件）。
     * 默认 true。editAndResend 传 false：编辑重发回退后立即发新消息、即刻接受回退
     * （revert 态被清、被回退消息物理清理），永远进不了可 unrevert 态，safety 快照
     * 建了也永不被消费——故编辑重发路径跳过创建。
     */
    createSafetySnapshot?: boolean
    /**
     * 本次是否为「编辑并重发」。为 true 时回退产生的 revert 态**不**弹「已回退到历史
     * 版本 / 恢复原状」横幅（RevertBanner）——编辑重发要么立即发新消息消费掉回退、
     * 要么刹车停在无快照可恢复的回退态，两种都不该呈现「可恢复原状」的静置回退横幅
     * 。rollback 路径不传 / false，横幅照常。
     */
    isEditResend?: boolean
    /**
     * Called after successful rollback, before cleanup.
     * `fileRewindFailed`：本地 per-file 文件回退是否失败（rewind 抛错 / failedFiles 非空）。
     * `transcriptRewindFailed`：本地 transcript 是否未成功写入回退标记。
     * `resourceRestoreFailed`：用户选择恢复的资源是否至少有一个失败；显式 skip 不计失败。
     * editAndResend 据此刹车——任一已选择恢复层没到位时**不**自动重发，
     * 避免新一轮 Agent 基于不一致的工作现场继续跑。
     */
    onSuccess?: (ctx: {
      sessionId: string
      fileRewindFailed: boolean
      transcriptRewindFailed: boolean
      resourceRestoreFailed: boolean
      targetMsg: ChatMessage
      targetIdx: number
      messagesBeforeRollback: readonly ChatMessage[]
    }) => Promise<void>
    /** editAndResend 已改写时间线后的收尾异常：保留待发内容，不自动 unrevert。 */
    onFailureAfterRollback?: (sessionId: string) => void
    /** Extra state to merge after success */
    extraSuccessState?: (ctx: { sessionId: string }, state: CheckpointStore) => Partial<CheckpointStore>
    /** Toast key for generic failure */
    failToastKey: string
    failToastDefault: string
  }

  async function executeRollbackPipeline(config: RollbackPipelineConfig): Promise<void> {
    const { currentSessionId, abortStreamAndWait, restoringSessionId } = get()
    const targetSessionId = config.sessionId || currentSessionId
    if (!targetSessionId) return
    if (restoringSessionId) {
      if (restoringSessionId !== targetSessionId) {
        toast({ title: i18n.t('chat:checkpoint.anotherSessionRestoring', { defaultValue: '另一个会话正在恢复中，请稍后再试' }) })
      }
      return
    }
    const isStreaming = isSessionBusy(targetSessionId)
    let backendRolledBack = false

    try {
      set({ restoringSessionId: targetSessionId, restoringPhase: 'preparing' })

      if (isStreaming) {
        const { cancelCompleted } = await abortStreamAndWait(STREAM_ABORT_TIMEOUT_MS, targetSessionId)
        if (!cancelCompleted) {
          toast({ title: i18n.t('chat:checkpoint.abortNotCompleted', { defaultValue: 'Agent 仍在运行，请等待完成后重试' }) })
          set({ restoringSessionId: null, restoringPhase: null })
          return
        }
      }

      // ：abort 之后再读 LIVE 列表做截断，避免 abort 前冻结快照与
      // ActiveRunBinding 中断标记 / abort 期间建壳脱节。
      const messages = get().messagesBySessionId[targetSessionId] ?? []
      const targetMsg = messages.find(m => m.id === config.messageId)
      if (!targetMsg) {
        log.error(`${config.label}: Target message not found`)
        toast({ title: i18n.t('chat:checkpoint.targetMsgNotFound', { defaultValue: '找不到目标消息，无法执行操作' }) })
        set({ restoringSessionId: null, restoringPhase: null })
        return
      }

      const targetIdx = messages.indexOf(targetMsg)
      // 无预览的旧入口才从消息推导；确认后的执行只消费恢复计划里的权威锚点。
      const locallyDerivedAnchorId = config.resolveAnchorId({ messages, targetMsg, targetIdx })
      const anchorId = config.recoveryPlan
        ? config.recoveryPlan.fileAnchor.id
        : locallyDerivedAnchorId

      // ：回退前为本地 per-file 建 safety 快照（捕获即将被 rewind 覆盖的
      // tracked 文件当前状态），unrevert 时 `rewind(safetyAnchorId)` 还原。
      let safetySnapshotRef: string | null = null
      if (config.createSafetySnapshot !== false && anchorId && fileHistoryIpc.isAvailable()) {
        const candidate = buildPerFileSafetyAnchorId(targetSessionId)
        try {
          await fileHistoryIpc.createSafetySnapshot(targetSessionId, candidate)
          safetySnapshotRef = candidate
          log.info(`${config.label}: per-file safety snapshot anchor=${candidate}`)
        } catch (err) {
          log.warn(`${config.label}: per-file safety snapshot failed (unrevert may not restore files)`, err)
        }
      }

      // Runtime-first rollback：agent-runtime 先计算并写入权威 REWIND boundary；
      // runtime 成功后由 Host 同步 Django rollback 投影。
      const rollbackResult = await rollbackViaRuntime(
        targetSessionId,
        targetMsg,
        targetIdx,
        config.label === 'restoreAndEdit' ? 'editAndResend' : 'rollback',
        config.rollbackReason,
        safetySnapshotRef,
        config.recoveryPlan,
        config.approvedUnavailableFileReason,
      )
      backendRolledBack = true
      // ：Django rollback 成功即会向所有端（含本端）广播 ROLLBACK。本机是
      // 发起端、runtime 已是权威，登记期望让回流的自发广播跳过整页重拉——重拉
      // 与下方本地截断竞态，正是被回退消息复活的根因。
      getSessionMessagesFacade(targetSessionId).expectSelfRollbackBroadcast()
      const applyResult = rollbackResult.apply_result ?? null
      if (rollbackResult.rollback_state) {
        let rollbackState = rollbackResult.rollback_state
        // 对齐写入：API 已返回分层 apply_result 但 rollback_state 缺 partial_success_details
        // 时，从 layers 推导补齐——RevertBanner / RevertHistorySheet 都消费这份 details。
        if (applyResult?.layers && !rollbackState.partial_success_details) {
          const derived = derivePartialSuccessDetailsFromLayers(applyResult.layers)
          if (derived) rollbackState = { ...rollbackState, partial_success_details: derived }
        }
        get().updateSessionInCaches(targetSessionId, {
          rollback_state: rollbackState,
          revert_snapshot_hash: rollbackState.safety_snapshot_ref ?? null,
        })
      }
      // partial_success 分层 toast（fail-visible）：逐层展示 conversation/workspace_files/
      // resources/pg_state 的 status + detail，让用户在 apply 完成瞬间就看清哪层没到位。
      const applyOverallStatus = applyResult?.overall_status ?? rollbackResult.overall_status
      if (applyResult?.layers && applyOverallStatus === 'partial_success') {
        const layerLines = buildApplyLayerSummaryLines(applyResult.layers)
        if (layerLines.length > 0) {
          const hasFailedLayer = Object.values(applyResult.layers)
            .some(layer => layer?.status === 'failed')
          toast({
            title: i18n.t('chat:checkpoint.applyPartialTitle', { defaultValue: '回退部分完成' }),
            description: layerLines.join('\n'),
            variant: hasFailedLayer ? 'destructive' : 'warning',
          })
        }
      }
      resetResourceRetryCount(targetSessionId)
      const transcriptRewindFailed = false

      // ── 本地文件回退：per-file + 宿主分流（§3.9）─────────────────────────────
      //
      // 后端 file_restore_host 是宿主分流的**权威判据**（后端 _resolve_daemon_context
      // 解析 Space 绑定控制设备）——避免前端自行判断宿主（前端无可靠 device/runtime 信息）：
      //   - 'daemon'：Daemon 宿主会话，文件在远端，已由后端 file_history_rewind 处理 →
      //     前端**不**本地 rewind（本进程无该 thread 账本，盲调必抛错假警报）；文件层
      //     结果以 file_restore_success 为准。
      //   - 'local'/缺省：Electron 本地宿主，文件在本机 → 前端 fileHistoryIpc.rewind 负责。
      // rewind 只还原该轮 track 过的文件（INV-3：文件工具 + shell pre-track；#2656），
      // 跟 git / 工作区根权限无关（INV-5）。不碰用户手改、未备份的终端新建等。
      // fail-visible：失败计入 failedFiles / file_restore_success，绝不静默成功（INV-4）。
      const backendHandledFiles = rollbackResult.file_restore_host === 'daemon'
        || rollbackResult.file_restore_coordinated_by_host === true
      let fileRewindResult: fileHistoryIpc.FileHistoryRewindResult | null = null
      let fileRewindFailed = false
      set({ restoringPhase: 'files' })
      if (backendHandledFiles) {
        // Daemon 宿主：文件回退已由后端 per-file rewind 完成，前端不本地 rewind。
        if (rollbackResult.file_restore_success === false) {
          const executionReason = rollbackResult.file_restore_reason ?? null
          const acceptedConversationOnly = fileHistoryIpc.canContinueWithoutFileRestore(executionReason)
            && executionReason === config.approvedUnavailableFileReason
          fileRewindFailed = !acceptedConversationOnly
          if (fileRewindFailed) {
            toast({
              title: i18n.t('chat:checkpoint.fileRestoreWarning', {
                defaultValue: '工作区文件恢复失败，请手动检查文件状态',
              }),
              variant: 'warning',
            })
          }
        }
      } else if (!anchorId) {
        // §3.9 规则 3 边界：目标之后还没有 agent run（user 消息未触发回复）→ 无锚点。
        // 绝不报错、绝不 reset：对话/云资源照常回退，仅跳过文件恢复并明确告知。
        log.warn(`${config.label}: no rewind anchor (no agent run for target); skipping file restore`)
        toast({
          title: i18n.t('chat:checkpoint.noFileSnapshotSkipRestore', {
            defaultValue: '该消息没有可恢复的代码快照，已回退对话但工作区文件保持不变',
          }),
          variant: 'warning',
        })
      } else if (fileHistoryIpc.isAvailable()) {
        try {
          fileRewindResult = await fileHistoryIpc.rewind(
            targetSessionId,
            anchorId,
            config.recoveryPlan?.filePreviewRevision,
          )
          log.info(`${config.label}: per-file rewind anchor=${anchorId}`, fileRewindResult)
          if (fileRewindResult.failedFiles.length > 0) {
            // fail-visible（实现要求 2）：非空 failedFiles 必须明确告知，绝不静默成功。
            fileRewindFailed = true
            toast({
              title: i18n.t('chat:checkpoint.rewindFilesPartialFailed', {
                count: fileRewindResult.failedFiles.length,
                defaultValue: '{{count}} 个文件未能恢复，请手动检查工作区',
              }),
              variant: 'warning',
            })
          }
        } catch (err) {
          // rewind 抛错：只有执行原因与用户在预览里明确接受的稳定原因完全一致，
          // 才允许“仅重写对话”；预览后新出现的任何文件错误都必须暂停自动发送。
          const detail = err instanceof Error ? err.message : String(err)
          const executionReason = fileHistoryIpc.classifyFileHistoryUnavailableReason(err)
          const acceptedConversationOnly = fileHistoryIpc.canContinueWithoutFileRestore(executionReason)
            && executionReason === config.approvedUnavailableFileReason
          fileRewindFailed = !acceptedConversationOnly
          log.warn(`${config.label}: per-file rewind failed (conversation rollback kept):`, detail)
          if (fileRewindFailed) {
            toast({
              title: i18n.t('chat:checkpoint.fileRewindFailedKeepConversation', {
                defaultValue: '工作区文件未能自动恢复，但对话已回退；请手动检查文件状态',
              }),
              variant: 'warning',
            })
          }
        }
      } else {
        // 确认与执行之间 IPC 仍可能断开；执行层也必须 fail-closed。
        // local 宿主存在文件锨点时，跳过恢复后继续重发会让对话与
        // 工作区不一致。
        fileRewindFailed = true
        toast({
          title: i18n.t('chat:checkpoint.fileRewindUnavailableKeepConversation', {
            defaultValue: '工作区文件恢复能力已断开，对话已回退但文件状态待确认',
          }),
          variant: 'warning',
        })
      }

      let resourceRestoredCount = 0
      let resourceFailedCount = 0
      let resourceRestoreFailed = false
      if (config.resourceRestorePlan && config.resourceRestorePlan.length > 0) {
        set({ restoringPhase: 'resources' })
        // v2 要求预览 plan 全集都有显式决策：可恢复项严格沿用
        // action/version，不可恢复或用户排除项显式发 skip，不能靠“省略”表达。
        const fullPlanDecisions = config.resourceRestorePlan
          .map(ri => ({
            resource_type: ri.resource_type,
            resource_id: ri.resource_id,
            action: (
              ri.can_restore && (ri.action === 'restore_version' || ri.action === 'trash')
                ? ri.action
                : 'skip'
            ) as 'restore_version' | 'trash' | 'skip',
            restore_to_version_id: (
              ri.can_restore && ri.action === 'restore_version'
                ? ri.restore_to_version_id
                : null
            ),
          }))

        if (fullPlanDecisions.length > 0) {
          try {
            const result = await chatExtraApi.restoreResources(targetSessionId, fullPlanDecisions, {
              rollbackContractVersion: config.recoveryPlan?.version ?? (config.isEditResend ? 2 : 1),
              previewRevision: config.recoveryPlan?.previewRevision,
            })
            resourceRestoredCount = result.restored_count
            resourceFailedCount = result.failed_count ?? 0
            // 既看聚合计数也看业务 success：旧端 / 异常响应可能只回
            // success=false 而没有 failed_count，不能因 0 默认值误继续重发。
            resourceRestoreFailed = result.success === false || resourceFailedCount > 0
            if (result.rollback_state) {
              get().updateSessionInCaches(targetSessionId, {
                rollback_state: result.rollback_state,
                revert_snapshot_hash: result.rollback_state.safety_snapshot_ref ?? null,
              })
            }
            if (result.failed_count > 0) {
              const results = Array.isArray(result.results) ? result.results : []
              const failedItems = results.filter(r => !r.success)
              const nameMap = new Map(
                (config.resourceRestorePlan ?? []).map(ri => [`${ri.resource_type}:${ri.resource_id}`, ri.resource_name]),
              )
              const failedNames = failedItems
                .map(f => nameMap.get(`${f.resource_type}:${f.resource_id}`) || f.resource_id.slice(0, 8))
                .slice(0, 3)
              const detail = failedNames.join('、') + (failedItems.length > 3 ? ` 等${failedItems.length}个` : '')

              log.warn(`${config.label}: ${result.failed_count} resource(s) failed to restore`, failedItems)
              toast({
                title: i18n.t('chat:checkpoint.resourceRestorePartial', {
                  restored: result.restored_count,
                  failed: result.failed_count,
                  defaultValue: '{{restored}} 个资源已恢复，{{failed}} 个恢复失败',
                }),
                description: detail,
              })
            } else if (result.restored_count > 0) {
              log.info(`${config.label}: ${result.restored_count} resource(s) restored`)
            }
            handleCollabPostRestore(
              config.label,
              result.collab_sync_warnings,
              [...new Set(fullPlanDecisions.map(ri => ri.resource_type))],
            )
          } catch (err) {
            resourceRestoreFailed = true
            log.warn(`${config.label}: Resource restore failed, continuing with rollback`, err)
            toast({
              title: i18n.t('chat:checkpoint.resourceRestoreFailed', {
                defaultValue: '资源恢复失败，聊天和文件已回退',
              }),
            })
          }
        }
      }

      set({ restoringPhase: 'finalizing' })
      // ：finalizing 前再读 LIVE；目标已不在则中止，绝不拿过期 keep 硬截。
      const liveMessages = get().messagesBySessionId[targetSessionId] ?? []
      const liveTargetIdx = liveMessages.findIndex(m => m.id === config.messageId)
      if (liveTargetIdx < 0) {
        throw new Error(
          `${config.label}: target message missing at finalizing (${config.messageId})`,
        )
      }
      const liveTargetMsg = liveMessages[liveTargetIdx]!
      const keepCount = config.keepCount({
        targetMsg: liveTargetMsg,
        targetIdx: liveTargetIdx,
      })
      const truncatedMessages = stripEmptyInterruptedAssistants(
        liveMessages.slice(0, keepCount),
      )
      const removedMessages = liveMessages.slice(keepCount)
      const removedIds = new Set(removedMessages.map(m => m.id))
      const removedCount = countSemanticMessages(removedMessages)

      const summaryParts: string[] = []
      if (removedCount > 0) summaryParts.push(i18n.t('chat:checkpoint.rewindMsgsRemoved', { count: removedCount, defaultValue: '移除了 {{count}} 条消息' }))
      // 文件层摘要按实际结果诚实呈现（ 假成功 UX）：
      //   - 失败（fileRewindFailed）→ "文件恢复待确认"。
      //   - Daemon 宿主（backendHandledFiles）由后端实际处理 → "文件已恢复"（后端仅在处理了才回 daemon 且 success）。
      //   - 本地 rewind：仅当实际还原/删除了文件（filesRestored + filesDeleted > 0）才说"文件已恢复"；
      //     rewind 跑了但 0 文件变更（该轮无 tracked 改动）**不再谎报"文件已恢复"**，避免用户以为回退了代码。
      const localFilesChanged = fileRewindResult
        ? fileRewindResult.filesRestored.length + fileRewindResult.filesDeleted.length
        : 0
      if (fileRewindFailed) {
        summaryParts.push(i18n.t('chat:checkpoint.rewindFilesIssue', { defaultValue: '文件恢复待确认' }))
      } else if (backendHandledFiles || localFilesChanged > 0) {
        summaryParts.push(i18n.t('chat:checkpoint.rewindFilesRestored', { defaultValue: '文件已恢复' }))
      }
      if (resourceRestoredCount > 0 || resourceFailedCount > 0) {
        if (resourceFailedCount > 0) {
          summaryParts.push(i18n.t('chat:checkpoint.rewindResourcesPartial', {
            restored: resourceRestoredCount,
            failed: resourceFailedCount,
            defaultValue: '{{restored}} 个资源已恢复，{{failed}} 个恢复失败',
          }))
        } else {
          summaryParts.push(i18n.t('chat:checkpoint.rewindResourcesRestored', { count: resourceRestoredCount, defaultValue: '{{count}} 个资源已恢复' }))
        }
      }

      const withSummary = [...truncatedMessages]
      // 编辑重发是一次时间线重写，不是一个需要留在对话里的普通回退事件。
      // 新消息会成为唯一可见结果；失败刹车也通过 toast + composer 草稿表达，
      // 避免缓存里残留「回退完成」摘要，随后又被当成历史消息同步回来。
      if (!config.isEditResend && summaryParts.length > 0) {
        withSummary.push({
          id: `rewind-summary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'system' as const,
          content: `${i18n.t('chat:checkpoint.rewindCompleted', { defaultValue: '回退完成' })} — ${summaryParts.join(i18n.t('chat:checkpoint.rewindSeparator', { defaultValue: '，' }))}`,
          created_at: new Date().toISOString(),
        } as ChatMessage)
      }
      // ：回退截断是本地权威结构性变更——bump epoch，使截断前发起、尚未写回
      // 的服务端 sync（MESSAGE_COMMITTED / lifecycle end / 重连对账）全部作废，
      // 被回退消息不再经迟到写回复活。
      getSessionMessagesFacade(targetSessionId).recordStructuralMutation('rollback-truncate')
      get().applyRollbackTruncation(targetSessionId, withSummary)
      await cacheMessages(targetSessionId, withSummary, undefined, { preserveSyncTimestamp: true })

      if (removedIds.size > 0) {
        set(state => {
          const prev = state.checkpointsBySessionId[targetSessionId] ?? {}
          const next = { ...prev }
          for (const id of removedIds) delete next[id]
          return { checkpointsBySessionId: { ...state.checkpointsBySessionId, [targetSessionId]: next } }
        })
      }

      // 全量清理 runtime 数据：回滚后所有按 session 索引的内存态（agentSteps、toolEvents、
      // assistantEvents、runState 等）都可能引用已删除的消息，统一驱逐比逐字段清理更安全。
      // runtime 数据是纯内存态、不持久化，全量清理的代价可接受。
      cleanupRuntimeState?.(targetSessionId)

      if (removedIds.size > 0) cleanupHitlState?.(targetSessionId, removedIds)

      set(state => {
        const { [targetSessionId]: _, ...restInterrupted } = state.restoreInterruptedBySessionId
        return {
          restoringSessionId: null,
          restoringPhase: null,
          restoreInterruptedBySessionId: restInterrupted,
          // ：编辑重发的回退态不弹「已回退到历史版本」横幅；rollback 置 false 照常弹。
          // 每次回退操作都经过此块确定性覆写，避免陈旧标记误判后续 rollback。
          editResendRevertBySessionId: {
            ...state.editResendRevertBySessionId,
            [targetSessionId]: config.isEditResend === true,
          },
          ...(config.extraSuccessState?.({ sessionId: targetSessionId }, state) ?? {}),
        }
      })

      await config.onSuccess?.({
        sessionId: targetSessionId,
        fileRewindFailed,
        transcriptRewindFailed,
        resourceRestoreFailed,
        targetMsg,
        targetIdx,
        messagesBeforeRollback: messages,
      })
      log.info(`${config.label} completed`)
    } catch (error) {
      log.error(`${config.label} failed:`, error)

      // shadow-git `restoreSafe` 已移除。per-file rewind 失败**不会**走到这里
      // （上方已 fail-visible + 保留对话回退），此 catch 仅处理后端回退 / 收尾异常。
      if (backendRolledBack && config.isEditResend) {
        // 编辑重发已可能完成文件/资源恢复。此时 unrevert 只能恢复对话投影，
        // 会把旧消息复活却留下已回退的工作现场。因此保留权威回退结果、
        // 回填草稿并停止自动发送。
        try {
          config.onFailureAfterRollback?.(targetSessionId)
        } catch (prefillError) {
          log.warn(`${config.label}: failed to preserve blocked edit draft`, prefillError)
        }
        toast({
          title: i18n.t('chat:checkpoint.editResendPausedAfterRollbackError', {
            defaultValue: '对话已回退，但收尾时发生异常；编辑内容已保留，请确认后手动发送',
          }),
          variant: 'destructive',
        })
      } else if (backendRolledBack) {
        let unrevertFailed = false
        try {
          await chatExtraApi.unrevertSession(targetSessionId)
        } catch (unrevertErr) {
          unrevertFailed = true
          log.error(`${config.label}: Failed to unrevert backend:`, unrevertErr)
        }
        toast({
          title: unrevertFailed
            ? i18n.t('chat:checkpoint.rollbackInconsistent', {
                defaultValue: '回退操作异常，对话和文件状态可能不一致，请刷新页面确认',
              })
            : i18n.t('chat:checkpoint.restoreFileFailedBackendReverted', {
                defaultValue: '文件恢复失败，对话状态已自动还原',
              }),
          variant: 'destructive',
        })
      } else {
        toast({ title: i18n.t(config.failToastKey, { defaultValue: config.failToastDefault }), variant: 'destructive' })
      }

      if (backendRolledBack) {
        try {
          await syncMessagesFromServer(targetSessionId)
        } catch (syncErr) {
          log.warn(`${config.label}: session sync failed`, syncErr)
        }
      }
      set({ restoringSessionId: null, restoringPhase: null })
    }
  }

  async function doRestoreAndEdit(
    messageId: string,
    newContent: string,
    attachments?: ChatAttachment[],
    contextBlocks?: Array<Record<string, unknown>>,
    resourceRestorePlan?: chatExtraApi.ResourceRestoreInfo[],
    sessionId?: string,
    rollbackReason?: string,
    approvedUnavailableFileReason?: string,
    recoveryPlan?: RecoveryPlanContract,
  ): Promise<void> {
    await executeRollbackPipeline({
      messageId,
      sessionId,
      label: 'restoreAndEdit',
      resolveAnchorId: ({ messages, targetIdx }) => resolveRewindAnchorId(messages, targetIdx),
      // 编辑并重发：移除被编辑的 user 消息及其后（重发新内容），文件回到该消息之前。
      keepCount: ({ targetIdx }) => targetIdx,
      // ：编辑重发回退后立即发新消息、即刻接受回退（revert 态被清、被回退消息
      // 物理清理），永进不了可 unrevert 态，safety 快照建了也永不被消费——跳过创建。
      createSafetySnapshot: false,
      // ：编辑重发的回退态不弹「已回退到历史版本 / 恢复原状」横幅。
      isEditResend: true,
      onFailureAfterRollback: (rolledBackSessionId) => {
        prefillComposerAfterBlockedSend(
          rolledBackSessionId,
          newContent,
          attachments,
          contextBlocks,
        )
      },
      resourceRestorePlan,
      rollbackReason,
      approvedUnavailableFileReason,
      recoveryPlan,
      onSuccess: async ({
        sessionId: rolledBackSessionId,
        fileRewindFailed,
        transcriptRewindFailed,
        resourceRestoreFailed,
      }) => {
        if (fileRewindFailed || transcriptRewindFailed || resourceRestoreFailed) {
          // fail-visible：任一已选择恢复层没到位时刹车，绝不让新一轮 Agent 基于
          // 不一致的工作现场继续跑。对话回退已保留；把待发送内容回填 composer，
          // 用户检查文件/资源后无需重新编辑即可手动发送。
          log.warn(`restoreAndEdit: rollback precondition failed, paused auto-send for ${rolledBackSessionId}`, {
            fileRewindFailed,
            transcriptRewindFailed,
            resourceRestoreFailed,
          })
          prefillComposerAfterBlockedSend(
            rolledBackSessionId,
            newContent,
            attachments,
            contextBlocks,
          )
          toast({
            title: transcriptRewindFailed
              ? i18n.t('chat:checkpoint.editResendPausedTranscriptRewindFailed', {
                  defaultValue: '对话上下文未能完整回退，已暂停自动发送，请重试后再发送',
                })
              : fileRewindFailed
                ? i18n.t('chat:checkpoint.editResendPausedFileRewindFailed', {
                    defaultValue: '文件未能完整回退，已暂停自动发送，请检查工作区后手动发送',
                  })
                : i18n.t('chat:checkpoint.editResendPausedResourceRestoreFailed', {
                    defaultValue: '资源未能完整恢复，已暂停自动发送；编辑内容已保留',
                  }),
            variant: 'warning',
          })
          return
        }
        let submission: Awaited<ReturnType<NonNullable<CheckpointDeps['resendAfterRestore']>>>
        try {
          submission = resendAfterRestore
            ? await resendAfterRestore(newContent, attachments, contextBlocks, rolledBackSessionId)
            : { accepted: false, persisted: false, reason: 'send_port_unavailable' }
        } catch (error) {
          submission = {
            accepted: false,
            persisted: false,
            reason: error instanceof Error ? error.message : String(error),
          }
        }
        if (!submission.accepted && !submission.persisted) {
          // 对话回退已经成为权威时间线，发送拒绝不是“回退失败”，不能抛给外层
          // catch 触发 unrevert。停在已回退状态并完整回填草稿，让用户可直接重试。
          log.warn('restoreAndEdit: resend was not accepted; keeping rollback and draft', {
            sessionId: rolledBackSessionId,
            reason: submission.reason,
          })
          prefillComposerAfterBlockedSend(
            rolledBackSessionId,
            newContent,
            attachments,
            contextBlocks,
          )
          toast({
            title: i18n.t('chat:checkpoint.editResendPausedSendRejected', {
              defaultValue: '对话已回退，但编辑内容未能发送；草稿已保留，请重试',
            }),
            variant: 'warning',
          })
        }
      },
      failToastKey: 'chat:checkpoint.restoreFailed',
      failToastDefault: '恢复失败，请稍后重试',
    })
  }

  async function doRollbackToCheckpoint(
    messageId: string,
    resourceRestorePlan?: chatExtraApi.ResourceRestoreInfo[],
    rollbackReason?: string,
    sessionId?: string,
    recoveryPlan?: RecoveryPlanContract,
  ): Promise<void> {
    await executeRollbackPipeline({
      messageId,
      sessionId,
      label: 'rollbackToCheckpoint',
      resolveAnchorId: ({ messages, targetIdx }) => resolveRewindAnchorId(messages, targetIdx),
      // 「回退到此位置」：assistant 目标**保留**这条回复本身、仅移除其后（对齐
      // tooltip「移除之后的消息」+ 后端 _build_revert_visible_message_filter 的
      // assistant id__lte 可见边界 + _compute_rollback_preview id__gt）；user 目标
      // 移除该 user 及其后。#4528 姊妹缺陷：曾用 targetIdx（剔除 assistant 目标）。
      keepCount: ({ targetMsg, targetIdx }) => targetMsg.role === 'assistant' ? targetIdx + 1 : targetIdx,
      resourceRestorePlan,
      rollbackReason,
      recoveryPlan,
      onSuccess: async ({ sessionId: rolledBackSessionId, targetMsg, targetIdx, messagesBeforeRollback }) => {
        if (targetMsg.role !== 'assistant') return
        for (let i = targetIdx - 1; i >= 0; i -= 1) {
          const m = messagesBeforeRollback[i]
          // ：预填只认真人用户轮，禁止把 push-notification 文案填进输入框
          if (!isRegularUserMessage(m) || isContextInjectionMessage(m)) continue
          const prefill = buildRollbackPrefill(m)
          const hasContent = typeof prefill === 'string'
            ? !!prefill
            : !!prefill.message || (prefill.contextBlocks?.length ?? 0) > 0 || (prefill.attachments?.length ?? 0) > 0
          if (hasContent) useChatRuntimeStore.getState().setPrefillForSession(rolledBackSessionId, prefill)
          break
        }
      },
      failToastKey: 'chat:checkpoint.rollbackFailed',
      failToastDefault: '回退失败，请稍后重试',
    })
  }

  async function doRollbackAgentRun(agentRunId: string): Promise<void> {
    const targetSessionId = get().currentSessionId
    if (targetSessionId && isSessionBusy(targetSessionId)) {
      await cancelActiveRunBestEffort(targetSessionId)
    }
    try {
      const result = await chatExtraApi.rollbackAgentRun(agentRunId)

      if (result.all_skipped) {
        toast({
          title: i18n.t('chat:checkpoint.agentRunNoChanges', {
            defaultValue: '此次 AI 操作无可回滚的资源变更',
          }),
        })
        return
      }

      const restoredTypes = result.rollback_results
        .filter(r => r.status === 'restored')
        .map(r => r.resource_type)
      handleCollabPostRestore('rollbackAgentRun', result.collab_sync_warnings, [...new Set(restoredTypes)])

      const cascadedRunCount = result.cascaded_run_count ?? 0
      toast({
        title: i18n.t('chat:checkpoint.agentRunRollbackSuccess', {
          defaultValue: 'AI 操作已回滚',
        }),
        ...(cascadedRunCount > 0 && {
          description: i18n.t('chat:checkpoint.agentRunRollbackCascadeHint', {
            count: cascadedRunCount,
            defaultValue: '包含 {{count}} 个子 Agent 的变更',
          }),
        }),
      })
    } catch (error) {
      log.error('rollbackAgentRun failed:', error)
      const reason = error instanceof Error ? error.message : String(error)
      toast({
        title: i18n.t('chat:checkpoint.agentRunRollbackFailed', {
          reason,
          defaultValue: '撤销这次 AI 操作未完成：{{reason}}',
        }),
        variant: 'destructive',
      })
    }
  }

  const actions = {

    retryFailedResourceRestore: (sessionId?: string | null) => enqueue(sessionId ?? get().currentSessionId ?? '', async () => {
      const { currentSessionId, resourceRetryCountBySessionId, sessions } = get()
      const effectiveSessionId = sessionId ?? currentSessionId
      if (!effectiveSessionId) return
      const rollbackState = sessions.find((session: ChatSession) => session.id === effectiveSessionId)?.rollback_state ?? null
      const retryableItems = extractRetryableResourceRestoreItemsFromRollbackState(rollbackState)
      if (retryableItems.length === 0) return

      const retryCount = resourceRetryCountBySessionId[effectiveSessionId] ?? 0
      if (retryCount >= RESOURCE_RESTORE_MAX_RETRIES) {
        toast({
          title: i18n.t('chat:checkpoint.retryRestoreMaxReached', {
            defaultValue: '已达最大重试次数，请到各模块的版本历史中手动恢复',
          }),
        })
        resetResourceRetryCount(effectiveSessionId)
        return
      }

      try {
        const result = await chatExtraApi.restoreResources(effectiveSessionId, retryableItems)
        if (result.rollback_state) {
          get().updateSessionInCaches(effectiveSessionId, {
            rollback_state: result.rollback_state,
            revert_snapshot_hash: result.rollback_state.safety_snapshot_ref ?? null,
          })
        }
        if (result.failed_count === 0) {
          resetResourceRetryCount(effectiveSessionId)
          toast({ title: i18n.t('chat:checkpoint.retryRestoreSuccess', { defaultValue: '资源恢复重试成功' }) })
        } else {
          set(state => ({
            resourceRetryCountBySessionId: {
              ...state.resourceRetryCountBySessionId,
              [effectiveSessionId]: retryCount + 1,
            },
          }))
          toast({
            title: i18n.t('chat:checkpoint.retryRestorePartial', {
              restored: result.restored_count,
              failed: result.failed_count,
              defaultValue: '{{restored}} 个恢复成功，仍有 {{failed}} 个失败',
            }),
          })
        }
      } catch (err) {
        log.warn('retryFailedResourceRestore failed:', err)
        set(state => ({
          resourceRetryCountBySessionId: {
            ...state.resourceRetryCountBySessionId,
            [effectiveSessionId]: retryCount + 1,
          },
        }))
        toast({ title: i18n.t('chat:checkpoint.retryRestoreFailed', { defaultValue: '资源恢复重试失败，请稍后再试' }) })
      }
    }),

    rollbackAgentRun: (agentRunId: string) => enqueue(get().currentSessionId || FALLBACK_QUEUE_KEY, () => doRollbackAgentRun(agentRunId)),

    createManualCheckpoint: (sessionId?: string | null) => enqueue(sessionId ?? get().currentSessionId ?? FALLBACK_QUEUE_KEY, async () => {
      const effectiveSessionId = sessionId ?? get().currentSessionId
      if (!effectiveSessionId) {
        toast({
          title: i18n.t('chat:checkpoint.manualNoSession', { defaultValue: '请先选择一个会话' }),
          variant: 'destructive',
        })
        return
      }

      const session = get().sessions.find(s => s.id === effectiveSessionId)
      const selectedSpace = useSpaceStore.getState().selectedSpace
      const spaceId = resolveSessionScopeId(session) ?? selectedSpace?.id
      if (!spaceId) {
        toast({
          title: i18n.t('chat:checkpoint.manualNoSpace', { defaultValue: '无法确定当前 Workspace，无法创建快照' }),
          variant: 'destructive',
        })
        return
      }

      const manualAnchorId = `manual:${effectiveSessionId}:${Date.now()}`
      let commitHash = ''

      try {
        const isAvail = checkpointIpc.isAvailable()
        const spacePath = isAvail ? await resolveSpacePath(effectiveSessionId) : null

        if (spacePath) {
          try {
            const result = await checkpointIpc.commit(spacePath, {
              kind: 'manual',
              trigger: 'manual',
              allowEmpty: true,
              visibleInHistory: true,
              anchor: manualAnchorId,
            })
            commitHash = result.commitHash ?? ''
            if (commitHash) {
              emitCheckpointCreated({
                spacePath,
                commitHash,
                spaceId,
                sessionId: effectiveSessionId,
                messageId: manualAnchorId,
              })
            }
          } catch (err) {
            log.warn('createManualCheckpoint: file commit failed (continuing with resource snapshot)', err)
          }
        }

        let diffSummary: chatExtraApi.CheckpointDiffSummary | undefined
        if (commitHash && spacePath) {
          try {
            const diffResult = await checkpointIpc.diffSummary(spacePath, commitHash)
            diffSummary = {
              ...diffResult.summary,
              files: diffResult.files,
            }
          } catch (err) {
            log.warn('createManualCheckpoint: diff summary failed (non-blocking)', err)
          }
        }

        const created = await chatExtraApi.createSpaceCheckpoint({
          spaceId,
          fileCheckpointHash: commitHash,
          trigger: 'manual',
          anchorSessionId: effectiveSessionId,
          checkpointPolicy: {
            kind: 'manual',
            trigger: 'manual',
            allowEmpty: true,
            visibleInHistory: true,
            anchor: manualAnchorId,
          },
          diffSummary,
        })

        if (!created) {
          toast({
            title: i18n.t('chat:checkpoint.manualCreateFailed', { defaultValue: '快照保存失败，请稍后重试' }),
            variant: 'destructive',
          })
          return
        }

        toast({
          title: i18n.t('chat:checkpoint.manualCreateSuccess', { defaultValue: '快照已保存' }),
          variant: 'success',
        })
        log.info('Manual SpaceCheckpoint created:', created.id, 'space:', spaceId)
      } catch (error) {
        log.error('createManualCheckpoint failed:', error)
        toast({
          title: i18n.t('chat:checkpoint.manualCreateFailed', { defaultValue: '快照保存失败，请稍后重试' }),
          variant: 'destructive',
        })
      }
    }),

    createCheckpoint: (sessionId: string, messageId: string, stateHint?: number, meta?: { spaceId?: string; agentRunId?: string; baselineHash?: string; kind?: 'agent_turn_done' | 'error_compensation' | 'manual' }) => enqueue(sessionId, async () => {
      try {
        const isAvail = checkpointIpc.isAvailable()
        if (!isAvail) {
          log.warn('createCheckpoint: checkpoint bridge unavailable, skipping', {
            sessionId: sessionId.slice(0, 8),
            messageId: messageId.slice(0, 8),
          })
          return
        }
        const spacePath = await resolveSpacePath(sessionId)

        if (!spacePath) {
          log.warn('createCheckpoint: Unable to resolve Space path, skipping', {
            sessionId: sessionId.slice(0, 8),
          })
          return
        }

        const checkpointKind = meta?.kind ?? 'agent_turn_done'
        let commitHash: string
        try {
          const result = await checkpointIpc.commit(spacePath, {
            kind: checkpointKind,
            trigger: checkpointKind,
            allowEmpty: false,
            visibleInHistory: true,
            anchor: messageId,
          })
          if (!result.commitHash) {
            log.info('createCheckpoint: no file changes, skipping checkpoint commit')
            return
          }
          commitHash = result.commitHash
        } catch (err) {
          log.warn('createCheckpoint: commit failed', err)
          recordCheckpointFailure(sessionId)
          return
        }

        log.info('Checkpoint created:', commitHash, 'for message:', messageId)
        emitCheckpointCreated({
          spacePath,
          commitHash,
          spaceId: meta?.spaceId,
          sessionId,
          messageId,
        })

        const sid = sessionId
        if (!sid) return

        let diffSummary: chatExtraApi.CheckpointDiffSummary | undefined
        try {
          // diff_summary 继续服务历史消息 / Changes 快照；当前 Review Card 改用编辑账本。
          // 有 baseline 时即使 changed===0 也绝不能回退 vs parent——否则会把轮前 Space
          // 累计脏文件（被 shadow-git 扫进本 commit）误标成「本轮 Agent 改动」。
          // 无 baseline（writeTree 失败）时才退回 parent..commit，供版本详情兜底。
          const diffResult = await checkpointIpc.diffSummary(
            spacePath,
            commitHash,
            meta?.baselineHash,
          )
          diffSummary = {
            ...diffResult.summary,
            files: diffResult.files,
          }
          log.info('Checkpoint diff summary:', diffSummary.changed, 'files,',
            '+' + diffSummary.insertions, '-' + diffSummary.deletions,
            meta?.baselineHash ? `(baseline: ${meta.baselineHash.slice(0, 8)})` : '(vs parent)')
        } catch (err) {
          // Non-blocking：diff summary 用于 UI 展示文件变更统计，失败时静默——
          // checkpoint 本身已经创建成功，summary 缺失不影响回退能力。
          log.warn('Failed to get checkpoint diff summary (non-blocking):', err)
        }

        // ：本地立即回填 diff_summary，Changes「最近 Agent 修改」不必等 server reconcile
        const localDiffSummary = diffSummary
          ? {
              changed: diffSummary.changed,
              insertions: diffSummary.insertions,
              deletions: diffSummary.deletions,
              files: (diffSummary.files ?? []).map((file) => ({
                file: file.file,
                changes: file.insertions + file.deletions,
                insertions: file.insertions,
                deletions: file.deletions,
                binary: file.binary,
                ...(file.status ? { status: file.status } : {}),
              })),
            }
          : undefined

        set(state => {
          const prev = state.checkpointsBySessionId[sid] ?? {}
          return {
            messagesBySessionId: {
              ...state.messagesBySessionId,
              [sid]: (state.messagesBySessionId[sid] ?? []).map(message => (
                message.id === messageId
                  ? {
                      ...message,
                      checkpoint_hash: commitHash,
                      ...(localDiffSummary ? { diff_summary: localDiffSummary } : {}),
                    }
                  : message
              )),
            },
            checkpointsBySessionId: {
              ...state.checkpointsBySessionId,
              [sid]: { ...prev, [messageId]: commitHash },
            },
          }
        })

        let checkpointPersisted = false
        for (let attempt = 0; attempt < CHECKPOINT_PERSIST_MAX_ATTEMPTS; attempt++) {
          try {
            await chatExtraApi.persistCheckpointHash(messageId, commitHash, stateHint, diffSummary)
            checkpointPersisted = true
            break
          } catch (err) {
            if (attempt === CHECKPOINT_PERSIST_MAX_ATTEMPTS - 1) {
              log.error(`Failed to persist checkpoint hash after ${CHECKPOINT_PERSIST_MAX_ATTEMPTS} attempts:`, err)
              recordCheckpointFailure(sid)
            } else {
              log.warn(`persistCheckpointHash attempt ${attempt + 1} failed, retrying...`, err)
              const retryDelay = checkpointPersistRetryDelayMs(attempt)
              if (retryDelay > 0) {
                await new Promise(r => setTimeout(r, retryDelay))
              }
            }
          }
        }
        if (!checkpointPersisted) return

        set(state => {
          const { [sid]: _, ...restFailCounts } = state.checkpointFailCountBySessionId
          const { [sid]: __, ...restHealth } = state.checkpointHealthBySessionId
          return {
            checkpointFailCountBySessionId: restFailCounts,
            checkpointHealthBySessionId: restHealth,
          }
        })

        if (meta?.spaceId) {
          try {
            const checkpointMessage = get().messagesBySessionId[sessionId]?.find(
              message => message.id === messageId,
            )
            const agentRunId = meta.agentRunId || checkpointMessage?.agent_run_id || undefined

            // QC-08：同时把 diffSummary 传给后端 SpaceCheckpoint 创建路径，
            // 使 `insertions + deletions >= 30` 触发条件与 Daemon 路径一致，
            // LLM 增强摘要能在 Electron 驱动的 checkpoint 上也被生成。
            await chatExtraApi.createSpaceCheckpoint({
              spaceId: meta.spaceId,
              fileCheckpointHash: commitHash,
              agentRunId,
              trigger: checkpointKind,
              anchorSessionId: sessionId,
              anchorMessageId: messageId,
              checkpointPolicy: {
                kind: checkpointKind,
                trigger: checkpointKind,
                allowEmpty: false,
                visibleInHistory: true,
                anchor: messageId,
                baselineHash: meta?.baselineHash,
              },
              diffSummary,
            })
            log.info('SpaceCheckpoint created for space:', meta.spaceId)
          } catch (err) {
            log.warn('SpaceCheckpoint creation failed (non-blocking):', err)
          }
        }
      } catch (error) {
        log.error('createCheckpoint failed:', error)
      }
    }),

    restoreAndEdit: (messageId: string, newContent: string, attachments?: ChatAttachment[], contextBlocks?: Array<Record<string, unknown>>, sessionId?: string) =>
      enqueue(sessionId ?? get().currentSessionId ?? '', () => doRestoreAndEdit(messageId, newContent, attachments, contextBlocks, undefined, sessionId)),

    rollbackToCheckpoint: (
      messageId: string,
      sessionId?: string,
      resourceRestorePlan?: chatExtraApi.ResourceRestoreInfo[],
    ) =>
      enqueue(sessionId ?? get().currentSessionId ?? '', () => doRollbackToCheckpoint(messageId, resourceRestorePlan, undefined, sessionId)),

    unrevertSession: (sessionId?: string | null) => enqueue(sessionId ?? get().currentSessionId ?? '', async () => {
      const { currentSessionId, sessions } = get()
      const effectiveSessionId = sessionId ?? currentSessionId
      if (!effectiveSessionId) return
      const rollbackState = sessions.find((session: ChatSession) => session.id === effectiveSessionId)?.rollback_state ?? null
      const isReverted = !!rollbackState?.revert_active
      if (!isReverted || rollbackState?.can_unrevert === false) return

      // 预缓存当前回退涉及的资源类型：unrevert API 成功后 resource_restore_state 可能被后端清空
      const preUnrevertResourceTypes = (rollbackState?.resource_restore_state ?? [])
        .map((r: Record<string, unknown>) => typeof r.resource_type === 'string' ? r.resource_type : null)
        .filter((v): v is string => v !== null)

      if (isSessionBusy(effectiveSessionId)) {
        const { cancelCompleted } = await get().abortStreamAndWait(STREAM_ABORT_TIMEOUT_MS, effectiveSessionId)
        if (!cancelCompleted) {
          toast({ title: i18n.t('chat:checkpoint.abortNotCompleted', { defaultValue: 'Agent 仍在运行，请等待完成后重试' }) })
          return
        }
      }

      try {
        set({ restoringSessionId: effectiveSessionId, restoringPhase: 'preparing' })

        // ：本地 per-file safety 快照还原 + 对话 unrevert。
        // bugbot 评审  high：必须**先**调后端 unrevertSession API 成功、**再**还原
        // 本地文件——否则 API 失败时对话仍在回退态、文件却已回到回退前，永久不一致。
        // 顺序：unrevert API（对话恢复）→ 成功后 per-file rewind（文件恢复）。
        const safetyRef = rollbackState?.safety_snapshot_ref
          ?? sessions.find(s => s.id === effectiveSessionId)?.revert_snapshot_hash
          ?? null

        set({ restoringPhase: 'finalizing' })
        const result = await chatExtraApi.unrevertSession(effectiveSessionId)
        // ：Django unrevert 成功即广播 UNREVERT（含本端）。本机是发起端且下方
        // 自带权威 syncMessagesFromServer，回流广播的整页重拉跳过。
        getSessionMessagesFacade(effectiveSessionId).expectSelfRollbackBroadcast()
        if (result.rollback_state) {
          get().updateSessionInCaches(effectiveSessionId, {
            rollback_state: result.rollback_state,
            revert_snapshot_hash: result.rollback_state.safety_snapshot_ref ?? null,
          })
        }

        // API 成功后再还原本地文件（safety: 前缀是 Electron 本地宿主的 per-file 锚点；
        // 非 safety: 前缀是 Daemon shadow-git，由后端处理、前端不碰）。
        let localFileRestoreOk: boolean | null = null
        if (isPerFileSafetyAnchor(safetyRef) && fileHistoryIpc.isAvailable()) {
          set({ restoringPhase: 'files' })
          try {
            const rewindResult = await fileHistoryIpc.rewind(effectiveSessionId, safetyRef)
            localFileRestoreOk = rewindResult.failedFiles.length === 0
            if (rewindResult.failedFiles.length > 0) {
              toast({
                title: i18n.t('chat:checkpoint.unrevertFilesPartialFailed', {
                  count: rewindResult.failedFiles.length,
                  defaultValue: '撤销回退时 {{count}} 个文件未能还原，请手动检查工作区',
                }),
                variant: 'warning',
              })
            }
            log.info('unrevertSession: per-file safety rewind', rewindResult)
          } catch (err) {
            localFileRestoreOk = false
            log.warn('unrevertSession: per-file safety rewind failed', err)
            toast({
              title: i18n.t('chat:checkpoint.unrevertFilesFailed', {
                defaultValue: '撤销回退时工作区文件未能自动还原，请手动检查',
              }),
              variant: 'warning',
            })
          }
        }

        //  本地宿主：移除本机 transcript 的 rewind 软标记（daemon 宿主由后端
        // session_transcript_unrevert 下发处理）。通道在 hub；无本机
        // bridge / 调用失败均仅告警，不阻塞 unrevert 主流程。
        try {
          await getSessionController(effectiveSessionId).unrevertTranscript()
        } catch (err) {
          log.warn('unrevertSession: local transcript unrevert failed (or no runtime bridge)', err)
        }

        // 文件层：本地 per-file safety 还原优先；否则据后端（Daemon shadow-git）报告。
        const fileRestoreOk = localFileRestoreOk !== null
          ? localFileRestoreOk
          : result.file_restore_success === true

        await syncMessagesFromServer(effectiveSessionId)

        const hasResourceFailures = (result.partial_success_details?.resources?.failed_count ?? 0) > 0
        const unrevertSummary = {
          id: `unrevert-summary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'system' as const,
          content: hasResourceFailures
            ? i18n.t('chat:checkpoint.unrevertResourcePartial', { defaultValue: '已恢复部分内容，但仍有资源未恢复到回退前状态' })
            : fileRestoreOk
              ? i18n.t('chat:checkpoint.unrevertComplete', { defaultValue: '已恢复到回退前的状态' })
              : i18n.t('chat:checkpoint.unrevertPartial', { defaultValue: '已恢复对话到回退前；工作区文件未自动还原，如需请手动检查' }),
          created_at: new Date().toISOString(),
        } as ChatMessage
        get().injectSystemMessage(effectiveSessionId, unrevertSummary)

        resetResourceRetryCount(effectiveSessionId)

        clearSessionCache(effectiveSessionId)

        // 使用预缓存的资源类型分发 collab 事件（API 返回后 resource_restore_state 可能已被清空）
        if (preUnrevertResourceTypes.length > 0) {
          handleCollabPostRestore(
            'unrevertSession',
            result.partial_success_details?.resources?.collab_sync_warnings ?? null,
            [...new Set(preUnrevertResourceTypes)],
          )
        }

        toast({
          title: hasResourceFailures
            ? i18n.t('chat:checkpoint.unrevertResourcePartialToast', { defaultValue: '已恢复部分内容，仍有资源需要处理' })
            : i18n.t('chat:checkpoint.unrevertSuccess', { defaultValue: '已撤销回退，对话已恢复' }),
          variant: hasResourceFailures ? 'destructive' : 'success',
        })
        log.info('Unrevert completed, messages restored')
      } catch (error) {
        log.error('unrevertSession failed:', error)
        // 此处 catch 覆盖整个 unrevert 主流程失败；本地文件 rewind 的局部失败已在
        // 上方 fail-visible toast，不会把对话成功改成这里的 destructive。
        toast({ title: i18n.t('chat:checkpoint.unrevertFailed', { defaultValue: '撤销回退失败，请稍后重试' }), variant: 'destructive' })
      } finally {
        set({ restoringSessionId: null, restoringPhase: null })
      }
    }),

    getCheckpointDiff: async (checkpointHash: string, sessionId?: string | null) => {
      if (!checkpointIpc.isAvailable()) return []
      try {
        const spacePath = await resolveSpacePath(sessionId)
        if (!spacePath) return []
        const { diffs } = await checkpointIpc.diff(spacePath, checkpointHash)
        return diffs.map((d) => {
          const hasBefore = d.before && d.before.length > 0
          const hasAfter = d.after && d.after.length > 0
          let status: 'added' | 'modified' | 'deleted' = 'modified'
          if (!hasBefore && hasAfter) status = 'added'
          else if (hasBefore && !hasAfter) status = 'deleted'
          return { path: d.relativePath, status, before: d.before, after: d.after }
        })
      } catch (err) {
        log.warn('getCheckpointDiff failed:', err)
        return []
      }
    },

    requestRewindPreview: (
      sessionId: string | null,
      targetMessageId: string,
      mode: 'rollback' | 'editAndResend',
      editContent?: string,
      editAttachments?: ChatAttachment[],
      editContextBlocks?: Array<Record<string, unknown>>,
      resendIntent?: 'edit' | 'resend',
    ) => {
      const effectiveSessionId = sessionId || get().currentSessionId
      if (!effectiveSessionId) return
      //  / ：失败的 Project Task 会话禁止「确认并重新发送」，引导任务页重跑。
      if (mode === 'editAndResend' && isProjectTaskEditAndResendBlocked(effectiveSessionId)) {
        toast({
          title: i18n.t('chat:projectTask.runRequiredTitle', {
            defaultValue: '请从任务详情重新运行',
          }),
          description: i18n.t('chat:projectTask.runRequiredHint', {
            defaultValue: PROJECT_TASK_RUN_REQUIRED_MESSAGE,
          }),
          variant: 'destructive',
        })
        return
      }
      set({
        rewindPreview: {
          sessionId: effectiveSessionId,
          targetMessageId,
          mode,
          resendIntent,
          editContent,
          editAttachments,
          editContextBlocks,
        },
      })
    },

    cancelRewindPreview: () => {
      set({ rewindPreview: null })
    },

    /**
     *  self-heal：回退 preview/apply 命中 404「目标消息不存在」时调用。
     *
     * 该 404 必然意味着本地消息列表已与服务端不同步——被回退的消息要么从未落库
     * （流式中途 abort/error，后端事务未提交），要么已被前一次软回滚的物理清理删除。
     * 强制从服务端重拉消息并重建 checkpoint 映射，使陈旧消息（及其回退按钮）消失，
     * 把「点了报错的死胡同」变成「自动刷新到最新状态」。
     *
     * 纯本地状态自愈，不改回滚语义；失败 fail-soft 不阻塞调用方。
     */
    resyncMessagesAfterMissingTarget: async (sessionId: string | null) => {
      const effectiveSessionId = sessionId || get().currentSessionId
      if (!effectiveSessionId) return
      try {
        await syncMessagesFromServer(effectiveSessionId)
      } catch (err) {
        log.warn('resyncMessagesAfterMissingTarget failed (non-blocking):', err)
      }
    },

    confirmRewindPreview: (confirmation: RecoveryPlanConfirmation) => enqueue(get().rewindPreview?.sessionId ?? get().currentSessionId ?? '', async () => {
      const { rewindPreview, currentSessionId } = get()
      if (!rewindPreview) return

      if (rewindPreview.mode === 'editAndResend') {
        const { resolveProjectTaskChatSendGate } = await import(
          '../../messages/product/delivery/projectTaskSendGate'
        )
        const gate = await resolveProjectTaskChatSendGate(rewindPreview.sessionId)
        if (gate) {
          set({ rewindPreview: null })
          toast({
            title: i18n.t('chat:projectTask.runRequiredTitle', {
              defaultValue: '请从任务详情重新运行',
            }),
            description: i18n.t('chat:projectTask.runRequiredHint', {
              defaultValue: gate.errorMessage,
            }),
            variant: 'destructive',
          })
          return
        }
      }

      set({ rewindPreview: null })

      if (rewindPreview.sessionId !== currentSessionId) {
        log.info('confirmRewindPreview: operating on split-pane session', rewindPreview.sessionId, '(current:', currentSessionId, ')')
      }

      const plan = confirmation.resourceRestorePlan ?? rewindPreview.resourceRestorePlan

      if (rewindPreview.mode === 'rollback') {
        await doRollbackToCheckpoint(
          rewindPreview.targetMessageId,
          plan,
          confirmation.rollbackReason,
          rewindPreview.sessionId,
          confirmation.contract,
        )
      } else {
        const content = (rewindPreview.editContent || '').trim()
        if (!content) {
          toast({ title: i18n.t('chat:checkpoint.editContentEmpty', { defaultValue: '消息内容不能为空' }) })
          return
        }
        await doRestoreAndEdit(
          rewindPreview.targetMessageId,
          content,
          rewindPreview.editAttachments,
          rewindPreview.editContextBlocks,
          plan,
          rewindPreview.sessionId,
          confirmation.rollbackReason,
          confirmation.approvedUnavailableFileReason,
          confirmation.contract,
        )
      }
    }),

    /**
     * Daemon checkpoint 失败时由 WS 事件处理器调用，累计 failCount。
     * per-file 迁移期（P2-1）：不再写 checkpointHealth，故不弹 warning/error/toast——
     * shadow-git checkpoint 失败不影响 per-file 回退能力，失败仅计数供调试。
     */
    reportCheckpointFailure: (sessionId: string) => {
      recordCheckpointFailure(sessionId)
      log.warn('Daemon checkpoint failure reported, consecutive failures:', get().checkpointFailCountBySessionId[sessionId] || 0)
    },

    /**
     * Daemon checkpoint 成功时由 WS 事件处理器调用，清零 failCount 并恢复 healthy 状态。
     */
    reportCheckpointSuccess: (sessionId: string) => {
      const prevFailCount = get().checkpointFailCountBySessionId[sessionId] || 0
      if (prevFailCount === 0) return
      const nextFailCount = Math.max(0, prevFailCount - 1)
      // P2-1：与 recordCheckpointFailure 对称，**不再写 checkpointHealth**（迁移期
      // shadow-git 健康度不驱动 UI，避免「回退功能暂不可用」warning badge 误弹）。
      // 仅 decay failCount 供调试。
      if (nextFailCount === 0) {
        set(state => {
          const { [sessionId]: _, ...restFailCounts } = state.checkpointFailCountBySessionId
          return { checkpointFailCountBySessionId: restFailCounts }
        })
      } else {
        set(state => ({
          checkpointFailCountBySessionId: { ...state.checkpointFailCountBySessionId, [sessionId]: nextFailCount },
        }))
      }
      log.info('Daemon checkpoint success, failCount decayed from', prevFailCount, 'to', nextFailCount)
    },

    /**
     * Crash recovery reconciliation: if the server marks the session as reverted
     * but local state was never updated (e.g. Electron crashed mid-rollback),
     * sync messages from server to realign. Runs at most once per session per
     * app lifecycle via `reconciledSessionIds`.
     *
     * @returns `true` if an async sync was initiated (caller should skip its
     *          own background sync to avoid a limit-50-vs-500 race).
     */
    reconcileSessionState: (sessionId: string): boolean => {
      if (reconciledSessionIds.has(sessionId)) return false
      reconciledSessionIds.add(sessionId)

      const { sessions } = get()
      const session = sessions.find((s: ChatSession) => s.id === sessionId)
      if (!session) {
        reconciledSessionIds.delete(sessionId)
        return false
      }

      const serverReverted = !!session.rollback_state?.revert_active
      if (!serverReverted) return false

      log.info('reconcileSessionState: server marks session as reverted, syncing messages', sessionId)
      syncMessagesFromServer(sessionId)
        .then(msgs => { cacheMessages(sessionId, msgs) })
        .catch(err => {
          log.warn('reconcileSessionState: sync failed, will retry on next select', err)
          reconciledSessionIds.delete(sessionId)
        })

      return true
    },
  }

  // ：把带 enqueue 串行化的回退 actions 注册给 hub——SessionController 的
  // rollback / restoreAndEdit / unrevert 门面复用同一份 actions（对外操作入口在
  // hub，编排本体在本 slice，连接通道在 SessionController）。
  rollbackRegistry.register({
    rollbackToCheckpoint: actions.rollbackToCheckpoint,
    restoreAndEdit: actions.restoreAndEdit,
    unrevertSession: actions.unrevertSession,
    rollbackAgentRun: actions.rollbackAgentRun,
  })

  return actions
}
