/**
 * AppHostContext — 宿主注入给 App 的能力接口
 *
 * builtin (in-process): 宿主直接构造并传递 context 对象
 * marketplace (WebContentsView): 通过 preload bridge (window.tabtin.appHost) 透传
 */

import type { AppHttpTransport } from './http'

export interface AppHostContext {
  /** App 唯一标识 */
  appId: string

  /** 当前 Space ID */
  spaceId: string | null

  /** 当前工作空间 ID */
  organizationId: string | null

  /** 获取访问令牌（用于 API 调用鉴权） */
  getAccessToken: () => Promise<string | null> | string | null

  /** 后端 API 基础 URL */
  baseApiUrl: string

  /** 展示 toast 通知 */
  showToast?: (message: string, level?: 'info' | 'error' | 'success' | 'warning') => void

  /** 导航到目标（打开面板、跳转路由等） */
  navigate?: (target: { type: string; id: string }) => void

  /**
   * HTTP 传输层 —— 由宿主注入，处理实际网络 I/O
   *
   * builtin: 注入 TableApiPort.request（含 401 自动刷新）
   * marketplace: 注入基于 IPC 的传输
   */
  httpTransport?: AppHttpTransport
}

/**
 * Context 变更事件载荷
 */
export interface AppHostContextUpdate {
  spaceId?: string | null
  organizationId?: string | null
  baseApiUrl?: string
}
