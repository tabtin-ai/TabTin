/**
 * 组织 UI 组件的类型定义
 * 这些类型用于 UI 组件的 props，不包含业务逻辑
 */

export type OrganizationRole = 'owner' | 'admin' | 'editor' | 'viewer'

export interface OrganizationSettings {
  theme?: string
  language?: string
  [key: string]: any
}

export interface Organization {
  id: string
  name: string
  description?: string
  /** @deprecated 仅兼容历史数据；新版 UI 统一使用系统组织图标。 */
  icon?: string
  type?: 'personal' | 'team'
  owner_id: string
  is_default: boolean
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
}

export interface CreateOrganizationData {
  name: string
  description?: string
  /** @deprecated 仅兼容旧调用方；创建组织对话框不再提供图标配置。 */
  icon?: string
  /**
   * 可选组织设置。创建时可带 `logo_url`（公开 CDN URL），
   * 由宿主在提交前完成裁剪上传。
   */
  settings?: OrganizationSettings
}

export interface UpdateOrganizationData {
  name?: string
  description?: string
  /** @deprecated 仅兼容旧调用方；新版 UI 不再提供图标配置。 */
  icon?: string
  settings?: OrganizationSettings
}

export interface AddMemberData {
  user_id: string
  role: 'admin' | 'editor' | 'viewer'
}
