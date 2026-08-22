/**
 * 记录 Store（Web 宿主包装层）
 *
 * 领域逻辑在 @tabtin/table-core/domain，此文件仅注入宿主服务与 ViewStore 桥接。
 */

import { createStore } from 'zustand'
import type { StateCreator } from 'zustand'
import { persist } from 'zustand/middleware'
import { registerResetAction } from '@tabtin/app-shell'
import {
  createRecordStoreState,
  createRecordStorePersistOptions,
  RecordApiService,
  type RecordStore,
  type RecordStoreViewBridge,
} from '@tabtin/table-core'
import { createStoreHost, createHostAdapters } from '@tabtin/table-ui'
import i18n from '@/i18n'
import { viewStore, type ViewStoreApi } from './useViewStore'

type CreateRecordStoreOptions = {
  persisted?: boolean
  viewStore?: ViewStoreApi
}

type ViewStoreState = ReturnType<ViewStoreApi['getState']>

const createViewStoreBridge = (viewStoreApi?: ViewStoreApi): RecordStoreViewBridge | undefined => {
  if (!viewStoreApi) return undefined
  return {
    getState: () => ({
      currentViewRecords: viewStoreApi.getState().currentViewRecords,
    }),
    setState: (partial, _replace) => {
      const nextPartial =
        typeof partial === 'function'
          ? partial({ currentViewRecords: viewStoreApi.getState().currentViewRecords })
          : partial
      viewStoreApi.setState(nextPartial as Partial<ViewStoreState>)
    },
  }
}

const { translate, logger } = createHostAdapters(i18n)

const buildRecordStoreCreator = (options?: CreateRecordStoreOptions): StateCreator<RecordStore> => {
  const baseCreator = createRecordStoreState({
    recordService: RecordApiService,
    viewStore: createViewStoreBridge(options?.viewStore),
    translate,
    logger,
  })
  if (!options?.persisted) return baseCreator
  return persist(baseCreator, createRecordStorePersistOptions()) as unknown as StateCreator<RecordStore>
}

export const createRecordStore = (options?: CreateRecordStoreOptions) =>
  createStore<RecordStore>()(buildRecordStoreCreator(options))

export type RecordStoreApi = ReturnType<typeof createRecordStore>

const {
  store: recordStore,
  Provider: RecordStoreProvider,
  useStore: useRecordStore,
  useStoreApi: useRecordStoreApi,
} = createStoreHost<RecordStore>(createRecordStore({ persisted: true, viewStore }))

export { recordStore, RecordStoreProvider, useRecordStore, useRecordStoreApi }

registerResetAction('web-record', 'reset', () => recordStore.getState().reset())
