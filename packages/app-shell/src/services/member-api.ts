/**
 * 组织成员管理 API 服务 — 从 Electron 抽离
 */

import type {
  OrganizationMember,
  MemberListResponse,
  AddMemberRequest,
  UpdateMemberRoleRequest,
  OrganizationRole,
  MemberIdentitySnapshotListResponse,
} from '../types/organization.js'
import { ASSIGNABLE_ROLES } from '../types/organization.js'
import { API_ENDPOINTS, joinApiPath } from '@tabtin/config'
import { authenticatedRequest, apiBaseUrl } from './base.js'

export interface MemberSearchParams {
  search?: string
  role?: string
  offset?: number
  limit?: number
}

export class MemberApiService {
  static async getMembers(organizationId: string, params?: MemberSearchParams): Promise<MemberListResponse> {
    const url = new URL(joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.ORGANIZATION_MEMBER.LIST(organizationId)}`))
    if (params?.search) url.searchParams.set('search', params.search)
    if (params?.role) url.searchParams.set('role', params.role)
    if (params?.offset) url.searchParams.set('offset', String(params.offset))
    if (params?.limit) url.searchParams.set('limit', String(params.limit))

    const response = await authenticatedRequest({ url: url.toString(), method: 'GET' })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to load members')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to load members')
    }
    const data = responseData.data
    if (!data?.members) {
      throw new Error('Invalid members response')
    }
    return data as MemberListResponse
  }

  static async getIdentitySnapshots(organizationId: string): Promise<MemberIdentitySnapshotListResponse> {
    const fullUrl = joinApiPath(
      apiBaseUrl(),
      `${API_ENDPOINTS.ORGANIZATION_MEMBER.LIST(organizationId)}/identity-snapshots`,
    )
    const response = await authenticatedRequest({ url: fullUrl, method: 'GET' })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to load member identity snapshots')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to load member identity snapshots')
    }
    const data = responseData.data
    if (!Array.isArray(data?.identities)) {
      throw new Error('Invalid member identity snapshots response')
    }
    return data as MemberIdentitySnapshotListResponse
  }

  static async addMember(organizationId: string, data: AddMemberRequest): Promise<OrganizationMember> {
    if (!data.user_id || data.user_id.trim().length === 0) {
      throw new Error('User ID is required')
    }
    if (!data.role || !(ASSIGNABLE_ROLES as readonly string[]).includes(data.role)) {
      throw new Error('Invalid role')
    }

    const fullUrl = joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.ORGANIZATION_MEMBER.ADD(organizationId)}`)
    const response = await authenticatedRequest({
      url: fullUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!response || response.status !== 201) {
      throw new Error(response?.data?.message || 'Failed to add member')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to add member')
    }
    const memberData = responseData.data
    if (!memberData?.id) {
      throw new Error('Invalid add member response')
    }
    return memberData as OrganizationMember
  }

  static async updateMemberRole(
    organizationId: string,
    userId: string,
    data: UpdateMemberRoleRequest,
  ): Promise<void> {
    if (!data.role || !(ASSIGNABLE_ROLES as readonly string[]).includes(data.role)) {
      throw new Error('Invalid role')
    }
    const fullUrl = joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.ORGANIZATION_MEMBER.UPDATE(organizationId, userId)}`)
    const response = await authenticatedRequest({
      url: fullUrl,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to update member role')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to update member role')
    }
  }

  static async removeMember(organizationId: string, userId: string): Promise<void> {
    const fullUrl = joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.ORGANIZATION_MEMBER.REMOVE(organizationId, userId)}`)
    const response = await authenticatedRequest({ url: fullUrl, method: 'DELETE' })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to remove member')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to remove member')
    }
  }

  static async getCurrentUserRole(
    organizationId: string,
    currentUserId: string,
    ownerId: string,
  ): Promise<OrganizationRole> {
    if (currentUserId === ownerId) return 'owner'
    try {
      const response = await this.getMembers(organizationId)
      const member = response.members.find((m) => m.user_id === currentUserId)
      if (member) return member.role
      throw new Error('Permission denied')
    } catch (error) {
      throw error
    }
  }
}
