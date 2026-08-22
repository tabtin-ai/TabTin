/**
 * Project（团队协作房间，后端 Space(type=team_space)）与伴生 Workspace 类型。
 *
 * 分层模型见 principle/workspace-project.md：Project 是共享协作面，执行落到成员各自的
 * 伴生 Workspace（`my_workspace`，仅返回当前用户自己的执行现场）。
 */

export interface ProjectCompanionWorkspace {
  id: string
  organization_id?: string | null
  project_id?: string | null
  type?: string | null
  name: string
  working_dir: string
  normalized_working_dir?: string | null
  working_dir_type?: string | null
  agent_id?: string | null
  execution_agent_id?: string | null
  bound_device_id?: string | null
  control_device_id: string | null
  control_device_status: string | null
  is_archived?: boolean | null
  provisioning_source?: 'user' | 'system_project' | 'system_task' | string | null
  is_companion: boolean
}

export interface Project {
  id: string
  organization_id: string
  type?: 'team_space'
  name: string
  description: string
  avatar: string
  color: string
  status: string
  execution_space_id?: string | null
  table_count?: number
  order?: number
  is_archived: boolean
  is_default?: boolean
  visibility: string
  member_count: number
  config_version?: number
  last_activity_at: string | null
  created_at: string
  updated_at: string
  /** 仅 getProject 返回：当前用户在此 Project 下的执行 Workspace（可能为 null）。 */
  my_workspace?: ProjectCompanionWorkspace | null
}

export interface ProjectListResponse {
  projects: Project[]
  total: number
}

export interface PendingProjectInvitation {
  project_id: string
  project_name: string
  organization_id: string
  role: 'owner' | 'admin' | 'editor' | 'viewer'
  inviter_name: string
  invited_at: string
}

export interface PendingProjectInvitationListResponse {
  invitations: PendingProjectInvitation[]
  total: number
}

/** Owner 侧：某 Project 尚未接受的邀请 */
export interface ProjectPendingInvitation {
  membership_id: string
  user_id: string
  user_name: string
  role: 'owner' | 'admin' | 'editor' | 'viewer'
  invited_at: string
  invited_by?: string | null
}

export interface ProjectPendingInvitationListResponse {
  invitations: ProjectPendingInvitation[]
  total: number
}

export interface InviteProjectMemberRequest {
  user_id: string
  role: 'admin' | 'editor' | 'viewer'
}

export interface CreateProjectWithWorkspaceRequest {
  organization_id: string
  name: string
  description?: string
  device_id: string
  working_dir: string
  working_dir_type?: string
}

export interface AcceptProjectInvitationRequest {
  device_id: string
  working_dir: string
  working_dir_type?: string
}

export type EnsureProjectWorkspaceRequest = AcceptProjectInvitationRequest

export interface AcceptProjectInvitationResult {
  project_id: string
  project_name: string
  role: string
  workspace: {
    id: string
    name: string
    working_dir: string
  }
}

export interface CreateProjectWithWorkspaceResult {
  project: Project
  workspace: ProjectCompanionWorkspace
}

export type ProjectTaskPriority = 'low' | 'medium' | 'high' | 'urgent'
export type ProjectTaskAssignmentStatus = 'pending' | 'accepted' | 'rejected'
export type ProjectTaskWorkStatus = 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled'
/** 历史兼容字段；未完成任务中间产物默认项目成员可读，不再依赖此开关。 */
export type ProjectTaskResultVisibility = 'private' | 'project_preview'

export interface ProjectTaskIdentity {
  id: string
  name: string
}

export interface ProjectTaskRun {
  id: string
  status: 'preparing' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  rerun_of_id: string | null
  chat_session_id: string | null
  result_summary: string
  result_items: ProjectTaskResultItem[]
  safe_failure_reason: string
  binding: {
    agent_name?: string
    workspace_name?: string
    device_name?: string
  }
  started_at: string | null
  ended_at: string | null
  created_at: string
}

/** 任务下挂载的一条对话（对应一次 TaskRun / 准备会话）。 */
export type ProjectTaskConversationKind = 'execution' | 'preparation'

export interface ProjectTaskConversation {
  session_id: string | null
  run_id: string
  kind: ProjectTaskConversationKind
  run_status: ProjectTaskRun['status']
  rerun_of_id: string | null
  title: string
  is_active: boolean
  created_at: string
}

export interface ProjectTaskResultItem {
  id: string
  context_item_id: string
  resource_type: string
  resource_id: string
  item_type: string
  title: string
  preview: string
  resource_space_id?: string
}

export interface ProjectTask {
  id: string
  project_id: string
  title: string
  description: string
  priority: ProjectTaskPriority
  created_by: ProjectTaskIdentity
  responsible_user: ProjectTaskIdentity
  assignment_status: ProjectTaskAssignmentStatus
  work_status: ProjectTaskWorkStatus
  selected_agent: ProjectTaskIdentity | null
  project_workspace: {
    id: string
    name: string
    device_status: string
    confirmed_at: string | null
  } | null
  workspace_confirmed: boolean
  execution_ready: boolean
  result_summary: string
  /** 历史兼容字段；未完成任务中间产物默认项目成员可读，不再依赖此开关。 */
  result_visibility: ProjectTaskResultVisibility
  latest_run: ProjectTaskRun | null
  /** 最近一次成功执行；新开对话时 latest_run 可能是 preparing，完成发布看这里。 */
  latest_completed_run?: ProjectTaskRun | null
  /** 任务下全部对话（各次执行/准备会话）；责任人外 session_id 为空。 */
  conversations?: ProjectTaskConversation[]
  deliverables: Array<{
    id: string
    context_item_id: string
    title: string
    item_type: string
    resource_id: string
    preview: string
    metadata: Record<string, unknown>
    created_at: string
  }>
  events?: Array<{
    id: string
    event_type: string
    actor: {
      id: string | null
      name: string
    }
    payload: Record<string, unknown>
    created_at: string
  }>
  version: number
  created_at: string
  updated_at: string
}

export interface ProjectTaskListResponse {
  tasks: ProjectTask[]
  total: number
}

/** ：按 Agent 跨 Project 聚合任务列表项（含 project 元数据） */
export interface AgentProjectTaskListItem extends ProjectTask {
  project: {
    id: string
    name: string
  }
}

export interface AgentProjectTaskListResponse {
  tasks: AgentProjectTaskListItem[]
  next_cursor: string | null
  has_more: boolean
}

export interface CreateProjectTaskRequest {
  title: string
  description?: string
  priority: ProjectTaskPriority
  responsible_user_id: string
}
