import { DeviceIdentityStore } from '@tabtin/agent-host/state'
import { getDeviceIdentity, type DeviceIdentity } from '../../utils/deviceFingerprint.js'

export type DeviceIdentitySnapshot = DeviceIdentity

export interface DeviceRegistrationAdapter<TDevice> {
  register(input: {
    organizationId: string
    identity: DeviceIdentitySnapshot
  }): Promise<TDevice>
}

/**
 * AgentHost 内部的设备身份单一所有者。
 *
 * 设备身份只在 Main/AgentHost 读取一次，并通过快照与订阅向其他模块投影。
 * 后端 Device.id 由 machineKey reclaim 保持稳定，并作为 Workspace 绑定身份。
 */
export class DeviceIdentityCoordinator<TDevice = unknown> {
  private snapshot: DeviceIdentitySnapshot | null = null
  private registration: { organizationId: string; promise: Promise<TDevice> } | null = null
  private registered: { organizationId: string; device: TDevice } | null = null
  private registrationGeneration = 0
  private readonly listeners = new Set<(device: TDevice) => void | Promise<void>>()

  readonly state: DeviceIdentityStore

  constructor(
    private readonly registrationAdapter: DeviceRegistrationAdapter<TDevice>,
    state = new DeviceIdentityStore(),
  ) {
    this.state = state
  }

  getSnapshot(): DeviceIdentitySnapshot {
    if (!this.snapshot) {
      this.snapshot = getDeviceIdentity()
      this.state.setIdentity(this.snapshot)
    }
    return this.snapshot
  }

  resetRegistration(): void {
    this.registrationGeneration += 1
    this.registration = null
    this.registered = null
    this.state.clearRegistration()
  }

  subscribe(listener: (device: TDevice) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  ensureRegistered(organizationId: string): Promise<TDevice> {
    const normalizedOrganizationId = organizationId.trim()
    if (!normalizedOrganizationId) {
      return Promise.reject(new Error('organizationId is required'))
    }
    if (this.registration?.organizationId === normalizedOrganizationId) {
      return this.registration.promise
    }
    if (this.registered?.organizationId === normalizedOrganizationId) {
      return Promise.resolve(this.registered.device)
    }

    const organizationChanged =
      (this.registration != null
        && this.registration.organizationId !== normalizedOrganizationId)
      || (this.registered != null
        && this.registered.organizationId !== normalizedOrganizationId)
    if (organizationChanged) {
      this.registration = null
      this.registered = null
      this.state.clearRegistration()
    }

    const generation = ++this.registrationGeneration
    const promise = this.registrationAdapter.register({
      organizationId: normalizedOrganizationId,
      identity: this.getSnapshot(),
    }).then(async (device) => {
      if (generation !== this.registrationGeneration) {
        throw new Error('device registration superseded by a newer registration context')
      }
      const record = device as unknown as Record<string, unknown>
      const deviceId = String(record.id ?? '')
      if (!deviceId) {
        throw new Error('device registration is missing device id')
      }
      await Promise.all([...this.listeners].map(listener => listener(device)))
      this.registered = { organizationId: normalizedOrganizationId, device }
      this.state.setRegistration({
        organizationId: normalizedOrganizationId,
        deviceId,
      })
      return device
    }).finally(() => {
      if (this.registration?.promise === promise) this.registration = null
    })

    this.registration = { organizationId: normalizedOrganizationId, promise }
    return promise
  }
}
