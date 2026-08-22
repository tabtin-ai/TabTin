import { beforeEach, describe, expect, it, vi } from 'vitest'

type CoreOptions = {
  refreshAuth: () => Promise<Record<string, unknown> | null>
}

const core = vi.hoisted(() => ({
  options: [] as CoreOptions[],
  connect: vi.fn(),
  close: vi.fn(),
  suspend: vi.fn(),
  getStatus: vi.fn(),
  request: vi.fn(),
  acknowledgeApplicationEvent: vi.fn(),
}))
const getOrCreateDeviceCredential = vi.hoisted(() => vi.fn())
const getAccessToken = vi.hoisted(() => vi.fn())
const isAccessTokenExpiringSoon = vi.hoisted(() => vi.fn())
const refreshAccessToken = vi.hoisted(() => vi.fn())
const daemonControlEnabled = vi.hoisted(() => ({ value: true }))

vi.mock('@tabtin/ws-gateway-client', () => ({
  WsGatewayClient: class {
    constructor(options: CoreOptions) {
      core.options.push(options)
    }

    connect = core.connect
    close = core.close
    suspend = core.suspend
    getStatus = core.getStatus
    request = core.request
    acknowledgeApplicationEvent = core.acknowledgeApplicationEvent
  },
}))
vi.mock('../../device-credential.js', () => ({ getOrCreateDeviceCredential }))
vi.mock('../../auth.js', () => ({
  TokenManager: { getAccessToken, isAccessTokenExpiringSoon, refreshAccessToken },
}))
vi.mock('../../config/api.js', () => ({
  WS_BASE_URL: 'wss://gateway.example.com',
  get DAEMON_CONTROL_ENABLED() { return daemonControlEnabled.value },
}))
vi.mock('../../services/ConfigService', () => ({
  configService: { get: () => 'installation-a', set: vi.fn() },
}))
vi.mock('../../utils/deviceFingerprint.js', () => ({
  getDeviceFingerprint: () => 'installation-a',
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('../electronWsCapabilities', () => ({
  DEFAULT_ELECTRON_WS_CAPABILITIES: ['agent.action'],
}))

import { ElectronWsGateway } from '../ElectronWsGateway'

describe('Electron Gateway 设备凭据', () => {
  beforeEach(() => {
    daemonControlEnabled.value = true
    core.connect.mockReset().mockResolvedValue(true)
    core.close.mockReset()
    core.suspend.mockReset()
    core.getStatus.mockReset().mockReturnValue('idle')
    core.request.mockReset()
    core.acknowledgeApplicationEvent.mockReset()
    getOrCreateDeviceCredential.mockReset().mockResolvedValue('stable-device-secret')
    getAccessToken.mockReset().mockResolvedValue('fresh-access-token')
    isAccessTokenExpiringSoon.mockReset().mockResolvedValue(false)
    refreshAccessToken.mockReset().mockResolvedValue('refreshed-access-token')
  })

  it('首次连接与 token 刷新复用同一个设备凭据', async () => {
    const gateway = new ElectronWsGateway({ deviceId: 'installation-a' })
    gateway.setDaemonControlActive(true)
    const options = core.options.at(-1)!

    await gateway.connect({ token: 'initial-access-token' })

    expect(core.connect).toHaveBeenCalledWith({
      token: 'initial-access-token',
      deviceCredential: 'stable-device-secret',
    })
    await expect(options.refreshAuth()).resolves.toEqual({
      token: 'fresh-access-token',
      deviceCredential: 'stable-device-secret',
    })
  })

  it('系统暂停只关闭 transport，唤醒时使用新 token 恢复同一认证上下文', async () => {
    const gateway = new ElectronWsGateway({ deviceId: 'installation-a' })
    gateway.setDaemonControlActive(true)
    await gateway.connect({ token: 'old-user-token', organizationId: 'org-a' })
    core.connect.mockClear()

    gateway.suspend()
    const connected = await gateway.reconnectAfterResume()

    expect(core.suspend).toHaveBeenCalledOnce()
    expect(connected).toBe(true)
    expect(core.connect).toHaveBeenCalledWith({
      token: 'fresh-access-token',
      organizationId: 'org-a',
      deviceCredential: 'stable-device-secret',
    })
  })

  it('冷启动恢复精确设备流时显式从 0-0 resume', async () => {
    core.request.mockResolvedValue({ ok: true })
    const gateway = new ElectronWsGateway({ deviceId: 'installation-a' })
    gateway.setDaemonControlActive(true)
    await gateway.connect({ token: 'initial-access-token' })

    await gateway.resumeDeviceActionsFromStart()

    expect(core.request).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'initial-access-token' }),
      'resume',
      { last_event_id: '0-0' },
      undefined,
    )
  })

  it('业务 admission 成功后推进对应设备流游标', () => {
    const gateway = new ElectronWsGateway({ deviceId: 'installation-a' })

    gateway.acknowledgeApplicationEvent(
      '100-0',
      'agent.action.device.installation-a',
    )

    expect(core.acknowledgeApplicationEvent).toHaveBeenCalledWith(
      '100-0',
      'agent.action.device.installation-a',
    )
  })

  it('关闭后不会用旧账号凭据重新发起请求', async () => {
    const gateway = new ElectronWsGateway({ deviceId: 'installation-a' })
    gateway.setDaemonControlActive(true)
    await gateway.connect({ token: 'old-user-token' })

    gateway.close()

    await expect(gateway.requestWithLastAuth('agent.action', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'WS_NOT_AUTHENTICATED' },
    })
    expect(core.close).toHaveBeenCalledOnce()
    expect(core.request).not.toHaveBeenCalled()
  })

  it('仅允许本机 WS 或远端 WSS 承载长期凭据', () => {
    expect(() => new ElectronWsGateway({ wsBaseUrl: 'ws://gateway.example.com' })
      .setDaemonControlActive(true))
      .toThrow('WSS')
    expect(() => new ElectronWsGateway({ wsBaseUrl: 'ws://127.0.0.1:6060' })
      .setDaemonControlActive(true))
      .not.toThrow()
    expect(() => new ElectronWsGateway({ wsBaseUrl: 'wss://gateway.example.com' })
      .setDaemonControlActive(true))
      .not.toThrow()
  })

  it('控制面关闭时保持旧 WS 地址且不读取设备凭据', async () => {
    daemonControlEnabled.value = false
    const gateway = new ElectronWsGateway({
      deviceId: 'installation-a',
      wsBaseUrl: 'ws://192.168.1.20:6060',
    })

    await gateway.connect({ token: 'legacy-access-token' })

    expect(getOrCreateDeviceCredential).not.toHaveBeenCalled()
    expect(core.connect).toHaveBeenCalledWith({ token: 'legacy-access-token' })
  })
})
