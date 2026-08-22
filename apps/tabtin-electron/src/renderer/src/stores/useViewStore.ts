/** @store-category domain */

/**
 * 视图 Store（Electron 宿主包装层）
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
import i18n from '@/i18n'
import { registerResetAction } from './sessionResetRegistry'
import { bindTableRequestHeaders } from './bindTableRequestHeaders'
import { useAuthStore } from './useAuthStore'

const { translate, logger } = createHostAdapters(i18n)

const buildViewStoreCreator = (
  requestHeaders?: Record<string, string>,
): StateCreator<ViewStore> => createViewStoreState({
  viewService: bindTableRequestHeaders(ViewApiService, requestHeaders),
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

export const createViewStore = (requestHeaders?: Record<string, string>) =>
  createStore<ViewStore>()(buildViewStoreCreator(requestHeaders))

export type ViewStoreApi = ReturnType<typeof createViewStore>

const {
  store: viewStore,
  Provider: ViewStoreProvider,
  useStore: useViewStore,
  useStoreApi: useViewStoreApi,
} = createStoreHost<ViewStore>(createViewStore())

export { viewStore, ViewStoreProvider, useViewStore, useViewStoreApi }

registerResetAction('view', 'reset', () => viewStore.getState().reset())
