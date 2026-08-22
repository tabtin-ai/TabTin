/**
 * Organization (组织) 类型定义
 */

export type OrganizationType = 'personal' | 'team'

export type OrganizationRole = 'owner' | 'admin' | 'editor' | 'viewer'

export type AssignableRole = Exclude<OrganizationRole, 'owner'>
export const ASSIGNABLE_ROLES: readonly AssignableRole[] = ['admin', 'editor', 'viewer'] as const
/**
 * UI 层可见的可分配角色。产品调整（2026-06-10）：两级模型收口为 Owner + Editor——
 * 管理动作（成员/邀请/计费/应用/Agent 停用/组织设置）全部 owner-only，editor 负责内容读写。
 * 数据层（OrganizationRole 枚举 / ROLE_LEVELS / member-api 契约）仍保留 admin、viewer 用于
 * 存量成员展示与识别；后端新写入同样只接受 editor。
 * 未来需放开多级时，改这一个常量即可恢复。
 */
export const UI_ASSIGNABLE_ROLES: readonly AssignableRole[] = ['editor'] as const
export const ROLE_LEVELS: Record<OrganizationRole, number> = { owner: 4, admin: 3, editor: 2, viewer: 1 }

export interface OrganizationSettings {
  theme?: 'light' | 'dark' | 'auto'
  language?: string
  /**
   * 组织头像（公开 CDN URL 或 OSS object key）。读写走 updateOrganization settings，
   * 仅 owner 可改（与组织资料其他字段一致）。侧栏身份入口仍用系统图标。
   */
  logo_url?: string
  /**
   * Yolo 准入天花板：组织是否允许其成员在对话里使用 Yolo 档。
   * 默认 false（缺省 = 关闭）。这是 Yolo 的唯一 gate——组织不开放，任何成员
   * 都无法进入 yolo；开放后成员仍需在自己的对话里显式选 yolo（per-session）。
   * 只有 owner 可改（见 useCanManageOrganization / 后端 owner-only 校验）。
   */
  allow_member_yolo?: boolean
  [key: string]: any
}

export interface Organization {
  id: string
  name: string
  description?: string
  /** @deprecated 仅兼容历史数据；新版 UI 统一使用系统组织图标。 */
  icon?: string
  type: OrganizationType
  owner_id: string
  is_default: boolean
  member_count?: number
  space_count?: number
  settings?: OrganizationSettings
  created_at: string
  updated_at: string
}

export interface OrganizationMember {
  id: string
  organization_id: string
  user_id: string
  role: OrganizationRole
  joined_at: string
  user?: {
    id?: string
    username?: string
    nickname?: string
    email?: string
    phone?: string
    avatar?: string
  }
}

export interface CreateOrganizationRequest {
  name: string
  description?: string
  /** @deprecated 仅兼容旧客户端；新版客户端不再写入。 */
  icon?: string
  settings?: OrganizationSettings
  default_agent_device_fingerprint?: string
  default_agent_working_dir?: string
  default_agent_working_dir_type?: 'code' | 'mixed' | 'doc'
}

export interface UpdateOrganizationRequest {
  name?: string
  description?: string
  /** @deprecated 仅兼容旧客户端；新版客户端不再写入。 */
  icon?: string
  settings?: OrganizationSettings
}

export interface AddMemberRequest {
  user_id: string
  role: AssignableRole
}

export interface UpdateMemberRoleRequest {
  role: AssignableRole
}

export interface OrganizationListResponse {
  organizations: Organization[]
  total: number
}

export interface OrganizationCreatePolicy {
  allowed: boolean
  current_count: number
  max_allowed: number
  remaining: number
  message: string
}

export interface MemberListResponse {
  members: OrganizationMember[]
  total: number
}

export interface OrganizationMemberIdentitySnapshot {
  user_id: string
  display_name: string
  left_at: string
}

export interface MemberIdentitySnapshotListResponse {
  identities: OrganizationMemberIdentitySnapshot[]
  total: number
}

export interface OrganizationStats {
  spaceCount: number
  tableCount: number
  memberCount: number
  storageUsed?: number
  lastActivity?: string
}

export interface OrganizationDetail extends Organization {
  stats?: OrganizationStats
  members?: OrganizationMember[]
  currentUserRole?: OrganizationRole
}

export interface OrganizationSearchParams {
  search?: string
  is_default?: boolean
  type?: OrganizationType
}
