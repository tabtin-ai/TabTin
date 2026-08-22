import { joinApiPath } from '@tabtin/config'
import { API_CONFIG, API_ENDPOINTS } from '@/config/api'
import { apiRequest as adapterApiRequest, getAuthToken } from '@/adapters/api-adapter-instance'
import { createLogger } from '@/utils/logger'
import type {
  AcceptProjectInvitationRequest,
  AcceptProjectInvitationResult,
  CreateProjectWithWorkspaceRequest,
  CreateProjectWithWorkspaceResult,
  EnsureProjectWorkspaceRequest,
  InviteProjectMemberRequest,
  PendingProjectInvitation,
  PendingProjectInvitationListResponse,
  ProjectPendingInvitation,
  ProjectPendingInvitationListResponse,
  Project,
  ProjectCompanionWorkspace,
  ProjectListResponse,
  ProjectTask,
  ProjectTaskListResponse,
  AgentProjectTaskListResponse,
  CreateProjectTaskRequest,
} from '@/types/project'

const log = createLogger('projectApi')

type ApiEnvelope<T> = {
  success?: boolean
  code?: string
  error_code?: string
  message?: string
  data?: T
}

export class ProjectApiError extends Error {
  readonly statusCode: number
  readonly errorCode?: string

  constructor(message: string, statusCode: number, errorCode?: string) {
    super(message)
    this.name = 'ProjectApiError'
    this.statusCode = statusCode
    this.errorCode = errorCode
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function buildError(
  response: { status?: number; data?: unknown } | null | undefined,
  fallback: string,
): ProjectApiError {
  const record = asRecord(response?.data)
  const code = record?.code ?? record?.error_code
  const message = record?.message
  return new ProjectApiError(
    typeof message === 'string' && message ? message : fallback,
    response?.status ?? 0,
    typeof code === 'string' && code ? code : undefined,
  )
}

async function authHeaders(): Promise<Record<string, string>> {
  try {
    const token = await getAuthToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  } catch (error) {
    log.warn('token fetch failed', error)
    return {}
  }
}

async function apiRequest(options: {
  url: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  body?: string
}) {
  const headers = await authHeaders()
  return adapterApiRequest({ ...options, headers: { ...headers, ...options.headers } })
}

function url(path: string): string {
  return joinApiPath(API_CONFIG.baseURL, path)
}

export class ProjectApiService {
  static async createWithWorkspace(
    payload: CreateProjectWithWorkspaceRequest,
  ): Promise<CreateProjectWithWorkspaceResult> {
    const response = await apiRequest({
      url: url(API_ENDPOINTS.PROJECT.CREATE_WITH_WORKSPACE),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response || response.status !== 201) {
      throw buildError(response, '创建 Project 失败')
    }
    const body = response.data as ApiEnvelope<CreateProjectWithWorkspaceResult>
    if (!body?.success || !body.data?.project?.id || !body.data?.workspace?.id) {
      throw buildError(response, '创建 Project 返回数据异常')
    }
    return body.data
  }

  static async listProjects(organizationId: string): Promise<ProjectListResponse> {
    const target = new URL(url(API_ENDPOINTS.PROJECT.LIST))
    target.searchParams.set('organization_id', organizationId)
    const response = await apiRequest({ url: target.toString(), method: 'GET' })
    if (!response || response.status !== 200) {
      throw buildError(response, '获取项目列表失败')
    }
    const body = response.data as ApiEnvelope<ProjectListResponse>
    if (!body?.success || !body.data) {
      throw buildError(response, '项目列表数据格式错误')
    }
    return body.data
  }

  static async getProject(projectId: string): Promise<Project> {
    const response = await apiRequest({
      url: url(API_ENDPOINTS.PROJECT.DETAIL(projectId)),
      method: 'GET',
    })
    if (!response || response.status !== 200) {
      throw buildError(response, '获取项目详情失败')
    }
    const body = response.data as ApiEnvelope<Project>
    if (!body?.success || !body.data?.id) {
      throw buildError(response, '项目详情数据格式错误')
    }
    return body.data
  }

  static async listMyPendingInvitations(): Promise<PendingProjectInvitation[]> {
    const response = await apiRequest({
      url: url(API_ENDPOINTS.PROJECT.PENDING_INVITATIONS),
      method: 'GET',
    })
    if (!response || response.status !== 200) {
      throw buildError(response, '获取项目邀请失败')
    }
    const body = response.data as ApiEnvelope<PendingProjectInvitationListResponse>
    return body?.data?.invitations ?? []
  }

  /** Owner 侧：列出本 Project 尚未接受的邀请 */
  static async listProjectPendingInvitations(
    projectId: string,
  ): Promise<ProjectPendingInvitation[]> {
    const response = await apiRequest({
      url: url(API_ENDPOINTS.PROJECT.PROJECT_INVITATIONS(projectId)),
      method: 'GET',
    })
    if (!response || response.status !== 200) {
      throw buildError(response, '获取项目待接受邀请失败')
    }
    const body = response.data as ApiEnvelope<ProjectPendingInvitationListResponse>
    return body?.data?.invitations ?? []
  }

  static async inviteMember(
    projectId: string,
    payload: InviteProjectMemberRequest,
  ): Promise<void> {
    const response = await apiRequest({
      url: url(API_ENDPOINTS.PROJECT.INVITE(projectId)),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response || response.status !== 201) {
      throw buildError(response, '发送项目邀请失败')
    }
  }

  static async acceptInvitation(
    projectId: string,
    payload: AcceptProjectInvitationRequest,
  ): Promise<AcceptProjectInvitationResult> {
    const response = await apiRequest({
      url: url(API_ENDPOINTS.PROJECT.INVITE_ACCEPT(projectId)),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response || response.status !== 200) {
      throw buildError(response, '接受项目邀请失败')
    }
    const body = response.data as ApiEnvelope<AcceptProjectInvitationResult>
    if (!body?.success || !body.data?.workspace?.id) {
      throw buildError(response, '接受项目邀请返回数据异常')
    }
    return body.data
  }

  static async rejectInvitation(projectId: string): Promise<void> {
    const response = await apiRequest({
      url: url(API_ENDPOINTS.PROJECT.INVITE_REJECT(projectId)),
      method: 'POST',
    })
    if (!response || response.status !== 200) {
      throw buildError(response, '拒绝项目邀请失败')
    }
  }

  static async ensureMyWorkspace(
    projectId: string,
    payload: EnsureProjectWorkspaceRequest,
  ): Promise<Pick<ProjectCompanionWorkspace, 'id' | 'name' | 'working_dir'>> {
    const response = await apiRequest({
      url: url(API_ENDPOINTS.PROJECT.WORKSPACE_ENSURE(projectId)),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response || response.status !== 200) {
      throw buildError(response, '供给项目执行工作空间失败')
    }
    const body = response.data as ApiEnvelope<{
      workspace: Pick<ProjectCompanionWorkspace, 'id' | 'name' | 'working_dir'>
    }>
    if (!body?.success || !body.data?.workspace?.id) {
      throw buildError(response, '供给项目执行工作空间返回数据异常')
    }
    return body.data.workspace
  }

  static async listTasks(projectId: string, inbox = false): Promise<ProjectTaskListResponse> {
    const endpoint = inbox
      ? API_ENDPOINTS.PROJECT.TASK_INBOX(projectId)
      : API_ENDPOINTS.PROJECT.TASKS(projectId)
    const response = await apiRequest({ url: url(endpoint), method: 'GET' })
    if (!response || response.status !== 200) throw buildError(response, '获取项目任务失败')
    const body = response.data as ApiEnvelope<ProjectTaskListResponse>
    if (!body?.success || !body.data) throw buildError(response, '项目任务数据格式错误')
    return body.data
  }

  /** ：按 Agent 跨 Project 聚合任务（替代客户端 N 次 listTasks 扫描） */
  static async listTasksForAgent(
    organizationId: string,
    agentId: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<AgentProjectTaskListResponse> {
    const target = new URL(url(API_ENDPOINTS.PROJECT.AGENT_TASKS(organizationId, agentId)))
    if (options?.limit !== undefined) {
      target.searchParams.set('limit', String(options.limit))
    }
    if (options?.cursor) {
      target.searchParams.set('cursor', options.cursor)
    }
    const response = await apiRequest({ url: target.toString(), method: 'GET' })
    if (!response || response.status !== 200) {
      throw buildError(response, '获取 Agent 项目任务失败')
    }
    const body = response.data as ApiEnvelope<AgentProjectTaskListResponse>
    if (!body?.success || !body.data) {
      throw buildError(response, 'Agent 项目任务数据格式错误')
    }
    return body.data
  }

  static async getTask(projectId: string, taskId: string): Promise<ProjectTask> {
    const response = await apiRequest({
      url: url(API_ENDPOINTS.PROJECT.TASK_DETAIL(projectId, taskId)),
      method: 'GET',
    })
    if (!response || response.status !== 200) throw buildError(response, '获取任务详情失败')
    const body = response.data as ApiEnvelope<{ task: ProjectTask }>
    if (!body?.success || !body.data?.task?.id) {
      throw buildError(response, '任务详情数据格式错误')
    }
    return body.data.task
  }

  static async createTask(projectId: string, payload: CreateProjectTaskRequest): Promise<ProjectTask> {
    const response = await apiRequest({
      url: url(API_ENDPOINTS.PROJECT.TASKS(projectId)),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response || response.status !== 201) throw buildError(response, '创建任务失败')
    const body = response.data as ApiEnvelope<{ task: ProjectTask }>
    if (!body?.success || !body.data?.task?.id) throw buildError(response, '创建任务返回数据异常')
    return body.data.task
  }

  static async addTaskComment(projectId: string, taskId: string, content: string): Promise<ProjectTask> {
    return this.taskCommand(
      API_ENDPOINTS.PROJECT.TASK_COMMENTS(projectId, taskId),
      'POST',
      { content: content.trim() },
      '发布评论失败',
    )
  }

  static async respondTaskAssignment(projectId: string, taskId: string, accept: boolean): Promise<ProjectTask> {
    return this.taskCommand(
      API_ENDPOINTS.PROJECT.TASK_ASSIGNMENT_RESPONSE(projectId, taskId),
      'POST',
      { accept },
      '响应任务指派失败',
    )
  }

  static async configureTaskExecution(
    projectId: string,
    taskId: string,
    payload: { agent_id: string; workspace_id: string },
  ): Promise<ProjectTask> {
    return this.taskCommand(
      API_ENDPOINTS.PROJECT.TASK_EXECUTION(projectId, taskId),
      'PUT',
      payload,
      '确认任务执行配置失败',
    )
  }

  static async prepareTaskRun(projectId: string, taskId: string): Promise<ProjectTask> {
    return this.taskCommand(
      API_ENDPOINTS.PROJECT.TASK_RUN_PREPARE(projectId, taskId),
      'POST',
      undefined,
      '准备执行会话失败',
    )
  }

  static async startTaskRun(
    projectId: string,
    taskId: string,
    payload: {
      message?: string
      attachments?: Array<{
        type: 'image' | 'file' | 'video'
        file_id?: string
        filename?: string
        mime_type?: string
        size?: number
        url?: string
        preview_url?: string
      }>
    } = {},
  ): Promise<ProjectTask> {
    return this.taskCommand(
      API_ENDPOINTS.PROJECT.TASK_RUNS(projectId, taskId),
      'POST',
      {
        message: payload.message?.trim() || '',
        attachments: (payload.attachments || []).map(item => ({
          type: item.type,
          file_id: item.file_id || '',
          filename: item.filename || '附件',
          mime_type: item.mime_type || '',
          size: item.size || 0,
          url: item.url || '',
          preview_url: item.preview_url || '',
        })),
      },
      '启动任务失败',
    )
  }

  static async cancelTask(projectId: string, taskId: string): Promise<ProjectTask> {
    return this.taskCommand(
      API_ENDPOINTS.PROJECT.TASK_CANCEL(projectId, taskId),
      'POST',
      undefined,
      '取消任务失败',
    )
  }

  static async acceptTaskResult(
    projectId: string,
    taskId: string,
    payload: {
      result_summary?: string
      deliverable_title?: string
      result_item_ids?: string[]
    } = {},
  ): Promise<ProjectTask> {
    return this.taskCommand(
      API_ENDPOINTS.PROJECT.TASK_ACCEPTANCE(projectId, taskId),
      'POST',
      payload,
      '验收任务失败',
    )
  }

  static async setTaskResultVisibility(
    projectId: string,
    taskId: string,
    resultVisibility: 'private' | 'project_preview',
  ): Promise<ProjectTask> {
    return this.taskCommand(
      API_ENDPOINTS.PROJECT.TASK_RESULT_VISIBILITY(projectId, taskId),
      'POST',
      { result_visibility: resultVisibility },
      '更新结果可见性失败',
    )
  }

  private static async taskCommand(
    endpoint: string,
    method: 'POST' | 'PUT',
    payload: Record<string, unknown> | undefined,
    fallback: string,
  ): Promise<ProjectTask> {
    const response = await apiRequest({
      url: url(endpoint),
      method,
      ...(payload ? {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      } : {}),
    })
    if (!response || response.status !== 200) throw buildError(response, fallback)
    const body = response.data as ApiEnvelope<{ task: ProjectTask }>
    if (!body?.success || !body.data?.task?.id) throw buildError(response, `${fallback}：返回数据异常`)
    return body.data.task
  }
}
