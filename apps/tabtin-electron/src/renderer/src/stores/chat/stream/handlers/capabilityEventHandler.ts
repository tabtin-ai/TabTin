/**
 * capabilityEventHandler — Wave 3 模型能力降级 / 警告事件路由。
 *
 * 业务背景：
 * 后端 wire_adapter 在请求适配阶段发现"该模型支持图片但不支持 4K 分辨率"
 * 这类**软不匹配**时，通过 SSE `event: capability_downgrade` /
 * `event: capability_warning` 发出事件。proxy-provider yield capability_event
 * chunk → query.ts 转 `agent.stream.capability_event` StreamEvent → 本 handler
 * 落到 useChatRuntimeStore.capabilityBannersBySessionId，让 ChatPanel 顶部
 * 显示降级 banner（不打断对话流）。
 *
 * W2f PR2：透传 `stage` / `reason`（runtime_profile vs legacy reasoning），
 * **不**据此修改 Session thinking_mode。
 *
 * 与 capability_gate 硬错的边界：
 *   - 硬错（图片完全不支持）→ chunk.error → 错误卡片 + 阻塞对话
 *   - 软降级（图片支持但分辨率/格式有限制）→ capability_event → banner
 *
 * 设计原则：
 *   - **transient UI 事件**——不进 conversation history、不写
 *     ChatMessage 表；仅服务"用户看到 banner 知道发生了什么"
 *   - banner 跨多 turn 持续显示直到用户主动 dismiss / 切模型 / 新会话
 *   - 同 (kind, feature, fallback_to) 三元组重复幂等（store 层保证）
 */

import type { AgentStreamMessage, HandlerContext } from './streamHandlerTypes'
import { createLogger } from '@/utils/logger'

const log = createLogger('E2E:Capability')

interface CapabilityEventPayload {
  kind?: string
  feature?: string
  fallback_to?: string
  message?: string
  model?: string
  model_name?: string
  stage?: string
  reason?: string
  requested?: string
  extras?: Record<string, unknown>
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function buildExtras(payload: CapabilityEventPayload): Record<string, unknown> | undefined {
  const base = (
    payload.extras && typeof payload.extras === 'object'
      ? { ...payload.extras }
      : {}
  ) as Record<string, unknown>

  const stage = readString(payload.stage) ?? readString(base.stage)
  const reason = readString(payload.reason) ?? readString(base.reason)
  const requested = readString(payload.requested) ?? readString(base.requested)
  const modelName = readString(payload.model_name) ?? readString(base.model_name)

  if (stage) base.stage = stage
  if (reason) base.reason = reason
  if (requested) base.requested = requested
  if (modelName) base.model_name = modelName

  return Object.keys(base).length > 0 ? base : undefined
}

export function handleCapabilityEvent(
  message: AgentStreamMessage,
  ctx: HandlerContext,
): void {
  const payload = (message.payload ?? {}) as CapabilityEventPayload
  const kind = payload.kind === 'downgrade' || payload.kind === 'warning' ? payload.kind : null
  if (!kind) {
    log.debug('skip capability_event: invalid kind', { kind: payload.kind })
    return
  }

  const feature = readString(payload.feature)
  const fallbackTo = readString(payload.fallback_to)
  const messageText = readString(payload.message)
  const extras = buildExtras(payload)
  const model = readString(payload.model)
    ?? readString(payload.model_name)
    ?? readString(extras?.model_name)

  log.debug('← CAPABILITY_EVENT', {
    session: ctx.sessionId.slice(0, 8),
    kind,
    feature,
    fallback_to: fallbackTo,
    model,
    stage: extras?.stage,
    reason: extras?.reason,
  })

  // dynamic import 避免循环依赖（streamMessageHandler ↔ useChatRuntimeStore）
  void import('@/stores/useChatRuntimeStore').then(({ useChatRuntimeStore }) => {
    useChatRuntimeStore.getState().pushCapabilityBanner(ctx.sessionId, {
      kind,
      feature,
      fallback_to: fallbackTo,
      message: messageText,
      model,
      extras,
    })
  }).catch(err => log.warn('Failed to push capability banner', err))
}
