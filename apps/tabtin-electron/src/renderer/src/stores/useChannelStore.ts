/** @store-category domain */

/**
 * Zustand store for Channel Gateway state.
 */

import { create } from 'zustand'
import i18n from '@/i18n'
import { registerResetAction } from './sessionResetRegistry'
import {
  channelApi,
  type ChannelAccountPayload,
  type ChannelAccountResponse,
  type ChannelRuntimeStatusResponse,
} from '@/services/channelApi'
import { createLogger } from '@/utils/logger'

const log = createLogger('Channel')

interface ChannelState {
  accounts: ChannelAccountResponse[]
  runtimeStatuses: ChannelRuntimeStatusResponse[]
  loading: boolean
  error: string | null

  fetchAccounts: (organizationId: string) => Promise<void>
  fetchRuntimeStatuses: (organizationId: string) => Promise<void>
  createAccount: (payload: ChannelAccountPayload) => Promise<ChannelAccountResponse>
  updateAccount: (id: string, payload: Partial<ChannelAccountPayload>) => Promise<void>
  deleteAccount: (id: string, organizationId: string) => Promise<void>
  getStatusForAccount: (channel: string, accountId: string) => ChannelRuntimeStatusResponse | undefined
  clearAll: () => void
}

export const useChannelStore = create<ChannelState>((set, get) => ({
  accounts: [],
  runtimeStatuses: [],
  loading: false,
  error: null,

  fetchAccounts: async (organizationId) => {
    set({ loading: true, error: null })
    try {
      const accounts = await channelApi.listAccounts(organizationId)
      set({ accounts, loading: false })
    } catch (err) {
      log.error('fetchAccounts failed:', { organizationId, error: err })
      set({ error: err instanceof Error ? err.message : i18n.t('channel:errors.loadAccountsFailed'), loading: false })
    }
  },

  fetchRuntimeStatuses: async (organizationId) => {
    try {
      const runtimeStatuses = await channelApi.listRuntimeStatus(organizationId)
      set({ runtimeStatuses })
    } catch (err) {
      // 运行时状态非致命：拉取失败仅影响状态角标，不阻塞账号列表
      log.warn('fetchRuntimeStatuses failed (non-critical):', { organizationId, error: err })
    }
  },

  createAccount: async (payload) => {
    const account = await channelApi.createAccount(payload)
    set((s) => ({ accounts: [...s.accounts, account] }))
    return account
  },

  updateAccount: async (id, payload) => {
    const updated = await channelApi.updateAccount(id, payload)
    set((s) => ({
      accounts: s.accounts.map((a) => (a.id === id ? updated : a)),
    }))
  },

  deleteAccount: async (id, organizationId) => {
    await channelApi.deleteAccount(id)
    set((s) => ({
      accounts: s.accounts.filter((a) => a.id !== id),
    }))
  },

  getStatusForAccount: (channel, accountId) => {
    return get().runtimeStatuses.find(
      (s) => s.channel === channel && s.account_id === accountId,
    )
  },

  clearAll: () => {
    set({ accounts: [], runtimeStatuses: [], loading: false, error: null })
  },
}))

registerResetAction('channel', 'reset', () => useChannelStore.getState().clearAll())
