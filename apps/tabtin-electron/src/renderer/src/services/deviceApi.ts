/**
 * Device API 服务
 *
 * 负责 Renderer 端的设备列表、心跳、更新与删除。
 * 本机注册由 AgentHost DeviceIdentityCoordinator 统一管理。
 */

import { joinApiPath } from '@tabtin/config'
import type { Device, DeviceUpdateRequest, DeviceListResponse } from '@tabtin/app-shell'
import { API_CONFIG, API_ENDPOINTS } from '@/config/api'
import { apiRequest as adapterApiRequest, getAuthToken } from '@/adapters/api-adapter-instance'
import i18n from '@/i18n'

async function getAuthHeaders(): Promise<Record<string, string>> {
  try {
    const token = await getAuthToken()
    if (token) {
      return { Authorization: `Bearer ${token}` }
    }
    return {}
  } catch {
    return {}
  }
}

async function apiRequest(options: {
  url: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  body?: string
}): Promise<any> {
  const authHeaders = await getAuthHeaders()
  let response: any
  try {
    response = await adapterApiRequest({
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
    })
  } catch (error) {
    // 网络层失败（如 ECONNREFUSED）：附带 endpoint，便于上层日志定位打到了哪个地址
    if (error instanceof Error) {
      (error as Error & { endpoint?: string }).endpoint = options.url
    }
    throw error
  }
  if (response && response.status >= 400) {
    const msg = response.data?.message ?? response.data?.error ?? `HTTP ${response.status}`
    const err = new Error(msg) as Error & { status?: number; endpoint?: string }
    err.status = response.status
    err.endpoint = options.url
    throw err
  }
  return response
}

function unwrapResponseData(response: any): any {
  const body = response?.data
  if (body && typeof body === 'object' && 'data' in body) {
    return body.data
  }
  return body
}

export class DeviceApiService {
  /**
   * 设备心跳。定时调用以保持 last_heartbeat_at 新鲜。
   * WS 重连期间设备不会被 Celery 清理任务标记 offline。
   */
  static async heartbeat(
    fingerprint: string,
    payload?: {
      capabilities?: string[]
      system_info?: Record<string, unknown>
    }
  ): Promise<void> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.DEVICE.HEARTBEAT}`)
    await apiRequest({
      url,
      method: 'POST',
      body: JSON.stringify({
        fingerprint,
        ...(payload?.capabilities ? { capabilities: payload.capabilities } : {}),
        ...(payload?.system_info ? { system_info: payload.system_info } : {}),
      }),
    })
  }

  /**
   * 主动上报离线（异步版）。
   * Best-effort：绕过 401 拦截器，避免触发 token 刷新 → auth:logout 死循环。
   */
  static async reportOffline(fingerprint: string): Promise<void> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.DEVICE.OFFLINE}`)
    const authHeaders = await getAuthHeaders()
    const body = JSON.stringify({ fingerprint })

    if (typeof window !== 'undefined' && window.tabtin?.apiRequest) {
      await window.tabtin.apiRequest({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body,
      })
    } else {
      await adapterApiRequest({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body,
      })
    }
  }

  /**
   * 主动上报离线 — beforeunload / before-quit 期间调用。
   * 使用 sendBeacon (非阻塞) + 同步 XHR (fallback)。
   * sendBeacon 不支持自定义 header，所以把 token 放 body 里。
   */
  static reportOfflineSync(fingerprint: string, cachedToken: string): void {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.DEVICE.OFFLINE}`)
    const payload = JSON.stringify({ fingerprint, _token: cachedToken })

    // 优先 sendBeacon：浏览器保证在页面卸载后仍会发送
    try {
      const blob = new Blob([payload], { type: 'application/json' })
      if (navigator.sendBeacon?.(url, blob)) return
    } catch { /* sendBeacon not available or failed */ }

    // Fallback: 同步 XHR（sync mode 下 timeout 不生效但 Electron 关闭流程有限时保护）
    try {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', url, false)
      xhr.setRequestHeader('Content-Type', 'application/json')
      xhr.send(payload)
    } catch {
      // best-effort during shutdown
    }
  }

  /**
   * 获取当前用户在指定组织内的设备列表。
   */
  static async listDevices(organizationId?: string): Promise<DeviceListResponse> {
    const qs = organizationId ? `?organization_id=${organizationId}` : ''
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.DEVICE.LIST}${qs}`)
    const response = await apiRequest({ url, method: 'GET' })
    const data = unwrapResponseData(response)
    if (!data) {
      return { devices: [], total: 0 }
    }
    return data as DeviceListResponse
  }

  /**
   * 更新设备名称或能力列表。
   */
  static async updateDevice(deviceId: string, payload: DeviceUpdateRequest): Promise<Device> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.DEVICE.UPDATE(deviceId)}`)
    const response = await apiRequest({
      url,
      method: 'PATCH',
      body: JSON.stringify(payload),
    })
    const data = unwrapResponseData(response)
    if (!data) {
      throw new Error(`[Device] ${i18n.t('common:errors.deviceUpdateInvalidResponse')}`)
    }
    return data as Device
  }

  /**
   * 删除设备。
   */
  static async deleteDevice(deviceId: string): Promise<void> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.DEVICE.DELETE(deviceId)}`)
    await apiRequest({ url, method: 'DELETE' })
  }

  /**
   * 生成 Daemon 安装 Token。
   * 用户在 DevicePanel 中点击"添加远程设备"时调用。
   */
  static async createInstallToken(
    organizationId: string,
    deviceName: string,
    expiresMinutes = 60,
  ): Promise<{ token: string; expires_at: string }> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.DEVICE.INSTALL_TOKEN}`)
    const response = await apiRequest({
      url,
      method: 'POST',
      body: JSON.stringify({
        organization_id: organizationId,
        device_name: deviceName,
        expires_minutes: expiresMinutes,
      }),
    })
    const data = unwrapResponseData(response)
    if (!data) {
      throw new Error(`[Device] ${i18n.t('common:errors.deviceInstallTokenFailed')}`)
    }
    return data as { token: string; expires_at: string }
  }

  /**
   * 通过工作空间入口校验部署设备绑定（：不再经 Agent 身份路径）。
   * 可由 owner 显式恢复离线历史绑定（：recover_offline_binding）。
   * expectedVersion 传入当前 config_version 启用 CAS 并发控制。
   * 返回工作空间摘要；兼容 Space 壳由后端同步。
   * 版本冲突时抛出带 status=409 的错误。
   */
  static async bindSpaceDevice(
    spaceId: string,
    deviceId: string | null,
    expectedVersion?: number,
    recoverOfflineBinding = false,
  ): Promise<any> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.DEVICE.BIND_SPACE(spaceId)}`)
    const body: Record<string, any> = { device_id: deviceId }
    if (expectedVersion !== undefined) {
      body.expected_version = expectedVersion
    }
    if (recoverOfflineBinding) {
      body.recover_offline_binding = true
    }
    const response = await apiRequest({
      url,
      method: 'PATCH',
      body: JSON.stringify(body),
    })
    return unwrapResponseData(response) ?? null
  }

}
