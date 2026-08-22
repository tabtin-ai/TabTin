/**
 * AskUser slice — submitAskUserAnswer / skipAskUser
 *
 * Handles the AskQuestion tool interrupt: user answers structured questions,
 * then the Agent resumes with the answers as tool_result.
 * User can also skip (dismiss) the questions — Agent gets "skipped" result.
 *
 * M5.Y / Wave 11：云端 `/api/orchestration/agent/answer` 已下线，HTTP 兜底
 * 整条移除。本 slice 仅走 `window.tabtin.agentEngine.submitAskUserResponse`
 * (IPC → 本地 Runtime)。没有本地 Runtime / 非 Electron 上下文时，直接把错误
 * 文案写回会话；sendMessageAction 已在入口阻止了"无设备"场景发消息，这里
 * 只处理 race / 异常兜底。
 */

import type { ChatMessage, ChatClient, AskUserAnswer } from '@tabtin/chat-client'
import type { AskUserRequestState } from '../../shared/types'
import i18n from '@/i18n'
import { toast } from '@tabtin/smartsheet-ui'
import { isLocalRuntimeAvailable } from '@services/localAgentClient'
import { getSessionController } from '@/services/agentService'
import { isPlatformIpcError, formatIpcErrorForUser } from '@/services/ipc-error'
import { ensureLegacyOk, extractLegacyErrorMessage } from '@/services/legacy-result'
import { recordHitlResolvedKey } from '../handlers/hitlStreamHandlers'

/**
 * 把 askUser IPC 抛出的错误格式化为给用户看的文案。
 *
 * **决策树**：
 * - PlatformIpcError 且 code ∈ NOT_FOUND/RESOLVER_MISSING/SOFT_FAIL → 沿用 W11 P0 的"resolver
 *   失效"文案（语义：会话已超时 / 已被其他窗口处理；用户能理解"换个窗口或刷新"）
 * - 其他 PlatformIpcError → 用其 message + trace 末 6 位（譬如 main 进程出 bug 时让 trace 可追溯）
 * - 其他 Error → message
 * - 兜底 → unknownError 文案
 *
 * 这条决策树保留了 contract W2-β 改造前的产品语义——之前 caller 检测「success 字段为 false」
 * 后必显示 runtimeResolverMissing；现在所有抛出场景都被 catch 接住，但只在 RESOLVER_MISSING
 * 类语义码下保留原文案，让"通信失败"和"业务找不到 resolver"两种语义在 toast 上分得开。
 */
function formatAskUserSubmitError(err: unknown): string {
  const RESOLVER_MISSING_CODES = new Set(['NOT_FOUND', 'RESOLVER_MISSING', 'SOFT_FAIL', 'LEGACY_SHAPE'])
  if (isPlatformIpcError(err) && RESOLVER_MISSING_CODES.has(err.code)) {
    return i18n.t('chat:askUser.runtimeResolverMissing', {
      defaultValue: '没找到这条待回答的问题（可能已超时或已被其他窗口处理）。请刷新后重试。',
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

function isAlreadyTerminalAskResponseError(err: unknown): boolean {
  const code = readErrorCode(err).toLowerCase()
  return code === 'already_consumed' ||
    code === 'pending_not_found' ||
    code === 'not_found' ||
    code === 'resolver_missing'
}

function ensureAskUserResponseDelivered<T>(raw: T, op: string): asserts raw is Exclude<T, { success: false }> {
  if (raw && typeof raw === 'object' && (raw as { success?: unknown }).success === false) {
    const err = new Error(extractLegacyErrorMessage(raw, `${op} failed`)) as Error & { code?: string }
    const code = (raw as { code?: unknown }).code
    if (typeof code === 'string') err.code = code
    throw err
  }
  ensureLegacyOk(raw, op)
}

export interface AskUserSliceDeps {
  getChatClient: () => ChatClient
}

export interface AskUserSliceStore {
  currentSessionId: string | null
  pendingAskUser: AskUserRequestState | null
  isAskUserSubmitting: boolean
  pendingAskUserBySessionId: Record<string, AskUserRequestState>
  askUserSubmittingBySessionId: Record<string, boolean>
}

type GetFn = () => AskUserSliceStore
type SetFn = (
  partial:
    | Partial<AskUserSliceStore>
    | ((state: AskUserSliceStore) => Partial<AskUserSliceStore>),
) => void

interface AskUserSliceHelpers {
  addStreamingSession: (sessionId: string) => void
  updateSessionMessages: (
    sessionId: string | null,
    updater: (prev: ChatMessage[]) => ChatMessage[],
  ) => void
}

// 路径权限治理 W7 / A5 D6 真分立：原 _stableStringify / _isEqualLoose 用于
// approve 模式 diff fields 当前值 vs default 计算 modified_fields——但
// AskUserPanel `RequestApprovalCard` 的 onApprovalSubmit(approved, {}) 永远传
// 空 fieldValues（W5 已落定 request_approval 不再有 fillable 字段），diff 永
// 远空。D6 真分立后 approval state 不再带 fields/addons，整段死代码删除。

export function createAskUserActions(
  get: GetFn,
  set: SetFn,
  deps: AskUserSliceDeps,
  helpers: AskUserSliceHelpers,
) {
  const { getChatClient } = deps
  const { addStreamingSession, updateSessionMessages } = helpers

  // Wave 11 迁移：Django `/api/orchestration/agent/answer` 已下线（urls_deferred.py L47-48），
  // Electron 环境下必须走本地 Runtime IPC。判定与 sendMessage / approvalSlice 对齐——消除判定漂移。
  const isLocalAskUserIpcAvailable = isLocalRuntimeAvailable

  const getPendingAskUserForSession = (sessionId: string) => (
    get().pendingAskUserBySessionId[sessionId] ?? null
  )

  const setAskUserSubmittingForSession = (sessionId: string, submitting: boolean) => {
    set((state) => {
      const next = { ...state.askUserSubmittingBySessionId }
      if (submitting) {
        next[sessionId] = true
      } else {
        delete next[sessionId]
      }
      return {
        askUserSubmittingBySessionId: next,
      }
    })
  }

  // Wave 11 Review 必修（P1）：AskUser IPC 失败此前只 console.error + 解锁按钮，
  // 用户看不出失败原因。对齐 approvalSlice 的 submitError 模型，让 AskQuestionPanel
  // 能展示红条提示（下游消费端按 `pendingAskUser.submitError` 渲染）。
  const setAskUserSubmitError = (sessionId: string, error: string | undefined) => {
    set((state) => {
      const prev = state.pendingAskUserBySessionId[sessionId]
      if (!prev) return {}
      return {
        pendingAskUserBySessionId: {
          ...state.pendingAskUserBySessionId,
          [sessionId]: { ...prev, submitError: error },
        },
      }
    })
  }

  const clearAskUserForSession = (
    sessionId: string,
    /**
     * ：提交/跳过前已抓到的 pending。若 single_hitl_resolved 抢先清掉
     * store，仍要用这份快照记墓碑，否则 lifecycle-end 对账会把面板派生回开。
     */
    knownPending?: AskUserRequestState | null,
  ) => {
    // ：调用点都是「这条追问已了结」语义——把可能作为服务端 request_key 的
    // 三个候选 id 都记墓碑，挡住「消息缓存还停在 pending」的派生恢复回开面板。
    set((state) => {
      const pending = knownPending ?? state.pendingAskUserBySessionId[sessionId]
      if (pending) {
        recordHitlResolvedKey(sessionId, pending.interruptId)
        recordHitlResolvedKey(sessionId, pending.toolCallId)
        recordHitlResolvedKey(sessionId, pending.messageId)
      }
      const nextPending = { ...state.pendingAskUserBySessionId }
      delete nextPending[sessionId]
      const nextSubmitting = { ...state.askUserSubmittingBySessionId }
      delete nextSubmitting[sessionId]
      return {
        pendingAskUserBySessionId: nextPending,
        askUserSubmittingBySessionId: nextSubmitting,
      }
    })
  }

  const handleSubmitFailure = (
    sessionId: string,
    error: unknown,
    knownPending?: AskUserRequestState | null,
  ) => {
    if (isAlreadyTerminalAskResponseError(error)) {
      clearAskUserForSession(sessionId, knownPending)
      toast.info(i18n.t('chat:askUser.alreadyHandled', {
        defaultValue: '这条请求已由其它设备处理',
      }))
      return
    }

    const errMsg = formatAskUserSubmitError(error)
    setAskUserSubmittingForSession(sessionId, false)
    setAskUserSubmitError(sessionId, errMsg)
    toast.error(i18n.t('chat:messages.submitFailed', { message: errMsg }))
  }

  const appendUnavailableNotice = (sessionId: string, messageIdPrefix: string) => {
    updateSessionMessages(sessionId, (prev) => [
      ...prev,
      {
        id: `${messageIdPrefix}-${Date.now()}`,
        role: 'assistant',
        // Phase 1 Review #6 修复：原文案 "需要本地 Runtime" 对普通用户是黑话。
        // 改成"需要桌面端"+"在哪能解决"，避免用户对着术语发呆。
        content: i18n.t('chat:messages.askUserRequiresDevice', {
          defaultValue: '这个操作需要在桌面端 TabTin 里完成。请打开桌面客户端、或在 Agent 设置中绑定一台设备后再试。',
        }),
        created_at: new Date().toISOString(),
      },
    ])
  }

  const submitAskUserAnswerForSession = async (sessionId: string, answers: AskUserAnswer[]) => {
    const pendingAskUser = getPendingAskUserForSession(sessionId)
    if (!pendingAskUser) {
      console.warn('[Chat] No pending question to answer')
      return
    }

    const requestId = pendingAskUser.interruptId
    if (!isLocalAskUserIpcAvailable() || !requestId) {
      appendUnavailableNotice(sessionId, 'ask-user-no-device')
      return
    }

    setAskUserSubmittingForSession(sessionId, true)
    setAskUserSubmitError(sessionId, undefined)
    try {
      // Wave 11 P0 + contract W2-β：
      // 主进程 resolver 失效时返 raw `{success: false}`（channel 仍在 LEGACY_HANDLERS，
      // 透传到 caller）；envelope `ok:false` 路径走 invokeIpc 自动 throw PlatformIpcError。
      // ensureLegacyOk 把"两种形态"统一成 throw —— catch 块统一识别 RESOLVER_MISSING 文案。
      // **不删 success 检查**：D-3 不留 MVP，main 端转 envelope 前必须显式拦 success:false，
      // 否则 resolver 失效会静默成功（用户以为审批通过但 Agent 没收到）。
      const submitRes = await getSessionController(sessionId).answerAskUser(requestId, { answers }, pendingAskUser.threadId)
      ensureAskUserResponseDelivered(submitRes, 'submitAskUserResponse')
      clearAskUserForSession(sessionId, pendingAskUser)
      const client = getChatClient()
      if (client.isStreaming(sessionId)) {
        addStreamingSession(sessionId)
      }
    } catch (error) {
      console.error('[Chat] Failed to submit answer via IPC:', error)
      handleSubmitFailure(sessionId, error, pendingAskUser)
    }
  }

  const submitAskUserFieldValuesForSession = async (
    sessionId: string,
    fieldValues: Record<string, unknown>,
  ) => {
    const pendingAskUser = getPendingAskUserForSession(sessionId)
    if (!pendingAskUser) {
      console.warn('[Chat] No pending question to answer (fields mode)')
      return
    }

    const requestId = pendingAskUser.interruptId
    if (!isLocalAskUserIpcAvailable() || !requestId) {
      appendUnavailableNotice(sessionId, 'ask-user-fields-no-device')
      return
    }

    setAskUserSubmittingForSession(sessionId, true)
    setAskUserSubmitError(sessionId, undefined)
    try {
      // contract W2-β: ensureLegacyOk 拦 main 端 raw `{success: false}` 转 throw（同 submitAskUserAnswerForSession 决策）
      const submitRes = await getSessionController(sessionId).answerAskUser(requestId, { field_values: fieldValues }, pendingAskUser.threadId)
      ensureAskUserResponseDelivered(submitRes, 'submitAskUserResponse(fields)')
      clearAskUserForSession(sessionId, pendingAskUser)
      const client = getChatClient()
      if (client.isStreaming(sessionId)) {
        addStreamingSession(sessionId)
      }
    } catch (error) {
      console.error('[Chat] Failed to submit field values via IPC:', error)
      handleSubmitFailure(sessionId, error, pendingAskUser)
    }
  }

  /**
   * 路径权限治理 W7 / A5 D6 真分立：request_approval 提交。
   *
   * 与 W5 collapse 时代的差异：
   *   - request_approval 不再有 fillable fields；submitter 仅传 `approved` 布尔
   *   - 不再 diff modified_fields（approval state 类型层面就没有 fields）
   *   - 不再透传 intent='approve' wire 字段（main 端按 requestId 分发，无歧义）
   *
   * Agent 收到的 tool_result 是 `{ approved: true|false }`——简洁、确定，
   * 不需要让 Agent 解读 modified_fields 这种间接信号。
   */
  const submitAskUserApprovalForSession = async (
    sessionId: string,
    approved: boolean,
  ) => {
    const pendingAskUser = getPendingAskUserForSession(sessionId)
    if (!pendingAskUser) {
      console.warn('[Chat] No pending question to answer (approve mode)')
      return
    }
    if (pendingAskUser.kind !== 'approval') {
      console.error(
        '[Chat] submitAskUserApproval called but pending kind is',
        pendingAskUser.kind,
      )
      return
    }
    const requestId = pendingAskUser.interruptId
    if (!isLocalAskUserIpcAvailable() || !requestId) {
      appendUnavailableNotice(sessionId, 'ask-user-approve-no-device')
      return
    }
    setAskUserSubmittingForSession(sessionId, true)
    setAskUserSubmitError(sessionId, undefined)
    try {
      const submitRes = await getSessionController(sessionId).answerAskUser(requestId, {
        approved,
      }, pendingAskUser.threadId)
      ensureAskUserResponseDelivered(submitRes, 'submitAskUserResponse(approve)')
      clearAskUserForSession(sessionId, pendingAskUser)
      const client = getChatClient()
      if (client.isStreaming(sessionId)) {
        addStreamingSession(sessionId)
      }
    } catch (error) {
      console.error('[Chat] Failed to submit approval via IPC:', error)
      handleSubmitFailure(sessionId, error, pendingAskUser)
    }
  }

  const submitAskUserTextForSession = async (
    sessionId: string,
    text: string,
  ) => {
    const pendingAskUser = getPendingAskUserForSession(sessionId)
    if (!pendingAskUser) {
      console.warn('[Chat] No pending question to answer (text fallback mode)')
      return
    }

    const requestId = pendingAskUser.interruptId
    if (!isLocalAskUserIpcAvailable() || !requestId) {
      appendUnavailableNotice(sessionId, 'ask-user-text-no-device')
      return
    }

    setAskUserSubmittingForSession(sessionId, true)
    setAskUserSubmitError(sessionId, undefined)
    try {
      // contract W2-β: ensureLegacyOk 拦 main 端 raw `{success: false}` 转 throw（同 submitAskUserAnswerForSession 决策）
      const submitRes = await getSessionController(sessionId).answerAskUser(requestId, { text }, pendingAskUser.threadId)
      ensureAskUserResponseDelivered(submitRes, 'submitAskUserResponse(text)')
      clearAskUserForSession(sessionId, pendingAskUser)
      const client = getChatClient()
      if (client.isStreaming(sessionId)) {
        addStreamingSession(sessionId)
      }
    } catch (error) {
      console.error('[Chat] Failed to submit text fallback via IPC:', error)
      handleSubmitFailure(sessionId, error, pendingAskUser)
    }
  }

  const skipAskUserForSession = async (sessionId: string) => {
    const pendingAskUser = getPendingAskUserForSession(sessionId)
    if (!pendingAskUser) return

    const requestId = pendingAskUser.interruptId
    if (!isLocalAskUserIpcAvailable() || !requestId) {
      // ：与 submit 分支对齐——无 runtime 时只追加不可用提示，**不清**澄清面板。
      // 之前这里额外调 clearAskUserForSession 会让面板立刻消失，用户误以为"跳过"已
      // 生效，但 IPC 没发出、Agent 实际没收到 skip（还在等回复）。保留面板让用户
      // 明确看到"本机没法处理这次跳过"，与 submit/answer/fields/approve/text 各分支
      // 的无 runtime 兜底行为一致。
      appendUnavailableNotice(sessionId, 'ask-user-skip-no-device')
      return
    }

    setAskUserSubmittingForSession(sessionId, true)
    setAskUserSubmitError(sessionId, undefined)
    try {
      // contract W2-β: skip 路径同样要拦 main 端 raw `{success: false}` —— 否则 resolver
      // 失效时用户看到面板被清掉但 Agent 没收到 skip，回来还在等。
      const submitRes = await getSessionController(sessionId).answerAskUser(requestId, { skipped: true }, pendingAskUser.threadId)
      ensureAskUserResponseDelivered(submitRes, 'submitAskUserResponse(skip)')
      clearAskUserForSession(sessionId, pendingAskUser)
    } catch (error) {
      console.error('[Chat] Failed to skip question via IPC:', error)
      // （第二刀）：skip IPC 失败但本机 UI 已决定关面板——通过
      // cancel-hitl IPC 让 runtime 收敛 pending 为 cancelled 终态，避免
      // hitl_interaction 消息卡在 pending。fire-and-forget：不影响 catch 主流程
      // 的 clear + toast；已被别处 resolve 的 pending 不再需要重复收敛。
      void getSessionController(sessionId)
        .cancelHitlInteraction({
          kind: 'ask',
          requestKey: requestId,
          reason: 'Ask panel closed locally after skip IPC failed.',
        })
        .catch((cancelErr) => {
          console.warn('[Chat] cancel-hitl(ask) fallback failed (non-fatal):', cancelErr)
        })
      clearAskUserForSession(sessionId, pendingAskUser)
      if (isAlreadyTerminalAskResponseError(error)) {
        toast.info(i18n.t('chat:askUser.alreadyHandled', {
          defaultValue: '这条请求已由其它设备处理',
        }))
      } else {
        toast.warning(i18n.t('chat:askUser.skipClosedLocally', {
          defaultValue: '已在本机关闭此提示，但未确认 Agent 收到跳过',
        }))
      }
    }
  }

  return {
    submitAskUserAnswer: async (answers: AskUserAnswer[]) => {
      const sessionId = get().currentSessionId
      if (!sessionId) return
      await submitAskUserAnswerForSession(sessionId, answers)
    },
    submitAskUserAnswerForSession,

    submitAskUserText: async (text: string) => {
      const sessionId = get().currentSessionId
      if (!sessionId) return
      await submitAskUserTextForSession(sessionId, text)
    },
    submitAskUserTextForSession,

    submitAskUserFieldValues: async (fieldValues: Record<string, unknown>) => {
      const sessionId = get().currentSessionId
      if (!sessionId) return
      await submitAskUserFieldValuesForSession(sessionId, fieldValues)
    },
    submitAskUserFieldValuesForSession,

    submitAskUserApproval: async (approved: boolean) => {
      const sessionId = get().currentSessionId
      if (!sessionId) return
      await submitAskUserApprovalForSession(sessionId, approved)
    },
    submitAskUserApprovalForSession,

    skipAskUser: async () => {
      const sessionId = get().currentSessionId
      if (!sessionId) return
      await skipAskUserForSession(sessionId)
    },
    skipAskUserForSession,
  }
}
