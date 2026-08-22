/**
 * session-config — Session/Partition 选择 + 反检测配置组装
 *
 * 从 ViewFactory.ts 提取，纯函数设计：不持有状态，所有依赖通过参数注入。
 */

import type { WebContents, WebContentsView } from 'electron'
import type { ViewFactoryConfig } from './types'
import {
  cleanUserAgent,
  ensureSessionUARewrite,
  applyProxyFromAntiDetect,
  applyTraditionalConfig,
  setupUAOverrideInjection,
  tagProxy,
  tagUserAgent,
  type FullConfig,
} from './anti-detect-config'
import { setupResourceInterception, type ResourceInterceptionContext } from './resource-interception'
import { getCDPConnectionManager } from '@tabtin/action-tools/cdp'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FinalConfig = Omit<Required<ViewFactoryConfig>, 'proxy' | 'antiDetect' | 'appId'> &
  Pick<ViewFactoryConfig, 'proxy' | 'antiDetect' | 'appId'>

export interface SessionConfigDeps {
  log: (...args: unknown[]) => void
}

export interface ViewInstanceDeps {
  viewManager: { createView: (opts: any) => WebContentsView }
  antiDetectManager: {
    getOrCreateProfile: (config: any) => Promise<any>
  }
  sessionsWithUARewrite: WeakSet<Electron.Session>
  resourceInterceptionCtx: ResourceInterceptionContext
  log: (...args: unknown[]) => void
}

// ---------------------------------------------------------------------------
// buildSessionConfig
// ---------------------------------------------------------------------------

/**
 * 根据 partition 配置构建 Electron WebPreferences。
 *
 * 优先级：显式 partition > 默认共享。
 *
 * NOTE: antiDetect.session.persistent 不在此处消费。
 * Session 持久性完全由 config.partition / config.sessionMode 决定。
 */
export function buildSessionConfigForView(
  config: FinalConfig,
  SessionConfigFactory: any,
  log: (...args: unknown[]) => void,
): Record<string, unknown> {
  let sessionConfig: Record<string, unknown>

  if (config.partition) {
    log('[ViewFactory] 📌 使用自定义隔离配置:', config.partition)
    // 调用链中既存在 SessionConfigFactory 需要的裸名称（如
    // `tabtin:organization:*`），也存在来自 Electron session API 的完整名称
    // （`persist:*`）。先归一化，避免产生 `persist:persist:*`；temp-* 则必须
    // 保持非持久，否则一次性登录接力会写盘并被 webview attach policy 拒绝。
    const isExplicitPersistent = config.partition.startsWith('persist:')
    const partition = isExplicitPersistent
      ? config.partition.slice('persist:'.length)
      : config.partition
    sessionConfig = SessionConfigFactory.custom({
      isolated: true,
      partition,
      persistent: isExplicitPersistent || !partition.startsWith('temp-'),
    })
  } else if (config.sessionMode === 'isolated') {
    const taskId = config.taskId || config.id || `task-${Date.now()}`
    log('[ViewFactory] 📌 使用隔离持久化 session (sessionMode: isolated, taskId: %s)', taskId)
    sessionConfig = SessionConfigFactory.custom({
      isolated: true,
      partition: `task-${taskId}`,
      persistent: true,
    })
  } else if (config.sessionMode === 'persistent') {
    const appId = config.appId || config.id || 'unknown'
    log('[ViewFactory] 📌 使用持久化隔离 session (sessionMode: persistent, appId: %s)', appId)
    sessionConfig = SessionConfigFactory.custom({
      isolated: true,
      partition: `persist:marketplace-${appId}`,
      persistent: true,
    })
  } else if (config.sessionMode === 'temporary') {
    const taskId = config.taskId || config.id || `task-${Date.now()}`
    log('[ViewFactory] 📌 使用临时 session (sessionMode: temporary, taskId: %s)', taskId)
    sessionConfig = SessionConfigFactory.forTemporary(taskId)
  } else {
    // sessionMode === 'inherit' 或未指定 → 默认行为
    log('[ViewFactory] 📌 使用共享 session 配置 (profile: %s)', config.profile)
    sessionConfig = SessionConfigFactory.forEmbedded()
  }

  log('[ViewFactory] 📝', SessionConfigFactory.describeConfig(sessionConfig))

  const validation = SessionConfigFactory.validateConfig(sessionConfig)
  if (validation?.errors?.length > 0) {
    log('[SessionConfig] ⚠️ 配置校验警告:', validation.errors)
  }

  return sessionConfig
}

// ---------------------------------------------------------------------------
// applyAntiDetectConfig
// ---------------------------------------------------------------------------

/**
 * 在 View 创建后应用反检测 / 传统代理配置。
 *
 * : 参数从 WebContentsView 收窄为 WebContents（容器无关化）。
 *
 * 返回补充的 metadata（antiDetectProfile）供调用方合并。
 */
export async function applyAntiDetectConfig(
  webContents: WebContents,
  config: FinalConfig,
  deps: ViewInstanceDeps,
): Promise<Record<string, unknown> | null> {
  const { antiDetectManager, log } = deps

  if (config.antiDetect) {
    log('[ViewFactory] 🔐 使用 anti-detect 模块配置...')
    try {
      const antiDetectProfile = await antiDetectManager.getOrCreateProfile(config.antiDetect)

      // UA 多层防御
      const cleanUA = cleanUserAgent(antiDetectProfile.userAgent)
      log('[ViewFactory] 🎭 设置 User-Agent:', cleanUA.substring(0, 50) + '...')

      const session = webContents.session
      session.setUserAgent(cleanUA)
      log('[ViewFactory] 🎭 Session UA 已设置')
      ensureSessionUARewrite(session, cleanUA, {
        log,
        sessionsWithUARewrite: deps.sessionsWithUARewrite,
      })
      webContents.setUserAgent(cleanUA)

      webContents.on('will-navigate', (_event, url) => {
        if (!webContents || webContents.isDestroyed()) return
        webContents.setUserAgent(cleanUA)
        log('[ViewFactory] 🔄 will-navigate 重新设置 UA:', url.substring(0, 50))
      })
      webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
        if (!webContents || webContents.isDestroyed()) return
        if (isMainFrame) {
          webContents.setUserAgent(cleanUA)
          log('[ViewFactory] 🔄 did-start-navigation 重新设置 UA:', url.substring(0, 50), '(isInPlace:', isInPlace, ')')
        }
      })
      webContents.on('did-start-loading', () => {
        if (!webContents || webContents.isDestroyed()) return
        webContents.setUserAgent(cleanUA)
        log('[ViewFactory] 🔄 did-start-loading 重新设置 UA（处理刷新）')
      })

      if (antiDetectProfile.proxy) {
        log('[ViewFactory] 🌐 设置代理:', tagProxy(antiDetectProfile.proxy))
        await applyProxyFromAntiDetect(webContents, antiDetectProfile.proxy, { log })
      }

      try {
        const cdpManager = getCDPConnectionManager()
        await cdpManager.getOrAttach(webContents, { strategy: 'keep-alive' })
        await webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: 'delete Object.getPrototypeOf(navigator).webdriver;',
          runImmediately: true,
        })
        log('[ViewFactory] CDP webdriver 属性已从原型链删除（通过 CDPConnectionManager）')
      } catch (cdpErr) {
        log('[ViewFactory] CDP webdriver 隐藏失败（非致命）:', cdpErr)
      }

      if (cleanUA) {
        log('[ViewFactory] 🎨 设置 UA 覆盖注入')
        await setupUAOverrideInjection(
          webContents,
          cleanUA,
          {
            log,
          },
        )
      }

      return {
        antiDetectProfile: {
          sessionId: antiDetectProfile.id,
          userAgentTag: tagUserAgent(antiDetectProfile.userAgent),
          proxyTag: antiDetectProfile.proxy ? tagProxy(antiDetectProfile.proxy) : undefined,
          fingerprintId: antiDetectProfile.fingerprint?.id,
        },
      }
    } catch (error) {
      log('[ViewFactory] ⚠️  anti-detect 配置失败，回退到传统方式:', error)
      await applyTraditionalConfig(webContents, config as FullConfig, { log })
      return null
    }
  }

  // 传统配置
  await applyTraditionalConfig(webContents, config as FullConfig, { log })
  return null
}

// ---------------------------------------------------------------------------
// setupResourceInterceptionForProfile
// ---------------------------------------------------------------------------

export function setupResourceInterceptionForProfile(
  webContents: WebContents,
  config: FinalConfig,
  ctx: ResourceInterceptionContext,
): void {
  if (config.profile === 'agent-workspace') {
    setupResourceInterception(webContents, config.url, ctx)
  }
}
