/**
 * ChatClient 单例生命周期管理
 *
 * 零 store 依赖的纯数据模块，持有 ChatClient 单例引用。
 * chatApi.ts 负责创建和配置 client，本模块负责存储、重置和页面卸载清理。
 *
 * 独立出来的目的：打断 chatApi ↔ useOrganizationStore 循环依赖，
 * 使 useOrganizationStore 可以静态导入 resetChatClient 而不引入 chatApi 的
 * store 依赖链。
 */

import type { ChatClient } from '@tabtin/chat-client'
import { registerResetAction } from '@/stores/sessionResetRegistry'
import { useBackgroundEventStore } from '@/stores/useBackgroundEventStore'
import { clearPersistedLastEventId } from './wsLastEventIdPersistence'
import { createLogger } from '@/utils/logger'

const log = createLogger('ChatClient')

let instance: ChatClient | null = null
let reconnectHandler: ((activeSessionIds: string[]) => Promise<void>) | null = null

export function getChatClientInstance(): ChatClient | null {
  return instance
}

export function setChatClientInstance(client: ChatClient): void {
  instance = client
  if (reconnectHandler) {
    client.setOnReconnected(reconnectHandler)
  }
}

export function resetChatClient(): void {
  if (instance) {
    try {
      instance.abortStream()
      instance.getGateway().close()
    } catch (error) {
      log.warn('resetChatClient 关闭连接失败:', error)
    }
    instance = null
  }
  // Wave 3: teardown 阶段一并清空非前台事件桶，避免登录/重登后新会话
  // 继承旧用户的 per-organization 队列。
  try {
    useBackgroundEventStore.getState().clearAll()
  } catch {
    // store 未初始化时忽略（测试场景）
  }
  // W4c · §3.6 catchup：teardown（登出 / token 失效 / user 切换）时清掉
  // localStorage 中持久化的 lastEventId——避免新 user 拿到旧 cursor 触发
  // backend WS_RESUME_OVERFLOW（重连后服务端找不到对应 stream cursor）。
  try {
    clearPersistedLastEventId()
  } catch {
    // 持久化模块自身已 try/catch；冗余兜底防御未来修改引入的边角崩溃
  }
}

/**
 * 注册 WS 重连后的同步回调。
 * 由 useChatStore 在模块级别调用，避免 chatApi 反向依赖 useChatStore。
 * 如果 client 已创建，立即挂载；否则在 setChatClientInstance 时挂载。
 */
export function setReconnectHandler(
  handler: (activeSessionIds: string[]) => Promise<void>,
): void {
  reconnectHandler = handler
  if (instance) {
    instance.setOnReconnected(handler)
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (instance) {
      try {
        instance.getGateway().close()
      } catch { /* best-effort */ }
    }
  })
}

registerResetAction('chat-client', 'teardown', resetChatClient)
