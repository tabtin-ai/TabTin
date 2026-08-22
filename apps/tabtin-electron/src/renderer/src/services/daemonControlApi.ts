import { joinApiPath } from '@tabtin/config'
import { DAEMON_CONTROL_API_BASE_URL } from '@/config/api'
import { apiRequest, unwrapData } from '@/services/apiBase'
import { createLogger } from '@/utils/logger'

const log = createLogger('DaemonControlApi')

export const DAEMON_CONTROL_DEVICE_KIND = {
  electron: 1,
  daemon: 2,
  mobile: 3,
  sandbox: 4,
} as const

export const DAEMON_CONTROL_PRESENCE = {
  online: 1,
  offline: 2,
  unknown: 3,
} as const

export const DAEMON_CONTROL_DEVICE_ROLE = {
  controller: 1,
  executor: 2,
} as const

export const DAEMON_CONTROL_CONTROL_STATE = {
  active: 1,
} as const

export interface AccountDevicePresence {
  state: number
  connected_at?: string
  last_seen_at?: string
}

export interface AccountDevice {
  device_id: string
  owner_user_id: string
  installation_id: string
  name: string
  kind: number
  roles: number[]
  control_state: number
  os: string
  arch: string
  app_version: string
  capabilities?: {
    names: string[]
    revision: number
    observed_at: string
  } | null
  presence?: AccountDevicePresence | null
  created_at: string
}

interface AccountDeviceListData {
  items: AccountDevice[]
}

/** 查询当前登录账号的设备及 Daemon Control 实时拉取的在线快照。 */
export async function listAccountDevices(): Promise<AccountDevice[]> {
  const startedAt = performance.now()
  const url = joinApiPath(
    DAEMON_CONTROL_API_BASE_URL,
    '/daemon-control/v1/devices',
  )
  log.debug('账号设备列表请求开始')
  try {
    const response = await apiRequest({ url, method: 'GET' })
    const data = unwrapData<AccountDeviceListData>(response, 'Failed to load account devices')
    if (!Array.isArray(data.items)) {
      throw new Error('Daemon Control returned an invalid device list')
    }
    log.debug('账号设备列表请求成功', {
      count: data.items.length,
      elapsedMs: Math.round(performance.now() - startedAt),
    })
    return data.items
  } catch (error) {
    log.warn('账号设备列表请求失败', {
      elapsedMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
