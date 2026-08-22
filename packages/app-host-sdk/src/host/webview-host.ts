/**
 * WebContentsView 宿主端工具（为 marketplace App 准备）
 *
 * 提供 IPC handler 注册接口，在主进程中为 WebContentsView 注入 context。
 * Phase B 只建最小骨架，Phase C 完整实现。
 */

export interface WebViewAppConfig {
  appId: string
  spaceId: string | null
  /** @deprecated Use spaceId */
  projectId?: string | null
  organizationId: string | null
  baseApiUrl: string
  getAccessToken: () => Promise<string | null>
}

/**
 * 序列化 context 供 preload bridge 传递（不含函数引用）
 */
export interface SerializedAppHostContext {
  appId: string
  spaceId: string | null
  organizationId: string | null
  baseApiUrl: string
}

/**
 * 从配置生成可序列化的 context（供 IPC 传输）
 */
export function serializeAppHostContext(config: WebViewAppConfig): SerializedAppHostContext {
  return {
    appId: config.appId,
    spaceId: config.spaceId ?? config.projectId ?? null,
    organizationId: config.organizationId,
    baseApiUrl: config.baseApiUrl,
  }
}
