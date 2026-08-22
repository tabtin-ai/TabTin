import os from 'node:os'
import { app } from 'electron'
import type { Device, DeviceRegisterRequest } from '@tabtin/app-shell'
import { API_ENDPOINTS } from '@tabtin/config'

import { djangoRequest } from '../../cli/routes/shared/error-handler.js'
import type {
  DeviceIdentitySnapshot,
  DeviceRegistrationAdapter,
} from './DeviceIdentityCoordinator.js'

const ELECTRON_CAPABILITIES = [
  'terminal_execute',
  'terminal_read',
  'terminal_write',
  'browser',
  'file',
  'gui',
  'mcp',
  'git',
  'code_search',
] as const

type ResponseEnvelope<T> = { data?: T } | T

function unwrapDevice(value: unknown): Device | null {
  if (!value || typeof value !== 'object') return null
  const outer = value as ResponseEnvelope<Device>
  const candidate = 'data' in outer ? outer.data : outer
  if (!candidate || typeof candidate !== 'object' || !('id' in candidate)) return null
  return candidate as Device
}

function readErrorMessage(value: unknown, status: number): string {
  if (value && typeof value === 'object') {
    const body = value as Record<string, unknown>
    const nested = body.data && typeof body.data === 'object'
      ? body.data as Record<string, unknown>
      : null
    const message = body.message ?? body.error ?? nested?.message ?? nested?.error
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  return `device registration failed with HTTP ${status}`
}

function buildRegistrationRequest(
  organizationId: string,
  identity: DeviceIdentitySnapshot,
): DeviceRegisterRequest {
  const platform = process.platform
  return {
    organization_id: organizationId,
    fingerprint: identity.fingerprint,
    device_type: 'electron',
    name: `${os.hostname()} (${platform})`,
    os_info: {
      os: platform,
      platform,
      arch: process.arch,
      app_version: app.getVersion(),
    },
    capabilities: [...ELECTRON_CAPABILITIES],
    machine_key: identity.machineKey ?? undefined,
    previous_fingerprint: identity.previousFingerprint ?? undefined,
    recovery_fingerprints: identity.recoveryFingerprints.length
      ? identity.recoveryFingerprints
      : undefined,
  }
}

export const electronDeviceRegistrationAdapter: DeviceRegistrationAdapter<Device> = {
  async register({ organizationId, identity }) {
    const response = await djangoRequest(
      'POST',
      API_ENDPOINTS.DEVICE.REGISTER,
      buildRegistrationRequest(organizationId, identity),
      { logTag: '[DeviceIdentity]' },
    )
    if (response.status < 200 || response.status >= 300) {
      throw new Error(readErrorMessage(response.data, response.status))
    }
    const device = unwrapDevice(response.data)
    if (!device) throw new Error('device registration returned an invalid response')
    return device
  },
}
