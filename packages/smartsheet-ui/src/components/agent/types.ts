export type SpaceStatus = 'active' | 'paused' | 'completed' | 'archived'

export interface Space {
  id: string
  organization_id: string
  name: string
  description?: string
  icon?: string
  avatar?: string
  color?: string
  status: SpaceStatus
  table_count: number
  is_archived: boolean
  is_default: boolean
  created_at: string
  updated_at: string
}
