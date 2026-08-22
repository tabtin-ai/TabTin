/**
 * subsystem-registrations — ViewStateRegistry / ResourceManager / CDPManager 注册/注销
 *
 * 从 ViewFactory.ts 提取。通过 `RegistrationContext` 注入所有外部依赖。
 */

import type { WebContents, WebContentsView } from 'electron'
import type { ViewFactoryConfig, ViewEntry, ViewRegistrationStatus } from '../types'

// ---------------------------------------------------------------------------
// Common types
// ---------------------------------------------------------------------------

type FinalConfig = Omit<Required<ViewFactoryConfig>, 'proxy' | 'antiDetect'> &
  Pick<ViewFactoryConfig, 'proxy' | 'antiDetect'>

type ResourceManagerLike = {
  register?: (resource: any) => void
  unregister?: (resourceId: string) => void
  get?: (resourceId: string) => any
}

type ViewManagerLike = {
  hasView: (id: string) => boolean
  getViewIds: () => string[]
  registerView?: (id: string, view: WebContentsView) => void
  registerExternalView?: (id: string, view: WebContentsView) => void
  unregisterView?: (id: string) => void
}

export interface RegistrationContext {
  views: Map<string, ViewEntry>
  pendingResourceRegistrations: Map<string, FinalConfig>
  pendingViewManagerRegistrations: Map<string, WebContentsView>
  /** undefined = handler 未配置（跳过注册），() => null = 暂时不可用（可重试） */
  getResourceManager: (() => ResourceManagerLike | null) | undefined
  /** undefined = handler 未配置（跳过注册），() => null = 暂时不可用（可重试） */
  getViewManager: (() => ViewManagerLike | null) | undefined
  getViewStateRegistry: () => {
    register: (id: string, webContents: WebContents, opts: any) => void
    unregister: (id: string) => void
  }
  profileToMode: (profile: string) => string
  setRegistrationState: (id: string, key: keyof ViewRegistrationStatus, value: boolean) => void
  schedulePendingResourceRetry: () => void
  schedulePendingViewManagerRetry: () => void
  log: (...args: unknown[]) => void
}

// ---------------------------------------------------------------------------
// ViewStateRegistry
// ---------------------------------------------------------------------------

export function registerToViewStateRegistry(
  id: string,
  webContents: WebContents,
  config: FinalConfig,
  inUse: boolean,
  ctx: RegistrationContext,
): void {
  if (process.env.DEBUG_VIEW_FACTORY) {
    ctx.log('[ViewFactory] 注册到 ViewStateRegistry:', id)
  }
  const registry = ctx.getViewStateRegistry()
  registry.register(id, webContents, {
    url: config.url,
    mode: ctx.profileToMode(config.profile),
    owner: 'shared',
    reusable: config.keepAlive,
    inUse,
    metadata: {
      createdBy: 'ViewFactory',
      createdAt: Date.now(),
      profile: config.profile,
      taskId: config.taskId,
      ...config.metadata,
    },
  })
  ctx.setRegistrationState(id, 'viewStateRegistry', true)
}

export function unregisterFromViewStateRegistry(
  id: string,
  ctx: RegistrationContext,
): void {
  ctx.log('[ViewFactory] 从 ViewStateRegistry 注销:', id)
  ctx.getViewStateRegistry().unregister(id)
  ctx.setRegistrationState(id, 'viewStateRegistry', false)
}

// ---------------------------------------------------------------------------
// ResourceManager
// ---------------------------------------------------------------------------

export async function registerToResourceManager(
  id: string,
  config: FinalConfig,
  ctx: RegistrationContext,
): Promise<void> {
  if (process.env.DEBUG_VIEW_FACTORY) {
    ctx.log('[ViewFactory] 📦 注册到 ResourceManager:', id)
  }
  try {
    if (!ctx.getResourceManager) {
      return
    }
    const resourceManager = ctx.getResourceManager()
    if (!resourceManager) {
      if (process.env.DEBUG_VIEW_FACTORY) {
        ctx.log('[ViewFactory] ⚠️  ResourceManager 不可用，记录到待注册队列')
      }
      queuePendingResource(id, config, ctx)
      return
    }
    if (typeof resourceManager.register !== 'function') {
      ctx.log('[ViewFactory] ⚠️  ResourceManager 不支持 register 方法，记录到待注册队列')
      queuePendingResource(id, config, ctx)
      return
    }
    const entry = ctx.views.get(id)
    if (!entry || !entry.view) {
      ctx.log('[ViewFactory] ⚠️  View 状态不存在或已 discard，跳过 ResourceManager 注册')
      ctx.pendingResourceRegistrations.delete(id)
      return
    }
    const resourceId = `view-${id}`
    resourceManager.register({
      id: resourceId,
      type: 'view',
      status: 'in_use',
      taskId: config.taskId || null,
      createdAt: entry.createdAt,
      lastAccessAt: entry.createdAt,
      expiresAt: null,
      viewId: id,
      view: entry.view,
      url: config.url,
      metadata: {
        createdBy: 'ViewFactory',
        profile: config.profile,
        displayMode: config.displayMode,
        ...config.metadata,
      },
    })
    ctx.log('[ViewFactory] ✅ ResourceManager 注册完成:', resourceId)
    ctx.pendingResourceRegistrations.delete(id)
    ctx.setRegistrationState(id, 'resourceManager', true)
  } catch (error) {
    ctx.log('[ViewFactory] ❌ ResourceManager 注册失败:', error)
    queuePendingResource(id, config, ctx)
    ctx.setRegistrationState(id, 'resourceManager', false)
  }
}

export async function unregisterFromResourceManager(
  id: string,
  ctx: RegistrationContext,
): Promise<void> {
  if (!ctx.getResourceManager) {
    ctx.pendingResourceRegistrations.delete(id)
    return
  }
  ctx.log('[ViewFactory] 📦 从 ResourceManager 注销:', id)
  try {
    const resourceManager = ctx.getResourceManager()
    if (!resourceManager) {
      ctx.pendingResourceRegistrations.delete(id)
      return
    }
    if (typeof resourceManager.unregister !== 'function') {
      ctx.log('[ViewFactory] ⚠️  ResourceManager 不支持 unregister 方法，跳过注销')
      return
    }
    const resourceId = `view-${id}`
    resourceManager.unregister(resourceId)
    ctx.log('[ViewFactory] ✅ ResourceManager 注销完成:', resourceId)
    ctx.pendingResourceRegistrations.delete(id)
    ctx.setRegistrationState(id, 'resourceManager', false)
  } catch (error) {
    ctx.log('[ViewFactory] ❌ ResourceManager 注销失败:', error)
    ctx.pendingResourceRegistrations.delete(id)
    ctx.setRegistrationState(id, 'resourceManager', false)
  }
}

function queuePendingResource(id: string, config: FinalConfig, ctx: RegistrationContext): void {
  ctx.pendingResourceRegistrations.set(id, config)
  ctx.schedulePendingResourceRetry()
}

export async function flushPendingResourceRegistrations(ctx: RegistrationContext): Promise<void> {
  if (ctx.pendingResourceRegistrations.size === 0) return
  ctx.log('[ViewFactory] ⏳ 重试待注册资源:', Array.from(ctx.pendingResourceRegistrations.keys()))
  for (const [id, config] of Array.from(ctx.pendingResourceRegistrations.entries())) {
    try {
      await registerToResourceManager(id, config, ctx)
    } catch (error) {
      ctx.log('[ViewFactory] ⚠️ 重试 ResourceManager 注册失败:', id, error)
    }
  }
}

// ---------------------------------------------------------------------------
// CDPManager (WebContentsViewManager)
// ---------------------------------------------------------------------------

export async function registerToWebContentsViewManager(
  id: string,
  view: WebContentsView,
  ctx: RegistrationContext,
): Promise<void> {
  if (!ctx.getViewManager) {
    ctx.pendingViewManagerRegistrations.delete(id)
    return
  }
  ctx.log('[ViewFactory] 🔗 注册到 CDPManager:', id)
  try {
    if (!view || !view.webContents) {
      ctx.log('[ViewFactory] ⚠️  View 或 WebContents 无效，跳过注册')
      ctx.pendingViewManagerRegistrations.delete(id)
      return
    }
    if (view.webContents.isDestroyed()) {
      ctx.log('[ViewFactory] ⚠️  WebContents 已销毁，跳过注册')
      ctx.pendingViewManagerRegistrations.delete(id)
      return
    }
    const viewManager = ctx.getViewManager()
    if (!viewManager) {
      ctx.log('[ViewFactory] ⚠️  WebContentsViewManager 不可用，跳过注册')
      queuePendingViewManager(id, view, ctx)
      return
    }
    const registerMethod = (viewManager as any).registerView || (viewManager as any).registerExternalView
    if (typeof registerMethod !== 'function') {
      ctx.log('[ViewFactory] ⚠️  registerView 方法不存在，跳过注册')
      queuePendingViewManager(id, view, ctx)
      return
    }
    ctx.log('[ViewFactory] 📝 调用 cdpManager.registerView...', {
      id,
      url: view.webContents.getURL(),
      isDestroyed: view.webContents.isDestroyed(),
    })
    registerMethod.call(viewManager, id, view)
    const registered = viewManager.hasView(id)
    if (registered) {
      ctx.log('[ViewFactory] ✅ 已成功注册到 WebContentsViewManager')
      ctx.log('[ViewFactory] 📊 当前 viewManager 中的 View 数量:', viewManager.getViewIds().length)
      ctx.pendingViewManagerRegistrations.delete(id)
      ctx.setRegistrationState(id, 'cdpManager', true)
    } else {
      ctx.log('[ViewFactory] ⚠️  注册调用完成，但 hasView 返回 false')
      queuePendingViewManager(id, view, ctx)
      ctx.setRegistrationState(id, 'cdpManager', false)
    }
  } catch (error) {
    ctx.log('[ViewFactory] ❌ 注册到 WebContentsViewManager 失败:', error)
    queuePendingViewManager(id, view, ctx)
    ctx.setRegistrationState(id, 'cdpManager', false)
  }
}

export async function unregisterFromWebContentsViewManager(
  id: string,
  ctx: RegistrationContext,
): Promise<void> {
  if (!ctx.getViewManager) {
    ctx.pendingViewManagerRegistrations.delete(id)
    return
  }
  ctx.log('[ViewFactory] 从 CDPManager 注销:', id)
  try {
    const viewManager = ctx.getViewManager()
    if (viewManager && viewManager.hasView(id)) {
      if (typeof viewManager.unregisterView === 'function') {
        viewManager.unregisterView(id)
        ctx.log('[ViewFactory] ✅ 从 CDPManager 注销完成:', id)
        ctx.pendingViewManagerRegistrations.delete(id)
        ctx.setRegistrationState(id, 'cdpManager', false)
      } else {
        ctx.log('[ViewFactory] ⚠️  unregisterView 方法不存在')
      }
    } else {
      ctx.pendingViewManagerRegistrations.delete(id)
      ctx.setRegistrationState(id, 'cdpManager', false)
    }
  } catch (error) {
    ctx.log('[ViewFactory] ⚠️  从 CDPManager 注销失败:', error)
    ctx.pendingViewManagerRegistrations.delete(id)
    ctx.setRegistrationState(id, 'cdpManager', false)
  }
}

function queuePendingViewManager(
  id: string,
  view: WebContentsView | undefined,
  ctx: RegistrationContext,
): void {
  if (view) {
    ctx.pendingViewManagerRegistrations.set(id, view)
  }
  ctx.schedulePendingViewManagerRetry()
}

export async function flushPendingViewManagerRegistrations(
  ctx: RegistrationContext,
): Promise<void> {
  if (ctx.pendingViewManagerRegistrations.size === 0) return
  ctx.log('[ViewFactory] ⏳ 重试 CDPManager 注册:', Array.from(ctx.pendingViewManagerRegistrations.keys()))
  for (const [id, view] of Array.from(ctx.pendingViewManagerRegistrations.entries())) {
    try {
      await registerToWebContentsViewManager(id, view, ctx)
    } catch (error) {
      ctx.log('[ViewFactory] ⚠️ 重试 CDPManager 注册失败:', id, error)
    }
  }
}
