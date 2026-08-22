/**
 * 跨 Organization 关键事件 toast 通知。
 *
 * 处理范围：stream 级"需要人工确认"事件——这些事件仅经 `agent.stream.{thread_id}`
 * topic 推送，不走 user 通道：
 *   - `agent.stream.approval_requested`（v0.4 W1.5：批量审批 HITL）
 *   - `agent.stream.ask_user_required`（W4 / 2026-05-11：ask 三件套合一为单 ask_user，多选问答 HITL）
 *
 * 当用户不在该事件所属 organization 的前台时，useBackgroundEventStore 会把事件入桶；
 * 本 notifier 订阅这些非前台事件，弹一条 toast 提示用户切到对应团队处理。
 *
 * 历史背景：早期（Wave 5/6/7）曾有"跨 wt 任务通知"机制（user.{userId} 通道 +
 * useGlobalTaskMonitor + 角标 + 离线 inbox 补送 + offline_recovery_hint 弹框），
 * 但该机制信息密度极低且充满兜底兜底再兜底。2026-05 整套删除：每个具体入口
 * （会话 / Agenda / Agent）打开时自然加载状态，不再依赖事件流补送。
 * 本 notifier 是仅存的"非前台 stream 级关键事件"toast 路径。
 *
 * toast id 包含 envelope.event_id 避免同事件多次入桶时重复弹（enqueue → drain 重放）。
 */

import { useBackgroundEventStore, type BackgroundEnvelope } from '@/stores/useBackgroundEventStore'
import { useOrganizationStore } from '@tabtin/app-shell'
import { toast } from '@tabtin/smartsheet-ui/toast'
import i18n from '@/i18n'
import { logger } from '@/utils/logger'

/**
 * 保留空集合 + 函数为未来扩展留接口（如 daemon 设备失败之类不走 user 通道的事件）。
 */
const CRITICAL_FAILURE_TYPES: ReadonlySet<string> = new Set<string>([])

/**
 * stream 级"需要人工确认"事件——这些事件仅经 `agent.stream.{thread_id}` topic
 * 推送，不走 user 通道：
 * - `agent.stream.approval_requested`：v0.4 W1.5 批量审批 HITL（per-thread topic）
 * - `agent.stream.ask_user_required`：W4（2026-05-11）合一形态——ask 三件套合并为单
 *   ask_user 工具，多选问答 HITL。
 */
const CRITICAL_APPROVAL_TYPES: ReadonlySet<string> = new Set([
  'agent.stream.approval_requested',
  'agent.stream.ask_user_required',
])

function isAgentRunFailure(envelope: BackgroundEnvelope): boolean {
  if (typeof envelope.type !== 'string') return false
  return CRITICAL_FAILURE_TYPES.has(envelope.type)
}

function isReviewOrActionRequired(envelope: BackgroundEnvelope): boolean {
  if (typeof envelope.type !== 'string') return false
  return CRITICAL_APPROVAL_TYPES.has(envelope.type)
}

function organizationName(organizationId: string): string {
  const wt = useOrganizationStore.getState().organizations.find((w) => w.id === organizationId)
  return wt?.name ?? i18n.t('organization:unnamed', { defaultValue: '组织' })
}

/**
 * 生成稳定的 toast id（避免快速触发时 Date.now() 冲突导致 toast 互相覆盖）。
 *
 * 优先级：envelope.event_id > request_id > thread_id+type > 随机后缀
 */
function buildToastId(
  prefix: string,
  organizationId: string,
  envelope: BackgroundEnvelope,
): string {
  const eventId = typeof envelope.event_id === 'string' && envelope.event_id
    ? envelope.event_id
    : null
  if (eventId) return `${prefix}-${organizationId}-${eventId}`

  const requestId = typeof (envelope as { request_id?: unknown }).request_id === 'string'
    ? ((envelope as { request_id?: string }).request_id ?? '')
    : ''
  if (requestId) return `${prefix}-${organizationId}-${requestId}`

  const threadId = typeof (envelope as { thread_id?: unknown }).thread_id === 'string'
    ? ((envelope as { thread_id?: string }).thread_id ?? '')
    : ''
  const type = typeof envelope.type === 'string' ? envelope.type : 'unknown'
  if (threadId) return `${prefix}-${organizationId}-${threadId}-${type}`

  // fallback：Date.now + 短随机段，避免 Date.now 同毫秒冲突
  const salt = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${organizationId}-${type}-${Date.now()}-${salt}`
}

/**
 * 模块级单例注册状态。
 *
 * 设计语义：`registerCriticalBackgroundEventNotifier` **仅在 renderer 首次
 * 加载时被调用一次**（由 `chatApi.getChatClient` 承担），listener 挂在
 * `useBackgroundEventStore` 的模块级闭包上，生命周期 = renderer 全生命周期。
 *
 * 登出 / token 失效 → `chatClientSingleton.resetChatClient` 只清 buffer，
 * 不动 listener：用户重登后 criticalNotifier 无需重挂。
 *
 * 为此：
 *   - `register` 重复调用为 no-op（返回空 unsubscribe），避免 Wave 5 扩展时
 *     有人在其他初始化路径里二次调用导致重复 listener
 *   - 生产代码**禁止**调用返回的 unsubscribe（只给测试用 `__reset...ForTest`）
 *   - 这样设计后不再依赖"调用方是否持有并调用 unsubscribe"这种脆弱约定
 */
let _registered = false
let _activeUnsubscribe: (() => void) | null = null

export function registerCriticalBackgroundEventNotifier(): () => void {
  if (_registered) {
    // 二次调用无副作用，返回空 unsubscribe。正常流程不应触发；仅
    // 给了热重载 / 多次初始化兜底（不会重复挂载 listener）。
    logger.debug('[CriticalNotifier] already registered, skipping')
    return () => {}
  }
  _registered = true

  const unsubscribe = useBackgroundEventStore.getState().subscribe((organizationId, envelope) => {
    try {
      if (isAgentRunFailure(envelope)) {
        toast({
          id: buildToastId('bg-agent-run-failed', organizationId, envelope),
          title: i18n.t('chat:notifier.agentRunFailed.title', {
            defaultValue: 'Agent 任务失败',
          }),
          description: i18n.t('chat:notifier.agentRunFailed.desc', {
            defaultValue: '「{{name}}」中一个 Agent 任务失败，切到该组织查看详情',
            name: organizationName(organizationId),
          }),
          duration: 8000,
        })
        logger.info('[CriticalNotifier] agent.run failure toast', {
          organizationId,
          type: envelope.type,
        })
        return
      }

      if (isReviewOrActionRequired(envelope)) {
        toast({
          id: buildToastId('bg-approval-required', organizationId, envelope),
          title: i18n.t('chat:notifier.reviewRequired.title', {
            defaultValue: 'Agent 需要你确认',
          }),
          description: i18n.t('chat:notifier.reviewRequired.desc', {
            defaultValue: '「{{name}}」中有一个 Agent 等待你审批，切到该组织处理',
            name: organizationName(organizationId),
          }),
          duration: 10000,
        })
        logger.info('[CriticalNotifier] approval_requested toast', {
          organizationId,
          type: envelope.type,
        })
      }
    } catch (err) {
      logger.warn('[CriticalNotifier] toast dispatch failed', err)
    }
  })

  _activeUnsubscribe = unsubscribe

  // 生产代码不消费这个返回值；保留 unsubscribe 仅给 test helper
  return () => {
    // 生产环境禁调：调了也不让 _registered 复位，防止 Wave 5 误改出
    // "重新 register 但 listener 挂了两个" 的竞态
    logger.warn(
      '[CriticalNotifier] unsubscribe invoked in production code — this is intentionally a no-op; use __resetCriticalNotifierRegistrationForTest() in tests instead',
    )
  }
}

/** Test-only: 重置注册状态以便测试隔离（会真正解绑当前 listener）。 */
export function __resetCriticalNotifierRegistrationForTest(): void {
  if (_activeUnsubscribe) {
    _activeUnsubscribe()
    _activeUnsubscribe = null
  }
  _registered = false
}
