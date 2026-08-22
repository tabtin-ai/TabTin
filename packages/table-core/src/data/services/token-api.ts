/**
 * Open API Token 管理 API Service
 */

import {
  requestJsonApi,
  translate,
} from '../http'
import type {
  ApiToken,
  CreateTokenRequest,
  CreateTokenResponse,
  UpdateTokenRequest,
  AvailableScopesResponse,
} from '../types/token'

const TOKEN_ERROR_KEYS = {
  FETCH_LIST_FAILED: 'token:apiErrors.fetchListFailed',
  CREATE_FAILED: 'token:apiErrors.createFailed',
  UPDATE_FAILED: 'token:apiErrors.updateFailed',
  DELETE_FAILED: 'token:apiErrors.deleteFailed',
  REGENERATE_FAILED: 'token:apiErrors.regenerateFailed',
  FETCH_SCOPES_FAILED: 'token:apiErrors.fetchScopesFailed',
} as const

const tokenMessage = (
  key: (typeof TOKEN_ERROR_KEYS)[keyof typeof TOKEN_ERROR_KEYS],
  fallback: string,
) => translate(key, fallback)

// ── API 端点 ──────────────────────────────────────────

const ENDPOINTS = {
  LIST: '/tabdata/tokens',
  CREATE: '/tabdata/tokens',
  DETAIL: (tokenId: string) => `/tabdata/tokens/${tokenId}`,
  UPDATE: (tokenId: string) => `/tabdata/tokens/${tokenId}`,
  DELETE: (tokenId: string) => `/tabdata/tokens/${tokenId}`,
  REGENERATE: (tokenId: string) => `/tabdata/tokens/${tokenId}/regenerate`,
  AVAILABLE_SCOPES: '/tabdata/tokens/scopes/available',
} as const

// ── 响应归一化 ──────────────────────────────────────────

function normalizeToken(raw: Record<string, unknown>): ApiToken {
  return {
    id: raw.id as string,
    name: raw.name as string,
    description: (raw.description as string) || '',
    tokenPrefix: raw.token_prefix as string,
    spaceId: (raw.space_id as string | null) ?? null,
    scopes: raw.scopes as ApiToken['scopes'],
    spaceIds: (raw.space_ids as string[] | null) ?? null,
    tableIds: (raw.table_ids as string[] | null) ?? null,
    rateLimit: raw.rate_limit as number,
    expiredAt: (raw.expired_at as string | null) ?? null,
    lastUsedAt: (raw.last_used_at as string | null) ?? null,
    useCount: (raw.use_count as number) || 0,
    isActive: raw.is_active as boolean,
    createdAt: raw.created_at as string,
  }
}

// ── Service ──────────────────────────────────────────────

export class TokenApiService {
  /**
   * 列出当前用户的 API Token；可按 Space 过滤
   */
  static async list(spaceId?: string): Promise<ApiToken[]> {
    const endpoint = spaceId
      ? `${ENDPOINTS.LIST}?space_id=${encodeURIComponent(spaceId)}`
      : ENDPOINTS.LIST
    const raw = await requestJsonApi<Record<string, unknown>[]>({
      endpoint,
      method: 'GET',
      fallbackError: tokenMessage(TOKEN_ERROR_KEYS.FETCH_LIST_FAILED, '获取 Token 列表失败'),
    })
    return (raw ?? []).map(normalizeToken)
  }

  /**
   * 创建新的 API Token（返回一次性明文）
   */
  static async create(body: CreateTokenRequest): Promise<CreateTokenResponse> {
    const raw = await requestJsonApi<{
      token: Record<string, unknown>
      plain_token: string
    }>({
      endpoint: ENDPOINTS.CREATE,
      method: 'POST',
      body,
      fallbackError: tokenMessage(TOKEN_ERROR_KEYS.CREATE_FAILED, '创建 Token 失败'),
    })
    return {
      token: normalizeToken(raw!.token),
      plainToken: raw!.plain_token,
    }
  }

  /**
   * 更新 Token
   */
  static async update(tokenId: string, body: UpdateTokenRequest): Promise<ApiToken> {
    const raw = await requestJsonApi<Record<string, unknown>>({
      endpoint: ENDPOINTS.UPDATE(tokenId),
      method: 'PATCH',
      body,
      fallbackError: tokenMessage(TOKEN_ERROR_KEYS.UPDATE_FAILED, '更新 Token 失败'),
    })
    return normalizeToken(raw!)
  }

  /**
   * 删除 Token
   */
  static async delete(tokenId: string): Promise<void> {
    await requestJsonApi<void>({
      endpoint: ENDPOINTS.DELETE(tokenId),
      method: 'DELETE',
      fallbackError: tokenMessage(TOKEN_ERROR_KEYS.DELETE_FAILED, '删除 Token 失败'),
    })
  }

  /**
   * 重新生成 Token 签名（旧签名立即失效）
   */
  static async regenerate(tokenId: string): Promise<CreateTokenResponse> {
    const raw = await requestJsonApi<{
      token: Record<string, unknown>
      plain_token: string
    }>({
      endpoint: ENDPOINTS.REGENERATE(tokenId),
      method: 'POST',
      fallbackError: tokenMessage(TOKEN_ERROR_KEYS.REGENERATE_FAILED, '重新生成 Token 失败'),
    })
    return {
      token: normalizeToken(raw!.token),
      plainToken: raw!.plain_token,
    }
  }

  /**
   * 获取可用的 Scope 列表和预设组合
   */
  static async getAvailableScopes(): Promise<AvailableScopesResponse> {
    const raw = await requestJsonApi<AvailableScopesResponse>({
      endpoint: ENDPOINTS.AVAILABLE_SCOPES,
      method: 'GET',
      fallbackError: tokenMessage(TOKEN_ERROR_KEYS.FETCH_SCOPES_FAILED, '获取 Scope 列表失败'),
    })
    return raw!
  }
}
