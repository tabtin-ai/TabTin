/**
 * 全局 QueryClient 配置
 *
 * 所有 react-query 查询共享此实例。
 * Electron 桌面应用不需要考虑 SSR hydration。
 */
import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: 'always',
    },
    mutations: {
      retry: 0,
    },
  },
})
