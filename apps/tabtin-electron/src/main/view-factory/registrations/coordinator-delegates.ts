/**
 * coordinator-delegates — ViewRegistrationCoordinator 的回调实现
 *
 * 从 ViewFactory.ts 提取。通过 DelegatesDeps 注入所有依赖，
 * 返回的对象可直接作为 ViewRegistrationCoordinator 构造参数。
 */

import type { WebContents, WebContentsView } from 'electron'
import type { ViewFactoryConfig, ViewEntry, ViewRegistrationStatus, DestroyViewOptions } from '../types'
import type { RegistrationContext } from './ViewRegistrationCoordinator'

type FinalConfig = Omit<Required<ViewFactoryConfig>, 'proxy' | 'antiDetect'> &
  Pick<ViewFactoryConfig, 'proxy' | 'antiDetect'>

type ViewMeta = {
  title: string; url: string; favicon?: string
  runId?: string; isPreview?: boolean; createdAt: number
}

export interface DelegatesDeps {
  log: (...args: unknown[]) => void
  setRegistrationState: (id: string, key: keyof ViewRegistrationStatus, value: boolean) => void
  destroyView: (id: string, opts?: DestroyViewOptions) => Promise<void>
  registerToViewStateRegistry: (id: string, webContents: WebContents, config: FinalConfig, inUse: boolean) => void
  registerToWebContentsViewManager: (id: string, view: WebContentsView) => Promise<void>
  registerToResourceManager: (id: string, config: FinalConfig) => Promise<void>
  unregisterFromViewStateRegistry: (id: string) => void
  unregisterFromWebContentsViewManager: (id: string) => Promise<void>
  unregisterFromResourceManager: (id: string) => Promise<void>
  getRunSessionManager: () => {
    registerView: (runId: string, data: any) => void
    registerViewLocked: (runId: string, data: any) => Promise<void>
    getRunIdByView: (id: string) => string | undefined
    unregisterView: (runId: string, viewId: string) => void
  }
  getOrganizationTabManager: () => {
    registerView: (csId: string, viewId: string, meta: ViewMeta) => boolean
    isOrganizationView: (id: string) => boolean
    unregisterView: (id: string) => void
    getTabByView: (id: string) => string | null | undefined
  }
  getCrawlspaceContextHub: () => {
    registerView: (csId: string, viewId: string, meta: ViewMeta) => void
    unregisterView: (csId: string, viewId: string) => void
    getSnapshot: (csId: string) => { views: Array<{ viewId: string }> }
  }
  getResourceDetectionService: () => {
    registerView: (id: string, webContents: WebContents, options?: { partition?: string }) => void
    unregisterView: (id: string) => void
  }
  getViewPageRegistry: () => {
    unregister: (viewId: string) => boolean
    has: (viewId: string) => boolean
  } | null
  getExternalViewManager: () => { hasView: (id: string) => boolean; getViewIds: () => string[] } | null
  getExternalResourceManager: () => { get?: (id: string) => any } | null
  viewStateRegistryHasView: (id: string) => boolean
  buildWorkspaceViewMeta: (config: FinalConfig, createdAt: number) => ViewMeta
  /** RF04: 查询 VSR 中 View 的 inUse 状态 */
  getViewInUse: (id: string) => boolean
}

/**
 * 创建 ViewRegistrationCoordinator 所需的全部回调。
 */
export function createCoordinatorDelegates(deps: DelegatesDeps): RegistrationContext {
  return {
    log: deps.log,

    registerRunSession: async (state, options) => {
      const runId = state.config.runId
      if (!runId) return
      const manager = deps.getRunSessionManager()
      try {
        await manager.registerViewLocked(runId, {
          viewId: state.id,
          profile: state.config.profile,
          partition: state.config.partition,
          userAgent: state.config.userAgent,
          proxy: state.config.proxy,
          metadata: state.config.metadata,
          createdAt: state.createdAt,
          inUse: deps.getViewInUse(state.id),
        })
        deps.setRegistrationState(state.id, 'runSession', true)
      } catch (error) {
        deps.log('[ViewFactory] ❌ RunSession 注册失败:', { id: state.id, runId, error })
        if (options.rollbackOnFailure) {
          await deps.destroyView(state.id, { force: true })
        }
        throw error
      }
    },

    registerWorkspace: async (state, options) => {
      const crawlspaceId = state.config.metadata?.crawlspaceId as string | undefined
      if (!crawlspaceId) return
      const wtm = deps.getOrganizationTabManager()
      const viewMeta = deps.buildWorkspaceViewMeta(state.config, state.createdAt)
      const registered = wtm.registerView(crawlspaceId, state.id, viewMeta)
      if (!registered) {
        deps.log('[ViewFactory] ❌ Workspace 注册失败:', { id: state.id, crawlspaceId })
        if (options.strict) {
          await deps.destroyView(state.id, { force: true })
          throw new Error(`[ViewFactory] workspace view 注册失败: id=${state.id}`)
        }
        return
      }
      deps.setRegistrationState(state.id, 'workspace', true)
      deps.getCrawlspaceContextHub().registerView(crawlspaceId, state.id, viewMeta)
      deps.setRegistrationState(state.id, 'contextHub', true)
    },

    registerCdpManager: async (state) => {
      if (!state.view) return;
      await deps.registerToWebContentsViewManager(state.id, state.view)
    },

    registerResourceManager: async (state) => {
      await deps.registerToResourceManager(state.id, state.config)
    },

    registerResourceDetection: (state) => {
      // : 容器无关取 WebContents——WCV 走 view.webContents，
      // webview guest 走 guestWebContents（view 恒为 null）。
      const webContents = state.view?.webContents ?? state.guestWebContents
      if (!webContents) return;
      try {
        deps.getResourceDetectionService().registerView(state.id, webContents, {
          partition: state.config.partition
        })
      } catch (error) {
        deps.log('[ViewFactory] ⚠️ ResourceDetection 注册失败:', { id: state.id, error })
      }
    },

    unregisterRunSession: (state) => {
      const manager = deps.getRunSessionManager()
      const runId = manager.getRunIdByView(state.id)
      if (runId) {
        manager.unregisterView(runId, state.id)
        deps.setRegistrationState(state.id, 'runSession', false)
      }
    },

    unregisterWorkspace: (state) => {
      const wtm = deps.getOrganizationTabManager()
      if (wtm.isOrganizationView(state.id)) {
        wtm.unregisterView(state.id)
        deps.setRegistrationState(state.id, 'workspace', false)
      }
      const crawlspaceId = state.config.metadata?.crawlspaceId as string | undefined
      if (crawlspaceId) {
        deps.getCrawlspaceContextHub().unregisterView(crawlspaceId, state.id)
        deps.setRegistrationState(state.id, 'contextHub', false)
      }
    },

    unregisterViewStateRegistry: (state) => {
      deps.unregisterFromViewStateRegistry(state.id)
    },

    unregisterCdpManager: async (state) => {
      await deps.unregisterFromWebContentsViewManager(state.id)
    },

    unregisterResourceManager: async (state) => {
      await deps.unregisterFromResourceManager(state.id)
    },

    unregisterResourceDetection: (state) => {
      try {
        deps.getResourceDetectionService().unregisterView(state.id)
      } catch (error) {
        deps.log('[ViewFactory] ⚠️ ResourceDetection 反注册失败:', { id: state.id, error })
      }
    },

    unregisterViewPageRegistry: (state) => {
      try {
        const registry = deps.getViewPageRegistry()
        if (registry && registry.has(state.id)) {
          registry.unregister(state.id)
          deps.log('[ViewFactory] ✅ ViewPageRegistry 注销完成:', state.id)
        }
      } catch (error) {
        deps.log('[ViewFactory] ⚠️ ViewPageRegistry 注销失败:', { id: state.id, error })
      }
    },

    reconcileState: async (state, reason) => {
      const viewManager = deps.getExternalViewManager()
      const resourceManager = deps.getExternalResourceManager()
      const wtm = deps.getOrganizationTabManager()
      const hub = deps.getCrawlspaceContextHub()
      const id = state.id

      try {
        if (!deps.viewStateRegistryHasView(id) && state.view) {
          const inUseFallback = state.registrations?.runSession === true || deps.getViewInUse(id)
          deps.registerToViewStateRegistry(id, state.view.webContents, state.config, inUseFallback)
        }
      } catch (error) {
        deps.log('[ViewFactory] ⚠️ ViewStateRegistry reconcile 失败:', { id, reason, error })
      }

      try {
        if (viewManager && !viewManager.hasView(id) && state.view) {
          await deps.registerToWebContentsViewManager(id, state.view)
        }
      } catch (error) {
        deps.log('[ViewFactory] ⚠️ ViewManager reconcile 失败:', { id, reason, error })
      }

      try {
        const resourceId = `view-${id}`
        if (resourceManager?.get && !resourceManager.get(resourceId)) {
          await deps.registerToResourceManager(id, state.config)
        }
      } catch (error) {
        deps.log('[ViewFactory] ⚠️ ResourceManager reconcile 失败:', { id, reason, error })
      }

      const crawlspaceId = state.config.metadata?.crawlspaceId as string | undefined
      if (crawlspaceId) {
        try {
          const tabId = wtm.getTabByView(id)
          const viewMeta = deps.buildWorkspaceViewMeta(state.config, state.createdAt)
          if (tabId !== crawlspaceId) {
            const registered = wtm.registerView(crawlspaceId, id, viewMeta)
            if (registered) {
              hub.registerView(crawlspaceId, id, viewMeta)
              deps.setRegistrationState(id, 'workspace', true)
              deps.setRegistrationState(id, 'contextHub', true)
            }
          } else {
            const snapshot = hub.getSnapshot(crawlspaceId)
            const existsInHub = snapshot.views.some(v => v.viewId === id)
            if (!existsInHub) {
              hub.registerView(crawlspaceId, id, viewMeta)
              deps.setRegistrationState(id, 'contextHub', true)
            }
          }
        } catch (error) {
          deps.log('[ViewFactory] ⚠️ Workspace/ContextHub reconcile 失败:', { id, reason, error })
        }
      }
    },
  }
}
