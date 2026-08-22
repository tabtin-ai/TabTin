import { beforeEach, describe, expect, it, vi } from 'vitest'

const djangoRequest = vi.hoisted(() => vi.fn())

vi.mock('../../cli/routes/shared/error-handler.js', () => ({ djangoRequest }))
vi.mock('electron', () => ({ app: { getVersion: () => '1.2.3' } }))
vi.mock('node:os', () => ({ default: { hostname: () => 'test-host' } }))

import { electronDeviceRegistrationAdapter } from './electronDeviceRegistrationAdapter.js'

describe('electronDeviceRegistrationAdapter', () => {
  beforeEach(() => djangoRequest.mockReset())

  it('由 Main 进程组装稳定身份并注册设备', async () => {
    djangoRequest.mockResolvedValue({
      status: 200,
      data: { data: { id: 'device-1', fingerprint: 'electron-test' } },
    })

    await expect(electronDeviceRegistrationAdapter.register({
      organizationId: 'org-1',
      identity: {
        fingerprint: 'electron-test',
        machineKey: 'machine-test',
        previousFingerprint: 'electron-old',
        recoveryFingerprints: [],
      },
    })).resolves.toMatchObject({ id: 'device-1' })

    expect(djangoRequest).toHaveBeenCalledWith(
      'POST',
      '/context/devices/register',
      expect.objectContaining({
        organization_id: 'org-1',
        fingerprint: 'electron-test',
        machine_key: 'machine-test',
        previous_fingerprint: 'electron-old',
        device_type: 'electron',
      }),
      { logTag: '[DeviceIdentity]' },
    )
  })

  it('保留后端可诊断的业务错误', async () => {
    djangoRequest.mockResolvedValue({
      status: 403,
      data: { message: 'organization access denied' },
    })

    await expect(electronDeviceRegistrationAdapter.register({
      organizationId: 'org-1',
      identity: {
        fingerprint: 'electron-test',
        machineKey: null,
        previousFingerprint: null,
        recoveryFingerprints: [],
      },
    })).rejects.toThrow('organization access denied')
  })
})
