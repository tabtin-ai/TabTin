/**
 * 应用根级共享的 AppHostClient
 *
 * smartsheet-ui 的 share-dialog（CollaboratorsSection / PublicLinkSection 等)通过
 * useAppHostClient() 获取 client 来调用 /collaborators、/share 等后端接口。这些组件
 * 渲染在 GridToolbar 等地方，并不在 TabdocPanelApp 的 Provider 树内,
 * 所以需要一个根级 Provider 作为兜底。
 *
 * TabdocPanelApp 自己在内层挂了一个带 collab / docs 配置的 Provider, 内层值会覆盖外层 —
 * TabDoc 编辑器内的 share-dialog 仍使用其专属 client, 不受本兜底影响。
 *
 * 延迟初始化:在第一次调用时通过 requireTableApiPort() 拿到全局 HTTP transport,
 * 因此本模块必须在 initializeElectronApiAdapter() 之后才被访问。
 */
import { createDirectAppClient } from '@tabtin/app-host-sdk/host'
import type { AppHostClient } from '@tabtin/app-host-sdk'
import type { AppHttpTransport } from '@tabtin/contracts/app'
import { requireTableApiPort } from '@tabtin/table-core'
import { message } from '@tabtin/smartsheet-ui/message'
import { API_CONFIG } from '@/config/api'

let cached: AppHostClient | null = null

function hostShowToast(
  text: string,
  level: 'info' | 'error' | 'success' | 'warning' = 'info',
): void {
  if (level === 'error') {
    message.error(text)
    return
  }
  if (level === 'success') {
    message.success(text)
    return
  }
  if (level === 'warning') {
    message.warning(text)
    return
  }
  message.info(text)
}

export function getSharedAppHostClient(): AppHostClient {
  if (cached) return cached
  const apiPort = requireTableApiPort()
  cached = createDirectAppClient({
    appId: 'tabtin-shell',
    spaceId: null,
    organizationId: null,
    baseApiUrl: API_CONFIG.baseURL,
    getAccessToken: () => apiPort.getAccessToken(),
    httpTransport: apiPort.request as unknown as AppHttpTransport,
    showToast: hostShowToast,
  })
  return cached
}
