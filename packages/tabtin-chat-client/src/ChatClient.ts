import { HttpClient } from './core/http-client'
import { SessionManager } from './managers/SessionManager'
import { MessageManager } from './managers/MessageManager'
import { StreamManager } from './managers/StreamManager'
import { ContextManager } from './managers/ContextManager'
import { ActionManager } from './managers/ActionManager'
import { ModelManager } from './managers/ModelManager'
import { ChatClientOptions, StreamCallbacks } from './types'
import { WsGateway, resolveGatewayCapabilities } from './core/ws-gateway'

/**
 * Chat Agent 客户端
 *
 * 基于最新的 Agent 架构，提供完整的 Chat Agent 功能：
 * - 会话管理（创建、查询、更新、删除）
 * - 消息管理（发送、查询历史）
 * - 流式输出（WS-first，基于 Agent）
 * - 上下文管理（设置当前 project/table/view）
 * - 前端动作执行（网页抓取等）
 *
 * @example
 * ```typescript
 * const client = new ChatClient({
 *   baseURL: 'https://api.example.com/api/chat',
 *   getToken: () => localStorage.getItem('token') || ''
 * })
 *
 * // 创建会话
 * const session = await client.sessions.create('project-id')
 *
 * // 流式输出（推荐）
 * await client.stream(session.id, '帮我查询项目', {
 *   onChunk: (chunk) => console.log(chunk),
 *   onActionRequired: async (action, taskId) => {
 *     // 处理前端动作请求
 *     const result = await executeAction(action)
 *     await client.actions.submitResult(session.id, taskId, result)
 *   },
 *   onDone: (messageId) => console.log('完成:', messageId)
 * })
 * ```
 */
export class ChatClient {
  private http: HttpClient
  private catalogHttp: HttpClient
  private wsGateway: WsGateway

  /** 会话管理 */
  public readonly sessions: SessionManager

  /** 消息管理 */
  public readonly messages: MessageManager

  /** 流式管理 */
  private streamManager: StreamManager

  /** 上下文管理 */
  public readonly context: ContextManager

  /** 前端动作管理 */
  public readonly actions: ActionManager

  /** 模型管理 */
  public readonly models: ModelManager

  /**
   * 创建 Chat Client 实例
   * @param options - 客户端配置选项
   */
  constructor(options: ChatClientOptions) {
    this.http = new HttpClient(options)
    const catalogBaseURL = options.catalogBaseURL ?? options.baseURL.replace(/\/chat\/?$/, '')
    this.catalogHttp = new HttpClient({
      ...options,
      baseURL: catalogBaseURL
    })
    this.sessions = new SessionManager(this.http)
    const role = options.role ?? 'electron'
    const capabilities = resolveGatewayCapabilities(role, options.capabilities)
    this.wsGateway = options.wsGateway
      ? options.wsGateway as WsGateway
      : new WsGateway({
          ...options,
          role,
          capabilities,
        })
    this.streamManager = new StreamManager(options, this.wsGateway)
    this.context = new ContextManager(this.http)
    this.models = new ModelManager(this.http, this.catalogHttp)
    this.messages = new MessageManager(this.http)
    this.actions = new ActionManager(this.wsGateway)
  }

  /**
   * 获取内部管理的 WsGateway 实例
   */
  public getGateway(): WsGateway {
    return this.wsGateway
  }

  /**
   * 获取 StreamManager（供 sleep/wake 恢复等场景重置 slot 计时器）
   */
  public getStreamManager(): StreamManager {
    return this.streamManager
  }

  /**
   * 当前用户所属全部 organization（服务端 auth.ok / organization.membership_changed 回填）。
   * 供 Wave 3 Store 层消费：切换 organization 时验证 id 是否仍在 membership，
   * 或用于跨 organization 任务通知的角标聚合。
   */
  public getOrganizationIds(): string[] {
    return this.wsGateway.getOrganizationIds()
  }

  /**
   * 当前前台 organization（primary）。服务端在 auth.ok 或 membership_changed
   * 里最终决定；客户端传入的 `getOrganizationId` 只是 hint。
   */
  public getPrimaryOrganizationId(): string | undefined {
    return this.wsGateway.getPrimaryOrganizationId()
  }

  /**
   * 发送流式消息（基于 Agent WS）
   *
   * 新架构：
   * 1. 自动建立 WS 连接并订阅 stream/action 主题
   * 2. 发送消息到 /api/chat/sessions/{id}/messages
   * 3. 通过 WS 接收 AI 回复和前端动作请求
   *
   * @param sessionId - 会话ID（等同于 thread_id）
   * @param message - 用户消息内容
   * @param callbacks - 事件回调函数
   *
   * @example
   * ```typescript
   * await client.stream(sessionId, '帮我抓取知乎', {
   *   onChunk: (chunk, fullContent) => {
   *     // 逐字显示 AI 回复
   *     console.log('收到:', chunk)
   *   },
   *   onToolCall: (toolName, toolArgs) => {
   *     // 后端工具调用
   *     console.log('调用工具:', toolName, toolArgs)
   *   },
   *   onActionRequired: async (action, taskId) => {
   *     // ⭐ 需要前端执行动作
   *     if (action.action === 'fetch_webpage') {
   *       const html = await captureWebpage(action.params.url)
   *       await client.actions.submitResult(sessionId, taskId, {
   *         success: true,
   *         clean_html: html
   *       })
   *     }
   *   },
   *   onDone: (messageId, fullContent) => {
   *     // 完成
   *     console.log('完成，消息ID:', messageId)
   *   },
   *   onError: (error) => {
   *     // 错误
   *     console.error('错误:', error)
   *   }
   * })
   * ```
   */
  async stream(
    sessionId: string,
    message: string,
    callbacks: StreamCallbacks,
    options?: {
      modelId?: string
      agentName?: string
      /** v2 消息块（多模态输入） */
      blocks?: Array<Record<string, unknown>>
      /** Agent 交互模式（ask / agent / plan / study） */
      agentMode?: string
      /** 前端生成的消息唯一标识，用于精确去重 */
      clientMessageId?: string
    }
  ): Promise<void> {
    return this.streamManager.stream(sessionId, message, callbacks, options)
  }

  /**
   * 中止所有流式连接并取消后端 run
   */
  abortStream(): void {
    this.streamManager.abort()
  }

  /**
   * 中止指定 session 的流式连接并取消其后端 run
   */
  abortStreamForSession(sessionId: string): void {
    void this.streamManager.abortSession(sessionId)
  }

  /**
   * 中止指定 session 并等待后端 cancel 完成
   */
  async abortStreamForSessionAndWait(sessionId: string, timeoutMs?: number): Promise<{ cancelRequested: boolean; cancelCompleted: boolean }> {
    return this.streamManager.abortSession(sessionId, timeoutMs)
  }

  /**
   * 中止所有流式连接并等待后端 cancel 完成（带超时保护）
   */
  async abortStreamAndWait(timeoutMs?: number): Promise<{ cancelRequested: boolean; cancelCompleted: boolean }> {
    return this.streamManager.abortAndWait(timeoutMs)
  }

  /**
   * 暂停流式监听但不取消后端 run。
   * 用于 human-in-the-loop review 场景。
   */
  pauseStream(sessionId?: string): void {
    if (sessionId) {
      this.streamManager.pauseSession(sessionId)
    } else {
      this.streamManager.pause()
    }
  }

  /**
   * 暂停流式处理但保持 WS 订阅。
   * 用于 review 确认后后端仍需通过 WS 派发前端动作并推送结果的场景。
   */
  pauseForReview(sessionId?: string): void {
    if (sessionId) {
      this.streamManager.pauseForReview(sessionId)
    } else {
      for (const id of this.streamManager.activeSessionIds) {
        this.streamManager.pauseForReview(id)
      }
    }
  }

  /**
   * 检查是否有活动的流式连接
   */
  isStreaming(sessionId?: string): boolean {
    return this.streamManager.isStreaming(sessionId)
  }

  /**
   * 注册 WS 重连回调。
   * 重连后会传入当前所有活跃流式 sessionId，上层可据此拉取子 Agent 等状态。
   */
  setOnReconnected(handler: (activeSessionIds: string[]) => void): void {
    this.streamManager.setOnReconnected(handler)
  }
}


