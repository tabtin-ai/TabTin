/**
 * `useChatStore` 反向访问 callback 注册中心（中立 leaf 模块）。
 *
 * ## 为什么要这个 leaf？
 *
 * `chatApi` / `useChatModelStore` 等模块都需要从 `useChatStore` 读写状态，
 * 但**不能**顶部静态 import `useChatStore` —— 否则 madge 会报循环依赖
 * （`useChatStore` 顶部已经反向 import 它们）。
 *
 * 把 callback registry 放在中立 leaf 里：
 *
 * ```
 * chatApi              ─┐
 * useChatModelStore    ─┼─→ storeAccessRegistry  ←─  useChatStore（注入实现）
 * （未来其他需求方）     ─┘
 * ```
 *
 * 三方都单向依赖 leaf，无循环。`useChatStore` 在 module body 末尾通过
 * `register*` 注入实现；其他模块通过 `get*` 读出实现。
 *
 * ## 时机保证
 *
 * register 真正的时序保障来自 **ESM 加载图**：当前代码里
 * `chatApi → membershipEventHandler → useChatStore → chatApi` 形成一个
 * 良性 ESM 加载环，加载顺序保证 `useChatStore` module body 末尾的
 * `registerXxx(...)` 在 `chatApi` 自身的 `getApiRuntimeConfig` /
 * `getChatClient` 等使用 callback 的代码路径之前完成。
 *
 * 同时所有 callback 都是在用户事件 / IPC / WS envelope 触发后才被调用，
 * 时机晚于全部 module 初始化阶段。
 *
 * **未来 refactor 注意**：如果 `chatApi → membershipEventHandler →
 * useChatStore` 这条 ESM 加载链被破坏（例如 chatApi 不再依赖
 * membershipEventHandler，或者 membershipEventHandler 不再依赖 useChatStore），
 * register 时序就失去保障，`getXxx()` 可能在 callback 调用时返回 `null`。
 * 因此设计上：
 *   - 所有 caller 都用 `getXxx()?.method(...)` 链式调用，null 时静默降级；
 *   - 重要的降级路径（如 WS resume overflow）会在 console.warn 留痕，便于
 *     未来排查"register 之前就被调用"的实际故障。
 */

import type { ChatMessage, ChatSession, ReviewRequiredEventData } from '@tabtin/chat-client'
import type {
  ApprovalRequestState,
  AskUserRequestState,
} from './types'

// ============================================================================
// chatApi → useChatStore 的访问
// ============================================================================

/**
 * `chatApi` 通过这些回调访问 `useChatStore` 状态：
 *
 * - `streamingChecker` 注入给 ChatClient.isStreaming 做 SSoT 判定；
 * - WS resume overflow 时按 streaming 列表重同步消息；
 * - background bucket router 按 sessionsBySpaceId 反查 envelope 的 organization_id；
 * - user-level `agent.user.title_updated` 事件写 sessions 标题缓存；
 * - user-level `agent.user.session_created` 事件 upsert Project 会话列表。
 */
export interface ChatStoreCallbacks {
  isSessionBusy: (sessionId: string) => boolean
  /** 用户级 run_state 广播写入运行时投影；由组合根注入，避免 chatApi 反向 import store。 */
  applySessionRunStateEvent: (sessionId: string, runState: unknown) => boolean
  getStreamingSessionIds: () => string[]
  getCurrentSessionId: () => string | null
  syncSessionMessagesFromServer: (sessionId: string) => void
  getSessionsBySpaceId: () => Record<string, ChatSession[]>
  updateSessionTitleInCaches: (
    sessionId: string,
    title: string,
    opts?: { bumpUpdatedAt?: boolean },
  ) => void
  shouldApplyGeneratedTitleUpdate?: (sessionId: string, title: string) => boolean
  /** Project WS session_created → 已加载桶 prepend 新会话（去重）。 */
  upsertSessionInSpace: (spaceId: string, session: ChatSession) => void
  /** 注入错误气泡（按 content + isErrorMessage 去重）。 */
  injectErrorBubble: (sessionId: string, message: ChatMessage) => void
  /** 观察端注入 user 消息（多键去重）。 */
  upsertObservedUserMessage: (sessionId: string, message: ChatMessage) => void
  /** 落库 id 回填：补 metadata.message_id = 服务端 id。 */
  linkServerMessageId: (sessionId: string, localMessageId: string, serverId: string) => void
  /** synthetic user 消息 id 收敛：把 (旧 id → server id) 对重绑到消息列表。 */
  rebindMessageIds: (
    sessionId: string,
    idPairs: ReadonlyArray<readonly [oldId: string, newId: string]>,
  ) => void
}

let _chatStoreCallbacks: ChatStoreCallbacks | null = null

/** @internal 由 `useChatStore.ts` module body 末尾调用。 */
export function registerChatStoreCallbacks(cbs: ChatStoreCallbacks): void {
  _chatStoreCallbacks = cbs
}

export function getChatStoreCallbacks(): ChatStoreCallbacks | null {
  return _chatStoreCallbacks
}

// ============================================================================
// useChatModelStore → useChatStore 的访问
// ============================================================================

/**
 * `useChatModelStore` 通过这些回调访问 `useChatStore` 状态：
 *
 * - `switchModel` / `switchContextTier` 调 `setSessionFields` 写
 *   ChatSession 字段（普通会话与 Tracker Run 缓存同步由 `useChatStore` 内部封装）；
 * - `getCurrentModel` / `syncTierForActiveSession` 通过 `getCurrentSessionId`
 *   + `getSessionById` 读当前 session。
 */
export interface ChatSessionAccess {
  getCurrentSessionId: () => string | null
  getSessionById: (sessionId: string) => ChatSession | undefined
  /**
   * 把 partial 字段合并到 ChatSession，并同步普通会话与 Tracker Run 缓存。
   * caller 不需要操心会话所在的具体分桶。
   */
  setSessionFields: (sessionId: string, fields: Partial<ChatSession>) => void
  /** 永久写失败后撤销乐观态，并回读该会话所在 Space 的服务端列表。 */
  refreshSessionFromServer?: (sessionId: string) => void
}

let _sessionAccess: ChatSessionAccess | null = null

/** @internal 由 `useChatStore.ts` module body 末尾调用。 */
export function registerChatSessionAccess(access: ChatSessionAccess): void {
  _sessionAccess = access
}

export function getChatSessionAccess(): ChatSessionAccess | null {
  return _sessionAccess
}

// ============================================================================
// streamMessageHandler / hitlStreamHandlers → useChatStore HITL 状态
// ============================================================================

export interface HitlStoreSlice {
  pendingApprovalBySessionId: Record<string, ApprovalRequestState>
  approvalSubmittingBySessionId: Record<string, boolean>
  pendingAskUserBySessionId: Record<string, AskUserRequestState>
  askUserSubmittingBySessionId: Record<string, boolean>
}

export interface HitlStoreAccess {
  getState: () => HitlStoreSlice
  applyState: (
    partial:
      | Partial<HitlStoreSlice>
      | ((state: HitlStoreSlice) => Partial<HitlStoreSlice>),
  ) => void
  upsertHitlBubble: (sessionId: string, placeholderMessageId: string | null | undefined, bubble: ChatMessage) => void
  buildReviewMessage?: (data: ReviewRequiredEventData) => string
}

let _hitlStoreAccess: HitlStoreAccess | null = null

/** @internal 由 `useChatStore.ts` module body 末尾调用。 */
export function registerHitlStoreAccess(access: HitlStoreAccess): void {
  _hitlStoreAccess = access
}

export function getHitlStoreAccess(): HitlStoreAccess | null {
  return _hitlStoreAccess
}

/** Test-only：重置 HITL store access。 */
export function __resetHitlStoreAccessForTest(): void {
  _hitlStoreAccess = null
}
