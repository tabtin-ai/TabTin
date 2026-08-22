/**
 * 主进程全局类型声明
 *
 * `global.tabtin` 是供 @tabtin/action-tools 等跨包代码访问主进程能力的
 * 命名空间。所有字段均为可选，在 FrontendActionBridge 初始化后才可用。
 */

declare global {
  interface TabtinGlobal {
    /** 后端 API 基础地址，默认 http://localhost:6060/api */
    apiBaseUrl?: string

    /**
     * 当前 active organization ID（C9 防御 #6）。
     *
     * 由 `bridge-core.ts` 用 `Object.defineProperty` 注入为 lazy getter：
     * 每次访问都读 `cli-context.ts` 的 `currentOrganizationId` 模块状态，
     * 与 active organization 切换天然同步（`space:set-active` 链路
     * + chat IPC `syncCLISpaceContextFromQueryRequest` 兜底已经
     * 维护这个 state 与 renderer `useOrganizationStore` 一致）。
     *
     * 用途：让 ActionTool 调 `uploadFileToOSS` 时的 fallback 链路
     * （`opts.organizationId || g?.tabtin?.organizationId || undefined`）
     * 在 Electron 模式下也有正确值，避免写错 organization 的 FileRecord。
     *
     * 与 daemon 端 `injectGlobalTabtin` 写入的固定值差异：daemon 是
     * 启动期就定的单 organization 模型，Electron 是用户随时切换的多 organization。
     */
    organizationId?: string

    crawlView?: {
      /** 在指定 View 的 WebContents 中执行脚本 */
      executeScript?: (tabId: string, script: string) => Promise<unknown>
    }

    auth?: {
      /** 获取当前用户的 access token */
      getAccessToken: () => Promise<string | null>
    }

    runSession?: {
      /** 按 runId 获取 RunSession 实例 */
      get: (runId: string) => unknown
      /** 向当前 run session 追加观测事件 */
      addEvent: (event: unknown) => void
      /** 打开/创建标签页 — 由 bridge-core.ts 注入，TabResolver 依赖 */
      openTab?: (options: {
        runId?: string
        id?: string
        url?: string
        profile?: string
        partition?: string
        userAgent?: string
        proxy?: unknown
        antiDetect?: unknown
        metadata?: Record<string, unknown>
        fallbackReason?: string
        displayMode?: 'embedded' | 'windowed' | 'hidden'
        showInSidebar?: boolean
        notifyRenderer?: boolean
        tabName?: string
        keepAlive?: boolean
      }) => Promise<{ success: boolean; id?: string; profile?: string; reused?: boolean; error?: string }>
    }

    /** runtime-bridge.ts 的回退解析路径 */
    api?: {
      runSession?: TabtinGlobal['runSession']
      crawlView?: TabtinGlobal['crawlView']
    }
  }

  // eslint-disable-next-line no-var
  var tabtin: TabtinGlobal | undefined
}

export {}
