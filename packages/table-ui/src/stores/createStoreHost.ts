import React from 'react'
import { useStore, type StoreApi } from 'zustand'

/**
 * 为 zustand store 创建标准化的 React Context / Provider / Hook 三件套。
 *
 * 两端（Electron / Web）的 store 包装层 90% 以上是相同的 Context + Provider + useStore 模板代码，
 * 此工具函数将其统一提取。
 */
export function createStoreHost<T>(
  defaultStore: StoreApi<T>,
) {
  const StoreContext = React.createContext<StoreApi<T> | null>(null)

  const Provider: React.FC<{
    store?: StoreApi<T>
    children: React.ReactNode
  }> = ({ store, children }) =>
    React.createElement(
      StoreContext.Provider,
      { value: store ?? defaultStore },
      children,
    )

  const useStoreHook = <R = T>(selector?: (state: T) => R) => {
    const ctx = React.useContext(StoreContext) ?? defaultStore
    const sel = selector ?? ((state: T) => state as unknown as R)
    return useStore(ctx, sel)
  }

  const useStoreApi = () => React.useContext(StoreContext) ?? defaultStore

  return {
    store: defaultStore,
    Provider,
    useStore: useStoreHook,
    useStoreApi,
  }
}
