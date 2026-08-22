/**
 * useGatewayTopic — Gateway 主题订阅基础 Hook
 *
 * 统一处理 WS Gateway 的 connect / subscribe / reconnect / cleanup 生命周期，
 * 消除各 EventStream hooks 中的重复逻辑。
 *
 * 内置 organization 就绪守卫：Gateway 认证依赖 organizationId，
 * 本 hook 自动感知 organization 状态，organization 未就绪时保持 idle，
 * 就绪后自动连接，切换后自动重连。调用方无需重复检查。
 *
 * 调用方仅需关注：
 * - topic: 要订阅的主题
 * - onEvent: 收到 envelope 后的业务处理（过滤逻辑由调用方负责）
 * - onReconnected: 重连后的数据补偿
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { useWsConnectionStore } from '@/stores/useWsConnectionStore'
import { isGatewayMembershipReadyForOrganization } from '@/services/gatewayOrganizationMembership'
import { createLogger } from '@/utils/logger'
import { mainAgentGateway } from '@/services/mainAgentGateway'

const log = createLogger('GatewayTopic')

const DEDUP_CACHE_LIMIT = 200

// ：初始 connect / subscribe 失败（如 WS_REQUEST_TIMEOUT）不能一次放弃——
// 否则用户停留在会话里镜像流永久失联。带指数退避的有限次重试，
// 上限后维持 error 态（鉴权拒绝等确定性失败不值得无限打服务器）。
const SUBSCRIBE_MAX_RETRIES = 6
const SUBSCRIBE_RETRY_BASE_DELAY_MS = 2_000
const SUBSCRIBE_RETRY_MAX_DELAY_MS = 30_000

export type GatewayTopicStatus = 'idle' | 'connecting' | 'connected' | 'error'

export interface UseGatewayTopicOptions {
  topic: string | null
  enabled?: boolean
  subscriptionKey?: string | number | null
  onEvent?: (envelope: Record<string, unknown>) => void
  onReconnected?: () => void
  onStatusChange?: (status: GatewayTopicStatus, error?: string) => void
  logPrefix?: string
}

export interface UseGatewayTopicReturn {
  status: GatewayTopicStatus
}

interface TopicSubscriptionState {
  refCount: number
  subscribePromise: Promise<GatewayTopicSubscribeResult> | null
  unsubscribePromise: Promise<void> | null
}

export interface GatewayTopicSubscribeResult {
  ok: boolean
  code?: string
  message?: string
  retryable: boolean
}

const DEFINITIVE_SUBSCRIBE_FAILURE_CODES = new Set([
  'WS_1003_SCHEMA_INVALID',
  'WS_1004_TYPE_UNKNOWN',
  'WS_1005_PERMISSION_DENIED',
  'WS_1006_NOT_FOUND',
])

const TRANSIENT_SUBSCRIBE_FAILURE_CODES = new Set([
  'WS_CLIENT_NOT_READY',
  'WS_NOT_CONNECTED',
  'WS_DISCONNECTED',
  'WS_CLOSED',
  'WS_REQUEST_TIMEOUT',
  'WS_SEND_FAILED',
  'WS_SUBSCRIBE_THROWN',
  // 限流是典型的瞬态错误：网关是 10s / 100 条消息的滑动窗口，等一会儿必然放行。
  // 漏掉它会被判成 non-retryable，于是冷启动撞上限流的 topic 直到下次重连都收不到
  // 事件——账号 space 一多（每个 space 一条 tracker.events 订阅）就会稳定复现。
  'WS_1007_RATE_LIMITED',
])

function isDefinitiveSubscribeFailureCode(code?: string): boolean {
  return !!code && DEFINITIVE_SUBSCRIBE_FAILURE_CODES.has(code)
}

function isRetryableSubscribeFailureCode(code?: string): boolean {
  if (!code) return true
  if (isDefinitiveSubscribeFailureCode(code)) return false
  return TRANSIENT_SUBSCRIBE_FAILURE_CODES.has(code)
}

function getStringField(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function envelopeMatchesGatewayTopic(envelope: Record<string, unknown>, topic: string): boolean {
  const payload = envelope.payload && typeof envelope.payload === 'object'
    ? envelope.payload as Record<string, unknown>
    : undefined
  const envelopeTopic =
    getStringField(envelope, '_topic')
    ?? getStringField(envelope, 'topic')
    ?? getStringField(payload, '_topic')

  // Legacy/control envelopes may not carry a topic. Keep those on the old path
  // and let business handlers decide; all modern topic broadcasts carry _topic.
  if (!envelopeTopic) return true
  return envelopeTopic === topic
}

const topicSubscriptionStates = new Map<string, TopicSubscriptionState>()

function getTopicSubscriptionState(topic: string): TopicSubscriptionState {
  let state = topicSubscriptionStates.get(topic)
  if (!state) {
    state = {
      refCount: 0,
      subscribePromise: null,
      unsubscribePromise: null,
    }
    topicSubscriptionStates.set(topic, state)
  }
  return state
}

function cleanupTopicSubscriptionState(topic: string, state: TopicSubscriptionState): void {
  if (state.refCount <= 0 && !state.subscribePromise && !state.unsubscribePromise) {
    topicSubscriptionStates.delete(topic)
  }
}

export function retainGatewayTopic(topic: string): void {
  const state = getTopicSubscriptionState(topic)
  state.refCount += 1
}

export async function ensureGatewayTopicSubscribed(gateway: any, topic: string): Promise<GatewayTopicSubscribeResult> {
  const state = getTopicSubscriptionState(topic)

  if (state.unsubscribePromise) {
    await state.unsubscribePromise
  }

  if (state.subscribePromise) {
    return state.subscribePromise
  }

  state.subscribePromise = gateway
    .subscribe([topic])
    .then((result: { ok?: boolean; error?: { code?: string; message?: string } } | undefined) => {
      if (result?.ok) {
        return { ok: true, retryable: false }
      }
      const code = result?.error?.code
      return {
        ok: false,
        code,
        message: result?.error?.message ?? 'subscribe failed',
        retryable: isRetryableSubscribeFailureCode(code),
      }
    })
    .catch((error: unknown) => ({
      ok: false,
      code: 'WS_SUBSCRIBE_THROWN',
      message: error instanceof Error ? error.message : 'subscribe threw',
      retryable: true,
    }))
    .finally(() => {
      state.subscribePromise = null
      cleanupTopicSubscriptionState(topic, state)
    })

  return state.subscribePromise ?? Promise.resolve({
    ok: false,
    code: 'WS_CLIENT_NOT_READY',
    message: 'subscribe unavailable',
    retryable: true,
  })
}

export async function releaseGatewayTopic(gateway: any, topic: string): Promise<void> {
  const state = topicSubscriptionStates.get(topic)
  if (!state) return

  state.refCount -= 1
  if (state.refCount > 0) return

  if (state.unsubscribePromise) {
    await state.unsubscribePromise
    return
  }

  state.unsubscribePromise = (async () => {
    if (state.subscribePromise) await state.subscribePromise
    if (state.refCount > 0) return
    await gateway.unsubscribe([topic])
  })()
    .catch(() => {})
    .then(() => undefined)
    .finally(() => {
      state.unsubscribePromise = null
      cleanupTopicSubscriptionState(topic, state)
    })

  await state.unsubscribePromise
}

export interface SubscribeGatewayTopicHandlers {
  onEvent?: (envelope: Record<string, unknown>) => void
  onReconnected?: () => void
  onStatus?: (status: GatewayTopicStatus, error?: string) => void
  logPrefix?: string
}

/**
 * 命令式（非 React）的 gateway topic 订阅：connect → addListener → subscribe，
 * 内建重连补订阅 + 有限次退避重试 + event_id 去重，返回 unsubscribe。
 *
 * 这是 `useGatewayTopic` 的内核，同时供 agentService 的命令式来源接入
 * （`attachObserverSource`）复用——WS 订阅生命周期是纯运行时逻辑，不该只存在于 hook 里。
 * **org 就绪门控不在此**：调用方（hook / hub 薄绑定）负责在 org 就绪后才调用、org 切换时重订阅。
 */
export function subscribeGatewayTopic(
  topic: string,
  handlers: SubscribeGatewayTopicHandlers,
): () => void {
  const prefix = handlers.logPrefix ?? topic
  const recentEventIds = new Set<string>()
  let runActive = true
  let isActive = true
  let hasConnected = false
  let listener: ((envelope: any) => void) | null = null
  let reconnectHandler: (() => void) | null = null
  let retainedTopic: string | null = null
  let retryAttempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const setStatus = (s: GatewayTopicStatus, err?: string) => handlers.onStatus?.(s, err)

  const detachListeners = () => {
    try {
      if (listener) {
        mainAgentGateway.removeListener(listener)
        listener = null
      }
      if (reconnectHandler) {
        mainAgentGateway.offReconnectedEvent(reconnectHandler)
        reconnectHandler = null
      }
    } catch {
      // Gateway may not be initialized
    }
  }

  const scheduleConnectRetry = (reason: string) => {
    if (!runActive) return
    if (retryAttempt >= SUBSCRIBE_MAX_RETRIES) {
      log.error(`[${prefix}] giving up after ${retryAttempt} retries: ${reason}`)
      return
    }
    // 加抖动（equal jitter）：限流是**连接级**的，一次冷启动会有几十个 topic
    // 同时被拒。纯指数退避让它们在同一时刻一起重试，等于把惊群原样搬到下一轮，
    // 结果是再次集体撞限流。抖动把重试铺开到 [delay/2, delay) 区间里错峰。
    const ceiling = Math.min(
      SUBSCRIBE_RETRY_BASE_DELAY_MS * 2 ** retryAttempt,
      SUBSCRIBE_RETRY_MAX_DELAY_MS,
    )
    const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2))
    retryAttempt += 1
    log.warn(`[${prefix}] ${reason}, retry ${retryAttempt}/${SUBSCRIBE_MAX_RETRIES} in ${delay}ms`)
    retryTimer = setTimeout(() => {
      retryTimer = null
      void connect()
    }, delay)
  }

  const connect = async () => {
    detachListeners()
    setStatus('connecting')

    try {
      const gw = mainAgentGateway

      const connected = await gw.connect()
      if (!runActive) return
      if (!connected) {
        setStatus('error', 'ws connection failed')
        scheduleConnectRetry('ws connection failed')
        return
      }

      const l = (envelope: any) => {
        if (!isActive) return
        if (!envelopeMatchesGatewayTopic(envelope, topic)) return
        const eventId = envelope?.event_id as string | undefined
        if (eventId) {
          if (recentEventIds.has(eventId)) return
          recentEventIds.add(eventId)
          if (recentEventIds.size > DEDUP_CACHE_LIMIT) {
            const first = recentEventIds.values().next().value
            if (first !== undefined) recentEventIds.delete(first)
          }
        }
        handlers.onEvent?.(envelope)
      }
      listener = l
      gw.addListener(l)

      const rh = () => {
        if (!isActive) return
        setStatus('connecting')
        ensureGatewayTopicSubscribed(gw, topic).then((subscribed) => {
          if (!isActive) return
          if (subscribed.ok) {
            setStatus('connected')
            handlers.onReconnected?.()
          } else {
            setStatus('error', subscribed.message ?? 'resubscribe failed')
            const reason = `resubscribe failed after reconnect: ${subscribed.code ?? 'unknown'}`
            log.warn(`[${prefix}] ${reason}`)
            if (subscribed.retryable) {
              scheduleConnectRetry(reason)
            }
          }
        }).catch(() => {
          if (!isActive) return
          setStatus('error', 'resubscribe failed')
          scheduleConnectRetry('resubscribe threw')
        })
      }
      reconnectHandler = rh
      gw.onReconnectedEvent(rh)

      retainGatewayTopic(topic)
      retainedTopic = topic

      const subscribed = await ensureGatewayTopicSubscribed(gw, topic)
      if (!runActive) {
        detachListeners()
        if (retainedTopic === topic) {
          retainedTopic = null
          await releaseGatewayTopic(gw, topic)
        }
        return
      }
      if (!subscribed.ok) {
        detachListeners()
        if (retainedTopic === topic) {
          retainedTopic = null
          await releaseGatewayTopic(gw, topic)
        }
        const reason = subscribed.code ? `initial subscribe failed (${subscribed.code})` : 'initial subscribe failed'
        setStatus('error', subscribed.message ?? 'subscribe failed')
        if (subscribed.retryable) {
          scheduleConnectRetry(reason)
        } else {
          log.error(`[${prefix}] non-retryable subscribe failure: ${reason}`)
        }
        return
      }

      retryAttempt = 0
      const wasReconnect = hasConnected
      hasConnected = true
      setStatus('connected')

      if (wasReconnect) {
        handlers.onReconnected?.()
      }
    } catch (err) {
      if (!runActive) return
      const msg = err instanceof Error ? err.message : String(err)
      setStatus('error', msg)
      log.warn(`[${prefix}] connect failed:`, err)
      scheduleConnectRetry('connect threw')
    }
  }

  void connect()

  return () => {
    runActive = false
    isActive = false
    hasConnected = false
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    detachListeners()

    try {
      if (retainedTopic === topic) {
        retainedTopic = null
        void releaseGatewayTopic(mainAgentGateway, topic)
      }
    } catch {
      // ignore
    }
  }
}

export function useGatewayTopic(options: UseGatewayTopicOptions): UseGatewayTopicReturn {
  const { topic, enabled = true, subscriptionKey, onEvent, onReconnected, onStatusChange, logPrefix } = options

  // Gateway 认证要求 organizationId，统一在此感知就绪状态。
  // 等价于 getEffectiveOrganizationId() !== null（同样的 fallback 链：
  // selectedOrganization → is_default → organizations[0]），
  // 用原始字段避免在 selector 中调用 store 方法以简化测试 mock。
  const organizationReady = useOrganizationStore(
    s => !!(s.selectedOrganization || s.organizations[0]),
  )
  const organizationId = useOrganizationStore(s => s.selectedOrganization?.id ?? null)
  const organizationAccessRecoveryInFlight = useWsConnectionStore(
    s => s.organizationAccessRecoveryInFlight,
  )
  const gatewayMembershipReady = isGatewayMembershipReadyForOrganization(organizationId)

  const [status, setStatus] = useState<GatewayTopicStatus>('idle')

  const onEventRef = useRef(onEvent)
  const onReconnectedRef = useRef(onReconnected)
  const onStatusChangeRef = useRef(onStatusChange)
  onEventRef.current = onEvent
  onReconnectedRef.current = onReconnected
  onStatusChangeRef.current = onStatusChange

  const updateStatus = useCallback((s: GatewayTopicStatus, err?: string) => {
    setStatus(prev => (prev === s ? prev : s))
    onStatusChangeRef.current?.(s, err)
  }, [])

  // 薄包命令式内核 subscribeGatewayTopic：org 就绪门控 + 组件生命周期绑定留在 hook，
  // 订阅 / 重连 / 重试 / 去重的运行时逻辑全在内核（与 hub 命令式来源接入共用同一份）。
  useEffect(() => {
    if (
      !topic
      || !enabled
      || !organizationReady
      || organizationAccessRecoveryInFlight
      || !gatewayMembershipReady
    ) {
      updateStatus('idle')
      return
    }
    return subscribeGatewayTopic(topic, {
      onEvent: (env) => onEventRef.current?.(env),
      onReconnected: () => onReconnectedRef.current?.(),
      onStatus: (s, err) => updateStatus(s, err),
      logPrefix,
    })
  }, [
    topic,
    enabled,
    organizationReady,
    organizationId,
    organizationAccessRecoveryInFlight,
    gatewayMembershipReady,
    subscriptionKey,
    updateStatus,
    logPrefix,
  ])

  return { status }
}
