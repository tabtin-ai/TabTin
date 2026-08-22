import { HttpClient } from '../core/http-client'
import {
  ChatSession,
  CreateSessionRequest,
  QuickStartSessionRequest,
  QuickStartSessionResponse,
  UpdateSessionRequest,
  SessionListResponse,
  SessionQueryParams,
  AllSessionQueryParams,
  AllSessionListResponse,
  PendingInteraction,
  PendingInteractionListResponse,
  SessionReadAccess,
} from '../types'

/**
 * 会话管理器
 * 负责会话的创建、查询、更新、删除操作
 */
export class SessionManager {
  constructor(private http: HttpClient) {}

  /**
   * 创建新会话
   * @param scopeId - 当前 UI 作用域 ID（仅用于调用端追踪；不再写入请求）
   * @param organizationId - 组织ID（兼容字段，可选）
   * @param modelId - 初始模型ID（可选，UUID）
   * @returns 创建的会话对象
   */
  async create(
    _scopeId: string,
    organizationId: string | undefined,
    modelId: string | undefined,
    binding: {
      agentId: string
      workspaceId?: string | null
      projectId?: string | null
      targetDeviceId?: string | null
    },
  ): Promise<ChatSession> {
    const request: CreateSessionRequest = {
      agent_id: binding.agentId,
      workspace_id: binding.workspaceId,
      project_id: binding.projectId,
      target_device_id: binding.targetDeviceId,
      organization_id: organizationId,
      model_id: modelId,
    }
    return this.http.post<ChatSession>('/sessions', request)
  }

  /**
   * 草稿预建：一次请求完成 session 创建 + 初始上下文 + group_runtime 投影。
   */
  async quickStart(
    _scopeId: string,
    organizationId?: string,
    modelId?: string,
    initialContext?: Record<string, unknown>,
    binding?: {
      agentId: string
      workspaceId?: string | null
      projectId?: string | null
      targetDeviceId?: string | null
    },
  ): Promise<QuickStartSessionResponse> {
    if (!binding?.agentId) {
      throw new Error('quickStart requires an explicit agentId')
    }
    const request: QuickStartSessionRequest = {
      agent_id: binding.agentId,
      workspace_id: binding.workspaceId,
      project_id: binding.projectId,
      target_device_id: binding.targetDeviceId,
      organization_id: organizationId,
      model_id: modelId,
      ...(initialContext ?? {}),
    }
    return this.http.post<QuickStartSessionResponse>('/sessions/quick-start', request)
  }

  /**
   * 查询会话列表
   * @param params - 查询参数
   * @returns 会话列表响应
   */
  async list(params: SessionQueryParams): Promise<SessionListResponse> {
    return this.http.get<SessionListResponse>('/sessions', params)
  }

  /**
   * 获取单个会话详情
   * @param sessionId - 会话ID
   * @returns 会话对象
   */
  async get(
    sessionId: string,
    access?: SessionReadAccess,
  ): Promise<ChatSession> {
    return this.http.get<ChatSession>(
      `/sessions/${sessionId}`,
      access ? { share_id: access.shareId } : undefined,
    )
  }

  /**
   * 更新会话信息
   * @param sessionId - 会话ID
   * @param updates - 更新的字段
   * @returns 更新后的会话对象
   */
  async update(sessionId: string, updates: UpdateSessionRequest): Promise<ChatSession> {
    return this.http.put<ChatSession>(`/sessions/${sessionId}`, updates)
  }

  /**
   * 删除会话
   * @param sessionId - 会话ID
   * @returns 删除成功消息
   */
  async delete(sessionId: string): Promise<{ message: string }> {
    return this.http.delete<{ message: string }>(`/sessions/${sessionId}`)
  }

  /**
   * 触发会话标题生成（fire-and-forget；#6768 必带正文）。
   *
   * 调用方必须传入 ``userMessage``——与消息落库状态解耦，服务端不读库取正文。
   * HTTP 立即返 ``{accepted}``；标题经 ``agent.user.title_updated`` 落地。
   *
   *   - ``accepted=true`` → 已调度生成
   *   - ``accepted=false, reason='already_has_title'`` → 已有非默认标题且未 force
   *   - ``accepted=false, reason='empty_user_message'`` → 正文为空
   */
  async generateTitle(
    sessionId: string,
    options: {
      /** ：必填用户正文；服务端不读库回填正文 */
      userMessage: string
      modelId?: string
      force?: boolean
    }
  ): Promise<{
    accepted: boolean
    reason?: 'already_has_title' | 'empty_user_message'
  }> {
    const userMessage = options.userMessage.trim()
    return this.http.post(`/sessions/${sessionId}/generate-title`, {
      user_message: userMessage,
      ...(options.force !== undefined ? { force: options.force } : {}),
      ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
    })
  }

  /**
   * Fork 会话 —— 从指定消息处创建分支会话
   * @param sessionId - 源会话 ID
   * @param options - fork 选项
   * @param options.fork_anchor_message_id - Agent Host transcript 中的分叉锚点消息 ID
   * @param options.message_id - 兼容旧服务端的 ChatMessage PK，不指定则 fork 到最新
   * @returns 新创建的分叉会话
   */
  async fork(
    sessionId: string,
    options?: { fork_anchor_message_id?: string; message_id?: string },
  ): Promise<ChatSession> {
    return this.http.post<ChatSession>(
      `/sessions/${sessionId}/fork`,
      options || {},
    )
  }

  /**
   * 将 fork 子会话弹出为根级对话（清除 forked_from_id / fork_point_message_id）。
   */
  async unfork(sessionId: string): Promise<ChatSession> {
    return this.http.post<ChatSession>(`/sessions/${sessionId}/unfork`, {})
  }

  /**
   * 跨 Space 查询所有会话（含 Agent 信息）
   * @param params - 查询参数，organization_id 必填
   * @returns 会话列表响应（含 Agent 元信息）
   */
  async listAll(params: AllSessionQueryParams): Promise<AllSessionListResponse> {
    return this.http.get<AllSessionListResponse>('/sessions/all', params)
  }

  /**
   * 拉取该会话仍需用户处理的待办交互（HITL 权威事实）。
   *
   * 只返回 `status='pending'`（服务端已剔除 resolved / expired）。客户端在进会话、
   * 重连、seq-gap 补拉等 sync 时机调用，用作追问 / 审批面板是否保持打开的权威判据——
   * 与消息走同一条 sync 路径，避免实时 stream 重放导致面板复活。
   *
   * @param sessionId - 会话ID
   * @returns 该会话的 pending 交互列表
   */
  async pendingInteractions(sessionId: string): Promise<PendingInteraction[]> {
    const response = await this.http.get<PendingInteractionListResponse>(
      `/sessions/${sessionId}/pending-interactions`,
    )
    return response?.interactions ?? []
  }
}











