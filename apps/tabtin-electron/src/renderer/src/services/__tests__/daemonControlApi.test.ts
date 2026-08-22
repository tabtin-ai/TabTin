import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiRequestMock, loggerWarnMock } = vi.hoisted(() => ({
  apiRequestMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}))

vi.mock('@/adapters/api-adapter-instance', () => ({
  apiRequest: apiRequestMock,
  getAuthToken: vi.fn().mockResolvedValue('account-token'),
}))

vi.mock('@/config/api', () => ({
  DAEMON_CONTROL_API_BASE_URL: 'http://127.0.0.1:6080/api',
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: loggerWarnMock,
    error: vi.fn(),
  }),
}))

import { listAccountDevices } from '../daemonControlApi'

describe('listAccountDevices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('使用当前账号凭据从 Daemon Control 查询设备', async () => {
    const devices = [{
      device_id: 'device-1',
      owner_user_id: 'user-1',
      installation_id: 'installation-1',
      name: 'Office Mac',
      kind: 1,
      roles: [1, 2],
      control_state: 1,
      os: 'darwin',
      arch: 'arm64',
      app_version: '0.1.0',
      presence: { state: 1, last_seen_at: '2026-08-13T02:00:00Z' },
      created_at: '2026-08-12T02:00:00Z',
    }]
    apiRequestMock.mockResolvedValue({
      status: 200,
      data: { success: true, data: { items: devices } },
    })

    await expect(listAccountDevices()).resolves.toEqual(devices)
    expect(apiRequestMock).toHaveBeenCalledWith({
      url: 'http://127.0.0.1:6080/api/daemon-control/v1/devices',
      method: 'GET',
      headers: { Authorization: 'Bearer account-token' },
    })
  })

  it('拒绝非列表响应，避免设置页误判为空设备', async () => {
    apiRequestMock.mockResolvedValue({
      status: 200,
      data: { success: true, data: { items: null } },
    })

    await expect(listAccountDevices()).rejects.toThrow('invalid device list')
    expect(loggerWarnMock).toHaveBeenCalledOnce()
  })
})
