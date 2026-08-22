/**
 * API Token 状态管理 (Zustand StateCreator)
 *
 * 与 table-store / record-store 模式一致：
 * 核心包定义 State + StateCreator，宿主层注入具体 service。
 */

import type { StateCreator } from 'zustand'
import type {
  ApiToken,
  CreateTokenRequest,
  CreateTokenResponse,
  UpdateTokenRequest,
} from '../data'

// ── Store Interface ──────────────────────────────────

export interface TokenStore {
  // 状态
  tokens: ApiToken[]
  isLoading: boolean
  error: string | null

  // 操作
  loadTokens: () => Promise<void>
  createToken: (req: CreateTokenRequest) => Promise<CreateTokenResponse | null>
  updateToken: (tokenId: string, req: UpdateTokenRequest) => Promise<ApiToken | null>
  deleteToken: (tokenId: string) => Promise<boolean>
  regenerateToken: (tokenId: string) => Promise<CreateTokenResponse | null>
  clearError: () => void
}

// ── 依赖注入 ──────────────────────────────────────────

export interface TokenStoreService {
  list: () => Promise<ApiToken[]>
  create: (req: CreateTokenRequest) => Promise<CreateTokenResponse>
  update: (tokenId: string, req: UpdateTokenRequest) => Promise<ApiToken>
  delete: (tokenId: string) => Promise<void>
  regenerate: (tokenId: string) => Promise<CreateTokenResponse>
}

export interface TokenStoreDeps {
  tokenService: TokenStoreService
  translate?: (key: string, fallback: string, options?: Record<string, unknown>) => string
}

// ── StateCreator ──────────────────────────────────────

export const createTokenStoreState = (
  deps: TokenStoreDeps,
): StateCreator<TokenStore> => {
  const { tokenService, translate } = deps

  const t = (key: string, fallback: string): string =>
    translate?.(key, fallback) ?? fallback

  return (set, get) => ({
    tokens: [],
    isLoading: false,
    error: null,

    loadTokens: async () => {
      set({ isLoading: true, error: null })
      try {
        const tokens = await tokenService.list()
        set({ tokens, isLoading: false })
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : t('token:apiErrors.loadFailed', '加载 Token 失败')
        set({ error: msg, isLoading: false })
      }
    },

    createToken: async (req: CreateTokenRequest) => {
      set({ error: null })
      try {
        const result = await tokenService.create(req)
        set({ tokens: [result.token, ...get().tokens] })
        return result
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : t('token:apiErrors.createFailed', '创建 Token 失败')
        set({ error: msg })
        return null
      }
    },

    updateToken: async (tokenId: string, req: UpdateTokenRequest) => {
      set({ error: null })
      try {
        const updated = await tokenService.update(tokenId, req)
        set({
          tokens: get().tokens.map((tk) => (tk.id === tokenId ? updated : tk)),
        })
        return updated
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : t('token:apiErrors.updateFailed', '更新 Token 失败')
        set({ error: msg })
        return null
      }
    },

    deleteToken: async (tokenId: string) => {
      set({ error: null })
      try {
        await tokenService.delete(tokenId)
        set({ tokens: get().tokens.filter((tk) => tk.id !== tokenId) })
        return true
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : t('token:apiErrors.deleteFailed', '删除 Token 失败')
        set({ error: msg })
        return false
      }
    },

    regenerateToken: async (tokenId: string) => {
      set({ error: null })
      try {
        const result = await tokenService.regenerate(tokenId)
        set({
          tokens: get().tokens.map((tk) => (tk.id === tokenId ? result.token : tk)),
        })
        return result
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : t('token:apiErrors.regenerateFailed', '重新生成 Token 失败')
        set({ error: msg })
        return null
      }
    },

    clearError: () => set({ error: null }),
  })
}
