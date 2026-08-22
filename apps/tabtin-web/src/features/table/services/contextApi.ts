import { getApiClient } from '@/services/api-client'

export interface OrganizationSummary {
  id: string
  name: string
  is_default: boolean
  icon?: string
}

export interface OrganizationListResponse {
  organizations: OrganizationSummary[]
  total: number
}

export interface SpaceSummary {
  id: string
  organization_id: string
  name: string
  type?: 'workspace'
  icon?: string
  color?: string
  description?: string
  order?: number
  status?: string
  is_archived?: boolean
}

export interface SpaceListResponse {
  spaces: SpaceSummary[]
  total: number
}

export async function listOrganizations(): Promise<OrganizationListResponse> {
  return getApiClient().raw<OrganizationListResponse>('GET', '/organizations')
}

export async function listWorkspaceSpaces(organizationId: string): Promise<SpaceListResponse> {
  return getApiClient().raw<SpaceListResponse>('GET', '/spaces', {
    params: {
      organization_id: organizationId,
      type: 'workspace',
      is_archived: false,
    },
  })
}
