/**
 * Approval slice — submitApprovalDecision, submitApprovalDecisions,
 * resetSessionApprovals, clearApprovalRequests.
 *
 * v0.4 W1.5（PRD §6.7 / §7.4）：从单工具 review_required 升格为批量 approval_requested。
 *
 * 关键变化（与 v0.3a 对比）：
 *   - 监听事件：`agent.stream.review_required` → `agent.stream.approval_requested`
 *   - 提交通道：`window.tabtin.agentEngine.submitAskUserResponse(requestId, ...)`
 *               → `window.tabtin.agentEngine.submitHitlBatch(batchId, decisions[])`
 *   - 状态字段：`pendingReviewBySessionId` → `pendingApprovalBySessionId`，
 *               `reviewSubmittingBySessionId` → `approvalSubmittingBySessionId`
 *   - state.batchId（替代 interruptId）：runtime 端 LocalPermissionHandler.requestPermissionsBatch
 *               用 batchId 注册 pending；提交时按 batchId 查 resolver。
 *
 * Ask-user 路径（独立语义）保留 `submitAskUserResponse(requestId, ...)`，详见 askUserSlice.ts。
 */

import type { ChatMessage, ChatClient } from '@tabtin/chat-client'
import type {
  ApprovalRequestState,
} from '../../shared/types'
import i18n from '@/i18n'
import { toast } from '@tabtin/smartsheet-ui'
import { isLocalRuntimeAvailable } from '@services/localAgentClient'
import { getSessionController } from '@/services/agentService'
import { isSessionBusy } from '../../execution/sessionRunProjection'
import { isPlatformIpcError, formatIpcErrorForUser } from '@/services/ipc-error'
import { ensureLegacyOk, extractLegacyErrorMessage } from '@/services/legacy-result'
import { useAuthStore } from '@stores/useAuthStore'
import { recordHitlResolvedKey } from '../handlers/hitlStreamHandlers'

/**
 * 审批提交错误的文案分流——保留 W1.5 P0 的"resolver 失效"业务语义。
 * 详见 askUserSlice.ts 的 `formatAskUserSubmitError` 同款决策树注释。
 */
function formatApprovalSubmitError(err: unknown): string {
  const RESOLVER_MISSING_CODES = new Set(['NOT_FOUND', 'RESOLVER_MISSING', 'SOFT_FAIL', 'LEGACY_SHAPE'])
  if (isPlatformIpcError(err) && RESOLVER_MISSING_CODES.has(err.code)) {
    return i18n.t('chat:review.runtimeResolverMissing', {
      defaultValue: '本地 Runtime 未找到待处理的审批请求（可能会话已超时或已被其他窗口处理），请刷新后重试',
    })
  }
  return formatIpcErrorForUser(err, i18n.t('chat:messages.unknownError'))
}

function readErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string') {
    return String((err as { code: string }).code)
  }
  return ''
}

function isAlreadyTerminalApprovalResponseError(err: unknown): boolean {
  const code = readErrorCode(err).toLowerCase()
  return code === 'already_consumed' ||
    code === 'pending_not_found' ||
    code === 'not_found' ||
    code === 'resolver_missing'
}

/**
 * ：WS 转发失败 / delivery ack 超时的错误码集合。
 *
 * main 端 `ElectronAgentHost.handleSubmitHitlBatch` 在本地 resolver miss 后走
 * `forwardUserResponseToBackend` → `electronWsGateway.requestWithLastAuth`。
 * 这条路径上的失败码：
 *   - `HITL_FORWARD_FAILED`：forward 抛错或返回非 ok 的兜底码
 *   - `WS_REQUEST_TIMEOUT`：ws-gateway 10s 内未收到 ack（issue 现象里的 "request timeout"）
 *   - `WS_IDLE_TIMEOUT`：ws 长时间无入流，连接已被判定死
 *   - `MISSING_THREAD_ID`：payload 缺 threadId，根本没法转发
 *   - `DELIVERY_TIMEOUT`： Django 等 runtime 签收超时（幽灵卡 / 设备未签收）
 *
 * 这些场景的共性是「审批决策没法送达 Agent」——pending 留着会让 Composer 一直
 * 停在待确认态（发送只能入队、无法推进本轮）。和 terminal error 的区别只是文案：
 * terminal 是"已被其它设备处理"，forward failure 是"未送达"。
 * 两者都关卡清 pending 恢复输入，重发消息会触发新审批。
 */
function isApprovalForwardFailureError(err: unknown): boolean {
  const code = readErrorCode(err).toLowerCase()
  return code === 'hitl_forward_failed' ||
    code === 'ws_request_timeout' ||
    code === 'ws_idle_timeout' ||
    code === 'missing_thread_id' ||
    code === 'delivery_timeout'
}

function currentApproverIdentity(): { user_id: string; client_info: string; timestamp: number } | undefined {
  const userId = useAuthStore.getState().user?.id
  if (userId === undefined || userId === null || String(userId).trim() === '') return undefined
  return {
    user_id: String(userId),
    client_info: 'Electron renderer',
    timestamp: Date.now(),
  }
}

function ensureApprovalResponseDelivered<T>(raw: T, op: string): asserts raw is Exclude<T, { success: false }> {
  if (raw && typeof raw === 'object' && (raw as { success?: unknown }).success === false) {
    const err = new Error(extractLegacyErrorMessage(raw, `${op} failed`)) as Error & { code?: string }
    const code = (raw as { code?: unknown }).code
    if (typeof code === 'string') err.code = code
    throw err
  }
  ensureLegacyOk(raw, op)
}

// ---------------------------------------------------------------------------
// Deps & Store shape
// ---------------------------------------------------------------------------

export interface ApprovalSliceDeps {
  getChatClient: () => ChatClient
}

export interface ApprovalSliceStore {
  currentSessionId: string | null
  pendingApproval: ApprovalRequestState | null
  isApprovalSubmitting: boolean
  pendingApprovalBySessionId: Record<string, ApprovalRequestState>
  approvalSubmittingBySessionId: Record<string, boolean>
}

type GetFn = () => ApprovalSliceStore
type SetFn = (
  partial:
    | Partial<ApprovalSliceStore>
    | ((state: ApprovalSliceStore) => Partial<ApprovalSliceStore>),
) => void

// ---------------------------------------------------------------------------
// Injected helpers (from parent store closure)
// ---------------------------------------------------------------------------

interface ApprovalSliceHelpers {
  addStreamingSession: (sessionId: string) => void
  updateSessionMessages: (
    sessionId: string | null,
    updater: (prev: ChatMessage[]) => ChatMessage[],
  ) => void
}

// ---------------------------------------------------------------------------
// Per-tool decision schema（与 ApprovalPanel 对接）
// ---------------------------------------------------------------------------

export interface PerToolApprovalDecision {
  request_id?: string
  tool_call_id?: string
  decision: 'approve' | 'reject'
  scope?: 'once' | 'thread' | 'always'
  rejection_message?: string
  pattern_key?: string
  scope_description?: string
  decision_kind?: 'exact' | 'pattern'
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createApprovalActions(
  get: GetFn,
  set: SetFn,
  deps: ApprovalSliceDeps,
  helpers: ApprovalSliceHelpers,
) {
  const { getChatClient } = deps
  const { addStreamingSession, updateSessionMessages } = helpers

  // Wave 11 迁移：Django `/api/orchestration/agent/review` 已下线，Electron 必须走本地
  // Runtime IPC。判定与 sendMessage / askUser 对齐——消除判定漂移。
  const isLocalApprovalIpcAvailable = isLocalRuntimeAvailable

  const getPendingApprovalForSession = (sessionId: string) => (
    get().pendingApprovalBySessionId[sessionId] ?? null
  )

  const setApprovalSubmittingForSession = (sessionId: string, submitting: boolean) => {
    set((state) => {
      const next = { ...state.approvalSubmittingBySessionId }
      if (submitting) {
        next[sessionId] = true
      } else {
        delete next[sessionId]
      }
      return {
        approvalSubmittingBySessionId: next,
      }
    })
  }

  const setApprovalSubmitError = (sessionId: string, error: string | undefined) => {
    set((state) => {
      const prev = state.pendingApprovalBySessionId[sessionId]
      if (!prev) return {}
      return {
        pendingApprovalBySessionId: {
          ...state.pendingApprovalBySessionId,
          [sessionId]: { ...prev, submitError: error },
        },
      }
    })
  }

  const clearApprovalForSession = (sessionId: string) => {
    // ：所有调用点都是「这个 batch 已了结」语义（提交成功 / 已被他端处理 /
    // 送达失败作废 / 用户放弃）——记墓碑，挡住 stream 重放与「消息缓存还停在
    // pending」的派生恢复（reconcileHitlPanelsFromMessages）把面板回开。
    set((state) => {
      recordHitlResolvedKey(sessionId, state.pendingApprovalBySessionId[sessionId]?.batchId)
      const nextPending = { ...state.pendingApprovalBySessionId }
      delete nextPending[sessionId]
      const nextSubmitting = { ...state.approvalSubmittingBySessionId }
      delete nextSubmitting[sessionId]
      return {
        pendingApprovalBySessionId: nextPending,
        approvalSubmittingBySessionId: nextSubmitting,
      }
    })
  }

  /**
   * 清掉 review message 占位的 content——避免审批通过后 chat 流里仍然残留
   * 「⚠️ 需要确认执行以下操作：…」一段提示文本（用户已经看了 ApprovalPanel 做了
   * 决策，那段 inline 文案不再有意义；持续显示几秒会让用户误以为"操作没生效"）。
   *
   * 方案选择：清空 `content` 让 MessageBubble 显示空白 → 等 runtime resume 后
   * 新 ASSISTANT delta 自然累积到 streamingOverride 把内容填回。这段空白窗口
   * 一般 0.5-3 秒，体感比"残留长 prompt 文本"好得多。
   *
   * 反馈语义：
   *   - approve：直接清空（不需要"已确认"文字提示——ApprovalPanel 消失 + toast.success
   *     已经够），让 LLM 后续输出立刻进入主位置
   *   - reject：填一条"已拒绝执行该操作"作为视觉反馈，等 LLM 继续 reasoning 时
   *     被 streamingOverride 覆盖；这样用户能确认自己的拒绝意图被记下
   *
   * **不删整条 message** 的原因：reviewMsgId 是 runtime 复用的 ai message id，
   * runtime resume 后新 delta 仍按这个 id 走 streamingOverride 累积；删了再
   * 重建会跟 runtime 的 message id 协议冲突。
   */
  const resetReviewMessageContent = (
    sessionId: string,
    messageId: string | undefined,
    decision: 'approve' | 'reject',
  ) => {
    if (!messageId) return
    const replacementContent = decision === 'reject'
      ? i18n.t('chat:reviewPrompt.rejectedMessage', { defaultValue: '已拒绝执行该操作。' })
      : ''
    updateSessionMessages(sessionId, (prev) =>
      prev.map((msg) =>
        msg.id === messageId ? { ...msg, content: replacementContent } : msg,
      ),
    )
  }

  const appendUnavailableNotice = (sessionId: string) => {
    updateSessionMessages(sessionId, (prev) => [
      ...prev,
      {
        id: `approval-no-device-${Date.now()}`,
        role: 'assistant',
        content: i18n.t('chat:messages.reviewRequiresDevice', {
          defaultValue: '审批需要本地 Runtime 才能回执。请先在 Agent 设置中绑定一台设备后再试。',
        }),
        created_at: new Date().toISOString(),
      },
    ])
  }

  const handleApprovalSubmitFailure = (sessionId: string, error: unknown) => {
    if (isAlreadyTerminalApprovalResponseError(error)) {
      clearApprovalForSession(sessionId)
      toast.info(i18n.t('chat:askUser.alreadyHandled', {
        defaultValue: '这条请求已由其它设备处理',
      }))
      return
    }

    // ：WS 转发失败 / delivery ack 超时 → 审批未送达 Agent。这种"确认无法
    // 送达"的失败等同审批已失效——留着 pending 会让 Composer 一直停在待确认态。
    // 关卡清 pending 让用户能重发消息触发新审批。和 terminal error 区别只在文案
    // （未送达 vs 已被其它设备处理）。不违反"防假成功"：失败路径不 toast.success，
    // 用户不会误以为审批通过。
    if (isApprovalForwardFailureError(error)) {
      clearApprovalForSession(sessionId)
      toast.warning(i18n.t('chat:approval.forwardFailedCleared', {
        defaultValue: '审批未送达 Agent，已取消。请重新发送消息让 Agent 重新执行',
      }))
      return
    }

    // 未知错误（success:false 无 code / IPC 抛错无 code）：保守保留 pending +
    // 记录 submitError。这是防假成功的保守策略——main 端没明确说失效，清了
    // 怕用户误以为已通过。submitError 会触发 ApprovalPanel 渲染"放弃审批"按钮，
    // 给用户手动恢复输入的出口；审批自然过期时 onExpired 也会清。
    const errMsg = formatApprovalSubmitError(error)
    setApprovalSubmittingForSession(sessionId, false)
    setApprovalSubmitError(sessionId, errMsg)
    updateSessionMessages(sessionId, (prev) => [
      ...prev,
      {
        id: `approval-error-${Date.now()}`,
        role: 'assistant',
        content: i18n.t('chat:messages.submitFailed', { message: errMsg }),
        created_at: new Date().toISOString(),
      },
    ])
  }

  /**
   * ：手动 / 过期放弃审批——清 pending 恢复 Composer 输入。
   *
   * 两个触发源：
   *   - `reason='expired'`：ApprovalPanel 倒计时归零经 `onExpired` 调入。
   *     此时审批真的过期失效，清 pending 让主 composer 解锁，toast 提示用户
   *     重发消息。覆盖"自然过期死锁"——之前 ChatInput 没传 onExpired，过期
   *     后 pending 一直挂着，用户要等满 TTL 才能恢复输入。
   *   - `reason='manual'`：用户在 submitError 旁点"放弃审批"按钮调入。
   *     兜底未知错误场景（success:false 无 code / IPC 抛错）——handleApprovalSubmitFailure
   *     保守保留 pending 防假成功，但用户确认要放弃时给手动出口。
   *
   * 幂等：pending 已清则 no-op（onExpired tick 可能多次触发）。
   *
   * （第二刀）：在清本地 UI 前**先**走 cancel-hitl IPC 让 runtime
   * 收敛 pending（emit HitlInteractionEvent status='cancelled'），
   * 让 Django / 其它端的 hitl_interaction 消息终态与本地 UI 对齐——避免面板
   * 关了但服务端仍显示 pending，换端 / 重载后被 HitlMessageReconcile 派生
   * 恢复成「关不掉的幽灵卡」。IPC 失败（例如 batch 已被其它设备处理）不阻断
   * 本地清理——反正本机 UI 意图已经明确了。
   */
  const dismissApprovalForSession = (
    sessionId: string,
    reason: 'expired' | 'manual' = 'manual',
  ) => {
    const pending = getPendingApprovalForSession(sessionId)
    if (!pending) return
    if (pending.batchId && isLocalApprovalIpcAvailable()) {
      // fire-and-forget：cancel-hitl 只走本机（main 端不再 WS 兜底转发；跨端
      // 收敛靠后端 hitl_interaction 消息广播）。失败静默——已被别处 resolve
      // 的 pending 不再需要重复收敛。
      void getSessionController(sessionId)
        .cancelHitlInteraction({
          kind: 'approval',
          requestKey: pending.batchId,
          reason: reason === 'expired'
            ? 'Approval panel timed out on the client UI.'
            : 'User dismissed the approval panel manually.',
        })
        .catch((err) => {
          console.warn('[Chat] cancel-hitl(approval) failed (non-fatal):', err)
        })
    }
    clearApprovalForSession(sessionId)
    if (reason === 'expired') {
      toast.info(i18n.t('chat:approval.expiredCleared', {
        defaultValue: '审批已过期，请重新发送消息让 Agent 重新执行',
      }))
    }
  }

  const RESUME_WATCHDOG_DELAY_MS = 10_000

  /**
   * v0.4 W1.5（PRD §7.8）：post-approval resume 状态判定单源化。
   *
   * 旧实装用 `client.isStreaming(sessionId)` 判定流是否仍活：
   *   - 本地 IPC 主路径（M5.Y 之后默认）`localClient.stream` 不走 ChatClient
   *     的 streamManager → 不建 StreamSlot → `isStreaming` 永远 false
   *   - 但 sendMessageAction 同步 `streamingBySessionId=true`（W4.4 修复刻意保的）
   * → 双状态机割裂导致 `Stream slot already closed before review resume`
   *   warning 在本地 IPC 路径下**稳定常态触发**（功能上由 watchdog 内 store 检查
   *   兜底，但日志噪声 + 误导排查方向）。
   *
   * v0.4 修复：以执行态单一投影（isSessionBusy）为权威单源；
   * `client.isStreaming` 不再参与判定（：原 streamingBySessionId 已删）。
   */
  function handlePostApprovalResume(_client: ChatClient, sessionId: string): void {
    void _client
    void import('@stores/chat/useChatStore').then(({ useChatStore }) => {
      if (isSessionBusy(sessionId)) {
        addStreamingSession(sessionId)
        return
      }
      console.info('[Chat] post-approval: stream already done, scheduling watchdog sync')
      setTimeout(() => {
        const store = useChatStore.getState()
        if (isSessionBusy(sessionId)) return
        store.syncSessionMessagesFromServer(sessionId).catch((err: unknown) => {
          console.warn('[Chat] Post-approval watchdog sync failed:', err)
        })
      }, RESUME_WATCHDOG_DELAY_MS)
    }).catch(() => {})
  }

  // 内部：把 PerToolApprovalDecision[] 映射成 wire 协议要求的 batch decisions
  // schema（{request_id, tool_call_id, outcome, scope?, rejection_message?}），
  // 并和 pending state 内的 actionRequests 做匹配（按 tool_call_id 优先；缺省按
  // 顺序兜底）——前端只需关心 decision/scope/rejection_message，request_id 由
  // 这里从 pending 状态自动取。
  const buildBatchDecisions = (
    pending: ApprovalRequestState,
    decisions: PerToolApprovalDecision[],
  ): Array<{
    request_id: string
    tool_call_id: string
    outcome: 'allow' | 'deny'
    scope?: 'once' | 'thread' | 'always'
    rejection_message?: string
    pattern_key?: string
    scope_description?: string
    decision_kind?: 'exact' | 'pattern'
    approver_identity?: { user_id: string; client_info: string; timestamp: number }
  }> => {
    const actionRequests = pending.actionRequests ?? []
    const approverIdentity = currentApproverIdentity()
    return decisions.map((d, i) => {
      const matched = d.tool_call_id
        ? actionRequests.find((a) => a.tool_call_id === d.tool_call_id)
        : actionRequests[i]
      const requestId = d.request_id
        ?? (matched as { request_id?: string } | undefined)?.request_id
        ?? matched?.tool_call_id
        ?? d.tool_call_id
        ?? ''
      return {
        request_id: requestId,
        tool_call_id: d.tool_call_id ?? matched?.tool_call_id ?? requestId,
        outcome: d.decision === 'approve' ? 'allow' as const : 'deny' as const,
        scope: d.scope,
        rejection_message: d.rejection_message,
        pattern_key: d.pattern_key,
        scope_description: d.scope_description,
        decision_kind: d.decision_kind,
        ...(approverIdentity ? { approver_identity: approverIdentity } : {}),
      }
    })
  }

  const submitApprovalDecisionForSession = async (
    sessionId: string,
    decision: 'approve' | 'reject',
  ) => {
    const pending = getPendingApprovalForSession(sessionId)
    if (!pending) {
      console.warn('[Chat] No pending approval request')
      return
    }
    if (!isLocalApprovalIpcAvailable() || !pending.batchId) {
      appendUnavailableNotice(sessionId)
      return
    }

    setApprovalSubmittingForSession(sessionId, true)
    setApprovalSubmitError(sessionId, undefined)
    try {
      const approverIdentity = currentApproverIdentity()
      const decisions = (pending.actionRequests ?? []).map((a) => ({
        request_id: (a as { request_id?: string }).request_id ?? a.tool_call_id ?? '',
        tool_call_id: a.tool_call_id ?? '',
        outcome: decision === 'approve' ? 'allow' as const : 'deny' as const,
        ...(approverIdentity ? { approver_identity: approverIdentity } : {}),
      }))
      // W1.5-轮 3 + contract W2-β：
      // 主进程 batch resolver 按 batchId 查 pending；resolver 失效返 raw `{success: false}`
      // （channel 在 LEGACY_HANDLERS 透传），envelope ok:false 走 invokeIpc 短路 throw。
      // ensureLegacyOk 把"两种形态"统一成 throw —— catch 块用 formatApprovalSubmitError
      // 区分 RESOLVER_MISSING（业务"已失效/已被其他窗口处理"语义）和通信错误。
      // **不能删 ensureLegacyOk**：W1.5 P0 "resolver 已失效绝不 toast 成功" —— main 端
      // raw `{success: false}` 不走 throw 时 toast.success 会误弹，用户以为审批通过但
      // Agent 没收到。
      const submitRes = await getSessionController(sessionId).submitApproval(pending.batchId, decisions, pending.threadId)
      ensureApprovalResponseDelivered(submitRes, 'submitHitlBatch')
      toast.success(i18n.t('chat:review.submitSuccess', { defaultValue: '审批已提交' }))
      // 修问题 1：先清 review prompt 文本，再清 pending state，让 chat 流不残留
      // 「⚠️ 需要确认执行以下操作：…」长文案。详见 resetReviewMessageContent。
      resetReviewMessageContent(sessionId, pending.messageId, decision)
      clearApprovalForSession(sessionId)
      handlePostApprovalResume(getChatClient(), sessionId)
    } catch (error) {
      console.error('[Chat] Failed to submit approval via IPC:', error)
      handleApprovalSubmitFailure(sessionId, error)
    }
  }

  const submitApprovalDecisionsForSession = async (
    sessionId: string,
    decisions: PerToolApprovalDecision[],
  ) => {
    const pending = getPendingApprovalForSession(sessionId)
    if (!pending) {
      console.warn('[Chat] No pending approval request')
      return
    }
    if (!isLocalApprovalIpcAvailable() || !pending.batchId) {
      appendUnavailableNotice(sessionId)
      return
    }

    setApprovalSubmittingForSession(sessionId, true)
    setApprovalSubmitError(sessionId, undefined)
    try {
      const batchDecisions = buildBatchDecisions(pending, decisions)
      const submitRes = await getSessionController(sessionId).submitApproval(pending.batchId, batchDecisions, pending.threadId)
      ensureApprovalResponseDelivered(submitRes, 'submitHitlBatch(perTool)')
      toast.success(i18n.t('chat:review.submitSuccess', { defaultValue: '审批已提交' }))
      const aggregateDecision: 'approve' | 'reject' = decisions.some(d => d.decision === 'reject')
        ? 'reject'
        : 'approve'
      resetReviewMessageContent(sessionId, pending.messageId, aggregateDecision)
      clearApprovalForSession(sessionId)
      // 平台审批（sandbox 镜像）无本地 runtime 流可 resume；仅 runtime HITL 需要。
      if (pending.approvalSource !== 'platform') {
        handlePostApprovalResume(getChatClient(), sessionId)
      }
    } catch (error) {
      console.error('[Chat] Failed to submit approval via IPC:', error)
      handleApprovalSubmitFailure(sessionId, error)
    }
  }

  return {
    submitApprovalDecision: async (decision: 'approve' | 'reject') => {
      const sessionId = get().currentSessionId
      if (!sessionId) return
      await submitApprovalDecisionForSession(sessionId, decision)
    },
    submitApprovalDecisionForSession,

    submitApprovalDecisions: async (decisions: PerToolApprovalDecision[]) => {
      const sessionId = get().currentSessionId
      if (!sessionId) return
      await submitApprovalDecisionsForSession(sessionId, decisions)
    },
    submitApprovalDecisionsForSession,

    dismissApproval: (reason: 'expired' | 'manual' = 'manual') => {
      const sessionId = get().currentSessionId
      if (!sessionId) return
      dismissApprovalForSession(sessionId, reason)
    },
    dismissApprovalForSession,
  }
}
