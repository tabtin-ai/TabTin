import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const warn = vi.hoisted(() => vi.fn())
const getOrCreateDeviceCredential = vi.hoisted(() => vi.fn())
const nextDeviceRuntimeProfileRevision = vi.hoisted(() => vi.fn(() => 8))
const persistDeviceRuntimeProfileRevision = vi.hoisted(() => vi.fn())
const daemonControlEnabled = vi.hoisted(() => ({ value: true }))

vi.mock('electron', () => ({ app: { getVersion: () => '1.2.3' } }))
vi.mock('node:os', () => ({
  default: { hostname: () => 'Home Mac' },
  hostname: () => 'Home Mac',
}))
vi.mock('../../config/api.js', () => ({
  API_BASE_URL: 'https://api.example.com/api',
  DAEMON_CONTROL_API_BASE_URL: 'http://127.0.0.1:6080/api',
  get DAEMON_CONTROL_ENABLED() { return daemonControlEnabled.value },
}))
vi.mock('../../utils/deviceFingerprint.js', () => ({
  getDeviceFingerprint: () => 'electron-installation-1',
  nextDeviceRuntimeProfileRevision,
  persistDeviceRuntimeProfileRevision,
}))
vi.mock('../../device-credential.js', () => ({ getOrCreateDeviceCredential }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }),
}))
vi.mock('../../services/CapabilityDiscoveryService', () => ({
  ELECTRON_DEVICE_CAPABILITIES: ['terminal_execute', 'file'],
}))

import {
  isDaemonControlEnabledForOrganization,
  registerCurrentElectronDevice,
} from '../device-registration'

describe('Electron 设备自动登记', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  beforeEach(() => {
    daemonControlEnabled.value = true
    getOrCreateDeviceCredential.mockResolvedValue('device-secret')
  })

  it('开关默认关闭时不读凭据、不发起登记请求', async () => {
    daemonControlEnabled.value = false
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(registerCurrentElectronDevice('access-token', 'installation-1')).resolves.toBe(false)

    expect(getOrCreateDeviceCredential).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('只按 Django 下发的当前组织开关激活设备控制', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { daemon_control: { enabled: true } },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(isDaemonControlEnabledForOrganization('access-token', 'org-1'))
      .resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/platform-config/features/effective?organization_id=org-1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer access-token',
          'X-Client-Type': 'electron',
          'X-Client-Version': '1.2.3',
        }),
      }),
    )
  })

  it('使用当前登录态和 Gateway 同一 installation_id 登记 Electron', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { device: { device_id: 'device-1', capabilities: { revision: 7 } } },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { device: { device_id: 'device-1', capabilities: { revision: 8 } } },
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      registerCurrentElectronDevice('access-token', 'electron-installation-1')
    ).resolves.toBe(true)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, request] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:6080/api/daemon-control/v1/devices/register')
    expect(request.headers.Authorization).toBe('Bearer access-token')
    expect(request.headers['X-TabTin-Device-Credential']).toBe('device-secret')
    expect(request.redirect).toBe('error')
    expect(JSON.parse(request.body)).toMatchObject({
      installation_id: 'electron-installation-1',
      name: 'Home Mac',
      kind: 1,
      os: process.platform,
      arch: process.arch,
      app_version: '1.2.3',
      capabilities: ['terminal_execute', 'file'],
    })
    expect(nextDeviceRuntimeProfileRevision).toHaveBeenCalledWith(7)
    const [syncUrl, syncRequest] = fetchMock.mock.calls[1]
    expect(syncUrl).toBe(
      'http://127.0.0.1:6080/api/daemon-control/v1/devices/device-1/runtime-profile',
    )
    expect(syncRequest.method).toBe('PUT')
    expect(JSON.parse(syncRequest.body)).toMatchObject({
      os: process.platform,
      arch: process.arch,
      app_version: '1.2.3',
      capabilities: ['terminal_execute', 'file'],
      capabilities_revision: 8,
    })
    expect(persistDeviceRuntimeProfileRevision).toHaveBeenCalledWith(8)
  })

  it('控制面不可用时降级，不阻断后续 Gateway', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unavailable')))

    await expect(registerCurrentElectronDevice('access-token', 'installation-1')).resolves.toBe(false)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('拒绝把登录凭据发送到非本机 HTTP 地址', async () => {
    vi.doUnmock('../../config/api.js')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { requireSecureCredentialApiBaseUrl } = await import('@tabtin/config')
    expect(() => requireSecureCredentialApiBaseUrl('http://control.example.com/api'))
      .toThrow('HTTPS')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
