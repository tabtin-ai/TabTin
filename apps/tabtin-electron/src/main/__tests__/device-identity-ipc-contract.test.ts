import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  guardedHandle: vi.fn(),
  identity: {
    fingerprint: 'electron-machine-profile',
    machineKey: 'machine-profile',
    previousFingerprint: 'electron-legacy',
  },
}))

vi.mock('../utils/guarded-handle', () => ({
  guardedHandle: mocks.guardedHandle,
}))

vi.mock('../utils/deviceFingerprint', () => ({
  getDeviceIdentity: () => mocks.identity,
}))

vi.mock('../agent/device-identity/electronDeviceRegistrationAdapter.js', () => ({
  electronDeviceRegistrationAdapter: { register: vi.fn() },
}))

vi.mock('../auth.js', () => ({
  TokenManager: { onAuthChanged: vi.fn() },
}))

import {
  DEVICE_IDENTITY_IPC_CHANNEL,
  registerDeviceIdentityIpcHandler,
} from '../device-identity-ipc'

describe('device:getIdentity IPC contract', () => {
  beforeEach(() => {
    mocks.guardedHandle.mockClear()
  })

  it('registers the canonical channel and returns an okResponse envelope', async () => {
    registerDeviceIdentityIpcHandler()

    expect(mocks.guardedHandle).toHaveBeenCalledTimes(2)
    expect(mocks.guardedHandle).toHaveBeenCalledWith(
      DEVICE_IDENTITY_IPC_CHANNEL,
      expect.any(Function),
    )

    const registration = mocks.guardedHandle.mock.calls.find(
      ([channel]) => channel === DEVICE_IDENTITY_IPC_CHANNEL,
    ) as unknown as [string, () => unknown]
    expect(registration[1]()).toEqual({
      ok: true,
      data: mocks.identity,
    })
  })
})
