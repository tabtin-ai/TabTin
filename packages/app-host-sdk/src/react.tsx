/**
 * AppHostClient React 集成 —— Context / Provider / hook
 *
 * 由宿主在组件树外层注入 AppHostClient 实例，下游组件通过 useAppHostClient
 * 取到 client 后调用其 request() 等方法。
 */

import { createContext, useContext } from 'react'
import type { AppHostClient } from './app-client'

export const AppHostClientContext = createContext<AppHostClient | null>(null)

export const AppHostClientProvider = AppHostClientContext.Provider

export function useAppHostClient(): AppHostClient {
  const client = useContext(AppHostClientContext)
  if (!client) {
    throw new Error(
      '[useAppHostClient] AppHostClient not found in context. ' +
        'Ensure AppHostClientProvider wraps this component tree.',
    )
  }
  return client
}
