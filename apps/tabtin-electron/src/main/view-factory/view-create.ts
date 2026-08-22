/**
 * view-create — View 实例创建
 *
 * 从 ViewFactory.createViewInstance 提取，纯函数设计：
 * 不持有状态，所有依赖通过 ViewCreateDeps 注入。
 *
 * 职责：
 * - Session 配置构建（partition / shared）
 * - 指纹 preload 注入
 * - ViewManager 底层 View 创建
 * - 反检测配置应用（UA / Proxy / Fingerprint）
 * - 资源拦截设置
 */

import type { WebContents, WebContentsView } from 'electron'
import type { ViewFactoryConfig } from './types'
import type { ViewManager } from '@tabtin/browser-capabilities'
import type { SessionPreloadRegistry } from './session-preload-registry'
import type { ResourceInterceptionContext } from './resource-interception'
import {
  buildSessionConfigForView,
  applyAntiDetectConfig,
  setupResourceInterceptionForProfile,
  type ViewInstanceDeps,
} from './session-config'
import { ensureFramePreloadRegistered } from './session-preload-registry'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FinalConfig = Omit<Required<ViewFactoryConfig>, 'proxy' | 'antiDetect'> &
  Pick<ViewFactoryConfig, 'proxy' | 'antiDetect'>

export interface ViewCreateDeps {
  viewManager: ViewManager
  sessionPreloadRegistry: SessionPreloadRegistry
  getViewInstanceDeps: () => ViewInstanceDeps
  getResourceInterceptionCtx: () => ResourceInterceptionContext
  log: (...args: any[]) => void
}

/** Session 准备阶段的依赖子集（: WCV 创建与 webview guest announce 共用） */
export type GuestSessionPrepDeps = Pick<ViewCreateDeps, 'sessionPreloadRegistry' | 'log'>

/** 能力装配阶段的依赖子集（: WCV 创建与 webview guest did-attach 共用） */
export type GuestCapabilityDeps = Pick<ViewCreateDeps, 'getViewInstanceDeps' | 'getResourceInterceptionCtx' | 'log'>

// ---------------------------------------------------------------------------
// 共用装配段（ 抽取，供 WCV createViewInstance 与 webview-host 复用）
// ---------------------------------------------------------------------------

/**
 * Session 配置构建 + 指纹 preload 注入（容器无关段）。
 *
 * 从 createViewInstance 提取：WCV 路径在创建 WebContentsView 前调用；
 * webview tag 路径在 announce 阶段调用（renderer 创建 <webview> 元素前，
 * 保证 session 级指纹 preload 先于 guest 加载注册到位）。
 *
 * 返回 SessionConfigFactory 归一化后的 webPreferences 形状（含 `partition`）。
 */
export async function prepareGuestSessionConfig(
  config: FinalConfig,
  deps: GuestSessionPrepDeps,
): Promise<Record<string, unknown>> {
  const { SessionConfigFactory } = await import('../config/SessionConfigFactory')
  const sessionConfig = buildSessionConfigForView(config, SessionConfigFactory, deps.log)

  // 指纹 preload 注入
  deps.log('[ViewFactory] 🔍 检查指纹配置:', {
    hasAntiDetect: !!config.antiDetect,
    hasFingerprint: !!config.antiDetect?.fingerprint,
    fingerprintPreset: config.antiDetect?.fingerprint?.preset,
    profile: config.profile,
  })

  if (config.antiDetect?.fingerprint) {
    const path = await import('path')
    const fs = await import('fs')
    const preloadPath = path.join(import.meta.dirname, 'anti-detect', 'fingerprint-preload.js')
    const fileExists = fs.existsSync(preloadPath)
    deps.log('[ViewFactory] 🎨 检查指纹 preload:', preloadPath, '(exists:', fileExists, ')')
    if (!fileExists) {
      deps.log('[ViewFactory] ❌ Preload 脚本不存在！路径:', preloadPath)
      deps.log('[ViewFactory] 🔍 import.meta.dirname:', import.meta.dirname)
    } else if ((sessionConfig as Electron.WebPreferences).partition) {
      ensureFramePreloadRegistered(
        (sessionConfig as Electron.WebPreferences).partition,
        preloadPath,
        deps.sessionPreloadRegistry,
        deps.log,
      )
      deps.log('[ViewFactory] ✅ 已注册隔离 session 级指纹 preload')
    } else {
      (sessionConfig as any).preload = preloadPath
      deps.log('[ViewFactory] ✅ 默认共享 session 使用 view 级 preload 兜底')
    }
  } else {
    deps.log('[ViewFactory] ⚠️  未配置指纹伪装（antiDetect.fingerprint 为空）')
  }

  return sessionConfig
}

/**
 * View 创建后的能力装配（容器无关段）：反检测配置 + 资源拦截。
 *
 * 从 createViewInstance 提取：WCV 路径在 ViewManager 创建后调用；
 * webview tag 路径在 did-attach 配对后对 guest WebContents 调用。
 *
 * 返回补充的 metadata（antiDetectProfile），已合并进 config.metadata。
 */
export async function applyGuestCapabilities(
  webContents: WebContents,
  config: FinalConfig,
  deps: GuestCapabilityDeps,
): Promise<void> {
  // 反检测 / 传统配置（: 服务面收 WebContents，取 .webContents 在此上提）
  const extraMeta = await applyAntiDetectConfig(webContents, config, deps.getViewInstanceDeps())
  if (extraMeta) {
    config.metadata = { ...config.metadata, ...extraMeta }
  }

  // 资源拦截
  setupResourceInterceptionForProfile(webContents, config, deps.getResourceInterceptionCtx())
}

// ---------------------------------------------------------------------------
// Core creation
// ---------------------------------------------------------------------------

/**
 * 创建底层 WebContentsView 实例。
 *
 * 流程：Session 配置构建 → 指纹 preload 注入 → ViewManager 创建 →
 * 反检测配置应用 → 资源拦截设置。
 *
 * 委托 session-config 子模块处理 Session 构建 + 反检测配置。
 */
export async function createViewInstance(
  config: FinalConfig,
  deps: ViewCreateDeps,
): Promise<WebContentsView> {
  deps.log('[ViewFactory] 🆕 使用 ViewManager 创建 WebContentsView...')

  const sessionConfig = await prepareGuestSessionConfig(config, deps)

  const bootstrapUrl = config.url && config.url !== 'about:blank'
    ? 'about:blank'
    : config.url

  const view = deps.viewManager.createView({
    id: config.id,
    webPreferences: sessionConfig,
    bounds: config.bounds,
    url: bootstrapUrl,
  })

  await applyGuestCapabilities(view.webContents, config, deps)

  deps.log('[ViewFactory] ✅ View 创建完成（ViewManager 引擎）:', config.id)
  return view
}
