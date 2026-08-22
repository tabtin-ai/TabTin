import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockHealthCheck = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useAppVersion', () => ({
  useAppVersion: () => ({ version: '0.2.1', loading: false }),
}))

vi.mock('@/services/api', () => ({
  apiService: { healthCheck: mockHealthCheck },
}))

vi.mock('@/config/api', () => ({
  API_BASE_URL: 'https://api-test.example.com/api',
}))

import { useRuntimeVersionInfo } from '../useRuntimeVersionInfo'

describe('useRuntimeVersionInfo', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_GIT_COMMIT', 'client1234567890')
    mockHealthCheck.mockResolvedValue({
      release_version: '260812',
      source_sha: 'server1234567890',
    })
  })

  it('组合客户端构建信息和服务端部署信息', async () => {
    const { result } = renderHook(() => useRuntimeVersionInfo(true))

    await waitFor(() => expect(result.current.serverVersion).toBe('260812'))
    expect(result.current).toMatchObject({
      clientVersion: '0.2.1',
      clientSourceSha: 'client1234567890',
      serverVersion: '260812',
      serverSourceSha: 'server1234567890',
      serverAddress: 'https://api-test.example.com/api',
    })
  })
})
