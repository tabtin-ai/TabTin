/** @store-category session */

/**
 * 非前台 Organization 事件分桶 Store（Wave 3）
 *
 * Wave 3 的连接模型已变成「连接绑用户」：一条 WS 会同时承载用户所属全部
 * organization 的订阅权限，切换 organization 只是前端状态切换，旧 organization 的流式
 * 事件仍会持续下发到本客户端。
 *
 * 为保证：
 *   1) 非前台 organization 的事件不触发 React 渲染（避免打断用户当前关注的页面）；
 *   2) 切回时仍能批量 replay 事件，让侧边栏角标、任务进度等 UI 迅速反映
 *      后台任务状态；
 *   3) 为 Wave 5 的「跨 Organization 任务通知」铺好消费入口，
 *
 * 这里维护一个 per-organization ring buffer（FIFO 截断），配合
 * {@link onForegroundOrganizationChanged} 在切换时触发 replay。
 *
 * ⚠️ 本 store 只承担「缓存 + replay + consumer 入口」三件事，不做业务语义解析。
 * 消费端（如 `criticalEventNotifier`）通过 subscribe 感知新事件。
 */

import { create } from 'zustand'
import { logger } from '@/utils/logger'

/** 事件 envelope 的最小契约（与 WsGatewayClient onEvent 的类型保持兼容）。 */
export interface BackgroundEnvelope {
  type?: string
  payload?: Record<string, unknown> | null
  organization_id?: string | null
  space_id?: string | null
  event_id?: string
  [key: string]: unknown
}

/** 每个 organization 最多缓存的 envelope 数量（超出走 FIFO 截断，保留最新）。 */
const PER_ORGANIZATION_BUFFER_LIMIT = 100

/**
 * 事件类型白名单：仅这些事件会入队，避免缓存 heartbeat 等噪音。
 *
 * ⚠️ 这里匹配的是**envelope.type 前缀**（不是 topic 名）。两者不能混淆：
 *   - `tracker.events.{wt}` 是 *topic 名*；envelope.type 是 `tracker.run.completed` / `tracker.progress` 等
 *
 * 用户级事件（``agent.user.*``，含 title_updated / notification.new /
 * permission.changed）**不入桶**——它们由 chatApi.ts::handleUserLevelEnvelope
 * 与 useNotificationEventStream 直接消费，且语义上是用户级（无 organization 维度），
 * 进 per-organization 桶毫无意义。详见 W2 用户级事件治理总控。
 *
 * 真实 envelope.type 见后端 `apps/services/common/agent_protocol/constants.py`：
 *   - `AgentStreamEvent.*`：`agent.stream.{lifecycle|assistant|reasoning|tool|step|done|approval_requested|approval_resolved|ask_user_required|...}`
 *   - `AgentActionEvent.*`：`agent.action.{request|result|approval_request|approval_response|resolved|...}`
 *   - `TrackerEvent.*`：`tracker.{progress|run.started|run.completed|run.failed|notification|health_alert|trigger.filtered}`
 *     （Wave 2 续作 charter v1.8 §6.4：单 Skill 执行模型下不再有「步骤」概念，
 *     已删除 `step.*` / `checkpoint`）
 *   - Billing / Extension 等事件目前走具体业务名（详见下方注释）
 *
 * 下面的前缀是**真实 envelope.type 的最小覆盖集合**：
 */
const QUEUEABLE_EVENT_TYPE_PREFIXES = [
  // agent.stream.approval_requested / approval_resolved / ask 三件套 —— 高价值阻塞事件，必须入桶
  // ContentBlock 6 件套 (message_* / content_block_*) 等流式 delta
  //   **故意不入桶**：PRD §4.5 明确说 StreamManager 实时进 useChatStore、不依赖
  //   replay。入桶只会让 100 条 FIFO 被流式 delta 挤占、把低频关键事件（approval_*
  //   / persist_error 等）挤出队列。这里用 prefix 精准挑出需要缓存的子类型。
  // W4.5 第三波 C1（2026-05-13）：移除 `'agent.stream.tool_timeout'` 队列条目，
  //   wire 层 `StreamEvents.TOOL_TIMEOUT` 物理删，事件已不再产生。
  'agent.stream.approval_requested',
  'agent.stream.approval_resolved',
  // W4 (2026-05-11): ask 三件套合一为 ask_user_required，多选问答 HITL。
  'agent.stream.ask_user_required',
  'agent.stream.persist_error',
  'agent.stream.system_notice',
  'agent.stream.subagent_failed',
  'agent.stream.lifecycle', // 仅缓存终态 end/error 事件（enqueue 无法识别，由 critical notifier 过滤）
  // agent.run.* —— 任务级状态变化（PRD §4.6 要求 Wave 5 后端补推 status_changed）
  'agent.run.',
  'agent.action.result',
  // 资源域 —— topic / envelope.type 共用 `{domain}.events.` 前缀
  'table.events.',
  'doc.events.',
  'slide.events.',
  'docparse.events.',
  'context.sync.',
  // Tracker —— envelope.type 为 `tracker.*`（不是 topic 名 `tracker.events`）
  // 波次 4 Stage 2 一刀切：legacy `goal.*` prefix 已下线
  'tracker.',
  // Billing —— envelope.type 为 `billing.*`（不是 `billing.events.`）
  'billing.',
  // Extension —— envelope.type 为 `extension.*`（不是 `extension.events.`）
  'extension.',
  // Membership —— 完整事件名（无后续子类）
  'organization.membership_changed',
]

export type BackgroundEventListener = (
  organizationId: string,
  envelope: BackgroundEnvelope,
) => void

interface BackgroundEventState {
  /** 按 organization_id 分桶的事件队列；nullish / 空字符串的 organization_id 不入桶。 */
  buffersByOrganizationId: Record<string, BackgroundEnvelope[]>

  enqueue: (organizationId: string, envelope: BackgroundEnvelope) => void
  /** 取出并清空指定 organization 的队列，返回按时间顺序的副本。 */
  drain: (organizationId: string) => BackgroundEnvelope[]
  /** 只读快照，不影响队列状态（用于 Wave 5 的角标聚合）。 */
  peek: (organizationId: string) => readonly BackgroundEnvelope[]
  /** 事件数量（O(1)）。 */
  count: (organizationId: string) => number
  /** 清空指定 organization（Wave 3 membership 被移出时使用）。 */
  clearOrganization: (organizationId: string) => void
  /** 清空全部缓存；**不**影响 subscribe 的 listeners（登出 / 链路重置使用）。 */
  clearAll: () => void

  /**
   * 订阅新事件，返回 unsubscribe 函数。Wave 5 的角标 / 系统通知消费端挂载
   * 这里。listener 由模块级闭包维护，不暴露在 state 里以防止被误
   * clearAll 清掉。
   */
  subscribe: (listener: BackgroundEventListener) => () => void
}

function shouldQueue(envelopeType: string | undefined): boolean {
  if (!envelopeType) return false
  return QUEUEABLE_EVENT_TYPE_PREFIXES.some((prefix) => envelopeType.startsWith(prefix))
}

// 模块级 listener 表：不作为 zustand state 的一部分，避免
//   (a) `.clear()` 被外部误用一次性清掉所有订阅；
//   (b) 未来接入 persist middleware 时序列化 Set<Function> 崩溃。
// 生命周期与 window/renderer 相同，登出只清 buffer，不清 listener。
const _backgroundEventListeners = new Set<BackgroundEventListener>()

function emitToListeners(organizationId: string, envelope: BackgroundEnvelope): void {
  for (const listener of _backgroundEventListeners) {
    try {
      listener(organizationId, envelope)
    } catch (err) {
      logger.warn('[BackgroundEventStore] listener threw', err)
    }
  }
}

export const useBackgroundEventStore = create<BackgroundEventState>((set, get) => ({
  buffersByOrganizationId: {},

  enqueue: (organizationId, envelope) => {
    if (!organizationId) return
    if (!shouldQueue(envelope.type)) return

    set((state) => {
      const prev = state.buffersByOrganizationId[organizationId] ?? []
      const next = prev.length >= PER_ORGANIZATION_BUFFER_LIMIT
        ? [...prev.slice(prev.length - PER_ORGANIZATION_BUFFER_LIMIT + 1), envelope]
        : [...prev, envelope]
      return {
        buffersByOrganizationId: {
          ...state.buffersByOrganizationId,
          [organizationId]: next,
        },
      }
    })

    emitToListeners(organizationId, envelope)
  },

  drain: (organizationId) => {
    if (!organizationId) return []
    const buf = get().buffersByOrganizationId[organizationId]
    if (!buf || buf.length === 0) return []
    set((state) => {
      const nextMap = { ...state.buffersByOrganizationId }
      delete nextMap[organizationId]
      return { buffersByOrganizationId: nextMap }
    })
    return buf.slice()
  },

  peek: (organizationId) => {
    if (!organizationId) return []
    return get().buffersByOrganizationId[organizationId] ?? []
  },

  count: (organizationId) => {
    if (!organizationId) return 0
    const buf = get().buffersByOrganizationId[organizationId]
    return buf ? buf.length : 0
  },

  clearOrganization: (organizationId) => {
    if (!organizationId) return
    set((state) => {
      if (!state.buffersByOrganizationId[organizationId]) return state
      const nextMap = { ...state.buffersByOrganizationId }
      delete nextMap[organizationId]
      return { buffersByOrganizationId: nextMap }
    })
  },

  clearAll: () => set({ buffersByOrganizationId: {} }),

  subscribe: (listener) => {
    _backgroundEventListeners.add(listener)
    return () => {
      _backgroundEventListeners.delete(listener)
    }
  },
}))

/** Test-only：清空全部 listeners。生产代码 **禁止** 调用。 */
export function __resetBackgroundEventListenersForTest(): void {
  _backgroundEventListeners.clear()
}

/**
 * 切换前台 organization 时的清理钩子。
 *
 * 本 Wave 的行为：
 *   - 新前台 organization 的队列直接 drain（避免切回后累积）；
 *   - 目前 Wave 3 不做 per-envelope replay——因为 StreamManager 的 slot
 *     在 WS 不断连的前提下始终持有订阅，agent.stream 事件会**实时**进入
 *     useChatStore（不会丢），而 resource/table 等事件在用户重新订阅
 *     对应 space/organization topic 时会从后端拉取最新快照。队列在 Wave 3
 *     里仅作为 Wave 5 的「积压信号」——drain 的内容可供调用方做一次性汇总。
 *   - 返回 drained 事件数组，便于 Wave 5 扩展做 toast / 角标归零。
 */
export function onForegroundOrganizationChanged(
  _prevForegroundId: string | null,
  nextForegroundId: string | null,
): BackgroundEnvelope[] {
  if (!nextForegroundId) return []
  const drained = useBackgroundEventStore.getState().drain(nextForegroundId)
  if (drained.length > 0) {
    logger.debug(
      '[BackgroundEventStore] foreground switched, drained queue:',
      { organizationId: nextForegroundId, count: drained.length },
    )
  }
  return drained
}

/**
 * 解析 envelope 归属的 organization_id。按优先级依次尝试：
 *   1. 顶层 `envelope.organization_id`（auth / channel / device.capabilities.refresh 等会携带）
 *   2. `envelope.payload.organization_id`（业务 payload 约定携带的场景）
 *   3. 通过 `envelope.thread_id` 反查 `useChatStore.sessionsBySpaceId` 找 ChatSession.organization_id
 *      —— 后端 `ChatStreamPublisher.publish_ws` 当前只把 `thread_id` 放 envelope 顶层，
 *      `organization_id` 不注入。前端靠本地会话缓存反查是零成本、零 DB 的 fallback
 *
 * ⚠️ 传入 `organizationIdResolver` 允许调用方自注入解析器（默认从 useChatStore 反查），
 * 让 store 文件不直接 import 上游 store，便于测试和解耦。
 */
export type OrganizationIdResolver = (
  envelope: BackgroundEnvelope,
) => string | null

let _externalResolver: OrganizationIdResolver | null = null

/** 注册 fallback 解析器（chatApi.ts 在启动时注入基于 useChatStore 的反查）。 */
export function registerBackgroundOrganizationIdResolver(
  resolver: OrganizationIdResolver | null,
): void {
  _externalResolver = resolver
}

export function resolveEnvelopeOrganizationId(
  envelope: BackgroundEnvelope,
): string | null {
  if (!envelope || typeof envelope !== 'object') return null

  const fromEnvelope = typeof envelope.organization_id === 'string' && envelope.organization_id.length > 0
    ? envelope.organization_id
    : null
  if (fromEnvelope) return fromEnvelope

  const payload = envelope.payload as Record<string, unknown> | null | undefined
  if (payload && typeof payload === 'object') {
    const fromPayload = payload.organization_id
    if (typeof fromPayload === 'string' && fromPayload.length > 0) {
      return fromPayload
    }
  }

  if (_externalResolver) {
    try {
      const fromResolver = _externalResolver(envelope)
      if (typeof fromResolver === 'string' && fromResolver.length > 0) {
        return fromResolver
      }
    } catch (err) {
      logger.warn('[BackgroundEventStore] external resolver threw', err)
    }
  }

  return null
}

/**
 * Gateway 全局 listener 入口：按 envelope 的 organization_id 路由到桶；
 * 当前前台 organization 不入桶（仍由 StreamManager / useGatewayTopic 等正常消费）。
 *
 * 返回 true 表示事件被入桶（非前台）；false 表示事件未入桶（前台或无法归属）。
 */
export function routeEnvelopeToBackgroundBucket(
  envelope: BackgroundEnvelope,
  currentForegroundOrganizationId: string | null,
): boolean {
  const rawOrganizationId = resolveEnvelopeOrganizationId(envelope)
  if (!rawOrganizationId) return false
  if (rawOrganizationId === currentForegroundOrganizationId) return false
  useBackgroundEventStore.getState().enqueue(rawOrganizationId, envelope)
  return true
}
