import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authCallbacks = vi.hoisted(() => [] as Array<() => void>)
const organizationCallbacks = vi.hoisted(() => [] as Array<(
  payload: { organizationId: string | null }
) => void>)
const currentOrganizationId = vi.hoisted(() => ({ value: 'org-1' as string | null }))
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
  getCLIOrganizationId: () => currentOrganizationId.value,
  onCLISpaceContextChanged: (callback: (payload: { organizationId: string | null }) => void) => {
    organizationCallbacks.push(callback)
    return () => organizationCallbacks.splice(organizationCallbacks.indexOf(callback), 1)
  },
}))
vi.mock('../../config/api.js', () => ({ DAEMON_CONTROL_ENABLED: true }))
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

describe('ElectronAgentService 认证生命周期', () => {
  let service: ElectronAgentService

  beforeEach(() => {
    authCallbacks.length = 0
    organizationCallbacks.length = 0
    currentOrganizationId.value = 'org-1'
    gateway.status = 'idle'
    gateway.getStatus.mockReset().mockImplementation(() => gateway.status)
    gateway.close.mockReset().mockImplementation(() => { gateway.status = 'idle' })
    gateway.connect.mockReset().mockImplementation(async () => {
      gateway.status = 'ready'
      return true
    })
    gateway.subscribe.mockReset().mockResolvedValue({ ok: false })
    gateway.resumeDeviceActionsFromStart.mockReset().mockResolvedValue({ ok: true })
    getAccessToken.mockReset().mockResolvedValue('token-a')
    registerCurrentElectronDevice.mockReset().mockResolvedValue(true)
    isDaemonControlEnabledForOrganization.mockReset().mockResolvedValue(true)
    service = new ElectronAgentService()
  })

  afterEach(async () => {
    await service.stop()
    vi.useRealTimers()
  })

  it('登录用户或 token 变化时先登记，再用对应 token 鉴权', async () => {
    await service.start()
    await vi.waitFor(() => expect(gateway.connect).toHaveBeenCalledWith(expect.objectContaining({ token: 'token-a' })))
    expect(gateway.subscribe).toHaveBeenCalledWith([
      'agent.action.device.electron-installation-1',
    ])
    expect(registerCurrentElectronDevice.mock.invocationCallOrder[0])
      .toBeLessThan(gateway.subscribe.mock.invocationCallOrder[0])
    expect(gateway.subscribe.mock.invocationCallOrder[0])
      .toBeLessThan(gateway.connect.mock.invocationCallOrder[0])

    getAccessToken.mockResolvedValue('token-b')
    authCallbacks[0]()

    expect(gateway.close).toHaveBeenCalledOnce()
    await vi.waitFor(() => {
      expect(registerCurrentElectronDevice).toHaveBeenLastCalledWith(
        'token-b',
        'electron-installation-1',
      )
      expect(gateway.connect).toHaveBeenLastCalledWith(expect.objectContaining({ token: 'token-b' }))
    })
    expect(gateway.close.mock.invocationCallOrder[0])
      .toBeLessThan(registerCurrentElectronDevice.mock.invocationCallOrder.at(-1)!)
    expect(registerCurrentElectronDevice.mock.invocationCallOrder.at(-1)!)
      .toBeLessThan(gateway.connect.mock.invocationCallOrder.at(-1)!)
  })

  it('登记失败不阻断 Gateway 主链就绪', async () => {
    registerCurrentElectronDevice.mockResolvedValue(false)

    await service.start()

    await expect(service.ensureConnected()).resolves.toBe(true)
    expect(gateway.connect).toHaveBeenCalledOnce()
    expect(registerCurrentElectronDevice).toHaveBeenCalledOnce()
  })

  it('并发重连复用同一次设备登记和 Gateway 连接', async () => {
    let resolveFeatureCheck!: (enabled: boolean) => void
    isDaemonControlEnabledForOrganization.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      resolveFeatureCheck = resolve
    }))

    await service.start()
    await vi.waitFor(() => expect(isDaemonControlEnabledForOrganization).toHaveBeenCalledOnce())

    const retries = Array.from({ length: 20 }, () => service.retryConnect())
    resolveFeatureCheck(true)
    await Promise.all(retries)

    expect(registerCurrentElectronDevice).toHaveBeenCalledOnce()
    expect(gateway.connect).toHaveBeenCalledOnce()
  })

  it('连接失败后的手动重连会取消主进程退避并立即连接', async () => {
    vi.useFakeTimers()
    getAccessToken.mockResolvedValueOnce(null).mockResolvedValue('token-a')

    await service.start()
    await expect(service.ensureConnected()).resolves.toBe(false)

    await expect(Promise.all(
      Array.from({ length: 20 }, () => service.retryConnect()),
    )).resolves.toEqual(Array(20).fill(true))
    expect(getAccessToken).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(gateway.connect).toHaveBeenCalledOnce())
    expect(registerCurrentElectronDevice).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(gateway.connect).toHaveBeenCalledOnce()
  })

  it('当前组织未开启时不登记设备，保持原 Gateway 链路', async () => {
    isDaemonControlEnabledForOrganization.mockResolvedValue(false)

    await service.start()
    await expect(service.ensureConnected()).resolves.toBe(true)

    expect(gateway.setDaemonControlActive).toHaveBeenCalledWith(false)
    expect(registerCurrentElectronDevice).not.toHaveBeenCalled()
    expect(gateway.connect).toHaveBeenCalledOnce()
  })

  it('只在用户切换组织时重新判定，不因同组织 Space 切换重连', async () => {
    await service.start()
    await service.ensureConnected()
    gateway.close.mockClear()

    organizationCallbacks[0]({ organizationId: 'org-1' })
    expect(gateway.close).not.toHaveBeenCalled()

    currentOrganizationId.value = 'org-2'
    organizationCallbacks[0]({ organizationId: 'org-2' })
    await vi.waitFor(() => {
      expect(isDaemonControlEnabledForOrganization)
        .toHaveBeenLastCalledWith('token-a', 'org-2')
    })
    expect(gateway.close).toHaveBeenCalledOnce()
  })

  it('冷启动连接并订阅设备 topic 后从 0-0 恢复首条缓冲 prompt', async () => {
    await service.start()
    await service.ensureConnected()

    expect(gateway.resumeDeviceActionsFromStart).toHaveBeenCalledOnce()
    expect(gateway.connect.mock.invocationCallOrder[0])
      .toBeLessThan(gateway.resumeDeviceActionsFromStart.mock.invocationCallOrder[0])
  })

  it('后台登记恢复后重新鉴权并恢复设备 topic', async () => {
    vi.useFakeTimers()
    registerCurrentElectronDevice
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)

    await service.start()
    await service.ensureConnected()
    expect(gateway.connect).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(gateway.connect).toHaveBeenCalledTimes(2))

    expect(gateway.close).toHaveBeenCalledOnce()
    expect(gateway.subscribe).toHaveBeenCalledWith([
      'agent.action.device.electron-installation-1',
    ])
    expect(gateway.subscribe.mock.invocationCallOrder[0])
      .toBeLessThan(gateway.connect.mock.invocationCallOrder[1])
  })

  it('登出时立即关闭旧连接且不再用旧 token 重连', async () => {
    await service.start()
    await vi.waitFor(() => expect(gateway.connect).toHaveBeenCalledOnce())

    getAccessToken.mockResolvedValue(null)
    authCallbacks[0]()

    expect(gateway.close).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(getAccessToken).toHaveBeenCalledTimes(3))
    expect(registerCurrentElectronDevice).toHaveBeenCalledOnce()
    expect(gateway.connect).toHaveBeenCalledOnce()
  })

  it('stop 会关闭 Gateway', async () => {
    await service.start()
    await vi.waitFor(() => expect(gateway.connect).toHaveBeenCalledOnce())
    gateway.close.mockClear()

    await service.stop()

    expect(gateway.close).toHaveBeenCalledOnce()
  })
})
