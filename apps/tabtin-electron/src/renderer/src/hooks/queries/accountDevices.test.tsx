import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listAccountDevices: vi.fn(),
  userId: 'user-1',
}))

vi.mock('@/services/daemonControlApi', () => ({
  listAccountDevices: mocks.listAccountDevices,
}))

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: (
    selector: (state: { user: { id: string } | null }) => unknown,
  ) => selector({ user: mocks.userId ? { id: mocks.userId } : null }),
}))

import { accountDeviceKeys, useAccountDevicesQuery } from './accountDevices'

function createQueryHarness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, wrapper }
}

describe('useAccountDevicesQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.userId = 'user-1'
    mocks.listAccountDevices.mockResolvedValue([])
  })

  it('按当前账号隔离缓存并在页面打开时查询', async () => {
    const { queryClient, wrapper } = createQueryHarness()

    renderHook(() => useAccountDevicesQuery(), { wrapper })

    await waitFor(() => expect(mocks.listAccountDevices).toHaveBeenCalledOnce())
    expect(queryClient.getQueryData(accountDeviceKeys.list('user-1'))).toEqual(
      [],
    )
    expect(accountDeviceKeys.list('user-1')).not.toEqual(
      accountDeviceKeys.list('user-2'),
    )
    const query = queryClient.getQueryCache().find({
      queryKey: accountDeviceKeys.list('user-1'),
    })
    expect(query?.options.refetchOnMount).toBe('always')
    expect(query?.options.refetchOnWindowFocus).toBe(true)
    expect(query?.options.refetchInterval).toBeUndefined()
  })

  it('未登录时不请求设备控制面', () => {
    mocks.userId = ''
    const { wrapper } = createQueryHarness()

    const { result } = renderHook(() => useAccountDevicesQuery(), { wrapper })

    expect(result.current.fetchStatus).toBe('idle')
    expect(mocks.listAccountDevices).not.toHaveBeenCalled()
  })

  it('调用方禁用时不请求设备控制面', () => {
    const { wrapper } = createQueryHarness()

    const { result } = renderHook(
      () => useAccountDevicesQuery({ enabled: false }),
      { wrapper },
    )

    expect(result.current.fetchStatus).toBe('idle')
    expect(mocks.listAccountDevices).not.toHaveBeenCalled()
  })
})
