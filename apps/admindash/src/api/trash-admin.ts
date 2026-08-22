import { rawJson } from './raw-json'
import { getApiClient } from './tabtin-client'

export interface TrashOverview {
  total_trashed_resources: number
  trashed_spaces: number
  expiring_soon_3_days: number
  by_type: Array<{ item_type: string; count: number }>
}

export interface TrashedResource {
  id: string
  resource_id: string | null
  item_type: string
  title: string
  organization_id?: string | null
  space_id: string | null
  trashed_at: string | null
  trashed_by: string | null
  trashed_by_name?: string | null
  created_by?: string | null
  created_by_name?: string | null
  previous_status: string | null
  created_at: string | null
}

export interface TrashedResourceListData {
  items: TrashedResource[]
  total: number
  page: number
  page_size: number
}

export interface TrashedSpace {
  id: string
  name: string
  icon?: string | null
  description?: string | null
  status?: string | null
  type?: string | null
  organization_id?: string | null
  trashed_at: string | null
  trashed_by: string | null
  trashed_by_name?: string | null
  created_by?: string | null
  created_by_name?: string | null
  previous_status?: string | null
  created_at?: string | null
}

export interface TrashedSpaceListData {
  items: TrashedSpace[]
  total: number
  page: number
  page_size: number
}

export interface ListTrashedParams {
  item_type?: string
  attention?: string
  organization_id?: string
  page?: number
  page_size?: number
}

export interface ListTrashedSpacesParams {
  organization_id: string
  page?: number
  page_size?: number
}

export interface TrashSensitiveActionPayload {
  reason: string
  ticket_id?: string
}

export interface EmptyOrganizationTrashResult {
  success?: boolean
  message: string
  data?: {
    deleted_count: number
    remaining: number
  }
}

export const trashAdminApi = {
  async getOverview(): Promise<TrashOverview> {
    return getApiClient().raw<TrashOverview>('GET', '/auth/admin/trash/overview')
  },

  async listResources(params?: ListTrashedParams): Promise<TrashedResourceListData> {
    const queryParams: Record<string, string | number> = {}
    if (params?.item_type) queryParams.item_type = params.item_type
    if (params?.attention) queryParams.attention = params.attention
    if (params?.organization_id) queryParams.organization_id = params.organization_id
    queryParams.page = params?.page ?? 1
    queryParams.page_size = params?.page_size ?? 50
    return getApiClient().raw<TrashedResourceListData>('GET', '/auth/admin/trash/resources', {
      params: queryParams,
    })
  },

  async listTrashedSpaces(params: ListTrashedSpacesParams): Promise<TrashedSpaceListData> {
    return getApiClient().raw<TrashedSpaceListData>('GET', '/auth/admin/trash/spaces', {
      params: {
        organization_id: params.organization_id,
        page: params.page ?? 1,
        page_size: params.page_size ?? 20,
      },
    })
  },

  async forceCleanup(payload: TrashSensitiveActionPayload): Promise<{ message: string }> {
    return rawJson<{ message: string }>('POST', '/auth/admin/trash/force-cleanup', {
      reason: payload.reason,
      ticket_id: payload.ticket_id ?? '',
    })
  },

  async emptyOrganizationResourceTrash(
    organizationId: string,
    payload: TrashSensitiveActionPayload
  ): Promise<EmptyOrganizationTrashResult> {
    return rawJson<EmptyOrganizationTrashResult>(
      'POST',
      `/auth/admin/trash/organizations/${organizationId}/empty`,
      {
        reason: payload.reason,
        ticket_id: payload.ticket_id ?? '',
      }
    )
  },

  async permanentDelete(
    contextItemId: string,
    payload: TrashSensitiveActionPayload
  ): Promise<void> {
    await rawJson('DELETE', `/auth/admin/trash/resources/${contextItemId}`, {
      reason: payload.reason,
      ticket_id: payload.ticket_id ?? '',
    })
  },

  async restoreResource(
    contextItemId: string,
    payload: TrashSensitiveActionPayload
  ): Promise<{ message: string }> {
    return rawJson<{ message: string }>(
      'POST',
      `/auth/admin/trash/resources/${contextItemId}/restore`,
      {
        reason: payload.reason,
        ticket_id: payload.ticket_id ?? '',
      }
    )
  },

  /** 将活跃资源移入回收站（可恢复） */
  async trashResource(
    contextItemId: string,
    payload: TrashSensitiveActionPayload
  ): Promise<{ message: string }> {
    return rawJson<{ message: string }>('POST', `/auth/admin/resources/${contextItemId}/trash`, {
      reason: payload.reason,
      ticket_id: payload.ticket_id ?? '',
    })
  },

  /** 将活跃协作空间移入回收站（可恢复） */
  async trashSpace(
    spaceId: string,
    payload: TrashSensitiveActionPayload
  ): Promise<{ message: string }> {
    return rawJson<{ message: string }>('POST', `/auth/admin/spaces/${spaceId}/trash`, {
      reason: payload.reason,
      ticket_id: payload.ticket_id ?? '',
    })
  },

  async restoreSpace(
    spaceId: string,
    payload: TrashSensitiveActionPayload
  ): Promise<{ message: string }> {
    return rawJson<{ message: string }>('POST', `/auth/admin/trash/spaces/${spaceId}/restore`, {
      reason: payload.reason,
      ticket_id: payload.ticket_id ?? '',
    })
  },

  async permanentDeleteSpace(
    spaceId: string,
    payload: TrashSensitiveActionPayload
  ): Promise<{ message: string }> {
    return rawJson<{ message: string }>('DELETE', `/auth/admin/trash/spaces/${spaceId}`, {
      reason: payload.reason,
      ticket_id: payload.ticket_id ?? '',
    })
  },
}
