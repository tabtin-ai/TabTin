/**
 * 适配器：将本地 Runtime 的 StreamEvent 桥接到
 * 现有 streamMessageHandler + 流式 UI 更新。
 *
 * 本地 Runtime yield 的事件已采用 agent.stream.* 格式
 * （与 @tabtin/agent-wire StreamEvents 一致），
 * 因此可直接传给 createStreamMessageHandler。
 *
 * 适配器额外处理两件事：
 *   1. assistant delta → onAssistantDelta 回调（模拟 onChunk 更新流式内容）
 *   2. done → onStreamDone 回调（通知调用方执行完成）
 *
 * 用法（Phase 2 集成到 sendMessageAction 时）：
 *   const adapter = createLocalStreamAdapter(handlerDeps, callbacks)
 *   // 在 LocalAgentClient 回调中：
 *   adapter.processEvent(event)      // onMessage 回调
 *   adapter.processDelta(content)    // onChunk 回调
 *   adapter.processDone(metadata)    // onDone 回调
 */

import {
  createStreamMessageHandler,
  type StreamHandlerDeps,
  type AgentStreamMessage,
} from '../stores/chat/stream/handlers/streamMessageHandler'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LocalStreamAdapterCallbacks {
  /** 处理 assistant delta 文本（更新 streamingContent / UI） */
  onAssistantDelta: (content: string) => void
  /** 流式执行完成 */
  onStreamDone: (metadata?: Record<string, unknown>) => void
}

export interface LocalStreamAdapter {
  /**
   * 处理一个结构化流事件。
   * 内部将事件路由到 createStreamMessageHandler 以更新
   * agentSteps / toolEvents / runState 等运行时状态。
   */
  processEvent: (event: AgentStreamMessage) => void

  /**
   * 处理 assistant delta 文本片段。
   * 调用 onAssistantDelta 回调以更新流式显示内容。
   */
  processDelta: (content: string) => void

  /**
   * 处理流式执行完成。
   * 先让 messageHandler 处理 DONE 事件的副作用，
   * 再通知调用方执行完成。
   */
  processDone: (metadata?: Record<string, unknown>) => void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * 创建一个本地流适配器。
 *
 * @param handlerDeps  传给 createStreamMessageHandler 的依赖
 *                     （sessionId / get / set / client 等）
 * @param callbacks    额外的本地模式回调
 */
export function createLocalStreamAdapter(
  handlerDeps: StreamHandlerDeps,
  callbacks: LocalStreamAdapterCallbacks,
): LocalStreamAdapter {
  const messageHandler = createStreamMessageHandler(handlerDeps)

  return {
    processEvent(event: AgentStreamMessage) {
      if (!event?.type) return
      messageHandler(event)
    },

    processDelta(content: string) {
      callbacks.onAssistantDelta(content)
    },

    processDone(metadata?: Record<string, unknown>) {
      messageHandler({
        type: 'agent.stream.done',
        payload: metadata,
      })
      callbacks.onStreamDone(metadata)
    },
  }
}
