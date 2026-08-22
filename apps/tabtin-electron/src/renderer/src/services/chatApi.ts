/**
 * Chat Agent API 服务
 *
 * 提供 ChatClient 单例，封装与 Chat Agent 后端的通信。
 * 单例生命周期（reset / beforeunload / session reset）由 chatClientSingleton.ts 管理。
 */

import { ChatClient } from '@tabtin/chat-client'
import type { ChatSession } from '@tabtin/chat-client'
import {
  getChatSessionAccess,
  getChatStoreCallbacks,
} from '../stores/chat/shared/storeAccessRegistry'
import { getApiRuntimeConfig, type EnvLike } from '@tabtin/config'
import {
  ChatSessionEvents,
  UserEvents,
  OrganizationEvents,
  type ChatSessionEventType,
  type UserEventType,
} from '@tabtin/agent-wire'
import { logger, createLogger } from '@/utils/logger'
import { notifyLogoutRequired } from '@/utils/authPersistence'

const log = createLogger('ChatAPI')
const STALE_RESUME_CURSOR_ERROR_CODES = new Set([
  'WS_RESUME_OVERFLOW',
  'WS_1014_REPLAY_GAP',
])
import { Capabilities } from '@tabtin/ws-gateway-client'
import {
  loadPersistedLastEventId,
  attachLastEventIdPersistence,
  clearPersistedLastEventId,
} from './wsLastEventIdPersistence'
import { useWsConnectionStore } from '../stores/useWsConnectionStore'
import { useAuthStore } from '../stores/useAuthStore'
import { useOrganizationStore } from '../stores/useOrganizationStore'
import {
  routeEnvelopeToBackgroundBucket,
  useBackgroundEventStore,
  registerBackgroundOrganizationIdResolver,
  type BackgroundEnvelope,
} from '../stores/useBackgroundEventStore'
import { toast } from '@tabtin/smartsheet-ui/toast'
import i18n from '@/i18n'
import { getOrCreateDeviceId } from '@/utils/deviceId'
import {
  getChatClientInstance,
  setChatClientInstance,
} from './chatClientSingleton'
import { orchestrationClient } from './orchestrationApi'
import { isOrganizationPermissionMessage } from './organizationAccessErrors'
import { mainAgentGateway } from './mainAgentGateway'

/** 懒加载 membership handler，打断 chatApi → membershipEventHandler → useChatStore → chatApi 环 */
function loadMembershipEventHandler() {
  return import('./membershipEventHandler')
}

/** 懒加载 organization profile handler，避免 chatApi 启动期拉满 organization store 依赖 */
function loadOrganizationProfileEventHandler() {
  return import('./organizationProfileEventHandler')
}

function loadSessionCollaborationEventHandler() {
  return import('./sessionCollaborationEventHandler')
}
import { schedulePermissionAccessRefresh, clearPendingPermissionAccessRefreshes } from './permissionAccessRefresh'
import { registerCriticalBackgroundEventNotifier } from './criticalEventNotifier'
import { queryClient } from '@/lib/query-client'
import { membershipKeys } from '@/hooks/queries/membership'
import { memberKeys } from '@/hooks/queries/members'
import { memberBudgetKeys } from '@/hooks/queries/memberBudgetKeys'
import {
  handlePendingInteractionRequestedEvent,
  handlePendingInteractionTerminalEvent,
} from '../stores/chat/hitl/handlers/hitlStreamHandlers'
import { parseChatSessionRunStateEvent } from './chatSessionRunStateEvent'
import {
  mergeSessionReadStateFields,
  parseSessionReadState,
} from '../stores/chat/session/sessionReadProjection'
export { resetChatClient } from './chatClientSingleton'

const { chatApiBaseUrl, apiBaseUrl } = getApiRuntimeConfig(import.meta.env as unknown as EnvLike)

// chatApi → useChatStore 的反向访问通过中立 leaf `chat/storeAccessRegistry`
// 注入。由 `useChatStore.ts` module body 末尾调用 `registerChatStoreCallbacks`
// 写入实现；本文件只通过 `getChatStoreCallbacks()` 读出。这样 chatApi 与
// useChatStore 都单向依赖 leaf，避免它们互相 import 形成 ESM 循环加载。

let authLoadPromise: Promise<void> | null = null

const ensureAccessToken = async (): Promise<string> => {
  const state = useAuthStore.getState()
  if (state.accessToken) {
    return state.accessToken
  }

  if (typeof window !== 'undefined' && state.loadAuthFromStorage) {
    if (!authLoadPromise) {
      authLoadPromise = state.loadAuthFromStorage()
        .catch(error => {
          log.error('加载认证信息失败:', error)
        })
        .finally(() => {
          authLoadPromise = null
        })
    }
    await authLoadPromise
  }

  const token = useAuthStore.getState().accessToken
  if (!token) {
    throw new Error(i18n.t('chat:errors.notLoggedIn'))
  }
  return token
}

/**
 * 获取 Chat Client 单例
 *
 * @returns ChatClient 实例
 */
export function getChatClient(): ChatClient {
  const existing = getChatClientInstance()
  if (existing) return existing

  if (import.meta.env?.DEV) {
    logger.debug('[Chat API] baseURL:', chatApiBaseUrl, '→ Gateway:', 'main-backed ElectronWsGateway')
  }

  // W4c · §3.6 catchup 协议：启动时从 localStorage 恢复 lastEventId，让 WS
  // 首次握手完成后自动跑 sendResume(id) 续传"上次进程关闭至本次启动期间"
  // backend Redis Stream 缓冲的事件——避免用户重启 Electron 后丢失本应收到
  // 的 LLM stream / 工具产物 / approval 等事件。
  const persistedLastEventId = loadPersistedLastEventId()

  const client = new ChatClient({
    baseURL: chatApiBaseUrl,
    catalogBaseURL: apiBaseUrl,

    getToken: async () => {
      return ensureAccessToken()
    },

    getOrganizationId: async () => {
      return useOrganizationStore.getState().getEffectiveOrganizationId() ?? null
    },

    role: 'electron',
    wsGateway: mainAgentGateway,
    capabilities: [
      Capabilities.AGENT_ACTION,
      Capabilities.TABLE_EVENTS, Capabilities.CONTEXT_SYNC, Capabilities.DOC_EVENTS,
      Capabilities.DOCPARSE_EVENTS, Capabilities.TRACKER_EVENTS,
      Capabilities.NOTIFICATIONS, Capabilities.EXTENSION_EVENTS,
      Capabilities.BILLING_EVENTS, Capabilities.ASR_STREAM,
      Capabilities.SESSION_COLLABORATION,
    ],
    deviceId: getOrCreateDeviceId(),

    onDisconnect: () => {
      logger.info('[E2E:WS] disconnected')
      useWsConnectionStore.getState().setDisconnected()
    },
    onConnected: () => {
      logger.info('[E2E:WS] connected')
      useWsConnectionStore.getState().setConnected()
      void import('./sessionReadReceipt').then(({ flushSessionReadOutbox }) => {
        void flushSessionReadOutbox()
      })
    },
    onReconnected: () => {
      logger.info('[E2E:WS] reconnected')
      useWsConnectionStore.getState().setConnected()
      void import('./sessionReadReceipt').then(({ flushSessionReadOutbox }) => {
        void flushSessionReadOutbox()
      })
    },
    onReconnecting: (attempt: number, delayMs: number) => {
      logger.info(`[E2E:WS] reconnecting attempt=${attempt} delay=${delayMs}ms`)
      useWsConnectionStore.getState().setReconnecting(attempt, delayMs)
    },
    onError: (error: Error) => {
      log.error('gateway error:', error)
      const errorCode = (error as { code?: string }).code
      if (
        errorCode === 'WS_ORGANIZATION_ACCESS_DENIED'
        || isOrganizationPermissionMessage(error.message)
      ) {
        const organizationId = useOrganizationStore.getState().getEffectiveOrganizationId()
        if (organizationId) {
          void loadMembershipEventHandler().then((m) =>
            m.recoverFromInvalidOrganizationAccess(organizationId),
          )
        }
        return
      }
      if (errorCode && STALE_RESUME_CURSOR_ERROR_CODES.has(errorCode)) {
        // W4c · §3.6 catchup 协议契约：cursor 已陈旧到 backend Redis Stream 已
        // GC 或命中 replay gap，必须**清掉 localStorage 持久化的 lastEventId**——
        // 否则下次进程冷启动会再次 sendResume(stale cursor) 反复失败。
        // 同时触发本会话全量重拉（syncSessionMessagesFromServer）兜底"丢的事件
        // 也在 DB 里"。
        try {
          clearPersistedLastEventId()
        } catch (err) {
          log.warn('clearPersistedLastEventId failed on stale resume cursor:', err)
        }
        toast.warning(
          i18n.t('chat:ws.resumeCursorExpired', {
            defaultValue: '网络恢复，正在重新同步会话消息',
          }),
          { duration: 8000 },
        )
        setTimeout(() => {
          const cbs = getChatStoreCallbacks()
          if (!cbs) {
            log.warn('stale resume cursor resync skipped: chat store callbacks not registered yet')
            return
          }
          const activeSessions = cbs.getStreamingSessionIds()
          if (activeSessions.length > 0) {
            for (const sid of activeSessions) {
              cbs.syncSessionMessagesFromServer(sid)
            }
          } else {
            const cur = cbs.getCurrentSessionId()
            if (cur) cbs.syncSessionMessagesFromServer(cur)
          }
        }, 2000)
      }
    },
    onAuthFailed: (error: Error & { code?: string }) => {
      if (error.code === 'WS_REQUEST_TIMEOUT' || error.code === 'WS_CLOSED') {
        log.warn('WS auth handshake transient failure, keeping session:', error.message)
        useWsConnectionStore.getState().setDisconnected()
        return
      }
      log.error('WS auth failed, triggering logout:', error.message)
      useWsConnectionStore.getState().setAuthFailed()
      notifyLogoutRequired('ws_auth_failed')
    },
    onOrganizationAccessDenied: (error: Error & { code?: string }) => {
      log.warn('WS organization access denied:', error.message)
      useWsConnectionStore.getState().setDisconnected()
      const organizationId = useOrganizationStore.getState().getEffectiveOrganizationId()
      if (!organizationId) {
        useWsConnectionStore.getState().setOrganizationAccessBlocked(
          'unknown',
          i18n.t('organization:unnamed', { defaultValue: '组织' }),
        )
        return
      }
      void loadMembershipEventHandler().then((m) =>
        m.recoverFromInvalidOrganizationAccess(organizationId),
      )
    },

    timeout: 30000,

    probeRun: async (runId: string) => {
      const token = await ensureAccessToken()
      try {
        return await orchestrationClient.get(`/runs/${runId}`, { token })
      } catch {
        return { status: 'unknown' }
      }
    },

    /**
     * v0.4 W1.5（PRD 05 §7.8.2 选项 A）：把执行态单一投影（isSessionBusy）
     * 作为 streaming 状态的单源注入给 ChatClient.isStreaming。
     *
     * 本地 IPC 主路径（M5.Y 之后默认）走 LocalAgentClient.stream → 不建
     * StreamManager slot；旧实装下 ChatClient.isStreaming(sessionId) 永远 false，
     * 导致 approvalSlice.handlePostApprovalResume 在审批通过后看到"stream 已关"
     * → 跑 watchdog 兜底分支 → 控制台 `[Chat] Stream slot already closed before
     * approval resume` 伪警告稳定常态触发。注入此回调后 isStreaming 直接读 store，
     * 双状态机统一 SSoT。
     */
    streamingChecker: (sessionId: string) =>
      getChatStoreCallbacks()?.isSessionBusy(sessionId) ?? false,
  })

  // Wave 3 设计约束：listener 挂接必须在 setInstance 之前完成，避免"单例已暴露
  // 但 listener 未就绪"的中间态。任何一步失败都不保留半装好的 client。
  //
  // - `registerBackgroundEventRouter`：挂在 gateway 实例（随 client 生命周期 GC）
  // - `registerCriticalBackgroundEventNotifier`：挂在模块级闭包（renderer 全生命周期单例）
  // - `registerBackgroundOrganizationIdResolver`：注入 `envelope.thread_id → sessionId
  //   → organization_id` 反查，补齐 chat_stream_publisher 不注入 envelope.organization_id 的缺口
  // - W4c：catchup 协议——connect 之前注入 lastEventId，listener 写持久化
  try {
    const gateway = client.getGateway() as unknown as {
      setInitialLastEventId?: (id: string | undefined) => void
      addListener: (cb: (envelope: unknown) => void) => unknown
    }
    // §3.6 catchup case C：把 localStorage 恢复的 lastEventId 注入底层
    // WsGatewayClient——首次握手完成后会自动跑 sendResume(id)。
    if (typeof gateway.setInitialLastEventId === 'function') {
      gateway.setInitialLastEventId(persistedLastEventId)
    }
    // 运行时每收到一条 event 节流写回 localStorage，保证用户关进程前 1s 内
    // 的 cursor 也能落盘——重启后续传链路完整。
    attachLastEventIdPersistence(gateway)

    registerBackgroundEventRouter(client)
    // 最小 consumer 闭环：对跨 organization 的关键事件（tracker.run.failed /
    // agent.stream.approval_requested 等）即时弹 toast；
    // Wave 5 会接入完整的角标 + 系统通知体系。
    registerCriticalBackgroundEventNotifier()
    // 给 useBackgroundEventStore 注入 organization_id 反查能力。
    registerBackgroundOrganizationIdResolver(resolveOrganizationIdFromChatStore)
  } catch (err) {
    logger.error('[Chat API] gateway listener registration failed, discarding half-initialized client', err)
    // 没写入 singleton，直接丢 client 让调用方下次重试
    try { client.getGateway().close() } catch { /* best-effort */ }
    throw err
  }

  setChatClientInstance(client)
  return client
}

/**
 * Background bucket organization_id fallback 解析器。
 *
 * 后端 `chat_stream_publisher.publish_ws` 当前只把 `thread_id` 放 envelope 顶层，
 * `organization_id` **不**写入 envelope。前端本地的 `useChatStore.sessionsBySpaceId`
 * 存有每个 session 的 `organization_id`，通过 `envelope.thread_id` 即可 O(n) 反查（
 * n ≤ LRU 缓存的 session 总数，通常 < 100，热路径性能可接受）。
 *
 * 优先匹配顺序：
 *   1. `envelope.thread_id` == session.id / session.thread_id（session 里有 id 也有 thread_id）
 *   2. `envelope.session_id` 字段（部分 action 类事件单独带）
 *
 * 未匹配时返回 null，事件不入桶。这与"默认 fallthrough"语义一致——
 * 我们宁可漏一条不入桶也不把事件误路由到错误的 organization。
 */
function resolveOrganizationIdFromChatStore(envelope: BackgroundEnvelope): string | null {
  const threadId = typeof (envelope as { thread_id?: unknown }).thread_id === 'string'
    ? (envelope as { thread_id?: string }).thread_id ?? ''
    : ''
  const sessionId = typeof (envelope as { session_id?: unknown }).session_id === 'string'
    ? (envelope as { session_id?: string }).session_id ?? ''
    : ''
  if (!threadId && !sessionId) return null

  try {
    const cbs = getChatStoreCallbacks()
    if (!cbs) return null
    const sessionsBySpaceId = cbs.getSessionsBySpaceId()
    for (const sessions of Object.values(sessionsBySpaceId)) {
      for (const s of sessions) {
        if (
          (threadId && (s.id === threadId || s.thread_id === threadId)) ||
          (sessionId && s.id === sessionId)
        ) {
          return s.organization_id || null
        }
      }
    }
  } catch (err) {
    // 通常是 store 未初始化（首屏阶段 / 测试环境），但保留 err 信息便于
    // 其他异常（getState 抛出、迭代过程中 setState 失败等）的现场排障。
    logger.debug('[Chat API] resolveOrganizationIdFromChatStore 反查失败:', err)
  }
  return null
}

/**
 * Gateway 全局 envelope listener — organization 事件分桶 + 用户级事件路由。
 *
 * ## 新事件接入 cookbook（W2 用户级事件治理立项）
 *
 * 用户级事件（``agent.user.*``）**不绑 topic 订阅**——客户端 ``auth.ok`` 时
 * 已自动 join `user.{user_id}` group（详见 `apps/tabtin_django/apps/services
 * /common/ws/handlers/auth.py::_join_group`），后端通过 `publish_to_user`
 * 投递的事件直达本 listener。新增 user-level 事件接入只需在下方 switch 加
 * ``UserEvents.X`` case 分支，**不需要 useGatewayTopic / syncSubscriptions /
 * 独立 hook**。
 *
 * 协议常量见 `packages/agent-wire/src/events.ts::UserEvents`，禁止写裸字面量
 * （``'agent.user.title_updated'``）—— 避免 W0 反思 §1 的 typo / case 漂移。
 *
 * ## Wave 3 范围（不变）
 *
 * - 前台 organization（`useOrganizationStore.selectedOrganization?.id`）事件不动，
 *   正常由 StreamManager / useGatewayTopic / useResourceEventStream 等
 *   按既有路径消费。
 * - 非前台 organization 事件入 `useBackgroundEventStore` 的 per-organization ring
 *   buffer，不触发前台 React 渲染；切回对应 organization 时 drain 队列（
 *   `onForegroundOrganizationChanged`），Wave 5 的 consumer 会在此基础上接入
 *   角标 / 任务完成通知。
 * - `organization.membership_changed` 走独立通道（见 handleMembershipChangedEnvelope），
 *   与 per-organization 桶解耦。
 */
export function registerBackgroundEventRouter(client: ChatClient): void {
  const gateway = client.getGateway()
  gateway.addListener((envelope) => {
    if (!envelope || typeof envelope !== 'object') return
    const envelopeType = typeof envelope.type === 'string' ? envelope.type : ''

    if (envelopeType === 'organization.membership_changed') {
      void loadMembershipEventHandler().then((m) =>
        m.handleMembershipChangedEnvelope(envelope.payload),
      )
      return
    }

    if (envelopeType === OrganizationEvents.UPDATED) {
      void loadOrganizationProfileEventHandler().then((m) =>
        m.handleOrganizationUpdatedEnvelope(envelope.payload),
      )
      return
    }

    if (
      envelopeType === 'session.collaboration.changed'
    ) {
      void loadSessionCollaborationEventHandler().then((m) =>
        m.handleSessionCollaborationEnvelope(envelope),
      )
      return
    }

    if (handleUserLevelEnvelope(envelopeType as UserEventType, envelope)) {
      return
    }

    const currentForegroundId = useOrganizationStore.getState().selectedOrganization?.id ?? null
    routeEnvelopeToBackgroundBucket(envelope, currentForegroundId)
  })
}

/**
 * 用户级事件分发（``agent.user.*``）。
 *
 * 返回 ``true`` 表示已识别并处理；调用方据此短路，不再走 background bucket
 * 通用兜底（user-level 事件没有 organization_id 维度，进 bucket 也消费不掉）。
 *
 * - {@link UserEvents.TITLE_UPDATED}：直接调 `useChatStore.updateSessionTitleInCaches`
 *   把 LLM 生成的新标题落到 sessions cache（与 fork / 手动 rename / ACK 路径
 *   写同一份缓存，下游排序 / UI 一并更新）。dogfood 577f1a4c 复盘根因：原走
 *   `agent.stream.title_updated` topic 的实现在 stream.done 后 slot 被 cleanup
 *   就接不到事件；user-level group 跟 stream 生命周期完全解耦，不会再丢。
 * - {@link UserEvents.SESSION_CREATED}： /  起服务端不再向其他成员
 *   广播私有执行 session；客户端作为纵深防御忽略 upsert。创建者本地仍走
 *   createSession / TabChat 响应写 store；恢复事实源是按用户过滤的 loadSessions。
 * - {@link UserEvents.PERMISSION_CHANGED}：invalidate react-query 角色 / 套餐
 *   / 成员列表缓存，并静默回读 zustand organization store 的角色 / owner_id
 *   （`refreshOrganizationAccess`）。加入/移出组织（成员**集合**变化）仍由
 *   `organization.membership_changed` 独立通道处理；但所有权转让 / 角色变更
 *   只改角色不改集合，membership_changed 不会触发，zustand 里的
 *   currentUserRole / owner_id 必须靠本事件回读——设置页 owner 门禁读的是
 *   zustand 而非 react-query（见 SettingsSpace.tsx）。
 * - {@link UserEvents.INTERACTION_RESOLVED} / {@link UserEvents.INTERACTION_EXPIRED}：
 *   任一端处理/过期待办后收起本地 HITL 卡，避免跨端 first-resolve 后留下僵尸弹窗。
 * - {@link ChatSessionEvents.RUN_STATE_UPDATED}：按 sequence/revision 写统一运行投影，
 *   并同步会话双缓存；无论当前打开哪条会话都能即时收口状态。
 * - {@link ChatSessionEvents.ACTIVITY_UPDATED}： 同账号目录活动——upsert /
 *   bump `last_message_at` 并重排；仅 owner 自设备，不替代已退役的团队
 *   `session_created`。
 *
 * 注：{@link UserEvents.NOTIFICATION_NEW} 由 `useNotificationEventStream` hook
 * 自身挂 gateway listener 处理——通知业务逻辑较重（react-query 乐观更新 /
 * 桌面通知 / 邀请事件分发）且需要 hook 层的 detached chat / hasMainWindowHost
 * enabled 守卫；同名 envelope 在 hook 内按 ``UserEvents.NOTIFICATION_NEW``
 * 判别后处理，本 router 不再重复路由（gateway 多 listener 互不干扰）。
 */
function handleUserLevelEnvelope(
  envelopeType: UserEventType | ChatSessionEventType | string,
  envelope: { type?: string; payload?: unknown },
): boolean {
  switch (envelopeType) {
    case 'chat.session.read_state.updated': {
      const payload = envelope.payload as Record<string, unknown> | undefined
      const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : ''
      const organizationId = typeof payload?.organization_id === 'string'
        ? payload.organization_id
        : null
      const currentOrganizationId =
        useOrganizationStore.getState().selectedOrganization?.id ?? null
      const readState = parseSessionReadState(payload?.read_state)
      if (
        !sessionId
        || !readState
        || typeof payload?.has_unread_reply !== 'boolean'
        || (organizationId && currentOrganizationId && organizationId !== currentOrganizationId)
      ) {
        log.warn('ignored invalid session read_state envelope', {
          hasSessionId: !!sessionId,
        })
        return true
      }
      const access = getChatSessionAccess()
      const cached = access?.getSessionById(sessionId)
      const incoming = {
        id: sessionId,
        has_unread_reply: payload.has_unread_reply,
        read_state: readState,
      } as unknown as ChatSession
      const merged = mergeSessionReadStateFields(incoming, cached) as ChatSession & {
        has_unread_reply?: boolean
        read_state?: unknown
      }
      access?.setSessionFields(sessionId, {
        has_unread_reply: merged.has_unread_reply,
        read_state: merged.read_state,
      } as Partial<ChatSession>)
      return true
    }

    case ChatSessionEvents.RUN_STATE_UPDATED: {
      const sessionAccess = getChatSessionAccess()
      const rawPayload = envelope.payload as { session_id?: unknown } | undefined
      const rawSessionId = typeof rawPayload?.session_id === 'string'
        ? rawPayload.session_id
        : ''
      const parsed = parseChatSessionRunStateEvent(envelope.payload, {
        currentOrganizationId:
          useOrganizationStore.getState().selectedOrganization?.id ?? null,
        cachedSession: rawSessionId
          ? sessionAccess?.getSessionById(rawSessionId)
          : undefined,
      })
      if (!parsed) {
        log.warn('ignored invalid session run_state envelope', {
          hasSessionId: !!rawSessionId,
        })
        return true
      }

      const chatStoreCallbacks = getChatStoreCallbacks()
      const accepted = chatStoreCallbacks?.applySessionRunStateEvent(
        parsed.sessionId,
        parsed.runState,
      ) ?? false
      if (accepted) {
        if (sessionAccess) {
          sessionAccess.setSessionFields(parsed.sessionId, {
            run_state: parsed.runState,
          })
        } else {
          log.warn('run_state cache update skipped: chat session access not registered', {
            sessionId: parsed.sessionId.slice(0, 8),
          })
        }
      }
      return true
    }

    case ChatSessionEvents.ACTIVITY_UPDATED: {
      const payload = envelope.payload as {
        session_id?: unknown
        organization_id?: unknown
        title?: unknown
        status?: unknown
        workspace_id?: unknown
        project_id?: unknown
        agent_id?: unknown
        agent_name?: unknown
        agent_avatar?: unknown
        message_count?: unknown
        has_messages?: unknown
        last_message_at?: unknown
        updated_at?: unknown
        created_at?: unknown
        thread_id?: unknown
        reason?: unknown
        is_agent_mention_session?: unknown
      } | undefined
      const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : ''
      const organizationId = typeof payload?.organization_id === 'string'
        ? payload.organization_id
        : null
      const currentOrganizationId =
        useOrganizationStore.getState().selectedOrganization?.id ?? null
      if (!sessionId) {
        log.warn('ignored activity.updated without session_id')
        return true
      }
      if (
        organizationId
        && currentOrganizationId
        && organizationId !== currentOrganizationId
      ) {
        return true
      }

      const workspaceId = typeof payload?.workspace_id === 'string' ? payload.workspace_id : null
      const projectId = typeof payload?.project_id === 'string' ? payload.project_id : null
      // Electron 桶键优先 workspace（个人执行现场），其次 project。
      const spaceId = workspaceId || projectId
      if (!spaceId) {
        log.warn('activity.updated missing workspace/project scope', {
          sessionId: sessionId.slice(0, 8),
        })
        return true
      }

      const asOptionalString = (value: unknown): string | null | undefined => {
        if (value === undefined) return undefined
        if (value === null) return null
        return typeof value === 'string' ? value : undefined
      }

      const patch: Partial<ChatSession> = {
        space_id: spaceId,
        workspace_id: workspaceId ?? undefined,
        project_id: projectId ?? undefined,
      }
      const title = asOptionalString(payload?.title)
      if (typeof title === 'string') patch.title = title
      const status = asOptionalString(payload?.status)
      if (typeof status === 'string') {
        patch.status = status as ChatSession['status']
      }
      const agentId = asOptionalString(payload?.agent_id)
      if (typeof agentId === 'string') patch.agent_id = agentId
      const agentName = asOptionalString(payload?.agent_name)
      if (agentName !== undefined) patch.agent_name = agentName
      const agentAvatar = asOptionalString(payload?.agent_avatar)
      if (agentAvatar !== undefined) patch.agent_avatar = agentAvatar

      //  列表可见性契约：has_messages 优先，其次 message_count。
      // 旧后端两者皆缺但有 last_message_at 时，shim 成 count=1 + has_messages=true。
      const rawHasMessages = payload?.has_messages
      if (typeof rawHasMessages === 'boolean') {
        patch.has_messages = rawHasMessages
      }
      const rawMessageCount = payload?.message_count
      if (
        typeof rawMessageCount === 'number'
        && Number.isFinite(rawMessageCount)
        && rawMessageCount >= 0
      ) {
        patch.message_count = Math.floor(rawMessageCount)
      }
      const lastMessageAt = asOptionalString(payload?.last_message_at)
      if (lastMessageAt !== undefined) patch.last_message_at = lastMessageAt
      if (
        patch.has_messages === undefined
        && patch.message_count === undefined
        && typeof lastMessageAt === 'string'
        && lastMessageAt.length > 0
      ) {
        patch.message_count = 1
        patch.has_messages = true
      } else if (
        patch.has_messages === undefined
        && typeof patch.message_count === 'number'
      ) {
        patch.has_messages = patch.message_count > 0
      } else if (
        patch.message_count === undefined
        && typeof patch.has_messages === 'boolean'
      ) {
        patch.message_count = patch.has_messages ? 1 : 0
      }

      const updatedAt = asOptionalString(payload?.updated_at)
      if (typeof updatedAt === 'string') patch.updated_at = updatedAt
      const createdAt = asOptionalString(payload?.created_at)
      if (typeof createdAt === 'string') patch.created_at = createdAt
      const threadId = asOptionalString(payload?.thread_id)
      if (typeof threadId === 'string') patch.thread_id = threadId
      if (payload?.is_agent_mention_session === true) {
        patch.is_agent_mention_session = true
      }

      const sessionAccess = getChatSessionAccess()
      if (!sessionAccess) {
        log.warn('activity.updated skipped: chat session access not registered', {
          sessionId: sessionId.slice(0, 8),
        })
        return true
      }
      // setSessionFields → updateSessionInCaches（含  活动字段重排 / 未知会话 upsert）
      sessionAccess.setSessionFields(sessionId, patch)
      logger.info(
        `[Chat API] ${ChatSessionEvents.ACTIVITY_UPDATED} session=${sessionId.slice(0, 8)}… reason=${String(payload?.reason ?? '')} space=${spaceId.slice(0, 8)}…`,
      )
      return true
    }

    case UserEvents.TITLE_UPDATED: {
      const payload = envelope.payload as { session_id?: string; title?: string } | undefined
      const sessionId = payload?.session_id
      const title = payload?.title
      if (sessionId && typeof title === 'string') {
        logger.info(
          `[Chat API] ${UserEvents.TITLE_UPDATED} session=${sessionId.slice(0, 8)}… title=${JSON.stringify(title)}`,
        )
        const cbs = getChatStoreCallbacks()
        if (cbs) {
          if (cbs.shouldApplyGeneratedTitleUpdate?.(sessionId, title) === false) {
            logger.info(
              `[Chat API] ${UserEvents.TITLE_UPDATED} skipped because manual title wins session=${sessionId.slice(0, 8)}…`,
            )
            return true
          }
          // 显式 bumpUpdatedAt: false——LLM 后台异步生成标题是运维路径，不该把
          // 老会话提到"今天"分组。后端 generate_session_title_task 也专门用
          // update_fields=['title', ...] 不带 updated_at，前端这层必须配合。
          cbs.updateSessionTitleInCaches(sessionId, title, { bumpUpdatedAt: false })
        } else {
          // 跟 WS resume overflow 对称：register 前的边角情况留痕便于排查，
          // 而不是完全静默丢失标题更新。
          logger.warn('[Chat API] TITLE_UPDATED skipped: chat store callbacks not registered yet')
        }
      }
      return true
    }

    case UserEvents.SESSION_CREATED: {
      const payload = envelope.payload as {
        space_id?: string
        session?: ChatSession
      } | undefined
      const spaceId = payload?.space_id
      const sessionId = payload?.session?.id
      // 纵深防御：即使旧服务端仍广播完整 schema/id，非责任端也不得 upsert。
      logger.info(
        `[Chat API] ${UserEvents.SESSION_CREATED} ignored (privacy) space=${(spaceId ?? '').slice(0, 8)}… session=${(sessionId ?? '').slice(0, 8)}…`,
      )
      return true
    }

    case UserEvents.PERMISSION_CHANGED: {
      const payload = envelope.payload as { organization_id?: string; space_id?: string } | undefined
      logger.info(
        `[Chat API] ${UserEvents.PERMISSION_CHANGED} organization=${(payload?.organization_id ?? '').slice(0, 8)}… space=${(payload?.space_id ?? '').slice(0, 8)}…`,
      )
      // 后端 broadcast_permission_changed 触发场景包括：成员角色变更
      // (organization_service.update_member_role)、所有权转移、Space 成员角色变化
      // (access_service)。下面三个 query key 域覆盖用户感知的 react-query 视图：
      //   - membership: 当前用户在 organization 的角色 / 套餐 / 钱包
      //   - members: organization / Space 成员列表面板
      //   - memberBudget: 成员预算策略 / 用量统计（角色变化常带预算调整）
      void queryClient.invalidateQueries({ queryKey: membershipKeys.all })
      void queryClient.invalidateQueries({ queryKey: memberKeys.all })
      void queryClient.invalidateQueries({ queryKey: memberBudgetKeys.all })
      // zustand 侧的 currentUserRole / selectedOrganization.owner_id 也要回读：
      // 加入/移出组织有 ``organization.membership_changed`` 兜底，但角色变更 /
      // 所有权转让不改成员集合、membership_changed 不触发；若不回读，新 owner
      // 的设置页 owner 门禁（读 zustand）要等下一次偶发全量刷新才生效（分钟级）。
      const organizationId = payload?.organization_id
      if (organizationId) {
        schedulePermissionAccessRefresh(organizationId)
      }
      return true
    }

    case UserEvents.NOTIFICATION_NEW:
      // 由 useNotificationEventStream hook 内部的 listener 处理（保留 hook 层
      // 的 detached / hasMainWindowHost enabled 守卫语义）；router 不重复路由
      // 但仍声明短路，避免误进 background bucket。
      return true

    case UserEvents.INTERACTION_RESOLVED:
    case UserEvents.INTERACTION_EXPIRED: {
      // 收敛 team-space owner 专属审批面板（pendingApprovalBySessionId /
      // pendingAskUserBySessionId）——会话列表「待处理」pill 与面板同源，随之熄灭。
      handlePendingInteractionTerminalEvent(envelope as Parameters<typeof handlePendingInteractionTerminalEvent>[0])
      return true
    }

    case UserEvents.INTERACTION_REQUESTED: {
      // Project 审批详情不能走共享 thread stream；owner 专属 user event
      // 承载完整 payload，并在这里打开 owner 可操作的审批面板（pill 由此面板态派生）。
      handlePendingInteractionRequestedEvent(envelope as Parameters<typeof handlePendingInteractionRequestedEvent>[0])
      return true
    }

    case UserEvents.PROJECT_TASK_INVALIDATED: {
      const payload = envelope.payload as {
        project_id?: string
        task_id?: string
        event_type?: string
        version?: number
      } | undefined
      const projectId = payload?.project_id
      const taskId = payload?.task_id
      const version = typeof payload?.version === 'number'
        ? payload.version
        : Number(payload?.version)
      if (projectId && taskId && Number.isFinite(version)) {
        logger.info(
          `[Chat API] ${UserEvents.PROJECT_TASK_INVALIDATED} project=${projectId.slice(0, 8)}… task=${taskId.slice(0, 8)}… event=${payload?.event_type ?? ''} version=${version}`,
        )
        void import('@/stores/useProjectTaskStore').then(({ useProjectTaskStore }) => {
          useProjectTaskStore.getState().applyInvalidation({
            project_id: projectId,
            task_id: taskId,
            event_type: typeof payload?.event_type === 'string' ? payload.event_type : '',
            version,
          })
        })
      }
      return true
    }

    default:
      return false
  }
}

/**
 * 重置 chat client 时一并清空事件桶，避免新会话继承旧用户的队列。
 * 调用方：sessionResetRegistry 的 teardown 阶段（登出、token 失效）。
 */
export function clearBackgroundEventBuckets(): void {
  useBackgroundEventStore.getState().clearAll()
  clearPendingPermissionAccessRefreshes()
}
