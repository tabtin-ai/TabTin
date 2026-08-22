/**
 * 视图 Store（Web 宿主包装层）
 *
 * 领域逻辑在 @tabtin/table-core/domain，此文件仅注入宿主服务。
 */

import { createStore } from 'zustand'
import type { StateCreator } from 'zustand'
import {
  createViewStoreState,
  ViewApiService,
  type ViewStore,
} from '@tabtin/table-core'
import { createStoreHost, createHostAdapters } from '@tabtin/table-ui'
import { registerResetAction } from '@tabtin/app-shell'
import i18n from '@/i18n'
import { useAuthStore } from '@/stores/auth-store'

const { translate, logger } = createHostAdapters(i18n)

const baseCreator: StateCreator<ViewStore> = createViewStoreState({
  viewService: ViewApiService,
  getCurrentUserId: () => useAuthStore.getState().user?.id ?? null,
  translate,
  logger: { ...logger, debug: logger.debug ?? ((...args: unknown[]) => console.debug(...args)) },
  isDebugEnabled: () => {
    try {
      return localStorage.getItem('debug:view-store') === '1'
    } catch {
      return false
    }
  },
})

export const createViewStore = () => createStore<ViewStore>()(baseCreator)

export type ViewStoreApi = ReturnType<typeof createViewStore>

const {
  store: viewStore,
  Provider: ViewStoreProvider,
  useStore: useViewStore,
  useStoreApi: useViewStoreApi,
} = createStoreHost<ViewStore>(createViewStore())

export { viewStore, ViewStoreProvider, useViewStore, useViewStoreApi }

registerResetAction('web-view', 'reset', () => viewStore.getState().reset())
