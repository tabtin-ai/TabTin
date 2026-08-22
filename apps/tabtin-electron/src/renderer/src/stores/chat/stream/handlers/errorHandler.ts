/**
 * errorHandler — 流式 lifecycle / DONE 错误的 **telemetry** 入口。
 *
 * 聊天气泡不再由此 inject。终态错误唯一写手是
 * [`finalizeDoneEvent`](./doneEventFinalizer.ts)（仅 DONE 调用）。
 *
 * lifecycle phase=error 仍调用本 handler，只打日志，供 dogfood 排障。
 */

import i18n from '@/i18n'
import { AgentStreamEvents } from '@tabtin/ws-gateway-client'
import { createLogger } from '@/utils/logger'
import type { AgentStreamMessage, HandlerContext } from './streamHandlerTypes'

const log = createLogger('E2E:Error')

/**
 * 从 lifecycle phase=error / DONE payload 提取后端 LLMProxy 中文文案。
 */
export function extractProxyErrorMessage(
  payload: Record<string, unknown>,
): string | undefined {
  const candidates = [
    payload.error_message,
    payload.errorMessage,
    payload.detail,
    payload.error,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return undefined
}

/**
 * 判断 lifecycle phase=error 是否来自后端 LLMProxy SSE error 路径。
 * 仅 telemetry；不影响渲染。
 */
export function isFromProxySSEError(
  payload: Record<string, unknown>,
): boolean {
  const errorClass = typeof payload.error_class === 'string' ? payload.error_class : ''
  if (errorClass !== 'LLM_ERROR' && errorClass !== 'LLM_BILLING_ERROR') return false
  const msg = extractProxyErrorMessage(payload) ?? ''
  return /上游服务|预算|余额|图片下载|模型|组织|API Key/.test(msg)
}

function isDoneErrorEvent(message: AgentStreamMessage, payload: Record<string, unknown>): boolean {
  if (message.type !== AgentStreamEvents.DONE) return false
  return payload.error === true
    || typeof payload.error_class === 'string'
    || typeof payload.error_message === 'string'
    || typeof payload.errorMessage === 'string'
}

/**
 * @deprecated  已删除 inject；保留空实现以免旧测试/调用方瞬时崩溃。
 * 终态错误请走 finalizeDoneEvent。
 */
export function injectSystemBubbleIfNeeded(
  message: AgentStreamMessage,
  ctx: HandlerContext,
): void {
  void message
  void ctx
  log.debug('injectSystemBubbleIfNeeded no-op ( single DONE finalizer)')
}

/**
 * lifecycle phase=error：只记日志。气泡由 DONE → finalizeDoneEvent 写入。
 */
export function handleError(
  message: AgentStreamMessage,
  ctx: HandlerContext,
): void {
  const payload = message.payload || {}
  const phase = payload.phase
  if (phase !== 'error' && !isDoneErrorEvent(message, payload)) return

  const userMessage = extractProxyErrorMessage(payload)
  if (!userMessage) return

  const fromProxy = isFromProxySSEError(payload)
  log.warn(
    `phase=error session=${ctx.sessionId.slice(0, 8)} fromProxy=${fromProxy} msg=${userMessage.slice(0, 80)}`,
  )
  void i18n
}
