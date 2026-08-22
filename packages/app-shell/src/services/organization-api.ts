/**
 * 组织 API 服务 — 从 Electron 抽离
 */

import type {
  Organization,
  OrganizationListResponse,
  OrganizationCreatePolicy,
  CreateOrganizationRequest,
  UpdateOrganizationRequest,
  OrganizationSearchParams,
} from '../types/organization.js'
import { API_ENDPOINTS, joinApiPath } from '@tabtin/config'
import { authenticatedRequest, apiBaseUrl, formatApiErrorMessage } from './base.js'

export class OrganizationApiService {
  static async getOrganizationCreatePolicy(): Promise<OrganizationCreatePolicy> {
    const fullUrl = joinApiPath(apiBaseUrl(), '/platform-config/product-limits/organization-create-policy')
    const response = await authenticatedRequest({ url: fullUrl, method: 'GET' })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to load organization create policy')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to load organization create policy')
    }
    const policy = responseData.data
    if (typeof policy?.allowed !== 'boolean') {
      throw new Error('Invalid organization create policy response')
    }
    return policy as OrganizationCreatePolicy
  }

  static async getOrganizations(params?: OrganizationSearchParams): Promise<OrganizationListResponse> {
    const queryParams = new URLSearchParams()
    if (params?.search) queryParams.append('search', params.search)
    if (params?.is_default !== undefined) queryParams.append('is_default', String(params.is_default))

    const qs = queryParams.toString()
    const fullUrl = joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.ORGANIZATION.LIST}${qs ? `?${qs}` : ''}`)

    const response = await authenticatedRequest({ url: fullUrl, method: 'GET' })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to load organization list')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to load organization list')
    }
    const data = responseData.data
    if (!data?.organizations) {
      throw new Error('Invalid organization list response')
    }
    return data as OrganizationListResponse
  }

  static async getOrganization(organizationId: string): Promise<Organization> {
    const fullUrl = joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.ORGANIZATION.DETAIL(organizationId)}`)
    const response = await authenticatedRequest({ url: fullUrl, method: 'GET' })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to load organization detail')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to load organization detail')
    }
    const data = responseData.data
    if (!data?.id) {
      throw new Error('Invalid organization detail response')
    }
    return data as Organization
  }

  static async createOrganization(data: CreateOrganizationRequest): Promise<Organization> {
    if (!data.name || data.name.trim().length === 0) {
      throw new Error('Organization name is required')
    }
    if (data.name.length > 100) {
      throw new Error('Organization name is too long')
    }
    const fullUrl = joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.ORGANIZATION.CREATE}`)
    const response = await authenticatedRequest({
      url: fullUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!response || response.status !== 201) {
      throw new Error(response?.data?.message || 'Failed to create organization')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to create organization')
    }
    const organizationData = responseData.data
    if (!organizationData?.id) {
      throw new Error('Invalid create organization response')
    }
    return organizationData as Organization
  }

  static async updateOrganization(organizationId: string, data: UpdateOrganizationRequest): Promise<Organization> {
    if (data.name !== undefined && data.name.trim().length === 0) {
      throw new Error('Organization name is required')
    }
    if (data.name && data.name.length > 100) {
      throw new Error('Organization name is too long')
    }
    const fullUrl = joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.ORGANIZATION.UPDATE(organizationId)}`)
    const response = await authenticatedRequest({
      url: fullUrl,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to update organization')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to update organization')
    }
    const organizationData = responseData.data
    if (!organizationData?.id) {
      throw new Error('Invalid update organization response')
    }
    return organizationData as Organization
  }

  static async deleteOrganization(organizationId: string): Promise<void> {
    const fullUrl = joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.ORGANIZATION.DELETE(organizationId)}`)
    const response = await authenticatedRequest({ url: fullUrl, method: 'DELETE' })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to delete organization')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to delete organization')
    }
  }

  static async leaveOrganization(organizationId: string): Promise<void> {
    const fullUrl = joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.ORGANIZATION.LEAVE(organizationId)}`)
    const response = await authenticatedRequest({ url: fullUrl, method: 'POST' })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to leave organization')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to leave organization')
    }
  }

  static async transferOwnership(organizationId: string, newOwnerUserId: string): Promise<void> {
    const fullUrl = joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.ORGANIZATION_TRANSFER(organizationId)}`)
    const response = await authenticatedRequest({
      url: fullUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_owner_user_id: newOwnerUserId }),
    })
    if (!response || !response.data?.success) {
      throw new Error(formatApiErrorMessage(response?.data, 'Failed to transfer organization ownership'))
    }
  }

  static async checkHealth(): Promise<{ status: string; message: string }> {
    try {
      const fullUrl = joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.ORGANIZATION.HEALTH}`)
      const response = await authenticatedRequest({ url: fullUrl, method: 'GET' })
      if (response?.status === 200 && response.data) {
        const data = response.data.data || response.data
        return { status: data.status || 'unknown', message: data.message || 'Unknown status' }
      }
      return { status: 'unknown', message: 'Unexpected response' }
    } catch (error) {
      return {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Service unavailable',
      }
    }
  }

  static async getDefaultOrganization(): Promise<Organization | null> {
    try {
      const response = await this.getOrganizations({ is_default: true })
      if (response.organizations?.length > 0) return response.organizations[0]
      return null
    } catch {
      return null
    }
  }
}
