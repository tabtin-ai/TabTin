export type HostDeviceIdentitySnapshot = {
  fingerprint: string
  machineKey: string | null
  previousFingerprint: string | null
  recoveryFingerprints: string[]
}

export type HostDeviceRegistration = {
  organizationId: string
  deviceId: string
}

/** AgentHost 对本机身份与当前注册实例的权威状态。 */
export class DeviceIdentityStore {
  private identity: HostDeviceIdentitySnapshot | null = null
  private registration: HostDeviceRegistration | null = null

  setIdentity(identity: HostDeviceIdentitySnapshot): void {
    this.identity = identity
  }

  getIdentity(): HostDeviceIdentitySnapshot | null {
    return this.identity
  }

  setRegistration(registration: HostDeviceRegistration): void {
    this.registration = registration
  }

  getRegistration(): HostDeviceRegistration | null {
    return this.registration
  }

  clearRegistration(): void {
    this.registration = null
  }
}
