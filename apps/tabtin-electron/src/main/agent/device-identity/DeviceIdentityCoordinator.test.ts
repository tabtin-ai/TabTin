import { beforeEach, describe, expect, it, vi } from 'vitest'

const getDeviceIdentity = vi.hoisted(() => vi.fn())

vi.mock('../../utils/deviceFingerprint.js', () => ({ getDeviceIdentity }))

import { DeviceIdentityCoordinator } from './DeviceIdentityCoordinator.js'

const identity = {
  fingerprint: 'electron-test',
  machineKey: 'machine-test',
  previousFingerprint: null,
  recoveryFingerprints: [],
}

describe('DeviceIdentityCoordinator', () => {
  beforeEach(() => {
    getDeviceIdentity.mockReset()
    getDeviceIdentity.mockReturnValue(identity)
  })

  it('只读取一次身份快照', () => {
    const coordinator = new DeviceIdentityCoordinator({ register: vi.fn() })

    expect(coordinator.getSnapshot()).toBe(identity)
    expect(coordinator.getSnapshot()).toBe(identity)

    expect(getDeviceIdentity).toHaveBeenCalledTimes(1)
  })

  it('同一组织的并发注册合并为一个事务', async () => {
    let resolveRegistration!: (device: { id: string }) => void
    const register = vi.fn(() => new Promise<{ id: string }>((resolve) => {
      resolveRegistration = resolve
    }))
    const coordinator = new DeviceIdentityCoordinator({ register })

    const first = coordinator.ensureRegistered('org-1')
    const second = coordinator.ensureRegistered('org-1')

    expect(first).toBe(second)
    expect(register).toHaveBeenCalledTimes(1)
    resolveRegistration({ id: 'device-1' })
    await expect(first).resolves.toEqual({ id: 'device-1' })
  })

  it('注册成功发布一次身份就绪事件', async () => {
    const coordinator = new DeviceIdentityCoordinator({
      register: vi.fn().mockResolvedValue({ id: 'device-1' }),
    })
    const listener = vi.fn()
    const unsubscribe = coordinator.subscribe(listener)

    await coordinator.ensureRegistered('org-1')
    expect(listener).toHaveBeenCalledWith({ id: 'device-1' })
    unsubscribe()
    coordinator.resetRegistration()
    await coordinator.ensureRegistered('org-1')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('Host State 对账失败时不发布已就绪注册状态', async () => {
    const register = vi.fn().mockResolvedValue({
      id: 'registration-1',
    })
    const coordinator = new DeviceIdentityCoordinator({ register })
    coordinator.subscribe(() => Promise.reject(new Error('host state unavailable')))

    await expect(coordinator.ensureRegistered('org-1')).rejects.toThrow('host state unavailable')
    expect(coordinator.state.getRegistration()).toBeNull()

    await expect(coordinator.ensureRegistered('org-1')).rejects.toThrow('host state unavailable')
    expect(register).toHaveBeenCalledTimes(2)
  })

  it('认证变化会废弃仍在途的旧账号注册结果', async () => {
    let resolveRegistration!: (device: { id: string }) => void
    const coordinator = new DeviceIdentityCoordinator({
      register: () => new Promise<{ id: string }>((resolve) => {
        resolveRegistration = resolve
      }),
    })

    const registration = coordinator.ensureRegistered('org-1')
    coordinator.resetRegistration()
    resolveRegistration({ id: 'stale-device' })

    await expect(registration).rejects.toThrow('newer registration context')
  })

  it('不同组织反序返回时拒绝旧组织结果', async () => {
    const resolvers = new Map<string, (device: { id: string }) => void>()
    const coordinator = new DeviceIdentityCoordinator({
      register: ({ organizationId }) => new Promise<{ id: string }>((resolve) => {
        resolvers.set(organizationId, resolve)
      }),
    })

    const oldOrganization = coordinator.ensureRegistered('org-old')
    const currentOrganization = coordinator.ensureRegistered('org-current')
    resolvers.get('org-current')?.({ id: 'device-current' })
    await expect(currentOrganization).resolves.toEqual({ id: 'device-current' })
    resolvers.get('org-old')?.({ id: 'device-old' })
    await expect(oldOrganization).rejects.toThrow('newer registration context')

    await expect(coordinator.ensureRegistered('org-current')).resolves.toEqual({
      id: 'device-current',
    })
  })

  it('切换组织开始注册时立即清除旧组织注册投影', async () => {
    let resolveCurrent!: (device: { id: string }) => void
    const coordinator = new DeviceIdentityCoordinator({
      register: vi.fn(({ organizationId }) => {
        if (organizationId === 'org-old') return Promise.resolve({ id: 'device-old' })
        return new Promise<{ id: string }>((resolve) => {
          resolveCurrent = resolve
        })
      }),
    })

    await coordinator.ensureRegistered('org-old')
    expect(coordinator.state.getRegistration()).toEqual({
      organizationId: 'org-old',
      deviceId: 'device-old',
    })

    const currentRegistration = coordinator.ensureRegistered('org-current')
    expect(coordinator.state.getRegistration()).toBeNull()

    resolveCurrent({ id: 'device-current' })
    await expect(currentRegistration).resolves.toEqual({ id: 'device-current' })
  })
})
