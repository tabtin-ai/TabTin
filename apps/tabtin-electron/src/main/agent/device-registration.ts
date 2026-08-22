import { joinApiPath, requireSecureCredentialApiBaseUrl } from '@tabtin/config'
import { app } from 'electron'
import { hostname } from 'node:os'
import { API_BASE_URL, DAEMON_CONTROL_API_BASE_URL, DAEMON_CONTROL_ENABLED } from '../config/api.js'
import { getOrCreateDeviceCredential } from '../device-credential.js'
import { createLogger } from '../logger'
import { ELECTRON_DEVICE_CAPABILITIES } from '../services/CapabilityDiscoveryService'
import {
  nextDeviceRuntimeProfileRevision,
  persistDeviceRuntimeProfileRevision,
} from '../utils/deviceFingerprint.js'

const log = createLogger('DeviceRegistration')

interface DeviceResponse {
  success?: boolean
  data?: {
    device?: {
      device_id?: string
      capabilities?: { revision?: number }
    }
  }
}

interface EffectiveFeaturesResponse {
  success?: boolean
  data?: { daemon_control?: { enabled?: boolean } }
}

function responseRevision(response: DeviceResponse): number {
  const value = response.data?.device?.capabilities?.revision
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

/** Django 是组织灰度的唯一真相；失败时保持旧链路，不触碰设备控制面。 */
export async function isDaemonControlEnabledForOrganization(
  accessToken: string,
  organizationId: string,
): Promise<boolean> {
  if (!DAEMON_CONTROL_ENABLED || !organizationId.trim()) return false
  try {
    const response = await fetch(joinApiPath(
      API_BASE_URL,
      `/platform-config/features/effective?organization_id=${encodeURIComponent(organizationId)}`,
    ), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Client-Type': 'electron',
        'X-Client-Version': app.getVersion(),
      },
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    })
    if (!response.ok) return false
    const result = await response.json() as EffectiveFeaturesResponse
    return result.success === true && result.data?.daemon_control?.enabled === true
  } catch (error) {
    log.warn(`组织设备控制开关查询失败，保持关闭: ${error}`)
    return false
  }
}

/** 登录后幂等登记当前安装实例；控制面不可用时保留原有 Gateway 能力。 */
export async function registerCurrentElectronDevice(
  accessToken: string,
  installationId: string,
): Promise<boolean> {
  if (!DAEMON_CONTROL_ENABLED) return false
  const startedAt = performance.now()
  try {
    const deviceCredential = await getOrCreateDeviceCredential(installationId)
    const baseUrl = requireSecureCredentialApiBaseUrl(DAEMON_CONTROL_API_BASE_URL)
    const runtimeProfile = {
      os: process.platform,
      arch: process.arch,
      app_version: app.getVersion(),
      capabilities: ELECTRON_DEVICE_CAPABILITIES,
    }
    log.info(`设备登记开始 installationId=${installationId}`)
    const response = await fetch(
      joinApiPath(baseUrl, '/daemon-control/v1/devices/register'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...(deviceCredential
            ? { 'X-TabTin-Device-Credential': deviceCredential }
            : {}),
        },
        body: JSON.stringify({
          installation_id: installationId,
          name: hostname().trim().slice(0, 120) || 'TabTin Device',
          kind: 1, // DEVICE_KIND_ELECTRON
          ...runtimeProfile,
        }),
        signal: AbortSignal.timeout(5_000),
        redirect: 'error',
      },
    )
    const elapsedMs = (performance.now() - startedAt).toFixed(0)
    if (!response.ok) {
      log.warn(`设备登记降级 status=${response.status} elapsedMs=${elapsedMs}`)
      return false
    }
    const registration = await response.json() as DeviceResponse
    const deviceId = registration.data?.device?.device_id?.trim()
    if (registration.success !== true || !deviceId) {
      log.warn(`设备登记降级 invalid_response elapsedMs=${elapsedMs}`)
      return false
    }

    const capabilitiesRevision = nextDeviceRuntimeProfileRevision(responseRevision(registration))
    const syncResponse = await fetch(joinApiPath(
      baseUrl,
      `/daemon-control/v1/devices/${encodeURIComponent(deviceId)}/runtime-profile`,
    ), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        ...runtimeProfile,
        capabilities_revision: capabilitiesRevision,
      }),
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    })
    if (!syncResponse.ok) {
      log.warn(`设备运行资料同步降级 status=${syncResponse.status}`)
      return false
    }
    const synced = await syncResponse.json() as DeviceResponse
    if (synced.success !== true) {
      log.warn('设备运行资料同步降级 invalid_response')
      return false
    }
    persistDeviceRuntimeProfileRevision(Math.max(
      capabilitiesRevision,
      responseRevision(synced),
    ))
    log.info(`设备登记成功 installationId=${installationId} elapsedMs=${elapsedMs}`)
    return true
  } catch (error) {
    log.warn(`设备登记降级 elapsedMs=${(performance.now() - startedAt).toFixed(0)}`, error)
    return false
  }
}
