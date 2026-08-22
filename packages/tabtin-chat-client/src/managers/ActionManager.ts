import { ActionResultRequest } from '../types'
import { WsGateway } from '../core/ws-gateway'
import { t } from '../i18n'
import { actionEventType } from '../core/namespace'
import { compactActionResultForTransport } from '../utils/action-result-transport'

/**
 * 前端动作管理器
 * 负责上报前端动作执行结果到 Agent API
 */
export class ActionManager {
  constructor(
    private wsGateway: WsGateway
  ) {
  }

  /**
   * 上报前端动作执行结果
   *
   * @param threadId - 会话ID（等同于 session_id）
   * @param taskId - 任务ID（来自 action_required 事件）
   * @param result - 动作执行结果
   *
   * @example
   * ```typescript
   * // 网页抓取结果
   * await actionManager.submitResult(sessionId, taskId, {
   *   success: true,
   *   clean_html: '<html>...</html>',
   *   title: '知乎热榜',
   *   url: 'https://zhihu.com'
   * })
   *
   * // 快照结果（根据请求参数返回不同字段）
   * await actionManager.submitResult(sessionId, taskId, {
   *   success: true,
   *   data: {
   *     snapshot: {
   *       url: 'https://zhihu.com',
   *       title: '知乎',
   *       accessibility_tree: { ... },  // 当 include_accessibility_tree=true
   *       skeleton_html: '<html>...</html>',  // 当 include_dom=true
   *       screenshot_base64: '...'       // 当 include_screenshot=true
   *     },
   *     frontend_execution_time_ms: 890
   *   }
   * })
   * ```
   */
  async submitResult(
    threadId: string,
    taskId: string,
    result: ActionResultRequest
  ): Promise<{ status: string; message: string }> {
    // 前端只需要确保成功或失败的基本字段存在
    if (!result.success && !result.error) {
      throw new Error(t('errors.missingErrorField'))
    }

    const send = (payloadResult: ActionResultRequest) =>
      this.wsGateway.request(
        actionEventType('result'),
        {
          task_id: taskId,
          ...payloadResult,
        },
        {
          threadId,
        }
      )

    const MAX_RETRIES = 2
    const RETRY_DELAYS = [1000, 3000]

    let retryPayload = result
    let response = await send(result)

    if (!response.ok && response.error?.code === 'WS_MESSAGE_TOO_LARGE_CLIENT') {
      const compacted = compactActionResultForTransport(result)
      if (compacted.changed) {
        console.warn('[ActionManager] payload too large, retrying with compact payload', {
          taskId,
          estimatedBytes: compacted.estimatedBytes,
        })
        retryPayload = compacted.result
        response = await send(retryPayload)
      }
    }

    if (!response.ok && response.error?.code !== 'WS_MESSAGE_TOO_LARGE_CLIENT') {
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const delay = RETRY_DELAYS[attempt] ?? 3000
        console.warn(`[ActionManager] submitResult failed, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`, {
          taskId,
          error: response.error?.message,
        })
        await new Promise(resolve => setTimeout(resolve, delay))
        response = await send(retryPayload)
        if (response.ok) break
      }
    }

    if (!response.ok) {
      const message = response.error?.message || t('errors.wsActionResultFailed')
      throw new Error(message)
    }

    return response.payload
  }
}
