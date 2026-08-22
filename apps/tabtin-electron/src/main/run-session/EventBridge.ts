/**
 * EventBridge - 事件桥接（占位符实现）
 *
 * 职责：
 * - 接收本地事件
 * - （未来）推送到后端服务器
 * - （未来）实现事件持久化
 *
 * @status 占位符（仅记录日志，不做实际推送）
 */

import { createLogger } from '../logger'

const log = createLogger('EventBridge')

export interface EventBridgePayload {
  type: string
  timestamp: number
  runId?: string
  sessionId?: string
  viewId?: string
  data?: any
}

/**
 * EventBridge 单例
 */
class EventBridge {
  private enabled = false // 默认禁用，避免日志噪音

  /**
   * 推送事件到 EventBridge
   */
  push(event: EventBridgePayload): void {
    if (!this.enabled) {
      return // 静默跳过
    }

    // 占位符：仅记录日志
    log.debug('事件推送（占位符）', {
      type: event.type,
      runId: event.runId,
      timestamp: new Date(event.timestamp).toISOString()
    })
  }

  /**
   * 启用 EventBridge（用于调试）
   */
  enable(): void {
    this.enabled = true
    log.info('已启用')
  }

  /**
   * 禁用 EventBridge
   */
  disable(): void {
    this.enabled = false
    log.info('已禁用')
  }
}

let instance: EventBridge | null = null

/**
 * 获取 EventBridge 单例
 */
export function getEventBridge(): EventBridge {
  if (!instance) {
    instance = new EventBridge()
  }
  return instance
}
