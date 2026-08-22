import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authCallbacks = vi.hoisted(() => [] as Array<() => void>)
const getAccessToken = vi.hoisted(() => vi.fn())
const registerCurrentElectronDevice = vi.hoisted(() => vi.fn())
const isDaemonControlEnabledForOrganization = vi.hoisted(() => vi.fn())
const gateway = vi.hoisted(() => ({
  status: 'idle',
  close: vi.fn(),
  connect: vi.fn(),
  getStatus: vi.fn(),
  getDeviceId: vi.fn(() => 'electron-installation-1'),
  subscribe: vi.fn(),
  resumeDeviceActionsFromStart: vi.fn(),
  setDaemonControlActive: vi.fn(),
}))

vi.mock('electron', () => ({ app: { getVersion: () => '1.2.3' } }))

vi.mock('../../auth.js', () => ({
  TokenManager: {
    getAccessToken,
    onAuthChanged: (callback: () => void) => {
      authCallbacks.push(callback)
      return () => {
        const index = authCallbacks.indexOf(callback)
        if (index >= 0) authCallbacks.splice(index, 1)
      }
    },
  },
}))
vi.mock('../../ws/ElectronWsGateway.js', () => ({ electronWsGateway: gateway }))
vi.mock('../../cli/cli-server.js', () => ({
  getCLIOrganizationId: () => undefined,
  onCLISpaceContextChanged: () => () => {},
}))
vi.mock('../../config/api.js', () => ({ DAEMON_CONTROL_ENABLED: false }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('../device-registration.js', () => ({
  isDaemonControlEnabledForOrganization,
  registerCurrentElectronDevice,
}))
vi.mock('../device-identity/currentDeviceIdentity.js', () => ({
  currentDeviceIdentity: {
    getSnapshot: () => ({ fingerprint: 'electron-installation-1' }),
  },
}))

import { ElectronAgentService } from '../ElectronAgentService'

describe('ElectronAgentService 账号切换认证生命周期 ', () => {
  let service: ElectronAgentService

  beforeEach(() => {
    authCallbacks.length = 0
    gateway.status = 'idle'
    gateway.getStatus.mockReset().mockImplementation(() => gateway.status)
    gateway.close.mockReset().mockImplementation(() => { gateway.status = 'idle' })
    gateway.connect.mockReset().mockImplementation(async () => {
      gateway.status = 'ready'
      return true
    })
    gateway.subscribe.mockReset().mockResolvedValue({ ok: true })
    gateway.resumeDeviceActionsFromStart.mockReset().mockResolvedValue({ ok: true })
    getAccessToken.mockReset().mockResolvedValue('token-a')
    registerCurrentElectronDevice.mockReset().mockResolvedValue(true)
    isDaemonControlEnabledForOrganization.mockReset().mockResolvedValue(false)
    service = new ElectronAgentService()
  })

  afterEach(async () => {
    await service.stop()
  })

  it('设备控制面关闭时，账号切换仍会替换 ready 网关的认证', async () => {
    await service.start()
    await vi.waitFor(() => expect(gateway.connect).toHaveBeenCalledWith(expect.objectContaining({ token: 'token-a' })))

    getAccessToken.mockResolvedValue('token-b')
    authCallbacks[0]()

    expect(gateway.close).toHaveBeenCalledOnce()
    await vi.waitFor(() => {
      expect(gateway.connect).toHaveBeenLastCalledWith(expect.objectContaining({ token: 'token-b' }))
    })
    expect(gateway.connect).toHaveBeenCalledTimes(2)
    expect(registerCurrentElectronDevice).not.toHaveBeenCalled()
  })

  it('设备控制面关闭时，登出会关闭旧连接且不再使用旧 token', async () => {
    await service.start()
    await vi.waitFor(() => expect(gateway.connect).toHaveBeenCalledOnce())

    getAccessToken.mockResolvedValue(null)
    authCallbacks[0]()

    expect(gateway.close).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(getAccessToken).toHaveBeenCalledTimes(3))
    expect(gateway.connect).toHaveBeenCalledOnce()
    expect(registerCurrentElectronDevice).not.toHaveBeenCalled()
  })
})
