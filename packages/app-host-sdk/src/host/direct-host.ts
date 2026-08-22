import type { AppHostContext } from '../context'
import type { AppHttpTransport } from '../http'
import { AppHostClient } from '../app-client'

/**
 * builtin in-process 宿主端工具
 *
 * 为 builtin App（通过 React.lazy dynamic import 加载）
 * 构造 AppHostContext 并创建 AppHostClient
 */

export interface CreateDirectClientInput {
  appId: string
  spaceId?: string | null
  /** @deprecated Use spaceId */
  projectId?: string | null
  organizationId: string | null
  getAccessToken: () => Promise<string | null> | string | null
  baseApiUrl: string
  showToast?: (message: string, level?: 'info' | 'error' | 'success' | 'warning') => void
  navigate?: (target: { type: string; id: string }) => void
  /** HTTP 传输层 —— 通常传入平台的 TableApiPort.request */
  httpTransport?: AppHttpTransport
}

/**
 * 创建 builtin App 的 AppHostClient
 * 宿主在 React 组件中调用此方法，将 client 传递给 App 组件
 */
export function createDirectAppClient(input: CreateDirectClientInput): AppHostClient {
  const ctx: AppHostContext = {
    appId: input.appId,
    spaceId: input.spaceId ?? input.projectId ?? null,
    organizationId: input.organizationId,
    getAccessToken: input.getAccessToken,
    baseApiUrl: input.baseApiUrl,
    showToast: input.showToast,
    navigate: input.navigate,
    httpTransport: input.httpTransport,
  }

  return AppHostClient.fromContext(ctx)
}
